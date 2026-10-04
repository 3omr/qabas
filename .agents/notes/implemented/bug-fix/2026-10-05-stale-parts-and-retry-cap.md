# Agent Note: Fresh redo, staged alignment recovery and bounded client retries

Status: implemented

English | [中文](2026-10-05-stale-parts-and-retry-cap.zh.md)

## Problem

A cached started-redo marker can make a new Redo reuse an earlier draft and stages. A saved read budget can exceed the current response allowance even when retained repair parts have independent alignment. Preparation can fail before returning a manifest, leaving salvage without a draft identity. Unbounded client retries hide repeated engine failures behind the last progress step.

## Decision

Redo archives the matching draft and stages under previous-drafts at entry, beneath the lecture lease, and keeps the existing final transcript until replacement succeeds. Internal retries and Continue preserve the new run's retained work. Direct begin redo calls also start fresh. Valid staged layouts restore their recorded segment budget when parts.txt and alignment agree. Unreliable stages move under stale-staged; the saved draft supplies bounded repair parts, or retained verbatim supplies a new guide. Read paging can reset an oversized budget independently of repair/write alignment; it never requests the previous max-part-bytes limit.

Draft resolution uses the cached unit manifest for module and lecture when no manifest path was returned. Explicit manifest paths remain authoritative. Salvage, deterministic repair and source recovery share that resolution.

The client admits three automatic retries by default, configurable through pipelineRetryLimit, with exponential delays based on chatRepairCancelGraceMs. Persisted retry counts survive reloads. Progress names the step being retried and attempt count. Exhaustion releases the job slot, reports a resumable stopped job and preserves the raw engine error in job.error. The fixed note is `Automatic retries stopped after repeated engine errors; your retained work is available through Continue.`; job.noteLine.retryLimit owns its localized tray wording.

This partially supersedes the unbounded engine-request retry policy in the [finalization note](2026-10-04-finish-always.md); that note remains active for validated salvage, figures and assessment retention. The [bounded-review note](2026-10-04-bounded-review-repair.md) remains active for retained-part size limits and review ownership.

## Alternatives considered

**Trust redo_started for a new Redo.** The marker identifies retained work for Continue, not the student's request to start fresh.

**Require a matching host limit or discard retained text.** Recorded segmentation can establish resume alignment; archival preserves uncertain stages while saved text supplies a fresh repair layout.

**Retry indefinitely or replace raw errors with a generic message.** A finite retry limit gives a visible end state; separate details retain evidence needed to diagnose storage and engine failures.

## Consequences

Synthetic regressions cover started-redo archival, independent repair/read budgets, missing alignment, recorded write-budget restoration, preparation failure before manifest return, finite retries with backoff, cancellation, tray wording and persistence. The read-only endo reproduction uses a private temporary copy: all thirteen Hyperthyroidism parts remain byte-identical in previous-drafts, begin returns the verbatim route, and execution reaches the writer before an injected offline stop. No student content enters repository fixtures. Full engine and client checks own the regression evidence; live NotebookLM and agy completion is outside this offline reproduction.
