# Agent Note: Connection-owned freshness for plugin observations

Status: implemented

## Problem

A plugin-management UI needs current runtime observations after activation or recovery. An inventory retained across connection replacement can describe a different runtime. Configuration enablement alone proves neither a live instance nor account readiness.

## Decision

The browser inventory binds the Connection service's generation through the Slots hook compartment. A mounted tab reads on generation establishment and on explicit refresh or retry. Connection loss hides the prior generation's rows; late requests cannot publish into a replacement generation. The Host Loader remains the runtime-state owner, with no native registry or polling timer.

A manual refresh preserves search, disclosures, and the last result while reading. Failure labels the retained result as stale. Preset details report configuration independently from runtime failure, and an absent root Fiber means no running instance was observed. These observations do not constitute installation, compatibility, authentication, or permission checks.

The [preset-scope decision](../../archived/architecture/2026-08-29-plugin-inventory-agent-preset-scopes.md) still owns global versus per-preset provenance. The [plugin-owned settings decision](../../archived/architecture/2026-08-12-plugin-owned-settings-surface.md) still owns configuration cards. The [marketplace proposal](../../proposed/architecture/2026-09-06-desktop-plugin-marketplace.md) remains proposed: inventory freshness does not implement Bundle installation operations.

## Alternatives considered

**Poll the inventory continuously.** Rejected because an unopened settings tab needs no read traffic; connection generations and user gestures provide explicit refresh points.

**Retain rows from the previous connection until refresh succeeds.** Rejected because a replacement Host can have a different composition. Retention is limited to manual refresh within one generation and is labeled on failure.

**Give the component its own connection subscription.** Rejected because Slots already owns observable binding and disposal. The component consumes the framework hook rather than wiring a second subscription mechanism.

## Consequences

The inventory stays read-only and event-driven. It does not subscribe to individual Loader changes; users request refresh for changes within one connection. Component tests control late resolution and rejection across generation replacement. The browser scenario uses the assembled Web profile, changes a disabled Loader row, and checks manual refresh and network reconnection in both locales without model calls. Native WebView acceptance remains separate.
