# Agent Note: Per-paper exam coverage and legacy question access

Status: implemented

English | [中文](2026-10-10-per-paper-exam-status.zh.md)

## Problem

One unread or changed exam paper hides independently indexed papers when desktop inventory treats the module bank as an all-or-nothing result. Large cards and paper-level controls for module-wide extraction obscure recovery scope. Retired parser indices remain useful question evidence without the SHA records required to claim current indexed membership.

## Decision

Desktop inventory compares each published source and failure against its original SHA-256. Matching papers retain indexed membership and question/review counts independently. Module summaries distinguish built, partial, stale, missing and legacy, with indexed, failed and pending counts. Legacy sources without SHA records expose index_legacy, retain question access and do not claim indexed membership. Readers accept partial coverage and legacy extractors while preserving original-hash checks where recorded and agy prepared-text verification. The lecture refresh decision still checks complete paper coverage.

The desktop displays compact, wrapping paper rows with localized status, counts and overflow actions. Raw engine diagnostics remain inside Details. Retry is available after preparation or indexing failure and reads the selected original before updating the module bank. Module-wide extraction stays in the bank action. Module banners explain partial and legacy banks. Stop and component disposal abort the same controller passed to preparation and indexing. A completed index request refreshes authoritative inventory rather than asserting that every paper was indexed.

## Alternatives considered

**Treat partial publication as stale everywhere.** This hides valid per-paper evidence and makes unrelated failures appear to erase the whole bank.

**Claim legacy sources are SHA-matched.** Original parser indices have no SHA records. A separate legacy flag preserves question access without fabricating freshness.

**Repeat module-wide extraction on every card.** A card suggests a file-scoped operation. Only an explicitly labeled failure retry combines file reading with a module-bank update.

## Consequences

JSON additions preserve existing required fields. Legacy question access continues until replacement, while changed recorded hashes still prevent stale source reads. Counts describe current original papers; a failure from older bytes does not count against a replacement. English and Arabic UI dictionaries share placeholders. Tests cover A indexed/B failed/C pending, changed SHA, legacy lecture and file reads, compact rows, retry scope, summaries, partial/legacy banners and index cancellation.
