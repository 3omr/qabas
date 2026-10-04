# Agent Note: 从头重做、恢复分段对齐与限制客户端重试

Status: implemented

[English](2026-10-05-stale-parts-and-retry-cap.md) | 中文

## Problem

缓存中的已开始重做标记可能让新的「重新转写」复用早先的草稿与分段。即使保留的修复分段独立对齐，保存的读取预算仍可能超过当前响应容量。准备步骤可能在返回清单之前失败，导致补救无法识别草稿。无限客户端重试将反复出现的引擎错误隐藏在最后一条进度说明后面。

## Decision

「重新转写」在入口处、持有讲座锁时，将对应草稿与分段归档到 previous-drafts；原定稿保留到替换成功。内部重试与「继续」保留新一轮的内容。直接调用 begin 重做也从头开始。有效的分段布局在 parts.txt 与对齐一致时恢复其记录的分段预算。不可靠的分段移入 stale-staged；保存的草稿提供有界修复分段，否则保留的逐字稿提供新指南。读取分页可独立于修复/写作对齐重置过大的预算；不会要求使用先前的 max-part-bytes 限制。

未返回清单路径时，草稿解析使用模块与讲座对应的缓存单元清单。显式清单路径仍是权威。补救、确定性修复与来源恢复共享该解析方式。

客户端默认允许三次自动重试，可通过 pipelineRetryLimit 配置；指数延迟基于 chatRepairCancelGraceMs。持久化的重试次数在重新加载后保留。进度说明被重试的步骤与尝试次数。耗尽后释放任务名额，报告可恢复的停止任务，并在 job.error 中保留原始引擎错误。固定备注是 `Automatic retries stopped after repeated engine errors; your retained work is available through Continue.`；job.noteLine.retryLimit 管理其本地化托盘文案。

此决定部分替代[定稿记录](2026-10-04-finish-always.zh.md)中的无限引擎请求重试策略；该记录仍管理通过验证的补救、图片与考题保留。[有界审阅记录](2026-10-04-bounded-review-repair.zh.md)仍管理保留分段的大小限制与审阅归属。

## Alternatives considered

**新的「重新转写」信任 redo_started。** 该标记为「继续」识别保留内容，而非学生要求从头开始的请求。

**要求匹配的 Host 限制或丢弃保留文本。** 记录的分段可建立恢复对齐；归档保留不确定的分段，保存的文本则提供新的修复布局。

**无限重试或用通用消息替换原始错误。** 有限重试提供可见的结束状态；独立详情保留诊断存储与引擎故障所需的证据。

## Consequences

合成回归覆盖已开始重做的归档、独立修复/读取预算、缺失对齐、记录写作预算的恢复、返回清单前的准备失败、带退避的有限重试、取消、托盘文案与持久化。只读 endo 复现使用私有临时副本：Hyperthyroidism 的全部十三个分段在 previous-drafts 中保持逐字节一致，begin 返回逐字稿路径，执行在注入离线停止之前到达 writer。学生内容不会进入仓库测试数据。完整引擎与客户端检查负责回归证据；真实 NotebookLM 与 agy 的完成不属于此次离线复现。
