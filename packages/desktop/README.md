---
description: "The desktop package group: native host capabilities and their authenticated bridge for the community Tauri application."
kind: "package-group"
---

# desktop/ — native host integration

## Summary

The desktop packages let trusted Harness plugins use the native application's window, notification, and login-autostart capabilities. The service package defines those operations, and the native provider forwards them to the owning Tauri host. Browser and headless profiles do not load this optional integration. Each package README owns its configuration and failure behavior.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The service and provider form the desktop capability seam.

| Package | Role |
|---|---|
| [`desktop/`](desktop/README.md) | Defines native host operations through `ctx.desktop` |
| [`desktop-native/`](desktop-native/README.md) | Forwards those operations over the authenticated local bridge |
| [`bundle-preparation/`](bundle-preparation/README.md) | Prepares reviewed local artifacts in Harness without changing a profile |
| [`bundle-marketplace/`](bundle-marketplace/README.md) | Adds reviewed discovery and explicit next-launch activation to desktop Settings |
| [`focus-timer/`](focus-timer/README.md) | Adds an optional account-free sidebar countdown through a Bundle |
| [`notification-controls/`](notification-controls/README.md) | Adds optional persistent completion and failure notification switches |
| [`delegation-launcher/`](delegation-launcher/README.md) | Adds reviewed human task submission through loaded subagent providers |

<a id="related-documentation"></a>
## Related documentation

- [Desktop subsystem](../../docs/subsystems/desktop.md) — the capability boundary and generated API reference.
- [Desktop application](../../apps/desktop/README.md) — native application lifecycle, development, and packaging.
- [Contribute a desktop Bundle](../../docs/cookbook/desktop-marketplace-bundle.md) — authoring, catalog review and installation-to-use verification.

<a id="dev-note"></a>
## Dev Note

None.
