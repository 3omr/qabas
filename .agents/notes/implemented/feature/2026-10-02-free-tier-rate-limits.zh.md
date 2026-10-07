# Agent Note: 学生免费层配额恢复

Status: implemented

[English](2026-10-02-free-tier-rate-limits.md) | 中文

## Problem

Gemini 转录需要数十次模型请求。每分钟五次请求的配额可能中断轮次，通用配额措辞隐藏临时性质，短退避则浪费请求。每日耗尽需要学生采取不同操作。

## Decision

pi-ai 适配器先于通用配额错误识别配额周期。每日耗尽携带 `DAILY_QUOTA_EXHAUSTED` 与包含模型名称的诊断；执行器在所有模式下都将它保留为终止错误。非 Google 的 pi-ai 默认采用 normal 重试并设置 `unlimitedCodes: [RATE_LIMIT]`，其他瞬态失败保持有界。提供方显式策略仍可覆盖默认值。[Google 聊天等待决策](../bug-fix/2026-10-07-google-chat-wait-bounds.zh.md) 负责 Google 默认值。

进程级节拍器从每分钟违规学习正的请求计数 RPM，按提供方路由与请求模型记录。近期派发预约包含学习前的请求。已学习预算同时实施均匀间隔与滑动分钟窗口，在适配器替换后保留，并由所有会话共享。取消等待不占用预约；已派发的失败尝试占用预约。每日配额与 token 计数配额不提供 RPM。

最长提供方等待是最短等待，加配置的正向抖动，不受本地退避上限影响。持久重试事件保留现有载荷联合：无限 code 尝试使用 always 模式并省略 maxRetries，policyKey 保留 normal 提供方策略。现有 Chat 渲染器消费 delayMs 与 failure.code。Web 显式启用 base 重试执行器；desktop 使用相同组合。

请求错误动作决策独立持有恢复扩展点的所有权。活动记录搜索未发现被此功能取代的配额节拍决策。手工编写的记录式配额场景使用已发布的 headless profile。直接 ESM CLI 重放成功；现有 snapshot 子进程 harness 无输出退出，其既有重试基线也如此，仍是未解决的验证限制。

## Alternatives considered

固定五 RPM 在没有证据时限制付费模型，学习可以避免此代价。SDK 重试会将尝试隐藏在持久历史之外，因此恢复由现有步骤执行器持有。默认 always 重试会重复永久凭据错误；选择无限限流 code 使其他失败保持有界。

## Consequences

首次拒绝用于发现未知配额。知识只在一个进程与提供方/模型路由内部共享：其他进程、别名或项目外部用户仍可能导致拒绝。Google SDK 传输拒绝自定义 fetch 并丢弃响应头；JSON RetryInfo 提供等待。支持自定义 fetch 的协议在 SDK 展平错误前保留 HTTP Retry-After。

模拟时钟测试覆盖解析、每日分类、窗口过期、并发预约、取消、模型/提供方隔离与超过本地上限的等待。Loader 恢复测试使用一次模拟 429 后成功。实现报告记录执行的检查与沙箱限制。沙箱将 .agents 挂载为只读，因此双语记录交付于 /tmp，供以后放入 .agents/notes/implemented/feature/。
