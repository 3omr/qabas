# Agent Note: No recorded-speech guide fallback

Status: implemented

## Problem

Seven of thirteen lectures in one student library were published with the doctor's raw recorded text as their Chronological Guide. In six, the preserved rejected reviews contained a complete written explanation whose only guide finding was `folded unspoken summary must contain quoted items and be at the end of the Chronological Guide`. The writer separates topics with Markdown thematic breaks, so a `---` line followed the final folded summary. The finding named no part, so the repair loop refreshed inputs instead of returning it to agy, spent every round, and salvage then replaced the whole explanation with recorded speech.

## Decision

`guide_topic_errors` ignores thematic breaks and blank lines after the final folded summary; other unquoted lines there remain findings. `format_findings` locates folded-summary and guide-topic findings at their callout or `### ` headings, and `affected_parts` also reads document-wide `inspect parts` locations, so these findings return to agy with the part rewrite instead of only refreshing inputs.

[Salvage](../../../../engine/scripts/pipeline_repair.py) never substitutes recorded speech for the explanation. A guide that still fails validation raises `GuideUnresolved` with the located findings; the pipeline returns `failed` with those findings as `reason`, keeps the first failure in `findings`, and retains the draft and staged parts for Continue. Assessment salvage is unchanged.

This replaces the full-doctor-text fallback in [lecture publication](2026-10-10-lecture-publication-and-optional-exams.md); its scaffold refusal and failure outcome remain applicable.

## Alternatives considered

**Keep the recorded-speech fallback with a note.** Students read the published guide as an explanation; a transcript of speech under that heading looks complete while omitting the written work, and the note is easy to miss.

**Strip thematic breaks before validation only in salvage.** The repair loop would still spend its rounds on a finding no rewrite can remove, and validation would disagree between review and salvage.

**Delete the folded summary when it fails.** Slide-only content would disappear without a finding; a located finding lets agy correct the callout.

## Consequences

A lecture whose explanation cannot be validated now ends as a failed job with the guide findings instead of a published raw transcript. Lectures already published with recorded speech stay as they are until the student runs Redo. Tests use temporary modules and fake providers; with agy disabled, the pipeline now returns `failed` and writes no transcript.
