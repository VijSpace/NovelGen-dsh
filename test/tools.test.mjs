// 工具定义测试:验证 schema 合法 + 全流程 execute 端到端(模拟 agent 调用)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { createNovelStore } from '../lib/store.js';
import { createTools } from '../lib/tools.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novelgen-tools-'));
const store = createNovelStore(root);
const tools = createTools(store);
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

let passed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

async function runTests() {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; console.log('  ✓', name); }
    catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
  }
  console.log(`\n共 ${passed} 项通过`);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('== 工具 schema 测试 ==');

test(`工具数量:${tools.length} 个`, () => {
  assert.equal(tools.length, 19);
});

for (const t of tools) {
  test(`输出 schema 合法:${t.name}`, () => {
    assertSupportedJsonSchema(t.output.schema); // 非法会抛 JsonSchemaError
    assert.equal(typeof t.execute, 'function');
    assert.equal(typeof t.output.render, 'function');
    assert.equal(typeof t.description, 'string');
  });
}

test('参数 schema 编译(defineTool 已隐式验证)+ 输出校验函数可用', () => {
  const value = { ok: true };
  validateJsonSchemaValue({ type: 'object', additionalProperties: true }, value);
});

console.log('== 端到端 execute 测试(模拟 agent 工作流)==');

let pid, vid, cid;
test('novel_create_project', async () => {
  const r = await byName.novel_create_project.execute({ name: '《深空拾荒者》', systemPrompt: '硬科幻,克制冷静的叙述' });
  pid = r.project.id;
  assert.ok(pid);
  validateJsonSchemaValue(byName.novel_create_project.output.schema, r);
});

test('novel_create_volume x2 + novel_create_chapter', async () => {
  const v1 = await byName.novel_create_volume.execute({ projectId: pid, title: '第一卷 苏醒' });
  vid = v1.volume.id;
  await byName.novel_create_volume.execute({ projectId: pid, title: '第二卷 远航' });
  const c = await byName.novel_create_chapter.execute({ projectId: pid, volumeId: vid, title: '第一章 废墟里的灯' });
  cid = c.chapter.id;
});

test('novel_write_chapter(append 多段)', async () => {
  await byName.novel_write_chapter.execute({ projectId: pid, volumeId: vid, chapterId: cid, content: '舱门滑开的瞬间,警报声停止了。' });
  const r = await byName.novel_write_chapter.execute({ projectId: pid, volumeId: vid, chapterId: cid, content: '\n她摸了摸口袋里的磁卡。', mode: 'append' });
  assert.equal(r.chapter.wordCount, 27);
});

test('novel_read_chapter 分页', async () => {
  const r = await byName.novel_read_chapter.execute({ projectId: pid, volumeId: vid, chapterId: cid, limit: 10 });
  assert.equal(r.returnedChars, 10);
  assert.equal(r.totalChars, 27);
  const full = await byName.novel_read_chapter.execute({ projectId: pid, volumeId: vid, chapterId: cid });
  assert.equal(full.returnedChars, 27);
});

test('novel_get_project', async () => {
  const r = await byName.novel_get_project.execute({ projectId: pid });
  assert.equal(r.project.volumes.length, 2);
  assert.equal(r.project.volumes[0].chapters[0].title, '第一章 废墟里的灯');
  assert.ok(r.settings);
  const withContent = await byName.novel_get_project.execute({ projectId: pid, includeContent: true });
  assert.ok(withContent.project.volumes[0].chapters[0].content.length > 0);
  validateJsonSchemaValue(byName.novel_get_project.output.schema, withContent);
});

