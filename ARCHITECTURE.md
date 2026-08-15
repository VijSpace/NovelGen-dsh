# NovelGen-DSH (novelgen-dsh) · 架构地图

> **每次修改代码前,先回到本图过一遍"模块组合逻辑",再动手。**
> 修改原则:任何改动必须符合"数据真相归属"规则(见 §5),否则会引入"改了这个那个又出问题"的连锁 bug。

---

## 1. 分层总览

```
┌────────────────────────────────────────────────────────────┐
│                    DSH Host(宿主进程)                       │
│                                                            │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────────┐ │
│  │  lib/store   │   │ lib/routes   │   │ lib/tools      │ │
│  │  数据层(唯一  │◄──┤ API 层(HTTP) │   │ AI 工具层      │ │
│  │  落盘真相)    │   │ /novelgen/api│   │ novel_*(19个)  │ │
│  └──────┬───────┘   └──────┬───────┘   └───────┬────────┘ │
│         │   同一 store 实例(闭包共享)            │          │
│         └──────────────┬───────────────────────┘          │
│                        ▼                                  │
│              D:/novelgen/novels(数据目录)                   │
│              <项目ID>/project.json + volumes.json          │
│              <项目ID>/settings.json                        │
│              backups/<项目ID>/版本快照                      │
│              projects.order.json(项目排序)                 │
└────────────────────────────────────────────────────────────┘
                          │ GET/PUT/PATCH(HTTP)
                          ▼
┌────────────────────────────────────────────────────────────┐
│              web 前端(浏览器 /novelgen)                     │
│  app.js: 状态 + 渲染 + 编辑 + 保存 + 轮询 + 撤销/重做        │
└────────────────────────────────────────────────────────────┘
```

**组合关系**:
- `store` 是**唯一数据真相**(落盘);`routes` 和 `tools` 都只调 store,不直接碰文件
- `routes` 服务 web 前端;`tools` 服务 DSH 对话中的 AI —— **两条消费通道,同一份数据**
- 前端缓存(`state.current`)是**展示层快照**,不是真相;DOM 是**编辑中的真相**

---

## 2. store 数据层模块(map)

| 模块 | 职责 | 关键函数 | 组合约束 |
|---|---|---|---|
| 读写 | 项目/卷/章/设定 的持久化 | `readProject`/`saveVolumes`/`saveSettingsFile`/`atomicWrite` | 每个项目独立目录;写前自动版本快照(`snapshotBeforeWrite`) |
| 项目 CRUD | 增删改查/排序 | `createProject`/`deleteProject`/`orderProjects`/`listProjects` | 排序持久化到 `projects.order.json`;删除项目**不删备份** |
| 卷/章 | 卷章结构 + 正文 | `addVolume`/`findVolume`/`findChapter`/`writeChapter`/`readChapter` | **ID 精确匹配,找不到回退标题匹配**(重名报错);`writeChapter` 支持 replace/append/prepend |
| 设定 | 分类组→分类→条目 | `updateSetting`/`deleteSetting`/`renameSetting`/`getSettings` | 固定模型:分类必须在分类组里;直挂条目自愈进「未整理」 |
| 归一化 | 物理↔逻辑视图 | `toNormalized`/`fromNormalized`/`withExtra`/`legacyToNormalized` | **withExtra 保留 UI 元数据(`_height` 等)**,双向不丢 |
| 备份 | 版本快照 | `snapshotBeforeWrite`/`listBackups`/`restoreBackup` | 5 分钟节流;每类保留 20 份;恢复前自动快照当前版本 |

**组合约束**:`saveVolumes`/`saveSettingsFile` 写前必调 `snapshotBeforeWrite`(先快照旧文件,再写新文件)。

---

## 3. API 层(routes.js)模块

| 端点 | 方法 | 对应 store | 备注 |
|---|---|---|---|
| `/projects` | GET/POST | `listProjects`/`createProject` | |
| `/projects/order` | PUT | `orderProjects` | body `{ids}` |
| `/projects/:id` | GET/PATCH/DELETE | `getProject`/`renameProject`/`deleteProject` | GET 返回**含 settings(逻辑视图)** |
| `/projects/:id/backups` | GET | `listBackups` | |
| `/projects/:id/backups/restore` | POST | `restoreBackup` | body `{ts}` |
| `/projects/:id/restore` | POST | `restoreProject` | 撤销/重做用 |
| `/projects/:id/volumes[/:vid][/chapters[/:cid]]` | POST/PATCH/DELETE | 卷章 CRUD | |
| `/projects/:id/settings` | PUT/PATCH | `saveSettings`(整份)/`updateSetting`(单条) | **无 GET**(settings 随项目 GET) |
| `/config` | GET/PUT | `getRoot`/`setRoot` | 切换数据目录 |
| `/health` | GET | — | |

**组合约束**:所有路径参数 `decodeURIComponent`;错误码按消息匹配 404(`/不存在|未找到/`)。

