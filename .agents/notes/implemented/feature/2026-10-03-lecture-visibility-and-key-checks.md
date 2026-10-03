# Agent Note: Reversible lecture visibility and authenticated Gemini key checks

Status: implemented

English | [中文](2026-10-03-lecture-visibility-and-key-checks.zh.md)

## Problem

Removing a manual lecture definition makes its recordings reappear through automatic grouping. Automatic units have no removal operation. Existing transcripts can also reappear as orphan rows. Gemini catalog discovery uses a built-in model list and does not establish whether a saved key works. Provider exhaustion messages can contain unavailable-model wording even when every model has exhausted its daily quota.

## Decision

The engine owns reversible visibility in module.json. hidden_recordings contains safe names relative to Lecture/. hide_lecture resolves the manual id or title against the complete local and cached NotebookLM inventory, hides every recording and removes the definition in one locked atomic write. restore_recordings removes selected names without reconstructing definitions. Hidden recordings cannot be claimed by definition or organization writes until restored, remain flagged in file inventory, and are excluded from unassigned sources. A partially restored group contains only visible recordings.

hidden_transcripts retains recording associations for existing legacy transcripts whose custom titles lose their manual definition. Recording provenance, stored associations and fully hidden units suppress orphan transcript rows. Source files, NotebookLM sources and transcripts remain unchanged. The Host and Client data APIs expose hide and restore through the existing registry process runner; callers reload the affected module after success.

The credentials Remote resolves GEMINI_API_KEY on the Host for every explicit check, sends it only in the x-goog-api-key header of one fixed Gemini model-catalog request, and returns only a safe status. Its configured five-second default deadline includes body consumption; cancellation reaches fetch. No redirect, key value, provider body or exception text is returned. Quota results identify daily or per-minute limits when the response supplies evidence and otherwise report unknown. Catalog authentication does not establish generation quota or model access.

The library classifies explicit daily reset, DAILY_QUOTA_EXHAUSTED and exhausted-model diagnostics before generic unavailable messages. Its reset helper returns the next Pacific midnight with daylight-saving changes. The Accounts helper and library helper share expected reset fixtures while remaining separate values because this change adds no dependencies. UI controls and rendering remain owned by their consumers.

## Alternatives considered

**Delete recordings or NotebookLM sources.** Removing a lecture from view is reversible organization, not destruction of student data or remote sources.

**Store hidden lecture titles alone.** Automatic grouping can change titles and manual definitions can be removed. Recording identity supplies the persistent visibility authority; legacy transcript associations preserve only the missing provenance needed for existing files.

**Use model discovery as key validation.** The built-in catalog needs no authenticated request and cannot validate a credential. The credentials Remote already owns stored-key resolution and the Accounts client already calls it, avoiding a Python or provider-discovery coupling.

**Generate text to test a key.** The catalog request verifies authentication without spending a generation request. It intentionally gives no remaining-generation-quota promise.

**Share quota code through a new package dependency.** The two UI packages have no suitable common utility dependency for this function. The small duplicated calculation and common fixtures respect the dependency constraint without importing another UI plugin's values in production.

## Consequences

The [lecture manager](2026-10-02-lecture-manager-wiring.md), [library inventory](2026-10-02-library-single-call-and-organization.md), [daily model fallback](2026-10-02-daily-quota-model-fallback.md) and [conversation labels](2026-10-02-qabas-conversation-labels.md) decisions retain their independent ownership and alternatives. This note extends their data operations and failure classification; none is fully superseded.

Restoring recordings can expose automatic groups or orphan transcripts because it does not reconstruct a custom definition. The hidden transcript association is additional module metadata and follows recording renames and removals. A catalog check can succeed while generation fails later; live Google acceptance remains an integration check requiring a key and network access. Deterministic tests use fake HTTP responses and observe exact safe statuses, current credential resolution, timeout and cancellation.

Python tests cover local and remote-only units, partial restoration, legacy and provenance transcripts, definition ownership refusals, unsafe persisted metadata, atomic-write failure, and direct CLI/MCP operations. Host and client tests cover wire admission, result validation, hidden flags, callbacks, safe key results, provider failures and Pacific reset dates. No Session or model request is required for the explicit data calls.
