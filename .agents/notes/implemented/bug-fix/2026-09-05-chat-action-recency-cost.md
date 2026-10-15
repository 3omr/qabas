# Agent Note: Bound chat action recency work in long transcripts

Status: implemented

## Problem

The following-sibling `:has()` rule used by [turn action chrome](../../archived/feature/2026-08-03-web-turn-run-time.md) makes style invalidation expensive when hundreds of user rows remain mounted. Composer focus and message insertion can evaluate the same sibling relationship for many rows, despite unchanged message content.

## Decision

The ChatView owner derives the latest user-or-steering key once per order change. Memoized seats receive a boolean and publish `data-actions-reveal`; CSS only handles opacity, hover, and focus. This supersedes the following-sibling CSS mechanism, not the turn-timing or recency UX decisions. No row subscribes to aggregate state to reverse-scan history. Streaming a stable node does not recompute recency.

The change preserves all loaded rows, native find, selection, and history prepend. Component tests cover initial recency, steering append, and history prepend; the stylesheet test rejects reintroducing `:has()`. The existing 500-turn browser benchmark keeps the same history, tool rows, and eight continued turns. Timings are measurements rather than CI thresholds and do not establish native WebView performance.

## Alternatives considered

- **Per-row reverse scans:** repeat subscription and search work for every mounted message.
- **Virtualization or layout containment:** may improve larger transcripts but needs separate selection, find, sticky code-header, width, and scroll-anchor acceptance; it is not needed to remove this selector cost.
- **Fewer benchmark messages:** changes the workload instead of improving the rendered path.

## Consequences

Only the old and new latest authored seats change recency when a message is appended. Row order remains a single owner input, and no message or persisted Session format changes. Large expanded histories still retain their DOM; this change does not promise bounded memory or eliminate all style and layout work.
