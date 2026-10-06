# Agent Note: ACP 会话使用保存的默认模型

Status: implemented

[English](2026-10-05-acp-saved-default-model.md) | 中文

## 问题

ACP 应用 bundle 曾将 `deepseek-official` 配置为提供方与模型。移除 DeepSeek 作为产品提供方主干时，这项配置被删除且没有替代，因此每个 ACP 会话都在没有模型的情况下启动，首轮在组装角色前缀的 `{{model}}` 变量时失败。

## 决策

当 ACP 插件没有完整的提供方与模型配置时，新建或恢复的会话会等待 Loader，然后使用 `agentDefaultModel.currentSelection()`，即用户登录后保存的路由。等待 Loader 与 headless 应用一致：ACP 请求可能在设置文档仍在挂载时到达。完整的部署配置仍然优先；没有保存的默认模型时，部分字段继续留给请求监听器补全。

## 考虑过的替代方案

**在 ACP bundle 中重新组合固定提供方。** 已否决：产品没有可信的静态默认值，这也是 base bundle 不组合任何提供方的原因。

**在插件应用时只读取一次默认值。** 已否决：设置在 ACP 启动之后挂载，并且进程运行期间的登录必须作用于下一个会话。

## 后果

内置 ACP 配置在独立主目录中使用已保存的 pi-ai 路由。ACP 录制会话回放通过 `agent-default-model` 选择路由，而非显式 ACP 组合。更改已保存的默认模型会影响下一个会话；完整的部署组合优先。
