// ==================== NovelGen Web 视图 ====================
// 与 DSH 对话中的 novel_* 工具共用同一份 JSON 数据(同一 store)。

const $ = (sel) => document.querySelector(sel);

// ---------- API 封装 ----------
async function api(method, url, body) {
  const res = await fetch('/novelgen/api' + url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }));
  if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.data;
}

// ---------- 状态 ----------
const state = {
  projects: [],
  current: null,        // 当前项目完整数据
  currentChapter: null, // { volumeId, chapterId }
  viewMode: 'editor',   // 'editor'(章节编辑器)| 'settings'(设定视图)
  settingsFocus: null,  // null=设定首页 | { cat, group? }=cat 是分类或分类组名,group 是组内成员分类名
  pendingSystemPrompt: null, // 未保存的系统提示词(切换视图时保留)
  pendingCategories: {},     // 未保存的分类编辑(按分类名暂存,切走不丢)
  pendingServerSettings: null, // 轮询期间 AI 写入的最新设定(设定视图编辑中不重绘,切走/重开时载入)
  _openSettings: true,  // 目录栏「设定」目录展开态
  _openBody: true       // 目录栏「正文」目录展开态
};

// ---------- 撤销/重做(结构级快照;打字区内用原生 Ctrl+Z) ----------
const hist = { stack: [], index: -1, maxS: 10 };

function pushHistory() {
  const cur = state.current;
  if (!cur) return;
  const snapshot = JSON.stringify({ volumes: cur.volumes, settings: cur.settings });
  if (hist.index >= 0) {
    const prev = hist.stack[hist.index];
    if (prev && prev.t === 's' && prev.snapshot === snapshot) return; // 去重
  }
  hist.stack = hist.stack.slice(0, hist.index + 1);
  hist.stack.push({ t: 's', snapshot });
  hist.index = hist.stack.length - 1;
  while (hist.stack.filter((e) => e.t === 's').length > hist.maxS) {
    const i = hist.stack.findIndex((e) => e.t === 's');
    hist.stack.splice(i, 1);
    if (i <= hist.index) hist.index--;
  }
  updateHistoryButtons();
}

function clearHistory() {
  hist.stack = [];
  hist.index = -1;
  updateHistoryButtons();
}

// 结构操作完成后的收尾:重新压入「操作后状态」,使撤销/重做能完整走通
// (pushHistory 压的是操作前状态,撤销后要能重做回操作后状态,必须再压一条)
function commitHistory() {
  const cur = state.current;
  if (!cur) return;
  const snapshot = JSON.stringify({ volumes: cur.volumes, settings: cur.settings });
  // 与栈顶去重:操作后状态若与操作前相同(例如操作未改变结构),不重复压栈
  const top = hist.stack[hist.index];
  if (top && top.t === 's' && top.snapshot === snapshot) return;
  hist.stack = hist.stack.slice(0, hist.index + 1);
  hist.stack.push({ t: 's', snapshot });
  hist.index = hist.stack.length - 1;
  while (hist.stack.filter((e) => e.t === 's').length > hist.maxS) {
    const i = hist.stack.findIndex((e) => e.t === 's');
    hist.stack.splice(i, 1);
    if (i <= hist.index) hist.index--;
  }
  updateHistoryButtons();
}

function updateHistoryButtons() {
  const b1 = $('#btnUndo'), b2 = $('#btnRedo');
  // index 指向「当前状态」在栈中的位置;撤销 = 应用 index-1(有更早状态时可用)
  if (b1) b1.disabled = !(hist.index > 0);
  // 重做 = 应用 index+1(之后还有状态时可用)
  if (b2) b2.disabled = !(hist.index < hist.stack.length - 1);
}

// dir = -1 撤销 / +1 重做:恢复结构级快照(整份正文+设定)
// 语义:stack 存「状态序列」,index 指向当前状态位置;
// 操作前 pushHistory 压「操作前状态」,操作完成后 refreshAfterChange 再压「操作后状态」,
// 撤销/重做分别应用 index±1,保证最后一次操作也能被重做。
async function undoRedo(dir) {
  const p = state.current;
  if (!p) return;
  if (dir === -1) {
    if (hist.index <= 0) return; // 没有更早的状态可回退
    await applySnapshot(p, hist.stack[hist.index - 1]);
    hist.index -= 1;
  } else {
    const next = hist.index + 1;
    if (next >= hist.stack.length) return; // 没有更晚的状态可前进
    await applySnapshot(p, hist.stack[next]);
    hist.index = next;
  }
  updateHistoryButtons();
}

async function applySnapshot(p, entry) {
  if (!entry || entry.t !== 's') return;
  const data = JSON.parse(entry.snapshot);
  try {
    _dirty = false; // 恢复快照,丢弃未保存的编辑器内容(避免 flush 把旧内容写回覆盖快照)
    // 清空设定暂存:避免把已撤销的编辑通过 pendingCategories 再次合入
    state.pendingCategories = {};
    state.pendingSystemPrompt = null;
    _settingsDirty = false;
    clearTimeout(_settingsSaveTimer);
    await api('POST', `/projects/${p.id}/restore`, { volumes: data.volumes, settings: data.settings });
    const was = state.currentChapter;
    await openProject(p.id, { resetHistory: false }); // 撤销/重做后保留历史栈(可继续撤销/重做)
    state.currentChapter = was;
    renderEditor();
    toast('已恢复', true);
  } catch (e) { toast('撤销失败: ' + e.message, false); throw e; }
}

// ---------- 自动保存(30s 定时 + 切页/关页刷新;静默 PATCH) ----------
let _dirty = false;
function markDirty() { _dirty = true; }

// ---------- 设定自动保存(输入防抖 1.5s + 切走/30s 周期兜底;静默 PUT,不打断编辑) ----------
let _settingsDirty = false;
let _settingsSaveTimer = null;

function markSettingsDirty() {
  _settingsDirty = true;
  clearTimeout(_settingsSaveTimer);
  _settingsSaveTimer = setTimeout(() => flushSettingsAutoSave(), 1500);
}

// 同步抓取当前 DOM 的设定并静默保存(不重绘、不打断)
function flushSettingsAutoSave() {
  if (!_settingsDirty || !state.current || state.viewMode !== 'settings') { _settingsDirty = false; return; }
  const p = state.current;
  let settings;
  try { settings = currentSettingsFromDom(); } catch { return; }
  _settingsDirty = false;
  clearTimeout(_settingsSaveTimer);
  api('PUT', `/projects/${p.id}/settings`, { settings })
    .then(() => {
      state.pendingSystemPrompt = settings.systemPrompt;
      // 把保存结果同步回 state.current(自动保存不整份重拉,否则树/徽章停留在旧数据)
      if (state.current && state.current.settings) state.current.settings = settings;
      // 同步 updated,避免轮询把"自己的保存"误判为外部变更
      if (state.current) state.current.updated = new Date().toISOString();
      // 已整份持久化:清空设定暂存,避免轮询/重绘时用旧 pending 覆盖刚保存的改动
      state.pendingCategories = {};
      // 分类/分类组名可能被改名:静默重绘目录树,保持目录与设定同步(不打断编辑区)
      renderTree();
      const hint = $('#settingsHint');
      if (hint && state.viewMode === 'settings' && !hint.textContent) {
        hint.textContent = '已自动保存';
        hint.className = 'save-hint ok';
        setTimeout(() => { if (hint.textContent === '已自动保存') hint.textContent = ''; }, 1200);
      }
    })
    .catch(() => { _settingsDirty = true; });
}

// 正文静默保存(供自动保存周期 + 切换离开正文前调用;返回 Promise 便于等待落盘)
async function flushChapterAutoSave() {
  if (!_dirty || !state.currentChapter || !state.current) return;
  const p = state.current;
  const cc = state.currentChapter;
  const content = $('#chContent').value;
  const title = $('#chTitle').value.trim();
  const status = $('#chStatus').value;
  try {
    const saved = await api('PATCH', `/projects/${p.id}/volumes/${cc.volumeId}/chapters/${cc.chapterId}`, { content, title, status });
    _dirty = false;
    // 同步更新前端内存中的章节内容,保证切回该章时渲染的是最新数据(服务端已保存)
    const v = (p.volumes || []).find((x) => x.id === cc.volumeId);
    const c = v && (v.chapters || []).find((x) => x.id === cc.chapterId);
    if (c) {
      c.content = content;
      c.title = title || c.title;
      c.status = status || c.status;
      c.wordCount = content.length;
      c.updated = new Date().toISOString();
    }
    // 同步 updated,避免轮询把"自己的保存"误判为外部变更
    if (saved && saved.updated) p.updated = saved.updated;
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const hint = $('#saveHint');
    if (hint) { hint.textContent = `已自动保存 ${hh}:${mm}`; hint.className = 'save-hint ok'; }
  } catch (e) { /* 静默失败,下个周期再试 */ }
}

