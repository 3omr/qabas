# Desktop host

English | [中文](desktop.zh.md)

The desktop subsystem is an optional [capability seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md) between a Harness Host and the native application that owns its process. The Service Definition ([dsh-desktop](../../packages/desktop/desktop)) exposes only `ctx.desktop`; the authenticated loopback Service Provider ([dsh-desktop-native](../../packages/desktop/desktop-native)) forwards that narrow contract to the Tauri host. Browser and headless compositions do not load either package.

## Boundary

The marketplace declares the root keyed slot `settings.bundleMarketplace.action` for plugin-owned use controls. Its key is the installed npm package name; its owner props reuse `SettingsPluginsTabOwnerProps`, including the Settings shell's `close` callback. Only confirmed-version entries in the selected Profile render these contributions outside a startup trial. The [marketplace reference](../../packages/desktop/bundle-marketplace/README.md#implementation) owns registration semantics; native startup does not interpret these browser actions.

The optional [marketplace plugin](../../packages/desktop/bundle-marketplace/README.md) exposes browser commands over the existing authenticated Remote transport. `MarketplaceEntry` projects catalog identity, title, package/version, publisher, source and compatibility issues without artifact paths. `MarketplaceSnapshot` combines these entries with native `DesktopProfileSelection` and `MarketplaceProfile` observations. Each Profile is either `unavailable` or `read` with ordered `ProfileBundle` values containing `packageName` and a nullable resolved `version`; these are file observations, not running-plugin health. `MarketplaceCommandResult` distinguishes `acknowledged` from `unconfirmed`, which requires a fresh read before retrying. The browser contribution mounts its own Remote namespace and Settings tab without changing the base Web assembly.

`BundleCatalogStatus` reports bundled, online, cached or unavailable metadata, whether remote checking is configured, and the nullable signed revision and expiry. `BundleReviewToken` binds a candidate's complete metadata and catalog revision to installation consent; both `BundleCandidate` and `MarketplaceEntry` carry it. The preparation service rejects changed or expired reviews before preparation and native queue dispatch. `MarketplaceSnapshot.catalog` exposes status without trust keys, cache paths or artifact URLs.

`ProfileBundle.removable` identifies a confirmed direct dependency resolved inside its Profile, excluding installation-owned, indirect and external packages. Removal commands carry the observed active Profile, package name and version; the Host rechecks these observations before preparing a new composition.

The separate [Bundle preparation service](../../packages/desktop/bundle-preparation/README.md) runs in Cordis, not in the native host. Its receipts describe reviewed bytes, offline dependencies or validated Profile composition. Its explicit activation operation prepares a fresh generation and queues it through the native desktop capability; the native host owns startup confirmation and recovery.

Its [types](../../packages/desktop/bundle-preparation/src/types.ts) distinguish the catalog-issued `BundleCatalogId`, a `BundleCandidate` containing compatibility findings, a `PreparedBundle` with verified artifact metadata and staging paths, and `PreparedDependencies` with private candidate, installed package, lockfile and receipt paths. Their states are `prepared-not-enabled` and `dependencies-prepared-not-enabled`; neither proves runtime readiness or publisher identity.

`PreparedComposition` records the candidate Harness home and Profile, a refreshed Profile lockfile, composed YAML and a source-configuration fingerprint. Validation-only candidates use a private home; activation candidates use an independent Profile in the existing desktop home. `composition-checked-not-enabled` means the normal dsh launcher composed the copied layers without booting them; it is not an active installation or runtime health result.

`PreparedRemoval` retains the composition paths and fingerprint without a dependency-installation candidate. It carries `removed.packageName`, `removed.version` and state `removal-checked-not-enabled`. It proves boot-free validation of a copied Profile with that direct Bundle removed, not deletion from the active Profile or erasure of plugin data.