test('novel_update_setting + novel_get_settings(分类名)', async () => {
  const r = await byName.novel_update_setting.execute({ projectId: pid, category: '总体设定', entry: '摘要', content: '少女在废弃空间站重启人类火种' });
  assert.equal(r.settings.categories[0].groups[0].entries[0].content, '少女在废弃空间站重启人类火种');
  await byName.novel_update_setting.execute({ projectId: pid, category: '角色设定', group: '第一卷', entry: '艾拉', content: '拾荒者' });
  const g = await byName.novel_get_settings.execute({ projectId: pid });
  const chars = g.settings.categories.find((c) => c.name === '角色设定');
  assert.equal(chars.groups[0].entries[0].name, '艾拉');
  assert.equal(chars.groups[0].entries[0].content, '拾荒者');
  // 删除/重命名工具
  await byName.novel_rename_setting.execute({ projectId: pid, category: '角色设定', group: '第一卷', entry: '艾拉', newName: '艾拉(改)' });
  assert.ok(store.getSettings(pid).categories.find((c) => c.name === '角色设定').groups[0].entries.some((e) => e.name === '艾拉(改)'));
  await byName.novel_delete_setting.execute({ projectId: pid, category: '角色设定', group: '第一卷', entry: '艾拉(改)' });
  assert.equal(store.getSettings(pid).categories.find((c) => c.name === '角色设定').groups[0].entries.length, 0);
});

test('novel_rename_chapter / rename_volume / delete', async () => {
  await byName.novel_rename_chapter.execute({ projectId: pid, volumeId: vid, chapterId: cid, title: '第一章 废墟里的灯(修订)' });
  await byName.novel_rename_volume.execute({ projectId: pid, volumeId: vid, title: '第一卷 苏醒·改' });
  const p = store.getProject(pid);
  assert.equal(p.volumes[0].title, '第一卷 苏醒·改');
  assert.equal(p.volumes[0].chapters[0].title, '第一章 废墟里的灯(修订)');
  // 删除章、卷、项目
  await byName.novel_delete_chapter.execute({ projectId: pid, volumeId: vid, chapterId: cid });
  assert.equal(store.getProject(pid).volumes[0].chapters.length, 0);
  await byName.novel_delete_volume.execute({ projectId: pid, volumeId: vid });
  assert.equal(store.getProject(pid).volumes.length, 1);
});

test('novel_list_projects / rename / delete project', async () => {
  const list = await byName.novel_list_projects.execute({});
  assert.equal(list.projects.length, 1);
  assert.equal(list.projects[0].volumes, 1);
  await byName.novel_rename_project.execute({ projectId: pid, name: '《深空拾荒者·终章》' });
  assert.equal(store.getProject(pid).name, '《深空拾荒者·终章》');
  await byName.novel_delete_project.execute({ projectId: pid });
  assert.equal(store.listProjects().length, 0);
});

test('项目拖拽排序:orderProjects 持久化并改变 listProjects 顺序', async () => {
  const a = store.createProject('《排序A》');
  const b = store.createProject('《排序B》');
  const c = store.createProject('《排序C》');
  // 默认按更新时间倒序:新建的 C 最新 → 排最前
  let list = store.listProjects();
  assert.equal(list[0].name, '《排序C》');
  // 自定义顺序: A, C, B
  store.orderProjects([a.id, c.id, b.id]);
  list = store.listProjects();
  assert.deepEqual(list.map((x) => x.name), ['《排序A》', '《排序C》', '《排序B》']);
  // 未知 ID 混入时忽略;重建 store 后顺序仍保留(已持久化)
  const store2 = createNovelStore(root);
  assert.deepEqual(store2.listProjects().map((x) => x.name), ['《排序A》', '《排序C》', '《排序B》']);
  // 部分列表 + 重复 ID:去重并补全漏项(B 未列出 → 自动追加末尾)
  store.orderProjects([a.id, a.id, c.id]);
  assert.deepEqual(store.listProjects().map((x) => x.name), ['《排序A》', '《排序C》', '《排序B》']);
  // 清理
  store.deleteProject(a.id);
  store.deleteProject(b.id);
  store.deleteProject(c.id);
  assert.equal(store.listProjects().length, 0);
});