async function autoSaveTick() {
  await flushChapterAutoSave();
}
setInterval(() => { autoSaveTick(); flushSettingsAutoSave(); }, 30000);
document.addEventListener('visibilitychange', () => { if (document.hidden) { autoSaveTick(); flushSettingsAutoSave(); } });
window.addEventListener('pagehide', () => {
  if (!_dirty || !state.currentChapter || !state.current) return;
  const p = state.current, cc = state.currentChapter;
  fetch(`/novelgen/api/projects/${p.id}/volumes/${cc.volumeId}/chapters/${cc.chapterId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: $('#chContent').value, title: $('#chTitle').value.trim(), status: $('#chStatus').value }),
    keepalive: true
  });
});

// ---------- 工具 ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, ok) {
  const el = $('#saveHint');
  el.textContent = msg;
  el.className = 'save-hint ' + (ok ? 'ok' : 'err');
  clearTimeout(toast._t);
  if (ok) toast._t = setTimeout(() => { el.textContent = ''; el.className = 'save-hint'; }, 2500);
}

function modal(title, value, placeholder) {
  return new Promise((resolve) => {
    $('#modalTitle').textContent = title;
    $('#modalInput').value = value || '';
    $('#modalInput').placeholder = placeholder || '名称';
    $('#modalMask').classList.remove('hidden');
    $('#modalInput').focus();
    const done = (v) => {
      $('#modalMask').classList.add('hidden');
      $('#modalOk').onclick = $('#modalCancel').onclick = $('#modalInput').onkeydown = null;
      resolve(v);
    };
    $('#modalOk').onclick = () => done($('#modalInput').value.trim() || null);
    $('#modalCancel').onclick = () => done(null);
    $('#modalInput').onkeydown = (e) => { if (e.key === 'Enter') done($('#modalInput').value.trim() || null); if (e.key === 'Escape') done(null); };
  });
}

// 条目总数(分类名下的条目 + 直挂条目)
function countEntries(c) {
  return c.groups ? c.groups.reduce((n, g) => n + (g.entries || []).length, 0) : (c.entries || []).length;
}

// ---------- 项目列表 ----------
async function loadProjects() {
  try {
    const data = await api('GET', '/projects');
    state.projects = data.projects;
    renderProjects();
  } catch (e) {
    $('#projectsList').innerHTML = `<div class="empty-tip">加载失败:${esc(e.message)}</div>`;
  }
}

function renderProjects() {
  const box = $('#projectsList');
  if (state.projects.length === 0) {
    box.innerHTML = '<div class="empty-tip">还没有项目。点右上角「新建项目」,或直接在 DSH 对话里让 AI 创建。</div>';
    return;
  }
  box.innerHTML = state.projects.map((p) => `
    <div class="project-item ${state.current && state.current.id === p.id ? 'active' : ''}" data-id="${esc(p.id)}">
      <span class="name">${esc(p.name)}</span>
      <span class="meta">${p.volumes}卷/${p.chapters}章</span>
      <span class="row-actions">
        <button class="icon-btn danger" data-act="del-project" title="删除项目(连同全部卷章设定,不可恢复)">✕</button>
      </span>
    </div>`).join('');
  box.querySelectorAll('.project-item').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('.icon-btn')) return;
      openProject(el.dataset.id);
    };
    bindDrag(el, { kind: 'project', pid: el.dataset.id });
  });
  // 项目删除
  box.querySelectorAll('[data-act="del-project"]').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const pid = btn.closest('.project-item').dataset.id;
      const name = (btn.closest('.project-item').querySelector('.name') || {}).textContent || '';
      if (!confirm(`确定删除项目「${name}」?将连同全部卷章与设定一并删除,不可恢复。`)) return;
      try {
        await api('DELETE', `/projects/${pid}`);
        toast('项目已删除', true);
        if (state.current && state.current.id === pid) {
          state.current = null;
          state.currentChapter = null;
          stopPolling();
        }
        await loadProjects();
        renderTree();
        renderEditor();
      } catch (err) { toast('删除失败: ' + err.message, false); }
    };
  });
}

async function createProject() {
  const name = await modal('新建小说项目', '', '项目名称,如《星际拾荒者》');
  if (!name) return;
  try {
    await api('POST', '/projects', { name });
    toast('项目已创建', true);
    await loadProjects();
    const p = state.projects.find((x) => x.name === name);
    if (p) await openProject(p.id);
  } catch (e) { toast('创建失败: ' + e.message, false); }
}

// ---------- 项目 / 树 ----------
// opts.resetHistory: true(默认)= 切换到另一个项目,清空撤销历史;
// false = 同项目刷新(删除/新建/重命名等结构操作后),保留历史以便撤销。
async function openProject(id, opts = {}) {
  try {
    await flushChapterAutoSave(); // 切项目/刷新前保存当前章正文(未修改时立即返回)
    const data = await api('GET', '/projects/' + encodeURIComponent(id));
    const switching = opts.resetHistory !== false;
    if (switching) {
      // 真正切换项目:清空未保存的设定暂存,避免旧项目的编辑污染新项目(同名分类串写)
      state.pendingCategories = {};
      state.pendingSystemPrompt = null;
      _settingsDirty = false;
      clearTimeout(_settingsSaveTimer);
    }
    state.current = data.project;
    state.currentChapter = null;
    _dirty = false;
    if (switching) clearHistory(); // 仅真正切换项目时清空撤销历史
    renderProjects();
    renderTree();
    renderEditor();
    startPolling(); // 开启服务端变更轮询(AI 在对话里写入后前端自动刷新)
  } catch (e) {
    toast('打开项目失败: ' + e.message, false);
  }
}

// ---------- 服务端变更轮询 ----------
// AI 在 DSH 对话里通过 novel_* 工具写入(正文/设定)时,前端不会自动感知。
// 每 2 秒比对项目 updated 时间戳,发现变化就静默刷新树与编辑器;
// 用户正在输入(_dirty/_settingsDirty)时只更新树,不覆盖输入框。
let _pollTimer = null;
let _polling = false;

function startPolling() {
  stopPolling();
  if (!state.current) return;
  _pollTimer = setInterval(syncFromServer, 2000);
}

function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

async function syncFromServer() {
  const cur = state.current;
  if (!cur || _polling) return;
  _polling = true;
  try {
    const data = await api('GET', '/projects/' + encodeURIComponent(cur.id));
    const fresh = data.project;
    if (!fresh || fresh.updated === cur.updated) return; // 无变化
    const wasChapter = state.currentChapter;
    const wasDirty = _dirty;
    const wasSettingsDirty = _settingsDirty;
    const wasViewMode = state.viewMode;
    const prevContent = $('#chContent') ? $('#chContent').value : null;
    const prevTitle = $('#chTitle') ? $('#chTitle').value : null;
    const prevStatus = $('#chStatus') ? $('#chStatus').value : null;
    // 正文视图的 state.current 整体替换;设定视图见下方分支(不重绘,按需合入缓存)
    state.current = wasViewMode === 'settings' ? { ...state.current, updated: fresh.updated, volumes: fresh.volumes, settings: state.current.settings } : fresh;
    renderProjects();
    renderTree();
    // 编辑器:正在输入时不重绘(避免丢内容);否则按最新数据刷新
    if (wasViewMode === 'editor' && !wasDirty) {
      renderEditor();
    } else if (wasViewMode === 'editor' && wasDirty && wasChapter) {
      // 正在编辑:仅当该章仍存在时保留现场,不重绘;章被删则清理引用
      const v = fresh.volumes.find((x) => x.id === wasChapter.volumeId);
      const c = v && v.chapters.find((x) => x.id === wasChapter.chapterId);
      if (!c) { state.currentChapter = null; _dirty = false; renderEditor(); }
    } else if (wasViewMode === 'settings') {
      // 设定视图【不重绘面板】:设定是用户主动编辑区,DOM 是唯一真相。
      // 轮询期间 AI 写入的最新设定先暂存,用户切走/重开面板时载入(见 openSettings),
      // 面板本身保持用户现场,不被旧缓存覆盖。
      if (!_settingsDirty) {
        state.pendingServerSettings = fresh.settings;
      }
    }
    // 编辑器内容:服务端正文更新而用户未编辑时,重绘后可能丢焦点/滚动,无碍
    const hint = $('#saveHint');
    if (hint && wasViewMode === 'editor') {
      hint.textContent = '已同步 AI 最新内容';
      hint.className = 'save-hint ok';
      setTimeout(() => { if (hint.textContent === '已同步 AI 最新内容') hint.textContent = ''; }, 1500);
    }
    void prevContent; void prevTitle; void prevStatus;
  } catch (e) { /* 轮询失败静默(网络抖动/服务重启) */ }
  finally { _polling = false; }
}

function renderTree() {
  const p = state.current;
  $('#treeTitle').innerHTML = p ? `<span>${esc(p.name)}</span>` : '选择项目';
  const body = $('#treeBody');
  if (!p) { body.innerHTML = '<div class="empty-tip">← 先在左侧选择一个项目</div>'; return; }

  // 目录栏:顶层两个入口「设定 / 正文」
  const cats = (p.settings && p.settings.categories) || [];
  const focus = state.settingsFocus;
  const catActive = (name) => state.viewMode === 'settings' && focus && focus.cat === name;

  // 固定模型:设定 → 分类组(可展开)→ 分类(成员)。分类必须属于分类组,无独立分类。
  const catHtml = (c) => {
    const groups = c.groups || [];
    const active = catActive(c.name);
    const open = !state._openCats || state._openCats[c.name] !== false;
    const children = groups.map((g) => `
      <div class="tree-row chapter settings-leaf ${active && focus.group === g.name ? 'active' : ''}" data-cat="${esc(c.name)}" data-group="${esc(g.name)}">
        <span class="label">${esc(g.name)}</span>
        <span class="badge">${(g.entries || []).length}条</span>
        <span class="row-actions">
          <button class="icon-btn" data-act="move-cat" title="移动到其他分类组">移动</button>
          <button class="icon-btn danger" data-act="del-member" title="删除该分类及其条目">✕</button>
        </span>
      </div>`).join('');
    return `
      <div class="tree-row category ${open ? 'open' : ''} ${active ? 'active' : ''}" data-cat="${esc(c.name)}">
        <span class="chevron">▶</span>
        <span class="label">${esc(c.name)}</span>
        <span class="badge">${groups.length}个分类</span>
        <span class="row-actions">
          <button class="icon-btn" data-act="add-group" title="在该分类组下新增分类">＋分类</button>
          <button class="icon-btn" data-act="rename-cat" title="重命名分类组">✎</button>
          <button class="icon-btn danger" data-act="del-cat" title="删除分类组及其全部分类">✕</button>
        </span>
      </div>
      <div class="tree-children ${open ? '' : 'hidden'}">${children || '<div class="empty-tip" style="font-size:12px">空分类组</div>'}</div>`;
  };

  const settingsOpen = state._openSettings !== false;
  const settingsDir = `
    <div class="tree-row volume settings-dir ${settingsOpen ? 'open' : ''} ${state.viewMode === 'settings' ? 'active' : ''}" id="rowSettings">
      <span class="chevron">▶</span>
      <span class="label">设定</span>
      <span class="badge">${cats.length}组</span>
      <span class="row-actions">
        <button class="icon-btn" data-act="add-grp" title="新增分类组">＋分类组</button>
      </span>
    </div>
    <div class="tree-children ${settingsOpen ? '' : 'hidden'}">
      ${cats.map(catHtml).join('') || '<div class="empty-tip" style="font-size:12px">(暂无设定)</div>'}
    </div>`;

  const bodyOpen = state._openBody !== false;
  const volumesHtml = p.volumes.length === 0
    ? '<div class="empty-tip">还没有卷。点「＋卷」创建,或在对话里让 AI 规划卷章结构。</div>'
    : p.volumes.map((v) => treeVolumeHtml(p, v)).join('');
  const bodyDir = `
    <div class="tree-row volume body-dir ${bodyOpen ? 'open' : ''}" id="rowBody">
      <span class="chevron">▶</span>
      <span class="label">正文</span>
      <span class="badge">${p.volumes.length}卷</span>
      <span class="row-actions">
        <button class="icon-btn" data-act="add-vol" title="新建卷">＋卷</button>
      </span>
    </div>
    <div class="tree-children ${bodyOpen ? '' : 'hidden'}">${volumesHtml}</div>`;

  body.innerHTML = settingsDir + bodyDir;
  bindTreeEvents(body);
}

// 打开设定视图:focus=null 显示设定首页;focus={cat,group?} 只显示选中的分类
// async:从正文切到设定前,先等待正文保存落盘(避免"切走后还没保存上")
async function openSettings(focus) {
  if (state.viewMode === 'editor' && _dirty && state.currentChapter) {
    await flushChapterAutoSave(); // 有未保存正文:等待保存落盘后再切换
  }
  stashSettings();
  flushSettingsAutoSave(); // 切走前自动保存设定改动
  // 若轮询期间 AI 在对话里改过设定(且本地无未保存改动):载入最新,让 AI 写入可见
  if (state.pendingServerSettings && !_settingsDirty) {
    if (state.current) state.current.settings = state.pendingServerSettings;
  }
  state.pendingServerSettings = null;
  state.viewMode = 'settings';
  state.settingsFocus = focus || null;
  state._openSettings = true;
  renderTree();
  renderEditor();
}

// 关闭设定,回到章节视图
function closeSettings() {
  stashSettings();
  flushSettingsAutoSave();
  state.viewMode = 'editor';
  state.settingsFocus = null;
  renderTree();
  renderEditor();
}

function treeVolumeHtml(p, v) {
  const open = state._openVols ? state._openVols[v.id] : true;
  const chapters = (v.chapters || []).map((c) => {
    const active = state.currentChapter && state.currentChapter.volumeId === v.id && state.currentChapter.chapterId === c.id;
    return `
      <div class="tree-row chapter ${active ? 'active' : ''}" data-vid="${esc(v.id)}" data-cid="${esc(c.id)}">
        <span class="label">${esc(c.title)}</span>
        <span class="badge">${c.wordCount}字</span>
        <span class="row-actions">
          <button class="icon-btn" data-act="rename-ch" title="重命名">✎</button>
          <button class="icon-btn danger" data-act="del-ch" title="删除">✕</button>
        </span>
      </div>`;
  }).join('');
  return `
    <div class="tree-row volume ${open ? 'open' : ''}" data-vid="${esc(v.id)}">
      <span class="chevron">▶</span>
      <span class="label">${esc(v.title)}</span>
      <span class="badge">${(v.chapters || []).length}章</span>
      <span class="row-actions">
        <button class="icon-btn" data-act="add-ch" title="新建章">＋章</button>
        <button class="icon-btn" data-act="rename-vol" title="重命名">✎</button>
        <button class="icon-btn danger" data-act="del-vol" title="删除卷">✕</button>
      </span>
    </div>
    <div class="tree-children ${open ? '' : 'hidden'}">${chapters || '<div class="empty-tip" style="font-size:12px">空卷</div>'}</div>`;
}

// ========== 目录拖拽排序(项目/卷/章/分类组/分类,可跨组移动) ==========
let dragSrc = null; // { kind:'project'|'vol'|'ch'|'cat'|'member', pid, vid, cid, cat, group, el }

function clearDropMark() {
  document.querySelectorAll('.tree-row.drop-before,.tree-row.drop-after,.tree-row.dragging,.project-item.drop-before,.project-item.drop-after,.project-item.dragging').forEach((r) => r.classList.remove('drop-before', 'drop-after', 'dragging'));
}

function canDrop(src, tgt) {
  if (!src || !tgt) return false;
  if (src.kind === 'project' && tgt.kind === 'project') return true;
  if (src.kind === 'vol' && tgt.kind === 'vol') return true;
  if (src.kind === 'ch') return tgt.kind === 'ch' || tgt.kind === 'vol';
  if (src.kind === 'cat' && tgt.kind === 'cat') return true;
  if (src.kind === 'member') return tgt.kind === 'member' || tgt.kind === 'cat';
  return false;
}

// 同一数组内移动:from 移除后按目标位插入(after 决定插在目标后还是前)
function moveInArr(arr, from, to, after) {
  if (from === to && !after) return arr;
  const [item] = arr.splice(from, 1);
  let ins = to + (after ? 1 : 0);
  if (from < ins) ins--;
  arr.splice(Math.max(0, Math.min(ins, arr.length)), 0, item);
  return arr;
}

function bindDrag(row, payload) {
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    dragSrc = { ...payload, el: row };
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', 'novelgen-dnd'); } catch { /* 部分浏览器要求 */ }
  });
  row.addEventListener('dragend', () => {
    clearDropMark();
    dragSrc = null;
  });
  row.addEventListener('dragover', (e) => {
    if (!dragSrc || !canDrop(dragSrc, payload)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = row.getBoundingClientRect();
    const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    clearDropMark();
    row.classList.add(pos === 'before' ? 'drop-before' : 'drop-after');
  });
  row.addEventListener('dragleave', () => {
    row.classList.remove('drop-before', 'drop-after');
  });
  row.addEventListener('drop', (e) => {
    if (!dragSrc || !canDrop(dragSrc, payload)) return;
    e.preventDefault();
    const pos = row.classList.contains('drop-before') ? 'before' : 'after';
    performDrop(dragSrc, payload, pos);
    clearDropMark();
    dragSrc = null;
  });
}

async function performDrop(src, tgt, pos) {
  const p = state.current;
  if (!p) return;
  try {
    if (src.kind === 'project' && tgt.kind === 'project') {
      // 项目排序:重排列表并持久化(项目级操作,不压入撤销历史)
      const ids = state.projects.map((x) => x.id);
      moveInArr(state.projects, ids.indexOf(src.pid), ids.indexOf(tgt.pid), pos === 'after');
      const newIds = state.projects.map((x) => x.id);
      await api('PUT', '/projects/order', { ids: newIds });
      renderProjects();
      return;
    }
    if (src.kind === 'vol' && tgt.kind === 'vol') {
      pushHistory();
      const ids = p.volumes.map((v) => v.id);
      moveInArr(p.volumes, ids.indexOf(src.vid), ids.indexOf(tgt.vid), pos === 'after');
      p.volumes.forEach((v, i) => v.order = i);
      await api('POST', `/projects/${p.id}/restore`, { volumes: p.volumes });
      await openProject(p.id, { resetHistory: false });
      commitHistory(); // 操作后状态入栈,支持重做
      renderEditor();
    } else if (src.kind === 'ch') {
      pushHistory();
      const srcV = p.volumes.find((v) => v.id === src.vid);
      const dstV = tgt.kind === 'ch' ? p.volumes.find((v) => v.id === tgt.vid) : (tgt.kind === 'vol' ? p.volumes.find((v) => v.id === tgt.vid) : null);
      if (!srcV || !dstV) return;
      const srcIdx = srcV.chapters.findIndex((c) => c.id === src.cid);
      if (srcIdx < 0) return;
      const [ch] = srcV.chapters.splice(srcIdx, 1);
      if (dstV === srcV) {
        const toIdx = srcV.chapters.findIndex((c) => c.id === tgt.cid);
        let ins = toIdx + (pos === 'after' ? 1 : 0);
        if (srcIdx < ins) ins--;
        srcV.chapters.splice(Math.max(0, ins), 0, ch);
      } else {
        const toIdx = tgt.kind === 'ch' ? dstV.chapters.findIndex((c) => c.id === tgt.cid) : -1;
        const ins = toIdx < 0 ? dstV.chapters.length : toIdx + (pos === 'after' ? 1 : 0);
        dstV.chapters.splice(ins, 0, ch);
      }
      p.volumes.forEach((v) => v.chapters.forEach((c, i) => c.order = i));
      await api('POST', `/projects/${p.id}/restore`, { volumes: p.volumes });
      await openProject(p.id, { resetHistory: false });
      commitHistory(); // 操作后状态入栈,支持重做
      state.currentChapter = { volumeId: dstV.id, chapterId: ch.id };
      renderEditor();
    } else if (src.kind === 'cat' && tgt.kind === 'cat') {
      // 用服务端最新设定做移动:先提交未保存的设定改动,避免过期暂存覆盖丢数据
      // (putSettings 内部会 pushHistory,此处不重复压栈)
      await flushSettingsAutoSave();
      const fresh = await api('GET', '/projects/' + encodeURIComponent(p.id));
      const settings = fresh.project.settings;
      const names = settings.categories.map((c) => c.name);
      moveInArr(settings.categories, names.indexOf(src.cat), names.indexOf(tgt.cat), pos === 'after');
      await putSettings(settings, null);
    } else if (src.kind === 'member') {
      // 同分类组移动:先提交未保存改动,基于服务端最新数据操作(putSettings 内部压栈)
      await flushSettingsAutoSave();
      const fresh = await api('GET', '/projects/' + encodeURIComponent(p.id));
      const settings = fresh.project.settings;
      const srcCat = settings.categories.find((c) => c.name === src.cat);
      if (!srcCat || !srcCat.groups) return;
      if (tgt.kind === 'member') {
        const dstCat = settings.categories.find((c) => c.name === tgt.cat);
        if (srcCat === dstCat) {
          const names = srcCat.groups.map((g) => g.name);
          moveInArr(srcCat.groups, names.indexOf(src.group), names.indexOf(tgt.group), pos === 'after');
        } else {
          const from = srcCat.groups.findIndex((g) => g.name === src.group);
          if (from < 0) return;
          const [g] = srcCat.groups.splice(from, 1);
          const toIdx = dstCat.groups.findIndex((m) => m.name === tgt.group);
          dstCat.groups.splice(toIdx + (pos === 'after' ? 1 : 0), 0, g);
        }
      } else if (tgt.kind === 'cat') {
        const from = srcCat.groups.findIndex((g) => g.name === src.group);
        if (from < 0) return;
        const [g] = srcCat.groups.splice(from, 1);
        const dstCat = settings.categories.find((c) => c.name === tgt.cat);
        if (!dstCat.groups) dstCat.groups = [];
        dstCat.groups.push(g);
      } else return;
      await putSettings(settings, null);
    }
  } catch (err) { toast('排序失败: ' + err.message, false); }
}

function bindTreeEvents(body) {

  // 可展开目录行:设定 / 正文 / 分类组 / 卷 —— 展开收起 + 记忆状态
  body.querySelectorAll('.tree-row.settings-dir, .tree-row.body-dir, .tree-row.category, .tree-row.volume').forEach((row) => {
    row.onclick = async (e) => {
      if (e.target.closest('.icon-btn')) return;
      const open = row.classList.toggle('open');
      row.nextElementSibling.classList.toggle('hidden');
      if (row.classList.contains('settings-dir')) {
        state._openSettings = open;
        if (open) await openSettings(null); // 展开时打开设定首页;收起时只收起(不再强制展开)
      } else if (row.classList.contains('body-dir')) {
        state._openBody = open;
      } else if (row.classList.contains('category')) {
        state._openCats = state._openCats || {};
        state._openCats[row.dataset.cat] = open;
        await openSettings({ cat: row.dataset.cat }); // 只显示选中的分类
      } else if (row.dataset.vid) {
        state._openVols = state._openVols || {};
        state._openVols[row.dataset.vid] = open;
      }
    };
  });
  // 设定叶行(组内成员分类):打开其详情并定位
  body.querySelectorAll('.tree-row.settings-leaf').forEach((row) => {
    row.onclick = async () => await openSettings({ cat: row.dataset.cat, group: row.dataset.group || null });
  });
  // 章行:打开编辑器(等待正文保存落盘后再切换,避免"切走后还没保存上")
  body.querySelectorAll('.tree-row.chapter:not(.settings-leaf)').forEach((row) => {
    row.onclick = async (e) => {
      if (e.target.closest('.icon-btn')) return;
      await openChapter(row.dataset.vid, row.dataset.cid);
    };
  });
  // 行内操作
  body.querySelectorAll('.icon-btn').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const act = btn.dataset.act;
      const p = state.current;
      const row = btn.closest('.tree-row');
      const vid = row.dataset.vid;
      const cid = row.dataset.cid;
      try {
        if (act === 'add-grp') {
          // 「＋分类组」:新增分类组
          const t = await modal('新增分类组', '', '分类组名,如"世界观"');
          if (!t) return;
          const settings = currentSettingsFromDom();
          settings.categories = settings.categories || [];
          settings.categories.push({ name: t, groups: [] });
          await putSettings(settings, { cat: t });
          return;
        }
        if (act === 'add-group') {
          // 分类组行「＋分类」:在该分类组下新增成员分类
          const t = await modal('新增分类', '', '分类名,如"新伊甸"');
          if (!t) return;
          const settings = currentSettingsFromDom();
          const grp = settings.categories.find((x) => x.name === row.dataset.cat);
          if (!grp) return;
          if (!grp.groups) grp.groups = [];
          grp.groups.push({ name: t, entries: [] });
          await putSettings(settings, { cat: row.dataset.cat, group: t });
          return;
        }
        if (act === 'move-cat') {
          // 「移动」:把分类从当前组搬到另一个分类组(组不存在自动创建)
          const t = await modal('移动到分类组', '', '目标分类组名(不存在将自动创建)');
          if (!t) return;
          const settings = currentSettingsFromDom();
          const src = settings.categories.find((x) => x.name === row.dataset.cat);
          if (!src || !src.groups) return;
          const gi = src.groups.findIndex((m) => m.name === row.dataset.group);
          if (gi < 0) return;
          const [member] = src.groups.splice(gi, 1);
          let dst = settings.categories.find((x) => x.name === t);
          if (!dst) { dst = { name: t, groups: [] }; settings.categories.push(dst); }
          if (!dst.groups) dst.groups = [];
          dst.groups.push(member);
          delete state.pendingCategories[row.dataset.cat + '::' + row.dataset.group];
          await putSettings(settings, { cat: t, group: member.name });
          return;
        }
        if (act === 'del-member') {
          const grpName = row.dataset.cat;
          const memberName = row.dataset.group;
          if (!confirm(`删除分类「${memberName}」及其全部条目?`)) return;
          const settings = currentSettingsFromDom();
          const grp = settings.categories.find((x) => x.name === grpName);
          if (grp && grp.groups) grp.groups = grp.groups.filter((m) => m.name !== memberName);
          delete state.pendingCategories[grpName + '::' + memberName];
          await putSettings(settings, { cat: grpName });
          return;
        }
        if (act === 'rename-cat') {
          const t = await modal('重命名分类组', row.dataset.cat, '新名称');
          if (!t || t === row.dataset.cat) return;
          const settings = currentSettingsFromDom();
          const c = settings.categories.find((x) => x.name === row.dataset.cat);
          if (!c) return;
          c.name = t;
          delete state.pendingCategories[row.dataset.cat];
          // 清理旧组名下的成员暂存键(旧组名::成员),避免改名后残留串写
          const prefix = row.dataset.cat + '::';
          for (const k of Object.keys(state.pendingCategories)) {
            if (k.startsWith(prefix)) delete state.pendingCategories[k];
          }
          const focusAfter = (state.settingsFocus && state.settingsFocus.cat === row.dataset.cat)
            ? { cat: t, group: state.settingsFocus.group || null }
            : null;
          await putSettings(settings, focusAfter);
          return;
        }
        if (act === 'del-cat') {
          if (!confirm(`删除分类组「${row.dataset.cat}」及其全部分类?`)) return;
          const settings = currentSettingsFromDom();
          settings.categories = settings.categories.filter((x) => x.name !== row.dataset.cat);
          delete state.pendingCategories[row.dataset.cat];
          await putSettings(settings, null);
          return;
        }
        if (act === 'add-vol') {
          const t = await modal('新建卷', '', '卷标题,如"第一卷 觉醒"');
          if (!t) return;
          pushHistory();
          await api('POST', `/projects/${p.id}/volumes`, { title: t });
          await openProject(p.id, { resetHistory: false });
          return;
        }
        if (act === 'add-ch') {
          const t = await modal('新建章', '', '章节标题,如"第一章 废墟来信"');
          if (!t) return;
          pushHistory();
          await api('POST', `/projects/${p.id}/volumes/${vid}/chapters`, { title: t });
        } else if (act === 'rename-vol') {
          const vol = p.volumes.find((x) => x.id === vid);
          const t = await modal('重命名卷', vol ? vol.title : '', '新卷标题');
          if (!t) return;
          pushHistory();
          await api('PATCH', `/projects/${p.id}/volumes/${vid}`, { title: t });
        } else if (act === 'del-vol') {
          if (!confirm(`确定删除整卷及其全部章节?`)) return;
          pushHistory();
          // 删除的是当前打开的卷时,丢弃未保存编辑并清除引用
          if (state.currentChapter && state.currentChapter.volumeId === vid) {
            _dirty = false;
            state.currentChapter = null;
          }
          await api('DELETE', `/projects/${p.id}/volumes/${vid}`);
        } else if (act === 'rename-ch') {
          const vol = p.volumes.find((x) => x.id === vid);
          const ch = vol && vol.chapters.find((x) => x.id === cid);
          const t = await modal('重命名章', ch ? ch.title : '', '新章节标题');
          if (!t) return;
          pushHistory();
          await api('PATCH', `/projects/${p.id}/volumes/${vid}/chapters/${cid}`, { title: t });
        } else if (act === 'del-ch') {
          if (!confirm(`确定删除章节?`)) return;
          pushHistory();
          // 删除的是当前打开的章时,先丢弃未保存编辑并清除引用,避免刷新时保存到已删章
          if (state.currentChapter && state.currentChapter.chapterId === cid) {
            _dirty = false;
            state.currentChapter = null;
          }
          await api('DELETE', `/projects/${p.id}/volumes/${vid}/chapters/${cid}`);
        }
        await openProject(p.id, { resetHistory: false });
        commitHistory(); // 操作后状态入栈,支持重做
      } catch (err) { toast(err.message, false); }
    };
  });

  // 拖拽排序:卷 / 章 / 分类组 / 分类(成员)
  body.querySelectorAll('.tree-row.volume[data-vid]').forEach((row) => bindDrag(row, { kind: 'vol', vid: row.dataset.vid }));
  body.querySelectorAll('.tree-row.chapter:not(.settings-leaf)[data-cid]').forEach((row) => bindDrag(row, { kind: 'ch', vid: row.dataset.vid, cid: row.dataset.cid }));
  body.querySelectorAll('.tree-row.category[data-cat]').forEach((row) => bindDrag(row, { kind: 'cat', cat: row.dataset.cat }));
  body.querySelectorAll('.tree-row.settings-leaf[data-group]').forEach((row) => bindDrag(row, { kind: 'member', cat: row.dataset.cat, group: row.dataset.group }));
}

// ---------- 编辑器 ----------
// async 切换:从正文切到另一章前,先等待当前章保存落盘(避免"切走后还没保存上")
async function openChapter(vid, cid) {
  const p = state.current;
  const v = p.volumes.find((x) => x.id === vid);
  const c = v && v.chapters.find((x) => x.id === cid);
  if (!c) return;
  if (state.viewMode === 'settings') {
    flushSettingsAutoSave(); // 从设定切到正文:先自动保存设定
  } else if (_dirty && state.currentChapter) {
    await flushChapterAutoSave(); // 有未保存正文:等待保存落盘后再切换
  }
  state.currentChapter = { volumeId: vid, chapterId: cid };
  state.viewMode = 'editor'; // 点章即回到章节视图
  _dirty = false; // 打开新章,未修改
  renderTree(); // 刷新选中态
  renderEditor();
}

function renderEditor() {
  const inner = $('#editorInner');
  const sp = $('#settingsPanel');
  const hint = $('#emptyHint');
  const p = state.current;
  if (!p) {
    hint.classList.remove('hidden'); inner.classList.add('hidden'); sp.classList.add('hidden');
    hint.innerHTML = '<div>从左侧选择项目与章节</div><div class="sub">也可以在 DSH 对话里让 AI 写作 —— 数据是同一份</div>';
    return;
  }
  // 设定模式:全屏展开设定,隐藏编辑器/提示
  if (state.viewMode === 'settings') {
    hint.classList.add('hidden'); inner.classList.add('hidden');
    sp.classList.remove('hidden'); sp.classList.add('full');
    renderSettings(p);
    return;
  }
  sp.classList.add('hidden'); sp.classList.remove('full');
  const ch = state.currentChapter ? (p.volumes.find((v) => v.id === state.currentChapter.volumeId)?.chapters || []).find((c) => c.id === state.currentChapter.chapterId) : null;
  if (!ch) {
    hint.classList.remove('hidden'); inner.classList.add('hidden');
    hint.innerHTML = `<div>项目「${esc(p.name)}」已打开 · 共 ${p.volumes.length} 卷</div><div class="sub">选择一章开始编辑,或在 DSH 对话里让 AI 写作;点目录栏「设定」维护全书设定</div>`;
    return;
  }
  hint.classList.add('hidden'); inner.classList.remove('hidden');
  $('#chTitle').value = ch.title || '';
  $('#chStatus').value = ch.status || 'draft';
  $('#chContent').value = ch.content || '';
  $('#wordCount').textContent = (ch.content || '').length + ' 字';
  updateHistoryButtons();
}

async function saveChapter() {
  const p = state.current;
  const cc = state.currentChapter;
  if (!p || !cc) return;
  const content = $('#chContent').value;
  const title = $('#chTitle').value.trim();
  const status = $('#chStatus').value;
  try {
    const data = await api('PATCH', `/projects/${p.id}/volumes/${cc.volumeId}/chapters/${cc.chapterId}`, { content, title, status });
    _dirty = false;
    toast(`已保存:${data.chapter.wordCount} 字`, true);
    await openProject(p.id, { resetHistory: false }); // 从服务端刷新树上的字数/状态(保留撤销历史)
    state.currentChapter = cc;
    renderEditor();
  } catch (e) { toast('保存失败: ' + e.message, false); }
}

// ---------- 设定(固定模型:分类组 → 分类 → 条目) ----------
// 分类必须属于分类组;分类直接挂条目(条目名 + 条目内容)。
// 数据:categories[] 顶层项全是分类组(groups = 成员分类);直挂条目的旧数据读写时自动收进「未整理」组。

const entryHtml = (e, ei) => `
  <div class="set-entry" data-entry-idx="${ei}">
    <input class="set-entry-name" value="${esc(e.name || '')}" placeholder="条目名">
    <textarea class="set-entry-content" placeholder="条目内容" ${e._height ? `style="height:${Number(e._height)}px"` : ''}>${esc(e.content || '')}</textarea>
    <span class="set-entry-btns">
      <button class="icon-btn" data-act="move-entry-up" title="上移条目">↑</button>
      <button class="icon-btn" data-act="move-entry-down" title="下移条目">↓</button>
      <button class="icon-btn danger" data-act="del-entry" title="删除条目">✕</button>
    </span>
  </div>`;

let _focusedOrig = null; // 当前详情卡片的原始分类对象(DOM 收集时合并未展示的成员/条目数据)

// 从「分类」卡片 DOM 收集(分类名 + 条目);同时记录条目文本域当前高度(_height,拖拽缩放持久化)
function gatherCategoryFromEl(catEl) {
  const cat = { name: catEl.querySelector('.set-name').value.trim() || '未命名分类' };
  const entriesEl = catEl.querySelector('.set-entries');
  cat.entries = entriesEl ? [...entriesEl.querySelectorAll('.set-entry')].map((en) => {
    const ta = en.querySelector('.set-entry-content');
    const entry = {
      name: en.querySelector('.set-entry-name').value.trim() || '未命名条目',
      content: ta ? ta.value : ''
    };
    if (ta && ta.offsetHeight > 0) entry._height = ta.offsetHeight; // 拖拽缩放后的高度
    return entry;
  }).filter((x) => x.name || x.content) : [];
  return cat;
}

// 从「分类组」卡片 DOM 收集(组名 + 成员分类;成员内容不在 DOM,按原名与原始数据合并)
function gatherGroupFromEl(groupEl, origMembers) {
  const g = { name: groupEl.querySelector('.set-name').value.trim() || '未命名分类组' };
  const byName = {};
  for (const m of origMembers || []) if (m && m.name) byName[m.name] = m;
  g.groups = [...groupEl.querySelectorAll('.member-row')].map((r) => {
    const name = r.dataset.group;
    if (!name) return null;
    const o = byName[name];
    return o ? { ...o, name } : { name, entries: [] };
  }).filter(Boolean);
  return g;
}

function gatherFocusedFromEl(card) {
  if (card.querySelector('.set-member-list')) return gatherGroupFromEl(card, _focusedOrig && _focusedOrig.groups);
  return gatherCategoryFromEl(card);
}

// 保留原条目上的附加字段(_height/_rows 等 UI 元数据),按条目名对齐
function preserveEntryMeta(gathered, origCat) {
  if (!origCat) return gathered;
  const orig = [];
  if (origCat.groups && origCat.groups.length > 0) for (const g of origCat.groups) orig.push(...(g.entries || []));
  else orig.push(...(origCat.entries || []));
  const byName = {};
  for (const e of orig) if (e && e.name) byName[e.name] = e;
  const collect = (list) => (list || []).forEach((en) => {
    const o = byName[en.name];
    if (!o) return;
    for (const k of Object.keys(o)) {
      if (k === 'name' || k === 'description' || k === 'content' || k in en) continue;
      en[k] = o[k];
    }
  });
  if (gathered.groups) for (const g of gathered.groups) collect(g.entries);
  else collect(gathered.entries);
  return gathered;
}

// 切换视图前暂存未保存的编辑(系统提示词 + 当前详情),切走不丢
function stashSettings() {
  const sp = $('#set-systemPrompt');
  if (sp) state.pendingSystemPrompt = sp.value;
  const card = $('#setCatRoot');
  if (card && state.settingsFocus && state.settingsFocus.cat) {
    const gathered = gatherFocusedFromEl(card);
    if (card.dataset.member) {
      // 组内成员分类:按 组名::成员原名 暂存
      state.pendingCategories[card.dataset.owner + '::' + card.dataset.orig] = gathered;
    } else {
      state.pendingCategories[state.settingsFocus.cat] = gathered;
      state.pendingCategories[gathered.name] = gathered;
    }
  }
}

// 当前完整设定 = DOM 正在编辑的部分 + 其余分类的最新值(含未保存的暂存)
function currentSettingsFromDom() {
  const base = JSON.parse(JSON.stringify((state.current.settings && state.current.settings.categories) || []));
  const spEl = $('#set-systemPrompt');
  const systemPrompt = spEl ? spEl.value : (state.pendingSystemPrompt ?? (state.current.settings && state.current.settings.systemPrompt) ?? '');
  let focusedName = null;
  const card = $('#setCatRoot');
  if (card) {
    const idx = Number(card.dataset.catIdx);
    const gathered = gatherFocusedFromEl(card);
    if (card.dataset.member) {
      // 组内成员:只更新所在分类组里的该成员(不替换整个组)
      const g = idx >= 0 && idx < base.length ? base[idx] : null;
      if (g && Array.isArray(g.groups)) {
        const mi = g.groups.findIndex((m) => m.name === card.dataset.orig);
        const orig = mi >= 0 ? g.groups[mi] : null;
        if (orig) { preserveEntryMeta(gathered, orig); g.groups[mi] = gathered; }
        else g.groups.push(gathered);
        focusedName = g.name; // 跳过该分类组的暂存覆盖(避免旧快照把刚改的成员名覆盖回去)
        // 成员改名后,旧名对应的暂存键已失效,清理避免残留
        delete state.pendingCategories[card.dataset.owner + '::' + card.dataset.orig];
      }
    } else {
      preserveEntryMeta(gathered, idx >= 0 && idx < base.length ? base[idx] : null);
      focusedName = gathered.name;
      if (idx >= 0 && idx < base.length) base[idx] = gathered;
    }
  }
  base.forEach((c, i) => {
    if (c.name === focusedName) return;
    const pend = state.pendingCategories[c.name];
    if (pend) base[i] = { ...pend };
    if (Array.isArray(c.groups)) {
      c.groups.forEach((m, mi) => {
        const mp = state.pendingCategories[c.name + '::' + (m && m.name)];
        if (mp) c.groups[mi] = { ...mp };
      });
    }
  });
  return { systemPrompt, categories: base };
}

// 保存(整份 PUT 归一化设定),随后刷新;focusAfter 决定保存后停留在哪个视图
async function saveSettingsFromDom(focusAfter) {
  clearTimeout(_settingsSaveTimer);
  _settingsDirty = false;
  const p = state.current;
  const settings = currentSettingsFromDom();
  await api('PUT', `/projects/${p.id}/settings`, { settings });
  const oldCat = state.settingsFocus && state.settingsFocus.cat;
  const newCat = focusAfter && focusAfter.cat;
  state.pendingCategories = Object.fromEntries(
    Object.entries(state.pendingCategories).filter(([k]) =>
      k !== oldCat && k !== newCat && !k.startsWith((oldCat || '') + '::') && !k.startsWith((newCat || '') + '::')
    )
  );
  state.pendingSystemPrompt = settings.systemPrompt;
  if (focusAfter) state.settingsFocus = focusAfter;
  await openProject(p.id, { resetHistory: false });
  return settings;
}

// 结构操作(加/移/删/改名):整份 PUT 后刷新,并按需跳转视图
async function putSettings(settings, focusAfter) {
  pushHistory(); // 结构级快照:设定/分类任何修改前压栈,可撤销
  const p = state.current;
  await api('PUT', `/projects/${p.id}/settings`, { settings });
  state.pendingSystemPrompt = settings.systemPrompt;
  await openProject(p.id, { resetHistory: false });
  commitHistory(); // 操作后状态入栈,支持重做
  if (focusAfter) await openSettings(focusAfter);
}

function refreshCatBadge(catEl) {
  const n = catEl.querySelectorAll('.set-entry').length;
  const badge = catEl.querySelector('.set-cat-head .set-badge');
  if (badge) badge.textContent = n + '条';
}

function renderSettings(p) {
  const box = $('#settingsBox');
  const s = (p && p.settings) || null;
  if (!s) { box.innerHTML = ''; return; }
  if (state.settingsFocus && state.settingsFocus.cat) renderCategoryDetail(box, s, p, state.settingsFocus);
  else renderSettingsHome(box, s, p);
}

// 设定首页:系统提示词 + 分类组索引(固定模型,点某个分类组才打开它的详情)
function renderSettingsHome(box, s, p) {
  box.innerHTML = `
    <div class="settings-crumbs">设定</div>
    <div class="field full"><label>系统提示词(全书风格约束)</label>
      <textarea id="set-systemPrompt" placeholder="写作风格、世界观约束……">${esc(state.pendingSystemPrompt ?? (s.systemPrompt || ''))}</textarea></div>
    <div class="settings-toolbar">
      <button class="btn sm" id="btnAddGroup">＋ 新增分类组</button>
      <span class="sub">固定结构:分类组 → 分类 → 条目;分类必须在分类组里</span>
    </div>
    <div id="setCatIndex"></div>
    <div class="settings-actions">
      <button class="btn primary" id="btnSaveSettings">保存设定</button>
      <span class="save-hint" id="settingsHint"></span>
    </div>`;

  $('#set-systemPrompt').oninput = () => { state.pendingSystemPrompt = $('#set-systemPrompt').value; };

  const idx = $('#setCatIndex');
  const cats = s.categories || [];
  if (cats.length === 0) {
    idx.innerHTML = '<div class="empty-tip">还没有设定。点「＋ 新增分类组」,或让 AI 在对话里整理设定。</div>';
  } else {
    idx.innerHTML = cats.map((c) => {
      const n = countEntries(c);
      return `
        <div class="cat-index-row" data-cat="${esc(c.name)}">
          <span class="ci-name" title="打开">${esc(c.name)}</span>
          <span class="ci-count">${(c.groups || []).length} 个分类 · ${n} 条</span>
          <span class="row-actions">
            <button class="icon-btn" data-act="open-cat" title="打开">打开</button>
            <button class="icon-btn" data-act="rename-cat" title="重命名">重命名</button>
            <button class="icon-btn danger" data-act="del-cat" title="删除">删除</button>
          </span>
        </div>`;
    }).join('');
  }

  idx.onclick = async (e) => {
    const row = e.target.closest('.cat-index-row');
    if (!row) return;
    const btn = e.target.closest('.icon-btn');
    const name = row.dataset.cat;
    try {
      if (btn && btn.dataset.act === 'rename-cat') {
        const t = await modal('重命名分类组', name, '新名称');
        if (!t || t === name) return;
        const settings = currentSettingsFromDom();
        const c = settings.categories.find((x) => x.name === name);
        if (!c) return;
        c.name = t;
        delete state.pendingCategories[name];
        // 清理旧组名下的成员暂存键(旧组名::成员)
        const prefix = name + '::';
        for (const k of Object.keys(state.pendingCategories)) {
          if (k.startsWith(prefix)) delete state.pendingCategories[k];
        }
        await putSettings(settings, null);
        return;
      }
      if (btn && btn.dataset.act === 'del-cat') {
        if (!confirm(`删除分类组「${name}」及其全部分类?`)) return;
        const settings = currentSettingsFromDom();
        settings.categories = settings.categories.filter((x) => x.name !== name);
        delete state.pendingCategories[name];
        await putSettings(settings, null);
        return;
      }
      // 点行或「打开」→ 打开该分类组详情
      openSettings({ cat: name });
    } catch (err) { toast('操作失败: ' + err.message, false); }
  };

  $('#btnAddGroup').onclick = async () => {
    const t = await modal('新增分类组', '', '分类组名,如"世界观"');
    if (!t) return;
    try {
      const settings = currentSettingsFromDom();
      settings.categories.push({ name: t, groups: [] });
      await putSettings(settings, { cat: t });
    } catch (err) { toast('新增失败: ' + err.message, false); }
  };

  $('#btnSaveSettings').onclick = async () => {
    try {
      await saveSettingsFromDom(null);
      const hint = $('#settingsHint');
      if (hint) { hint.textContent = '设定已保存'; hint.className = 'save-hint ok'; setTimeout(() => { hint.textContent = ''; }, 2500); }
    } catch (e) {
      const hint = $('#settingsHint');
      if (hint) { hint.textContent = '保存失败:' + e.message; hint.className = 'save-hint err'; }
    }
  };
}

// 详情分派:focus.group → 成员分类详情;否则 → 分类组详情(固定模型,顶层全是分类组)
function renderCategoryDetail(box, s, p, focus) {
  const cats = s.categories || [];
  const ci = cats.findIndex((c) => c.name === focus.cat);
  if (ci < 0) { renderSettingsHome(box, s, p); return; }
  let cat = cats[ci];
  const pend = state.pendingCategories[focus.cat];
  if (pend) cat = { ...pend, name: pend.name || cat.name };
  _focusedOrig = cat;

  if (focus.group) {
    const member = (cat.groups || []).find((g) => g.name === focus.group);
    if (member) {
      // 恢复该成员未保存的编辑(组名::成员名 暂存),避免切走再回来丢失
      const mp = state.pendingCategories[focus.cat + '::' + (member.name || '')];
      if (mp) {
        member.name = mp.name || member.name;
        member.entries = mp.entries || [];
      }
      renderMemberDetail(box, s, p, focus, ci, cat, member);
      return;
    }
  }
  renderGroupDetail(box, s, p, focus, ci, cat);
}

// 分类详情(分类组内成员):分类名 + 条目
function renderMemberDetail(box, s, p, focus, ci, ownerGroup, member) {
  box.innerHTML = `
    <div class="settings-crumbs">
      <button class="btn sm ghost" id="btnBackSettings">‹ 设定</button>
      <span class="crumb-sep">/</span>
      <button class="btn sm ghost" id="btnBackGroup">${esc(ownerGroup.name)}</button>
      <span class="crumb-sep">/</span>
      <span class="crumb-cur">${esc(member.name)}</span>
    </div>
    <div class="set-cat" id="setCatRoot" data-cat-idx="${ci}" data-member="1" data-owner="${esc(ownerGroup.name)}" data-orig="${esc(member.name)}">
      <div class="set-cat-head">
        <input class="set-name" value="${esc(member.name || '')}" placeholder="分类名(可自定义)">
        <span class="set-badge">${(member.entries || []).length}条</span>
        <span class="spacer"></span>
        <button class="icon-btn" data-act="add-entry" title="新增条目">＋条目</button>
        <button class="icon-btn" data-act="move-cat" title="移动到其他分类组">移动</button>
        <button class="icon-btn danger" data-act="del-member" title="删除该分类及其全部条目">✕</button>
      </div>
      <div class="set-entries" data-has-groups="false">${(member.entries || []).map(entryHtml).join('') || '<div class="empty-tip" style="font-size:12px">还没有条目,点「＋条目」添加</div>'}</div>
    </div>
    <div class="settings-actions">
      <button class="btn primary" id="btnSaveSettings">保存设定</button>
      <span class="save-hint" id="settingsHint"></span>
    </div>`;

  $('#btnBackSettings').onclick = () => openSettings(null);
  $('#btnBackGroup').onclick = () => openSettings({ cat: ownerGroup.name });

  box.onclick = async (e) => {
    const btn = e.target.closest('.icon-btn');
    if (!btn) return;
    const act = btn.dataset.act;
    const catEl = btn.closest('.set-cat');
    try {
      if (act === 'add-entry') {
        const container = catEl.querySelector('.set-entries');
        const empty = container.querySelector('.empty-tip');
        if (empty) empty.remove();
        container.insertAdjacentHTML('beforeend', '<div class="set-entry" data-entry-idx="0"><input class="set-entry-name" placeholder="条目名"><textarea class="set-entry-content" placeholder="条目内容"></textarea><span class="set-entry-btns"><button class="icon-btn" data-act="move-entry-up" title="上移条目">↑</button><button class="icon-btn" data-act="move-entry-down" title="下移条目">↓</button><button class="icon-btn danger" data-act="del-entry" title="删除条目">✕</button></span></div>');
        refreshCatBadge(catEl);
        markSettingsDirty(); // 点击型改动不触发 input,显式置脏,切走才会自动保存
      } else if (act === 'del-entry') {
        btn.closest('.set-entry').remove();
        refreshCatBadge(catEl);
        markSettingsDirty();
      } else if (act === 'move-entry-up' || act === 'move-entry-down') {
        const entry = btn.closest('.set-entry');
        if (!entry) return;
        const container = entry.parentElement;
        if (!container) return;
        if (act === 'move-entry-up' && entry.previousElementSibling) {
          container.insertBefore(entry, entry.previousElementSibling);
        } else if (act === 'move-entry-down' && entry.nextElementSibling) {
          container.insertBefore(entry.nextElementSibling, entry);
        }
        markSettingsDirty();
      } else if (act === 'move-cat') {
        // 「移动」:搬到另一个分类组(组不存在自动创建)
        const t = await modal('移动到分类组', '', '目标分类组名(不存在将自动创建)');
        if (!t) return;
        const card = $('#setCatRoot');
        const gathered = gatherFocusedFromEl(card);
        const settings = currentSettingsFromDom();
        const src = settings.categories[Number(card.dataset.catIdx)];
        if (!src || !src.groups) return;
        let gi = src.groups.findIndex((m) => m.name === card.dataset.orig);
        if (gi < 0) gi = src.groups.findIndex((m) => m.name === gathered.name);
        if (gi < 0) return;
        const [member2] = src.groups.splice(gi, 1);
        let dst = settings.categories.find((x) => x.name === t);
        if (!dst) { dst = { name: t, groups: [] }; settings.categories.push(dst); }
        if (!dst.groups) dst.groups = [];
        dst.groups.push(member2);
        delete state.pendingCategories[card.dataset.owner + '::' + card.dataset.orig];
        await putSettings(settings, { cat: t, group: member2.name });
      } else if (act === 'del-member') {
        const card = $('#setCatRoot');
        const shownName = (card.querySelector('.set-name').value || '').trim() || card.dataset.orig;
        if (!confirm(`删除分类「${shownName}」及其全部条目?`)) return;
        const settings = currentSettingsFromDom();
        const grp = settings.categories[Number(card.dataset.catIdx)];
        if (grp && grp.groups) grp.groups = grp.groups.filter((m) => m.name !== card.dataset.orig);
        delete state.pendingCategories[card.dataset.orig];
        delete state.pendingCategories[card.dataset.owner + '::' + card.dataset.orig];
        await putSettings(settings, { cat: state.settingsFocus.cat });
      }
    } catch (err) { toast('操作失败: ' + err.message, false); }
  };

  $('#btnSaveSettings').onclick = async () => {
    try {
      const card = $('#setCatRoot');
      const gathered = gatherFocusedFromEl(card);
      await saveSettingsFromDom({ cat: state.settingsFocus.cat, group: gathered.name });
      const hint = $('#settingsHint');
      if (hint) { hint.textContent = '设定已保存'; hint.className = 'save-hint ok'; setTimeout(() => { hint.textContent = ''; }, 2500); }
    } catch (e) {
      const hint = $('#settingsHint');
      if (hint) { hint.textContent = '保存失败:' + e.message; hint.className = 'save-hint err'; }
    }
  };
}

// 分类组详情:组名 + 成员分类清单(打开/移动/删除 + 新增分类)
function renderGroupDetail(box, s, p, focus, ci, cat) {
  const members = cat.groups || [];
  box.innerHTML = `
    <div class="settings-crumbs">
      <button class="btn sm ghost" id="btnBackSettings">‹ 设定</button>
      <span class="crumb-sep">/</span>
      <span class="crumb-cur">${esc(cat.name)}</span>
    </div>
    <div class="set-cat" id="setCatRoot" data-cat-idx="${ci}">
      <div class="set-cat-head">
        <input class="set-name" value="${esc(cat.name || '')}" placeholder="分类组名(可自定义)">
        <span class="set-badge">${members.length} 个分类</span>
        <span class="spacer"></span>
        <button class="icon-btn" data-act="add-member" title="在该分类组下新增分类">＋分类</button>
        <button class="icon-btn danger" data-act="del-group-cat" title="删除该分类组及其全部分类">✕</button>
      </div>
      <div class="set-member-list">
        ${members.length === 0 ? '<div class="empty-tip">空分类组,点「＋分类」加入分类</div>' : members.map((m) => `
          <div class="cat-index-row member-row" data-group="${esc(m.name)}">
            <span class="ci-name" title="打开该分类">${esc(m.name)}</span>
            <span class="ci-count">${(m.entries || []).length}条</span>
            <span class="row-actions">
              <button class="icon-btn" data-act="open-member" title="打开该分类">打开</button>
              <button class="icon-btn" data-act="move-member" title="移动到其他分类组">移动</button>
              <button class="icon-btn danger" data-act="del-member" title="删除该分类及其条目">✕</button>
            </span>
          </div>`).join('')}
      </div>
    </div>
    <div class="settings-actions">
      <button class="btn primary" id="btnSaveSettings">保存设定</button>
      <span class="save-hint" id="settingsHint"></span>
    </div>`;

  $('#btnBackSettings').onclick = () => openSettings(null);

  box.onclick = async (e) => {
    const btn = e.target.closest('.icon-btn');
    const row = e.target.closest('.member-row');
    if (row && !btn) { openSettings({ cat: focus.cat, group: row.dataset.group }); return; }
    if (!btn) return;
    const act = btn.dataset.act;
    const card = $('#setCatRoot');
    try {
      if (act === 'add-member') {
        const t = await modal('新增分类', '', '分类名,如"新伊甸"');
        if (!t) return;
        const settings = currentSettingsFromDom();
        const grp = settings.categories[Number(card.dataset.catIdx)];
        if (!grp) return;
        if (!grp.groups) grp.groups = [];
        grp.groups.push({ name: t, entries: [] });
        await putSettings(settings, { cat: focus.cat, group: t });
      } else if (act === 'open-member') {
        openSettings({ cat: focus.cat, group: row.dataset.group });
      } else if (act === 'move-member') {
        const t = await modal('移动到分类组', '', '目标分类组名(不存在将自动创建)');
        if (!t) return;
        const settings = currentSettingsFromDom();
        const src = settings.categories[Number(card.dataset.catIdx)];
        if (!src || !src.groups) return;
        const gi = src.groups.findIndex((m) => m.name === row.dataset.group);
        if (gi < 0) return;
        const [m2] = src.groups.splice(gi, 1);
        let dst = settings.categories.find((x) => x.name === t);
        if (!dst) { dst = { name: t, groups: [] }; settings.categories.push(dst); }
        if (!dst.groups) dst.groups = [];
        dst.groups.push(m2);
        delete state.pendingCategories[focus.cat + '::' + row.dataset.group];
        await putSettings(settings, { cat: focus.cat });
      } else if (act === 'del-member') {
        if (!confirm(`删除分类「${row.dataset.group}」及其全部条目?`)) return;
        const settings = currentSettingsFromDom();
        const grp = settings.categories[Number(card.dataset.catIdx)];
        if (grp && grp.groups) grp.groups = grp.groups.filter((m) => m.name !== row.dataset.group);
        delete state.pendingCategories[focus.cat + '::' + row.dataset.group];
        await putSettings(settings, { cat: focus.cat });
      } else if (act === 'del-group-cat') {
        const name = (card.querySelector('.set-name').value || '').trim() || focus.cat;
        if (!confirm(`删除分类组「${name}」及其全部分类?`)) return;
        const settings = currentSettingsFromDom();
        settings.categories.splice(Number(card.dataset.catIdx), 1);
        delete state.pendingCategories[focus.cat];
        await putSettings(settings, null);
      }
    } catch (err) { toast('操作失败: ' + err.message, false); }
  };

  $('#btnSaveSettings').onclick = async () => {
    try {
      const gathered = gatherFocusedFromEl($('#setCatRoot'));
      await saveSettingsFromDom({ cat: gathered.name, group: null });
      const hint = $('#settingsHint');
      if (hint) { hint.textContent = '设定已保存'; hint.className = 'save-hint ok'; setTimeout(() => { hint.textContent = ''; }, 2500); }
    } catch (e) {
      const hint = $('#settingsHint');
      if (hint) { hint.textContent = '保存失败:' + e.message; hint.className = 'save-hint err'; }
    }
  };
}

// ---------- 导入 / 导出 ----------

// 解析 CSV/TSV(逗号或制表符分隔,支持双引号转义与换行)
function parseDelimited(text) {
  const delim = text.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

// 把解析出的行数组(表头自动识别)转成 [{volume, chapter, content}]
function rowsToItems(rows) {
  if (rows.length === 0) return [];
  // 严格表头识别:每个单元格恰好是 卷/章/正文 等关键词(避免把数据行误判为表头)
  const HEADER_CELL = /^(卷|章|章节|正文|内容|标题|vol|volume|chapter|title|content|text)$/i;
  const isHeader = rows[0].length > 0 && rows[0].every((c) => HEADER_CELL.test(String(c).trim()));
  const body = isHeader ? rows.slice(1) : rows;
  const items = [];
  for (const r of body) {
    if (r.length === 0) continue;
    const volume = (r[0] || '').trim();
    const chapter = (r.length > 1 ? r[1] : '').trim();
    const content = (r.length > 2 ? r[2] : '').trim();
    if (!chapter && !content && !volume) continue;
    items.push({ volume: volume || '未命名卷', chapter: chapter || '未命名章', content });
  }
  return items;
}

// 解析 TXT: # 卷名 / ## 章名 / 其他行 = 正文
function parseTxt(text) {
  const items = [];
  let volume = '正文', chapter = null, buf = [];
  const flush = () => {
    if (chapter) items.push({ volume, chapter, content: buf.join('\n').trim() });
    buf = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^#\s+/.test(line)) { flush(); volume = line.replace(/^#\s+/, '').trim(); chapter = null; }
    else if (/^##\s+/.test(line)) { flush(); chapter = line.replace(/^##\s+/, '').trim(); }
    else if (chapter) buf.push(line);
  }
  flush();
  if (items.length === 0) items.push({ volume: '正文', chapter: '全文', content: text.trim() });
  return items;
}

function loadSheetJS() {
  return new Promise((resolve, reject) => {
    if (window.XLSX) return resolve(window.XLSX);
    const s = document.createElement('script');
    s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('加载 XLSX 解析库失败,请检查网络;CSV/TXT 可离线导入'));
    document.head.appendChild(s);
  });
}

// 导入:选择文件 → 解析 → 建新项目(项目名=文件名)→ 建卷章写正文
async function importFromFile(file) {
  const name = (file.name || '导入项目').replace(/\.(csv|tsv|txt|xlsx|xls)$/i, '');
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  let items;
  if (ext === 'xlsx' || ext === 'xls') {
    const XLSX = await loadSheetJS();
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false });
    items = rowsToItems(rows);
  } else {
    const text = await file.text();
    items = ext === 'txt' ? parseTxt(text) : rowsToItems(parseDelimited(text));
  }
  if (items.length === 0) throw new Error('文件中没有解析到任何章节内容');

  toast(`导入中:${items.length} 章…`, true);
  const created = await api('POST', '/projects', { name });
  const pid = created.project.id;
  const volumeIds = {};
  for (const it of items) {
    if (!volumeIds[it.volume]) {
      const v = await api('POST', `/projects/${pid}/volumes`, { title: it.volume });
      volumeIds[it.volume] = v.volume.id;
    }
    const c = await api('POST', `/projects/${pid}/volumes/${volumeIds[it.volume]}/chapters`, { title: it.chapter });
    if (it.content) {
      await api('PATCH', `/projects/${pid}/volumes/${volumeIds[it.volume]}/chapters/${c.chapter.id}`, { content: it.content });
    }
  }
  toast(`导入完成:${items.length} 章`, true);
  await loadProjects();
  await openProject(pid);
}

// 导出当前项目
async function exportProject() {
  const p = state.current;
  if (!p) { toast('先打开一个项目再导出', false); return; }
  const kind = await modal('导出格式', 'txt', 'txt 或 xlsx');
  if (!kind) return;
  const k = kind.toLowerCase();
  if (k !== 'txt' && k !== 'xlsx') { toast('仅支持 txt / xlsx', false); return; }

  const lines = [];
  for (const v of p.volumes) {
    lines.push(`# ${v.title}`);
    for (const c of v.chapters) {
      lines.push(`## ${c.title}`);
      if (c.content) lines.push('', c.content, '');
    }
  }
  if (k === 'txt') {
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${p.name}.txt`; a.click();
    URL.revokeObjectURL(url);
    toast(`已导出 ${p.name}.txt`, true);
  } else {
    try {
      const XLSX = await loadSheetJS();
      const data = [['卷', '章', '正文']];
      for (const v of p.volumes) for (const c of v.chapters) data.push([v.title, c.title, c.content || '']);
      const ws = XLSX.utils.aoa_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '章节');
      XLSX.writeFile(wb, `${p.name}.xlsx`);
      toast(`已导出 ${p.name}.xlsx`, true);
    } catch (e) { toast('XLSX 导出失败:' + e.message, false); }
  }
}

// ---------- 数据目录(自定义工作区) ----------
async function changeDataRoot() {
  const cur = ($('#rootPath').dataset.root || '').trim();
  const next = await modal('数据目录(自定义工作区)', cur, '例如 D:/小说库 或 D:/novelgen/novels');
  if (!next) return;
  try {
    const data = await api('PUT', '/config', { root: next });
    $('#rootPath').textContent = '数据目录: ' + data.root;
    $('#rootPath').title = data.root;
    $('#rootPath').dataset.root = data.root;
    // 旧目录的当前项目已失效,清空并重载
    state.current = null;
    state.currentChapter = null;
    state.pendingCategories = {};
    state.pendingSystemPrompt = null;
    _settingsDirty = false;
    clearTimeout(_settingsSaveTimer);
    _dirty = false;
    stopPolling();
    renderProjects();
    renderTree();
    renderEditor();
    toast('数据目录已切换', true);
    await loadProjects();
  } catch (e) {
    const msg = /未找到路由|404/.test(e.message) ? 'dsh web 尚未重启,新接口未加载 —— 请重启 dsh web 后重试' : e.message;
    toast('切换失败: ' + msg, false);
  }
}

// ---------- 事件 ----------
$('#btnNewProject').onclick = createProject;
$('#btnSave').onclick = saveChapter;
$('#btnUndo').onclick = () => undoRedo(-1);
$('#btnRedo').onclick = () => undoRedo(1);
$('#btnChangeRoot').onclick = changeDataRoot;
$('#btnCloseSettings').onclick = closeSettings;
$('#btnImport').onclick = () => $('#fileInput').click();
$('#btnExport').onclick = exportProject;
$('#fileInput').onchange = async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try { await importFromFile(file); }
  catch (err) { toast('导入失败: ' + err.message, false); }
};
$('#chContent').oninput = () => { $('#wordCount').textContent = $('#chContent').value.length + ' 字'; markDirty(); };
$('#chTitle').oninput = markDirty;
$('#chStatus').onchange = markDirty;

// ---------- 项目栏隐藏/显示(仅当前会话;刷新后恢复显示,避免"看不到项目"困惑) ----------
function setProjectsHidden(h) {
  const panel = $('#projectsPanel'), rail = $('#projectsRail');
  if (panel) panel.classList.toggle('hidden', h);
  if (rail) rail.classList.toggle('hidden', !h);
}
$('#btnHideProjects').onclick = () => setProjectsHidden(true);
$('#projectsRail').onclick = () => setProjectsHidden(false);
try { localStorage.removeItem('novelgen.projectsHidden'); } catch { /* 忽略 */ }

// 设定编辑自动保存:任何输入都标记脏(防抖 1.5s 后静默保存)
$('#settingsBox').addEventListener('input', () => markSettingsDirty());
// 条目文本域拖拽缩放:不触发 input,但高度要持久化(_height 随设定保存到服务端)
$('#settingsBox').addEventListener('resize', (e) => {
  const ta = e.target;
  if (ta && ta.classList && ta.classList.contains('set-entry-content')) {
    // 把新高度写回该条目的 DOM 记录,供 gatherCategoryFromEl 收集(_height)
    const entry = ta.closest('.set-entry');
    if (entry) entry.dataset.height = String(ta.offsetHeight);
    markSettingsDirty();
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveChapter(); return; }
  // 撤销/重做:打字区(textarea/input)内让位给原生撤销;其余位置走结构级栈
  const inEditor = e.target && (e.target.id === 'chContent' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT');
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
    if (inEditor) return;
    e.preventDefault();
    undoRedo(e.shiftKey ? 1 : -1);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
    if (inEditor) return;
    e.preventDefault();
    undoRedo(1);
  }
});

// ---------- 版本快照(自动备份)面板 ----------
// 每次正文/设定写入前,旧版本自动存为带时间戳的快照(见 store.snapshotBeforeWrite)。
// 打开面板列出快照,可选择恢复(恢复前自动快照当前版本,可再退回)。
async function openBackupsPanel() {
  const p = state.current;
  if (!p) { toast('请先选择一个项目', false); return; }
  const mask = $('#backupMask');
  const list = $('#backupList');
  mask.classList.remove('hidden');
  list.innerHTML = '<div class="backup-empty">加载中…</div>';
  try {
    const data = await api('GET', `/projects/${p.id}/backups`);
    const backups = data.backups || [];
    if (backups.length === 0) {
      list.innerHTML = '<div class="backup-empty">暂无备份。每次写入正文/设定时,旧版本会自动保存为快照(约 5 分钟一次,保留最近 20 份)。</div>';
      return;
    }
    list.innerHTML = backups.map((b) => `
      <div class="backup-item" data-ts="${b.ts}">
        <span class="time">${b.time}</span>
        <span class="scope">${[b.hasVolumes ? '正文' : '', b.hasSettings ? '设定' : ''].filter(Boolean).join(' + ') || '—'}</span>
        <button class="icon-btn" data-ts="${b.ts}" title="恢复到该版本">↩ 恢复</button>
      </div>`).join('');
    list.querySelectorAll('[data-ts]').forEach((el) => {
      el.onclick = async () => {
        const ts = el.dataset.ts;
        if (!confirm(`确定恢复到 ${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(8, 10)}:${ts.slice(10, 12)} 的版本?\n当前版本会自动保留为备份,可随时退回。`)) return;
        try {
          await api('POST', `/projects/${p.id}/backups/restore`, { ts });
          toast('已恢复备份', true);
          mask.classList.add('hidden');
          await openProject(p.id);
        } catch (e) { toast('恢复失败: ' + e.message, false); }
      };
    });
  } catch (e) {
    const msg = /未找到路由/.test(e.message) ? '备份功能需重启 dsh web 后生效' : e.message;
    list.innerHTML = `<div class="backup-empty">加载失败:${esc(msg)}</div>`;
  }
}

$('#btnBackups').onclick = openBackupsPanel;
$('#btnBackupClose').onclick = () => $('#backupMask').classList.add('hidden');
$('#backupMask').onclick = (e) => { if (e.target === e.currentTarget) $('#backupMask').classList.add('hidden'); };

// ---------- 启动 ----------
(async function init() {
  try {
    const health = await api('GET', '/health');
    $('#rootPath').textContent = '数据目录: ' + health.root;
    $('#rootPath').title = health.root;
    $('#rootPath').dataset.root = health.root;
  } catch (e) { $('#rootPath').textContent = '数据目录: 未知'; }
  await loadProjects();
  // 默认选中第一个项目(用户上次打开的会话状态不持久化,打开即见最近项目)
  if (state.projects.length > 0) await openProject(state.projects[0].id);
})();
