# Agent Note: Desktop-owned package manager for profile Bundles

Status: implemented

## Problem

The profile plugin CLI expects pnpm on PATH. An installed desktop application cannot assume its user has a package manager or a matching Node installation. A Skill downloader does not prove that an external Cordis package can contribute Host behavior and browser UI to the packaged application.

## Decision

Desktop preparation copies its exact pnpm development dependency into generated runtime resources, retains the package's license files, records its version, and adds relocatable launchers next to the bundled Node. The launchers select that adjacent Node directly. The [packaging smoke](../../../../apps/desktop/scripts/smoke-plugins.mjs) uses the existing packaged `dsh plugin` entry, Profile manifest, and `dsh.bundle.patch` composition; it introduces no new executable-plugin format or application launcher.

The smoke creates a private home and offline file package with Host and prebuilt client halves. Its subprocess environment excludes account credentials, Node injection variables, and ambient package-manager configuration. Only packaged executables appear on PATH. Install scripts and pnpm hooks are disabled. A failing postinstall fixture prevents an accidentally enabled lifecycle from passing silently. The browser fixture uses the existing locale and slot services rather than inserting an unrelated document into the page.

The [repository-plugin removal](../../archived/simplification/2026-08-09-remove-repository-plugin.md) remains authoritative for the single Bundle distribution path. Its host-PATH assumption continues to describe the standalone CLI; this desktop deployment supplies the package-manager runtime explicitly without restoring a configuration-time cache. The [desktop carrier](2026-08-20-tauri-desktop-carrier.md), [agent opt-ins](../feature/2026-09-06-desktop-local-agent-opt-ins.md), and [data-only Skills](../feature/2026-09-06-desktop-curated-skills.md) retain their independent responsibilities.

## Alternatives considered

**Require users to install Node and pnpm.** Rejected for desktop packaging because it makes plugin compatibility depend on an unrelated development environment.

**Build another plugin downloader and loader in Rust.** Rejected because Bundle composition and dependency reconciliation already have an upstream owner. Native process supervision remains separate from plugin-management policy.

**Expose an arbitrary install button immediately.** Rejected because packaging evidence does not provide publisher trust, dependency approval, recoverable updates, or a configuration workflow.

## Consequences

The [reviewed preparation decision](2026-09-06-reviewed-bundle-preparation.md) owns the smoke's pre-install staging step; the package-manager and activation checks remain independent acceptance criteria.

The app carries an additional pinned dependency and its maintenance cost. Packaging acceptance covers offline installation, Host activation, browser rendering, failed-add preservation, removal, and a subsequent clean startup. Relocation tests exercise the launcher independently; temporary paths, stores, profiles, and listeners belong to each test. Hosted desktop CI runs the smoke on macOS arm64 and Windows x64. A local run proves only its executing platform, and Chromium evidence is not native WebView acceptance.

The source-entrypoint check excludes the generated desktop runtime directory, just as it excludes built package outputs; it still rejects unclassified executables in adjacent source and resource directories. Third-party packaged tools are deployment artifacts, not additional supported Harness launchers.

The [desktop marketplace](../../../../packages/desktop/bundle-marketplace/README.md) uses this tool through the preparation service to build next-launch candidates, leaving running profiles and credentials unchanged. The [authoring guide](../../../../docs/cookbook/desktop-marketplace-bundle.md) owns the contribution and acceptance procedure. Online catalog verification, permission enforcement, native UI acceptance, and general third-party compatibility remain separate work in the [marketplace proposal](../../proposed/architecture/2026-09-06-desktop-plugin-marketplace.md).
