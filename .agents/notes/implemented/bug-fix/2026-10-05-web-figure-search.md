# Agent Note: Outside illustrations that real requests can actually find

Status: implemented

English | [中文](2026-10-05-web-figure-search.zh.md)

## Problem

No real transcript ever received an outside illustration, although writers requested sensible ones. Six causes stacked up: long search phrases ("tension pneumothorax needle decompression second intercostal space") return no Commons file; originals over 2 MiB were refused, which excludes most medical photographs; Public domain and CC0 files without a deed URL were refused; the whole lecture's step had two minutes while one agy inspection takes most of a minute; the writer's quote had to be an exact substring, so an elided or respelled quote dropped the request; and nothing recorded why a request failed.

## Decision

Search tries the writer's phrase, then its first four and first two content words and its last two, at most four queries. Commons thumbnails (1024 px, served from thumb.wikimedia.org) replace large originals, and SVG drawings are taken as their PNG thumbnails. Public domain and CC0 need no deed URL; CC BY and CC BY-SA still need a matching deed, ported deeds included. The step has ten minutes and at most four verified candidates per request. A quote is grounded when it is an exact substring or when each fragment of four or more words matches a window of the lecture at 0.75. The writer is told to copy 6-15 consecutive verbatim words exactly, misspellings included: a live run showed it correcting the ASR text and adding words the doctor never said. `web-figures-log.json` beside the manifest records each request's queries, verifier answers and outcome.

## Alternatives considered

**Download larger originals.** Not selected: 1024 px Commons thumbnails are large enough for a transcript figure and avoid the size refusal that excluded most medical photographs.

**Keep exact-substring grounding.** Rejected: elided or respelled quotes dropped valid requests, while fragment matching at 0.75 still ties each illustration to the lecture text.

**Relax the image verifier.** Not selected: approval stays with the strict agy verifier, so more candidates cannot lower the bar for an accepted image.

## Consequences

Approval stays with the strict agy verifier, and the license allowlist, attribution and five-image cap are unchanged. More candidates mean more verifier calls, bounded per request and by the step deadline.
