# Agent Note: Google 聊天等待的限制

Status: implemented

[English](2026-10-07-google-chat-wait-bounds.md) | 中文

## 问题

一个简短的 Google 聊天请求可能超过两分钟没有流事件。一次真实 Gemini 3.8 Flash 请求在用户取消前的 123 秒内没有事件。后续请求收到两次 HTTP 503 高负载失败，每次约两秒，随后另一轮尝试停滞。五分钟空闲间隔与延长的过载重试叠加，使等待难以与应用故障区分。Chat 分类器还把 Google 高负载的 `UNAVAILABLE` 状态解释为模型退役。

## 决策

`google` 路由的默认流空闲间隔为 60 秒，瞬态重试次数为两次，初始退避为 1 秒，本地上限为 5 秒。空闲限制包括首次响应，并在收到流事件后重置。显式 `streamIdleTimeoutMs` 和 `retryPolicy` 仍具有优先权。路由解析应用这些默认值，但不注册未使用的服务商，也不改变所选模型或推理等级。其他路由保留各自的服务商策略。

Chat 在通用模型不可用措辞之前识别过载，并提供本地化过载与超时提示。只有已安排的重试承诺自动继续。终止失败提示学生重试；服务商等待期间始终可以取消。

## 考虑过的替代方案

**保留延长的自动恢复。** [过载决策](../feature/2026-10-02-overload-backoff.zh.md) 和[分钟配额决策](../feature/2026-10-02-free-tier-rate-limits.zh.md) 保留恢复机制与可配置策略。延长的默认值对其他服务商及显式后台任务设置仍有用，但会让交互式 Google 等待过长。

**切换模型或禁用推理。** 两者都不能修复错误提示或限制停滞的传输，而且在没有证据表明设置导致延迟时改变了学生的请求。

## 后果

持续 Google 压力在三次尝试后结束，不会无限等待分钟配额恢复。长时间没有流事件会失败，即使服务商最终可能恢复；需要这种等待的部署可以配置更长空闲超时及重试策略。服务商规定的最短等待和已学习的 RPM 节流可能延长耗时，因此这不是整轮截止时间，也不保证外部服务延迟。

[Loader 恢复测试](../../../../packages/llm/llm-retry/tests/loader-composition.spec.ts) 使用模拟 HTTP 与时间，通过真实循环验证 Google 过载和限流耗尽。[适配器测试](../../../../packages/llm/llm-pi-ai/tests/adapter.spec.ts) 验证 schema 解析的默认值与显式覆盖。[Chat 回归测试](../../../../packages/client/ui-chat/tests/provider-failure.client.spec.ts) 区分过载与不可用模型，以及已安排与终止超时提示。已发布的 Session 事件和世代不变。
