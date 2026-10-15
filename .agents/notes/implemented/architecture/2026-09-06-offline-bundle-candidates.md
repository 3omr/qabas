# Agent Note: Offline Bundle dependency candidates without Profile activation

Status: implemented

## Problem

Reviewed tarball bytes do not establish that a Bundle has usable dependencies. Installing into a live Profile can trigger reload before configuration and activation checks finish. Candidate preparation needs a separate destination and a process lifecycle that survives cancellation without leaving installers running.

## Decision

Optional [operation history](2026-09-07-preparation-operation-history.md) preserves preparation observations without changing dependency validation or granting activation authority.

The optional [Bundle preparation service](../../../../packages/desktop/bundle-preparation/README.md) provides `prepareDependencies()` alongside [byte preparation](2026-09-06-reviewed-bundle-preparation.md). It accepts a current catalog identity, verifies fresh bytes and bounded archive contents, then invokes deployment-owned Node and version-pinned pnpm through the existing local subprocess provider. No core loader, agent loop or vendored Cordis change is required.

Each operation owns a private non-Profile project, empty package store and installer home. Ambient environment values are removed except Windows OS locations; scripts, pnpm hooks, peer auto-installation and registry downloads are disabled. Only self-contained reviewed Bundles are supported. The tar inspector rejects links, special entries, nonportable paths, identity mismatch and absent Bundle patches before extraction. Successful candidates include verified installed identity, a lockfile and a `dependencies-prepared-not-enabled` receipt; no plugin code is imported by preparation.

The service cancels and drains managed process trees before deleting a failed operation's directory. Earlier successful artifacts remain untouched. Disposal rejects new work and waits for owned cleanup; termination grace and filesystem work may extend past the operation deadline. Candidate creation does not mutate Profile or Session data.

## Alternatives considered

**Install into the selected Profile.** Rejected because dependency preparation would also request composition changes and could trigger live reload.

**Use the developer's package manager, cache and environment.** Rejected because acceptance would depend on machine state and could expose account configuration to the installer. The desktop owns its pinned distribution; each candidate uses empty local state.

**Download arbitrary dependency trees during preparation.** Deferred because reviewed top-level bytes do not pin all downloaded code. Self-contained artifacts give the initial offline workflow an explicit review unit; broader resolution needs a separate provenance and network policy.

## Consequences

The [packaged smoke](../../../../apps/desktop/scripts/smoke-plugins.mjs) exercises real bundled pnpm, a bundled dependency with a failing install script, missing-dependency failure, unchanged Profile state, and subsequent upstream Host/browser activation and removal. Unit tests cover archive bounds, candidate cleanup, version mismatch, environment scrubbing, cancellation, timeout and process drainage. Native Windows and WebView acceptance remain platform-owned work.

Directory and environment isolation is not an OS sandbox. Catalog authors and the configured package manager remain trusted; packages requiring native build scripts are unsupported. Dependency-only preparation does not validate composition; the separate [candidate Profile decision](2026-09-07-candidate-profile-composition.md) owns that check. There is no remote catalog, end-user install UI, crash-recoverable journal, controlled activation or recovery of a failed active Profile. Interrupted processes may leave incomplete directories; receipt existence grants no activation authority. The [marketplace proposal](../../proposed/architecture/2026-09-06-desktop-plugin-marketplace.md) still owns those remaining product decisions.
