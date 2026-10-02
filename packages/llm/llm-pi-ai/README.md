---
description: "The pi-ai-backed multi-provider adapter for users and maintainers routing the harness LLM service through pi-ai catalogs and hand-declared gateways."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-pi-ai

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-llm-pi-ai` routes model requests to multiple pi-ai providers, OpenAI-compatible gateways, or self-hosted servers from one configuration. Installed pi-ai providers supply endpoint, protocol, and model-catalog defaults; custom routes can declare those values without code changes. Profiles and credentials are resolved for each request, so settings changes take effect on the next request without a restart. Supported providers can use stored OAuth or interactive-key sign-in with cross-process refresh locking. The package may start with no routes and activate when user settings add them.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when a composition routes model requests through pi-ai's provider catalogs or through gateways that pi-ai's installed catalog does not describe. The `providers` dictionary is the whole configuration surface: each key is the provider route name a request selects with `GenerateOptions.provider`.

### When to choose it

This is the only model adapter mounted by the fork's base composition. It serves several providers through pi-ai's catalogs, corrects catalog facts when needed, and reaches hand-declared gateways through their own endpoints and protocols.

### Configure provider routes

Each profile may set a `retryPolicy`; omission uses normal mode with five retries for transient failures and unlimited `RATE_LIMIT` retries. An explicit policy replaces this default; `unlimitedCodes: [RATE_LIMIT]` preserves quota recovery with a custom normal policy. `apiKeyEnv` is a credential reference resolved per request through the harness credential seam, so no secret enters the configuration file; a reference that resolves to nothing fails the request with `MISSING_CREDENTIAL`. Omitting it leaves the route configured-but-keyless, which for an installed catalog route defers to pi-ai's provider-native ambient discovery.

`dailyQuotaFallback` defaults to `true` for the `google` route and `false` elsewhere. Google resets at midnight in `America/Los_Angeles`; another enabled route must set `dailyQuotaResetTimeZone` to its provider's IANA zone. Exhaustion is remembered by provider/model until that local date changes. When the host provides `storageDomain`, observations are written to its routed `llm_pi_ai_recovery` state unit before retry and loaded before routing a request, so server restarts preserve the quota date and reset zone. Compositions without that service retain process-only memory. Recovery retries the same admitted step with the newest eligible main writing model in the configured catalog, excluding preview, lite, image, live, audio, TTS, embedding, computer-use, deep-research, customtools, banana, and Gemma entries. Catalog order breaks equal-version ties. An explicit `AgentOptions.allowModelFallback: false` or turn-pinned `ModelSelectionRef.allowFallback: false` forbids switching; a Web session model selection is a preference. A user selection during recovery cancels the pending override. A provider 404 or a diagnostic naming a model as not found or unavailable marks that model unavailable permanently in process memory and host storage; fallback continues within the same step and skips it on later requests. Each switch records `llm/model-fallback` with `DAILY_QUOTA_EXHAUSTED` or `MODEL_UNAVAILABLE`. If no eligible model remains, the terminal error lists the excluded models and reports `DAILY_QUOTA_EXHAUSTED` when any quota can reset, otherwise `MODEL_UNAVAILABLE`.

For Gemini 3.x, provider-default reasoning uses the lowest supported level from low, medium, and high; models without declared reasoning omit thinking configuration. A 400 naming an unsupported thinking level permits one correction per model/step to the next declared supported level, or to `off` (omit thinking configuration) when available. `llm/thinking-fallback` records the correction before the retry. Successful corrections are remembered per provider/model in this process, including replacement of the rejected explicit effort; other explicit efforts remain honored. Direct `llm.stream()` calls remain single-attempt.

```yaml
- name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      openai:
        apiKeyEnv: OPENAI_API_KEY
        baseURL: https://proxy.example.com:8443
        reasoning: high
        requestImagePixelBudget: 4194304 # total pixels; 2048 by 2048 default
        requestImageMaxBytes: 1048576    # raw bytes before base64 expansion
        maxRequestImageBytes: 20971520   # accumulated base64 payload
        retryPolicy:
          mode: normal
          maxRetries: 3
      anthropic:
        apiKeyEnv: ANTHROPIC_API_KEY
        models:
          - id: claude-sonnet-4-5
            contextWindow: 200000
      acme-gateway:
        displayName: Acme Gateway
        apiKeyEnv: ACME_GATEWAY_API_KEY
        api: openai-completions
        baseURL: https://gateway.acme.example/v1
        compat:
          thinkingFormat: deepseek
        models:
          - id: acme-think
            name: Acme Think
            contextWindow: 262144
            reasoningEfforts:
              off:
              high: high
