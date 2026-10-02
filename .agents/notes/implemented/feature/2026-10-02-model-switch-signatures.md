# Agent Note: Google trace transfer and durable model exclusions

Status: implemented

English | [中文](2026-10-02-model-switch-signatures.zh.md)

## Problem

Gemini rejects unsigned function-call history during a model switch. Thought signatures belong to the producing model, while retired catalog entries can reject fallback requests with HTTP 404. A server restart can also forget daily exhaustion and spend another request rediscovering it.

## Decision

The adapter completes Google function-call signatures in the final request hook after pi-ai's conversion. pi-ai 0.85.1 removes cross-model signatures and rejects signatures that are not base64; therefore inserting Google's documented skip_thought_signature_validator placeholder into replay metadata would lose it before dispatch. The hook fills unsigned function-call parts and preserves valid same-model signatures. Durable content and replay metadata remain unchanged. This applies to every Google request, including fallback and user model changes, and to Vertex's matching request hook.

The recovery listener records MODEL_UNAVAILABLE for HTTP 404 and model-specific unavailable or not-found diagnostics, then continues the admitted step through the existing fallback eligibility and pin rules. Unavailable entries have no automatic expiry. Daily observations retain the provider reset zone and the next local reset date; comparisons use calendar dates so Pacific DST does not become a fixed 24-hour quota timer.

Host storageDomain persists provider/model exclusions in llm_pi_ai_recovery, version 1. Recovery awaits hydration before selection and awaits publication before retry. Request listeners detach and active recovery drains before the domain closes. Missing host storage preserves process-only behavior for minimal compositions; storage errors fail loudly. Observations remain process-wide across sessions and adapter remounts. Independent server processes and provider aliases do not coordinate.

## Alternatives considered

Reusing a foreign real signature violates the provider's trace ownership. Editing node_modules makes the fix disappear on installation. Altering durable replay metadata loses the producing model's valid signature when a user switches back. Treating retired models as daily exhaustion retries a permanently unusable entry every midnight. Keeping quota observations only in memory repeats failures after restarts.

## Consequences

Transferred function-call traces retain tool identities and results but omit the producing model's private reasoning state. Catalog entries unavailable to one account remain excluded for that provider/model in this host state, even if credentials later change. A deployment can explicitly remove the stored record to retry that entry. No credentials are stored. If every eligible entry is excluded, the terminal error names them and distinguishes resettable quotas from permanent unavailability.

The daily-quota fallback note remains active for pins, eligibility, thinking correction, and durable event ownership. This note partially supersedes its process-only durability and terminal replacement-model failures; it does not absorb the independent reasoning-correction decision. The free-tier pacing decision remains active for minute quotas.

Regression tests run the real Loader, Agent, pi-ai converter, and Google SDK with an external HTTP fake that rejects missing and foreign function-call signatures. Same-model, model-transfer, malformed signatures, quota fallback, retired-model skipping, and fresh-module restart hydration are covered. A real JSON state file proves durability; quota reset tests exercise the next Pacific calendar date. The existing truncated-tool-call fixtures retain their corrective result before subsequent requests. The accompanying report records commands actually run and sandbox limitations.
