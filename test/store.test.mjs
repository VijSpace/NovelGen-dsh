// NovelGen store 单元测试(纯 Node,无 DSH 依赖)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNovelStore } from '../lib/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novelgen-test-'));
const store = createNovelStore(root);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

console.log('== store 测试 ==');

test('数据目录自动创建', () => {
  assert.ok(fs.existsSync(root));
});

test('创建项目', () => {
  const p = store.createProject('《测试小说》', '黑暗奇幻风格');
  assert.ok(p.id);
  assert.equal(p.name, '《测试小说》');
  assert.equal(p.settings.systemPrompt, '黑暗奇幻风格');
  assert.deepEqual(p.volumes, []);
});

test('列出项目', () => {
  const list = store.listProjects();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '《测试小说》');
  assert.equal(typeof list[0].volumes, 'number');
});

test('项目文件落盘(正文/设定分文件)', () => {
  const list = store.listProjects();
  const dir = path.join(root, list[0].id);
  assert.ok(fs.existsSync(path.join(dir, 'project.json')));
  assert.ok(fs.existsSync(path.join(dir, 'volumes.json')));
  assert.ok(fs.existsSync(path.join(dir, 'settings.json')));
  // project.json 只留元数据
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf-8'));
  assert.equal(meta.schemaVersion, 1);
  assert.equal(meta.volumes, undefined);
  assert.equal(meta.settings, undefined);
  // 正文 / 设定各自独立文件
  const vols = JSON.parse(fs.readFileSync(path.join(dir, 'volumes.json'), 'utf-8'));
  assert.ok(Array.isArray(vols.volumes));
  const sets = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'));
  assert.ok(sets.settings && Array.isArray(sets.settings.settingTypes));
  // 原子写不留备份/临时文件
  for (const f of ['project.json', 'volumes.json', 'settings.json']) {
    assert.ok(!fs.existsSync(path.join(dir, f + '.autosave')));
    assert.ok(!fs.existsSync(path.join(dir, f + '.tmp')));
  }
});

test('正文/设定写入互不干扰(分文件后不整份重写)', () => {
  const pid = store.createProject('《隔离测试》').id;
  const dir = store.getRoot() + '/' + pid;
  store.saveSettings(pid, { systemPrompt: '风格', categories: [{ name: '组', entries: [{ name: 'e', content: 'x' }] }] });
  const settingsBefore = fs.readFileSync(dir + '/settings.json', 'utf-8');
  // 写正文(卷/章/内容):settings.json 不应被重写
  const v = store.addVolume(pid, '第一卷');
  const c = store.addChapter(pid, v.id, '第一章');
  store.writeChapter(pid, v.id, c.id, { content: '正文内容。' });
  assert.equal(fs.readFileSync(dir + '/settings.json', 'utf-8'), settingsBefore);
  // 改设定:volumes.json 不应被重写
  const volsBefore = fs.readFileSync(dir + '/volumes.json', 'utf-8');
  store.updateSetting(pid, '组', null, 'e', 'y');
  assert.equal(fs.readFileSync(dir + '/volumes.json', 'utf-8'), volsBefore);
  assert.equal(store.getSettings(pid).categories[0].groups[0].entries[0].content, 'y');
  store.deleteProject(pid);
});

test('新建卷 + 章', () => {
  const pid = store.listProjects()[0].id;
  const v = store.addVolume(pid, '第一卷');
  assert.equal(v.title, '第一卷');
  const v2 = store.addVolume(pid, '第二卷');
  const c = store.addChapter(pid, v.id, '第一章');
  assert.equal(c.status, 'draft');
  assert.equal(c.content, '');
  const p = store.getProject(pid);
  assert.equal(p.volumes.length, 2);
  assert.equal(p.volumes[0].chapters.length, 1);
  assert.equal(v2.order, 1);
});

