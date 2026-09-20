# Agent Note: 移除 DeepSeek 作为产品的默认提供方主干

Status: implemented

[English](2026-09-20-deepseek-provider-removal.md) | 中文

## 问题

本分叉是一款面向医学生的医学讲座转录桌面应用，其用户订阅的是 Claude 或 ChatGPT，而不是 DeepSeek。但组合装配仍以 DeepSeek 为主干：`llm-deepseek` 是已挂载的适配器，`agent-default-model` 组合出 `deepseek-official/deepseek-flash`，因此每个新 Session 都以它开场；网页搜索走 DeepSeek API；首次运行索要 DeepSeek API 密钥。于是，已登录自有订阅的学生，第一屏仍被要求提供一把自己没有的密钥，模型选择器里也摆着一条根本无法工作的路由。

## 决策

DeepSeek 被移除的是「硬接线的提供方」身份，而不是作为可选项被禁用。pi-ai 自带的约 30 个提供方中就包含 DeepSeek，因此它仍可像其他提供方一样被选用；消失的只是它的特权位置。

已移除：`llm-deepseek`、`deepseek-llm-api-extensions`、`plugin-package-inventory-deepseek`、`session-log-deepseek` 与 `web-search-deepseek` 这几个包；`agent-default-model` 的组合选择；以及 `web` 的 DeepSeek 搜索提供方，且不做替代——`web-search-exa` 与 `web-search-perplexity` 需要用户并不具备的密钥，而搜索本就不属于本产品的职责。

`agent-default-model` 以「无组合选择」的形态挂载。已经不存在诚实的静态默认值：默认值就是用户登录的那条路由，在登录时写入设置。若创建 Agent 时既无会话模型也无已存选择，它必须如实说明，而不是指向一条并不存在的路由。

因此 `packages/bundle/base/cordis.patch.yml` 与上游产生分叉。日后从上游合并时不得重新引入这些挂载。

## 备选方案

**保留 `llm-deepseek` 挂载但不做配置。** 用户将永远看不到 DeepSeek，那 382 份提到它的快照文件也不必再被审视。但一个无人能认证的已挂载适配器仍会出现在模型选择器和 `--dump-config` 中，首次运行流程也仍需为它写特例。为了不碰夹具而在代码树里留下一条死路由，正是那种会比其成因活得更久的债务。

**将其保留为仅供测试的依赖。** 这更省事；在快照语料看起来需要重新录制时，它一度颇具吸引力。事实并非如此：回放时适配器以 `disabled: true` 挂载，夹具根本不需要该包。一旦测清这一点，这个依赖买到的就只剩「能重新录制」——而重新录制无论如何都需要本项目并不具备的实时提供方。

**改用另一个网页搜索提供方。** `web-search-exa` 与 `web-search-perplexity` 都在，但二者都需要目标用户并不具备的 API 密钥，而网页搜索并不属于本产品的职责。交付一个无法搜索的搜索框，比不交付更糟。

**改写已录制的夹具，让它们指向另一个提供方。** 这会让 `grep deepseek` 返回空。同时也会让每一份录制都声称自己来自一个并未产生它的提供方——这是对这些文件未来每一位读者撒的谎。

## 影响

`snapshots/**` 下已录制的会话夹具仍带有 `deepseek-official`。那是历史，不是配置：回放时适配器以 `disabled: true` 挂载并读取已提交的 JSONL，因此这些录制照常可用，且不得被改写成来自另一个并未产生它们的提供方。十二份实时录制组合在没有适配器的情况下无法重新录制；`snapshots/recording-provider-required.mjs` 会把这一点变成清晰的失败，而不是令人困惑的崩溃。

`web/deepseek-search-llm-request` 是退役，而非删除。`session-format-v0-to-v1` 仍保留其 disposition 与载荷校验，因为移除之前录制的会话就在磁盘上，必须能继续迁移；已冻结的 released-v0 清单将其列入「不再由任何代码产生」的类型之中。

干净的部分 EOF 现在会被重试。被移除的适配器把它归类为 `STREAM_CLOSED` 并拒绝重试；pi-ai 将同一事件归类为 `TRANSPORT`，理由是连接在响应中途断开属于传输层截断，而非模型层错误。对读者而言毫无用处的截断响应，重试是更好的答案，并且始终受该路由 `retryPolicy` 的约束。
