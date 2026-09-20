---
description: "供 Sidebar 面板与 composer 选择条共同使用的转写工作区模块读取与讲座分类库。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-transcriber-workspace

[English](README.md) | 中文

## 概述

浏览器消费者可以通过同一个实现读取转写工作区的模块发现、讲座分组、转写匹配与缓存运行折叠。Sidebar 面板与 composer 选择条共同使用这个库，因此它们提供相同的讲座。这个库只使用传入的 workspace-files Remote 读取文件，不会启动运行，也不会写入文件。

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

根入口导出 `createReadModules`、`lecturesOf`、`groupRecordings`、转写匹配、运行折叠及相关类型。把 Session 的 `workspaceFiles.list` 与 `workspaceFiles.read` 面传给 `createReadModules`；成功结果包含 Sidebar 面板使用的同一模块与讲座视图，而 Remote 失败会作为失败结果保留给调用方显示。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

读取器识别引擎的 `modules/<id>/module.json`、`Lecture/`、`Transcripts/` 与运行缓存布局。`lectures.ts` 把分段录音合并并标记转写匹配；`runs.ts` 折叠最新的追加式运行；`workspace.ts` 通过有界的 Remote 文件服务读取两类视图。讲座分组 fixture 仍与转写面板测试及 Python 引擎用例共享。

</details>

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

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
