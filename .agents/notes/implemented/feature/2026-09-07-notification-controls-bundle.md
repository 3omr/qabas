# Agent Note: Optional notification policy Bundle

Status: implemented

## Problem

A marketplace needs a task-behavior example that can change desktop behavior without modifying the agent loop. The native desktop already sends generic completion and failure notifications; a second sender would duplicate delivery and obscure which package owns filtering and transport.

## Decision

The optional [Notification Controls Bundle](../../../../packages/desktop/notification-controls/README.md) supplies independent, persistent completion and failure switches. Both default to enabled. The existing native provider emits a synchronous `desktop/task-notification` waterfall after selecting an eligible live top-level completion. The event carries only the outcome, never Session identity, task text or errors. Without a policy, delivery remains permitted.

The Bundle registers a reversible listener that reads the current settings value and either delegates with `next()` or vetoes delivery. A throwing policy suppresses that notification and logs a generic warning without rejecting the committed turn. Removing the Bundle restores default native behavior; settings remain available for reinstallation. Uninstall is therefore not a mute operation, and the editor explains that distinction.

The existing settings provider owns validation and persistence. The browser editor contributes through the marketplace's keyed action slot and confirms revision-fenced writes against Host observations. The marketplace gives contributions a separate full-width row so configuration forms do not compete with package identity or removal controls. It does not add a marketplace-specific settings store or optimistic success state. The reviewed tarball includes schema dependencies for the installer's empty offline cache.

The [desktop carrier decision](../architecture/2026-08-20-tauri-desktop-carrier.md) remains authoritative for native filtering, generic notification contents, OS permission and transport. This policy does not supersede that ownership or the [Focus Timer decision](2026-09-07-focus-timer-bundle.md); the two optional Bundles exercise independent UI and task-behavior contributions.

## Alternatives considered

**Send notifications from a second plugin.** Rejected because the native provider already observes eligible turns and owns delivery. A policy extension preserves one sender and the existing default behavior.

**Put switches in the marketplace or native host.** Rejected because an optional Bundle must own its settings and reversible behavior. The marketplace supplies installation and the extension slot, while Rust retains operating-system integration.

**Change the agent loop or Session format.** Rejected because notification delivery is a post-commit desktop concern and contributes no model-visible input.

## Consequences

The Bundle changes notification policy without replacing Harness execution or native recovery. Trusted same-process plugins can still call notification APIs directly; this policy is not a security sandbox or a restriction on every possible sender. Native focus suppression and OS authorization remain independent.

Unit tests cover defaults, independent switches, policy delegation and disposal, failed writes and policy exceptions. Packaged acceptance installs the actual reviewed artifact with pinned pnpm and an empty offline cache, edits the real browser contribution, emits Session events through the native provider, restarts to verify persistence, and removes the Bundle to verify restored defaults. The authenticated native bridge is a fixture; actual OS notification delivery remains target-native acceptance.
