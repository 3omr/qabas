# Agent Note: Compressed recording uploads and failed-source recovery

Status: implemented

English | [中文](2026-10-07-compressed-recording-recovery.zh.md)

## Problem

A failed NotebookLM audio source shares the recording name with the local original. Treating every non-ready source as processing prevents a fresh upload and keeps the lecture job in source preparation. Large originals also increase upload time.

## Decision

The [engine](../../../../engine/README.md) distinguishes terminal `error`/`failed` sources from processing sources. The authorized lecture job uploads a fresh copy when every matching source has failed, verifies its readiness, then removes only failed sources with the exact original name. Ready and processing sources prevent duplicate uploads. Original files remain intact.

FFmpeg is a required installable tool. Recording uploads create a mono AAC copy in a locked private cache keyed by original SHA-256 and encoder settings. Integrity metadata verifies both original and encoded bytes before reuse. Atomic publication and owned subprocess cancellation keep partial output out of the cache. A larger encoded copy retains the smaller original for upload. Bitrate, sample rate and compression timeout are validated configuration fields. `TRANSCRIBER_CONFIG_PATH` names a persistent absolute JSON file inherited by the child engine, including frozen desktop builds; invalid explicit files fail before upload.

The app shows compression, upload and NotebookLM processing as distinct localized steps. Compression changes audio encoding; it does not trim the recording or overwrite the original. NotebookLM processing and provider quotas can still stop a lecture resumably.

## Alternatives considered

**Poll a terminally failed source.** Its status never becomes ready and wastes the lecture recovery budget.

**Replace the original with compressed audio.** The student loses the original recording quality.

**Delete the failed remote source before replacement.** A failed upload leaves no remote copy. Cleanup follows successful replacement instead.

## Consequences

The app can recover a failed upload without student intervention while preserving originals and preventing duplicate processing uploads. FFmpeg availability is part of readiness. Speech encoding trades quality for upload size; the original remains available. Source names and IDs constrain cleanup, and no unrelated remote source is removed.
