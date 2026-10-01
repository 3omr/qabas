# 桌面宿主

[English](desktop.md) | 中文

桌面子系统是 Harness Host 与拥有其进程的原生应用之间一项可选的[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)。Service Definition（[dsh-desktop](../../packages/desktop/desktop)）只公开 `ctx.desktop`；经过认证的回环 Service Provider（[dsh-desktop-native](../../packages/desktop/desktop-native)）把这份窄接口转发给 Tauri 宿主。浏览器与 headless 组合不会加载这两个包。

## 边界

市场声明根级键控 slot `settings.bundleMarketplace.action`，承载插件拥有的使用控件。键为已安装 npm 包名；所有者属性复用 `SettingsPluginsTabOwnerProps`，包括设置外壳的 `close` 回调。仅在不处于试启动状态时，为已选择 Profile 中版本已确认的条目渲染这些贡献。[市场参考](../../packages/desktop/bundle-marketplace/README.zh.md#implementation)拥有注册语义；原生启动不会解释这些浏览器操作。

可选的[市场插件](../../packages/desktop/bundle-marketplace/README.zh.md)通过现有已认证 Remote 传输暴露浏览器命令。`MarketplaceEntry` 投影目录标识、标题、包名与版本、发布者、源码和兼容性问题，不包含产物路径。`MarketplaceSnapshot` 将这些条目与原生 `DesktopProfileSelection` 及 `MarketplaceProfile` 观测组合。每个 Profile 要么为 `unavailable`，要么为 `read` 并包含有序的 `ProfileBundle` 值；每项包含 `packageName` 及可为空的解析版本 `version`。这些是文件观测，不代表运行插件健康状态。`MarketplaceCommandResult` 区分 `acknowledged` 与 `unconfirmed`，后者要求重试前重新读取。浏览器贡献挂载自身 Remote 命名空间与设置标签页，不改变基础 Web 装配。

`BundleCatalogStatus` 报告内置、在线、缓存或不可用元数据、是否配置远程检查，以及可为空的签名版本和有效期。`BundleReviewToken` 将候选完整元数据和目录版本绑定到安装确认；`BundleCandidate` 与 `MarketplaceEntry` 都携带它。准备服务在准备及向原生队列发送前拒绝变化或过期的审核。`MarketplaceSnapshot.catalog` 暴露状态，不包含信任公钥、缓存路径或产物 URL。

`ProfileBundle.removable` 标识解析到 Profile 目录内且已确认的直接依赖，排除安装目录自带包、间接依赖和外部包。卸载命令携带观测到的活动 Profile、包名和版本；Host 在准备新组合前重新核对这些观测。

独立的 [Bundle 准备服务](../../packages/desktop/bundle-preparation/README.zh.md)在 Cordis 中运行，不在原生宿主中运行。它的回执描述审核过的文件、离线依赖或已验证的 Profile 组合。显式启用操作准备新代际并通过原生桌面能力排队；原生宿主负责启动确认和恢复。

其[类型](../../packages/desktop/bundle-preparation/src/types.ts) 区分目录发放的 `BundleCatalogId`、包含兼容性结果的 `BundleCandidate`、包含已验证文件元数据及暂存路径的 `PreparedBundle`，以及包含独立候选项目、已安装包、锁文件和回执路径的 `PreparedDependencies`。其状态为 `prepared-not-enabled` 与 `dependencies-prepared-not-enabled`；两者都不证明运行时就绪或发布者身份已核实。

`PreparedComposition` 记录候选 Harness 主目录及 Profile、已刷新的 Profile 锁文件、组合 YAML 和源配置指纹。仅验证的候选使用私有主目录；待启用候选使用已有桌面主目录中的独立 Profile。`composition-checked-not-enabled` 表示正常 dsh 启动器在不启动插件的情况下完成复制层的组合；它不是生效安装或运行时健康结果。

`PreparedRemoval` 保留组合路径与指纹，不包含依赖安装候选。它携带 `removed.packageName`、`removed.version` 和状态 `removal-checked-not-enabled`。它证明副本 Profile 移除该直接 Bundle 后通过了不启动插件的验证，不表示从活动 Profile 删除包或清除插件数据。

`BundleOperationId` 标识一次准备操作。`PreparationOperation` 报告其可选目录元数据或 `removed` 包名与版本、请求的 `PreparationKind`、开始时间及观测状态：`preparing`、`unsettled`、`prepared`、`failed`、`unreadable` 或 `unavailable`。`PreparationKind` 包含独立于目录产物阶段的 `removal`。`preparedState` 标识已完成的准备阶段，不表示生效安装。[包参考](../../packages/desktop/bundle-preparation/README.zh.md#operation-history) 定义历史语义与保留限制。

该 seam 报告原生宿主是否可达，并公开窗口激活、操作系统通知和登录时启动。它不提供任意原生命令通道、文件系统逃生口，也不读取会话数据、设置或凭证。宿主无法完成操作时，提供方必须拒绝，而不是在 Node.js 中静默模拟。

`DesktopProfileName` 是带品牌的原生 Profile 名称。`DesktopProfileCandidate` 携带 `profile`、预期的 `previousProfile` 和 `manifestSha256`。`DesktopProfileSelection` 包含 `schemaVersion: 1`、`activeProfile`、可空的 `previousProfile`、可空的 `pending` 与 `trial` 候选，以及可空的 `lastFailure`，后者记录候选及 `interrupted`、`startup-failed` 或 `invalid-candidate` 原因。这些标识用于下次启动排队和精确取消；待启用或试启动状态都不代表生效安装。

桌面组合中的可信 Host 插件都可以使用该能力。逐插件 principal 与逐次调用授权仍是延后工作，因此 Consumer 必须保持为可信应用组合的一部分。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
