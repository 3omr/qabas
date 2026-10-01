---
description: "Qabas 学习资料库：应用的主面板和侧边栏树，展示医学生的模块、讲座及其转写进度，并提供可扩展的操作和文件打开方式。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-library

[English](README.md) | 中文

## 概要

资料库是 Qabas 打开时的第一个界面：主面板展示学习工作区里的每个模块、每个模块的讲座以及每节讲座的进度，并提供推进讲座的操作。侧边栏中的树通向同样的页面。对话仍然一键可达，但它不再是第一个画面，这些页面也不需要通过对话来读取。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发笔记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在浏览器插件列表中把它挂在 ui-layout 和 ui-sidebar 之后。它在布局的 `main` 插槽中注册 `library` 键、对应的 `sidebar.panellist` 行，并在 `sidebar.library` 中注册模块树。`startupPanel`（默认 `library`）决定应用打开时的面板；设为 `conversation` 则恢复原来的行为。

`jobConcurrency` 必须是正整数（默认 `2`）。启动中和等待回答的任务占用并发名额；额外任务按 FIFO 顺序启动。`ctx.libraryJobs.jobs` 按最新优先顺序提供任务，`answer`、`open`、`cancel` 和 `dismiss` 使用稳定的任务 id。任务记录持久化到 localStorage 的 `dsh.library.jobs` 键；重新加载后重新观察实时待答问题。任务通过 `sessions.watch` 保留对话事件源，不选中其会话；完成或运行器销毁时释放保留。

三个页面：首页（每个模块一张带进度的卡片，以及"等你处理"——未完成的草稿、有讲座尚未开始的模块、没有响应的 NotebookLM），模块页（按状态筛选的讲座，每节讲座附下一步操作，以及模块的参考资料），讲座页（三步进度——医生的原话、草稿、转写稿——以及操作和已生成的文件）。

### 扩展

`ctx.library` 是其他插件的接入点：

- `registerAction(action)` 在模块页或讲座页添加按钮。用已有 id 注册会替换原操作；本包自带的操作通过 `ctx.libraryJobs` 在 `transcriber` 预设上排队执行后台任务。
- `registerOpener(open)` 决定工作区文件在哪里打开。在注册之前，文件按钮处于禁用状态。
- `state` 是路由和工作区内容的快照存储，其他界面可以据此跟随学生正在看的内容。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

引擎决定什么是一节讲座以及它进展到哪一步。服务通过无会话的 transcriber-engine Remote 读取 `list_modules` 和 `list_lectures`；对同一内容的新读取会取消旧读取，被取代或在销毁之后才到达的结果会被丢弃。讲座状态来自引擎的 `state` 字段；更早的引擎只报告 `transcribed`，会被读作已完成或未开始。

首页会读取每个模块以便卡片显示进度；其他页面在模块首次打开时读取。刷新期间，上一次的结果会继续显示，直到新结果到达。

颜色来自主题：每种讲座状态都有 ui-brand-qabas 提供的 `--qabas-state-*` 令牌，缺失时回退到基础主题的状态令牌。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [ui-brand-qabas](../ui-brand-qabas/README.zh.md) — 调色板，包括这些页面使用的讲座状态令牌。
- [ui-sidebar](../ui-sidebar/README.zh.md) — 模块树所在的 `sidebar.library` 插槽。
- [ui-layout](../ui-layout/README.zh.md) — `main` 插槽和面板选择。

-----

<a id="model-experience"></a>
## 模型体验

这些页面不发起任何模型请求。任务操作会在 `transcriber` 预设上新建隐藏会话，并发送一句埃及阿拉伯语句子，按引擎列出的原样写出模块和讲座名称。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

任务记录与并发控制仅在当前浏览器客户端本地生效。在某个面板注册打开方式之前，文件无处打开。

-----

<a id="dev-note"></a>
### 开发笔记

每个页面都是服务状态的纯函数，面板只负责路由。测试用固定的工作区驱动页面，用脚本化的引擎驱动服务。