`BundleOperationId` identifies one preparation attempt. `PreparationOperation` reports its optional catalog metadata or `removed` package/version, requested `PreparationKind`, start time and observed state: `preparing`, `unsettled`, `prepared`, `failed`, `unreadable` or `unavailable`. `PreparationKind` includes `removal` independently of catalog artifact stages. `preparedState` identifies a completed preparation stage, not an active installation. The [package reference](../../packages/desktop/bundle-preparation/README.md#operation-history) owns history semantics and retention limits.

The seam reports whether the native host is reachable and exposes window activation, operating-system notifications, and login autostart. It does not expose an arbitrary native command channel, filesystem escape hatch, session data, settings, or credentials. A provider rejects operations that the host cannot complete instead of silently emulating them in Node.js.

`DesktopProfileName` is a branded native Profile name. `DesktopProfileCandidate` carries `profile`, expected `previousProfile` and `manifestSha256`. `DesktopProfileSelection` has `schemaVersion: 1`, an `activeProfile`, nullable `previousProfile`, nullable `pending` and `trial` candidates, and nullable `lastFailure` with a candidate and `interrupted`, `startup-failed` or `invalid-candidate` reason. These identities support next-launch queueing and exact cancellation; neither pending nor trial state means an active installation.

The desktop composition gives trusted Host plugins access to this capability. Per-plugin principals and per-call permission grants are deferred; consumers must therefore remain part of the trusted application composition.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbundlepreparation--bundlepreparation"></a>

### `ctx.bundlePreparation` — `BundlePreparation`

Verify catalog compatibility and stage reviewed bytes without importing package code.

```ts cordis-catalog
/**
 * List review records and every declared compatibility mismatch; performs no artifact I/O.
 * @returns Catalog-order candidates, not installation or runtime status.
 */
list(): readonly BundleCandidate[]

/**
 * Observe catalog provenance and expiry without fetching or exposing deployment paths.
 * @returns Current authorization to discover candidates, not plugin runtime health.
 */
catalogStatus(): BundleCatalogStatus

/**
 * Check the deployment-pinned online catalog only on explicit request, without installing anything.
 * Rejects concurrent preparation/refresh; a failed check preserves the previous verified revision.
 * @returns Completion after verified metadata is cached and selected.
 */
async refreshCatalog(): Promise<void>

/**
 * Read persisted attempt metadata without loading plugins or granting activation authority.
 * Unsettled records may belong to another live process; no automatic cleanup or retry occurs.
 * @returns Bounded history with altered receipts and unreadable records explicitly marked.
 */
async listOperations(): Promise<readonly PreparationOperation[]>

/**
 * Read the selected Profile's ordered Bundle versions without importing code or changing files.
 * @param profile - identity supplied by the native selection owner, never a browser-supplied path.
 * @returns Manifest observations with null versions for unreadable packages, not runtime health.
 */
async profileBundles(profile: DesktopProfileName): Promise<readonly ProfileBundle[]>

/**
 * Stage a catalog-selected tarball in an exclusively created operation directory.
 * Rejects unknown/incompatible entries, overlapping operations, symlinks and mismatched bytes.
 * This does not resolve dependencies, inspect archive contents, install, or activate the Bundle.
 * @param id - identity obtained from the current catalog.
 * Recording failures can retain a completed candidate; receipts never grant activation authority.
 * @returns Receipt after preparation and optional history publication complete.
 */
async prepare(id: BundleCatalogId): Promise<PreparedBundle>

/**
 * Prepare an offline candidate using bundled pnpm and a local subprocess provider.
 * Missing dependencies fail; scripts, hooks and automatic peer installation are disabled.
 * This creates no Profile and performs no activation. Preparation failures remove this operation's directory.
 * A subsequent history-publication failure can retain the completed candidate.
 * @param id - identity from the current catalog, never a caller-supplied receipt or file path.
 * @returns An installed candidate requiring separate composition and activation validation.
 */
async prepareDependencies(id: BundleCatalogId): Promise<PreparedDependencies>

/**
 * Build a private copy of the configured Profile and check its Bundle patches with dsh --dump-config.
 * Does not boot plugins, evaluate configuration expressions, switch Profiles or restart the app.
 * A history-publication failure can retain the completed candidate without authorizing activation.
 * @param id - identity selected from the current catalog.
 * @returns A composition receipt after source-configuration checks and boot-free validation.
 */
async prepareComposition(id: BundleCatalogId): Promise<PreparedComposition>

/**
 * Prepare a fresh Profile in the desktop home and queue it for the next full application launch.
 * Does not restart the runtime. After dispatch, transport failures retain all candidate files;
 * native selection must be inspected before retry or cleanup. History describes preparation only.
 * @param id - identity selected from the current reviewed catalog.
 * @param profile - native-selected Profile observed during confirmation.
 * @param version - observed installed version, or null only when the Bundle was absent.
 * @param reviewToken - digest from the exact catalog entry shown during confirmation.
 * @returns Candidate identity after native queue acknowledgement, not a running-plugin claim.
 */
async queueActivation( id: BundleCatalogId, profile: DesktopProfileName, version: string | null, reviewToken: BundleReviewToken, ): Promise<DesktopProfileCandidate>

/**
 * Remove an observed Profile-owned Bundle in a fresh composition and queue the next full launch.
 * Refuses stale selection, changed versions, built-in packages and overlapping operations.
 * Original configuration, packages and Session data remain intact; unknown queue outcomes retain candidates.
 * @param profile - active Profile observed by the caller, checked against native selection.
 * @param packageName - listed package name, never a path or catalog identity.
 * @param version - exact observed version to remove.
 * @returns Native queue acknowledgement; removal is not active until a successful application restart.
 */
async queueRemoval(profile: DesktopProfileName, packageName: string, version: string): Promise<DesktopProfileCandidate>
```

Source: [`packages/desktop/bundle-preparation/src/index.ts`](../../packages/desktop/bundle-preparation/src/index.ts)

<a id="ctxdesktop--desktophost-abstract-seam"></a>

### `ctx.desktop` — `DesktopHost` (abstract seam)

Native desktop capability. Implementations cross the process boundary into the owning desktop shell and reject when that shell cannot complete the operation.

```ts cordis-catalog
/**
 * Check that the native desktop host is reachable.
 * @returns Available status after a complete bridge round trip.
 */
abstract status(): Promise<DesktopStatus>

/**
 * Show and focus the primary application window.
 * @returns After the native host completes the operation.
 */
abstract show(): Promise<void>

/**
 * Open or focus the native local-agent settings window without running checks or changing preferences.
 * @returns After the native host completes the window operation; no agent-readiness claim.
 */
abstract openLocalAgents(): Promise<void>

/**
 * Display an operating-system notification.
 * @param notification - user-visible title and body.
 * @returns After the native host accepts the notification.
 */
abstract notify(notification: DesktopNotification): Promise<void>

/**
 * Enable or disable launch at user login.
 * @param enabled - desired autostart state.
 * @returns After the operating system records the state.
 */
abstract setAutostart(enabled: boolean): Promise<void>

/**
 * Read the native host's persisted startup selection without scanning plugin contents.
 * @returns Active, queued, trial and failed startup identities; no installation-health claim.
 */
abstract profileSelection(): Promise<DesktopProfileSelection>

/**
 * Queue a prepared Profile for the next full application launch; does not interrupt tasks.
 * A transport failure can leave the queue committed: inspect selection before retry or cleanup.
 * @param candidate - prepared identity with the expected active predecessor and manifest hash.
 * @returns After the native host records the pending selection.
 */
abstract queueProfile(candidate: DesktopProfileCandidate): Promise<void>

/**
 * Cancel the exact pending Profile without deleting its files or changing the active runtime.
 * @param profile - pending identity obtained from native selection.
 * @returns After the native host clears the pending selection.
 */
abstract cancelProfile(profile: DesktopProfileName): Promise<void>

/**
 * Start the native PTY-backed `nlm login` session.
 * @returns the opaque session identity used by the poll and input methods.
 */
abstract startNotebookLmAuth(): Promise<NotebookLmAuthSession>

/**
 * Read PTY output after a byte cursor.
 * @param session - native authentication session identity.
 * @param cursor - previously returned output cursor.
 * @param signal - optional cancellation for the bridge read.
 * @returns output after the cursor and process status.
 */
abstract pollNotebookLmAuth(session: NotebookLmAuthSession, cursor: number, signal?: AbortSignal): Promise<NotebookLmAuthPoll>

/**
 * Send one line to the native PTY.
 * @param session - native authentication session identity.
 * @param line - one user-entered line without an implicit newline.
 * @returns after the native host writes the line.
 */
abstract writeNotebookLmAuth(session: NotebookLmAuthSession, line: string): Promise<void>

/**
 * Terminate the native PTY session.
 * @param session - native authentication session identity.
 * @returns after the native host requests termination.
 */
abstract cancelNotebookLmAuth(session: NotebookLmAuthSession): Promise<void>
```

Source: [`packages/desktop/desktop/src/index.ts`](../../packages/desktop/desktop/src/index.ts)

<a id="desktop-events"></a>

### `desktop/*` events

<a id="desktoptask-notification--waterfall"></a>

#### `desktop/task-notification` — waterfall

Decide whether a live top-level turn may request a background notification. Policies call next() to delegate or return false to suppress delivery; no listener permits delivery. A thrown policy suppresses this notification without changing the committed turn.

```ts cordis-catalog
/**
 * Decide whether a live top-level turn may request a background notification.
 * Policies call next() to delegate or return false to suppress delivery; no listener permits delivery.
 * A thrown policy suppresses this notification without changing the committed turn.
 * @param outcome - Completion or failure only; no Session identity or task contents.
 * @param next - Delegate to remaining policies.
 * @mode waterfall
 */
'desktop/task-notification'(outcome: 'completed' | 'error', next: () => boolean): boolean
```

Source: [`packages/desktop/desktop-native/src/index.ts`](../../packages/desktop/desktop-native/src/index.ts)
<!-- END GENERATED cordis-surface -->
