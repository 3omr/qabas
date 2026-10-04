# Agent Note: Source-grounded external illustrations

Status: implemented

English | [中文](2026-10-04-web-figures.zh.md)

## Problem

A spoken visual distinction may be absent from the lecture slides. An unrelated or incorrect medical photograph can teach the wrong sign even when its caption sounds appropriate.

## Decision

The [engine](../../../../engine/README.md#external-illustrations) resolves structured guide placeholders carrying an English description, search phrase and literal lecture evidence. Exact excerpt grounding and a five-image lecture cap precede optional Commons access. Machine-readable license names and matching license URLs restrict reuse to CC0, Public domain, CC BY and CC BY-SA.

Gemini through agy inspects the candidate and every supplied extracted slide image. A strict confident yes approves the medical appearance and the visual gap; anything else omits the image. The working directory contains only copied images. The installed agy binary exposes `multimodal_view_file`; live availability and model judgment are not established by fake-model tests. Cache reuse requires the same description, evidence and slide bytes.

Approved originals and attribution metadata share the lecture figure directory, so the existing final-transcript trash transaction owns them together. A separate manifest and Arabic label keep external teaching illustrations distinct from the doctor's slides. Saved recovery fingerprints and part lengths describe the resolved draft, because image replacement changes its bytes. Illustration requests and attribution do not count toward spoken-content floors. The per-workspace switch suppresses both drafting requests and network/model calls during resolution.

## Alternatives considered

**Search relevance as approval.** A medically related title cannot prove what an image shows. Local image inspection and a conservative confidence threshold protect against that mismatch.

**General image search and uncertain licensing.** Scraping and unverifiable reuse terms do not meet the owner's licensing requirement. Commons supplies machine-readable metadata through its API; unknown licenses are rejected.

**Gemini API-key fallback.** The installed agy binary contains a multimodal file reader, so a second credential path is unnecessary. Permission denial or unavailable image reading yields no image.

## Consequences

Offline access, metadata gaps, large originals, uncertain visual judgments and denied tool reads reduce illustration coverage without preventing a lecture run. No added image-resizing dependency is required. A confident model can still misidentify a medical image; the engine preserves its answer and source attribution for review and makes no claim of live medical accuracy.

This note adds the external-image approval policy; it supersedes no active Agent Note. Fake HTTP/model tests cover approval and rejection, bounded reads, grounding, rendering, validator refusals, settings and trash restoration. The English/Chinese pair lives under `engine/` as requested.
