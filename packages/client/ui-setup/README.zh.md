---
description: "Qabas 首次设置的最后一步：说明学习工作区里有什么，并把学生带进资料库。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-setup

[English](README.md) | 中文

## 概要

首次设置的最后一步。在欢迎和 AI 账户（ui-settings-models）以及转写工具（ui-settings-transcriber-engine）之后，它说明学习工作区里有多少个模块（或者还没有模块），并打开资料库。

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

与 ui-library 一起挂载。它注册一个 `settings.onboarding` 步骤（`qabas-library`，order 30），绘制在共享的 `SetupStage` 框架中。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

此步骤读取资料库服务的状态（资料库自应用打开起就在加载），并像每个设置步骤一样，从 `settings.onboarding` 登记表读取自己在序列中的位置。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [ui-library](../ui-library/README.zh.md) — 此步骤打开的资料库。
- [ui-settings-models](../ui-settings-models/README.zh.md) — 欢迎和账户步骤。

-----

<a id="model-experience"></a>
## 模型体验

此步骤不发起任何模型请求。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

学习工作区是引擎启动时使用的那个；设置中暂不提供选择其他文件夹。

-----

<a id="dev-note"></a>
### 开发笔记

使用脚本化的工作区快照进行测试。
