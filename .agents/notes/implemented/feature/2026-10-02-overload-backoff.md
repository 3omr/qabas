# Agent Note: Bounded recovery from provider overload

Status: implemented

English | [中文](2026-10-02-overload-backoff.zh.md)

## Problem

Free Gemini keys encounter HTTP 503 UNAVAILABLE with high-demand diagnostics for a minute or longer. Five retries starting at 500 milliseconds exhaust their local waits before this temporary load clears. Text-only overload diagnostics can also escape transient classification.

## Decision

The [pi-ai stream translator](../../../../packages/llm/llm-pi-ai/src/stream.ts) maps HTTP 503, UNAVAILABLE, high-demand wording, and overloaded diagnostics to OVERLOADED after terminal authentication, quota, missing-model, and invalid-request checks. Other HTTP 5xx errors remain SERVER; transport truncation remains separate.

The [provider policy schema](../../../../packages/llm/llm/src/retry-policy.ts) accepts normal-mode codeOverrides for finite eligible codes. Omitted values inherit normal settings; invalid code membership, overlapping unlimited codes, unknown fields, and invalid budgets or delays fail resolution. Resolved overrides are detached and frozen. Each overridden code has an independent durable retry history keyed by the complete provider policy and selected code. The existing retry event and projection formats remain unchanged.

Non-Google pi-ai routes default to eight OVERLOADED retries with 3-second initial exponential backoff, a 60-second local cap, and 10 percent jitter. The nominal local waits total 273 seconds. Explicit retryPolicy replaces the entire default. Provider Retry-After and RetryInfo remain minimum waits even above the local cap; attempt count remains bounded while provider instructions can extend elapsed time. Other transient failures keep five retries and 500-millisecond/10-second backoff. RATE_LIMIT remains unlimited by default on those routes. The [Google chat wait decision](../bug-fix/2026-10-07-google-chat-wait-bounds.md) owns Google defaults.

The [free-tier quota decision](2026-10-02-free-tier-rate-limits.md) remains active for unlimited rate-limit recovery, RPM pacing, and provider waits. The [daily model fallback decision](2026-10-02-daily-quota-model-fallback.md) remains active for daily exhaustion. Neither is superseded by overload handling.

## Alternatives considered

**Longer backoff for all transient failures** delays recovery from short socket drops and empty responses. Per-code settings restrict the extended wait to overload.

**Unlimited overload retries** can leave a lecture job waiting indefinitely during a lasting outage. The eight-retry budget ends persistent overload without changing unlimited minute-quota recovery.

**Google-only special handling** excludes equivalent overloads from other pi-ai providers. Classification and provider-neutral policy settings support every route.

## Consequences

Persistent overload takes several minutes to fail and can repeat billed requests. Cancellation and disposal retain the executor's cancellable waits. Provider instructions can exceed the nominal total; no wall-clock deadline overrides them.

Real Loader composition with mocked external HTTP and fake time verifies recovery after sustained overload, exhaustion at eight retries, provider waits above the cap, unlimited RATE_LIMIT, and explicit user settings. Resolver tests cover inheritance, immutability, and rejected configuration. Classification fixtures include Google RetryInfo and generic Retry-After. The [authored overload snapshot](../../../../snapshots/session/overload-retry-current/snapshot.yml) exercises durable per-code retry events over the shipped headless profile with short waits.

TypeScript and direct package Oxlint checks pass. Full package tests encounter blocked sockets and watchers; the pre-existing TOOL_CALL_TRUNCATED versus TRANSPORT expectation was aligned with truncation recovery afterwards. Build and documentation aggregates are blocked by tsx IPC. All 105 focused tests pass. Direct dsh headless replay through the supported ESM launch prints Recovered. and its normalized persisted log matches the new fixture; the existing snapshot subprocess harness still returns empty output. Bilingual content-hash checks pass, but read-only .git prevents pinning recovery blobs.
