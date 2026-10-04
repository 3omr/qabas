# Agent Note: Quota exclusions follow the key

Status: implemented

English | [中文](2026-10-04-quota-exclusions-follow-the-key.zh.md)

## Problem

Gemini daily quota exclusions survive replacing an exhausted account's key because recovery identifies observations by provider and model. A valid replacement key can fail before a request reaches Google. Learned minute budgets and cooldowns can also belong to the old account.

## Decision

The settings credentials controller awaits the serial `credentials/reference-reset` event after successful saves and removals, including replacement and repeated saves. A Gemini catalog check returning `works` awaits the same reset; failed and quota checks retain recovery. The event carries only the branded reference name, never a key or hash.

The pi-ai listener maps the reference to configured `apiKeyEnv` routes and to Google’s native `GEMINI_API_KEY` authentication when the Google profile has no explicit reference. This includes the Settings card’s `google: {}` profile and dormant Google routes. Recovery resets open the host domain on demand before clearing daily observations in memory and the `llm_pi_ai_recovery` domain. If storage is unavailable, the store retains the clear and later hydration deletes the provider’s old daily records instead of restoring them. Store writes and resets are serialized. The pacer forgets all model budgets, reservations and cooldowns for the affected route. Other providers, unavailable-model observations and successful thinking corrections remain.

Process-local reset revisions invalidate pending turn overrides and prevent late old-key responses or queued writes from restoring quota observations. Counters contain no credential information and require no durable format change. The listener drains with request recovery during plugin disposal. Reset failures reject the caller after the credential write commits; they cannot undo the saved key.

## Alternatives considered

**Use the existing update notification.** Update observers are not awaited and contain failures. A completed save can race durable clearing or conceal its failure. An explicit serial event preserves the existing notification behavior.

**Persist a credential fingerprint.** Hash attribution distinguishes concurrent accounts but requires credential identity throughout request admission, recovery and persisted records. Provider-scoped invalidation clears legacy exclusions without retaining credential-derived identifiers.

**Delete all recovery records.** Unavailable models and thinking corrections describe the model. Replacing a key does not invalidate them; clearing other providers also forgets unrelated accounts' limits.

## Consequences

Fresh generation requests can discover quota exhaustion again. Catalog success does not establish remaining generation quota. Resets cover controller operations; direct credential-provider writes, external file edits and ambient environment changes do not call this event. Separate processes retain their own rate knowledge.

The [daily model fallback](../feature/2026-10-02-daily-quota-model-fallback.md), [free-tier pacing](../feature/2026-10-02-free-tier-rate-limits.md) and [authenticated key checks](../feature/2026-10-03-lecture-visibility-and-key-checks.md) decisions retain their independent routing, pacing and authentication rationale. This note owns credential invalidation; none is fully superseded.

Fake-HTTP Agent regressions cover saves, replacements, removals, successful and failed checks, and late old-key quota responses. Loader regressions include the Web host’s native Google route, sibling Settings Controller and pi-ai-before-storage load order after restart. The committed implementation fails these restart regressions because it does not map native Google authentication to the reset. Recovery-store tests cover memory-only operation, hydration, queued writes and persisted deletion across restart in temporary storage. Pacer tests preserve other providers' limits. Verification results and sandbox limitations are recorded in the implementation report.