test('错误处理:execute 抛错', async () => {
  await assert.rejects(() => byName.novel_get_project.execute({ projectId: 'nope' }), /项目不存在/);
  await assert.rejects(() => byName.novel_create_chapter.execute({ projectId: 'nope', volumeId: 'x', title: 'y' }), /项目不存在/);
});

console.log('== 回归:read_chapter schema + 卷章标题定位 ==');

test('novel_read_chapter 返回含 updated,输出通过严格 schema 校验', async () => {
  const p = store.createProject('《读章回归》');
  const v = store.addVolume(p.id, '第一卷');
  const c = store.addChapter(p.id, v.id, '第一章');
  store.writeChapter(p.id, v.id, c.id, { content: '正文内容' });
  const r = await byName.novel_read_chapter.execute({ projectId: p.id, volumeId: v.id, chapterId: c.id });
  assert.ok(r.chapter.updated);
  // 严格 schema 校验(additionalProperties:false)必须通过
  validateJsonSchemaValue(byName.novel_read_chapter.output.schema, r);
  assert.equal(r.content, '正文内容');
  store.deleteProject(p.id);
});

test('卷/章按标题回退定位(旧数据无 ID 也可读)', async () => {
  const p = store.createProject('《标题定位回归》');
  const v = store.addVolume(p.id, '第一卷 新伊甸');
  const c = store.addChapter(p.id, v.id, '第一章 废墟来信');
  store.writeChapter(p.id, v.id, c.id, { content: '历史正文' });
  // 用标题代替 ID 读取
  const r = await byName.novel_read_chapter.execute({ projectId: p.id, volumeId: '第一卷 新伊甸', chapterId: '第一章 废墟来信' });
  assert.equal(r.content, '历史正文');
  assert.equal(r.chapter.title, '第一章 废墟来信');
  // 用标题追加写入
  const w = await byName.novel_write_chapter.execute({ projectId: p.id, volumeId: '第一卷 新伊甸', chapterId: '第一章 废墟来信', content: '追加段', mode: 'append' });
  assert.ok(w.chapter.wordCount > 4);
  // 重读确认完整
  const r2 = await byName.novel_read_chapter.execute({ projectId: p.id, volumeId: '第一卷 新伊甸', chapterId: '第一章 废墟来信' });
  assert.ok(r2.content.includes('历史正文') && r2.content.includes('追加段'));
  // 重命名/删除也支持标题定位
  await byName.novel_rename_chapter.execute({ projectId: p.id, volumeId: '第一卷 新伊甸', chapterId: '第一章 废墟来信', title: '第一章 改名' });
  assert.equal(store.getProject(p.id).volumes[0].chapters[0].title, '第一章 改名');
  await byName.novel_rename_volume.execute({ projectId: p.id, volumeId: '第一卷 新伊甸', title: '第一卷 更名' });
  assert.equal(store.getProject(p.id).volumes[0].title, '第一卷 更名');
  store.deleteProject(p.id);
});

test('novel_delete_chapter 支持标题回退(与 rename/write/read 一致)', async () => {
  const p = store.createProject('《删除标题回归》');
  const v = store.addVolume(p.id, '第一卷');
  const c1 = store.addChapter(p.id, v.id, '第一章');
  const c2 = store.addChapter(p.id, v.id, '第二章');
  // 用卷/章标题删除(不传 ID)
  const r = await byName.novel_delete_chapter.execute({ projectId: p.id, volumeId: '第一卷', chapterId: '第一章' });
  // 返回解析后的真实 ID(而非回显标题)
  assert.equal(r.chapterId, c1.id);
  const remaining = store.getProject(p.id).volumes[0].chapters;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, c2.id);
  // 不存在的标题 → 明确报错
  await assert.rejects(
    () => byName.novel_delete_chapter.execute({ projectId: p.id, volumeId: '第一卷', chapterId: '不存在' }),
    /章不存在/
  );
  store.deleteProject(p.id);
});

