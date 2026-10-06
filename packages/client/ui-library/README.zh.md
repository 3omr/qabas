---
description: "Qabas 学习资料库：应用的主面板和侧边栏树，展示医学生的模块、讲座及其转写进度，并提供可扩展的操作和文件打开方式。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-library

[English](README.md) | 中文

## 概述

资料库是 Qabas 打开时的第一个界面：主面板展示学习工作区里的每个模块、每个模块的讲座以及每节讲座的进度，并提供推进讲座的操作。侧边栏中的树通向同样的页面。对话仍然一键可达，但它不再是第一个画面，这些页面也不需要通过对话来读取。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在浏览器插件列表中把它挂在 ui-layout 和 ui-sidebar 之后。它在布局的 `main` 插槽中注册 `library` 键、对应的 `sidebar.panellist` 行，并在 `sidebar.library` 中注册模块树。`startupPanel`（默认 `library`）决定应用打开时的面板；设为 `conversation` 则恢复原来的行为。

`jobConcurrency` 必须是正整数（默认 `2`）。启动中和等待回答的任务占用并发名额；额外任务按 FIFO 顺序启动。`ctx.libraryJobs.jobs` 按最新优先顺序提供任务，`answer`、`open`、`cancel` 和 `dismiss` 使用稳定的任务 id。任务记录持久化到 localStorage 的 `dsh.library.jobs` 键；重新加载后重新观察对话待答问题。中断的无会话运行恢复为已停止；Continue 从引擎保留的分段继续。会话任务通过 `sessions.watch` 保留对话事件源，不选中其会话；完成或运行器销毁时释放保留。任务可以在会话被选中之前提交和取消，观察 transcriber 工具进度，并回答与对话 composer 相同的待答问题。

四个页面：带模块进度与搜索的首页；带讲座操作、试卷管理和参考资料的模块页；带原话、草稿和最终文本记录文件的讲座页；以及可以返回模块的独立试卷页。

挂载的 transcriber Remote 提供全部七个注册表方法时，讲座管理器才会出现。适配器通过 Cordis effect 注册到 `library.provideEditing`，销毁时移除。学生可定义有序录音和资料、导入浏览器中选取的文件、重命名文件、移入回收站，并上传选定录音。清单路径保持模块相对形式；只有 `in_notebook: true` 才计为已存在于 NotebookLM，共享文件显示其首个所属讲座。引擎及传输失败转为页面错误；处理中的上传计为已发送，而引擎仍保留其就绪状态。加载讲座时保留手动定义 id、来源及资料名称。

各自 Remote 方法可用时，界面提供整理审阅、应用已审阅提案及本地考试索引操作。只有已完成的 `begin_lecture` 结果通过 `uploaded` 列出录音时，任务托盘才报告录音已上传。

