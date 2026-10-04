# Agent Note: Figure cache identity and pipeline progress

Status: implemented

English | [中文](2026-10-04-figure-cache-and-pipeline-steps.zh.md)

## Problem

Hyperthyroidism has a typed title slide followed by twenty full-slide pictures. Treating trailing textless single-picture slides as closing decoration removes every teaching picture and reports an empty selection as “all text.” A filename and selection-version marker cannot identify the deck bytes that produced a selection. Preparation counts also appear as writer-part counts, while external illustrations depend on the writer noticing a visual gap.

## Decision

The [engine](../../../../engine/README.md#bounded-review-repair) preserves consecutive textless single-picture slides through the deck's end; only its last isolated lone picture can be decorative, alongside named closing slides and empty pages without images. Selection version 6 remains above main's version 5. Extraction records the actual source SHA-256 and size plus selection options, per-page text/image observations and their SHA-256. Preparation and review share validation of current source bytes, default options, recorded inputs and recomputed selected entries. Missing identity fields, changed decks, malformed manifests and inconsistent selections require extraction. A source changed during extraction refuses the result.

Selected entries carry image SHA-256 and fingerprinted readings. Picture-only slides use local tesseract eng+ara OCR (at least 20 characters and 60 word confidence); sparse or low-confidence results use one short inspected agy vision caption. Image-only private directories restrict permitted reads. Successful readings cache by image bytes and recognition policy; an extraction has a shared five-minute reading budget, 60-second page deadlines and at most 30 vision calls. Missing or altered readings invalidate the manifest. Machine-read labels in the manifest, slide outline and writer inputs prohibit treating OCR or captions as the doctor's words.

Review inserts missing links through bounded agy paragraph-index plans, preserving all existing narration and assessment text. Each request supplies at most ten described figures and 12 KB of guide paragraphs; twelve calls share three minutes. Only known pages and guide paragraph indices are accepted. Saved staged parts retain the inserted links. Unmatched pages remain findings for guide-part repair; missing links do not trigger repeated extraction of an already-valid described deck.

Every pipeline progress message carries a stable `<step>:` prefix. The client derives the current step from that prefix for both pipeline frames and MCP chat observations. Only explicit `write_parts_with_agy: part N of M` checkpoints supply writer-part counts; other operations use their step sentences.

Pipeline guide prompts include enabled external-illustration rules, requesting helpful images of appearances described in the doctor's words when no extracted slide image shows them, with literal evidence and at most five requests per lecture. Staging preserves placeholders and review resolves them; no placeholder means no web-figure lock. The [external-illustration note](../feature/2026-10-04-web-figures.md) retains grounding, verification and attribution policy. The [bounded-review note](2026-10-04-bounded-review-repair.md) retains part repair and extraction ownership. Both remain active; neither is superseded.

## Alternatives considered

**Re-extract without reading or placement.** Rendering the same scanned slide supplies no matching text and cannot repair absent links. OCR/captions and paragraph-index placement address those distinct omissions.

**Rewrite the whole draft to add images.** Image links can be inserted after existing paragraphs without risking unrelated changes to the doctor's explanation or assessment text.

**Version bump alone.** It refreshes old selections once but cannot detect a same-name changed deck or different selection inputs.

**One picture means closing decoration.** Full-slide scanned teaching content has exactly that count; explicit closing text provides a narrower exclusion.

**Every progress count means a written part.** Preparation and topic organisation also report counts. A writer checkpoint identifies its ordinal's meaning.

**Always request external disease illustrations.** A disease name does not establish a described appearance; illustrations must remain grounded in the lecture.

## Consequences

Cache reuse hashes the current deck, and manifests retain page observations. Synthetic picture-only, typed-text and changed decks pin cache decisions without student-data writes. Pipeline tests use a fake executable writer to emit a placeholder, observe real staging and review resolution, and verify enabled/disabled lock behavior. Client tests cover both progress paths. A synthetic picture-only PPTX combines a real OCR text image with a fake agy captioned diagram; pipeline tests verify automatic placement without re-extraction or narration rewrite. The [description-resilience note](2026-10-04-figure-description-resilience.md) owns page-local failures, neutral labels and later description retries; this note retains source identity, selection, placement and progress rationale. Fake image providers do not establish live model choices or medical-image accuracy.
