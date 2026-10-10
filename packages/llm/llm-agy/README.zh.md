---
description: "配置 Antigravity CLI，使用 Google 登录回答 Qabas 聊天，并可通过 Gemini 密钥恢复。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-agy

[English](README.md) | 中文

## 概述

使用学生的 Antigravity Google 登录回答 Qabas 聊天，无需 API 密钥。Qabas 通过自身记录日志并执行权限检查的流程运行每个请求的资料库或引擎工具。可配置 CLI 模型、推理强度和实际时间期限。已保存的 Gemini 密钥可恢复一次不可用的“عومر”轮次；显式固定模型会阻止切换。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Web bundle 将此提供方与 pi-ai 一起挂载；Desktop 使用相同组合。设置仅在默认选择为空时保存配置的首选 agy 模型，包括在首次设置期间安装后。保存 Gemini 密钥会配置 Google，并保留学生已有的选择。

```yaml
- name: '@deepseek-ai/dsh-llm-agy'
  config:
    defaultModel: gemini-3.8-flash-low
    effort: low
    timeoutMs: 180000
    googleFallback: true
```

`executable` 默认为 `agy`，接受 PATH 中的命令或绝对路径。解析使用 Desktop 安装和认证同样使用的共享子进程可执行文件解析器。`graceMs` 默认为 3000；`maxOutputBytes` 默认为 4194304。`agy models` 提供以制表符分隔的模型 ID 和名称；配置的默认模型排在首位，模型不存在时配置操作显式失败。模型解析将配置的推理强度写入日志请求头。

每个请求使用私有临时根目录，其中包含空的工作子目录和位于其外部的响应 schema 文件。共享 `ctx.subprocess` 所有者启动 CLI，在取消或超时时终止进程树，并等待退出后删除临时根目录。

`AGY_NOT_INSTALLED`、`AGY_NOT_SIGNED_IN` 和 `AGY_QUOTA` 是需要学生操作的终止原因。连接重置和资格检查失败使用 `TRANSPORT`；共享重试执行器会重试。无效响应或工具调用在发布内容前失败。每个请求仅由一个 finish chunk 结束。

启用 `googleFallback: true` 时，符合条件的终止失败与已保存的 `GEMINI_API_KEY` 会在每轮最多一次选择已配置的 Google Flash 模型。Agent 回退钩子和选项必须允许切换。现有 `llm/model-fallback` 事件记录两个路由和 agy 原因；Chat 显示本地化的 عومر 转 Gemini 提示。下一轮从学生的原始选择开始。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

适配器是现有 LLM 能力接口的 Service Provider。CLI 返回结构化文本与请求的 Qabas 调用，而不执行这些调用。完整响应验证检查已提供的工具名称和 JSON 对象参数，并解开 `structured_output.text` 内代码围栏包裹的 schema JSON 响应。用量位于终止 finish 之前。

不发布 invariant 配套入口：适配器将一个请求转换为一个响应，不拥有可能发生偏差的独立注册表观察值。共享 LLM 注册表和子进程提供方拥有这些关系。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [LLM 服务](../llm/README.zh.md) — 提供方中立的请求和 chunk。
- [子进程所有者](../../subprocess/subprocess/README.zh.md) — 进程树生命周期。
- [pi-ai 适配器](../llm-pi-ai/README.zh.md) — Google 路由与持久回退记录。

-----

<a id="model-experience"></a>
## 模型体验

### 仅模型请求

#### 模型所见

CLI 从其私有工作目录读取 `prompt.md`（聊天提示词超过命令行参数限制）；该文件包含固定的 `tool_calls` 仅模型指令，之后是包含已记录系统文本、有序会话块及工具定义的 JSON。[渲染器](src/prompt.ts) 及包内快照固定了完整指令。提示词由会话日志重建的请求确定性生成；不会添加未记录的工作区内容或时间戳。

#### Token effect

JSON 包装和固定指令会增加日志请求内容的输入 token。CLI 的用量计数器在存在时提供输入和输出统计。

#### KV Cache effect

每次调用启动新的 CLI 进程并提供完整、确定性的会话前缀。不复用会话 ID 或适配器私有重放状态；缓存复用由 Antigravity 管理。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 响应缓冲到 CLI 退出后才发布；不支持逐 token 显示。
- 禁用工具的指令和 `--sandbox` 实现已决定的 CLI 模式；Antigravity 内部的执行限制取决于其 CLI 行为。
- 请求图像使用共享纯文本投影。Google 实际登录、真实模型资格和 Windows CLI 安装需要现场检查。

<a id="dev-note"></a>
### 开发备注

无。
