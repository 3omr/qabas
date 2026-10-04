# Agent Note: Finalize after bounded lecture repair

Status: implemented

English | [中文](2026-10-04-finish-always.zh.md)

## Problem

A lecture-local figure omission can hide a valid current extraction from both writing and review. Picture-only decks need OCR or vision readings to locate images in spoken explanations. Restricting sourced MCQs to four or five options rejects genuine three-option papers, and an uncertain secondary citation can veto a confirmed exam occurrence. A repair-budget handoff can leave only a draft while the tray reports completion.

## Decision

The [engine](../../../../engine/README.md#deterministic-lecture-jobs) treats network loss, spent quota, signed-out services and missing recordings as resumable student stops. Other findings enter bounded repairs and automatic validated salvage. Every emitted terminal reply is finalized or a student stop. A duplicate invocation waits cancellably for the active lecture's actual outcome. The Remote rejects handoff/completed replies, and the tray requires a finalization milestone before showing done. Unexpected engine-request failures remain running and retry retained-content recovery after the configured grace; reloaded sessionless lecture jobs resume with Continue.

A current manifest with present rasters restores a prior figure omission. Writers receive selected content figures with labelled machine readings. Recognized title and closing slides do not require links. Review matches OCR terms across all spoken guide paragraphs and their topics before requesting bounded paragraph-index plans. Plans insert known links without rewriting narration. Final salvage uses local matching without another placement-model request; unmatched content figures remain explicitly labelled references at the guide's end. Invalid image references are reported and removed independently of valid figures.

Past Exams and Question Bank MCQs retain their original two to six ordered options. Generated IMP MCQs use a–d. Provenance checks still reject missing or wrong-paper sources on the unmodified draft. Repair evaluates cited papers independently against raw papers and the paper-backed index, removes unlocated citations and searches other local assessment papers when necessary. Badges contain only evidenced years; an undated occurrence supports Question Bank. A truly unlocated question keeps its wording and options as IMP with a provenance note and an engine-issued receipt bound to its original wording and ordered options. A model-written retention comment cannot grant that exception. Receipts are published before repaired drafts or staged parts, preserving the exception across interrupted saves. Source-field repairs are included in staged recovery boundaries.

Salvage preserves evidenced stems, scenarios, options and clinical subquestions. One bounded rewrite may repair an answer or formatting but cannot change that wording. Rewrites stop before the reserved local validation and finalization window. If the assessment remains invalid, a folded source excerpt retains its wording and evidenced badge while omitting the unvalidated answer explicitly. Only still-invalid unevidenced assessments are dropped, with their labels reported. An invalid explanation falls back to complete saved doctor verbatim. All saved candidates pass ordinary complete-transcript, editorial and provenance checks; original stages remain archived.

The [self-repair note](2026-10-04-engine-self-repair.md) retains topic-span and cache ownership; this decision replaces its requirement that uncertain provenance must await part repair. The [bounded-review note](2026-10-04-bounded-review-repair.md) retains extraction provenance, retained-part limits and cancellation; this decision adds automatic placement and replaces the writer-only placement dependency. Both notes remain partially applicable.

## Alternatives considered

**Stop after repair exhaustion or send validation to chat.** This consumes another model quota and can report an unsaved lecture as finished.

**Accept every claimed year or discard uncertain questions.** The first fabricates exam provenance; the second loses useful assessments. Paper evidence owns badges, while unresolved wording can remain as practice.

**Prune an evidenced question whose generated answer is invalid.** The answer is replaceable; the original assessment is student evidence. A source excerpt preserves it without asserting an unvalidated answer.

**Append every figure at the end.** A content slide belongs beside the matching spoken explanation. An explicitly unmatched reference is only the last-resort fallback.

## Consequences

Synthetic regressions cover picture-only OCR decks with a writer that links nothing, restored omissions with a missing decorative raster, forged-marker rejection, receipt persistence through repeated validation, whole-guide matching, invalid placement plans, two-to-six-option parsing, uncertain secondary citations, missing/wrong-paper repairs, retained source excerpts, exhausted repairs, concurrent lecture leases and client recovery with fake time. The read-only Hyperthyroidism reproduction contains nineteen content-slide links and excludes its title and closing slides; both reported exam MCQs retain their evidenced years. Private evidence stays outside the repository. Network access is still required by the real finalization source-preflight path; offline reproduction can validate the draft and render the final student document locally, but cannot claim a live library commit.
