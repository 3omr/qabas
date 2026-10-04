# Agent Note: Part progress and finalized lecture job outcomes

Status: implemented

English | [中文](2026-10-04-part-progress-and-finalized-jobs.zh.md)

## Problem

A part-writing MCP call lasts several minutes per part, while a tool-count progress bar advances only when the call returns. A successfully finalized lecture can also be misreported as failed when the provider refuses the closing summary. Assessment generation can omit relevant sourced clinical cases when only some sub-questions are taught.

## Decision

MCP progress is informational Session data correlated by root and running call ids. The SDK owns request progress tokens and callback disposal. Each engine part reports its start and successful staging, including explicit replacements; failures never claim a completed write. Session appends can persist the ignorable marker so an older reader may omit progress without changing model reconstruction. Chat owns live and replay projection, and LibraryJobs consumes that public projection.

A lecture job owns one transcriber session. Any successful finalize in that session records a persistent goal milestone; later model errors become a job note, while the terminal outcome remains done. This partially supersedes the last-tool completion requirement in the background-library-jobs note; its admission, shared-feed, cancellation and question ownership rules remain applicable. Module-wide jobs retain normal turn-ending semantics.

Gemini Developer API requests explicitly configure the four adjustable filters through a validated provider threshold, defaulting to BLOCK_NONE. Vertex keeps provider defaults because its key/project restrictions differ. Google core protections remain enabled, and a prohibited-content refusal remains actionable as the blocked failure kind. No live key-tier acceptance is established by request-format tests.

Sourced patient scenarios belong in Clinical Cases. A sourced case remains relevant when at least one sub-question was taught; only untaught sub-questions are pruned and retained questions are renumbered. Sourced cases precede IMP supplements. Validators enforce recognizable patient-scenario placement, sourced-before-IMP ordering and consecutive retained sub-question numbers; evidence review owns semantic scope and omitted-case detection.

## Alternatives considered

**Only count finished tool calls.** This cannot expose work inside a single long writer call.

**Make progress model input.** Progress describes presentation, so including it in model context would add unrelated tokens and change the closing request.

**Require a successful closing summary.** The finalizer has already committed the lecture and updated its index; a later provider failure cannot undo that result.

**Prune a partly relevant sourced case or substitute generated cases.** This loses taught past-exam material and hides the distinction between sourced evidence and generated practice.

## Consequences

The tray can consume progress counts and a raw message independently of presentation design. Progress stops at the call result. Persisted goal milestones survive reloads whose current history window does not include the finalizer. Adjustable Gemini filters cannot guarantee acceptance of medical text, and prompt rules cannot prove semantic lecture coverage without source review.

## Verification

Temporary engine fixtures exercise progress-token presence, successful parts, explicit repairs, failed writes and prompt rules. Complete-transcript and editorial tests reject scenario misplacement and sourced-after-IMP ordering. A fake MCP transport exercises the installed SDK and durable Session checkpoints. Real client plugins project native and nested progress, clear it at results, and keep a finalized job done after a blocked turn. Installed Google SDK tests observe the outgoing safetySettings request fields.