test('卷/章标题歧义时报错提示用 ID', async () => {
  const p = store.createProject('《歧义回归》');
  const v = store.addVolume(p.id, '第一卷');
  store.addChapter(p.id, v.id, '第一章');
  store.addChapter(p.id, v.id, '第一章'); // 两个同名章
  await assert.rejects(
    () => byName.novel_read_chapter.execute({ projectId: p.id, volumeId: '第一卷', chapterId: '第一章' }),
    /有多章同名,请用 chapterId 精确定位/
  );
  store.deleteProject(p.id);
});

test('novel_get_project 输出含卷/章 ID(schema 声明 + 返回构造)', async () => {
  const p = store.createProject('《ID回归》');
  const v = store.addVolume(p.id, '第一卷');
  const c = store.addChapter(p.id, v.id, '第一章');
  const r = await byName.novel_get_project.execute({ projectId: p.id });
  assert.equal(r.project.volumes[0].id, v.id);
  assert.equal(r.project.volumes[0].chapters[0].id, c.id);
  validateJsonSchemaValue(byName.novel_get_project.output.schema, r);
  // render 文本含 ID(模型能拿到定位信息)
  const rendered = byName.novel_get_project.output.render({ projectId: p.id }, r);
  const textContent = rendered.map((b) => b.text).join('');
  assert.match(textContent, /volumeId: /);
  assert.match(textContent, /chapterId: /);
  store.deleteProject(p.id);
});

console.log('== 剧情演绎(角色扮演迁移) ==');

test('novel_roleplay_start:分类下全部条目合成人设卡 + 注入演绎规则', async () => {
  const p = store.createProject('《演绎测试》');
  store.updateSetting(p.id, '角色设定', '主角团', '艾拉', '拾荒者,嘴硬心软');
  store.updateSetting(p.id, '角色设定', '主角团', '老周', '沉默的机械师');
  store.updateSetting(p.id, '世界观', '新伊甸', '星门', '连接各殖民地的传送门');
  const deferred = [];
  const mockExec = { deferContext: (m) => deferred.push(m) };
  const r = await byName.novel_roleplay_start.execute({ projectId: p.id, character: '主角团', scene: '破败的补给站' }, mockExec);
  assert.equal(r.character, '主角团');
  assert.match(r.characterCard, /【艾拉】拾荒者,嘴硬心软/);
  assert.match(r.characterCard, /【老周】沉默的机械师/);
  assert.match(r.scene, /补给站/);
  assert.equal(r.mode, 'single');
  // 可选角色分类包含 主角团
  assert.ok(r.availableCharacters.includes('主角团'));
  // 注入消息:1 条设定快照 + 1 条演绎规则
  const rpMsg = deferred.find((m) => m.content.map((b) => b.text).join('').includes('剧情演绎 · 系统设定'));
  assert.ok(rpMsg, '应注入演绎规则消息');
  const textContent = rpMsg.content.map((b) => b.text).join('');
  assert.match(textContent, /剧情演绎 · 系统设定/);
  assert.match(textContent, /每次只生成【一个】剧情条目/);
  assert.match(textContent, /【艾拉】拾荒者,嘴硬心软/);
  // 世界设定(角色设定之外)进了提示词
  assert.match(textContent, /新伊甸/);
  store.deleteProject(p.id);
});

