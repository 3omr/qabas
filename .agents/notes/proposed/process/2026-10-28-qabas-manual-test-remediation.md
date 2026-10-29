# Agent Note: Qabas study workflow remediation

Status: proposed

## Problem

Qabas's artifact state, browser execution state and persisted engine results do not consistently agree. Students need reliable recovery, spoken-evidence importance marks and complete exam coverage without treating a saved draft or a completed request as proof of success. The [feature reference](../../../../docs/qabas/index.md) describes the current implementation and issue-linked limitations.

## Proposal

Use separate PRs for the slices below, with current behavior in the feature reference and unbuilt requirements here. Each behavioral slice updates its owning reference child, README/JSDoc and Agent Note. The reference lives under `docs/qabas/` and is not published through a website. Documentation issue [#66](https://github.com/3omr/qabas/issues/66) owns Slice 0.

### Owner requirements

The supplied findings label the shared emphasis requirement R2/R8; both labels retain acceptance obligations.

| Requirement | Required outcome |
|---|---|
| R1 | Follow the doctor's spoken order; slides help organize and name topics rather than dictate chronology. |
| R2 | Build Section 2 from the doctor's verbatim and explanation; IMP means spoken emphasis. |
| R3 | Mark a past-exam question IMP when the doctor emphasized it; importance and provenance remain independent. |
| R4 | Make question-index builds substantially faster under the benchmark below. |
| R5 | Identify the worker as «عومر» in work/progress/summary copy; retain accurate service names in account instructions. |
| R6 | Review the UI with Astra, remove redundant controls and fix layouts while retaining accessible actions. |
| R7 | Document every student feature and the remediation proposal. |
| R8 | Generate questions covering every emphasized point, including when the exam bank is already large. |
| R9 | Support every library action through general or explicitly module-scoped chat; trim the composer. |
| R10 | Propose useful additions separately from required fixes. |
| R11 | Restrict new Trash operations to transcript outputs while preserving recovery of existing non-transcript entries. |
| R12 | Expose clear transcription stages, place figures beside the matching explanation and keep the transcript ordered. |
| R13 | Finish the open PRs individually through review and validation. Durable execution is an additional plan requirement, not a replacement meaning for R13. |

### Issue map

The October 28 manual test opened issues #51–#63 and #65; #64 is the merged salvage-retry PR. The plan's follow-ups are #66 (documentation), #67 (figure dispositions), #68 (exam sidecars) and #69 (index lock diagnostics).

| Issue or follow-up | Scope and slices |
|---|---|
| [#51](https://github.com/3omr/qabas/issues/51) | Spoken emphasis, independent badges, doctor-first regression coverage; 1 |
| [#52](https://github.com/3omr/qabas/issues/52) | Reload cancellation, browser restart execution, durable jobs; 4–7 |
| [#53](https://github.com/3omr/qabas/issues/53) | Workspace/cache identity, stale inventories, mutation feedback; 8, 13 |
| [#54](https://github.com/3omr/qabas/issues/54) | Cross-library task history and tray placement; 7 |
| [#55](https://github.com/3omr/qabas/issues/55) | Owner-selected year across inventory and question view; 9 |
| [#56](https://github.com/3omr/qabas/issues/56) | Case-only duplicate lecture reconciliation; 10 |
| [#57](https://github.com/3omr/qabas/issues/57) | Worker identity/copy; 17 |
| [#58](https://github.com/3omr/qabas/issues/58) | Chat action parity, scope, composer and contention; 15–16 |
| [#59](https://github.com/3omr/qabas/issues/59) | Transcript-only Trash; 12 |
| [#60](https://github.com/3omr/qabas/issues/60) | CLI overhead, fair scheduling, publication and complete-build measurement; 3–4 |
| [#61](https://github.com/3omr/qabas/issues/61) | Quota classification, partial outcomes, failure visibility; 2, 4, 7 |
| [#62](https://github.com/3omr/qabas/issues/62) | Arabic naming, interaction, settings, accessibility and layout; 7, 10, 13–14, 16 |
| [#63](https://github.com/3omr/qabas/issues/63) | Lecture stages and draft/failure presentation; 7; coordinate figures with 11 |
| [#65](https://github.com/3omr/qabas/issues/65) | Continue dead-ends on a short saved draft whose repair parts are not agy source segments; recovery acceptance below; slice not yet assigned |
| [#66](https://github.com/3omr/qabas/issues/66) | Feature reference and proposal; 0 |
| [#67](https://github.com/3omr/qabas/issues/67) (plan N2) | Grounded figure placement/disposition, linked to #63; 11 |
| [#68](https://github.com/3omr/qabas/issues/68) (plan N3) | Preserve student text while reconciling legacy/owned exam sidecars; 9 |
| [#69](https://github.com/3omr/qabas/issues/69) (plan N4) | Accurate index-lock holder diagnostics, contention and crash recovery; 4 |
| Worktree follow-up (plan N5) | Separate operational inventory and concrete owner-approved cleanup; no product slice or deletion authorization. |

Preserve dotted-title coverage from [PR #48](https://github.com/3omr/qabas/pull/48). Offline finalization [#49](https://github.com/3omr/qabas/pull/49), salvage retry [#64](https://github.com/3omr/qabas/pull/64) and dependency PRs [#50](https://github.com/3omr/qabas/pull/50) and [#1](https://github.com/3omr/qabas/pull/1) are merged into `main`. Validate fixes already on the implementation base instead of duplicating them; do not merge an aggregate QA branch wholesale.

### Ordered slices and dependencies

Each row is one PR. Dependencies govern landing, and overlapping files constrain parallel implementation. Broad issues remain open until all contributing slices meet acceptance.

| Slice | Owner and proposed result | Dependencies |
|---|---|---|
| 0 | Documentation: seven repository references and this proposal | None |
| 1 | Transcript semantics: persisted emphasis ledger over all verbatims; Section 2 and generated practice cover every point; provenance repair preserves independent badges | 0 |
| 2 | Engine failures: normalize auth/quota/network/transient interruptions; recognize weekly individual quota and preserve reported reset | 0 |
| 3 | Invocation: measure installed CLI, then centralize text/image-review launch with verified isolation and no unrelated MCP starts | 1; installed-CLI evidence |
| 4 | Indexing: fair bounded extraction/review scheduling, one concurrency budget, per-paper publication with review-pending status, retained valid papers and accurate locks/outcomes | 2, 3 |
| 5 | Python jobs: library-local `.qabas/jobs.sqlite3`, monotonic schema, transactional checkpoints, idempotency and worker ownership; restart exposes interruption without automatic execution | 4 |
| 6 | Host jobs: branded start/list/get/watch/cancel/resume API, validated process replies and application-owned worker lifetime; observation does not own cancellation | 5 |
| 7 | Task UI: Host projection, library-scoped history, stable tray, real stages, accessible progress, explicit Continue and truthful complete/partial/stopped/failed outcomes | 2, 4, 6 |
| 8 | Library synchronization: Host identity before cache restore, explicit revisions, mutation invalidation and bounded revalidation | 0 |
| 9 | Exam metadata: reproduce year discrepancy through the real UI path; effective paper metadata and fingerprint/ownership-based sidecar reconciliation | 8; serialize engine edits with 5 |
| 10 | Identity: reproduce duplicate lectures, preserve distinct manual IDs, Arabic display names independent of safe module IDs, module rename and stable lecture positions | 8 |
| 11 | Figures: persisted placed/unmatched/excluded dispositions, spoken anchors, one inline placement, slide priority and external attribution; consistent repair/salvage | 1, 3 |
| 12 | Removal: transcript-only Trash in UI/tools/backend, non-destructive module/lecture hiding and separate legacy recovery | 10 |
| 13 | Library UI: immediate feedback, safe repeated clicks, stable rows/scroll, expiring success feedback, useful empty state and bidi handling | 12; coordinate refresh with 8 |
| 14 | Settings: stable asynchronous account cards and student preferences with separate advanced controls | 0 |
| 15 | Chat actions: action-parity matrix and server-resolved general/module scope, reused domain handlers and student-selected import handles | 6, 9, 12; integrate stable identities |
| 16 | Conversation: compact composer, optional diagnostics, measured queue/startup/first-token latency during indexing and bounded retry without duplicate mutations | 3, 15 |
| 17 | Locale integration: consistent «عومر» work/progress/recovery copy, accurate service names, localized fixed engine messages | 7, 13, 14, 16 |

Parallel pairs require distinct code, references, notes and fixtures: 2 with 14; 3 with 8; 4 with 13 after their dependencies; 5 with only the client portion of 9 while engine edits wait. Serialize shared-file chains 1 → 3 → 11, 2 → 4 → 5 → 6 → 7, 8 → 10 → 12 → 13 and 15 → 16 → 17. The engine README, MCP server, Host types and central Arabic locale remain collision points even when sections differ.

### Decision ownership

This proposal does not supersede shipped decisions before their replacement lands. Keep the [browser jobs](../../implemented/feature/2026-10-01-library-background-jobs.md), [part progress](../../implemented/feature/2026-10-04-part-progress-and-finalized-jobs.md), [reversible removals](../../implemented/feature/2026-10-03-reversible-removals-and-fixed-library.md), [sidecars](../../implemented/bug-fix/2026-10-10-automatic-exam-reading-sidecars.md) and [spoken topics](../../implemented/feature/2026-10-04-spoken-topics.md) notes active: each retains current responsibilities and independent rationale. Durable jobs and transcript-only Trash require explicit successor decisions; unchanged ownership decisions update their existing notes. No note is fully superseded by this documentation proposal; no archive changes are warranted.

### Optional additions for R10

These additions are separate feature proposals, not conditions for closing required fixes.

| Addition | Value and cost |
|---|---|
| “Why is this IMP?” source jump | Supporting doctor quote and recording location; medium cost after emphasis ledger |
| Revision queue | Focused study from emphasized points and past exams, evidence links and unresolved-answer labels; medium |
| Preflight estimate | Missing recordings, account/quota blockers, stages and measured time range; low–medium after durable jobs |
| Compare Redo before accepting | Inspect changed explanations, questions and figures while retaining the old final; medium |
| Local study-readiness summary | Ready lectures, unfinished work and incomplete exam coverage without technical telemetry; low after job/state fixes |

## Alternatives considered

**Browser persistence as durable execution.** Request cancellation and executable browser recovery cannot establish restart-safe engine ownership or cross-library history.

**Optimize extraction alone.** Startup, preparation, review, publication and retries contribute to student wait; extraction-only timing can hide incomplete papers and reviews.

**Infer importance from exam frequency or missing provenance.** Neither proves doctor emphasis; spoken evidence and exam provenance require independent records.

**Delete sidecars or replace mixed Trash with permanent deletion.** Filename similarity does not prove ownership, and existing removed material must remain recoverable.

**Use undocumented CLI flags or rewrite global configuration.** Isolation needs installed-version evidence while retaining authentication and required image/file reads; global student configuration is not disposable benchmark state.

## Acceptance criteria

Every behavioral slice has focused tests, affected reference/README/JSDoc updates and an owning note. Non-trivial model/product-visible changes have required keyless recorded-session coverage; owner-local UI expected output supplements it. GUI PRs include an actual server/model-flow GIF and applicable GUI/browser checks. Engine changes run focused Python checks and engine lint/typecheck. Documentation runs `test:docs` and `doc-sync`; outgoing checks follow repository pre-push policy. Synthetic checks do not establish live emphasis completeness, handwriting accuracy or provider acceptance.

R1–R3/R8 require human-labelled emphasis fixtures, long/multiple recordings, slide-only exclusions, emphasized points absent from the bank and frequent exam points never emphasized. Every emphasized point reaches Section 2 and generated practice; sourced emphasized questions retain both marks after repair/resume. Figure tests cover concurrency, duplicate links, decorative slides, unavailable external search and repeated finalization, with rendered inspection.

Job acceptance covers duplicate submissions, two observers, disconnect/reload, shutdown, restart without auto-run, explicit Continue, library switches, changed sources, cancellation and finalization-before-completion crashes. Short saved drafts and failures before draft creation expose usable recovery rather than a repeated dead end. Trash preserves non-transcript bytes and verifies restore conflicts/legacy recovery. Chat tests cover every operation family, scope changes, ambiguity, confirmation and resulting filesystem state.

### R4 targets and measurement

These thresholds are proposed acceptance targets, not measured predictions or current behavior.

| Measurement | Target |
|---|---|
| Fresh 13-paper Toxicology build | Median ≤7 minutes; no valid run >10 minutes across three runs |
| First durable usable paper | ≤90 seconds after accepted submission |
| Progress acknowledgment | ≤1 second |
| Stage/batch update or heartbeat | At least every 5 seconds |
| Unchanged rebuild | ≤15 seconds; zero extraction/review model requests |
| Partial publication | Readable through interruption/reload; completed valid papers retained |
| Complete outcome | All 13 originals accounted for; zero extraction failures and failed/pending reviews |
| Chat local queue/startup overhead | ≤2 seconds above idle baseline; report provider first-token latency separately |

Freeze original-paper hashes, sizes, pages, owner years, CLI/model versions, machine, concurrency and network conditions. Use fresh disposable libraries outside the repository and preserve student artifacts. Measure monotonic wall time from accepted submission to durable complete outcome, including OCR, startup, review, publication and retries; report prepared-text-only timing separately. Record stage timestamps, model calls, split retries, cache hits and unrelated MCP starts. Report all three fresh runs and quota-blocked attempts, then run concurrent chat.

The supplied QA plan reports approximately 21 minutes for its fresh build and an older 520-question index. These are corpus observations, not immutable count oracles. Reconcile unique questions and occurrences paper by paper, explaining deduplication and extraction corrections without unexplained missing questions, options or provenance. Interrupt after first publication and during review; verify readable retained results, reload attachment, explicit restart recovery and checkpoint reuse. CI uses deterministic fake-provider scheduling tests; live wall-time acceptance remains recorded benchmark evidence.

## Risks

Emphasis extraction can miss important spoken points despite valid quotes. Relaxed figure checks can hide substantive omissions without explicit dispositions. Early publication can promote unreviewed answers or discard valid sources. Job crash windows can duplicate execution or lose completion; browser history must never become executable restart instructions. Naming changes can merge distinct lectures or detach checkpoints. Settings cleanup can hide recovery controls, and persona copy can obscure the actual service needing sign-in.

Installed-CLI isolation and real-service benchmarks require live evidence. These gaps do not authorize speculative flags, broader deletion, automatic restart or a claim that remediation is implemented.
