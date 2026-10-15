# Agent Note: Preparation history is observation, not activation authority

Status: implemented

## Problem

A restarted service cannot distinguish successful preparation from abandoned directories by their existence. Another live process can own unfinished work, while a missing or modified receipt can invalidate a previously recorded result. Automatic cleanup based on timestamps risks removing another process's candidate.

## Decision

The optional [preparation journal](../../../../packages/desktop/bundle-preparation/README.md#operation-history) records each admitted attempt in an exclusively created operation directory. Begin metadata precedes work; terminal metadata follows completed work and cleanup. Independent identities avoid cross-process read-modify-write ownership. Metadata uses the existing atomic-write library; publication does not fsync or promise survival of power loss.

Readers identify only their own active attempt as `preparing`. Unterminated records otherwise remain `unsettled`, without claiming the owner is dead. Malformed metadata stays visible as `unreadable`. A prepared observation checks the bounded receipt's hash, not executable contents or runtime health; altered or missing receipts are `unavailable`. History grants no activation permission and causes no retries or deletion.

The deployment owns a bounded history directory separate from staging and the configured source Profile. Unknown entries and excessive history fail reads explicitly. Failure metadata excludes raw errors, child output and configuration. A terminal-write failure rejects the request and may leave completed candidate files; a second recording failure leaves an unresolved attempt. Callers own retention and subsequent investigation.

## Alternatives considered

**Infer abandoned work from age or directory presence.** Rejected because another live process can still own the operation. Recovery needs explicit ownership and admission, not a timeout-based guess.

**Treat a successful receipt as an activation grant.** Rejected because executable contents can change independently and no active-runtime health check has occurred.

**Maintain a shared mutable JSON index.** Rejected because independent attempts do not need shared read-modify-write coordination; exclusive operation directories and atomic records preserve that separation.

## Consequences

Service recreation preserves observations without changing Profiles or Sessions. Focused tests cover active-owner distinctions, record limits, invalid data, receipt changes, publication failures and exclusive identities. The packaged smoke reads successful composition and failed dependency attempts in a fresh dsh process without activating the candidate.

This is read-only restart history, not automatic crash recovery or installation rollback. The [byte preparation](2026-09-06-reviewed-bundle-preparation.md), [dependency candidate](2026-09-06-offline-bundle-candidates.md) and [Profile composition](2026-09-07-candidate-profile-composition.md) decisions retain their independent validation and isolation rationale. Task-idle admission, production switching and marketplace UI remain under the [marketplace proposal](../../proposed/architecture/2026-09-06-desktop-plugin-marketplace.md).