test('novel_roleplay_start:scene 模式 + 未知名分类报错', async () => {
  const p = store.createProject('《演绎测试2》');
  store.updateSetting(p.id, '角色设定', '反派', '魔女', '操纵火焰');
  const deferred = [];
  const r = await byName.novel_roleplay_start.execute({ projectId: p.id, character: '反派', mode: 'scene' }, { deferContext: (m) => deferred.push(m) });
  assert.equal(r.mode, 'scene');
  const rpMsg = deferred.find((m) => m.content.map((b) => b.text).join('').includes('剧情演绎 · 系统设定'));
  assert.ok(rpMsg);
  assert.match(rpMsg.content.map((b) => b.text).join(''), /推进当前场景直到出现转场/);
  // 未知分类 → 明确报错并列出可选分类
  await assert.rejects(
    () => byName.novel_roleplay_start.execute({ projectId: p.id, character: '不存在' }),
    /「角色设定」分类组下没有分类「不存在」/
  );
  store.deleteProject(p.id);
});

test('novel_roleplay_pick:换分类即换人设卡', async () => {
  const p = store.createProject('《演绎测试3》');
  store.updateSetting(p.id, '角色设定', '主角团', '艾拉', '拾荒者');
  store.updateSetting(p.id, '角色设定', '配角', '客栈老板', '消息灵通');
  const deferred = [];
  const r = await byName.novel_roleplay_pick.execute({ projectId: p.id, character: '配角' }, { deferContext: (m) => deferred.push(m) });
  assert.equal(r.character, '配角');
  assert.match(r.characterCard, /【客栈老板】消息灵通/);
  assert.doesNotMatch(r.characterCard, /艾拉/);
  const injected = deferred.find((m) => m.content.map((b) => b.text).join('').includes('剧情演绎 · 系统设定'));
  assert.ok(injected);
  const injectedText = injected.content.map((b) => b.text).join('');
  assert.match(injectedText, /【客栈老板】消息灵通/);
  // 人设卡区块(【本次演绎角色…【当前场景】之间)不含上一角色
  const cardSection = injectedText.slice(injectedText.indexOf('【本次演绎角色'), injectedText.indexOf('【当前场景】'));
  assert.doesNotMatch(cardSection, /艾拉/);
  store.deleteProject(p.id);
});

test('设定自动注入:deferContext 携带项目设定快照', async () => {
  const p = store.createProject('《设定注入测试》');
  store.updateSetting(p.id, '总体设定', null, '基调', '硬科幻,克制冷静');
  store.updateSetting(p.id, '角色设定', null, '艾拉', '拾荒者');
  const deferred = [];
  const mockExec = { deferContext: (msg) => deferred.push(msg) };
  // 无 exec 时不应抛错
  await byName.novel_get_settings.execute({ projectId: p.id });
  assert.equal(deferred.length, 0);
  // 带 exec 时注入设定快照
  await byName.novel_get_settings.execute({ projectId: p.id }, mockExec);
  assert.equal(deferred.length, 1);
  const msg = deferred[0];
  assert.equal(msg.role, 'user');
  const textContent = msg.content.map((b) => b.text).join('');
  assert.match(textContent, /总体设定\(分类组,1 个分类\):/);
  assert.match(textContent, /未整理: 基调/);
  assert.match(textContent, /角色设定\(分类组,1 个分类\):/);
  assert.match(textContent, /未整理: 艾拉/);
  assert.match(textContent, /【当前项目设定 · /);
  // 无设定的项目不注入
  const empty = store.createProject('《空设定》');
  const deferred2 = [];
  await byName.novel_get_project.execute({ projectId: empty.id }, { deferContext: (m) => deferred2.push(m) });
  assert.equal(deferred2.length, 0);
  // 写章节同样注入(写作时能看到设定)
  const v = store.addVolume(p.id, '卷');
  const c = store.addChapter(p.id, v.id, '章');
  const deferred3 = [];
  await byName.novel_write_chapter.execute({ projectId: p.id, volumeId: v.id, chapterId: c.id, content: '正文' }, { deferContext: (m) => deferred3.push(m) });
  assert.equal(deferred3.length, 1);
  assert.match(deferred3[0].content.map((b) => b.text).join(''), /未整理: 艾拉/);
  store.deleteProject(p.id);
  store.deleteProject(empty.id);
});

await runTests();
