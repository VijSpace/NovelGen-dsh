// ==================== NovelGen 模型侧工具定义 ====================
// 每个工具用 defineTool 声明:parameters(DSH 参数规格)、output(schema + render)、
// execute(调用 store 落盘 JSON)。供 DSH agent 在多轮对话中自动调用。

import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

const text = (t) => [{ type: 'text', text: t }];

// ---------- 设定上下文注入 ----------
// 每个项目级工具调用时,把该项目设定快照经工具的 deferContext 延迟注入到 agent
// 的下一轮上下文,保证 AI 写作/改稿时始终"读得到"系统提示词、角色、世界观等设定。

function settingsContext(store, projectId) {
  let s;
  try { s = store.getSettings(projectId); } catch { return null; }
  s = s || {};
  const parts = [];
  if (s.systemPrompt && String(s.systemPrompt).trim() !== '') parts.push(`- 系统提示词: ${String(s.systemPrompt).trim()}`);
  for (const c of (s.categories || [])) {
    if (c.groups && c.groups.length > 0) {
      parts.push(`- ${c.name}(分类组,${c.groups.length} 个分类):`);
      for (const g of c.groups) {
        const names = (g.entries || []).map((e) => e.name).filter(Boolean).join('、');
        parts.push(`    ${g.name}: ${names || '(空)'}`);
      }
    } else {
      const names = (c.entries || []).map((e) => e.name).filter(Boolean).join('、');
      parts.push(`- ${c.name}: ${names || '(空)'}`);
    }
  }
  if (parts.length === 0) return null;
  let body = `【当前项目设定 · ${projectId}】\n${parts.join('\n')}`;
  if (body.length > 2500) body = body.slice(0, 2500) + '\n…(已截断,可用 novel_get_settings 读取完整设定)';
  return body;
}

function deferSettings(exec, store, projectId) {
  if (!exec || typeof exec.deferContext !== 'function') return;
  const ctxText = settingsContext(store, projectId);
  if (!ctxText) return;
  exec.deferContext(createUserMessage({
    content: [{ type: 'text', text: ctxText }],
    source: { kind: 'plugin', plugin: 'novelgen-dsh' }
  }));
}

// ---------- 剧情演绎(原「角色扮演」,改名迁移) ----------
// 角色池不再是"所有 角色设定 条目",而是让用户自选「角色设定」分类组下的一个分类,
// 该分类里的全部条目合成为一张"人设卡"作为本次演绎的角色。

// 取 角色设定 分类组下的分类(成员)清单
function rpCharacterGroups(settings) {
  const cat = (settings.categories || []).find((c) => c.name === '角色设定');
  if (!cat) return [];
  return (cat.groups || []).filter((g) => g && g.name).map((g) => g.name);
}

// 把指定分类的全部条目拼成人设卡文本
function rpBuildCard(settings, character) {
  const cat = (settings.categories || []).find((c) => c.name === '角色设定');
  const group = cat?.groups?.find((g) => g.name === character);
  const entries = (group?.entries || []).filter((e) => e && e.name);
  if (!group || entries.length === 0) return null;
  return {
    card: entries.map((e) => `【${e.name}】${e.content || '（无详细设定）'}`).join('\n'),
    names: entries.map((e) => e.name)
  };
}

// 世界设定:角色设定 之外的全部分类组 → 分类 → 条目,截断 3000 字
function rpWorldContext(settings) {
  const parts = [];
  for (const c of settings.categories || []) {
    if (c.name === '角色设定') continue;
    if (c.groups && c.groups.length > 0) {
      for (const g of c.groups) {
        const lines = (g.entries || []).map((e) => `${e.name}：${e.content || ''}`).filter(Boolean);
        if (lines.length) parts.push(`[${g.name}]\n${lines.join('\n')}`);
      }
    } else {
      const lines = (c.entries || []).map((e) => `${e.name}：${e.content || ''}`).filter(Boolean);
      if (lines.length) parts.push(`[${c.name}]\n${lines.join('\n')}`);
    }
  }
  let ctx = parts.join('\n\n');
  if (ctx.length > 3000) ctx = ctx.substring(0, 3000) + '\n…（设定过长已截断）';
  return ctx;
}

