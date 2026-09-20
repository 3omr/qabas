---
description: "用于在长时间运行前检查转写引擎外部工具的 Host 与 Client 能力，包含可选的可用性探测和按平台提供的安装指引。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-transcriber-engine

[English](README.md) | 中文

## 概述

使用本包可在长时间运行之前检查转写引擎能否启动、连接 NotebookLM，并列出模块的本地与 NotebookLM 讲座。本包也拥有桌面文件拖放所使用的 Host 复制操作。存在性检查成本低；实时检查会运行引擎声明的探测，包括 NotebookLM 认证探测。即使必需工具缺失或不健康，包仍会返回有效报告，因此 Settings 页面可以说明修复方式。本包拥有这些引擎操作使用的 Remote 命名空间。

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

把本包挂载在包含 subprocess provider 和 API Remote assembly 的 Host 组合中；Web bundle 已经为它提供条目。

### 引擎位置

从 `TRANSCRIBER_SKILL_ROOT` 解析 launcher；未设置时回落到 `<cwd>/skills/universal-transcriber`。doctor 使用 `TRANSCRIBER_WORKSPACE` 作为工作目录和 `--workspace` 值；未设置时回落到 Host cwd。launcher 或 workspace 缺失时返回可操作的 `transcriber-engine/not-found` 错误，并指出要修复的设置。

### Doctor 结果

`transcriberEngine/doctor` Remote 接受 `{ live: false }` 进行仅存在性检查，接受 `{ live: true }` 运行较慢的探测。结果把引擎的 `ok` 与 `exit_code` 字段作为数据保留。每项 dependency 都报告用途、是否必需、解析结果、探测结果、失败提示和一个按平台决定的 `install_command`。

最后的 `AbortSignal` 属于 Remote 调用。它会传递给子进程 provider，并在页面或连接释放时终止 doctor。可执行文件缺失、进程启动失败、调用取消或 JSON 无效会拒绝；有效但非零的 doctor 报告不会拒绝。

### NotebookLM 认证

`transcriberEngine/auth` 流会启动桌面宿主中由 PTY 承载的 `nlm auth` 命令，并传出它的 notice 和检测到的 prompt。`answerAuth` 向等待中的进程发送一行文字，`cancelAuth` 终止它。只有同一个实时 doctor 看到 `dependencies[name === 'nlm'].probe.passed === true` 时，流才报告 `authorized`；它不使用 auth 进程的退出码。原生 PTY 不可用或启动失败时，会用可操作的 `nlm auth` 回退让 Settings 页面显示。

### 讲座列表

`transcriberEngine/listLectures` Remote 为一个模块启动一次引擎 MCP server。结果把本地录音与 NotebookLM 录音合并，把仅存在于 NotebookLM 的行标记为 `in_notebook_only`，并让这些行的 `paths` 为空。NotebookLM 失败时，失败信息放在同一份列表的 `warning` 中返回，因此浏览器可以保留磁盘视图并显示直白说明。调用只执行一次，取消会传递到子进程。

### 导入拖放文件

`transcriberEngine/importFiles` Remote 接收模块 id、`Lecture` 或 `Questions`，以及绝对源路径。它通过模块目录布局解析目标文件夹，拒绝越出工作区的模块或目标，并逐个复制被接受的源文件，不移动原文件。`Lecture` 接受共享的录音、幻灯片和文档格式；`Questions` 接受共享的文档和幻灯片格式。目标中已有的同名文件会被拒绝，不会重命名或覆盖。结果报告每个已归档目标和每个被拒绝源文件，因此同一次拖放中的不支持文件不会阻止其他文件落盘。取消会在解析目录前及逐个文件之间检查。

### 最小组合

```yaml
- id: transcriber-engine
  name: '@deepseek-ai/dsh-api-transcriber-engine'
```

生成的[配置目录](../../../docs/config-catalog.zh.md)不包含本包设置；两个 `TRANSCRIBER_*` 环境输入与 MCP 注册使用同一套引擎集成约定。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

`TranscriberEngine` 拥有一个 Remote 命名空间，并把 doctor 与讲座列表调用交给 `ctx.subprocess`；导入方法只在解析出模块内部目标后使用 Host 文件系统。认证流使用可选的原生桌面 PTY adapter；`auth.ts` 负责 frame 呈现、prompt 检测和基于 probe 的成功判定。`doctor.ts` 在一个函数中构建当前的 `python3` 加脚本 argv；runner 限制收集的输出，把取消传给 provider，并在进程边界校验完整的引擎答案。Client entry 通过 `ctx.transcriberEngine` 提供同一命名空间，因此 UI consumer 不必直接访问原始 Remote 对象。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host service 与 `transcriberEngine` Remote 方法 |
| [`src/doctor.ts`](src/doctor.ts) | 引擎路径解析、命令构建、subprocess 生命周期与 JSON 校验 |
| [`src/auth.ts`](src/auth.ts) | PTY 对话 frame 与 NotebookLM probe 判定 |
| [`src/lectures.ts`](src/lectures.ts) | MCP 请求、列表校验、warning 转换与 subprocess 生命周期 |
| [`src/import.ts`](src/import.ts) | 模块内部目标解析、格式接收、冲突拒绝、复制及混合结果 |
| [`src/types.ts`](src/types.ts) | 线路报告类型与 Remote 错误 details |
| [`src/client/index.ts`](src/client/index.ts) | 基于 `remote.transcriberEngine` 的 Client provider |
| — | 不发布运行时 invariant 伴生件；每次 doctor 调用都返回一个子进程报告，本能力不拥有独立事件流或可变投影。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Remote 组合](../remotes/README.zh.md)——选择的命名空间挂载，使浏览器可以触达 Host service。
- [Subprocess 能力](../../subprocess/subprocess/README.zh.md)——进程解析、收集输出与取消所有权。
- [转写引擎 Settings 页面](../../client/ui-settings-transcriber-engine/README.zh.md)——三状态的就绪呈现。

-----

<a id="model-experience"></a>
## 模型体验

无，本包不注册工具、提示词章节或会话事件。

#### KV Cache 影响

无；就绪检查不会组装或发送模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **当前 launcher 形式**——本包以 `python3` 和 `run_transcription.py` 调用；冻结引擎二进制的 argv 约定尚不存在，因此暂不支持。
- **原生认证验证**——PTY 启动和真实 Google 登录需要在每个目标桌面上手动验证；自动化测试使用 fake terminal 和录制的 doctor 报告。
- **一次性引擎调用**——每次 doctor 或讲座列表都会启动新进程；导入是 Host 直接复制，浏览器负责显示时的刷新策略，本包不提供服务端缓存。
- **探测计时由引擎拥有**——实时探测的期限仍在引擎中；取消可以停止进程，但不会缩短一个正常运行的探测。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

包名描述的是可扩展的引擎能力，而不是首个 `doctor` 方法，因此后续的 dropped-recording 导入和运行进度方法可以复用同一套 Remote 与 Client provider wiring。

</details>
