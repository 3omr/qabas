# Agent Note: Preserve dots in lecture titles

Status: implemented

## Problem

Lecture names can be recording filenames or titles from a manifest. Unconditional extension removal truncates a title such as `Addiction د. مصطفى` to `Addiction د`, affecting the draft path, final transcript filename and Index entry.

## Decision

The shared title helper keeps the basename and trims whitespace, removing a trailing extension only when it belongs to `RECORDING_EXTENSIONS`, compared without case sensitivity. Draft lookup and transcript publication share this rule. The [exact recording selection decision](../feature/2026-10-08-exact-recording-selection.md) continues to own source selection; source normalization and transcript matching remain unchanged.

## Alternatives considered

**Remove every suffix after the last dot.** This treats punctuation in an already-clean title as a file extension and loses part of the lecture name.

**Change source or transcript matching to compensate.** Matching cannot restore missing title text in newly generated filenames and would alter which existing sources or transcripts are selected.

## Consequences

Dotted titles survive draft lookup and final publication, while recording filenames still lose supported media extensions regardless of case. Focused tests cover draft paths, saved transcript paths and Index titles. Existing truncated files and Index rows are not renamed or rewritten automatically; their association still depends on the existing provenance and legacy title matching rules.
