---
description: "Configure completion and failure notifications through an optional desktop Bundle."
kind: "package-bundle"
---

# @deepseek-ai/dsh-notification-controls

English | [中文](README.zh.md)

## Summary

Choose whether Qabas notifies you when a task finishes or fails. The two switches save independently and apply to future task completions. This optional Bundle controls the desktop's existing notifications; it does not send another notification or change task execution.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open Settings → Plugins → Marketplace, select Notification Controls, review installation, and confirm installation for the next launch. Finish current tasks, then quit and reopen the desktop application. In Installed, expand Configure notifications. A separate Node or pnpm installation is not required.

Both switches initially permit notifications. Changing a switch saves that preference through the Host; a disabled switch suppresses the corresponding completion or failure notification. The displayed switches follow the saved Host observation. If saving cannot be confirmed, inspect the current switches before retrying. Preferences survive application restarts.

Leave the application in the background while a task runs and grant OS notification permission. The native provider omits task contents and does not notify for canceled tasks, subagents or restored history. These switches do not grant OS permission or override foreground suppression.

To silence notifications, disable the switches rather than remove the Bundle. Installed → Review removal prepares removal for the next launch. Removal restores the desktop's default notification behavior and retains saved preferences for reinstallation.

This package ships as a reviewed local tarball, not a promise of npm registry availability. Its bundled schema dependencies permit installation with the desktop's empty offline package cache. The patch inserts one `notification-controls` row.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[The Host entry](src/index.ts) registers the `notification-controls` settings namespace and a reversible `desktop/task-notification` policy. It reads the latest completion or failure preference when the native provider requests delivery. An enabled preference delegates with `next()`; a disabled preference returns false. Unloading removes the policy without changing the native provider or stored preferences.

[The browser entry](src/client/index.ts) contributes a keyed marketplace action through the existing Slots mechanism. The editor uses the Host settings scope for revision-fenced writes and reports success only after observing the requested value. It owns no second preference store. The policy does not import the native provider at runtime; its type-only import declares the event.

No invariant companion is published: the settings provider owns validation and persistence, and the policy reads that state without a separate mirror. The [native provider](../desktop-native/README.md) owns notification eligibility, transport and policy-failure handling.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Desktop packages](../README.md) — native capabilities and optional Bundles.
- [Marketplace](../bundle-marketplace/README.md) — reviewed installation and next-launch activation.
- [Notification policy decision](../../../.agents/notes/implemented/feature/2026-09-07-notification-controls-bundle.md) — lifecycle, defaults and task isolation.

<a id="model-experience"></a>
## Model Experience

None, as this notification policy adds no model input or Session events.

#### KV Cache effect

The Bundle does not change system prompts, tool schemas, request prefixes or model cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The native provider must have `notifyOnTurnEnd` enabled; the desktop overlay enables it. Installing this Bundle into a browser-only profile does not supply native notifications.
- Preferences use the selected Harness home's settings document. Saving requires a writable Host connection; preferences are not synchronized between devices.
- Notification delivery still depends on the operating system. The packaged smoke uses an authenticated bridge fixture, not actual OS permission or notification-center delivery.
- Installed plugins run as trusted same-process code. This policy does not sandbox plugins or govern their direct notification calls.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
