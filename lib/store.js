// ==================== NovelGen-DSH 数据存储(纯 Node,框架无关) ====================
// 每个项目一个目录:<root>/<projectId>/,正文与设定分文件存放:
//   project.json   元数据(id/name/created/updated/schemaVersion,极小)
//   volumes.json   正文:卷 → 章 → 内容
//   settings.json  设定:settingTypes
// 旧单文件布局(全部塞在 project.json)读取时自动回退兼容;
// 首次任意写入时自动拆分为三文件(project.json 只留元数据)。
// 采用 WPS 风格原子写:先写备份 → 写临时文件 → rename 替换 → 删除备份。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------- 常量 ----------

const SCHEMA_VERSION = 1;
const PROJECT_FILE = 'project.json';
const VOLUMES_FILE = 'volumes.json';
const SETTINGS_FILE = 'settings.json';
const PROJECTS_ORDER_FILE = 'projects.order.json';
const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;

// ---------- 工具函数 ----------

function now() {
  return new Date().toISOString();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function emptySettings() {
  return {
    systemPrompt: '',
    settingTypes: []
  };
}

function newProject(name) {
  return {
    id: randomUUID(),
    name,
    created: now(),
    updated: now(),
    schemaVersion: SCHEMA_VERSION,
    volumes: [],
    settings: emptySettings()
  };
}

function newVolume(title, order) {
  return { id: randomUUID(), title: title || '新卷', order, chapters: [] };
}

function newChapter(title, order) {
  return {
    id: randomUUID(),
    title: title || '新章',
    content: '',
    wordCount: 0,
    status: 'draft',
    order,
    updated: now()
  };
}

// WPS 风格原子写:先写备份 → 写临时文件 → rename 替换 → 删除备份
function atomicWrite(dir, filename, data) {
  const file = path.join(dir, filename);
  const bak = file + '.autosave';
  const tmp = file + '.tmp';
  const content = JSON.stringify(data, null, 2);
  fs.writeFileSync(bak, content, 'utf-8');   // 先写备份
  fs.writeFileSync(tmp, content, 'utf-8');    // 写临时文件
  fs.renameSync(tmp, file);                    // 原子替换正式文件
  try { fs.unlinkSync(bak); } catch { /* 忽略 */ }
}

// ---------- 版本快照(自动备份) ----------
// 每次正文/设定落盘前,把旧文件复制为带时间戳的版本快照:
//   <root>/backups/<projectId>/volumes-<YYYYMMDDHHmmss>.json  /  settings-<...>.json
// 节流:距上次同文件备份不足 BACKUP_MIN_GAP_MS 跳过(自动保存频繁,避免刷爆)
// 上限:每项目每类最多保留 BACKUP_MAX_KEEP 份,超出删最旧。
// 具体实现函数(snapshotBeforeWrite/listBackups/restoreBackup)在 createNovelStore 内,
// 因为依赖其闭包内的 resolve()/projectDir()/projectPath()。
const BACKUP_MIN_GAP_MS = 5 * 60 * 1000;  // 5 分钟
const BACKUP_MAX_KEEP = 20;

function backupStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function formatBackupTime(ts) {
  const p = (s, i) => String(s).slice(i, i + 2);
  return `${p(ts, 0)}-${p(ts, 2)}-${p(ts, 4)} ${p(ts, 6)}:${p(ts, 8)}:${p(ts, 10)}`;
}

// 项目元数据(不含 volumes/settings)
function metaOnly(project) {
  return {
    id: project.id,
    name: project.name,
    created: project.created,
    updated: project.updated,
    schemaVersion: project.schemaVersion ?? SCHEMA_VERSION
  };
}

// 固定模型:分类必须属于分类组。直挂条目的分类在读写时自动收进「未整理」分类组(自愈,兼容老数据)。
function ensureGrouped(cat) {
  if (Array.isArray(cat.groups)) return cat;
  return { ...cat, groups: [{ name: '未整理', entries: cat.entries || [] }] };
}

// ---------- store ----------

/**
 * 创建 NovelGen 存储。
 * @param {string | (() => string)} root 小说数据根目录(绝对路径),不存在会自动创建。
 *   传函数时每次操作实时解析 —— 支持运行中切换数据目录(自定义工作区)。
 */
export function createNovelStore(root) {
  function resolve() {
    const r = typeof root === 'function' ? root() : root;
    if (typeof r !== 'string' || r.trim() === '') throw new Error('novelgen: 数据目录未配置');
    const absolute = path.resolve(r.trim());
    ensureDir(absolute);
    return absolute;
  }

  const projectDir = (id) => path.join(resolve(), id);
  const projectPath = (id) => path.join(projectDir(id), PROJECT_FILE);

  function assertProjectFile(id) {
    if (!fs.existsSync(projectPath(id))) throw new Error(`项目不存在: ${id}`);
  }

  // 读取:元数据来自 project.json;正文/设定来自 volumes.json / settings.json,
  // 旧单文件布局(project.json 内嵌 volumes/settings)自动回退
  // 单个 JSON 文件损坏时不抛错:该项目对应部分按空处理,避免整项目/整列表不可读
  function readJsonSafe(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
    catch { return fallback; }
  }

  function readProject(id) {
    assertProjectFile(id);
    const dir = projectDir(id);
    const meta = readJsonSafe(projectPath(id), {});
    if (typeof meta.schemaVersion === 'undefined') meta.schemaVersion = SCHEMA_VERSION;
    const vp = path.join(dir, VOLUMES_FILE);
    if (fs.existsSync(vp)) meta.volumes = readJsonSafe(vp, {}).volumes || [];
    else meta.volumes = meta.volumes || [];
    const sp = path.join(dir, SETTINGS_FILE);
    if (fs.existsSync(sp)) meta.settings = readJsonSafe(sp, {}).settings || emptySettings();
    else meta.settings = meta.settings || emptySettings();
    return meta;
  }

  // 只读元数据(列表用,不碰正文/设定文件)
  function readProjectMeta(id) {
    const data = readJsonSafe(projectPath(id), {});
    if (typeof data.schemaVersion === 'undefined') data.schemaVersion = SCHEMA_VERSION;
    return data;
  }

  // 列表统计用的正文卷章(旧布局回退到 project.json)
  function readVolumesForList(id) {
    const vp = path.join(projectDir(id), VOLUMES_FILE);
    if (fs.existsSync(vp)) return readJsonSafe(vp, {}).volumes || [];
    const meta = readProjectMeta(id);
    return meta.volumes || [];
  }

  function touch(project) {
    project.updated = now();
    return project;
  }

  // 元数据落盘(project.json,极小)
  function saveMeta(project) {
    ensureDir(projectDir(project.id));
    atomicWrite(projectDir(project.id), PROJECT_FILE, metaOnly(project));
    return project;
  }

  // 正文落盘:只写 volumes.json + 刷新元数据时间戳;若还是旧单文件布局,顺手补写 settings.json 完成拆分
  function saveVolumes(project) {
    touch(project);
    const dir = projectDir(project.id);
    ensureDir(dir);
    snapshotBeforeWrite(project.id, VOLUMES_FILE); // 写前快照旧正文
    atomicWrite(dir, VOLUMES_FILE, { volumes: project.volumes || [] });
    const sp = path.join(dir, SETTINGS_FILE);
    if (!fs.existsSync(sp)) { snapshotBeforeWrite(project.id, SETTINGS_FILE); atomicWrite(dir, SETTINGS_FILE, { settings: project.settings || emptySettings() }); }
    atomicWrite(dir, PROJECT_FILE, metaOnly(project));
    return project;
  }

  // 设定落盘:只写 settings.json + 刷新元数据时间戳;旧布局时顺手补写 volumes.json 完成拆分
  function saveSettingsFile(project) {
    touch(project);
    const dir = projectDir(project.id);
    ensureDir(dir);
    snapshotBeforeWrite(project.id, SETTINGS_FILE); // 写前快照旧设定
    atomicWrite(dir, SETTINGS_FILE, { settings: project.settings || emptySettings() });
    const vp = path.join(dir, VOLUMES_FILE);
    if (!fs.existsSync(vp)) { snapshotBeforeWrite(project.id, VOLUMES_FILE); atomicWrite(dir, VOLUMES_FILE, { volumes: project.volumes || [] }); }
    atomicWrite(dir, PROJECT_FILE, metaOnly(project));
    return project;
  }

  // ---------- 项目 CRUD ----------

  function listProjects() {
    const base = resolve();
    const dirs = fs.readdirSync(base).filter((d) => {
      const p = path.join(base, d);
      try { return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, PROJECT_FILE)); }
      catch { return false; }
    });
    const metas = dirs.map((d) => {
      const meta = readProjectMeta(d);
      const volumes = readVolumesForList(d);
      return projectMeta(meta, volumes);
    });
    // 用户拖拽排序优先(projects.order.json),未配置时回退按更新时间倒序
    const order = readProjectsOrder();
    if (order && order.length > 0) {
      const byId = new Map(metas.map((m) => [m.id, m]));
      const ordered = order.map((id) => byId.get(id)).filter(Boolean);
      const rest = metas.filter((m) => !ordered.includes(m)).sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
      return [...ordered, ...rest];
    }
    return metas.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  }

  function readProjectsOrder() {
    try {
      const p = path.join(resolve(), PROJECTS_ORDER_FILE);
      if (!fs.existsSync(p)) return null;
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return Array.isArray(data?.ids) ? data.ids : null;
    } catch { return null; }
  }

  /** 保存项目显示顺序(拖拽排序持久化):ids = 项目 ID 列表,按期望显示顺序 */
  function orderProjects(ids) {
    if (!Array.isArray(ids)) throw new Error('项目顺序必须是数组');
    const base = resolve();
    const seen = new Set();
    const clean = [];
    for (const id of ids) {
      assertProjectFile(id);
      if (seen.has(id)) continue; // 去重
      seen.add(id);
      clean.push(id);
    }
    // 补全:漏掉的项目追加到末尾,避免静默丢位
    const all = listProjectIds();
    for (const id of all) {
      if (!seen.has(id)) clean.push(id);
    }
    atomicWrite(base, PROJECTS_ORDER_FILE, { ids: clean });
    return { ids: clean };
  }

  // 全部项目 ID(按当前目录序,仅用于补全)
  function listProjectIds() {
    const base = resolve();
    return fs.readdirSync(base).filter((d) => {
      const p = path.join(base, d);
      try { return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, PROJECT_FILE)); }
      catch { return false; }
    });
  }

  function projectMeta(p, volumes) {
    let volCount = 0, chapters = 0, words = 0;
    for (const v of volumes || []) {
      volCount += 1;
      for (const c of v.chapters || []) {
        chapters += 1;
        words += (c.content || '').length;
      }
    }
    return {
      id: p.id,
      name: p.name,
      created: p.created,
      updated: p.updated,
      volumes: volCount,
      chapters,
      words
    };
  }

  function createProject(name, systemPrompt) {
    const project = newProject(name || '未命名小说');
    if (systemPrompt) project.settings.systemPrompt = systemPrompt;
    const dir = projectDir(project.id);
    ensureDir(dir);
    atomicWrite(dir, PROJECT_FILE, metaOnly(project));
    atomicWrite(dir, VOLUMES_FILE, { volumes: [] });
    atomicWrite(dir, SETTINGS_FILE, { settings: project.settings });
    return project;
  }

  function getProject(id) {
    const p = readProject(id);
    // 输出用归一化设定视图(物理格式保持 settingTypes 不变)
    p.settings = toNormalized(p.settings);
    return p;
  }

  function renameProject(id, name) {
    const p = readProject(id);
    p.name = name || p.name;
    saveMeta(p);
    return p;
  }

  function deleteProject(id) {
    assertProjectFile(id);
    fs.rmSync(projectDir(id), { recursive: true, force: true });
    return { id };
  }

  // ---------- 卷操作 ----------

  function addVolume(id, title, afterIndex) {
    const p = readProject(id);
    const volume = newVolume(title, p.volumes.length);
    if (afterIndex !== undefined && afterIndex >= 0 && afterIndex < p.volumes.length) {
      p.volumes.splice(afterIndex + 1, 0, volume);
    } else {
      p.volumes.push(volume);
    }
    p.volumes.forEach((v, i) => v.order = i);
    saveVolumes(p);
    return volume;
  }

  function findVolume(p, vid) {
    const v = p.volumes.find((x) => x.id === vid);
    if (v) return v;
    // 卷 ID 找不到:回退按卷标题匹配(取第一个同名卷)
    const byTitle = p.volumes.filter((x) => x.title === vid);
    if (byTitle.length === 0) throw new Error('卷不存在');
    if (byTitle.length > 1) throw new Error(`卷「${vid}」有多卷同名,请用 volumeId 精确定位`);
    return byTitle[0];
  }

  function renameVolume(id, vid, title) {
    const p = readProject(id);
    const v = findVolume(p, vid);
    v.title = title || v.title;
    saveVolumes(p);
    return v;
  }

  function deleteVolume(id, vid) {
    const p = readProject(id);
    const v = findVolume(p, vid);
    p.volumes = p.volumes.filter((x) => x !== v);
    p.volumes.forEach((v, i) => v.order = i);
    saveVolumes(p);
    return { id, volumeId: vid };
  }

  // ---------- 章操作 ----------

  function addChapter(id, vid, title, afterIndex) {
    const p = readProject(id);
    const v = findVolume(p, vid);
    if (!v) throw new Error('卷不存在');
    const chapter = newChapter(title, v.chapters.length);
    if (afterIndex !== undefined && afterIndex >= 0 && afterIndex < v.chapters.length) {
      v.chapters.splice(afterIndex + 1, 0, chapter);
    } else {
      v.chapters.push(chapter);
    }
    v.chapters.forEach((c, i) => c.order = i);
    saveVolumes(p);
    return chapter;
  }

  function findChapter(p, vid, cid) {
    const v = findVolume(p, vid);
    return findChapterByVolume(p, v, cid);
  }

  function findChapterByVolume(p, v, cid) {
    let c = v.chapters.find((x) => x.id === cid);
    if (!c) {
      // 章 ID 找不到:回退按章标题匹配(取第一个同名章)
      const byTitle = v.chapters.filter((x) => x.title === cid);
      if (byTitle.length === 0) throw new Error('章不存在');
      if (byTitle.length > 1) throw new Error(`章「${cid}」有多章同名,请用 chapterId 精确定位`);
      c = byTitle[0];
    }
    return { v, c };
  }

  function renameChapter(id, vid, cid, title) {
    const p = readProject(id);
    const { c } = findChapter(p, vid, cid);
    c.title = title || c.title;
    saveVolumes(p);
    return c;
  }

  function deleteChapter(id, vid, cid) {
    const p = readProject(id);
    // 与 rename/write/read 一致:ID 精确匹配,找不到时回退按标题匹配(重名抛错)
    const { v, c } = findChapter(p, vid, cid);
    v.chapters = v.chapters.filter((x) => x !== c);
    v.chapters.forEach((x, i) => x.order = i);
    saveVolumes(p);
    return { id, volumeId: v.id, chapterId: c.id };
  }

  /**
   * 更新章节内容/标题/状态。
   * mode: 'replace'(默认) | 'append'(追加到末尾) | 'prepend'(插入开头)
   */
  function writeChapter(id, vid, cid, { content, mode = 'replace', title, status, prompt }) {
    const p = readProject(id);
    const { c } = findChapter(p, vid, cid);
    if (content !== undefined) {
      if (mode === 'append') c.content = (c.content || '') + content;
      else if (mode === 'prepend') c.content = content + (c.content || '');
      else c.content = content;
      c.wordCount = c.content.length;
    }
    if (title !== undefined) c.title = title;
    if (status !== undefined) c.status = status;
    if (prompt !== undefined) c.prompt = prompt;
    c.updated = now();
    saveVolumes(p);
    return c;
  }

  function readChapter(id, vid, cid, { offset = 0, limit } = {}) {
    const p = readProject(id);
    const { c } = findChapter(p, vid, cid);
    const total = (c.content || '').length;
    const start = Math.max(0, Math.min(total, offset || 0));
    const end = limit === undefined ? total : Math.min(total, start + limit);
    return {
      chapter: {
        id: c.id,
        title: c.title,
        status: c.status,
        wordCount: c.wordCount,
        updated: c.updated
      },
      content: (c.content || '').slice(start, end),
      offset: start,
      returnedChars: end - start,
      totalChars: total
    };
  }

  // ---------- 设定操作(分类组名 → 分类名 → 条目) ----------
  // 物理格式统一为 settings.settingTypes(兼容已有数据):
  //   [{ id, name, icon?,
  //      groups?:  [{ id, name, entries: [{ id, name, description }] }],   // 分类名
  //      entries?: [{ id, name, description }] }]                          // 直挂条目(未分组)
  // 逻辑视图(normalized,工具/视图/AI 上下文使用):
  //   { systemPrompt,
  //     categories: [{ id, name, icon?,
  //       groups?:  [{ id, name, entries: [{ id, name, content }] }],
  //       entries?: [{ id, name, content }] }] }

  function newSettingId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }

  // 旧槽位(overall/characters/customSettings/volumeArchitecture)→ settingTypes
  function ensurePhysicalSettings(p) {
    const s = p.settings || {};
    if (Array.isArray(s.settingTypes)) return s;
    const types = [];
    if (Array.isArray(s.characters) && s.characters.length > 0) {
      types.push({
        id: 'type_chars', name: '角色', icon: '👤',
        entries: s.characters.map((c) => ({ id: newSettingId('e'), name: (c && c.name) || '角色', description: typeof c === 'string' ? c : JSON.stringify(c, null, 2) }))
      });
    }
    if (Array.isArray(s.customSettings) && s.customSettings.length > 0) {
      types.push({
        id: 'type_custom', name: '自定义设定', icon: '📦',
        entries: s.customSettings.map((c, i) => ({ id: newSettingId('e'), name: (c && c.name) || `条目${i + 1}`, description: typeof c === 'string' ? c : JSON.stringify(c, null, 2) }))
      });
    }
    const overall = s.overall || {};
    const overallEntries = [];
    if (overall.summary) overallEntries.push({ id: newSettingId('e'), name: '摘要', description: String(overall.summary) });
    if (overall.content) overallEntries.push({ id: newSettingId('e'), name: '详情', description: String(overall.content) });
    if (overallEntries.length > 0) types.push({ id: 'type_overall', name: '总体设定', icon: '📖', entries: overallEntries });
    const arch = (s.volumeArchitecture || {}).volumes;
    if (Array.isArray(arch) && arch.length > 0) {
      types.push({
        id: 'type_volarch', name: '分卷架构', icon: '📐',
        entries: arch.map((v) => ({ id: newSettingId('e'), name: (v && v.title) || '卷', description: JSON.stringify(v, null, 2) }))
      });
    }
    p.settings = { systemPrompt: s.systemPrompt || '', settingTypes: types };
    return p.settings;
  }

  // 旧槽位 → 逻辑视图(读时兼容,不落盘;写操作时才真正迁移物理格式)
  function legacyToNormalized(settings) {
    const s = settings || {};
    const categories = [];
    if (Array.isArray(s.characters) && s.characters.length > 0) {
      categories.push({ id: 'type_chars', name: '角色', icon: '👤', entries: s.characters.map((c, i) => ({ id: newSettingId('e'), name: (c && c.name) || `角色${i + 1}`, content: typeof c === 'string' ? c : JSON.stringify(c, null, 2) })) });
    }
    if (Array.isArray(s.customSettings) && s.customSettings.length > 0) {
      categories.push({ id: 'type_custom', name: '自定义设定', icon: '📦', entries: s.customSettings.map((c, i) => ({ id: newSettingId('e'), name: (c && c.name) || `条目${i + 1}`, content: typeof c === 'string' ? c : JSON.stringify(c, null, 2) })) });
    }
    const overall = s.overall || {};
    const overallEntries = [];
    if (overall.summary) overallEntries.push({ id: newSettingId('e'), name: '摘要', content: String(overall.summary) });
    if (overall.content) overallEntries.push({ id: newSettingId('e'), name: '详情', content: String(overall.content) });
    if (overallEntries.length > 0) categories.push({ id: 'type_overall', name: '总体设定', icon: '📖', entries: overallEntries });
    const arch = (s.volumeArchitecture || {}).volumes;
    if (Array.isArray(arch) && arch.length > 0) {
      categories.push({ id: 'type_volarch', name: '分卷架构', icon: '📐', entries: arch.map((v) => ({ id: newSettingId('e'), name: (v && v.title) || '卷', content: JSON.stringify(v, null, 2) })) });
    }
    return { systemPrompt: s.systemPrompt || '', categories };
  }

  // 保留条目上的附加字段(_height/_rows 等 UI 元数据),不随归一化读写丢弃
  function withExtra(e, base) {
    for (const k of Object.keys(e || {})) {
      if (k === 'id' || k === 'name' || k === 'description' || k === 'content') continue;
      base[k] = e[k];
    }
    return base;
  }

  // 物理 → 逻辑(固定模型:每个顶层项都是分类组,分类必须在组里)
  function toNormalized(settings) {
    const s = settings || {};
    if (!Array.isArray(s.settingTypes)) {
      const legacy = legacyToNormalized(s);
      legacy.categories = legacy.categories.map(ensureGrouped);
      return legacy;
    }
    const categories = s.settingTypes.map((t) => {
      const cat = { id: t.id, name: t.name || '未命名分类' };
      if (t.icon) cat.icon = t.icon;
      // 有 groups 键(即使为空)按「分类组」读,保证空组身份不丢
      if (Array.isArray(t.groups)) {
        cat.groups = t.groups.map((g) => ({
          id: g.id,
          name: g.name || '未命名分类',
          entries: (g.entries || []).map((e) => withExtra(e, { id: e.id, name: e.name || '', content: e.description ?? e.content ?? '' }))
        }));
      } else {
        cat.entries = (t.entries || []).map((e) => withExtra(e, { id: e.id, name: e.name || '', content: e.description ?? e.content ?? '' }));
      }
      return ensureGrouped(cat);
    });
    return { systemPrompt: s.systemPrompt || '', categories };
  }

  // 逻辑 → 物理(固定模型:全部按分类组落盘,直挂条目自动收进「未整理」)
  function fromNormalized(norm) {
    const s = norm || {};
    const types = (Array.isArray(s.categories) ? s.categories : []).map(ensureGrouped).map((c) => {
      const type = { id: c.id || newSettingId('type'), name: c.name || '未命名分类' };
      if (c.icon) type.icon = c.icon;
      type.groups = c.groups.map((g) => ({
        id: g.id || newSettingId('g'),
        name: g.name || '未命名分类',
        entries: (g.entries || []).map((e) => withExtra(e, { id: e.id || newSettingId('e'), name: e.name || '', description: e.content ?? '' }))
      }));
      return type;
    });
    return { systemPrompt: s.systemPrompt || '', settingTypes: types };
  }

  function getSettings(id) {
    const p = readProject(id);
    return toNormalized(p.settings);
  }

  function saveSettings(id, normalized) {
    const p = readProject(id);
    p.settings = fromNormalized(normalized);
    saveSettingsFile(p);
    return toNormalized(p.settings);
  }

  /** 从逻辑视图按 分类组名 → 分类名 → 条目名 定位;缺层自动创建。不带分类名时归入「未整理」 */
  function locateEntry(norm, category, group, entry) {
    let cat = norm.categories.find((c) => c.name === category);
    if (!cat) { cat = { id: newSettingId('type'), name: category, groups: [] }; norm.categories.push(cat); }
    if (!cat.groups) cat.groups = [];
    const flat = !(typeof group === 'string' && group !== '');
    if (flat) {
      // 固定模型:不带分类名 → 归入「未整理」分类
      let g = cat.groups.find((x) => x.name === '未整理');
      if (!g) { g = { id: newSettingId('g'), name: '未整理', entries: [] }; cat.groups.push(g); }
      return { list: g.entries, cat, group: g };
    }
    let g = cat.groups.find((x) => x.name === group);
    if (!g) { g = { id: newSettingId('g'), name: group, entries: [] }; cat.groups.push(g); }
    return { list: g.entries, cat, group: g };
  }

  // upsert 条目:category.group.entry(entry 不存在则创建)
  function updateSetting(id, category, group, entry, content) {
    const p = readProject(id);
    ensurePhysicalSettings(p);
    const norm = toNormalized(p.settings);
    const loc = locateEntry(norm, category, group, entry);
    const existing = loc.list.find((e) => e.name === entry);
    if (existing) existing.content = content;
    else loc.list.push({ id: newSettingId('e'), name: entry, content });
    p.settings = fromNormalized(norm);
    saveSettingsFile(p);
    return toNormalized(p.settings);
  }

  // 删除:有 entry 删条目;只有 group 删分类;只有 category 删整个分类组
  function deleteSetting(id, category, group, entry) {
    const p = readProject(id);
    ensurePhysicalSettings(p);
    const norm = toNormalized(p.settings);
    const cat = norm.categories.find((c) => c.name === category);
    if (!cat) throw new Error(`分类组不存在: ${category}`);
    if (entry) {
      const flat = !(typeof group === 'string' && group !== '');
      const list = flat
        ? ((cat.groups || []).find((g) => g.name === '未整理') || { entries: [] }).entries
        : ((cat.groups || []).find((g) => g.name === group) || { entries: [] }).entries;
      const idx = list.findIndex((e) => e.name === entry);
      if (idx < 0) throw new Error(`条目不存在: ${category}${group ? '.' + group : ''}.${entry}`);
      list.splice(idx, 1);
    } else if (group) {
      const gi = (cat.groups || []).findIndex((g) => g.name === group);
      if (gi < 0) throw new Error(`分类不存在: ${category}.${group}`);
      cat.groups.splice(gi, 1);
    } else {
      const ci = norm.categories.findIndex((c) => c.name === category);
      norm.categories.splice(ci, 1);
    }
    p.settings = fromNormalized(norm);
    saveSettingsFile(p);
    return toNormalized(p.settings);
  }

  // 重命名 分类组/分类/条目
  function renameSetting(id, category, group, entry, newName) {
    const p = readProject(id);
    ensurePhysicalSettings(p);
    const norm = toNormalized(p.settings);
    const cat = norm.categories.find((c) => c.name === category);
    if (!cat) throw new Error(`分类组不存在: ${category}`);
    if (entry) {
      const flat = !(typeof group === 'string' && group !== '');
      const list = flat
        ? ((cat.groups || []).find((g) => g.name === '未整理') || { entries: [] }).entries
        : ((cat.groups || []).find((g) => g.name === group) || { entries: [] }).entries;
      const e = list.find((x) => x.name === entry);
      if (!e) throw new Error(`条目不存在: ${category}${group ? '.' + group : ''}.${entry}`);
      e.name = newName;
    } else if (group) {
      const g = (cat.groups || []).find((x) => x.name === group);
      if (!g) throw new Error(`分类不存在: ${category}.${group}`);
      g.name = newName;
    } else {
      cat.name = newName;
    }
    p.settings = fromNormalized(norm);
    saveSettingsFile(p);
    return toNormalized(p.settings);
  }

  // ---------- 其他 ----------

  function getRoot() {
    return resolve();
  }

  // 整份恢复(撤销/重做用):volumes / settings(归一化)任一提供即覆盖
  function restoreProject(id, data) {
    const p = readProject(id);
    if (data && Array.isArray(data.volumes)) {
      p.volumes = data.volumes;
      saveVolumes(p);
    }
    if (data && data.settings) {
      p.settings = fromNormalized(data.settings);
      saveSettingsFile(p);
    }
    return getProject(id);
  }

  // ---------- 版本快照(自动备份)实现(依赖闭包内的 resolve/projectDir/projectPath) ----------

  function backupDir(id) {
    return path.join(resolve(), 'backups', id);
  }

  // 写盘前调用:把 旧 文件(即将被覆盖)存为版本快照
  function snapshotBeforeWrite(id, filename) {
    try {
      const src = path.join(projectDir(id), filename);
      if (!fs.existsSync(src)) return; // 首次创建无旧文件
      const dir = backupDir(id);
      ensureDir(dir);
      const now = Date.now();
      const existing = fs.readdirSync(dir).filter((f) => f.endsWith('-' + filename));
      if (existing.length > 0) {
        // 距最近一次备份不足间隔 → 跳过
        const last = existing.map((f) => Number(f.slice(0, 14)) || 0).sort((a, b) => b - a)[0];
        if (now - last < BACKUP_MIN_GAP_MS) return;
      }
      const dest = path.join(dir, `${backupStamp()}-${filename}`);
      fs.copyFileSync(src, dest);
      // 修剪超限(按文件名时间戳排序,保留最新 BACKUP_MAX_KEEP 份)
      const sorted = existing.concat(path.basename(dest)).sort();
      while (sorted.length > BACKUP_MAX_KEEP) {
        const oldest = sorted.shift();
        try { fs.unlinkSync(path.join(dir, oldest)); } catch { /* 忽略 */ }
      }
    } catch { /* 备份失败不阻断主流程 */ }
  }

  /** 列出某项目的版本快照:按时间倒序,每项含是否有正文/设定 */
  function listBackups(id) {
    const dir = backupDir(id);
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((f) => /^\d{14}-(volumes|settings)\.json$/.test(f));
    const byTs = new Map();
    for (const f of files) {
      const ts = f.slice(0, 14);
      if (!byTs.has(ts)) byTs.set(ts, { ts, time: formatBackupTime(ts), hasVolumes: false, hasSettings: false });
      const item = byTs.get(ts);
      if (f.endsWith('-volumes.json')) item.hasVolumes = true;
      if (f.endsWith('-settings.json')) item.hasSettings = true;
    }
    return [...byTs.values()].sort((a, b) => b.ts.localeCompare(a.ts));
  }

  /** 恢复指定时间戳的快照:把备份文件复制回项目目录 */
  function restoreBackup(id, ts) {
    if (typeof ts !== 'string' || !/^\d{14}$/.test(ts)) throw new Error('备份时间戳无效');
    const dir = backupDir(id);
    const projectFile = projectPath(id);
    if (!fs.existsSync(projectFile)) throw new Error('项目不存在');
    if (!fs.existsSync(dir)) throw new Error('该项目没有备份');
    let restored = 0;
    for (const suffix of ['volumes.json', 'settings.json']) {
      const src = path.join(dir, `${ts}-${suffix}`);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(projectDir(id), suffix));
        restored++;
      }
    }
    if (restored === 0) throw new Error('该时间点没有可用备份');
    return getProject(id);
  }

  return {
    getRoot,
    listProjects,
    createProject,
    getProject,
    renameProject,
    deleteProject,
    orderProjects,
    addVolume,
    renameVolume,
    deleteVolume,
    addChapter,
    renameChapter,
    deleteChapter,
    writeChapter,
    readChapter,
    getSettings,
    saveSettings,
    updateSetting,
    deleteSetting,
    renameSetting,
    restoreProject,
    listBackups,
    restoreBackup
  };
}

export { MAX_JSON_BODY_BYTES };
