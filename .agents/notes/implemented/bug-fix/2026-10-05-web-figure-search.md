# Agent Note: Outside illustrations that real requests can actually find

Status: implemented

English | [中文](2026-10-05-web-figure-search.zh.md)

## Problem

No real transcript ever received an outside illustration, although writers requested sensible ones. Six causes stacked up: long search phrases ("tension pneumothorax needle decompression second intercostal space") return no Commons file; originals over 2 MiB were refused, which excludes most medical photographs; Public domain and CC0 files without a deed URL were refused; the whole lecture's step had two minutes while one agy inspection takes most of a minute; the writer's quote had to be an exact substring, so an elided or respelled quote dropped the request; and nothing recorded why a request failed.

## Decision

Search tries the writer's phrase, then its first four, three and two content words, at most four queries. Commons thumbnails (1024 px) replace large originals, and SVG drawings are taken as their PNG thumbnails. Public domain and CC0 need no deed URL; CC BY and CC BY-SA still need a matching deed, ported deeds included. The step has ten minutes and at most four verified candidates per request. A quote is grounded when it is an exact substring or when each fragment of four or more words matches a window of the lecture at 0.85. `web-figures-log.json` beside the manifest records each request's queries, verifier answers and outcome.

## Consequences

Approval stays with the strict agy verifier, and the license allowlist, attribution and five-image cap are unchanged. More candidates mean more verifier calls, bounded per request and by the step deadline.
