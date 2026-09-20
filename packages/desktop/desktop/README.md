---
description: "Native window, notification, and autostart operations for plugins running inside Harness Desktop."
kind: "package-reference"
---

# @deepseek-ai/dsh-desktop

English | [中文](README.zh.md)

## Summary

Desktop-hosted plugins can show the application window, send operating-system notifications, and control launch at login through `ctx.desktop`. A provider rejects operations the native host cannot complete. Browser and headless deployments do not receive an emulated desktop service.

## Table of Contents

- [Composition](#composition)
- [Implementation](#implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="composition"></a>

## Composition

Load the [native provider](../desktop-native/README.md) in the [desktop launch overlay](../../../apps/desktop/runtime/desktop.cordis.yml). This abstract service has no configuration and is not an independently installable Profile Bundle.

Notifications may set `backgroundOnly` to suppress delivery while the main window is focused. An accepted notification is not proof that the OS displayed it; system permissions and notification settings still apply.

`openLocalAgents()` opens or focuses the native extension settings without checking accounts, changing preferences or starting delegation. Its acknowledgement confirms only the window operation. The native page retains ownership of local-agent setup.

The NotebookLM authentication methods start and control the native `nlm auth` PTY. They expose incremental output and user-entered lines to trusted Host consumers; the transcriber engine owns the user-facing conversation and verifies completion with its live doctor.

Trusted preparation consumers can inspect the native Profile selection, queue a prepared Profile for the next full application launch, and cancel the exact pending selection. Queueing never restarts the running app. A failed transport response can follow a committed queue; inspect native selection before retrying or deleting candidate files. Startup confirmation and recovery belong to the [native selection owner](../../../.agents/notes/implemented/architecture/2026-09-07-desktop-profile-startup-selection.md), not an emulated Node state.

<a id="implementation"></a>

## Implementation

<details>
<summary>Native capability ownership</summary>

The [service definition](src/index.ts) exposes operations without depending on Tauri or a browser. Its provider owns the process transport. No runtime invariant companion is published because the abstract service owns no mutable observations; Cordis owns service registration and disposal.

</details>

<a id="model-experience"></a>

## Model Experience

### Native desktop operations

#### What the model sees

Nothing directly. Consumers decide whether a call such as `ctx.desktop.notify(...)` becomes a command, tool, or background policy.

#### Token effect

The Service Definition adds no prompt, message, schema, or tool result.

#### KV Cache effect

The service preserves every reusable model-request prefix because it contributes no model input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Trusted Host consumers only**: the service has no plugin principal or per-call permission grant; a mounted Host plugin can invoke every operation the active provider implements.

<a id="dev-note"></a>

### Dev Note

None.
