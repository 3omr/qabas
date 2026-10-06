---
description: "Verify reviewed Bundle artifacts before installation without changing the active Harness profile."
kind: "package-reference"
---

# @deepseek-ai/dsh-bundle-preparation

English | [中文](README.zh.md)

## Summary

Prepare a reviewed bundled or signed online tarball without activating it. Byte preparation checks declared Host/platform compatibility, size and SHA-256; optional dependency preparation installs a self-contained Bundle into a private candidate project. Neither operation changes a Profile or Session. Deployment maintainers supply the trusted catalog and package manager; this is not publisher verification or a security sandbox.

## Table of Contents

- [Composition](#composition)
- [Implementation](#implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="composition"></a>

## Composition

Mount the installed `@deepseek-ai/dsh-bundle-preparation` entry as a Cordis row in an explicit `dsh` profile overlay. This service is not an installable Profile Bundle; the desktop overlay mounts it alongside the marketplace gateway. The [packaged smoke](../../../apps/desktop/scripts/smoke-plugins.mjs) resolves the packaged entry by file URL and supplies its configuration and a test consumer through the real Web profile, then separately installs the prepared fixture with the existing Bundle CLI.

| Field | Default | Meaning |
|---|---|---|
| `catalogFile` | required | Absolute path to trusted UTF-8 JSON review records |
| `artifactDirectory` | required | Absolute directory containing catalog-named tarballs |
| `stagingDirectory` | required | Trusted absolute staging root, separate from profiles and sessions |
| `hostVersion` | required | Deployment-owned exact Harness version; no version ranges |
| `maxCatalogBytes` | 1048576 | Complete catalog limit, at most 16777216 bytes |
| `maxArtifactBytes` | 52428800 | Compressed artifact limit, at most 268435456 bytes |
| `remote` | false | Optional pinned HTTPS channel, Ed25519 keys, cache path and explicit resource/validity limits |
| `installer` | false | Optional exact Node/pnpm paths, version and operation limits; requires a local `subprocess` provider |
| `composition` | false | Optional source Harness home, Profile name, dsh entry and copy limits; requires `installer` |
| `journal` | false | Optional history directory and read limits, separate from staging and the source Profile |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-bundle-preparation) lists every installer field. All installer fields are required when enabled. The [packaged smoke](../../../apps/desktop/scripts/smoke-plugins.mjs) supplies a complete example with the bundled executables. The provider must execute on the same local filesystem as this service.

The [catalog parser](src/catalog.ts) owns accepted JSON fields. Review records pin exact artifact filenames, sizes and hashes. Paths and records are trusted deployment inputs, not user-entered installation arguments. Restart the service to load a changed bundled catalog.

Consumers inject `bundlePreparation` and select an identity from `list()`. `prepare(id)` returns `prepared-not-enabled` after byte verification only. `prepareDependencies(id)` stages fresh bytes, checks archive contents and package identity, then returns `dependencies-prepared-not-enabled` with candidate, package, lockfile and receipt paths. Neither receipt proves activation, runtime compatibility or publisher identity. Callers own retention and must reverify persisted artifacts before reuse.

Dependency preparation uses an empty private pnpm store and home, removes ambient environment values except required Windows OS locations, disables install scripts and pnpm hooks, and performs no registry downloads. Dependencies must be included in the reviewed tarball; missing dependencies fail offline. There is one in-flight operation. Failure removes only its newly created directory; completed candidates survive disposal. Cancellation and timeout terminate the managed process tree and await cleanup, which can extend beyond the deadline by termination grace and filesystem work.

`prepareComposition(id)` also copies the deployment-selected existing Profile, preserves its bundle order and user fields, overlays the candidate package, and refreshes its lockfile offline. Copies prefer filesystem copy-on-write, preserve internal dependency links within the copied tree, and materialize external links under configured byte/entry limits. A separate candidate Harness home contains the copied home patch but no copied Sessions. The candidate uses startup-only patch loading. Its `composition-checked-not-enabled` receipt records Profile paths, the composed YAML, and a fingerprint of the source manifest and Profile/home patches; source-configuration changes during preparation reject the operation.

Composition validation requires the upstream Bundle resolver to select the candidate's installed package, not an installation-owned copy with the same name. It runs the configured `dsh --profile candidate --dump-config` through the managed process provider. It does not boot plugins or evaluate `!!js`; it does not prove service injection, runtime compatibility, permissions or health. The source Profile, module files and staging paths must remain deployment-owned. This is not an atomic filesystem snapshot or a reusable activation authorization. Candidate files can contain private configuration; callers must protect and revalidate them, not expose dumps as public diagnostics.

`profileBundles(profile)` reads the named Profile's ordered layers through the upstream package resolver without importing code or writing files. It requires composition and installer configuration. A null version preserves a listed layer whose package metadata is missing, invalid or unreadable; a missing, malformed, duplicate, oversized or changing Profile rejects the whole read. `maxManifestBytes` bounds each file; `maxProfileEntries` bounds layers and `maxProfileBytes` bounds aggregate manifest content. Versions describe resolved files, not artifact hashes, running plugin health or an atomic snapshot of every package. No inventory is inferred from preparation receipts.

A subprocess outcome rejected after operation cancellation reports the cancellation reason. Provider startup errors remain visible when no cancellation occurred.

### Signed online catalogs

The optional `remote` configuration pins an HTTPS URL, channel, Ed25519 public keys, permitted origins and an absolute cache file. All timeout, byte, lock-wait, validity and clock-skew limits are explicit deployment fields. `refreshCatalog()` fetches only on request; startup reads the cache without network access. Signature verification authenticates the deployment's catalog authority, not independent package authors or code safety. The [signed-catalog decision](../../../.agents/notes/implemented/architecture/2026-09-13-signed-marketplace-catalog.md) owns the trust and publication rules.

An absent cache permits the bundled catalog. A valid unexpired cache supplies offline discovery; artifact installation still downloads its exact signed filename from the permitted HTTPS directory. Downloads reject redirects, omit credentials, limit the complete response and honor cancellation. Expired or corrupt cached metadata blocks discovery and installation instead of falling back to potentially withdrawn bundled entries. Network failure preserves the last verified revision, whose expiry still applies. A corrupt cache requires maintainer recovery; retry does not overwrite an unverifiable revision floor.

Refresh rejects revision rollback and conflicting content at the same revision, including across cooperating processes sharing the cache. Cache replacement is atomic but not fsynced; rollback protection does not survive deliberate cache deletion, a rolled-back filesystem or an untrusted system clock. A crashed writer can leave a lock; an operator must verify that no writer owns it before recovery. No automatic lock deletion occurs. Refresh and preparation exclude one another, and disposal cancels and drains their owned work. These checks do not revoke already installed code or migrate plugin data.

### Native activation

`queueRemoval(profile, packageName, version)` prepares an independent next-launch Profile without a listed Bundle. It rejects a stale native selection, another pending/trial Profile, a changed package version, or a package that is not a direct dependency resolved inside the source Profile. Installation-owned, indirect and externally linked packages are not removable through this operation. `profileBundles()` exposes this eligibility as `removable`; the executor rechecks it against source and copied files rather than trusting the browser. Removal preserves the original Profile, packages, home patch and Session data. It removes only the copied package entry and direct dependency, refreshes the lockfile offline and validates the remaining composition through the normal launcher. Unreferenced store files and plugin data are not purged.

`queueActivation(id, profile, version, reviewToken)` requires the native desktop service and composition/installer configuration. The caller supplies the exact review token returned by `list()` and the observed active Profile and exact installed version, or null only for an absent Bundle. A changed or expired catalog, changed native selection, unreadable listed version, stale version or same-version request rejects activation. Source and copied inventory checks surround composition, and a final source-version check precedes native queue dispatch. These observations do not lock the Profile or verify every installed byte.

Activation creates an exclusive `desktop-<UUIDv4>` generation directly under the original Harness home and runs the same copy and boot-free validation. Replacement preserves Bundle order, original packages and the shared home patch. Dependency links target that generation; no post-validation relocation occurs. Configuration must name the actual desktop home. Preparation and its optional journal commit finish before the service queues the exact manifest hash through `ctx.desktop`; the returned identity means awaiting restart, not enabled. The marketplace does not migrate plugin data or guarantee downgrade compatibility.

Failed generation preparation removes its owned files. A completed generation can remain when history publication or final pre-dispatch validation fails; no queue is sent in those cases. After native dispatch, a lost response retains the generation, staged artifact and receipts because the native queue may already have committed. Inspect `ctx.desktop.profileSelection()` before retrying or cleaning up. Service disposal drains a dispatched queue operation without undoing it. The service never restarts the app or infers that active tasks have finished.

<a id="operation-history"></a>

### Operation history

When `journal` is configured, `listOperations()` reads preparation metadata across service restarts without loading plugins. It reports `preparing` only for this service instance's active attempt; another instance or a restarted process reports an unterminated attempt as `unsettled`, not abandoned. Completed attempts report `prepared` or `failed`. Invalid metadata remains `unreadable`; a missing or changed prepared receipt is `unavailable`. Prepared history verifies receipt bytes only, not candidate code, safety or activation.

Removal history uses `kind: removal` and the observed package/version under `removed`, not a fabricated catalog entry. Its `removal-checked-not-enabled` receipt records the independently validated Profile and source fingerprint. Preparation history remains separate from native queue acknowledgement.

The deployment supplies an absolute history directory outside staging and the configured source Profile, plus required `maxEntries` and `maxRecordBytes` read bounds. Parent paths remain trusted deployment inputs. Reads reject an oversized directory or unknown entry rather than silently truncating history; callers own retention. Metadata publication is atomic but does not fsync and promises no power-loss durability. A recording failure rejects preparation and can leave an already completed candidate; failure records omit raw errors, child output and configuration. No history read retries work, deletes files, or infers another process has stopped. See the [history decision](../../../.agents/notes/implemented/architecture/2026-09-07-preparation-operation-history.md).

<a id="implementation"></a>

## Implementation

<details>
<summary>Preparation ownership</summary>

The [Cordis service](src/index.ts) owns catalog validation and operation cleanup. The [archive inspector](src/archive.ts) limits complete gzip expansion, entries and manifests; it rejects nonportable paths, links, special entries, mismatched identity and missing Bundle patches before pnpm extraction. The [candidate installer](src/installer.ts) uses the existing subprocess lifecycle, exact package-manager version and bounded output. Its project has no `dsh.profile`, so preparation cannot trigger Profile reload. No runtime invariant companion is published: operations validate their outputs directly and maintain no installation/runtime mirror.

</details>

<a id="further-exploration"></a>

## Further Exploration

- [Desktop subsystem](../../../docs/subsystems/desktop.md) — native and Harness ownership.
- [Profile composition](../../../docs/architecture.md) — supported application launch.
- [Marketplace proposal](../../../.agents/notes/proposed/architecture/2026-09-06-desktop-plugin-marketplace.md) — remaining product workflow.

<a id="model-experience"></a>

## Model Experience

None, as artifact preparation contributes no model input or active plugin composition.

#### KV Cache effect

Preparation changes no model request prefix, so it does not affect provider cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Online checks require deployment configuration; the packaged desktop uses its bundled catalog until a trusted channel is configured. Public feed hosting, signing-key custody, online dependency resolution and configuration forms are separate deployment/product work.
- Only reviewed self-contained Bundles are supported. Native dependencies requiring install scripts and arbitrary third-party packages are unsupported; directory/environment isolation is not an OS sandbox.
- Staging is not a crash-recoverable transaction. Interrupted processes can leave incomplete directories; no restart consumer treats those as installed state.

<a id="dev-note"></a>

### Dev Note

None.
