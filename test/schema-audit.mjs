// 动态校验:全部 19 个工具的 execute 返回值 vs output.schema 严格匹配
import { createNovelStore } from '../lib/store.js';
import { createTools } from '../lib/tools.js';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-audit-'));
const store = createNovelStore(root);
const tools = createTools(store);
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const noopExec = { deferContext: () => {} };

let pass = 0, fail = 0;
function check(toolName, value, label) {
  try {
    const tool = byName[toolName];
    if (!tool) throw new Error('工具不存在: ' + toolName);
    validateJsonSchemaValue(tool.output.schema, value);
    console.log('  ✓', label || toolName);
    pass++;
  } catch (e) {
    console.log('  ✗', label || toolName, '->', e.message);
    fail++;
  }
}

console.log('== 全工具 schema 严格校验 ==');
// 项目
const p = await byName.novel_create_project.execute({ name: '《审计》' }, noopExec);
check('novel_create_project', p);
const pid = p.project.id;
check('novel_list_projects', await byName.novel_list_projects.execute({}));
check('novel_get_project', await byName.novel_get_project.execute({ projectId: pid }));
check('novel_get_project', await byName.novel_get_project.execute({ projectId: pid, includeContent: true }), 'novel_get_project(includeContent)');
check('novel_rename_project', await byName.novel_rename_project.execute({ projectId: pid, name: '《审计·改》' }));
// 卷
const v1 = await byName.novel_create_volume.execute({ projectId: pid, title: '第一卷' });
const vid = v1.volume.id;
check('novel_create_volume', v1);
await byName.novel_create_volume.execute({ projectId: pid, title: '第二卷' });
check('novel_rename_volume', await byName.novel_rename_volume.execute({ projectId: pid, volumeId: vid, title: '第一卷·改' }));
// 章
const c1 = await byName.novel_create_chapter.execute({ projectId: pid, volumeId: vid, title: '第一章' });
const cid = c1.chapter.id;
check('novel_create_chapter', c1);
check('novel_write_chapter', await byName.novel_write_chapter.execute({ projectId: pid, volumeId: vid, chapterId: cid, content: '正文' }));
check('novel_read_chapter', await byName.novel_read_chapter.execute({ projectId: pid, volumeId: vid, chapterId: cid }));
check('novel_read_chapter', await byName.novel_read_chapter.execute({ projectId: pid, volumeId: vid, chapterId: cid, offset: 0, limit: 2 }), 'novel_read_chapter(分页)');
check('novel_rename_chapter', await byName.novel_rename_chapter.execute({ projectId: pid, volumeId: vid, chapterId: cid, title: '第一章·改' }));
// 设定
check('novel_get_settings', await byName.novel_get_settings.execute({ projectId: pid }));
check('novel_update_setting', await byName.novel_update_setting.execute({ projectId: pid, category: '世界观', group: '新伊甸', entry: '星门', content: '传送门' }));
check('novel_update_setting', await byName.novel_update_setting.execute({ projectId: pid, category: '世界观', entry: '直挂', content: 'x' }), 'novel_update_setting(无group)');
check('novel_rename_setting', await byName.novel_rename_setting.execute({ projectId: pid, category: '世界观', group: '新伊甸', entry: '星门', newName: '星门·改' }));
check('novel_delete_setting', await byName.novel_delete_setting.execute({ projectId: pid, category: '世界观', group: '新伊甸', entry: '星门·改' }), 'novel_delete_setting(entry)');
check('novel_delete_setting', await byName.novel_delete_setting.execute({ projectId: pid, category: '世界观', group: '新伊甸' }), 'novel_delete_setting(group)');
// 剧情演绎
store.updateSetting(pid, '角色设定', '主角团', '艾拉', '拾荒者');
check('novel_roleplay_start', await byName.novel_roleplay_start.execute({ projectId: pid, character: '主角团', scene: '场景' }, noopExec));
check('novel_roleplay_pick', await byName.novel_roleplay_pick.execute({ projectId: pid, character: '主角团' }, noopExec));
// 删除类(顺序:章→卷→项目)
check('novel_delete_chapter', await byName.novel_delete_chapter.execute({ projectId: pid, volumeId: vid, chapterId: cid }));
check('novel_delete_volume', await byName.novel_delete_volume.execute({ projectId: pid, volumeId: vid }));
check('novel_delete_project', await byName.novel_delete_project.execute({ projectId: pid }));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
