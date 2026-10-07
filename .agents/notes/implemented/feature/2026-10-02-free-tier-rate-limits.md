# Agent Note: Student free-tier quota recovery

Status: implemented

English | [中文](2026-10-02-free-tier-rate-limits.zh.md)

## Problem

A Gemini transcription needs dozens of model requests. A five-request minute quota can interrupt a turn, while generic quota wording hides its temporary nature and short backoffs waste requests. Daily exhaustion requires a different student action.

## Decision

The pi-ai adapter identifies quota periods before generic quota errors. Daily exhaustion carries `DAILY_QUOTA_EXHAUSTED` and a model-specific diagnostic; the retry executor leaves it terminal in every mode. Non-Google pi-ai defaults use normal retries with `unlimitedCodes: [RATE_LIMIT]`, keeping other transient failures bounded. Explicit provider policy overrides remain available. The [Google chat wait decision](../bug-fix/2026-10-07-google-chat-wait-bounds.md) owns Google defaults.

A process-wide pacer learns positive request-count RPM from per-minute violations per provider route and requested model. Recent dispatch reservations include requests made before learning. Learned budgets enforce even spacing and a sliding minute window, survive adapter replacement, and are shared across sessions. Cancelled waits consume no reservation; failed dispatched attempts do. Daily and token-count quotas never supply RPM.

The longest provider wait is a lower bound plus configured positive jitter, independent of the local backoff cap. Durable retry events retain their existing payload union: unlimited-code attempts use always mode and omit maxRetries, while policyKey retains the normal provider policy. The existing Chat renderer consumes delayMs and failure.code. Web explicitly enables the base retry executor; desktop consumes the same composition.

The request-error action decision retains independent ownership of the recovery extension point. The active-note search finds no quota-pacing decision superseded by this feature. The authored recorded quota scenario uses the shipped headless profile. Direct ESM CLI replay succeeds; the existing snapshot subprocess harness exits without output, including for its existing retry baseline, and remains an unresolved verification limitation.

## Alternatives considered

Fixed five-RPM pacing throttles paid models without evidence. Learning avoids that cost. SDK retries hide attempts from durable history, so the existing step executor owns recovery. Default always-retry repeats permanent credential errors; selecting unlimited rate-limit codes retains bounded treatment of other failures.

## Consequences

The first rejection discovers the unknown quota. Knowledge is local to one process and provider/model route: other processes, aliases, or external users of the project can still cause rejections. Google SDK transports reject custom fetch and discard response headers; their JSON RetryInfo supplies waits. Custom-fetch protocols preserve HTTP Retry-After before SDK flattening.

Fake-clock tests cover parsing, daily classification, window expiration, concurrent reservations, cancellation, per-model/provider isolation, and provider waits above the local cap. Loader recovery exercises a fake 429 then success. The implementation report records checks run and sandbox limitations. The sandbox mounts .agents read-only, so this bilingual note pair is delivered under /tmp for later placement in .agents/notes/implemented/feature/.
