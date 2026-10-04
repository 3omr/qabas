# Agent Note: Deterministic lecture pipeline

Status: implemented

English | [中文](2026-10-04-deterministic-lecture-pipeline.zh.md)

## Problem

Lecture jobs spend the student's chat-model quota coordinating a fixed procedure whose writing already runs in Antigravity. A model failure can interrupt the lecture, resubmit an oversized draft or ask about unrelated files.

## Decision

The [engine](../../../../engine/README.md#deterministic-lecture-jobs) owns one confirmed MCP procedure for transcribe, redo and continue. It composes existing lecture preparation, upload, verbatim, topic planning, figure, writing, review, validation, provenance and finalization internals. Finalization owns the transcript and Index.md commit. The lecture button authorizes this one run; module-wide source sync and unrelated uploads remain separate actions.

The [Remote](../../../../packages/api/transcriber-engine/README.md#lecture-pipeline) streams step and part progress without a Session. Cancellation sends the owning MCP request's cancellation before process termination, and teardown waits for exit. Engine cancellation preserves completed stages. Continue uses retained stages or a saved draft; redo preserves the final transcript until replacement succeeds.

Recovery keeps ordinary review, substance and provenance checks enabled. Deterministic cleanup precedes targeted agy rewrites and smaller source slices; transient provider errors and per-minute limits retry with cancellable backoff. Failed inputs are refreshed and optional figures can be omitted in the lecture manifest. Recording-based repair text survives unusable topic layouts. Specific findings and resume metadata, never the complete draft, can reach a bounded chat repair. If chat cannot finalize, engine salvage archives originals, prunes unverifiable questions and optional support, and validates the best retained transcript. Complete doctor verbatim remains the fallback when explanation repair is exhausted.

The [library runner](../../../../packages/client/ui-library/README.md) persists job identities, resume manifests, repair deadlines, progress and notes. It presents repair as running, validated completion as done, and only disconnected internet, spent daily/account quota, expired sign-in and missing recording as stopped with a plain reason. Per-minute limits and timeouts remain repairable. Reported reset instants are localized; Gemini API daily resets use midnight Pacific, while unknown account renewals remain explicitly unknown. Missing Remotes use the transcriber conversation. Chat repair is time-bounded and must release its writes before salvage; conversation opening remains available. Interrupted session-free jobs restore as stopped and Continue reuses engine artifacts.

This partially supersedes the one-Session-per-lecture assumption in [background jobs](../feature/2026-10-01-library-background-jobs.md) and [finalized jobs](../feature/2026-10-04-part-progress-and-finalized-jobs.md); their admission, conversation observation and milestone rationale remain useful. The [bounded repair decision](../bug-fix/2026-10-04-bounded-review-repair.md) remains the authority on saved parts and inline review limits. None of these notes is fully superseded.

## Alternatives considered

**Use a cheaper chat model to coordinate.** Quota, truncation and autonomous stopping still constrain the fixed procedure.

**Reimplement each step.** Separate implementations would diverge from the preset's existing source, review and finalization rules.

**Regenerate the complete draft after a refusal.** This spends writer calls on unaffected text and discards useful staged work.

## Consequences

The ordinary lecture job needs agy and NotebookLM but no chat API requests. Engine recovery defaults to six rounds, two-second initial backoff and a three-hour budget; chat repair defaults to five minutes. Deployment configuration owns these limits. Validated salvage never silently rebadges a question or discards doctor text. An unavailable engine, unwritable storage or unusable mandatory source can prevent every valid commit; the finished note states that retained work remains for Continue and does not claim a finalization milestone. Browser reload interrupts the owned request instead of silently starting another run.

Temporary-module tests use fake nlm and agy with real engine validation and finalization, including transient retries, deterministic repair, smaller-piece writing, forced pruning, student-only interruption, cancellation and Continue. Remote and client tests cover streamed progress, outcomes, abort, chat handoff and salvage. Real student data is neither copied nor written by these tests.
