---
description: "The LLM capability group: a provider-neutral model-call service, the pi-ai provider adapter, request-retry execution, and replay-aware token measurement."
kind: "package-group"
---

# llm/ — LLM capability family

English | [中文](README.zh.md)

## Summary

The llm group provides the harness's model-call capability: one provider-neutral service through which any composition streams requests to a model provider, plus the pi-ai adapter, retry execution, and measurement. The core `llm` package defines the message, content-block, and stream-chunk vocabulary every plugin and the session log use; the pi-ai adapter translates configured provider wire formats into that vocabulary; `llm-retry` re-runs failed requests at durable agent-step boundaries; and `token-meter` measures request and context pressure from the durable log. This page maps the group; each package README owns its per-package contract.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`llm/`](llm/README.md) | Streams one model call through a registered provider adapter and shares the harness message, block, and chunk vocabulary | `ctx.llm` |
| [`llm-pi-ai/`](llm-pi-ai/README.md) | Serves configured provider routes through pi-ai catalogs and wire protocols, including hand-declared gateways | registers on `ctx.llm` |
| [`llm-retry/`](llm-retry/README.md) | Retries failed model requests under each provider's policy at durable agent-step boundaries | listens to `agent/request-error` |
| [`token-meter/`](token-meter/README.md) | Measures request and context pressure from the durable session log with a fixed heuristic | `ctx.tokenMeter` |

-----

<a id="related-documentation"></a>
## Related documentation

- [LLM streaming subsystem](../../docs/subsystems/llm-streaming.md) — the message and block types, the assembled model request, the `StreamChunk` protocol, and the adapter contract.
- [Token meter subsystem](../../docs/subsystems/token-meter.md) — the measurement semantics behind `ctx.tokenMeter`.
- [Fork composition divergence](../../.agents/notes/implemented/architecture/2026-09-20-deepseek-provider-removal.md) — why this fork ships one adapter and no static model route.
- [Routed model context](../../.agents/notes/implemented/architecture/2026-07-20-routed-model-context-and-compaction-policy.md) — how the loop routes model requests and compacts context.

<a id="dev-note"></a>
## Dev Note

None.
