# Agent Note: Bounded Google chat waiting

Status: implemented

English | [中文](2026-10-07-google-chat-wait-bounds.zh.md)

## Problem

A short Google chat request can receive no stream event for more than two minutes. A real Gemini 3.8 Flash request produced no event during 123 seconds before user cancellation. A subsequent request received two HTTP 503 high-demand failures in about two seconds each, then stalled on another attempt. Five-minute idle intervals combined with extended overload retries make the wait difficult to distinguish from an application failure. The Chat classifier also interprets Google's high-demand `UNAVAILABLE` status as a retired model.

## Decision

The `google` route defaults to a 60-second stream-idle interval and two transient retries, with 1-second initial backoff and a 5-second local cap. The idle bound includes the first response and resets for delivered stream events. Explicit `streamIdleTimeoutMs` and `retryPolicy` remain authoritative. Route resolution applies these defaults without registering an unused provider or changing the selected model or reasoning effort. Other routes retain their provider policies.

Chat classifies overload before generic model-unavailable wording and localizes overload and timeout guidance. Only a scheduled retry promises automatic continuation. Terminal failures instruct the student to retry; cancellation remains available throughout provider waits.

## Alternatives considered

**Keep extended automatic recovery.** The [overload decision](../feature/2026-10-02-overload-backoff.md) and [minute-quota decision](../feature/2026-10-02-free-tier-rate-limits.md) preserve recovery mechanisms and configurable policies. Their extended defaults remain useful for other providers and explicit background-job settings, but make interactive Google waiting excessive.

**Switch models or disable reasoning.** Neither fixes the incorrect failure message or bounds a stalled transport, and both change the student's request without evidence that its settings caused the delay.

## Consequences

Persistent Google pressure ends after three attempts instead of waiting indefinitely for minute quota recovery. Long intervals without a stream event can fail even when the provider would eventually recover; deployments needing those intervals can configure a longer idle timeout and retry policy. Provider-directed minimum waits and learned RPM pacing can extend elapsed time, so this is not a total-turn deadline or a guarantee of external service latency.

[Loader recovery tests](../../../../packages/llm/llm-retry/tests/loader-composition.spec.ts) exercise Google overload and rate-limit exhaustion through the real loop with mocked HTTP and time. [Adapter tests](../../../../packages/llm/llm-pi-ai/tests/adapter.spec.ts) cover schema-resolved defaults and explicit overrides. [Chat regression tests](../../../../packages/client/ui-chat/tests/provider-failure.client.spec.ts) distinguish overload from unavailable models and scheduled from terminal timeout guidance. Released Session events and generations are unchanged.
