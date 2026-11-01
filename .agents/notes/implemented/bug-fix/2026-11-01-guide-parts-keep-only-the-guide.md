# Agent Note: Guide parts keep only the guide

Status: implemented

## Problem

The single guide part of `Heavy Metals 1` came back from the writer with its own IMP Points, MCQs, Written Questions and Clinical Cases after the Chronological Guide, although the guide prompt says no Sections 2–5. Those sections were staged inside part 1, so the assembled draft held every assessment section twice. Coverage keys then mixed the writer's unreviewed IMP points into Section 2, review re-audited sections that had just been reviewed in agy calls of about twelve minutes each, and validation would have refused the duplicated sections.

## Decision

[Guide staging](../../../../engine/scripts/mcp_server.py) cuts a written guide part at its first level-two Sections 2–5 heading before staging; those sections are staged only as their own assessment parts. Staged-part recovery, which Continue and every staged-draft tool run first, applies the same cut to guide parts already staged in an assessment layout. Assessment receipts that were current before the cut are rebound to the cut guide bytes, because the removed text was never guide evidence for those sections.

## Alternatives considered

**Rely on the prompt.** The writer already receives "No sections 2–5" and still produced them.

**Rewrite the guide part or invalidate the assessments.** A rewrite repeats a correct guide and costs agy time, and invalidating would rewrite four reviewed sections for text that only had to be removed.

## Consequences

On a copy of the live library, recovery cut part 1 from 37,596 to 11,713 characters, all four receipts stayed current, no section was stale, and review took two seconds. A regression test covers the cut at staging and at recovery, and Continue then makes no writer request. A writer that put guide narration after an assessment heading would lose it; guide parts have no reason to contain those headings.
