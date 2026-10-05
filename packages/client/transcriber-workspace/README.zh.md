---
description: "供 Sidebar 面板与 composer 选择条共同使用的转写工作区模块读取与讲座分类库。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-transcriber-workspace

[English](README.md) | 中文

## 概述

浏览器消费者可以通过同一个实现读取转写工作区的模块发现、讲座分组、转写匹配、缓存运行折叠与 NotebookLM 合并。Sidebar 面板与 composer 选择条共同使用这个库，因此它们提供相同的讲座。它先发布磁盘部分；引擎列表成功时由引擎行作为讲座清单并保留本地 source，引擎不可用时回退到磁盘分类；它不会启动运行，也不会写入文件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时使用

当浏览器表面需要转写工作区的模块或讲座时使用这个库。使用所属 UI 插件负责渲染和用户动作；这个包提供共享的读取与分类函数。

### 入口

根入口导出 `createReadModules`、`lecturesOf`、`groupRecordings`、转写匹配、运行折叠及相关类型。把 Session 的 `workspaceFiles` 面和可选的 `transcriberEngine.listLectures` 面传给 `createReadModules`。`onDisk` 回调会收到立即可用的磁盘视图，返回结果包含 NotebookLM 合并；运行进度 tick 使用 `includeNotebook: false`，并传入 `previous` 保留仅存在于远程的行。warning 会变成模块视图上的 NotebookLM 失败状态，同时保留可用的模块数据。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

读取器识别引擎的 `modules/<id>/module.json`、`Lecture/`、`Transcripts/`、`Questions/exam-index.json` 与运行缓存布局。`lectures.ts` 合并分段录音、应用共享的标题规范化规则，并重新导出共享的转写格式事实；`runs.ts` 折叠最新的追加式运行；`workspace.ts` 通过有界的 Remote 文件服务读取磁盘视图，成功时以引擎列表作为清单并附加匹配的本地 source。没有本地 source 的讲座使用空的 `sources` 数组，因此不会被提供为文件操作。

Python 引擎测试套件与浏览器分类测试套件共享唯一的[讲座分组用例文件](../../../engine/references/lecture-grouping-cases.json)，其中包括男生／女生班别与多段录音顺序。

</details>

**运行时不变量：** 不发布 companion。工作区辅助函数是作用于引擎回复的纯函数，没有可对照的第二个运行时来源；由行为 spec 断言。

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-transcriber](../ui-transcriber/README.zh.md)——在 Sidebar 中显示模块、讲座状态与运行进度。
- [ui-transcriber-composer](../ui-transcriber-composer/README.zh.md)——在 composer 上方显示选择，并把阿拉伯语请求写入草稿。
- [Workspace file Remote](../../api/workspace-files/README.zh.md)——提供本包消费的只读文件面。

-----

<a id="model-experience"></a>
## 模型体验

无。本库只读取浏览器工作区数据，不组装或发送模型请求。

#### KV Cache 影响

无；本库不发起 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **工作区约定**——读取器遵循引擎固定的目录名称，不接受可配置的布局。
- **NotebookLM 新鲜度**——远程库存只在初次加载或显式刷新时执行一次；运行进度轮询只读磁盘，列表变慢或失败时仍显示磁盘视图并给出状态说明。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