---

## 4. web 前端模块(app.js) —— 组合逻辑核心

### 4.1 状态对象(state)字段 → 归属

| 字段 | 归属 | 谁写 | 谁读 |
|---|---|---|---|
| `state.current` | **展示层快照** | `openProject`/`syncFromServer`/flush 同步 | 渲染、收集基准 |
| `state.currentChapter` | 当前编辑章指针 | `openChapter`/轮询 | `renderEditor` |
| `state.pendingCategories` | 设定**未保存暂存** | `stashSettings`/编辑 | `currentSettingsFromDom` 合并 |
| `state.pendingSystemPrompt` | 系统提示词暂存 | `stashSettings` | 同上 |
| `state.pendingServerSettings` | 轮询期间 AI 写入的设定 | `syncFromServer` | `openSettings` 载入 |
| `_dirty` | 正文未保存标记 | `markDirty` | flush/切走 |
| `_settingsDirty` | 设定未保存标记 | `markSettingsDirty` | flush/切走 |
| `hist` | 撤销/重做栈 | `pushHistory`/`commitHistory` | `undoRedo` |

### 4.2 数据真相归属(核心规则!)

```
正文模块:  DOM(chContent) = 唯一真相
  编辑 → _dirty → flushChapterAutoSave → PATCH → 同步 state.current.volumes
  渲染:renderEditor 从 state.current 读(需先同步)

设定模块:  DOM(settingsBox 条目) = 唯一真相(编辑中)
  编辑/缩放 → _settingsDirty → flushSettingsAutoSave → PUT 整份 → 同步 state.current.settings
  渲染:renderMemberDetail 从 state.current 读
  ⚠ pendingCategories 只是"切走不丢"的兜底,保存后必须清空(否则覆盖新数据)

轮询(syncFromServer): 每 2s 比对 updated
  正文视图: 整体替换 state.current → 用户未编辑时 renderEditor 刷新
  设定视图: 不重绘面板(DOM 是真相)→ 存 pendingServerSettings → 切走/重开时载入
  ⚠ 用户自动保存也会更新 updated → flush 后必须同步 state.current.updated(避免误判)
```

### 4.3 模块组合关系

| 动作 | 模块调用链 | 必须遵守 |
|---|---|---|
| 打开项目 | `openProject` → flushChapter → GET → 清暂存 → 渲染 → `startPolling` | 切换项目清空 pending/历史 |
| 编辑正文 | DOM → `markDirty` | — |
| 保存正文 | `flushChapterAutoSave` → PATCH → 同步内存章节+updated | 切章/切项目/切设定前必须 await |
| 编辑设定 | DOM → `markSettingsDirty`(输入/缩放/增删移) | **点击型操作必须显式置脏** |
| 保存设定 | `flushSettingsAutoSave` → PUT → 同步内存+updated → **清空 pending** | 整份持久化 |
| 拖拽排序 | `performDrop` → **flush 未保存 → GET 服务端最新 → 操作 → putSettings** | 结构操作基于服务端数据,不用编辑态 |
| AI 写入 | 服务端 updated 变化 → 轮询检测 → 按视图分支处理 | 设定视图不重绘 |
| 撤销/重做 | `undoRedo` → restore → openProject(保留历史) → 清暂存 | 恢复后必须清 pending |

---

## 5. 修改前检查清单(每次必过)

改任何一处之前,对照本图问:

1. **改的是哪个真相源?** DOM(编辑)/ state.current(快照)/ 服务端(落盘)——三者的同步链条是否完整?
2. **这条链路上有谁还会触发?** 轮询(2s)/ 自动保存(1.5s+30s)/ 切走(await flush)/ 撤销(restore)——是否会被另一个模块用旧数据覆盖?
3. **设定改动后 pendingCategories 是否清理?** 保存成功后必须清空,否则下次合并用旧快照覆盖新数据
4. **updated 是否同步?** 任何写操作后 `state.current.updated` 必须等于服务端,否则轮询误判
5. **结构操作是否基于服务端最新?** 拖拽/增删分类 → 先 flush → GET 最新 → 操作(不要用 currentSettingsFromDom 的合并结果)
6. **改完是否回归三场景?** ①AI 写正文实时显示 ②AI 写设定切走可见 ③用户编辑中轮询不打断

---

## 6. 已知架构决策(勿随意推翻)

- 设定固定模型:分类组 → 分类 → 条目;分类必须在分类组里
- 条目 `_height` 是 UI 元数据,经 `withExtra` 随设定持久化
- 卷/章支持标题回退定位(兼容旧数据无 ID 场景)
- 项目排序持久化 `projects.order.json`;删除项目保留备份
- 备份:5 分钟节流、每类 20 份、恢复前自动快照
- web 前端改动即时生效(带 ?v=8 防缓存);store/routes/tools 改动需重启 dsh web