test('写入章节(替换/追加/前置)与字数统计', () => {
  const pid = store.listProjects()[0].id;
  const p = store.getProject(pid);
  const cid = p.volumes[0].chapters[0].id;
  let c = store.writeChapter(pid, p.volumes[0].id, cid, { content: '天地玄黄。' });
  assert.equal(c.wordCount, 5);
  c = store.writeChapter(pid, p.volumes[0].id, cid, { content: '宇宙洪荒。', mode: 'append' });
  assert.equal(c.content, '天地玄黄。宇宙洪荒。');
  c = store.writeChapter(pid, p.volumes[0].id, cid, { content: '开头。', mode: 'prepend' });
  assert.equal(c.content, '开头。天地玄黄。宇宙洪荒。');
  c = store.writeChapter(pid, p.volumes[0].id, cid, { status: 'done' });
  assert.equal(c.status, 'done');
});

test('分页读取章节', () => {
  const pid = store.listProjects()[0].id;
  const p = store.getProject(pid);
  const cid = p.volumes[0].chapters[0].id;
  const vid = p.volumes[0].id;
  const r = store.readChapter(pid, vid, cid, { offset: 0, limit: 4 });
  assert.equal(r.content, '开头。天');
  assert.equal(r.totalChars, 13);
  assert.equal(r.returnedChars, 4);
  const full = store.readChapter(pid, vid, cid);
  assert.equal(full.returnedChars, 13);
});

test('重命名/删除卷章', () => {
  const pid = store.listProjects()[0].id;
  const p = store.getProject(pid);
  const v2 = p.volumes[1];
  const c = store.addChapter(pid, v2.id, '临时章');
  store.renameChapter(pid, v2.id, c.id, '改名章');
  assert.equal(store.getProject(pid).volumes[1].chapters[0].title, '改名章');
  store.deleteChapter(pid, v2.id, c.id);
  assert.equal(store.getProject(pid).volumes[1].chapters.length, 0);
  store.renameVolume(pid, v2.id, '第二卷(改)');
  assert.equal(store.getProject(pid).volumes[1].title, '第二卷(改)');
  store.deleteVolume(pid, v2.id);
  assert.equal(store.getProject(pid).volumes.length, 1);
});

test('设定:分类新增/更新/删除/重命名(固定三级)', () => {
  const pid = store.createProject('《设定测试》').id;
  // 不带分类名 → 归入「未整理」分类
  store.updateSetting(pid, '角色设定', null, '主角', '一个拾荒者');
  let s = store.getSettings(pid);
  assert.equal(s.categories[0].name, '角色设定');
  assert.equal(s.categories[0].groups[0].name, '未整理');
  assert.equal(s.categories[0].groups[0].entries[0].name, '主角');
  assert.equal(s.categories[0].groups[0].entries[0].content, '一个拾荒者');
  // 覆盖已有条目
  store.updateSetting(pid, '角色设定', null, '主角', '拾荒者,性格坚毅');
  assert.equal(store.getSettings(pid).categories[0].groups[0].entries[0].content, '拾荒者,性格坚毅');
  // 指定分类名
  store.updateSetting(pid, '分卷架构', '第一卷', '第一章', '引擎点火');
  store.updateSetting(pid, '分卷架构', '第二卷', '第一章', '远航');
  s = store.getSettings(pid);
  const vol = s.categories.find((c) => c.name === '分卷架构');
  assert.equal(vol.groups.length, 2);
  assert.equal(vol.groups[0].name, '第一卷');
  assert.equal(vol.groups[1].entries[0].content, '远航');
  // 同一分类组:未整理 与 指定分类 并存
  store.updateSetting(pid, '混合', null, '旧条目', 'x');
  store.updateSetting(pid, '混合', '一组', '新条目', 'y');
  s = store.getSettings(pid);
  const mix = s.categories.find((c) => c.name === '混合');
  assert.ok(mix.groups && !mix.entries, '固定模型下应只有 groups');
  assert.equal(mix.groups.find((g) => g.name === '一组').entries[0].content, 'y');
  assert.equal(mix.groups.find((g) => g.name === '未整理').entries[0].name, '旧条目');
  // 删除条目 / 分类 / 分类组
  store.deleteSetting(pid, '分卷架构', '第一卷', '第一章');
  assert.equal(store.getSettings(pid).categories.find((c) => c.name === '分卷架构').groups[0].entries.length, 0);
  store.deleteSetting(pid, '分卷架构', '第一卷');
  assert.equal(store.getSettings(pid).categories.find((c) => c.name === '分卷架构').groups.length, 1);
  store.deleteSetting(pid, '角色设定');
  assert.equal(store.getSettings(pid).categories.find((c) => c.name === '角色设定'), undefined);
  // 重命名
  store.renameSetting(pid, '分卷架构', '第二卷', null, '卷二');
  assert.equal(store.getSettings(pid).categories.find((c) => c.name === '分卷架构').groups[0].name, '卷二');
  store.renameSetting(pid, '分卷架构', null, null, '卷架构');
  assert.ok(store.getSettings(pid).categories.some((c) => c.name === '卷架构'));
  store.deleteProject(pid);
});

