---
description: "用于在长时间运行前检查转写引擎外部工具的 Host 与 Client 能力，包含可选的可用性探测和按平台提供的安装指引。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-transcriber-engine

[English](README.md) | 中文

## 概述

使用本包可在用户上传 source 或等待长时间运行之前，检查转写引擎能否启动。存在性检查成本低；实时检查会运行引擎声明的探测，包括 NotebookLM 认证探测。即使必需工具缺失或不健康，包仍会返回有效报告，因此 Settings 页面可以说明修复方式。本包拥有后续引擎操作继续扩展的 Remote 命名空间。

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

`TranscriberEngine` 拥有一个 Remote 命名空间，并把一次 doctor 调用交给 `ctx.subprocess`。`doctor.ts` 在一个函数中构建当前的 `python3` 加脚本 argv，限制收集的输出，把取消传给 provider，并在 subprocess 边界校验完整 JSON 答案。Client entry 通过 `ctx.transcriberEngine` 提供同一命名空间，因此 UI consumer 不必直接访问原始 Remote 对象。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host service 与 `transcriberEngine/doctor` Remote 方法 |
| [`src/doctor.ts`](src/doctor.ts) | 引擎路径解析、命令构建、subprocess 生命周期与 JSON 校验 |
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
- **一次性检查**——每次操作都会启动新的 doctor 进程，且不会保留就绪缓存。
- **探测计时由引擎拥有**——实时探测的期限仍在引擎中；取消可以停止进程，但不会缩短一个正常运行的探测。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

包名描述的是可扩展的引擎能力，而不是首个 `doctor` 方法，因此后续的 dropped-recording 导入和运行进度方法可以复用同一套 Remote 与 Client provider wiring。

</details>
