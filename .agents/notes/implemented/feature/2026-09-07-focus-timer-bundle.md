# Agent Note: Optional focus timer Bundle

Status: implemented

## Problem

A marketplace needs a usable, account-free package that proves UI extensions are installable Bundles, not only Skill files or test contributions. A small convenience feature must not introduce background Host work or alter agent execution.

## Decision

The [focus timer](../../../../packages/desktop/focus-timer/README.md) is an optional Bundle that mounts its own sidebar action. Its Host entry registers an optional duration preference in the existing settings provider. A component-local wall-clock deadline drives second-resolution rendering only while running; closing the dialog preserves countdown state, while unmount and page reload clear it. Users choose an integer duration of at most one day. The timer has no model or notification dependency.

Desktop preparation packs the repository-owned package with the pinned package manager and disabled scripts, publishes a content-addressed tarball, then atomically publishes its catalog record. The record pins bytes, package version, Harness version and build target. The package is excluded from the default runtime dependencies so that the upstream Bundle resolver selects the Profile-installed artifact. Development prepares the same source into a separate generated resource directory. Tests use private catalogs and do not populate the product catalog with fixture packages.

The reviewed tarball carries the schema library and its transitive dependencies through `bundledDependencies`. Packing selects pnpm's hoisted packing mode for that command only; the workspace keeps its isolated installation layout. An unbundled production dependency requires absent registry metadata in the installer's empty offline cache and prevents activation. Packaged acceptance uses the real pinned pnpm and an empty private cache to detect an incomplete dependency payload.

The optional marketplace launcher uses the existing keyed Slots mechanism with the Bundle's npm name. The launcher and sidebar share only visibility through an entry-declared store; the sidebar alone owns the countdown and interval. Closing Settings before opening the timer avoids competing modal owners. The launcher follows both the marketplace and sidebar declarations, so either owner can unload without leaving an unusable action. No feature-to-feature runtime import or separate action registry is required.

Plugin configuration belongs to the plugin's timer panel. Explicit saves and clears use the existing Host settings scope with the revision displayed by that panel. The saved-duration label follows Host observations; a rejected or unconfirmed save preserves the draft without asserting success. A fresh timer adopts the saved preference without starting; a running or paused timer retains its chosen duration when another settings writer changes the preference. Countdown progress never enters the settings document or Session log.

## Alternatives considered

**Put the timer in the sidebar owner.** Rejected because users must be able to add and remove the capability through normal Bundle composition without a shell fork.

**Persist timers or move timing to a Host service.** Rejected for this local countdown because that creates reminder durability and notification obligations. The UI states its lifetime and lack of alarms explicitly.

**Store preferences in the marketplace or browser local storage.** Rejected because the plugin already owns its settings namespace, and the existing Host scope provides validation, revision checks and persistence across browser reloads without a second settings authority.

**Offer an inert test package as the first catalog entry.** Rejected because successful preparation alone does not provide a user action or prove the installed browser contribution is useful.

## Consequences

The Bundle offers sidebar and marketplace use actions without adding work to the model loop. It is not a reliable alarm across sleep, throttling or application exit. Unit tests cover timing, settings validation, failed saves, shared visibility and declaration disposal; bilingual browser expectations cover save, refresh and clear; packaged acceptance installs the real artifact through marketplace confirmation, starts the candidate Profile, opens and reopens the same timer from Installed, verifies saved duration after restarting the Host, then removes the Bundle through marketplace confirmation. That acceptance simulates only native selection; real native activation and recovery retain their separate Rust owner. Graphical installation and removal belong to the marketplace, not this Bundle.
