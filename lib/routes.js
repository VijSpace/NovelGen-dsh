// ==================== /novelgen Web 路由 ====================
// 挂到 DSH webserver 服务上(node:http handler):
//   - GET  /novelgen[/]          → web/index.html(小说树 + 编辑器视图)
//   - GET  /novelgen/*.js|css    → 静态资源
//   - /novelgen/api/*            → JSON API(与 novel_* 工具共用同一 store)
// 响应统一为 { ok: true, data } / { ok: false, error }。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_JSON_BODY_BYTES } from './store.js';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function ok(res, data) {
  sendJson(res, 200, { ok: true, data });
}

function fail(res, error, status = 400) {
  sendJson(res, status, { ok: false, error: String(error && error.message || error) });
}

function serveStatic(res, relPath) {
  const file = path.join(WEB_DIR, relPath);
  const ext = path.extname(file).toLowerCase();
  if (!MIME[ext] || !fs.existsSync(file)) return false;
  res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_JSON_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
      catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

/**
 * @param {ReturnType<typeof import('./store.js').createNovelStore>} store
 * @param {{ getRoot: () => string, setRoot: (path: string) => string }} [conf] 数据目录配置访问器
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createNovelgenRouter(store, conf = { getRoot: () => store.getRoot(), setRoot: () => { throw new Error('数据目录不可切换'); } }) {
  return async (req, res) => {
    const url = new URL(req.url || '/', 'http://novelgen.local');
    const pathname = url.pathname;
    const method = (req.method || 'GET').toUpperCase();

    try {
      // ---------- 静态页面 ----------
      if (method === 'GET') {
        if (pathname === '/novelgen' || pathname === '/novelgen/') {
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
          return fs.createReadStream(path.join(WEB_DIR, 'index.html')).pipe(res);
        }
        if (pathname.startsWith('/novelgen/')) {
          const rel = pathname.slice('/novelgen/'.length);
          if (serveStatic(res, rel)) return;
        }
      }

      // ---------- JSON API ----------
      const api = pathname.startsWith('/novelgen/api') ? pathname.slice('/novelgen/api'.length) : null;

      if (api === '/health') {
        return ok(res, { status: 'ok', root: store.getRoot() });
      }

      // 数据目录(自定义工作区)读取 / 切换
      if (api === '/config' && method === 'GET') {
        return ok(res, { root: store.getRoot() });
      }
      if (api === '/config' && method === 'PUT') {
        const body = await readBody(req);
        return ok(res, { root: conf.setRoot(body.root) });
      }

      // GET /api/projects
      if (api === '/projects' && method === 'GET') {
        return ok(res, { projects: store.listProjects() });
      }

      // PUT /api/projects/order —— 项目拖拽排序持久化:body = { ids: [完整项目ID列表] }
      if (api === '/projects/order' && method === 'PUT') {
        const body = await readBody(req);
        return ok(res, store.orderProjects(body.ids));
      }

      // POST /api/projects
      if (api === '/projects' && method === 'POST') {
        const body = await readBody(req);
        const p = store.createProject(body.name, body.systemPrompt);
        return ok(res, { project: p });
      }

      const mProject = api?.match(/^\/projects\/([^/]+)$/);
      if (mProject) {
        const pid = decodeURIComponent(mProject[1]);
        if (method === 'GET') return ok(res, { project: store.getProject(pid) });
        if (method === 'PATCH') {
          const body = await readBody(req);
          return ok(res, { project: store.renameProject(pid, body.name) });
        }
        if (method === 'DELETE') return ok(res, store.deleteProject(pid));
      }

      // 版本快照(自动备份):GET 列出 / POST 恢复(body = { ts })
      const mBackups = api?.match(/^\/projects\/([^/]+)\/backups$/);
      if (mBackups && method === 'GET') {
        const pid = decodeURIComponent(mBackups[1]);
        return ok(res, { backups: store.listBackups(pid) });
      }
      const mBackupRestore = api?.match(/^\/projects\/([^/]+)\/backups\/restore$/);
      if (mBackupRestore && method === 'POST') {
        const pid = decodeURIComponent(mBackupRestore[1]);
        const body = await readBody(req);
        return ok(res, { project: store.restoreBackup(pid, body.ts) });
      }

      // 整份恢复(撤销/重做):body = { volumes?, settings? }
      const mRestore = api?.match(/^\/projects\/([^/]+)\/restore$/);
      if (mRestore && method === 'POST') {
        const pid = decodeURIComponent(mRestore[1]);
        const body = await readBody(req);
        return ok(res, { project: store.restoreProject(pid, body) });
      }

      const mVolume = api?.match(/^\/projects\/([^/]+)\/volumes\/([^/]+)$/);
      if (mVolume) {
        const pid = decodeURIComponent(mVolume[1]);
        const vid = decodeURIComponent(mVolume[2]);
        if (method === 'PATCH') {
          const body = await readBody(req);
          return ok(res, { volume: store.renameVolume(pid, vid, body.title) });
        }
        if (method === 'DELETE') return ok(res, store.deleteVolume(pid, vid));
      }

      const mChapter = api?.match(/^\/projects\/([^/]+)\/volumes\/([^/]+)\/chapters\/([^/]+)$/);
      if (mChapter) {
        const pid = decodeURIComponent(mChapter[1]);
        const vid = decodeURIComponent(mChapter[2]);
        const cid = decodeURIComponent(mChapter[3]);
        if (method === 'PATCH') {
          const body = await readBody(req);
          const c = store.writeChapter(pid, vid, cid, {
            content: body.content,
            mode: body.mode,
            title: body.title,
            status: body.status
          });
          return ok(res, { chapter: c });
        }
        if (method === 'DELETE') return ok(res, store.deleteChapter(pid, vid, cid));
      }

      const mChapters = api?.match(/^\/projects\/([^/]+)\/volumes\/([^/]+)\/chapters$/);
      if (mChapters && method === 'POST') {
        const pid = decodeURIComponent(mChapters[1]);
        const vid = decodeURIComponent(mChapters[2]);
        const body = await readBody(req);
        return ok(res, { chapter: store.addChapter(pid, vid, body.title, body.afterIndex) });
      }

      const mVolumes = api?.match(/^\/projects\/([^/]+)\/volumes$/);
      if (mVolumes && method === 'POST') {
        const pid = decodeURIComponent(mVolumes[1]);
        const body = await readBody(req);
        return ok(res, { volume: store.addVolume(pid, body.title, body.afterIndex) });
      }

      const mSettings = api?.match(/^\/projects\/([^/]+)\/settings$/);
      if (mSettings) {
        const pid = decodeURIComponent(mSettings[1]);
        if (method === 'PUT') {
          const body = await readBody(req);
          return ok(res, { settings: store.saveSettings(pid, body.settings) });
        }
        if (method === 'PATCH') {
          // upsert 条目:body = { category, group?, entry, content }
          const body = await readBody(req);
          return ok(res, { settings: store.updateSetting(pid, body.category, body.group, body.entry, body.content) });
        }
      }

      return fail(res, `未找到路由: ${method} ${pathname}`, 404);
    } catch (e) {
      const msg = String(e && e.message || e);
      const status = /不存在|未找到/.test(msg) ? 404 : 400;
      return fail(res, e, status);
    }
  };
}
