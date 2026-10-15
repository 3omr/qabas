# Agent Note: Exam answer provenance and fragmented text layers

Status: implemented

## Problem

Exam papers commonly omit official answer keys. Treating this absence as a question defect makes review counts uninformative. Paper-level year disagreements can also make review counts exceed question counts. Alphabetic PDF fragments evade script-noise detection and prevent otherwise faithful question extraction from grounding against the source.

## Decision

The engine post-processes raw cached agy batches without changing prompt version 2. Question occurrences carry answer_status values printed, no_key, or unverified. Missing-key-only advisory reasons retain their model flags and text but do not set the derived needs_review flag. A reason counts as missing-key-only when each clause either states an absent answer key or only names the question type, and no clause mentions handwriting, OCR damage, truncation, a missing or garbled option, student annotations, or noise. Other reasons remain reviewable, as do damaged options and unverifiable year claims. An answer or explanation that the source cannot verify is omitted and reported as answer_status unverified, and an ungrounded topic is dropped; neither flags the question, because the question itself remains usable. Model notes and these engine notes share one clause classifier, so a note that combines a missing key with an omitted topic is still advisory. Printed answers and absent keys across occurrences do not constitute an answer conflict; conflicting printed answers do.

Source review_reasons remain separate from the per-question needs_review count. The desktop displays those paper notes and omits a zero review count. The question view labels no_key as no official answer key in English and Egyptian Arabic.

Grounding retains token matching and accepts ordered, case- and digit-normalized alphanumeric text without whitespace. Phrases shorter than 20 characters require an exact compact match; longer phrases require at least 95% similarity in a same-length source window. Answer evidence still requires at least two normalized tokens.

PDF inspection measures the share of non-empty lines shorter than six characters. More than 50% of at least ten lines triggers OCR. This detects the supplied Khalsa fragments while retaining ordinary labelled short options in synthetic clean exams.

## Alternatives considered

**Changing the extraction prompt and version.** This would invalidate usable model batches and require re-extraction. Cached raw payloads already provide the evidence needed for classification.

**Suppressing every advisory review flag.** This would hide OCR damage and ambiguous handwriting. Only recognized missing-key-only reasons are exempted; mixed and unknown reasons remain visible.

**Counting paper notes as reviewed questions.** This can exceed the paper's question count and conflates paper provenance with question defects. Paper notes have their own display.

**Lowering token grounding thresholds.** This admits invented wording without solving split words. Ordered compact text preserves character order and uses a stricter similarity threshold.

## Consequences

Students see actionable question review counts and a separate indication that a paper has no official key. Raw model advisories remain available in occurrences. Missing-key wording that also mentions a source defect conservatively retains review. Compact similarity and layout quality are heuristics; the regressions cover the supplied layout and invented text, but do not establish accuracy for every scan. Existing published indexes require an index refresh to apply post-processing; unchanged cached model batches do not require another extraction.
