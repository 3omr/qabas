# Agent Note: 提供方过载的有界恢复

Status: implemented

[English](2026-10-02-overload-backoff.md) | 中文

## 问题

免费的 Gemini 密钥会遇到持续一分钟或更久的 HTTP 503 UNAVAILABLE，并伴随 high demand 诊断。从 500 毫秒开始的五次重试会在临时负载消退前耗尽本地等待。仅含文字的过载诊断还可能未被归类为瞬态失败。

## 决策

[pi-ai 流转换器](../../../../packages/llm/llm-pi-ai/src/stream.ts) 在终止性的身份验证、配额、模型缺失和无效请求检查之后，将 HTTP 503、UNAVAILABLE、high demand 描述和 overloaded 诊断映射为 OVERLOADED。其他 HTTP 5xx 错误仍为 SERVER；传输截断保持独立分类。

[提供方策略 schema](../../../../packages/llm/llm/src/retry-policy.ts) 接受 normal 模式下针对有界合格 code 的 codeOverrides。省略值继承 normal 设置；不合格的 code、与无限重试 code 重叠、未知字段，以及无效预算或延迟都会在解析时失败。解析后的覆盖值经过分离并被冻结。每个覆盖 code 都有独立的持久重试历史，以完整提供方策略和所选 code 为键。现有重试事件和投影格式保持不变。

非 Google 的 pi-ai 路由默认对 OVERLOADED 重试八次，初始指数退避为 3 秒，本地上限为 60 秒，并带有 10% 抖动。标称本地等待总计 273 秒。显式 retryPolicy 替换整个默认策略。提供方的 Retry-After 和 RetryInfo 仍是最短等待，即使超过本地上限也必须遵守；尝试次数仍有界，但提供方指令可能延长总耗时。其他瞬态失败保留五次重试及 500 毫秒／10 秒退避。这些路由的 RATE_LIMIT 默认仍无限重试。[Google 聊天等待决策](../bug-fix/2026-10-07-google-chat-wait-bounds.zh.md) 负责 Google 默认值。

[免费层配额决策](2026-10-02-free-tier-rate-limits.zh.md) 继续负责无限限流恢复、RPM 节流和提供方等待。[每日模型回退决策](2026-10-02-daily-quota-model-fallback.zh.md) 继续负责每日配额耗尽。过载处理没有取代这两个决策。

## 考虑过的替代方案

**延长所有瞬态失败的退避**会拖慢短暂 socket 中断和空响应的恢复。按 code 设置将延长等待限定于过载。

**无限重试过载**可能让讲座任务在长期故障期间无限等待。八次重试预算让持续过载最终结束，同时保留分钟配额的无限恢复。

**仅针对 Google 的特殊处理**无法覆盖其他 pi-ai 提供方的等效过载。分类和提供方无关的策略设置支持所有路由。

## 影响

持续过载需要几分钟才会失败，并可能重复产生计费请求。取消和释放保留执行器的可取消等待。提供方指令可能超过标称总等待；不会用墙钟截止时间覆盖这些指令。

使用模拟外部 HTTP 和虚拟时间的真实 Loader 组合验证了持续过载后的恢复、八次重试耗尽、超过上限的提供方等待、无限 RATE_LIMIT，以及显式用户设置。解析器测试覆盖继承、不可变性和无效配置拒绝。分类夹具包含 Google RetryInfo 和通用 Retry-After。[人工编写的过载快照](../../../../snapshots/session/overload-retry-current/snapshot.yml) 使用短等待，通过随附的 headless profile 验证持久的按 code 重试事件。

TypeScript 和直接运行的包级 Oxlint 检查通过。完整包测试遇到被阻止的 socket 和 watcher；原始代码中就存在的 TOOL_CALL_TRUNCATED 与 TRANSPORT 预期不符之后已与截断恢复对齐。构建和文档聚合检查被 tsx IPC 阻止。105 项聚焦测试通过。直接通过受支持的 ESM 启动运行 dsh headless 回放会输出 Recovered.，其规范化持久日志与新夹具一致；现有快照子进程测试框架仍返回空输出。双语内容 hash 检查通过，但只读 .git 阻止了恢复 blob 的固定。
