# Agent Note: Lecture publication and optional exam evidence

Status: implemented

## Problem

A failed exam refresh can restart inside each lecture repair round. Salvage can mistake a five-heading scaffold for a transcript even when no recorded speech exists. Generated exam text and legacy sidecars duplicate original papers in preparation and upload plans. A module-wide book can become a lecture deck and force its cover into the guide.

## Decision

The [lecture procedure](../../../../engine/README.md#deterministic-lecture-jobs) refreshes exam evidence once before repair. Failed or partial refreshes preserve unchanged, paper-backed occurrences and add an English note listing papers with missing past-exam years. Lecture question lookup validates occurrences independently rather than requiring complete module coverage. Explicit exam-management lookup keeps its stale-index refusal.

Salvage and MCP finalization require alphabetic narrated content in the Chronological Guide after removing headings, blockquotes, image links and HTML comments, and alphabetic speech in a saved verbatim baseline after removing headings and blockquotes. Existing complete-document, coverage, editorial and provenance checks remain mandatory. Other sections may be empty if no validated material is available. Absence of doctor text is not a successful transcription; [no recorded-speech fallback](2026-10-17-no-recorded-speech-guide-fallback.md) owns what happens when the written explanation cannot be validated.

Recovery without publishable content returns `failed`, preserving the first failure in `reason` and `findings` and its tool in `step`; `salvage_error` reports the independent recovery failure. Available `resume` metadata identifies retained module/manifest state. Publication does not write a transcript or change Index.md. The Remote validates this outcome, and the library stores the original reason, keeps `goalReached` false and finishes as failed without automatic transport retries.

Inventory and automatic manifests exclude preparation-owned derived exam names, paired sidecars, hidden files and JSON artifacts. One original paper supplies one assessment candidate. Automatic slides exclude general materials and other lectures' materials. Cached general-material slide assignments are removed on reuse. A lecture with no slides follows the doctor's recorded order and requires no figure; neutral pages labelled “picture slide; no machine-readable description” require no guide link.

This partially replaces the terminal-reply restriction in [bounded finalization](2026-10-04-finish-always.md) and [deterministic lecture recovery](../architecture/2026-10-04-deterministic-lecture-pipeline.md). Their validated assessment retention, repair budgets, cancellation and publication ownership remain applicable. [Exam failure isolation](2026-10-10-exam-index-failure-isolation.md) and [sidecar ownership](2026-10-10-automatic-exam-reading-sidecars.md) retain their independent rationale; index extraction and OCR are unchanged. These records remain active because their ownership and provenance rules still guide future changes.

## Alternatives considered

**Retry exam indexing during lecture repair.** Index failure is independent of lecture writing and repeats expensive work without repairing recorded content.

**Publish a scaffold after recovery exhaustion.** A completed file and index entry cannot establish that any lecture content was obtained or validated.

**Require every section to contain invented content.** Empty assessment sections are legitimate when no grounded questions exist; recorded guide content is the required minimum.

**Use a general book as a slide fallback.** A module reference does not establish lecture-specific slide order or figures. Neutral page labels supply no placement evidence.

## Consequences

A completed lecture can lack past-exam years for some papers, with the omissions explicitly reported. Failed runs retain resumable artifacts and require Continue instead of creating a false completion milestone. The minimum is structural and source-presence validation, not a new semantic proof that every generated sentence matches speech; existing coverage and provenance checks continue to supply their guarantees. Tests use temporary modules and fake providers, without real agy, NotebookLM, network requests or student-library access.
