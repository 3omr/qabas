---
description: "通过可选桌面 Bundle 配置任务完成和失败通知。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-notification-controls

[English](README.md) | 中文

## 概述

选择 Qabas 是否在任务完成或失败时通知你。两个开关分别保存，并应用到之后结束的任务。此可选 Bundle 控制桌面已有的通知；不会额外发送通知，也不会改变任务执行。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

打开设置 → 插件 → 插件市场，选择 Notification Controls，审阅安装信息，并确认在下次启动时安装。结束当前任务后退出并重新打开桌面应用。在“已安装”中展开“设置通知”。无需单独安装 Node 或 pnpm。

两个开关初始都允许通知。修改开关会通过 Host 保存偏好；关闭的开关会阻止对应的完成或失败通知。显示的开关状态跟随已保存的 Host 观测结果。若无法确认保存结果，请先核对当前开关再重试。偏好在应用重启后保留。

任务运行时将应用切到后台，并授予系统通知权限。原生提供方不包含任务内容，取消的任务、subagent 或恢复的历史不会发送通知。这些开关不会授予系统权限，也不会覆盖前台抑制规则。

若要静音，请关闭开关而不是移除 Bundle。“已安装 → 审阅移除”会准备下次启动时移除。移除恢复桌面的默认通知行为，并保留偏好供重新安装时使用。

本包以经过审核的本地 tarball 提供，不承诺 npm 注册表可用性。随包携带的 schema 依赖允许使用桌面的空离线包缓存安装。补丁插入一个 `notification-controls` 行。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

[Host 入口](src/index.ts)注册 `notification-controls` 设置命名空间和可撤销的 `desktop/task-notification` 策略。原生提供方请求发送通知时，策略读取最新的完成或失败偏好。启用的偏好通过 `next()` 委托；禁用的偏好返回 false。卸载会移除策略，不改变原生提供方或已存储的偏好。

[浏览器入口](src/client/index.ts)通过现有 Slots 机制贡献带键的市场操作。编辑器使用 Host 设置作用域执行修订号约束的写入，只有观测到请求的值后才报告成功。它没有第二份偏好存储。策略不会在运行时导入原生提供方；仅类型导入用于声明事件。

本包不发布 invariant 配套入口：设置提供方负责校验和持久化，策略直接读取该状态，没有单独的镜像。[原生提供方](../desktop-native/README.zh.md)负责通知适用条件、传输和策略异常处理。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [桌面包](../README.zh.md) — 原生能力和可选 Bundle。
- [插件市场](../bundle-marketplace/README.zh.md) — 审核后安装与下次启动时启用。
- [通知策略决策](../../../.agents/notes/implemented/feature/2026-09-07-notification-controls-bundle.zh.md) — 生命周期、默认行为和任务隔离。

<a id="model-experience"></a>
## 模型体验

无，因为此通知策略不添加模型输入或 Session 事件。

#### KV Cache 影响

Bundle 不改变系统提示词、工具 schema、请求前缀或模型缓存复用。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- 原生提供方必须启用 `notifyOnTurnEnd`；桌面覆盖层会启用它。在仅浏览器的 profile 中安装此 Bundle 不会提供原生通知。
- 偏好使用所选 Harness 主目录的设置文档。保存需要可写的 Host 连接；偏好不会跨设备同步。
- 通知送达仍取决于操作系统。打包冒烟测试使用经过认证的桥接 fixture（测试前置数据），不验证真实系统授权或通知中心送达。
- 已安装的插件作为受信任的同进程代码运行。此策略不会隔离插件，也不会管控它们直接调用通知的行为。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
