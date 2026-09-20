---
description: "为调用 Tauri 桌面宿主的插件提供经认证的回环传输，并说明配置和失败行为。"
kind: "package-reference"
---

# @deepseek-ai/dsh-desktop-native

[English](README.md) | 中文

## 概述

Tauri 应用管理 Harness 时，插件可通过 `ctx.desktop` 调用原生桌面操作。每次调用都使用私有回环 bridge 和独立的每次启动 token。提供方还提供 NotebookLM 认证使用的、仅限桌面的 PTY 生命周期。提供方在发送凭据前拒绝非回环 origin，并拒绝失败或超时的操作。

## 目录

- [配置](#configuration)
- [实现](#implementation)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

<a id="configuration"></a>

## 配置

[桌面 overlay](../../../apps/desktop/runtime/desktop.cordis.yml) 使用 Rust 提供的值挂载该提供方。它是 Cordis 插件，不是可独立安装的 Profile Bundle。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `endpoint` | 必填 | 精确的 `http://127.0.0.1:<port>` origin，不含用户信息、路径、查询或片段。 |
| `token` | 必填 | 原生 bridge 使用的 secret-role token，从不放入 URL。 |
| `timeoutMs` | `5000` | 每次操作独立计算的超时毫秒数。 |
| `notifyOnTurnEnd` | `false` | 对顶层会话的实时完成或失败发送通知；桌面 overlay 启用此项。 |
| `startupToken` | 省略 | Rust 提供的逐子进程十六进制标识；需要启动器的 `appReady` 服务。 |

配置 `startupToken` 后，提供方通过经过认证的私有 bridge 确认启动器已成功完成启动。挂载提供方或打开 HTTP 监听器不会发送该确认。卸载会移除就绪监听器、取消进行中的确认请求，并等待其结束。发送失败不会记录启动标识，原生启动期限仍然有效。Rust 只接受当前所拥有子进程的标识，并在确认到达且监听器可连接后才导航。这证明启动完成，不证明每项插件功能或后续运行时健康。

后台轮次通知不包含任务文本和错误详情。主窗口聚焦时，原生宿主抑制这些通知。取消或阻塞的轮次、子会话与恢复的历史不会通知；卸载提供方会移除观察器。提供方记录通知失败，不会使已提交的轮次失败。仍需 OS 通知权限；点击通知不会选中对应 Session。

发送符合条件的任务通知前，提供方询问同步的 `desktop/task-notification` waterfall（瀑布式事件）。策略通过 `next()` 委托或返回 false 阻止该通知。没有监听器时允许发送；策略抛出异常会阻止发送并记录通用警告，不改变已提交的轮次。可选的 [Notification Controls Bundle](../notification-controls/README.zh.md)提供持久化开关。此策略不管控直接的 `ctx.desktop.notify()` 调用。

Profile 选择读取在 65536 字节的回复上限内验证原生 JSON 的版本、标识和字段。排队与取消通过经过认证的桥接传递精确标识，都不重启运行时。提供方不维护启用镜像。超时不证明修改请求未提交；消费者保留准备文件，并在重试或清理前检查选择。

打开本地 agent 设置只向原生宿主发送固定、无参数的请求，不读取账户数据，也不运行探测。现有原生扩展窗口管理检测与已保存的选择；浏览器不会获得原生命令权限或 bridge token。

NotebookLM 认证通过原生宿主的 portable PTY 启动 `nlm auth`，按 cursor 轮询有界输出，并转发单行回复或取消。进程使用与本地 agent probe 相同的清理环境和构造出的 PATH。原生宿主不会把认证输出保存为持久数据。

<a id="implementation"></a>

## 实现

<details>
<summary>原生 bridge 的归属</summary>

[提供方](src/index.ts) 向 [Rust bridge](../../../apps/desktop/src-tauri/src/bridge.rs) 发送经认证的请求。浏览器认证由上游 Connection 包负责，使用另一份凭据。NotebookLM 输出留在有界的原生 session 中，由引擎 capability 轮询，而不是转成 Cordis event。该包不发布运行时 invariant companion，因为请求相互独立，且提供方不维护原生状态的镜像。

</details>

<a id="model-experience"></a>

## 模型体验

### 原生 bridge 操作

#### 模型看到什么

没有直接内容。`NativeDesktopHost.notify()` 负责传递消费方请求，不返回面向模型的文字。

#### Token 影响

原生操作不增加提示词、消息、schema 或工具结果。

#### KV Cache 影响

原生 bridge 流量位于模型请求之外，并保留所有可复用前缀。

### 已安装桌面应用的上下文

#### 模型看到什么

挂载 `systemPrompt` 时，提供方会注册下方的桌面环境说明。桌面覆盖层禁用 Web 开发上下文及其 `DSH_WEB_URL` Shell 变量。常规提示词组装会将结果写入 `request/header`；预设提供完整 persona 时，仍会替换组装后的系统提示词。卸载提供方会移除其分区。Bridge 端点与凭据不会进入这段文本。

##### 桌面环境说明

```markdown
You are interacting with the user through Harness Desktop, a desktop application built on DeepSeek Harness. References to "this app" or "this interface" mean this desktop application unless the user names another target. The interface provides no implicit screenshot, DOM, or route context. The app manages its bundled runtime. Starting a separate web server or rebuilding a workspace does not update this installed app. Do not modify installed application resources or restart the desktop app unless the user explicitly asks. Work in the selected session workspace; it is separate from the app installation.
```

#### Token 影响

该固定分区启用时会增加系统提示词 token，原生调用本身不增加 token。文本不包含每次启动变化的值。

#### KV Cache 影响

文本在各轮次之间保持为稳定的请求前缀。修改或移除分区会替换前面的提示词 token，可能使其无法复用；提供方缓存是否可用仍由外部决定。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **没有原生事件流**：NotebookLM 输出通过请求轮询而不是通用原生 event bus；菜单直接派发到 WebView。
- **PTY 需要手动验证**：真实 `nlm auth`、浏览器登录和 Windows PTY 行为不在 JavaScript bridge 测试覆盖范围内。
- **可信本地插件**：token 认证 Harness 进程，而不是其中的各个插件。

<a id="dev-note"></a>

### 开发备注

无。