// 构建演绎系统提示词(互动叙事规则,角色卡 = 所选分类的全部条目)
function rpBuildPrompt({ card, groupName, scene, mode, worldContext }) {
  const sceneText = scene && String(scene).trim() !== ''
    ? scene
    : '由剧情中的【场景】条目决定——最近的场景条目即当前场景';
  const modeLine = mode === 'scene'
    ? '【叙事基调】本轮推进当前场景直到出现转场:依次生成多个剧情条目,直到发生【转场】时,生成一个【转场】条目作为结束标记,然后立即停下,不要继续后面的内容。'
    : mode === 'full'
      ? '【叙事基调】全自动连续推进剧情,可以依次生成多个剧情条目(【场景】推进、【角色名】行为/台词、【转场】),持续推进直到用户手动停止。'
      : '【叙事基调】每次生成一个剧情条目(场景或角色行为);需要推进时自然过渡,不要一次性把所有剧情讲完。';

  return `你是互动小说叙事的引擎,负责驱动一个「剧情空间」——一个按顺序推进的剧情时间线。

【本次演绎角色(人设卡,来自「角色设定」分类组的「${groupName}」分类;严格遵守,不要出戏)】
${card || '（所选分类暂无条目,可创造符合世界设定的角色）'}

【当前场景】
${sceneText}

${worldContext ? '【世界设定】\n' + worldContext + '\n' : ''}
【剧情条目类型(四者同等地位,按时间顺序排列)】
- 【场景】:当前场景内的环境/事件/位置推进。一个场景条目 = 一次变化或推进,【不】代表剧情跳到别处。
- 【转场】:换地点/时间跳转/新事件开始。一个转场条目 = 剧情离开当前场景、进入新场景。【转场】是停下等待的分界点。
- 【角色名】:该角色的一次对话、行动或内心活动。一个角色条目 = 该角色的一次回应。
- 【旁白】:屏幕外的叙述者(通常是用户)的点评、思考说明、方向引导。旁白【不在剧情内】,你要把旁白的意图落实为【场景】或【角色】条目,不要把旁白当作剧情内容来续写。

【推进原则】
1. 每次只生成【一个】剧情条目(一个【场景】或一个【角色名】的行为/台词),不要一口气推进多个场景或多轮对话
2. 不要替用户补完全部剧情——生成一条后立即停下,等待用户或后续指示
3. 除非用户明确要求"推进到转场/全自动推进",否则每次只推进一小步,给用户留出交互空间
4. 回复格式:【场景】… 或 【角色名】…,如:【场景】两人走进餐厅、【A先生】"请坐"
5. 你扮演剧情时间线中出现的所有角色(用户操控过的 + 你引入的);需要新角色时优先从人设卡挑选,或创造符合世界设定的角色
6. 严格遵守角色人设(参考人设卡),不要说"作为AI"之类出戏的话
7. 可以描写角色的动作、表情、内心活动,用()或*括起来
8. 用中文回复

${modeLine}

【用户输入解读】用户在对话中直接输入的文字按以下规则理解:
- 以「场景:」「旁白:」「转场:」开头的输入 = 对应的剧情条目类型
- 以角色名(如「张三:」「艾拉:」)开头的输入 = 该角色的行为/台词
- 普通输入 = 屏幕外的旁白/方向引导,不在剧情内,你要落实为【场景】或【角色】条目
- 若用户以第一人称直接说话(无前缀),可视为当前主角(人设卡第一个角色)在说话`;
}

function deferRoleplay(exec, promptText) {
  if (!exec || typeof exec.deferContext !== 'function') return;
  exec.deferContext(createUserMessage({
    content: [{ type: 'text', text: `【剧情演绎 · 系统设定】以下为本轮剧情演绎的规则,请严格遵守并进入演绎状态:\n\n${promptText}` }],
    source: { kind: 'plugin', plugin: 'novelgen-dsh' }
  }));
}

const chapterCard = (c) => ({
  id: c.id,
  title: c.title,
  status: c.status,
  wordCount: c.wordCount,
  updated: c.updated
});

/**
 * 组装全部 novel_* 工具。
 * @param {ReturnType<typeof import('./store.js').createNovelStore>} store
 */
