// ==================== NovelGen DSH 插件入口(cordis 插件模块) ====================
// 导出 { name, inject, apply }:loader 按行名加载本包,apply(ctx, config) 注册:
//   1. novel_* 工具(agent 在对话中自动调用,数据落盘 <数据目录>/<projectId>/project.json)
//   2. /novelgen Web 视图与 /novelgen/api JSON API(挂到 webServer 服务)
//
// 数据目录(自定义工作区)解析优先级:
//   持久化文件($DSH_HOME/novelgen.data-root,web 视图里可改)> DSH_NOVELGEN_ROOT
//   > profile patch 的 config.root > <宿主进程 cwd>/novels
// 运行中可通过 ctx.novelgen.setRoot(path) 或 PUT /novelgen/api/config 切换,立即生效并持久化。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNovelStore } from './store.js';
import { createTools } from './tools.js';
import { createNovelgenRouter } from './routes.js';

const name = 'novelgen';
const inject = ['tools'];

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const ROOT_FILE = path.join(DSH_HOME, 'novelgen.data-root');

function loadPersistedRoot() {
  try {
    const v = fs.readFileSync(ROOT_FILE, 'utf-8').trim();
    return v || null;
  } catch { return null; }
}

function persistRoot(root) {
  try {
    fs.mkdirSync(DSH_HOME, { recursive: true });
    fs.writeFileSync(ROOT_FILE, root, 'utf-8');
  } catch { /* 持久化失败不阻断(下次启动回退到配置) */ }
}

function apply(ctx, config = {}) {
  const configured = config?.root ? String(config.root).trim() : (process.env.DSH_NOVELGEN_ROOT || '').trim();
  let currentRoot = loadPersistedRoot() || configured || path.join(process.cwd(), 'novels');

  // store 以函数方式持有 root:setRoot 切换后,工具与 REST 自动跟随
  const store = createNovelStore(() => currentRoot);

  function setRoot(next) {
    if (typeof next !== 'string' || next.trim() === '') throw new Error('数据目录不能为空');
    const absolute = path.resolve(next.trim());
    fs.mkdirSync(absolute, { recursive: true });
    currentRoot = absolute;
    persistRoot(absolute);
    ctx.logger?.info?.('[novelgen] 数据目录切换为: %s', absolute);
    return absolute;
  }

  // 1) 注册模型侧工具
  for (const tool of createTools(store)) {
    ctx.tools.register(tool);
  }

  // 2) 注册 /novelgen Web 视图 + JSON API(webserver 服务可用时)
  ctx.inject(['webServer'], (wctx) => {
    const dispose = wctx.webServer.register({
      kind: 'prefix',
      path: '/novelgen',
      handler: createNovelgenRouter(store, { getRoot: () => store.getRoot(), setRoot })
    });
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose);
  });

  // 3) 暴露服务:其他插件可通过 ctx.novelgen 访问 store / 切换数据目录
  if (typeof ctx.provide === 'function') {
    ctx.provide('novelgen', {
      getRoot: () => store.getRoot(),
      setRoot,
      listProjects: store.listProjects,
      createProject: store.createProject,
      getProject: store.getProject
    });
  }

  ctx.logger?.info?.('[novelgen] 插件已启动,小说数据目录: %s', store.getRoot());
}

export { name, inject, apply };
