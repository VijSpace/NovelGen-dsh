// /novelgen 路由测试:起 node:http 服务,验证静态页 + JSON API
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNovelStore } from '../lib/store.js';
import { createNovelgenRouter } from '../lib/routes.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novelgen-routes-'));
const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'novelgen-routes-b-'));
let currentRoot = root;
const store = createNovelStore(() => currentRoot);
const api = {
  getRoot: () => store.getRoot(),
  setRoot: (next) => {
    if (typeof next !== 'string' || next.trim() === '') throw new Error('数据目录不能为空');
    currentRoot = path.resolve(next.trim());
    fs.mkdirSync(currentRoot, { recursive: true });
    return currentRoot;
  }
};
const server = http.createServer(createNovelgenRouter(store, api));

let passed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

function req(method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method, headers: payload ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* 静态资源 */ }
        resolve({ status: res.statusCode, type: res.headers['content-type'] || '', json, raw: data });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function runTests() {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; console.log('  ✓', name); }
    catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
  }
  console.log(`\n共 ${passed} 项通过`);
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(rootB, { recursive: true, force: true });
}

// ---------- 测试 ----------
test('健康检查', async () => {
  const r = await req('GET', '/novelgen/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.data.root, root);
});

test('静态页 /novelgen', async () => {
  const r = await req('GET', '/novelgen/');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/html/);
  assert.match(r.raw, /NovelGen/);
  const app = await req('GET', '/novelgen/app.js');
  assert.equal(app.status, 200);
  assert.match(app.type, /javascript/);
  const css = await req('GET', '/novelgen/style.css');
  assert.equal(css.status, 200);
});

test('API:创建项目 → 建卷章 → 保存 → 读取', async () => {
  const c1 = await req('POST', '/novelgen/api/projects', { name: '《测试》', systemPrompt: 'x' });
  assert.equal(c1.status, 200);
  const pid = c1.json.data.project.id;

  const c2 = await req('POST', `/novelgen/api/projects/${pid}/volumes`, { title: '第一卷' });
  const vid = c2.json.data.volume.id;

  const c3 = await req('POST', `/novelgen/api/projects/${pid}/volumes/${vid}/chapters`, { title: '第一章' });
  const cid = c3.json.data.chapter.id;

  const c4 = await req('PATCH', `/novelgen/api/projects/${pid}/volumes/${vid}/chapters/${cid}`, { content: '你好,世界。', title: '第一章 起', status: 'done' });
  assert.equal(c4.json.data.chapter.wordCount, 6);
  assert.equal(c4.json.data.chapter.status, 'done');

  const c5 = await req('GET', `/novelgen/api/projects/${pid}`);
  assert.equal(c5.json.data.project.volumes[0].chapters[0].content, '你好,世界。');

  const c6 = await req('GET', '/novelgen/api/projects');
  assert.equal(c6.json.data.projects.length, 1);

  // 设定(固定模型:直挂条目自动收进「未整理」分类)
  const c7 = await req('PUT', `/novelgen/api/projects/${pid}/settings`, { settings: { systemPrompt: 'p', categories: [{ name: '角色', entries: [{ name: '甲', content: '主角' }] }] } });
  assert.equal(c7.json.data.settings.systemPrompt, 'p');
  assert.equal(c7.json.data.settings.categories[0].groups[0].name, '未整理');
  assert.equal(c7.json.data.settings.categories[0].groups[0].entries[0].name, '甲');

  // 删除
  await req('DELETE', `/novelgen/api/projects/${pid}`);
  const c8 = await req('GET', '/novelgen/api/projects');
  assert.equal(c8.json.data.projects.length, 0);
});

test('API:错误路径', async () => {
  const r = await req('GET', '/novelgen/api/projects/nope');
  assert.equal(r.status, 404);
  assert.equal(r.json.ok, false);
  const r2 = await req('GET', '/novelgen/api/no-such-route');
  assert.equal(r2.status, 404);
  const r3 = await req('GET', '/novelgen/../package.json');
  assert.equal(r3.status, 404); // 无路径穿越
});

test('API:数据目录(config)读取与切换', async () => {
  // 读取当前目录
  const g1 = await req('GET', '/novelgen/api/config');
  assert.equal(g1.status, 200);
  assert.equal(g1.json.data.root, root);
  // 切换目录
  const p1 = await req('PUT', '/novelgen/api/config', { root: rootB });
  assert.equal(p1.status, 200);
  assert.equal(p1.json.data.root, rootB);
  const g2 = await req('GET', '/novelgen/api/config');
  assert.equal(g2.json.data.root, rootB);
  // 新目录里建的项目落在新目录
  const c = await req('POST', '/novelgen/api/projects', { name: '《新目录的书》' });
  assert.equal(c.status, 200);
  assert.ok(fs.existsSync(path.join(rootB, c.json.data.project.id, 'project.json')));
  // 旧目录项目在新目录不可见
  const list = await req('GET', '/novelgen/api/projects');
  assert.equal(list.json.data.projects.length, 1);
  assert.equal(list.json.data.projects[0].name, '《新目录的书》');
  // 非法目录(空字符串)被拒绝
  const bad = await req('PUT', '/novelgen/api/config', { root: '   ' });
  assert.equal(bad.status, 400);
  // 切回
  await req('PUT', '/novelgen/api/config', { root });
});

test('API:非法 JSON body', async () => {
  const r = await new Promise((resolve, reject) => {
    const raw = 'not-json{';
    const req2 = http.request({ host: '127.0.0.1', port: server.address().port, path: '/novelgen/api/projects', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) }));
    });
    req2.on('error', reject);
    req2.write(raw);
    req2.end();
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.ok, false);
});

server.listen(0, '127.0.0.1', async () => {
  await runTests();
});
