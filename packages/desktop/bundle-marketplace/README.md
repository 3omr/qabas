---
description: "Browse reviewed Bundles and request native next-launch activation from desktop Settings."
kind: "package-reference"
---

# @deepseek-ai/dsh-bundle-marketplace

## Summary

Browse reviewed Bundles, inspect compatibility, and confirm installation for the next application launch. The current session keeps running. Native selection distinguishes a pending candidate from the active Profile; an uncertain command response requires a fresh read, not an automatic retry. This optional plugin uses the existing preparation service and native host.

## Table of Contents

- [Composition](#composition)
- [Implementation](#implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="composition"></a>
## Composition

The [desktop overlay](../../../apps/desktop/runtime/desktop.cordis.yml) mounts this package alongside configured `bundlePreparation` and `desktop` providers. There are no package configuration fields. It is a plugin, not an installable Bundle; the upstream Web profile does not mount it. The [browser acceptance test](../../../apps/web/tests/bundle-marketplace.e2e.ts) supplies an isolated composition with a reviewed fixture.

The browser contribution adds a Marketplace tab to Settings → Plugins. It loads metadata when opened, displays publisher/source and compatibility findings, and requires a separate confirmation before preparing code. Host plugins remain trusted same-process code with Harness access; review metadata is not a sandbox or independent publisher verification.

Configure local agents opens the existing native Extensions window. This built-in connection entry is separate from installable Bundles and keeps one owner for saved agent choices. Opening it performs no account check, login, installation or model task; the window owns the explicit detection and opt-in flow. Failed or uncertain responses offer the application-menu fallback, and connection changes discard stale window responses. The entry is not a collaboration Bundle.

Preparation queues a candidate without interrupting running tasks. Users finish their tasks, quit, and reopen the application to activate it. Cancellation targets exactly the observed pending Profile and preserves its files. The native owner, not the browser, decides startup success and recovery.

Discover lists reviewed entries; Installed lists the selected, pending and trial Profiles separately, with versions read through the upstream Bundle resolver. Missing package metadata remains explicitly unconfirmed. A changed native selection rejects the snapshot instead of mixing generations. These are on-disk observations, not running-plugin health checks or proof that the files match a reviewed tarball. The view prevents duplicate same-version installation and blocks installation when the current inventory or the selected package's version cannot be read.

Discover and Version changes search title, package name, publisher and the current language's description locally without another Host read. Version changes includes only known installed versions that differ from this catalog, retaining compatibility warnings and the existing confirmation. Search and view changes dismiss an open review. An unreadable inventory cannot produce a misleading no-differences result.

When the preparation provider configures an online channel, Check online catalog explicitly refreshes its signed metadata. The tab distinguishes bundled, verified online, cached and unavailable metadata; a status refresh alone never contacts the catalog server. Catalog checks do not install code or require a platform account. Installation carries the entry's review token so changed metadata requires fresh confirmation.

Operation history reads the bounded preparation journal on demand, separately from discovery. Prepared means its receipt was verified, not that native queueing, startup or plugin health succeeded. Unsettled outcomes, failed preparation, unreadable metadata and missing or changed receipts remain distinct. Unconfigured or unreadable history shows an unavailable state; it never becomes an empty list. Connection replacement and refresh discard stale responses. No background polling or history mutation is provided.

The tab drops unconfirmed observations on disconnect, reloads on reconnect or manual refresh, and rereads after every command settles. It never retries a mutation automatically. The gateway returns discovery metadata, native selection and ordered package/version observations; artifact paths, receipts, configuration, native tokens and raw command errors are not returned.

An installed Bundle at a different catalog version offers Review version change. The confirmation shows the observed version and target version; Replace for next launch preserves the active composition. Every install request carries the reviewed Profile and old version, with null reserved for absence. The preparation service rechecks them instead of interpreting stale confirmation as a new installation. The marketplace does not sort versions, promise an upgrade, migrate plugin data or guarantee downgrade compatibility. Review focuses Back so keyboard users can inspect or dismiss it without selecting the mutation by default.

Installed offers a separate removal review for direct Profile-owned Bundles with confirmed versions. Confirmation creates and validates a new combination, then queues it for the next full launch. It never deletes the active Profile or plugin data. Built-in, indirect and unconfirmed packages are not removable here; pending and trial combinations are read-only. The Host checks selection, ownership and the observed version again. An uncertain removal response triggers a status read, not an automatic retry.

<a id="implementation"></a>
## Implementation

<details>
<summary>Host commands and browser ownership</summary>

The [gateway](src/index.ts) exposes a package-owned generated Remote namespace over the existing authenticated application transport. The [browser entry](src/client/index.ts) mounts that namespace and contributes its localized slot with Cordis effects. The [component](src/client/MarketplaceTab.tsx) receives callbacks and a renderer-bound connection generation, not services or native credentials. No invariant companion is published because the gateway retains no independent installation or activation registry.

The tab declares the root keyed slot `settings.bundleMarketplace.action`. It renders a package's registered action only for a confirmed-version entry in the selected Profile, outside a startup trial. The npm package name is the key; the owner supplies the existing Settings `close` callback. Each contributor owns its localized controls and behavior. Pending entries and unknown versions have no use action. No registration renders nothing; the marketplace does not invent an action or treat it as a health check.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Preparation](../bundle-preparation/README.md) — reviewed artifacts, generation creation and cleanup.
- [Native host](../desktop/README.md) — queue, cancellation and selection values.
- [Marketplace decision](../../../.agents/notes/implemented/architecture/2026-09-07-desktop-marketplace-browser.md) — discovery and activation state ownership.

<a id="model-experience"></a>
## Model Experience

None, as browser discovery and next-launch commands add no model input to the active composition.

#### KV Cache effect

This plugin does not change an active model request prefix. Activated Bundles own their subsequent model-visible behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The packaged catalog is local unless the deployment configures a trusted online channel. [Source proposals](../../../docs/cookbook/desktop-marketplace-bundle.md) require maintainer review; public signed-feed hosting and self-service publication are not supplied by this UI. No automatic installation occurs.
- Installed versions are read from disk, not from a live health check. Use and configuration actions require each plugin's explicit contribution. Login forms, public feed operation and active-task restart coordination remain separate work. Removal retains previous generations and plugin data; storage cleanup is not provided.
- The desktop catalog offers optional [Focus Timer](../focus-timer/README.md), [Notification Controls](../notification-controls/README.md) and [Delegate Tasks](../delegation-launcher/README.md), each with an Installed action. This is a curated first-party catalog, not an open publisher marketplace.

<a id="dev-note"></a>
### Dev Note

None.
