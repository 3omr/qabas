# Agent Note: Same-step daily model fallback for student keys

Status: implemented

English | [中文](2026-10-02-daily-quota-model-fallback.zh.md)

## Problem

A free Gemini model can exhaust its daily request quota during one lecture even when minute-limit pacing succeeds. Each model has a separate daily allowance. Google's SDK also supplies MINIMAL when thinking is omitted, which some Gemini 3.x models reject with HTTP 400.

## Decision

The pi-ai plugin owns recovery on the existing Agent request and request-error waterfalls. `dailyQuotaFallback` defaults on only for the google route. Its reset zone is America/Los_Angeles; another enabled provider must declare an IANA reset zone. A process-wide provider/model observation expires when that zone's date changes, including daylight-saving changes. This avoids hardcoded request-count guesses and survives adapter remounts. Process restarts discard observations; aliases and separate processes do not share them.

AgentOptions.allowModelFallback=false explicitly pins routing; ModelSelectionRef.allowFallback=false pins an individual turn. A provider/model value alone is a preference, including Web and headless defaults. ACP prompt-admission selections forbid switching for their admitted turn. Web session model selections express preferences and permit recovery; a new selection invalidates the turn's pending recovery override. The failed admitted step keeps its messages, tools, and step number. The replacement route is the newest non-exhausted main writing model in the configured provider catalog; eligibility and stable numeric-version ordering mirror the Client rule without importing Client code. Preview and specialized models remain excluded, and fallback never crosses providers or adds models outside configuration. Exhausting every candidate produces DAILY_QUOTA_EXHAUSTED naming the attempted model and eligible catalog entries.

The durable `llm/model-fallback` payload contains turn, step, from and to routes ({provider, model, name}), and reason DAILY_QUOTA_EXHAUSTED. The subsequent request/header records the actual route and default reasoning. Chat renders one Chinese/English/Arabic line per event outside Compact folding. Existing request-header projection exposes the actual route as lastUsed; the Client change is the conversation line. The event is log-only and does not insert another user message.

Gemini 3.x defaults select low, medium, or high from declared SDK support; non-reasoning entries omit the SDK's implicit thinking configuration. A 400 explicitly naming an unsupported thinking level allows one correction per model/step to the next supported level, or off when declared. Off removes Google's disabled-thinking config instead of sending MINIMAL. `llm/thinking-fallback` records turn, step, provider, model, from, to, and reason UNSUPPORTED_THINKING_LEVEL before retry. Only successful assistant settlement teaches process-wide correction; the rejected explicit level uses its learned replacement, while other explicit efforts remain honored. A second rejection remains terminal. Direct LLM streams remain single-attempt.

## Alternatives considered

Switching after any quota or 429 would confuse minute pacing, account billing failures, and daily model exhaustion. Cross-provider fallback could spend an unrelated account's money and requires a different authorization policy. Treating every Web picker choice as a permanent pin prevents the student's ordinary preference from recovering mid-lecture. Always sending MINIMAL repeats an SDK default unsupported by the server. Unbounded thinking retries can conceal invalid request configuration and are refused.

## Consequences

Recovery changes model quality and provider cache identity, while preserving the admitted request history. Catalog knowledge cannot prove that a provider will serve an entry; non-quota failures on the replacement retain their normal error policy. Concurrent sessions may discover exhaustion simultaneously before the process has learned it. Correcting reasoning can increase thinking cost.

The existing free-tier-rate-limits note remains active for minute pacing and provider waits. Its statement that daily errors remain terminal applies to the generic retry executor; pi-ai's separate model-recovery listener owns eligible daily switches. The conversation-labels note remains active for failure classification. Neither decision is fully superseded or archived.

Loader composition with mocked external HTTP exercises same-step retry, exhausted-model skipping across sessions, terminal errors, provider defaults and pins, and thinking corrections. Clock tests cover Pacific summer/winter midnight and route/model isolation. Client tests pin localized event projection. The implementation report records gates actually executed and sandbox restrictions. Live free-tier requests are not used for deterministic quota evidence.
