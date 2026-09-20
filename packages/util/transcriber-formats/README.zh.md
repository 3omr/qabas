---
description: "供引擎 Host 和浏览器工作区读取器共享的转写录音、幻灯片和文档格式事实。"
kind: "package-reference"
---

# @deepseek-ai/dsh-util-transcriber-formats

[English](README.md) | 中文

## 概述

转写 Host 导入器和浏览器工作区读取器使用同一份 TypeScript 录音、幻灯片、文档及扩展名规则。Python 引擎仍是运行时处理的权威；本包让浏览器筛选和 Host 接收与引擎发布的文件格式保持一致。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制和延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----


-----

<a id="use-this-package"></a>
## 使用本包

当转写界面需要分类文件名时，导入格式集合和 `extensionOf`。让录音集合与引擎的 `RECORDING_EXTENSIONS` 保持一致；不要在面板或 Host 操作中建立本地副本。

-----

<a id="model-experience"></a>
## 模型体验

None, as this package registers no tool, prompt section, or session event.

#### KV Cache effect

None; format facts neither assemble nor send a model request.

## 已知限制和延期工作

<a id="known-limitations-and-deferred-work"></a>

- **两个运行时** — Python 引擎仍然声明自己的原生集合，所以修改引擎格式时必须同时更新本包及其消费者。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>

**运行时不变量：** 不发布 companion。本包只拥有不可变格式事实，不拥有运行时状态。
