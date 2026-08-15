# 📚 novelgen-dsh — NovelGen 的 DSH 插件版

把 [NovelGen](https://github.com/) 的 AI 小说创作能力做成了 DeepSeek Harness 插件:
- **模型侧工具**:AI 在对话中可直接创建项目/卷/章、写正文、维护设定(**17 个 `novel_*` 工具**)
- **Web 视图**:`http://127.0.0.1:3080/novelgen` —— 目录树(设定/正文)+ 章节编辑器 + 设定管理器(首页索引/分类详情)+ 导入导出
- **同一份数据**:工具、视图、AI 共用同一 store,JSON 落盘,原子写 + 备份保护
- **会话预设**:「📚 小说写作」轻量组合(关掉开发工具),+ 独立 novelgen profile

---

## 当前状态(功能总览,2026-08 快照)

| 能力 | 状态 |
|---|---|
| 17 个 novel_* 工具(项目/卷/章/正文/设定) | ✅ 完成,55 项单测全绿 |
| 设定:固定三级 分类组 → 分类 → 条目(分类必须归组)+ 旧数据自动归组 | ✅ 完成 |
| 设定自动注入 AI 上下文(deferContext) | ✅ 完成 |
| Web 视图:目录树「设定 / 正文」两大入口 | ✅ 完成 |
| UI:日间模式配色 + 排版参照原 Electron 版(暖纸白 / 暖红强调 / 衬线正文) | ✅ 完成 |
| 设定视图:首页分类组索引 + 详情(点选只显示该分类组/分类) | ✅ 完成 |
| 数据目录自定义工作区(Web 里改,持久化) | ✅ 完成 |
| 导入 CSV/TXT/XLSX、导出 TXT/XLSX | ✅ 完成 |
| 侧边栏「小说」按钮 | ✅ 完成(client bundle) |
| 会话预设 novel-writer(轻量写作模式) | ✅ 完成 |
| novelgen profile 模板 | ✅ 完成 |
| 4 个项目数据迁移(完美世界/地球往事/星途/时间之外) | ✅ 完成 |
| 撤销/重做 | ❌ 待做 |

## 安装(已在本机完成)

```bash
dsh plugin --profile web add file:D:/novelgen/dsh-plugin/novelgen-dsh
```

> 已安装:见 `C:\Users\A\.dsh\profiles\web\package.json` 的 `dsh.profile.bundles`。
> ⚠️ **host 侧改动(工具/接口/store)需重启 dsh web 生效**;web 视图静态文件实时生效;
> 会话预设免重启(刷新页面即见)。

## 插件集与组合模板

完整配方见 `dsh-plugin/RECIPES.md`:

- **会话预设「📚 小说写作」**:`dsh-plugin/templates/install.mjs preset` → `$DSH_HOME/.agent-presets/novel-writer/`
  (**轻量组合**:小说人设 + 上下文压缩 + ask-user + todo,**不含** shell/fs/skills/子代理/workflow 等开发工具)
- **novelgen profile 模板**:`dsh-plugin/templates/install.mjs profile` → `$DSH_HOME/profiles/novelgen/`
  (base+web-app+novelgen,默认预设 = novel-writer,数据目录固定,已装好插件;`dsh --profile novelgen --port 3081` 启动)

## 怎么用

1. **对话里写作**:「新建一本《XX》,写第一卷第一章」→ AI 自动调工具;写作前会自动读到项目设定
2. **可视化视图** `/novelgen`:
   - **目录树**:顶层「设定」「正文」两个入口;「设定」行右侧「＋分类」「＋组」,「正文」行右侧「＋卷」新建卷
   - **设定树**:独立分类显示为叶子(点击进详情编辑条目);「分类组」可展开显示其成员分类;分类行悬停可「打包」进分类组,组内分类可「移出」;分类组行「＋分类」新增成员
   - **设定首页**:点「设定」入口 → 系统提示词 + 分类/分类组索引(打开/重命名/删除)
   - 点章 → 章节编辑器(Ctrl+S 保存)
   - 顶栏:更改目录 / 导入 / 导出 / 新建项目
   - 侧边栏底部「小说」按钮一键打开(需重启后 client bundle 生效)
3. **数据目录**:默认 `<dsh 启动目录>/novels`,可在 Web 里「更改目录」随时切换并持久化
4. **数据迁移**:`node dsh-plugin/migrate.mjs`(把 Electron 版 `%APPDATA%/novelgen/projects` 或自定义 dataPath 的项目拷到 novels/)

## 工具清单(17 个)

| 工具 | 说明 |
|---|---|
| `novel_list_projects` | 列出全部项目(卷/章/字数) |
| `novel_create_project` / `novel_rename_project` / `novel_delete_project` | 项目 CRUD |
| `novel_get_project` | 卷章结构 + 设定(可选含正文,每章截断 2 万字) |
| `novel_create_volume` / `novel_rename_volume` / `novel_delete_volume` | 卷操作 |
| `novel_create_chapter` / `novel_rename_chapter` / `novel_delete_chapter` | 章操作 |
| `novel_write_chapter` | 写正文(`replace`/`append`/`prepend`,统计字数) |
| `novel_read_chapter` | 分页读正文(offset/limit 按字符) |
| `novel_get_settings` | 设定树:系统提示词 + 分类(→ 条目);分类组打包展示 |
| `novel_update_setting` | 新增/更新条目:category=分类名或分类组名,group=组内分类名(可选),缺层自动创建 |
| `novel_delete_setting` | 删条目 / 组内分类 / 分类或分类组 |
| `novel_rename_setting` | 重命名分类 / 分类组 / 组内分类 / 条目 |

> **设定自动读入**:每个项目级工具调用时,把设定快照(系统提示词 + 分类树条目清单)
> 经 `deferContext` 注入 AI 下一轮上下文(上限 2500 字,超出用 `novel_get_settings` 读全文)。

## 数据模型

### 文件布局(正文 / 设定分文件,2026-08 起)

```
novels/<项目ID>/
├── project.json    # 元数据:id/name/created/updated/schemaVersion(极小)
├── volumes.json    # 正文:{ volumes: [{ id, title, order, chapters[] }] }
│                       chapters[]: { id, title, content, wordCount, status, order, updated }
└── settings.json   # 设定:{ settings: { systemPrompt, settingTypes[] } }
```

- **旧单文件布局**(全部塞在 project.json,与 Electron 版一致)读取时自动回退兼容;
  **首次任意写入自动拆分**为三文件(project.json 只留元数据)—— 已迁移的 4 个项目已拆好
- **写隔离**:改正文只写 volumes.json,改设定只写 settings.json,互不整份重写
- **写保护**:每个文件 WPS 风格原子写(备份→临时→rename→删备份),崩溃不损坏

### 设定(固定模型:分类组 → 分类 → 条目)

- **固定三级结构,分类必须在分类组里**(OneNote 式纪律,无独立分类):
  `categories[]` = **分类组**(如 世界观/分卷架构),`groups[]` = **分类**(如 新伊甸/分卷架构一),分类下才是**条目**
- **自愈兼容**:直挂条目的旧数据(老分类/旧槽位)读写时自动收进「未整理」分类组;已迁移的 4 个项目已按前缀自动归组
- **逻辑视图**:`{ systemPrompt, categories: [{ id, name, groups: [{id,name,entries:[{id,name,content}]}] }] }`
- **物理存储**(统一 `settingTypes`):`settings.settingTypes[]: { id, name, groups: [{id,name,entries:[{id,name,description}]}] }` — 有 `groups` 键(即使为空)按分类组存,空组身份不丢
- **旧槽位迁移**:`overall/characters/customSettings/volumeArchitecture` 读取时自动映射成
  分类组(总体设定/角色/自定义设定/分卷架构),首次写入时迁移为 settingTypes

## 数据目录(自定义工作区)

优先级:`持久化文件($DSH_HOME/novelgen.data-root,Web 里改)` > `DSH_NOVELGEN_ROOT` >
profile patch `novelgen.config.root` > `<宿主进程 cwd>/novels`。

- Web 顶栏「更改目录」→ `PUT /novelgen/api/config` → 立即切换 + 持久化
- 运行时接口:`ctx.novelgen.setRoot(path)` / `GET /novelgen/api/config`
- 迁移:数据根换目录后,用 `migrate.mjs` 把项目拷过去(或直接改指针)

## 架构

```
dsh-plugin/
├── novelgen-dsh/                 # 插件包(已安装到 web profile)
│   ├── package.json              # dsh.bundle.patch → cordis.patch.yml;dsh.client → 侧边栏
│   ├── cordis.patch.yml          # 插入 loader 行:novelgen → novelgen-dsh
│   ├── lib/
│   │   ├── index.js              # 入口:注册工具 + /novelgen 路由 + ctx.novelgen 服务 + setRoot
│   │   ├── store.js              # JSON store(动态 root / 分类→条目+分类组设定 / 原子写)
│   │   ├── tools.js              # 17 个 novel_* 工具(defineTool + deferContext 注入)
│   │   ├── routes.js             # node:http:静态页 + /novelgen/api(含 /config)
│   │   └── client.js             # 侧边栏「小说」按钮 bundle(浏览器端)
│   ├── web/                      # index.html + style.css + app.js(目录树/编辑器/设定/导入导出)
│   ├── test/                     # store(13) + tools(29) + routes(6) + import-parse(5) = 53 项
│   └── README.md
├── templates/install.mjs         # 预设 + profile 模板安装器
├── presets/novel-writer/         # 轻量写作预设模板(agent.cordis.yml + preset.yml)
├── migrate.mjs                   # Electron 数据迁移(注意:勿用 fs.cpSync 递归复制中文路径,会原生崩溃)
└── RECIPES.md                    # 组合配方(写作/开发模式、数据目录、卸载)
```

## 开发与测试

```bash
cd dsh-plugin/novelgen-dsh
npm test                    # 53 项单测(store/tools/routes/import-parse)
npm run test:apply          # 对已安装副本的 apply() 冒烟(17 工具 + 路由 + 服务)
```

- 改源码后同步安装副本:`Copy-Item`(不要用 fs.cpSync 递归复制中文路径——Node 24 原生崩溃)
- host 侧改动需重启 dsh web;web 视图改动刷新即可;预设改动免重启

## 配置

- `DSH_NOVELGEN_ROOT` / profile patch `novelgen.config.root` / Web「更改目录」均可设数据根
- 其它插件可通过 `ctx.novelgen` 服务:`getRoot / setRoot / listProjects / createProject / getProject`

## 与原 Electron 版的差异

| 能力 | Electron 版 | DSH 插件版 |
|---|---|---|
| AI 对话 | 自研 function-calling 状态机 | DSH agent 原生多轮工具调用 + 设定自动注入 |
| 数据存储 | `%APPDATA%/novelgen/projects/<id>/project.json` | `<数据根>/<id>/project.json`(同结构,可迁移) |
| 设定模型 | 固定槽位 | 分类 → 条目 + 分类组打包(全自定义命名)+ 旧槽位自动迁移 |
| 编辑器 | 内置界面 | `/novelgen` 目录树 + 设定(首页/分类详情)+ 章节编辑器 |
| Excel 导入导出 | ✅ | ✅ CSV/TXT 离线 + XLSX(联网 SheetJS) |
| 撤销重做 | ✅ | 待做 |
