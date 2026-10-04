# Agent Note: Figure description resilience

Status: implemented

English | [中文](2026-10-04-figure-description-resilience.zh.md)

## Problem

One refused caption on the final picture of Hyperthyroidism aborts description collection before the extraction manifest is written. All twenty selected slide pictures disappear from the writer's inputs, and the lecture pipeline can finalize without reporting that loss. OCR and caption availability cannot determine whether an already-rendered picture exists.

## Decision

The [engine](../../../../engine/README.md#bounded-review-repair) retains every rendered selected page. A failed OCR operation, per-page deadline, unavailable vision provider or refused/invalid caption leaves available OCR text, or the neutral label `Slide N: picture slide; no machine-readable description`. The reading method identifies `ocr`, `vision`, `typed` or `neutral`; `reading.error` records failed attempts on the affected page. Neutral labels and weak OCR are placement hints, never doctor's words. Request cancellation still stops extraction.

An extraction shares five minutes and at most thirty vision calls. OCR and vision on each page share sixty seconds. Exhausting an aggregate description budget labels remaining uncached picture pages neutrally; one page's failure does not prevent later descriptions. Successful cached readings and typed slide text remain available without a new recognition call. Only successful OCR or vision readings without errors enter the image-hash cache; explicit extraction retries failed pages. A complete manifest with failed readings remains valid for preparation and review, so ordinary consumers do not repeatedly render the deck.

Inspected vision captions tolerate Markdown fences, line breaks and `toolAction`/`toolSummary` completion metadata. Captions are shortened to eighty words and six hundred characters. An explicit inspection confirmation and nonempty visual text remain required; formatting tolerance cannot convert a refusal into observed evidence.

Initial figure preparation retries extraction once, including a successful command that fails to produce a valid manifest. Two failed attempts persist a lecture-local slide omission and add the fixed job note `Slide pictures could not be prepared; the transcript has none.` The tray translates that sentence in English, Chinese and Egyptian Arabic. Recording-based writing and validation continue; mandatory checks remain enabled.

The [figure cache and pipeline note](2026-10-04-figure-cache-and-pipeline-steps.md) remains active for source identity, selection, placement and progress. This note supersedes only its all-or-nothing reading policy and operation-level description deadlines; independently useful rationale stays there.

## Alternatives considered

**Abort the whole extraction on one caption failure.** Description availability is weaker than raster availability and must not erase other selected pictures.

**Cache neutral labels as successful descriptions.** A provider refusal or timeout can recover on a later extraction; success-only caches preserve that retry.

**Invalidate every partial manifest.** Preparation and review would repeatedly rasterize a valid deck and lose reusable descriptions instead of supplying its pictures.

**Accept an uninspected caption.** Formatting cleanup preserves explicit inspection evidence; a refusal remains a recorded failure.

## Consequences

Synthetic PDF extraction exercises real OCR and rendering with a fake vision executable: an OCR page and a successful caption survive a refused final page, and later extraction retries only the failed description. Synthetic failures cover OCR errors with partial text, per-page timeouts, weak OCR, aggregate time/count exhaustion, caption formatting, bounded trimming, invalid metadata and missing inspection. Pipeline tests exercise recovered, repeated-error and missing-manifest subprocess outcomes through finalization and the persisted job note. The tray test covers fixed-sentence translation.

Temporary verification of the read-only Hyperthyroidism deck retains twenty selected pictures: nineteen OCR readings and one neutral reading for page twenty-one; the manifest validates and the source fingerprint is unchanged. This session's sandbox blocks LibreOffice conversion and agy's localhost listener, so verification substitutes a temporary image-based PDF renderer. These counts do not establish LibreOffice behavior or a live model caption; real caption-format inspection remains unverified in this environment.
