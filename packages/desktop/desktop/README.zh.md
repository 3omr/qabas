---
description: "为 Harness Desktop 内运行的插件提供原生窗口、通知和登录时启动操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-desktop

[English](README.md) | 中文

## 概述

桌面宿主内的插件可通过 `ctx.desktop` 显示应用窗口、发送操作系统通知及控制登录时启动。提供方会拒绝原生宿主无法完成的操作。浏览器和 headless 部署不会获得模拟的桌面服务。

## 目录

- [组合](#composition)
- [实现](#implementation)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

<a id="composition"></a>

## 组合

把[原生提供方](../desktop-native/README.zh.md)加载到[桌面启动 overlay](../../../apps/desktop/runtime/desktop.cordis.yml) 中。该抽象服务没有配置，也不是可独立安装的 Profile Bundle。

通知可以设置 `backgroundOnly`，在主窗口聚焦时抑制送达。请求被接受不代表 OS 已展示通知；系统权限和通知设置仍然适用。

`openLocalAgents()` 打开或聚焦原生扩展设置，不检查账户、不更改偏好，也不启动委派。返回确认仅代表窗口操作。原生页面继续管理本地 agent 配置。

NotebookLM 认证方法会启动并控制原生 `nlm login` PTY，并向可信 Host 消费者提供增量输出和用户输入行；转录引擎负责面向用户的对话，并使用 `nlm login --check` 验证完成结果。

可信准备消费者可以查询原生 Profile 选择、将已准备的 Profile 排入下次完整应用启动队列，并精确取消待启用项。排队不会重启运行中的应用。队列可能已经提交而传输回复失败；重试或删除候选文件前必须检查原生选择。启动确认和恢复由[原生选择所有者](../../../.agents/notes/implemented/architecture/2026-09-07-desktop-profile-startup-selection.zh.md)负责，不在 Node 中模拟另一份状态。

<a id="implementation"></a>

## 实现

<details>
<summary>原生能力的归属</summary>

[服务定义](src/index.ts) 不依赖 Tauri 或浏览器即可暴露操作。提供方负责跨进程传输。该包不发布运行时 invariant companion，因为抽象服务不持有可变观测状态；服务注册和 dispose（资源释放）由 Cordis 管理。

</details>

<a id="model-experience"></a>

## 模型体验

### 原生桌面操作

#### 模型看到什么

没有直接内容。消费方决定是否把 `ctx.desktop.notify(...)` 这类调用呈现为命令、工具或后台策略。

#### Token 影响

该 Service Definition 不增加提示词、消息、schema 或工具结果。

#### KV Cache 影响

该服务不贡献模型输入，因此保留所有可复用的模型请求前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限可信 Host 消费方**：该服务没有插件身份或逐次调用授权；已挂载的 Host 插件可以调用当前提供方实现的全部操作。

<a id="dev-note"></a>

### 开发备注

无。
