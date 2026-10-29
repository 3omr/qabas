# Agent Note: Salvage retries write missing lecture parts

Status: implemented

## Problem

A transport failure during writing leaves an incomplete staged lecture, or no saved content if the first part has not been staged. A retained-content retry that enters salvage immediately cannot publish because salvage requires every staged part, so repeated retries preserve the same failure.

## Decision

The [lecture pipeline](../../../../engine/scripts/lecture_pipeline.py) recovers saved staged parts before checking an explicit salvage request. An incomplete retained layout uses the ordinary writer attempt and its bounded repairs and resumable stops to write missing parts before validated salvage and finalization. When neither a staged layout nor a saved draft exists, the writer produces all parts. Only complete layouts and saved drafts without a staged layout skip writing and enter salvage directly. Failed outcomes omit the internal salvage-request sentinel from the latest-error diagnostic.

This complements the [guide-validation decision](2026-10-17-no-recorded-speech-guide-fallback.md): salvage still refuses incomplete or invalid explanations and never replaces them with recorded speech.

## Alternatives considered

**Enter salvage immediately for every retry.** An unwritten part remains missing across retries, preventing publication even when the writer is available.

**Allow salvage to publish incomplete layouts.** This discards required lecture content and weakens publication validation.

## Consequences

Retained-content retries can spend writer calls and repair time on missing parts. Completed parts remain reusable, ordinary validation and provenance checks still govern publication, and exhausted writing reports the unwritten parts with the real writer error. Temporary-module regressions cover absent, incomplete and complete layouts and persistent writing failures.
