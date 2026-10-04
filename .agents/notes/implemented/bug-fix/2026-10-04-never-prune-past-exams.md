# Agent Note: Never prune evidenced exam questions

Status: implemented

English | [中文](2026-10-04-never-prune-past-exams.zh.md)

## Problem

Last-resort lecture salvage applies complete-document numbering checks to isolated questions with their original numbers. This rejects every question numbered above 1, including real past-exam questions. A reproduced draft loses MCQs 2–8, Written Questions 2–4 and Clinical Case 2: eleven deletions despite valid editorial and paper provenance checks. A writer can also repeat all assessment sections in one questions part, which ordinary staging retains and review refuses.

## Decision

The [engine](../../../../engine/README.md#deterministic-lecture-jobs) validates isolated questions numbered from 1, then renumbers retained full sections. Conclusive paper/index evidence protects Past Exams and Question Bank questions independently of editorial errors, incorrect years, broken Source references or missing manifest entries. Located local sources used by salvage enter the lecture manifest so both checks and finalization use the same evidence. Compiled banks retain their bank role even when some sections contain dated exams.

Salvage repairs conclusive badges before validation and attempts one bounded agy rewrite of each remaining invalid question. A sourced rewrite must preserve its question/scenario wording, clinical subquestions and MCQ options; clinical subquestion numbering may change. An unresolved evidenced question or unparsed assessment refuses salvage and keeps original stages for Continue. Only unevidenced questions that still fail after a rewrite attempt can be pruned. The job note retains the fixed count sentence and identifies each omitted question by its original number and badge.

Staging replaces the final questions part. Staging and review coalesce repeated assessment sections and remove only exact repeated question blocks, ignoring heading numbers for identity. Different wording, answers, options or source fields remain separate for ordinary validation. The guide bytes and staged recovery boundaries survive these edits. Review measures content retention against the saved draft with exact duplicates removed.

This refines salvage eligibility in the [deterministic pipeline decision](../architecture/2026-10-04-deterministic-lecture-pipeline.md). Its job ownership and recovery budgets remain authoritative. The [bounded review decision](2026-10-04-bounded-review-repair.md) retains authority over staged replacement and inline limits; neither note is fully superseded.

## Alternatives considered

**Prune every block that fails any check.** Document-level numbering and editorial findings do not disprove exam provenance and cannot justify deleting a located paper question.

**Accept sourced questions without validation.** Incorrect answers and malformed output still require repair; a failed bounded repair preserves resumable work instead of weakening checks.

**Keep only the first occurrence of each section.** A later occurrence can contain distinct questions. Exact duplicate removal retains those questions and leaves conflicting variants for review.

## Consequences

Synthetic temporary-module tests cover numbering, protected past-exam and bank answer repairs, failed repair retention, missing manifest/source recovery, mixed dated/undated banks, clinical subquestion preservation, quoted cases, malformed headings, extra questions appended by repairs, minimal pruning and reported identities, repeated questions-part replacement, idempotent review, saved triplicate drafts and duplicate sections spanning retained repair parts. Tests replace only external writers; ordinary engine validators and persistence remain active. Private diagnosis reads paper evidence without copying student content into fixtures or writing student files. Unresolved sourced failures can prevent finalization and require Continue.
