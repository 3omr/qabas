# Agent Note: Deterministic engine self-repair

Status: implemented

English | [中文](2026-10-04-engine-self-repair.zh.md)

## Problem

Unattended lecture jobs can exhaust the chat model's quota when parser refusals and conclusive provenance mismatches require model intervention. A cached topic parse refusal hides the rejected answer and preserves repeated cohort sections. Scenario paraphrases can also hide a real dated exam occurrence from lexical provenance lookup.

## Decision

The [engine](../../../../engine/README.md#retried-topics-and-cancellable-agy-work) repairs located topic spans before requesting another answer. Unique reversed anchors swap; unusable tails use neighbour edges; overlapping tails clip at the later located start. Topic ownership and complete recording coverage remain mandatory, and `anchor_counts` records repairs. Duplicate starts and ambiguous ownership still refuse the proposal.

`topics.json` preserves rejected proposals, including malformed JSON text and per-attempt findings. One retry receives the rejected answer and named failing spans. Cache version 3 reparses saved proposals locally; older-parser refusals and refusals with fewer than two attempts cannot retain fallback indefinitely. Transient failures remain eligible for the next run.

Provenance uses the cited papers and their paper-backed index. A unique clinical scenario match requires substantial clinical wording, matching quantities, and agreement on sex, laterality, negation and units. Review and validation replace conclusive badges with Question Bank or Past Exams containing only evidenced years parsed through `exam_years.py`. Source lines and question prose remain intact. Uncertain wording, unknown sources and conflicting matches still require bounded part repair. Structured review results, validation output and a persistent correction journal expose each automatic correction. Validation saves confirmed badge repairs even when unrelated findings remain.

The [spoken-topic decision](../feature/2026-10-04-spoken-topics.md) remains active for topic ownership and guide composition. The [bounded-review decision](2026-10-04-bounded-review-repair.md) remains active for retained parts, figures and cancellation; this note extends its answer-refusal policy without superseding those mechanisms.

## Alternatives considered

**Send every refusal to the chat model.** Deterministic repairs then consume quota and stop unattended jobs.

**Downgrade every unmatched year to Question Bank.** A paraphrased scenario can conceal genuine exam evidence, so lookup must establish the source before changing its badge.

**Accept every overlapping map or approximate question match.** Duplicate span starts, conflicting quantities and uncertain source identity cannot establish ownership or provenance.

## Consequences

Topic organization spends at most two calls per run and retains diagnostic answers. Badge repair requires no model call; ambiguous evidence remains a bounded finding. Clinical matching is conservative lexical evidence, not semantic proof of arbitrary paraphrases. Synthetic temporary-directory regressions cover overlaps, reversals, cache retries, rejected proposals, dated and bank evidence, uncertain matches, saved correction reporting and staged recovery. Private diagnosis is read-only and its source content is absent from fixtures.