test('设定:旧槽位自动映射迁移到 settingTypes', () => {
  const pid = store.createProject('《旧数据》').id;
  // 构造旧单文件布局:删除拆分文件,只留 project.json(内嵌 volumes + 旧槽位 settings)
  const dir = store.getRoot() + '/' + pid;
  fs.rmSync(dir + '/volumes.json', { force: true });
  fs.rmSync(dir + '/settings.json', { force: true });
  const p = {
    id: pid, name: '《旧数据》', schemaVersion: 1,
    created: new Date().toISOString(), updated: new Date().toISOString(),
    volumes: [],
    settings: {
      systemPrompt: '旧提示词',
      overall: { summary: '旧摘要', content: '旧详情' },
      characters: [{ name: '甲', role: '主角' }],
      customSettings: ['自定义一条'],
      volumeArchitecture: { volumes: [{ title: '卷A' }] }
    }
  };
  fs.writeFileSync(dir + '/project.json', JSON.stringify(p, null, 2), 'utf-8');
  // 读取归一化(回退到 project.json 内嵌数据;每个旧槽位分类自动收进「未整理」组)
  const s = store.getSettings(pid);
  assert.equal(s.systemPrompt, '旧提示词');
  const names = s.categories.map((c) => c.name);
  assert.ok(names.includes('总体设定'));
  assert.ok(names.includes('角色'));
  assert.ok(names.includes('自定义设定'));
  assert.ok(names.includes('分卷架构'));
  assert.ok(s.categories.every((c) => Array.isArray(c.groups)), '固定模型:每个顶层项都应是分类组');
  // 写操作触发迁移:拆分为 settings.json + volumes.json,物理格式变为 settingTypes
  store.updateSetting(pid, '角色', null, '乙', '配角');
  assert.ok(fs.existsSync(dir + '/volumes.json'), '首次写应拆出 volumes.json');
  const raw = JSON.parse(fs.readFileSync(dir + '/settings.json', 'utf-8'));
  assert.ok(Array.isArray(raw.settings.settingTypes), '迁移后应为 settingTypes');
  assert.equal(raw.settings.overall, undefined, '旧槽位应被清除');
  const s2 = store.getSettings(pid);
  assert.ok(s2.categories.find((c) => c.name === '角色').groups[0].entries.some((e) => e.name === '乙'));
  store.deleteProject(pid);
});

