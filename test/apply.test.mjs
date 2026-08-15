// apply() 冒烟测试:加载【安装进 profile 的】novelgen-dsh 副本,
// 用 mock ctx 验证工具注册与 /novelgen 路由注册。
// 运行方式:node --experimental-loader ./test/resolve-hook.mjs test/apply.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const INSTALLED = 'C:/Users/A/.dsh/profiles/web/node_modules/novelgen-dsh/lib/index.js';
const { apply } = await import(pathToFileURL(INSTALLED).href);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novelgen-apply-'));
const registered = [];
const routes = [];
let provided = null;

const ctx = {
  tools: { register: (def) => registered.push(def) },
  inject: (deps, fn) => {
    assert.deepEqual(deps, ['webServer']);
    fn({ webServer: { register: (route) => { routes.push(route); return () => {}; } } });
  },
  effect: () => {},
  provide: (name, svc) => { provided = { name, svc }; },
  logger: { info: () => {} }
};

apply(ctx, { root });

try {
  // 1) 19 个工具注册
  assert.equal(registered.length, 19, '应注册 19 个 novel_* 工具');
  const names = registered.map((t) => t.name).sort();
  assert.ok(names.includes('novel_list_projects'));
  assert.ok(names.includes('novel_write_chapter'));
  assert.ok(names.includes('novel_update_setting'));
  assert.ok(names.includes('novel_delete_setting'));
  assert.ok(names.includes('novel_rename_setting'));
  assert.ok(names.includes('novel_roleplay_start'));
  assert.ok(names.every((n) => n.startsWith('novel_')));

  // 2) /novelgen 路由注册
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, '/novelgen');
  assert.equal(typeof routes[0].handler, 'function');

  // 3) 服务暴露
  assert.equal(provided.name, 'novelgen');
  assert.equal(typeof provided.svc.getRoot, 'function');

  // 4) 数据落盘到指定 root
  assert.ok(fs.existsSync(root));
  console.log('  ✓ apply() 冒烟:19 工具 + /novelgen 路由 + novelgen 服务 + 数据目录');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
