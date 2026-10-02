# Agent Note: 学生密钥的同一步骤每日模型回退

Status: implemented

[English](2026-10-02-daily-quota-model-fallback.md) | 中文

## Problem

即使每分钟限流等待成功，免费 Gemini 模型仍可能在一节课期间耗尽每日请求额度。每个模型有独立的每日额度。Google SDK 在省略思考设置时还会发送 MINIMAL，而部分 Gemini 3.x 模型以 HTTP 400 拒绝此值。

## Decision

pi-ai 插件通过现有 Agent 请求和请求错误 waterfall 拥有恢复逻辑。`dailyQuotaFallback` 仅在 google 路由上默认开启。其重置时区为 America/Los_Angeles；其他启用的提供方必须声明 IANA 重置时区。进程范围的提供方/模型记录在该时区日期变化时失效，包括夏令时变化。这避免硬编码请求数猜测，并在适配器重新挂载后保留知识。进程重启丢弃记录；别名和不同进程不共享记录。

AgentOptions.allowModelFallback=false 显式固定路由；ModelSelectionRef.allowFallback=false 固定单个轮次。仅指定提供方/模型仍属于偏好，包括 Web 和 headless 默认值。ACP 提示接纳时选定的模型禁止该轮次的切换。Web 会话模型选择表达偏好并允许恢复；新选择会使当前轮次待应用的恢复覆盖失效。失败的已接纳步骤保留消息、工具和步骤编号。替换路由是配置的提供方目录中版本最新且未耗尽的主要写作模型；资格和稳定数字版本排序与客户端规则一致，但不导入客户端代码。Preview 和专用模型仍被排除，回退从不跨提供方或添加配置之外的模型。所有候选模型耗尽时产生 DAILY_QUOTA_EXHAUSTED，列出尝试的模型和合格目录条目。

持久化 `llm/model-fallback` 载荷包含 turn、step、from 和 to 路由（{provider, model, name}），以及 reason DAILY_QUOTA_EXHAUSTED。随后 request/header 记录实际路由和默认推理级别。Chat 在 Compact 折叠之外为每个事件显示一行中文/英文/阿拉伯语提示。现有请求 header 投影在 lastUsed 中提供实际路由；客户端变更是对话提示行。此事件仅进入日志，不插入额外用户消息。

Gemini 3.x 默认从声明的 SDK 支持中选择 low、medium 或 high；非推理条目省略 SDK 的隐式思考配置。明确指出思考级别不受支持的 400 错误允许每个模型/步骤一次修正，使用下一个受支持级别，或在声明可用时使用 off。Off 移除 Google 的禁用思考配置，而不是发送 MINIMAL。`llm/thinking-fallback` 在重试前记录 turn、step、provider、model、from、to 和 reason UNSUPPORTED_THINKING_LEVEL。只有成功的助手结算才会记忆进程范围的修正；被拒绝的显式级别使用学到的替换值，其他显式级别仍被遵守。第二次拒绝仍然终止。直接 LLM 流仍只尝试一次。

## Alternatives considered

对任意 quota 或 429 进行切换会混淆每分钟限流、账户计费失败和每日模型额度耗尽。跨提供方回退可能消费无关账户的资金，需要不同的授权策略。将每次 Web 选择视为永久固定会阻止学生普通模型偏好在课程中途恢复。始终发送 MINIMAL 会重复 SDK 中服务器不支持的默认值。无限思考重试可能隐藏无效请求配置，因此被拒绝。

## Consequences

恢复会改变模型质量和提供方缓存标识，同时保留已接纳的请求历史。目录知识无法证明提供方一定能服务某个条目；替换模型的非额度失败保留正常错误策略。并发会话可能在进程学到事实之前同时发现额度耗尽。修正推理级别可能增加思考成本。

现有 free-tier-rate-limits 记录继续拥有每分钟限流和提供方等待的决策。其中每日错误仍然终止的陈述适用于通用重试执行器；pi-ai 的独立模型恢复监听器拥有合格的每日切换。conversation-labels 记录继续拥有失败分类。两者都未被完全取代或归档。

使用模拟外部 HTTP 的 Loader 组合覆盖同一步骤重试、跨会话跳过耗尽模型、终止错误、提供方默认值和固定模型，以及思考修正。时钟测试覆盖太平洋时区夏季/冬季午夜和路由/模型隔离。客户端测试固定本地化事件投影。实现报告记录实际执行的检查和沙箱限制。确定性额度证据不使用真实免费层请求。