test('设定:固定三级模型(空组保留 / 未整理自愈 / 跨组移动)', () => {
  const pid = store.createProject('《分组测试》').id;
  // 空分类组(groups: [])应保持「组」身份
  store.saveSettings(pid, { systemPrompt: '', categories: [{ name: '世界观', groups: [] }] });
  let s = store.getSettings(pid);
  let w = s.categories.find((c) => c.name === '世界观');
  assert.ok(Array.isArray(w.groups) && w.groups.length === 0, '空分类组应保留 groups');
  // 直挂条目分类:保存时自动收进「未整理」(自愈)
  store.saveSettings(pid, { systemPrompt: '', categories: [
    { name: '世界观', groups: [] },
    { name: '新伊甸', entries: [{ name: 'a', content: 'x' }] }
  ] });
  s = store.getSettings(pid);
  const nyd = s.categories.find((c) => c.name === '新伊甸');
  assert.equal(nyd.groups[0].name, '未整理', '直挂条目应自动归入未整理');
  assert.equal(nyd.groups[0].entries[0].content, 'x');
  // 跨组移动(模拟 web 端数组操作:成员从一组搬到另一组)
  let settings = store.getSettings(pid);
  const cats = settings.categories;
  cats.push({ name: '角色设定', groups: [] });
  const src = cats.find((x) => x.name === '新伊甸');
  const member = src.groups.splice(0, 1)[0]; // 新伊甸 里的 未整理(分类)
  cats.find((x) => x.name === '角色设定').groups.push(member);
  store.saveSettings(pid, { systemPrompt: '', categories: cats });
  s = store.getSettings(pid);
  const dst = s.categories.find((c) => c.name === '角色设定');
  assert.equal(dst.groups.length, 1);
  assert.equal(dst.groups[0].name, '未整理');
  assert.equal(dst.groups[0].entries[0].content, 'x');
  // 源组 新伊甸 变为空组,身份保留
  assert.ok(s.categories.find((c) => c.name === '新伊甸').groups.length === 0);
  store.deleteProject(pid);
});

test('设定:restoreProject 整份恢复(撤销/重做用)', () => {
  const pid = store.createProject('《恢复测试》').id;
  const v = store.addVolume(pid, '第一卷');
  store.addChapter(pid, v.id, '第一章');
  store.writeChapter(pid, v.id, store.getProject(pid).volumes[0].chapters[0].id, { content: '新内容' });
  // 保存恢复点:旧 volumes + 旧 settings
  const snap = { volumes: store.getProject(pid).volumes, settings: store.getSettings(pid) };
  // 做一次修改(删章 + 改设定)
  const chId = store.getProject(pid).volumes[0].chapters[0].id;
  store.deleteChapter(pid, v.id, chId);
  store.updateSetting(pid, '组', null, 'e', 'x');
  assert.equal(store.getProject(pid).volumes[0].chapters.length, 0);
  // 恢复(应同时回退:删章 与 加设定条目)
  const restored = store.restoreProject(pid, snap);
  assert.equal(restored.volumes[0].chapters.length, 1);
  assert.equal(restored.volumes[0].chapters[0].content, '新内容');
  assert.equal(restored.settings.categories.find((c) => c.name === '组'), undefined, '恢复点之后的设定修改应被回退');
  store.deleteProject(pid);
});

test('重命名/删除项目', () => {
  const pid = store.listProjects()[0].id;
  store.renameProject(pid, '《测试小说·改》');
  assert.equal(store.listProjects()[0].name, '《测试小说·改》');
  store.deleteProject(pid);
  assert.equal(store.listProjects().length, 0);
  assert.throws(() => store.getProject(pid), /项目不存在/);
});

test('错误路径', () => {
  const p = store.createProject('《错误测试》');
  assert.throws(() => store.addChapter(p.id, 'no-such-volume', 'x'), /卷不存在/);
  const v = store.addVolume(p.id, '卷');
  const c = store.addChapter(p.id, v.id, '章');
  assert.throws(() => store.writeChapter(p.id, v.id, 'no-such-chapter', { content: 'x' }), /章不存在/);
});

test('动态数据目录(自定义工作区):函数 root 实时跟随', () => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'novelgen-dyn-a-'));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'novelgen-dyn-b-'));
  let current = rootA;
  const dyn = createNovelStore(() => current);
  assert.equal(dyn.getRoot(), rootA);
  const pa = dyn.createProject('《工作区A的书》');
  assert.equal(dyn.listProjects().length, 1);
  // 切换工作区 → 同一 store 指向 B,A 的项目不再可见
  current = rootB;
  assert.equal(dyn.getRoot(), rootB);
  assert.equal(dyn.listProjects().length, 0);
  const pb = dyn.createProject('《工作区B的书》');
  assert.equal(dyn.listProjects().length, 1);
  assert.equal(dyn.listProjects()[0].name, '《工作区B的书》');
  // 切回 A 仍在
  current = rootA;
  assert.equal(dyn.listProjects().length, 1);
  assert.equal(dyn.listProjects()[0].name, '《工作区A的书》');
  // 文件确实落在对应目录
  assert.ok(fs.existsSync(path.join(rootA, pa.id, 'project.json')));
  assert.ok(fs.existsSync(path.join(rootB, pb.id, 'project.json')));
  fs.rmSync(rootA, { recursive: true, force: true });
  fs.rmSync(rootB, { recursive: true, force: true });
});

