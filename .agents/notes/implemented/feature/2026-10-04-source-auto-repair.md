# Agent Note: Scoped source auto repair

Status: implemented

English | [中文](2026-10-04-source-auto-repair.zh.md)

## Problem

An unattended lecture job can finish drafting and review yet fail during finalization because another lecture's handwritten PDF lacks searchable text. Supporting documents cannot justify losing an otherwise usable recording-based transcript.

## Decision

The [engine](../../../../engine/README.md#source-auto-repair) derives selected-source scope before executing preparation. Unrelated sources stay outside repair execution, and failed or planned preparation cannot enter uploads. Preparation errors remain associated with their original paths.

Local OCR precedes bounded Gemini/agy page-image reading. Word confidence below 60/100 rejects weak local OCR; PDF confidence checks cover the first three pages. A private temporary directory contains only copied/rendered images. The prompt permits those reads and requires faithful page-labelled transcription with illegibility markers. Validation rejects empty, refusal-only, missing and reordered pages. Cached Markdown records model/handwriting provenance, and a searchable PDF carries the text through the existing upload implementation. Content hashes prevent stale reuse; failures are cached to avoid repeated unattended attempts.

Selected manifest entries authorize their eligible prepared upload without a second approval list. Explicit lecture manifests use current phase-0 validation independently of module-wide sync checkpoints. Unreadable supporting documents, including selected slides, produce omission warnings. Recordings and classified exams/question banks remain required. Successful MCP results carry warnings into persisted library job notes, including nested dispatches and provider errors after finalization.

## Alternatives considered

**Block on every local document.** This couples a lecture to unrelated files and prevents completion after valid drafting and review.

**Upload unreadable originals or invent text.** Neither supplies reliable evidence. Failed supporting sources are omitted; model text remains attributed and uncertain words stay marked.

**Repair every module source or replace module-wide approval.** This spends model reads on unrelated student material. Lecture scope controls repair; explicit module sync retains approval and partial results for unresolved files.

## Consequences

The [job-completion policy](2026-10-04-part-progress-and-finalized-jobs.md) and [image-verification policy](2026-10-04-web-figures.md) remain active; this note supersedes neither. Structural validation cannot prove handwriting accuracy or absence of summarization. Unsupported formats without safe converters, absent agy, denied reads and unusable responses reduce supporting evidence. Required authorities, invalid manifests, ambiguous matches and remote failures still stop jobs.

Synthetic temporary PDFs/images and fake external commands cover scoped uploads, usable model text, cached success/failure, conversion, page/time limits, supporting warnings and required-source refusal. A launcher subprocess covers a failed module sync with an explicit lecture manifest. Recorded client Session events pin warning-to-job-note projection, completion and reload behavior. Live agy acceptance on the supplied private sample is blocked by host restrictions on CLI logs and local server startup; no live handwriting accuracy is established.