export function createTools(store) {
  return [

    // ---------- 项目 ----------

    defineTool({
      name: 'novel_list_projects',
      description: '列出当前全部小说项目(名称、创建/更新时间、卷数、章数、总字数)。AI 在开始写作、续写或用户询问"有哪些小说"时先调用它。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            projects: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  created: { type: 'string', required: true },
                  updated: { type: 'string', required: true },
                  volumes: { type: 'integer', required: true },
                  chapters: { type: 'integer', required: true },
                  words: { type: 'integer', required: true }
                }
              }
            }
          }
        },
        render: (_args, value) => {
          if (value.projects.length === 0) return text('当前没有小说项目。');
          const lines = value.projects.map((p, i) =>
            `${i + 1}. ${p.name} (${p.volumes} 卷 / ${p.chapters} 章 / ${p.words} 字, 项目ID: ${p.id})`
          );
          return text(`共有 ${value.projects.length} 个小说项目:\n${lines.join('\n')}`);
        }
      },
      execute: () => Promise.resolve({ projects: store.listProjects() }),
      presentCall: () => ({ card: 'generic', title: '列出小说项目', kind: 'other', rawInput: {} })
    }),

    defineTool({
      name: 'novel_create_project',
      description: '新建一个小说项目。AI 在用户提出新小说创意时调用,可同时给出全书系统提示词(systemPrompt)。返回项目 ID,后续卷/章/设定操作都需要它。',
      parameters: {
        name: { type: 'string', required: true, description: '小说项目名称,如《星际拾荒者》' },
        systemPrompt: { type: 'string', description: '全书写作风格/世界观约束的系统提示词(可选)' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            project: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                created: { type: 'string', required: true },
                updated: { type: 'string', required: true }
              }
            }
          }
        },
        render: (_args, value) => text(`已创建小说项目「${value.project.name}」(ID: ${value.project.id})`)
      },
      execute: (args, exec) => {
        deferSettings(exec, store, args.projectId);
        const p = store.createProject(args.name, args.systemPrompt);
        return Promise.resolve({ project: { id: p.id, name: p.name, created: p.created, updated: p.updated } });
      },
      presentCall: (args) => ({ card: 'generic', title: `新建项目「${args.name}」`, kind: 'other', rawInput: args })
    }),

    defineTool({
      name: 'novel_get_project',
      description: '读取项目结构:全部卷、每卷的章节标题/状态/字数/更新时间,以及全书设定。默认不含章节正文(正文用 novel_read_chapter 读取);includeContent=true 时返回每章正文(每章最多前 20000 字)。AI 规划写作、检查进度、回顾设定时调用。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 ID' },
        includeContent: { type: 'boolean', description: '是否包含章节正文(默认 false)' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            project: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                volumes: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                  id: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  chapters: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                    id: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    status: { type: 'string', required: true },
                    wordCount: { type: 'integer', required: true },
                    updated: { type: 'string', required: true },
                    content: { type: 'string' },
                    truncated: { type: 'boolean' }
                  } } }
                } } }
              }
            },
            settings: {
              type: 'object',
              additionalProperties: true,
              required: true
            }
          }
        },
        render: (_args, value) => {
          const p = value.project;
          const lines = [`项目「${p.name}」(${p.id}):`];
          if (p.volumes.length === 0) lines.push('  (暂无卷)');
          for (const v of p.volumes) {
            lines.push(`  📕 卷: ${v.title} (volumeId: ${v.id})`);
            if (v.chapters.length === 0) lines.push('    (暂无章)');
            for (const c of v.chapters) {
              lines.push(`    📄 ${c.title} [${c.status}] ${c.wordCount}字${c.truncated ? '(正文已截断)' : ''} (chapterId: ${c.id})`);
            }
          }
          return text(lines.join('\n'));
        }
      },
      execute: (args, exec) => {
        deferSettings(exec, store, args.projectId);
        const p = store.getProject(args.projectId);
        const volumes = p.volumes.map((v) => ({
          id: v.id,
          title: v.title,
          chapters: v.chapters.map((c) => {
            const base = chapterCard(c);
            if (args.includeContent) {
              const content = c.content || '';
              if (content.length > 20000) { base.content = content.slice(0, 20000); base.truncated = true; }
              else base.content = content;
            }
            return base;
          })
        }));
        return Promise.resolve({ project: { id: p.id, name: p.name, volumes }, settings: p.settings });
      },
      presentCall: (args) => ({ card: 'generic', title: '读取项目结构', kind: 'other', rawInput: args })
    }),

    defineTool({
      name: 'novel_rename_project',
      description: '重命名小说项目。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 ID' },
        name: { type: 'string', required: true, description: '新名称' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            project: { type: 'object', additionalProperties: false, required: true, properties: {
              id: { type: 'string', required: true }, name: { type: 'string', required: true }
            } }
          }
        },
        render: (_args, value) => text(`项目已重命名为「${value.project.name}」`)
      },
      execute: (args, exec) => {
        deferSettings(exec, store, args.projectId);
        const p = store.renameProject(args.projectId, args.name);
        return Promise.resolve({ project: { id: p.id, name: p.name } });
      },
      presentCall: (args) => ({ card: 'generic', title: '重命名项目', kind: 'other', rawInput: args })
    }),

    defineTool({
      name: 'novel_delete_project',
      description: '删除小说项目(连同全部卷章设定,不可恢复)。调用前应再次与用户确认。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 ID' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true }
          }
        },
        render: (args) => text(`已删除项目 ${args.projectId}`)
      },
      execute: (args, exec) => {
        deferSettings(exec, store, args.projectId);
        return Promise.resolve(store.deleteProject(args.projectId));
      },
      presentCall: (args) => ({ card: 'generic', title: '删除项目', kind: 'other', rawInput: args })
    }),

    // ---------- 卷 ----------

    defineTool({
      name: 'novel_create_volume',
      description: '在项目中新建一卷。afterIndex 指定插到哪一卷之后(0 表示第一卷之后;省略则追加到末尾)。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 ID' },
        title: { type: 'string', required: true, description: '卷标题,如"第一卷 觉醒"' },
        afterIndex: { type: 'integer', description: '插入位置(可选)' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            volume: { type: 'object', additionalProperties: false, required: true, properties: {
              id: { type: 'string', required: true }, title: { type: 'string', required: true }
            } }
          }
        },
        render: (_args, value) => text(`已创建卷「${value.volume.title}」(ID: ${value.volume.id})`)
      },
      execute: (args, exec) => {
        deferSettings(exec, store, args.projectId);
        const v = store.addVolume(args.projectId, args.title, args.afterIndex);
        return Promise.resolve({ volume: { id: v.id, title: v.title } });
      },
      presentCall: (args) => ({ card: 'generic', title: `新建卷「${args.title}」`, kind: 'other', rawInput: args })
    }),

    defineTool({
      name: 'novel_rename_volume',
      description: '重命名卷。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 ID' },
        volumeId: { type: 'string', required: true, description: '卷 ID' },
        title: { type: 'string', required: true, description: '新卷标题' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            volume: { type: 'object', additionalProperties: false, required: true, properties: {
              id: { type: 'string', required: true }, title: { type: 'string', required: true }
            } }
          }
        },
        render: (_args, value) => text(`卷已重命名为「${value.volume.title}」`)
      },
      execute: (args, exec) => {
        deferSettings(exec, store, args.projectId);
        const v = store.renameVolume(args.projectId, args.volumeId, args.title);
        return Promise.resolve({ volume: { id: v.id, title: v.title } });
      },
      presentCall: () => ({ card: 'generic', title: '重命名卷', kind: 'other', rawInput: {} })
    }),

    defineTool({
      name: 'novel_delete_volume',
      description: '删除整卷及其全部章节。调用前应确认。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 ID' },
        volumeId: { type: 'string', required: true, description: '卷 ID' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            volumeId: { type: 'string', required: true }
          }
        },
        render: (args) => text(`已删除卷 ${args.volumeId}`)
      },
      execute: (args, exec) => {
        deferSettings(exec, store, args.projectId);
        return Promise.resolve(store.deleteVolume(args.projectId, args.volumeId));
      },
      presentCall: () => ({ card: 'generic', title: '删除卷', kind: 'other', rawInput: {} })
    }),

    // ---------- 章 ----------

    defineTool({
      name: 'novel_create_chapter',
      description: '在指定卷中新建一章(空正文,draft 状态)。afterIndex 指定插到哪一章之后(省略则追加到卷末尾)。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 ID' },
        volumeId: { type: 'string', required: true, description: '卷 ID' },
        title: { type: 'string', required: true, description: '章节标题,如"第一章 废墟来信"' },
        afterIndex: { type: 'integer', description: '插入位置(可选)' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            chapter: { type: 'object', additionalProperties: false, required: true, properties: {
              id: { type: 'string', required: true }, title: { type: 'string', required: true }
            } }
          }
        },
        render: (_args, value) => text(`已创建章节「${value.chapter.title}」(ID: ${value.chapter.id})`)
      },
      execute: (args, exec) => {
        deferSettings(exec, store, args.projectId);
        const c = store.addChapter(args.projectId, args.volumeId, args.title, args.afterIndex);
        return Promise.resolve({ chapter: { id: c.id, title: c.title } });
      },
      presentCall: (args) => ({ card: 'generic', title: `新建章「${args.title}」`, kind: 'other', rawInput: args })
    }),

    defineTool({
      name: 'novel_write_chapter',
      description: '写入/续写章节正文。mode: replace(整章替换,默认)、append(追加到末尾)、prepend(插到开头)。返回新字数。AI 每写完一段应调用一次;长章节建议分多次 append 调用以控制单次输出长度。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 ID' },
        volumeId: { type: 'string', required: true, description: '卷 ID' },
        chapterId: { type: 'string', required: true, description: '章 ID' },
        content: { type: 'string', required: true, description: '章节正文' },
        mode: { type: 'string', enum: ['replace', 'append', 'prepend'], description: '写入模式,默认 replace' },
        title: { type: 'string', description: '修改章节标题(可选)' },
        status: { type: 'string', enum: ['draft', 'done', 'revising'], description: '章节状态(可选)' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            chapter: { type: 'object', additionalProperties: false, required: true, properties: {
              id: { type: 'string', required: true },
              title: { type: 'string', required: true },
              status: { type: 'string', required: true },
              wordCount: { type: 'integer', required: true },
              updated: { type: 'string', required: true }
            } }
          }
        },
        render: (_args, value) => {
          const c = value.chapter;
          return text(`章节「${c.title}」已保存:${c.wordCount} 字,状态 ${c.status}(${c.updated})`);
        }
      },
      execute: (args, exec) => {
        deferSettings(exec, store, args.projectId);
        const c = store.writeChapter(args.projectId, args.volumeId, args.chapterId, {
          content: args.content,
          mode: args.mode || 'replace',
          title: args.title,
          status: args.status
        });
        return Promise.resolve({ chapter: chapterCard(c) });
      },
      presentCall: (args) => ({ card: 'generic', title: `写入「${args.title || args.chapterId}」`, kind: 'other', rawInput: args })
    }),

    defineTool({
      name: 'novel_read_chapter',
      description: '读取章节正文。offset/limit 按字符数分页(默认从头读,limit 省略读全文)。AI 续写、修改、检查连贯性时先读取原文。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 ID' },
        volumeId: { type: 'string', required: true, description: '卷 ID' },
        chapterId: { type: 'string', required: true, description: '章 ID' },
        offset: { type: 'integer', description: '起始字符偏移,默认 0' },
        limit: { type: 'integer', description: '读取字符数,省略读至末尾' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            chapter: { type: 'object', additionalProperties: false, required: true, properties: {
              id: { type: 'string', required: true },
              title: { type: 'string', required: true },
              status: { type: 'string', required: true },
              wordCount: { type: 'integer', required: true },
              updated: { type: 'string', required: true }
            } },
            content: { type: 'string', required: true },
            offset: { type: 'integer', required: true },
            returnedChars: { type: 'integer', required: true },
            totalChars: { type: 'integer', required: true }
          }
        },
        render: (_args, value) => {
          const c = value.chapter;
          const head = value.content.length > 400 ? value.content.slice(0, 400) + '\n…(截断显示)' : value.content;
          return text(`章节「${c.title}」(${value.offset}-${value.offset + value.returnedChars}/${value.totalChars} 字):\n\n${head}`);
        }
      },
      execute: (args, exec) => {
        deferSettings(exec, store, args.projectId);
        return Promise.resolve(store.readChapter(args.projectId, args.volumeId, args.chapterId, {
          offset: args.offset, limit: args.limit
        }));
      },
      presentCall: (args) => ({ card: 'generic', title: `读取章节 ${args.chapterId}`, kind: 'other', rawInput: args })
    }),

    defineTool({
      name: 'novel_rename_chapter',
      description: '重命名章节。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 ID' },
        volumeId: { type: 'string', required: true, description: '卷 ID' },
        chapterId: { type: 'string', required: true, description: '章 ID' },
        title: { type: 'string', required: true, description: '新章节标题' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            chapter: { type: 'object', additionalProperties: false, required: true, properties: {
              id: { type: 'string', required: true }, title: { type: 'string', required: true }
            } }
          }
        },
        render: (_args, value) => text(`章节已重命名为「${value.chapter.title}」`)
      },
      execute: (args, exec) => {
        deferSettings(exec, store, args.projectId);
        const c = store.renameChapter(args.projectId, args.volumeId, args.chapterId, args.title);
        return Promise.resolve({ chapter: { id: c.id, title: c.title } });
      },
      presentCall: () => ({ card: 'generic', title: '重命名章节', kind: 'other', rawInput: {} })
    }),

    defineTool({
      name: 'novel_delete_chapter',
      description: '删除章节。调用前应确认。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 ID' },
        volumeId: { type: 'string', required: true, description: '卷 ID' },
        chapterId: { type: 'string', required: true, description: '章 ID' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            volumeId: { type: 'string', required: true },
            chapterId: { type: 'string', required: true }
          }
        },
        render: (args) => text(`已删除章节 ${args.chapterId}`)
      },
      execute: (args, exec) => {
        deferSettings(exec, store, args.projectId);
        return Promise.resolve(store.deleteChapter(args.projectId, args.volumeId, args.chapterId));
      },
      presentCall: () => ({ card: 'generic', title: '删除章节', kind: 'other', rawInput: {} })
    }),

    // ---------- 设定(分类 → 条目;分类组打包管理) ----------

    defineTool({
      name: 'novel_get_settings',
      description: '读取项目全部设定:系统提示词 + 固定结构 分类组 → 分类 → 条目(分类必须在分类组里)。AI 写作前回顾设定、维护设定一致性时调用。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 ID' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            settings: { type: 'object', additionalProperties: true, required: true }
          }
        },
        render: (_args, value) => {
          const s = value.settings;
          const lines = ['当前设定:'];
          if (s.systemPrompt) lines.push(`系统提示词: ${s.systemPrompt}`);
          for (const c of s.categories || []) {
            if (c.groups && c.groups.length > 0) {
              lines.push(`${c.name}(分类组 ${c.groups.length} 个分类):`);
              for (const g of c.groups) {
                const names = (g.entries || []).map((e) => e.name).filter(Boolean).join('、');
                lines.push(`  └ ${g.name}: ${names || '(空)'}`);
              }
            } else {
              const names = (c.entries || []).map((e) => e.name).filter(Boolean).join('、');
              lines.push(`${c.name}: ${names || '(空)'}`);
            }
          }
          if (!s.categories || s.categories.length === 0) lines.push('(暂无分类,可用 novel_update_setting 创建)');
          return text(lines.join('\n'));
        }
      },
      execute: (args, exec) => {
        deferSettings(exec, store, args.projectId);
        return Promise.resolve({ settings: store.getSettings(args.projectId) });
      },
      presentCall: (args) => ({ card: 'generic', title: '读取设定', kind: 'other', rawInput: args })
    }),

    defineTool({
      name: 'novel_update_setting',
      description: '新增或更新一条设定条目。固定结构 分类组 → 分类 → 条目:category 是分类组名(不存在自动创建),group 是分类名(可选,不带时自动归入「未整理」分类),entry 条目名(不存在则创建,存在则覆盖内容)。名称均可自定义。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 ID' },
        category: { type: 'string', required: true, description: '分类组名,如 世界观 / 分卷架构(不存在自动创建)' },
        group: { type: 'string', description: '分类名(可选),如 新伊甸;不带时归入「未整理」' },
        entry: { type: 'string', required: true, description: '条目名,如 第一章标题' },
        content: { type: 'string', required: true, description: '条目内容(纯文本,可长)' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            category: { type: 'string', required: true },
            group: { type: 'string' },
            entry: { type: 'string', required: true },
            settings: { type: 'object', additionalProperties: true, required: true }
          }
        },
        render: (args) => text(`已保存设定:${args.category}${args.group ? '.' + args.group : ''}.${args.entry}`)
      },
      execute: (args, exec) => {
        deferSettings(exec, store, args.projectId);
        const settings = store.updateSetting(args.projectId, args.category, args.group, args.entry, args.content);
        const result = { category: args.category, entry: args.entry, settings };
        if (args.group) result.group = args.group;
        return Promise.resolve(result);
      },
      presentCall: (args) => ({ card: 'generic', title: `更新设定 ${args.category}${args.group ? '/' + args.group : ''}/${args.entry}`, kind: 'other', rawInput: args })
    }),

    defineTool({
      name: 'novel_delete_setting',
      description: '删除设定。带 entry 删条目;只带 group 删分类组内的一个分类;只带 category 删整个分类或分类组。删除会连带其下所有内容,调用前确认。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 ID' },
        category: { type: 'string', required: true, description: '分类名或分类组名' },
        group: { type: 'string', description: '组内分类名(可选)' },
        entry: { type: 'string', description: '条目名(可选)' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            category: { type: 'string', required: true },
            group: { type: 'string' },
            entry: { type: 'string' },
            settings: { type: 'object', additionalProperties: true, required: true }
          }
        },
        render: (args) => text(`已删除设定:${args.category}${args.group ? '.' + args.group : ''}${args.entry ? '.' + args.entry : ''}`)
      },
      execute: (args, exec) => {
        deferSettings(exec, store, args.projectId);
        const settings = store.deleteSetting(args.projectId, args.category, args.group, args.entry);
        return Promise.resolve({ category: args.category, ...(args.group ? { group: args.group } : {}), ...(args.entry ? { entry: args.entry } : {}), settings });
      },
      presentCall: (args) => ({ card: 'generic', title: '删除设定', kind: 'other', rawInput: args })
    }),

    defineTool({
      name: 'novel_rename_setting',
      description: '重命名设定节点。带 entry 重命名条目;只带 group 重命名组内分类;只带 category 重命名分类或分类组。newName 为新名称。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 ID' },
        category: { type: 'string', required: true, description: '分类名或分类组名当前名' },
        group: { type: 'string', description: '组内分类名当前名(可选)' },
        entry: { type: 'string', description: '条目当前名(可选)' },
        newName: { type: 'string', required: true, description: '新名称' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            settings: { type: 'object', additionalProperties: true, required: true }
          }
        },
        render: (args) => text(`已重命名:${args.category}${args.group ? '.' + args.group : ''}${args.entry ? '.' + args.entry : ''} → ${args.newName}`)
      },
      execute: (args, exec) => {
        deferSettings(exec, store, args.projectId);
        const settings = store.renameSetting(args.projectId, args.category, args.group, args.entry, args.newName);
        return Promise.resolve({ settings });
      },
      presentCall: (args) => ({ card: 'generic', title: '重命名设定节点', kind: 'other', rawInput: args })
    }),

    // ---------- 剧情演绎(原「角色扮演」) ----------

    defineTool({
      name: 'novel_roleplay_start',
      description: '开始/进入「剧情演绎」模式(原角色扮演):从设定「角色设定」分类组中选一个分类(character 参数传分类名),该分类下的全部条目合成为本次演绎的人设卡,并注入互动小说叙事规则(每次只生成一个剧情条目【场景】/【角色名】,推进一小步)。scene 给初始场景,mode 选推进方式:single=单条、scene=推进到转场、full=全自动。用户开始剧情演绎/角色扮演/扮演某角色时调用。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 ID' },
        character: { type: 'string', required: true, description: '「角色设定」分类组下的分类名,该分类的全部条目合成为人设卡' },
        scene: { type: 'string', description: '初始场景描述(可选)' },
        mode: { type: 'string', enum: ['single', 'scene', 'full'], description: '推进方式,默认 single' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            character: { type: 'string', required: true },
            characterCard: { type: 'string', required: true },
            scene: { type: 'string', required: true },
            mode: { type: 'string', required: true },
            availableCharacters: { type: 'array', required: true, items: { type: 'string' } },
            prompt: { type: 'string', required: true }
          }
        },
        render: (_args, value) => {
          const lines = [
            `🎭 剧情演绎已开始(角色:${value.character} · 模式:${value.mode})`,
            '',
            '【人设卡】',
            value.characterCard,
            '',
            `【当前场景】${value.scene}`,
            '',
            '【可选的演绎角色分类】' + (value.availableCharacters.length ? value.availableCharacters.join('、') : '(暂无)'),
            '',
            '【玩法】直接继续对话推进剧情;每次只推进一个剧情条目(【场景】/【角色名】)。输入「场景:」「旁白:」「角色名:」开头可指定类型;换角色用 novel_roleplay_pick。'
          ];
          return text(lines.join('\n'));
        }
      },
      execute: (args, exec) => {
        deferSettings(exec, store, args.projectId);
        const settings = store.getSettings(args.projectId);
        const available = rpCharacterGroups(settings);
        const built = rpBuildCard(settings, args.character);
        if (!built) {
          throw new Error(`「角色设定」分类组下没有分类「${args.character}」。可选分类:${available.join('、') || '(暂无)'}`);
        }
        const mode = args.mode || 'single';
        const worldContext = rpWorldContext(settings);
        const promptText = rpBuildPrompt({
          card: built.card,
          groupName: args.character,
          scene: args.scene || '',
          mode,
          worldContext
        });
        deferRoleplay(exec, promptText);
        return Promise.resolve({
          character: args.character,
          characterCard: built.card,
          scene: args.scene && String(args.scene).trim() !== '' ? args.scene : '(由最近的【场景】条目决定)',
          mode,
          availableCharacters: available,
          prompt: promptText
        });
      },
      presentCall: (args) => ({ card: 'generic', title: `开始剧情演绎·${args.character}`, kind: 'other', rawInput: args })
    }),

    defineTool({
      name: 'novel_roleplay_pick',
      description: '切换「剧情演绎」的演绎角色:从「角色设定」分类组换选另一个分类,该分类全部条目成为新的人设卡,并重新注入演绎规则。scene 可更新当前场景。演绎中换角色/换人设时调用。',
      parameters: {
        projectId: { type: 'string', required: true, description: '项目 ID' },
        character: { type: 'string', required: true, description: '「角色设定」分类组下的分类名,该分类的全部条目合成为新的人设卡' },
        scene: { type: 'string', description: '更新当前场景(可选)' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            character: { type: 'string', required: true },
            characterCard: { type: 'string', required: true },
            scene: { type: 'string', required: true },
            availableCharacters: { type: 'array', required: true, items: { type: 'string' } },
            prompt: { type: 'string', required: true }
          }
        },
        render: (_args, value) => text(
          `🎭 已切换演绎角色:${value.character}\n\n【人设卡】\n${value.characterCard}\n\n【当前场景】${value.scene}\n\n可继续对话推进剧情。`
        )
      },
      execute: (args, exec) => {
        deferSettings(exec, store, args.projectId);
        const settings = store.getSettings(args.projectId);
        const available = rpCharacterGroups(settings);
        const built = rpBuildCard(settings, args.character);
        if (!built) {
          throw new Error(`「角色设定」分类组下没有分类「${args.character}」。可选分类:${available.join('、') || '(暂无)'}`);
        }
        const worldContext = rpWorldContext(settings);
        const promptText = rpBuildPrompt({
          card: built.card,
          groupName: args.character,
          scene: args.scene || '',
          mode: 'single',
          worldContext
        });
        deferRoleplay(exec, promptText);
        return Promise.resolve({
          character: args.character,
          characterCard: built.card,
          scene: args.scene && String(args.scene).trim() !== '' ? args.scene : '(由最近的【场景】条目决定)',
          availableCharacters: available,
          prompt: promptText
        });
      },
      presentCall: (args) => ({ card: 'generic', title: `切换演绎角色·${args.character}`, kind: 'other', rawInput: args })
    })
  ];
}