console.log('== 自动备份(版本快照) ==');

test('写前自动快照 + listBackups + restoreBackup', () => {
  const p = store.createProject('《备份测试》');
  const v = store.addVolume(p.id, '第一卷');
  const c = store.addChapter(p.id, v.id, '第一章');
  store.writeChapter(p.id, v.id, c.id, { content: '版本一内容' });
  // 首次写入后应产生 volumes 快照(旧文件在第一次写前不存在 → 无;第二次写前有)
  // 手动模拟快照:直接往备份目录放一个"过去"版本,验证 list/restore
  const bakDir = path.join(root, 'backups', p.id);
  fs.mkdirSync(bakDir, { recursive: true });
  const oldVol = { volumes: [{ id: v.id, title: '第一卷', order: 0, chapters: [{ id: c.id, title: '第一章', content: '被恢复的旧内容', wordCount: 7, order: 0 }] }] };
  const ts = '20260101120000';
  fs.writeFileSync(path.join(bakDir, ts + '-volumes.json'), JSON.stringify(oldVol), 'utf-8');
  // listBackups
  const list = store.listBackups(p.id);
  assert.ok(list.some((b) => b.ts === ts && b.hasVolumes));
  // restoreBackup:恢复旧内容
  const restored = store.restoreBackup(p.id, ts);
  assert.equal(restored.volumes[0].chapters[0].content, '被恢复的旧内容');
  // 无效时间戳/不存在备份报错
  assert.throws(() => store.restoreBackup(p.id, 'bad'), /时间戳无效/);
  assert.throws(() => store.restoreBackup(p.id, '19990101000000'), /没有可用备份/);
  // 清理(测试 store 的根目录整体清理在文件末尾)
  store.deleteProject(p.id);
});

test('真实写入路径生成快照(内容为旧版本 + 节流不刷爆)', () => {
  const p = store.createProject('《快照路径测试》');
  const v = store.addVolume(p.id, '卷');
  const c = store.addChapter(p.id, v.id, '章');
  // createProject 已写过 volumes.json(空数组),因此 addVolume 的落盘会先快照旧空数组
  store.writeChapter(p.id, v.id, c.id, { content: '内容A' });
  const bakDir = path.join(root, 'backups', p.id);
  assert.ok(fs.existsSync(bakDir), '应有备份目录');
  const files = fs.readdirSync(bakDir).filter((f) => f.endsWith('-volumes.json'));
  assert.ok(files.length >= 1, `应有至少 1 份 volumes 快照,实际 ${files.length}`);
  // 快照内容为旧版本:第一个快照是项目创建后的空数组(不含任何卷)
  const first = JSON.parse(fs.readFileSync(path.join(bakDir, files[0]), 'utf-8'));
  assert.equal((first.volumes || []).length, 0, '首份快照应为项目初始空数组');
  // 节流:紧接着再写不产生新快照(5 分钟间隔)
  const before = fs.readdirSync(bakDir).length;
  store.writeChapter(p.id, v.id, c.id, { content: '内容B' });
  store.writeChapter(p.id, v.id, c.id, { content: '内容C' });
  const after = fs.readdirSync(bakDir).length;
  assert.equal(after, before, '节流期内连续写入不应新增快照');
  store.deleteProject(p.id);
});

console.log(`\n共 ${passed} 项通过`);
fs.rmSync(root, { recursive: true, force: true });
