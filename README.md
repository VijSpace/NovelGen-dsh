# 📚 NovelGen-DSH — 小说管理插件 for DSH

在 DeepSeek Harness (DSH) 对话中创作与管理小说的插件：项目管理、章节写作、世界观设定、剧情演绎、自动备份。小说数据本地 JSON 落盘，AI 工具与 Web 视图共用同一份数据。

## 功能

- **对话即创作**：AI 在 DSH 对话中自动调用 `novel_*` 工具完成建项目/卷/章、写正文、维护设定、剧情演绎
- **Web 视图** `/novelgen`：目录树（设定/正文）+ 章节编辑器 + 设定管理器 + 导入导出 + 备份恢复
- **设定体系**：固定三级「分类组 → 分类 → 条目」，写作时自动注入 AI 上下文
- **剧情演绎**：从「角色设定」分类组选一个分类，该分类全部条目合成人设卡，AI 按互动叙事规则逐条推进
- **数据安全**：JSON 落盘 + WPS 原子写 + 自动版本快照（5 分钟节流 / 每类保留 20 份 / 一键恢复）
- **实时同步**：AI 写入内容自动刷新前端（2s 轮询），不打断用户编辑

## 安装

```bash
dsh plugin --profile web add file:/path/to/novelgen-dsh
```

> host 侧改动（工具/接口/store）需重启 `dsh web`；Web 视图静态文件刷新即生效；会话预设免重启。

## 快速开始

1. **对话里写作**：「新建一本《星际拾荒者》，写第一卷第一章」——AI 自动调用工具，写作前自动读取项目设定
2. **可视化视图** `/novelgen`：目录树 + 编辑器 + 设定管理 + 顶栏（更改目录/导入/导出/备份）
3. **剧情演绎**：「进入剧情演绎，扮演『主角团』这个分类」——该分类全部条目成为人设卡
4. **数据目录**：默认 `<dsh 启动目录>/novels`，可在 Web 里「更改目录」随时切换并持久化

## 工具清单（19 个）

| 工具 | 说明 |
|---|---|
| `novel_list_projects` / `novel_create_project` / `novel_rename_project` / `novel_delete_project` | 项目 CRUD |
| `novel_get_project` | 卷章结构 + 设定（可选含正文，每章截断 2 万字，输出卷/章 ID 便于定位） |
| `novel_create_volume` / `novel_rename_volume` / `novel_delete_volume` | 卷操作 |
| `novel_create_chapter` / `novel_rename_chapter` / `novel_delete_chapter` | 章操作 |
| `novel_write_chapter` | 写正文（replace / append / prepend，统计字数） |
| `novel_read_chapter` | 分页读正文（offset / limit 按字符） |
| `novel_get_settings` | 设定树：系统提示词 + 分类组 → 分类 → 条目 |
| `novel_update_setting` / `novel_delete_setting` / `novel_rename_setting` | 设定增删改 |
| `novel_roleplay_start` / `novel_roleplay_pick` | 剧情演绎：开始 / 切换演绎角色 |

> 卷/章支持按 ID 或标题定位（标题重名时报错提示用 ID）；设定快照经 `deferContext` 自动注入 AI 上下文（上限 2500 字）。

## 数据模型

```
novels/<项目ID>/
├── project.json    # 元数据
├── volumes.json    # 正文：卷 → 章 → 内容
├── settings.json   # 设定：settingTypes（分类组 → 分类 → 条目）
backups/<项目ID>/   # 自动版本快照（volumes-<ts>.json / settings-<ts>.json）
projects.order.json # 项目拖拽排序
```

- **设定固定三级**：分类组 → 分类 → 条目；分类必须归组（OneNote 式纪律），直挂条目自动收进「未整理」
- **写隔离**：改正文只写 volumes.json，改设定只写 settings.json
- **写保护**：WPS 风格原子写（备份 → 临时 → rename → 删备份），崩溃不损坏

## 架构

```
lib/
├── index.js    # 插件入口：注册工具 + /novelgen 路由 + ctx.novelgen 服务
├── store.js    # JSON store（动态数据根 / 原子写 / 自动备份 / 标题回退定位）
├── tools.js    # 19 个 novel_* 工具（defineTool + deferContext 注入）
└── routes.js   # node:http：静态页 + /novelgen/api
web/            # index.html + style.css + app.js（树/编辑器/设定/导入导出/备份）
test/           # 92 项单测（store/tools/routes/import-parse/schema-audit）
```

详见 [ARCHITECTURE.md](ARCHITECTURE.md)（模块组合逻辑 + 修改前检查清单）。

## 开发与测试

```bash
npm test            # 92 项单测
npm run test:apply  # 对已安装副本的 apply() 冒烟
```

- host 侧改动需重启 `dsh web`；Web 视图改动刷新即可
- 数据根配置：`DSH_NOVELGEN_ROOT` / profile patch / Web「更改目录」
- 其它插件可通过 `ctx.novelgen` 服务访问 store
