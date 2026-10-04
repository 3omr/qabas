# Agent Note: Bounded transcript review repair

Status: implemented

English | [中文](2026-10-04-bounded-review-repair.zh.md)

## Problem

An unattended lecture can fail review when loose slide renders demand links that its current extractor does not select. Manual definitions can name a deck without a legacy slide mapping. Asking a chat model to resubmit an 80 KB transcript invites incomplete tool JSON and exhausts the desktop loop's two-response truncation limit.

## Decision

The [engine](../../../../engine/README.md#bounded-review-repair) uses the current lecture title's extraction manifest as its slide inventory. Empty selections require no links; every selected raster requires its file and link. Loose rasters and old-title directories have no authority. Review extracts absent, invalid or incomplete manifests. Extraction refreshes layout and exact recovery metadata only when recording bytes and staged assignments remain unchanged. Manual decks resolve from definition materials by id or title; extraction by id writes under the definition title.

Anchored findings locate retained parts; other findings list guide placement candidates or document-wide part numbers. Review, validation, provenance and finalize failures direct staged replacement, from_parts review and both checks. Inline review rejects submitted or saved drafts over 20,000 UTF-8 bytes. read_draft(staged=true, part=N) retrieves a retained part. Saved drafts without layouts acquire 8 KB repair parts without model regeneration. These preserve bytes and use whole-guide substance checks rather than claiming recording-segment alignment. agy refuses to remap these saved repair parts; the chat writer replaces their bounded text with stage_draft_part.

The [truncation recovery decision](../feature/2026-10-02-truncated-tool-call-recovery.md) retains its two-response bound. The [external illustration decision](../feature/2026-10-04-web-figures.md) retains approval and attribution rules; slide evidence uses the current manifest inventory. Neither note is superseded.

## Alternatives considered

**Count loose rasters across recording names.** Stale renders then constrain current extraction and renamed lectures inherit old requirements.

**Resubmit the complete transcript.** Providers can truncate JSON before dispatch, so server size checks alone cannot rescue the call. Tool instructions must select part repair before generation.

**Regenerate every saved draft with agy.** This requires available verbatim sources and repeats work on unaffected text. Retaining bounded existing parts also supports drafts without verbatim sources.

**Raise desktop truncation retries.** Repeating oversized calls does not make them smaller. Engine recovery preserves bounded harness failures.

## Consequences

Review can spend one extraction attempt and reports converter errors with bounded retry guidance. Figure placement still requires the writer to identify the discussed topic; diagnostics do not verify semantic placement. Findings without exact anchors require candidate-part inspection. The inline ceiling cannot prevent truncation before tool dispatch; model-visible part instructions address that earlier failure.

Synthetic temporary-directory tests cover stale rasters, empty and incomplete manifests, manual deck lookup, automatic extraction, UTF-8 limits, retained-part reads, exact recovery and targeted replacement. Student files are never written or copied into fixtures.

## Follow-up: retried topics and cancellation

A real Shock redo timed out on the topic call and cached the fallback, so every later run repeated the cohort-separated guide. Transient topic failures are now recorded as attempts and retried on the next run; only a current-parser refusal with at least two attempts is cached, following the [self-repair decision](2026-10-04-engine-self-repair.md). Stopping a job did not stop the writer: the long-lived MCP server kept launching `agy` parts. Long agy work now runs under the request's cancellation, kills the agy process group on `notifications/cancelled`, and keeps staged parts.
