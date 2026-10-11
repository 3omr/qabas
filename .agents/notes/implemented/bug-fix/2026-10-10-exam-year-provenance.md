# Agent Note: Exam year provenance across a whole paper

Status: implemented

English | [中文](2026-10-10-exam-year-provenance.zh.md)

## Problem

An exam date printed in a paper header can be outside a question's cited units or extraction batch. Question-only validation rejects that date, while omitted model years discard trustworthy filename provenance. Combining a scan filename date with a different printed exam date also misclassifies a single exam as a question bank.

## Decision

Each source snapshot retains normalized text from all source units. Year evidence requires a complete matching year token and a normalized verbatim phrase in that text, or an existing trusted filename year. Occurrences record `year_source` as `question`, `paper`, or `filename`; unresolved years record null.

A single-year past exam supplies missing or rejected question years from text preceding the first grounded question stem, then from its filename when the text supplies no conflicting year. A printed header year takes precedence over filename provenance. Multiple text or filename years, or an explicit bank designation, prohibit blanket assignment. Existing question review reasons survive fallback assignment, but fallback itself does not require review. Lecture lookups re-verify every occurrence against the source bytes; a `paper` year passes when the year is printed in the source units that precede the occurrence, so questions on later pages keep the header year instead of being dropped as unverified.

A filename/header disagreement appears once in the source's `review_reasons` and contributes one source review item to `needs_review`. Source `years` retains assigned question years and uses the printed paper year rather than a conflicting scan filename year. Prompt and schema versions remain unchanged because cached raw batch payloads are revalidated under the current post-processing rules.

## Alternatives considered

**Question-unit-only evidence.** Rejecting header evidence prevents valid printed dates from reaching the index and makes question results depend on batch placement.

**Unconditional filename fallback.** Applying a scan date despite a different printed exam date loses exam provenance; applying one year to a bank attributes undated questions to the wrong exam.

**Repeating mismatch reviews on every question.** The disagreement concerns one source and does not establish uncertainty about each question's wording or answer.

## Consequences

Header evidence can validate across batches without repeated whole-paper text construction. Missing model years can retain defensible provenance without introducing question review flags. Header fallback is conservative: it requires an exactly located normalized question stem and a single printed year before the earliest such stem; unresolved sources retain null years when neither header nor filename provenance qualifies. Multiple year tokens anywhere in the paper disable blanket assignment even if one token is incidental.

Regression coverage includes Arabic digits, conflicting scan dates, omitted and rejected model years, multi-year banks, absent evidence, cached-payload replay, and header evidence outside the extraction batch. Live library sources are not modified or rerun by this engine-only change.
