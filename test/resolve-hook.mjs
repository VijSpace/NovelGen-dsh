// ESM resolve hook:把裸导入 @deepseek-ai/* 重定向到 dsh 安装目录,
// 模拟 DSH loader 的 bareModuleBaseUrl 机制(仅用于本地冒烟测试)。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const INSTALL = 'C:/Users/A/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules';

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/')) {
    const [scope, name] = specifier.split('/');
    const pkg = `${scope}/${name}`;
    const pkgDir = `${INSTALL}/${pkg}`;
    const manifest = JSON.parse(readFileSync(`${pkgDir}/package.json`, 'utf-8'));
    const main = manifest.main || 'lib/index.js';
    return { url: pathToFileURL(`${pkgDir}/${main}`).href, shortCircuit: true };
  }
  return next(specifier, context);
}