```

| Field | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | absent | Credential reference resolved per request; omission defers to pi-ai ambient discovery |
| `displayName` | provider name | Label shown by selector surfaces |
| `api` | catalog protocol | Wire protocol; only needed for routes the catalog does not supply |
| `baseURL` | catalog endpoint | Endpoint of every model on the route |
| `models` | installed catalog | Replaces the route's catalog wholesale; each entry defaults from the installed model |
| `modelOverrides` | none | Reshapes individual installed-catalog models without replacing the rest |
| `compat` | catalog detection | Wire-compatibility switches for unrecognized endpoints |
| `defaultContextWindow` | `262,144` | Capacity fallback for undescribed models |
| `defaultMaxTokens` | `32,768` | Output-cap fallback for undescribed models |
| `requestImagePixelBudget` | `4,194,304` | Total-pixel budget for each deterministic request image |
| `requestImageMaxBytes` | `1 MiB` | Encoded-byte target for each request image before base64 expansion |
| `maxRequestImageBytes` | `20 MiB` | Aggregate base64 image-payload bound with oldest-first offload |
| `dailyQuotaFallback` | `google`: true; others: false | Allow same-provider daily-quota switches for unpinned Agents |
| `dailyQuotaResetTimeZone` | `google`: `America/Los_Angeles` | Required IANA reset zone for other enabled routes |
| `retryPolicy` | normal, 5 retries; unlimited rate limits | Provider-owned retry policy executed by `dsh-llm-retry` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-pi-ai) is the exhaustive source for every accepted field and its JSDoc.

### Sign in to a provider

A provider pi-ai ships a login for can be signed into through the harness authorization seam: the flow offers OAuth or an interactive key prompt (a key is typed into pi-ai's own login prompt, not into the settings form), and the resulting credential is stored in the harness credential store at `llm-pi-ai/<provider id>`. The stored sign-in authenticates its route beneath any `apiKeyEnv` override and refreshes itself under the store's cross-process lock; signing out deletes the stored record. A hand-declared route key outside the record grammar — a lowercase hyphenated identifier — cannot be signed into, because a record write for it refuses with `LlmError('UNSTORABLE_PROVIDER_ID')`; such a route authenticates through `apiKeyEnv` or ambient provider settings instead.

### Resolve the model catalog

A profile's `models` list replaces the route's installed catalog rather than extending it; each entry defaults its unset fields from the installed model of the same id, so narrowing a route to two models, correcting one capacity, or adding a model newer than the installed catalog are one-line edits. `modelOverrides` reshapes individual installed-catalog models without that cost — correct one model, keep the other thirty-seven — and is refused when set beside a `models` list, on a hand-declared route, or naming a model the catalog does not describe, because a silently unchanged model would be a typo someone hunts for later.

### Run with reasoning and wire compatibility

`reasoningEfforts` declares a model's selectable thinking levels: each key is a level selectors offer, its value the spelling dispatch sends on the wire, so `max: ultra` renames a level for a gateway with its own vocabulary. Omitting the field keeps the installed catalog entry's capability; `false` declares a non-reasoning model. `compat` switches reshape the request for endpoints pi-ai cannot recognize — which role carries the system prompt, which field caps output, how a thinking level travels — configurable per route and per model. A model neither the entry nor the installed catalog sizes takes the route's `defaultContextWindow` and `defaultMaxTokens` fallbacks.

For self-hosted Chat Completions endpoints, `thinkingTokenBudgetField` selects the reasoning-budget parameter, and `vllmPriority` sets an integer scheduler priority when the server enables priority scheduling. Template arguments accept `$var: thinking.budget`. `openai-responses` gateways can set `supportsMaxOutputTokens: false` to omit `max_output_tokens`; Azure and Codex transports ignore this shared compatibility field. These controls are opt-in; catalog-owned Anthropic effort and fallback capabilities are not configurable switches.

### Change configuration at runtime

Profiles are re-read once per operation through the optional settings seam: the base and the user's `llm-pi-ai:` settings section merge per provider, so a user can add a route, override one field of a composition route, or point a route at another proxy, all effective on the next request with no restart. A section the adapter could not serve is refused where it is written — `settings.mutate` answers `settings-rejected` — and a stored section that later fails keeps the namespace's last good value. When the route set or a route's retry policy changes, the plugin re-registers atomically: a conflicting route leaves the previous routes serving.

### Discover models from endpoints

The plugin answers "which models can this provider serve?" for a route a configuration surface is editing or drafting. A route the installed catalog ships is answered from that catalog with no network call; only a route the catalog does not describe is interrogated over the wire. `openai-completions` and `openai-responses` use `GET {baseURL}/models` with bearer auth, while `anthropic-messages` uses native `GET /v1/models?limit=1000` semantics with `x-api-key` and `anthropic-version`; its listing URL accepts the API root with or without a trailing `/v1` because gateway documentation publishes both spellings, and only that listing URL normalizes the segment, so model requests receive the configured `baseURL` unchanged. A named configured route supplies its stored credential and profile `headers` inside the Host, so deployment headers configured through `settings.yaml` or Cordis config reach model discovery without becoming discovery-request or Models-page fields; a key typed into the form still wins over the stored credential. The parser accepts either the standard `data` array or an enriched `models` map, normalizing each candidate's id, display name, context window, and output-token cap; Anthropic's `max_input_tokens` and `max_tokens` feed the same capacity fields, a map key remains the request id even when its entry names a different canonical id, primitive-valued map properties are ignored, and a missing display name falls back to that request id. The reply is candidate metadata a surface may offer for adoption — nothing is stored, and `settings.yaml` remains the only thing that decides what a route serves.

### Failures and recovery

Google per-minute quota violations map to `RATE_LIMIT` before generic quota wording; per-day violations map to terminal `DAILY_QUOTA_EXHAUSTED` with the model named in the message. UI consumers can localize that stable code and offer a daily-reset wait or a model switch. RetryInfo `retryDelay`, “Please retry in Ns”, and exposed HTTP `Retry-After` values supply `failure.providerRetryAfterMs`; the longest instruction wins. Custom-fetch protocols retain error-response headers before pi-ai flattens SDK errors. Google SDK transports reject custom fetch and expose quota waits through their JSON body; headers discarded by those SDKs cannot be recovered.

The process-wide pacer in [`src/pacer.ts`](src/pacer.ts) learns positive request-count `quotaValue` values from `PerMinute` quota ids, separately for each provider route and requested model. Unknown budgets do not throttle. Learned budgets survive adapter replacement, and all sessions share atomic reservations, even spacing, and a sliding 60-second window that includes failed dispatched requests and recent requests made before learning. Concurrent waiters recheck availability; cancellation consumes no reservation. Daily and token-count quotas never become RPM budgets. Restarting the process forgets learned quotas; separate processes, project aliases, and other clients using the same key require their own coordination.

A route pi-ai does not ship needs `api`, `baseURL`, and a non-empty `models` list; an unserviceable profile is refused where it is written, naming the route and model. Failures carry stable codes: a credential that cannot be used fails with `INVALID_CREDENTIAL` naming the route and reference, a route whose `apiKeyEnv` reference resolves to nothing fails with `MISSING_CREDENTIAL`, an unconfigured model fails with `UNKNOWN_MODEL`, and terminal provider failures distinguish `QUOTA` from transient `RATE_LIMIT`. `GenerateOptions.stop` is rejected with `UNSUPPORTED_OPTION` because pi-ai's common streaming UI cannot guarantee it across providers.

Settings writes strictly validate each new or changed provider after merging its composition and user layers. During namespace registration, stored catalog failures retain the namespace and provider rows, with the first available model diagnostic or route failure in `LlmConfigurableProvider.error`; unchanged failed providers do not block edits elsewhere. Serviceable models remain selectable, while unresolved models remain in the editable configuration and fail with `INVALID_CONFIG` before network I/O if requested directly. Repairing or deleting the offending configuration clears its diagnostic. Schema and self-contained profile errors still reject loading. Later external edits validate changed providers and retain the last accepted section on failure.

Changing `displayName`, `apiKeyEnv`, or `baseURL` without resolving the provider's model errors still rejects the save. For example, renaming an OpenRouter route whose model `111` needs an `api` cannot be saved on its own: repair or remove that model in the same editor draft, then save the complete provider configuration. Intermediate repairs remain in the draft until the whole provider validates; other providers can be saved independently.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the adapter; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The adapter is built on immutable snapshots and per-operation resolution. Each operation captures a whole snapshot — the profiles plus a `createModels()` collection holding the `Provider` each route built — before its first `await`, and a configuration change builds a new collection rather than mutating the one in use, so a request that started under one configuration never finishes under another. A route's own credential reference resolves through the harness seam and rides as the request's `apiKey` option, which pi-ai treats as the highest-priority auth override — that is what keeps the fail-loud reference semantics. Everything that override does not cover reaches pi-ai through the collection's own auth: the credential store holds the records a login wrote and a refresh rotates (addressed as `llm-pi-ai/<provider id>`), and the auth context answers the ambient questions a provider asks while resolving. Both are stable across snapshots, so a configuration change rebuilds the collection without forgetting who is signed in.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: profile resolution, settings wiring, directory and route registration |
| [`src/auth.ts`](src/auth.ts) | The credential store and ambient auth context over the harness credential plane |
| [`src/login.ts`](src/login.ts) | Authorization flows for the installed providers that ship a login |
| [`src/config.ts`](src/config.ts) | Profile schema, resolution, and serviceability checks |
| [`src/catalog.ts`](src/catalog.ts) | Installed-catalog integration and drift gates |
| [`src/provider.ts`](src/provider.ts) | The supported-protocol table and provider construction |
| [`src/context.ts`](src/context.ts) | Harness-to-pi-ai context conversion, image handling, replay restore |
| [`src/stream.ts`](src/stream.ts) | pi-ai event conversion into harness `StreamChunk` values |
| [`src/replay.ts`](src/replay.ts) | Versioned `ReplayEnvelope` storage and validation |
| [`src/discovery.ts`](src/discovery.ts) | Endpoint interrogation for configuration surfaces |

### Registration and directory

The plugin declares every installed catalog provider it can authenticate in the configurable-provider directory, joined with every route the current profiles declare, so configuration surfaces can offer the full catalog before any route exists. Each entry carries `declared` — whether pi-ai ships nothing under that key — because only the adapter can distinguish a hand-declared route from a narrowed catalog route. Route registration is atomic: a candidate set that collides with another adapter leaves the previous routes serving. A bare mount with zero routes is the dormant posture: nothing registers until a settings section supplies profiles, and routes drop when it empties.

### Replay and vocabulary

Successful assistant responses store a versioned, lossless-JSON replay state beside the provider and model that produced them — response-level facts plus one per-block entry per streamed block. At request time, `LlmRuntime` passes replay state only when the same adapter instance owns both routes; the adapter validates it and restores native response ids, provider signatures, and optional `providerThinkingLevel` effort metadata, keeping absent effort metadata absent. Replay validates the requested model identity against the assistant source and separately restores an Anthropic response model when the provider resolved an alias or fallback. An unusable state degrades to provider-neutral content instead of failing the request. Google requests preserve valid same-provider/model function-call signatures. After pi-ai removes foreign or malformed signatures, the final Google request hook supplies `skip_thought_signature_validator` for unsigned function calls, including history transferred by fallback or a user model change. The placeholder stays request-local; durable replay metadata is unchanged. [Google documents transferred traces](https://ai.google.dev/gemini-api/docs/thought-signatures). pi-ai tool-call arguments are parsed objects, so the adapter parses input and re-stringifies output to the harness raw-JSON convention; pi-ai in-stream error events map to terminal `finish` chunks.

Tool calls stopped by `length`, incomplete argument JSON at stream end, and the Google SDK’s `Incomplete JSON segment at the end` diagnostic produce `TOOL_CALL_TRUNCATED`. Diagnostics name the exposed tool and count streamed raw argument characters. The adapter supplies no native replay state for these failed responses. Google’s SDK can buffer a whole function call until its JSON segment completes; when that buffer is lost, the adapter cannot report its tool name or size. The agent-loop provides bounded corrective feedback for both exposed and buffered calls.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the service contract to this adapter and the shared types.

- [dsh-llm service](../llm/README.md) — the provider-neutral service this adapter registers on.
- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — the `StreamChunk` protocol and adapter contract.
- [llm-retry](../llm-retry/README.md) — the retry executor that applies each profile's `retryPolicy`.
- [Fork composition divergence](../../../.agents/notes/implemented/architecture/2026-09-20-deepseek-provider-removal.md) — why this fork ships one adapter and no static model route.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-pi-ai) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Provider request through pi-ai

#### What the model sees

The selected catalog model receives one system prompt (`GenerateOptions.system`, otherwise the text of a leading `system` history message; a leading system message with empty text sends none), the remaining history, tools, and sampling fields supported by pi-ai's common streaming API. Each retained image is preceded by text naming its complete attachment id and actual request dimensions. When the current execution filesystem maps the attachment provider's host object, the text also carries a read-only normalized-object path and warns that normalization or request projection may have resized or re-encoded the upload. When accumulated base64 image payload exceeds the route's `maxRequestImageBytes`, each offloaded image keeps its own identity and currently resolved access in replacement text. Offloaded normalized attachments are not read or transformed. Provider-native replay metadata is restored only when the adapter validates it for the historical content.

#### Token effect

Provider tokenization governs exact input. Retained images add the stable attachment and coordinate descriptor; the offload placeholder replaces an omitted image's visual tokens. Replay metadata may let a native API reuse provider-side state.

#### KV Cache effect

Conversion preserves logical request order, while image handles and offload placeholders add model-visible text. A changed execution-world path rewrites a historical handle and can prevent reuse from that image even when attachment identity and request bytes stay stable. Changing adapter instance, provider, model, or another upstream token has the same suffix effect. Crossing the image bound replaces an earlier image with placeholder text, so reuse ends at that message until the offloaded prefix stabilizes. Each `llm/model-fallback` preserves the admitted messages and tools; the replacement model has a different provider cache identity.

### Provider response

#### What the model sees

pi-ai events become harness reasoning, text, tool-call, usage, and finish chunks. The adapter passes parsed tool arguments to the harness as raw JSON strings.

#### Token effect

Generated content affects later inputs only after the loop records it. pi-ai folds reasoning tokens into output usage when the provider does not report them separately, and preserves its exact `totalTokens` value unchanged.

#### KV Cache effect

Recorded response content appends to the next request and does not invalidate its earlier reusable prefix. Unrecorded transport metadata and usage accounting do not affect cache identity.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the adapter stops and future work begins. They are current package constraints, not a general pi-ai comparison or a task backlog.

- **`maxRequestImageBytes` counts base64 image payload only** — text, tools, descriptors, and JSON structure ride outside the bound, so it must sit below the gateway's request-body cap with headroom. Offload is a deterministic request projection and is not recorded as a session event.
- **A sign-in lives only in the process that started it** — an authorization attempt is not durable, so reloading the page mid-login abandons it and the human starts over. Signing out is `deleteRecord` on the stored record, which forgets it locally without telling the issuer.
- **Provider-native discovery answers through this plugin's ambient context** — a route naming no credential defers to the catalog provider's own resolution, which asks for environment values (`AZURE_OPENAI_API_KEY`, `AWS_PROFILE`, and each provider's own set) and for local credential files. Both questions are answered here: the credential seam is consulted before the process environment, and file existence is checked against the host process's filesystem with `~` expanded. What it cannot do is *read* a credential file's contents — a provider that parses `~/.aws/credentials` itself does so directly, outside the seam.
- **Settings can add or override routes, not remove composition routes** — the user layer merges over the composition base, so deleting a `cordis.yml`-provided provider is a composition change.
- **The layered merge has no delete for dict keys** — a `reasoningEfforts` level, `modelOverrides` entry, or `compat` field the base declares can be overridden but not removed by the user layer.
- **`headers` can carry a credential the redactor never sees** — profile resolution rejects names and values Fetch cannot represent, but the dict remains plain strings; store credentials as `apiKeyEnv` references.
- **A route's catalog never refreshes itself** — the catalog is whatever `settings.yaml` says; nothing here queries a provider for the models it serves.
- **Anthropic discovery reads at most 1,000 models** — the request uses the API's maximum page size but does not traverse `has_more`; entries beyond the first page must be added by hand.
- **One wire protocol per route** — a mixed-protocol catalog route cannot host a model of the other protocol; splitting the provider across two route keys is the workaround.
- **A modality declaration is not verified** — a model declaring `image` its gateway does not serve is refused by the provider after prompt admission. The durable image remains in history and the same misdeclared model can fail again; switching to a text-only model remains possible because the shared LLM runtime projects image references into stable text for that request.
- **An unauthenticated route depends on its protocol** — a route naming no credential resolves as configured-but-keyless, but pi-ai's OpenAI-compatible implementation still requires an API key or an `Authorization` header, so a keyless local server needs a placeholder credential referenced by `apiKeyEnv` or an `Authorization` entry in `headers`.
- **`GenerateOptions.stop` is unsupported** — pi-ai's common stream options cannot guarantee stop-sequence behavior across providers.
- **Only a leading in-history `system` message becomes pi-ai's `systemPrompt`** — pi-ai has one system slot, so a later `system` message, or a leading one when `GenerateOptions.system` is also set, folds into a `user` message at its position; provider-specific placement of the prompt follows pi-ai rather than a harness-owned wire override. Images in system or assistant history, including the leading system message, fail with `UNSUPPORTED_CONTENT` on both conversion paths.
- **Provider HTTP status is unavailable** — pi-ai error events do not expose a stable HTTP status across providers.
- **Retry policy is provider-owned, not an SDK retry** — pi-ai SDK retries stay disabled so durable agent steps and `llm/retry` events own every visible attempt, and direct `ctx.llm.stream()` calls remain single-attempt.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The offered protocol set is deliberately narrower than pi-ai's full API set: Bedrock, Vertex, Azure, and Codex authenticate through flows a profile cannot completely describe with a key, an endpoint, and headers; catalog routes still reach them through their own provider, and only an explicit override is refused. Codex is sign-in-able through the authorization flow's OAuth grant.
- The `compat` switch set is pinned to pi-ai's compat types by drift gates; an upstream upgrade that adds a field, gives a further protocol a compat type, or widens a value union fails the build until someone classifies it.

</details>

**Runtime invariant:** No companion is published. This package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam.
