# Agent Note: Unrepairable review findings

Status: implemented

## Problem

A real Toxicology job spent two repair rounds rewriting guide and questions parts for findings no rewrite could remove. Review refused the guide for three missing slide links: a title slide naming the lecturer, a video icon and a section divider. The writer prompt forbids linking title, divider and closing slides, and the automatic placement correctly found no matching paragraph. Validation then refused written questions citing `final Toxico 2023.pdf.txt`, the engine's prepared text sidecar of `final Toxico 2023.pdf`; the rewritten part cited the sidecar again.

## Decision

After automatic placement, [review](../../../../engine/scripts/mcp_server.py) lists every content slide that is still unlinked in a folded `[!note]` callout at the end of the Chronological Guide, the same block final salvage uses, instead of refusing the guide. Placement failures that raise remain findings. The folded unspoken-summary rule ignores thematic breaks, so the summary may be followed by this callout.

[Source matching](../../../../engine/scripts/phase_validation.py) treats a cited `<original>.txt` name as its original paper when that original is in the evidence catalog; other unknown sources remain findings.

## Alternatives considered

**Detect more title and divider slides.** Lecturer names, media icons and section titles vary per deck; a paragraph-match result already exists and needs no new heuristic.

**Tell the writer the sidecar names.** The prompt never contains them, and the rewrite repeated the mistake; matching the engine-owned naming rule is deterministic.

## Consequences

Every extracted content slide still appears in the guide, either beside its paragraph or in the closing list. A citation of a prepared sidecar validates and keeps its cited text. Tests cover the listed slide in review and the pipeline, and sidecar matching.
