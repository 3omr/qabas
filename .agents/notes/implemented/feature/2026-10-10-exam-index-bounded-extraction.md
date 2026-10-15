# Agent Note: Bounded exam extraction and incremental publication

Status: implemented

English | [中文](2026-10-10-exam-index-bounded-extraction.zh.md)

## Problem

Repeated small agy calls dominate exam indexing time. Dense banks can exhaust output capacity or time even when their input fits the model: the reported live 24000-character run indexed two papers but a dense bank timed out at 600 seconds. A fixed total desktop deadline can discard the published result even when most papers have validated cached batches.

## Decision

Batches of recognised question-per-row worksheets are built from their columns without agy ([structured workbook index](2026-10-15-structured-workbook-index.md)); the batching below applies to both. The engine JSON settings `exam_index_batch_chars` and `exam_index_workers` resolve to positive integer defaults of 12000 source characters and three workers. Source units remain indivisible and five neighbouring units retain their context role. One coordinator owns atomic cache writes and assembles questions by source and batch position; workers only request and validate batches. Each submitted task inherits deadline context and shares a local cancellation event. Shutdown sets that event, cancels queued tasks, and waits for running subprocess-tree cleanup.

Completed papers publish through the existing publication lock, source-list check, original hash check, prepared-unit check, and repair carry-over. An all-failed build preserves the previous publication. The cache records the source budget in addition to source fingerprints and batch count. Cache records lacking this field are invalidated because the former budget included per-unit overhead; equal batch counts cannot prove equal boundaries. The prompt version remains 2 because extraction instructions and validation remain unchanged. A timeout, output-limit/truncation diagnostic, or unusable JSON response raises a capacity-specific error; malformed proposal JSON gets the existing repair attempt first. The coordinator bisects the core units, saves the split decision atomically, and schedules both halves in the same pool. Recursive descendants retain up to five context units per side. Capacity failure at a single-unit leaf fails only that paper; authentication and evidence-validation errors are not split.

Root cache keys retain the zero-based batch index, such as `0`. Descendants append one-based half positions: `0/1`, `0/2`, `0/1/2`. Split nodes store `{"split": true}`; validated leaves store their existing payload record. Retry follows saved split nodes without requesting the parent and revalidates cached leaves. Results assemble by numeric root/split position before whole-paper coverage and publication checks. Progress retains the original part count and appends `split 1/2` or `split 2/2` at each depth.

MCP indexing runs inside the owning request scope and emits existing progress notifications. The host sends cancellation before terminating and reaping the MCP process. `examIndexTimeoutMs` is a 3600000 ms inactivity limit for index building; completed batch or paper progress resets it. `examIndexOverallTimeoutMs` supplies a validated 21600000 ms overall cap. Single-file preparation retains its total deadline.

## Alternatives considered

- Lowering only the character budget cannot bound question counts or the resulting JSON output; adaptive splitting responds to observed response failures.
- Increasing only batch size leaves multi-paper extraction serial and does not preserve published work on interruption.
- Independent per-paper pools multiply process limits and complicate cache ownership.
- Worker cache writes require locks across shared read-modify-write state and can overwrite validated results.
- Resetting deadlines on arbitrary stdout lets unrelated output conceal stalled extraction; only matching MCP progress notifications reset inactivity.

## Consequences

A fixed-delay fake process benchmark measures 1.869 s with one worker and 0.672 s with three workers (2.78×), covers three papers with three batches each, compares concurrent and sequential indexes, publishes each paper, and verifies cache-only retries. A cancellation test checks every running fake child is reaped. An interrupted build retains its completed paper and requests only the unfinished paper on retry. Host tests cover progress resets, inactivity, overall limits, and caller cancellation. No real provider calls or library mutations are used for validation. Fake capacity failures above two required units verify recursive completion, unchanged output order, overlap, and cache-only retries. A permanently failing single unit verifies paper isolation and reuse of its successful siblings. A changed budget requires fresh extraction; oversized individual source units can exceed the budget to preserve their locators.
