# Agent Note: Exact recording names select matching audio sources

Status: implemented

English | [中文](2026-10-08-exact-recording-selection.zh.md)

## Problem

Audio recordings can share a stem while using different formats, such as a selected `.m4a` with a neighboring `.ogg`. Stem-only matching can choose a different local recording or NotebookLM source. Passing full filenames from a manifest must preserve exact matching without adding extensions to transcript labels.

## Decision

Pass the complete manifest filename through the MCP-to-runner handoff. The runner and NotebookLM raw engine prefer a normalized exact filename, then use the existing extension-insensitive stem match for title-only requests and converted sources. Transcript paths and labels continue to use the filename stem.

## Alternatives considered

**Match every request by filename stem.** Rejected because a manifest-selected `.m4a` can share a stem with a neighboring `.ogg`, causing the wrong local recording or NotebookLM source to be selected.

**Include the extension in transcript paths and labels.** Rejected because the extension identifies the source file format, while transcript names remain based on the lecture title.

## Consequences

Same-stem audio files remain distinct when a manifest names the format. Older extensionless lecture titles continue to work, and transcript names remain extension-free.