对应 Remote 方法存在时，编辑数据 API 提供可选的 `hideLecture(module, title)` 与 `restoreRecordings(module, names)` 回调。两者返回 `EditOutcome<readonly string[]>`；成功结果包含已隐藏或实际恢复的录音名称。`ModuleFile.hidden` 标识保留的隐藏录音。[引擎可见性语义](../../api/transcriber-engine/README.zh.md#student-owned-lectures-and-files)定义列表与归属行为。调用方在编辑成功后重新加载相应模块。

设置数据 API 通过 `workspace()` 解析用户主目录下固定的 `Qabas Library`，首次使用时创建目录。不会向 Host 发送资料库文件夹选择。`LibrarySetup` 可选提供 `removeModule(module)`、`restoreModule(trashId)` 和 `listRemovedModules()`。其 `EditOutcome` 值按结果保留 `module`、`trashId`、`displayName`、`removedAt` 与 `notebookUntouched`。移除模块不会删除 NotebookLM 笔记本。模块修改成功后应重新加载整个资料库。

对应 Remote 存在时，`LectureEditing` 可选提供 `removeTranscript(module, title, kinds)`、`listTrash(module)` 和 `restoreTrash(module, id)`。均返回 `EditOutcome`；移除与恢复包含 `{ id, paths }`，列表包含 `{ id, removedAt, kind, label, paths }[]`。`kinds` 选择 `final`、`draft` 或 `verbatim`。[引擎回收站语义](../../api/transcriber-engine/README.zh.md#student-owned-lectures-and-files) 定义保留内容、锁拒绝与恢复冲突。编辑成功后调用方重新加载模块；适配器不添加控件。

流水线消息通过 `<step>:` 前缀标识当前步骤。托盘在准备、审阅与验证期间使用各自的步骤说明；只有明确的写作分段检查点显示分段计数。确定性流水线帧与 MCP 对话进度采用相同映射。引擎的固定备注会本地化，包括明确告知幻灯片图片未能准备好、转写中没有这些图片。

`jobFailureKind(message)` 优先于繁忙或不可用消息识别每日重置与模型额度耗尽诊断。`nextQuotaReset(now)` 以 `Date` 返回 `America/Los_Angeles` 的下一个午夜，包含夏令时变化；调用方按学生的本地时区显示该时刻。

### 扩展

`ctx.library` 是其他插件的接入点：

- `registerAction(action)` 在模块页或讲座页添加按钮。用已有 id 注册会替换原操作；本包自带的操作通过 `ctx.libraryJobs` 排队执行后台任务。
- `registerOpener(open)` 决定工作区文件在哪里打开。在注册之前，文件按钮处于禁用状态。
- `state` 是路由和工作区内容的快照存储，其他界面可以据此跟随学生正在看的内容。

组合 ui-tool 时，资料库通过 `ctx.toolTitles` 为其十九个转写 MCP 工具提供标题。对话行复用任务步骤词典，显示讲座参数或有效的 part/parts 参数对；清单路径与草稿内容保留在可展开的通用详情中。贡献遵循服务依赖生命周期，并使用当前语言，包括阿拉伯语语言包。

讲座操作（`transcribe`、`redo`、`continue`）调用流式 `runLecturePipeline` Remote。进度与修复步骤让托盘保持运行。定稿结果标记目标达成，并带着修复/省略备注结束；修复预算用尽不会把任务标为完成。断网、额度用尽、登录过期与缺少录音会以可恢复的原因停止；额度恢复时间使用学生本地时间。意外的引擎错误最多触发 `pipelineRetryLimit` 次自动保留内容重试（整数 0–10，默认 3），延迟从 `chatRepairCancelGraceMs`（默认 30000）开始指数增长：默认依次为 30、60、120 秒。重试次数与上限在重新加载后保留。进度说明当前步骤和重试次数。耗尽重试后任务以停止状态结束，带有 `stop.kind: retry-limit` 和固定备注 `Automatic retries stopped after repeated engine errors; your retained work is available through Continue.`。托盘通过 `job.noteLine.retryLimit` 翻译该备注，并在 `job.error` 详情中保留意外错误的原始文本。「重新转写」从头开始；自动重试使用「继续」保留新一轮的内容。重新加载后没有会话的讲座任务通过「继续」恢复。没有或无法使用 Remote 时改用 `transcriber` 对话；引擎可用时，验证发现留在引擎恢复中。旧版对话恢复会取消会话并等待其写入停止，再进行引擎补救；`chatRepairTimeoutMs` 默认 300000。取消会中止所属请求，释放时等待清理完成。题目与审计使用会话。恢复的讲座失败会自动继续，除非已定稿或因学生负责的原因停止。

`LibraryJob.progress` 公开运行中 transcriber 调用的 `{ done, total?, message? }`，并在每个投影进度检查点更新；结果或后续调用会清除它。成功的 transcriber 结果中带有 `[SOURCE-WARNING]` 的行会将这些警告持久化到 `note`，包括嵌套调用；任务完成或历史窗口裁剪后仍保留警告。讲座任务会话中成功的 finalize 持久化 `goalReached: true`；之后的模型失败保持 `status: done`，将诊断追加到 `note`，不设置 `error`。`jobFailureKind` 对禁止内容、安全过滤和提示被拦截的诊断返回 `blocked`；本地化文案通过 `job.error.blocked` 提供。

模块页始终提供“管理试卷”。每张原件卡片区分文本已提取和已纳入当前完整索引，并在已建立索引时显示解析题目数量。试卷面板支持拖入文件、搜索、同名处理选项、重命名、可恢复移除，以及逐文件准备与重试。其他试卷失败时，成功导入的文件保留。准备过程在索引前读取试卷；扫描文档可使用 OCR 或 agy 识读。生成的文本不显示在原件清单中。资料库首页可按名称或 id 筛选模块。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

引擎决定什么是一节讲座以及它进展到哪一步。服务通过一次无会话的 `listLibrary({ remote: 'cached' })` 调用读取整个工作区；缺少此方法时回退到 `listModules` 与逐模块 `listLectures`；对同一内容的新读取会取消旧读取，被取代或在销毁之后才到达的结果会被丢弃。讲座状态来自引擎的 `state` 字段；更早的引擎只报告 `transcribed`，会被读作已完成或未开始。

浏览器从按工作区命名的版本化存储立即恢复上次资料库快照，并标记为刷新中。存储无效或不可用不会阻止引擎读取；新结果会替换缓存工作区。打开已加载的模块不会再次读取。刷新按钮请求 `remote: 'refresh'`。学生编辑仅重新加载对应模块，NotebookLM 上传会强制刷新远端存在状态。题目索引状态及文件数来自整库响应。

颜色来自主题：每种讲座状态都有 ui-brand-qabas 提供的 `--qabas-state-*` 令牌，缺失时回退到基础主题的状态令牌。

</details>

**运行时不变量：** 不发布 companion。资料库 store 镜像引擎回复，没有可对照的第二个运行时来源；store 与任务的状态转换由行为 spec 断言。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [ui-brand-qabas](../ui-brand-qabas/README.zh.md) — 调色板，包括这些页面使用的讲座状态令牌。
- [ui-sidebar](../ui-sidebar/README.zh.md) — 模块树所在的 `sidebar.library` 插槽。
- [ui-layout](../ui-layout/README.zh.md) — `main` 插槽和面板选择。

-----

<a id="model-experience"></a>
## 模型体验

### 任务指令

#### 模型看到什么

讲座流水线不发起对话模型请求。会话回退、题目和审计在 `transcriber` preset 上创建隐藏会话，并发送一条用埃及阿拉伯语写成、点明模块和讲座的指令。引擎可用时，验证发现不会创建对话会话。

#### Token 影响

只有会话任务添加用户指令。确定性运行通过 agy 调用 writer，不添加对话 token。

#### KV Cache 影响

会话指令在提交时记录一次。流水线进度不添加对话历史或 KV 缓存条目。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 任务记录与并发控制仅在当前浏览器客户端本地生效。
- 在某个面板注册打开方式之前，文件无处打开。

-----

<a id="dev-note"></a>
### 开发备注

每个页面都是服务状态的纯函数，面板只负责路由。测试用固定的工作区驱动页面，用脚本化的引擎驱动服务。
