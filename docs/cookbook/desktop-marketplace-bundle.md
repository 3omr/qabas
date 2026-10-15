# Cookbook: contribute a reviewed desktop Bundle

## Summary

Package a capability so desktop users can install it, open its interface and remove it without editing configuration. This guide covers repository-owned candidates in the shipped review catalog, not self-service publication or arbitrary npm installation. A Bundle composes Cordis plugins; Skills and MCP connections are possible contents, not substitutes for the package and its lifecycle.

## Table of Contents

- [Choose an example](#choose-an-example)
- [Build the Bundle](#build-the-bundle)
- [Add the reviewed artifact](#add-the-reviewed-artifact)
- [Verify the user journey](#verify-the-user-journey)
- [Prepare the review](#prepare-the-review)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="choose-an-example"></a>
## Choose an example

Start with a working checkout and the [desktop development prerequisites](../../apps/desktop/README.md#development). Choose the smallest example that matches the capability:

| Example | Follow it for |
|---|---|
| [Focus Timer](../../packages/desktop/focus-timer/README.md) | An account-free interface with saved preferences |
| [Notification Controls](../../packages/desktop/notification-controls/README.md) | Policy over an existing native capability |
| [Delegate Tasks](../../packages/desktop/delegation-launcher/README.md) | Explicit user commands, remote reads and background-job control |

Keep the agent loop, credentials and native recovery with their existing owners. Use the [documented extension points](../architecture.md) rather than adding another scheduler or application launcher.

<a id="build-the-bundle"></a>
## Build the Bundle

Create the package through the [package checklist](adding-a-package.md). Follow the chosen example's manifest and build configuration rather than copying its business logic. The manifest declares `dsh.bundle.patch`; the patch inserts named Cordis rows. Browser contributions declare their client entry and dependencies. The package's emitted files, patch and required dependency payloads must survive packing.

The desktop installer uses its bundled package manager offline with lifecycle scripts and pnpm hooks disabled. Do not depend on a user's Node installation, a postinstall build or a registry download. Preserve shared Harness and Cordis module identity through the existing build configuration; do not vendor a second runtime into the plugin.

Give users an explicit use or configuration action through `settings.bundleMarketplace.action`, keyed by the package name. Store preferences through the settings capability, put product text in typed English and Chinese dictionaries, and dispose subscriptions when the contribution unloads. A package needing an account must explain configuration and account usage before execution; installation is not consent to start work.

<a id="add-the-reviewed-artifact"></a>
## Add the reviewed artifact

The [catalog builder](../../apps/desktop/scripts/runtime-marketplace.mjs) owns the admitted list. Its current entries map `id` to `packages/desktop/<id>` and `@deepseek-ai/dsh-<id>`; the package version must match the Harness root version. Add the reviewed identity there and update the builder's [fixtures](../../scripts/desktop-marketplace.spec.ts). Do not edit generated catalogs or tarballs.

From the repository root, build and prepare the source-development catalog:

```sh
pnpm run build
node apps/desktop/scripts/prepare-marketplace.mjs
```

The generated directory is `apps/desktop/resources/marketplace`. Its catalog records artifact size and SHA-256, exact Host versions and target platform, publisher, source, license and bilingual purpose/account/access/setup guidance. Inspect the generated entry before review. A hash proves byte identity, not publisher trust; the [strict parser](../../packages/desktop/bundle-preparation/src/catalog.ts) rejects undeclared fields. Screenshots belong in the package README and review evidence.

After preparing the desktop runtime, verify its packaged catalog from the repository root:

```sh
pnpm marketplace:verify apps/desktop/resources/runtime/marketplace
```

Pass a proposed catalog directory to the same command to inspect its adjacent `catalog.json` and declared tarballs. The checker reads without extracting, importing or executing package code. It rejects empty catalogs, missing bilingual guidance, changed bytes, mismatched package identities, unsafe archive paths and exceeded size limits. Success proves packaging checks only, not publisher identity, harmless code, offline dependency completeness or runtime compatibility. The desktop CI runs this check before its runtime tests.

<a id="verify-the-user-journey"></a>
## Verify the user journey

Add a case for the new Bundle to the [packaged smoke](../../apps/desktop/scripts/smoke-plugins.mjs); passing existing examples does not test the new package. Prepare the target runtime and run the smoke with the development Playwright Chromium browser available:

```sh
node apps/desktop/scripts/prepare-runtime.mjs
node apps/desktop/scripts/smoke-plugins.mjs
```

Verify browsing starts neither installation nor inference; installation needs confirmation; the source combination stays unchanged; the next launch resolves the reviewed artifact; its Installed action opens the actual capability; and removal withdraws it after another launch without deleting user data. Cover denied access, unavailable dependencies, interrupted operations and cleanup where the capability owns them. Keep expected UI output beside the test, and add recorded-session coverage for model-visible behavior under the [testing policy](../testing.md).

The browser smoke simulates native queue acknowledgements. Run the separate [native selection and recovery test](../../apps/desktop/src-tauri/src/runtime_profile_tests.rs), then verify the actual macOS or Windows window on an unlocked machine with a separate application identity and data directory. Do not count a build, Chromium run or simulated provider as native UI, other-platform or real-account acceptance.

<a id="prepare-the-review"></a>
## Prepare the review

Open a [Bundle proposal](https://github.com/Bestbbb/deepseek-harness-desktop/issues/new?template=marketplace-bundle.yml) with public source, an immutable commit, artifact checksums and verification evidence. After agreeing on scope with a maintainer, submit source, dependency and license changes, the Bundle patch, bilingual package documentation, its decision record and exact verification results together in a PR. Explain what the user gains, which data and processes the plugin can access, whether account quota can be spent, and how configuration, failure and removal behave. Include screenshots from the built interface rather than mockups. Never submit credentials, private sessions or personal workspace presets.

Host plugins execute trusted code with Harness access; a review label is not an isolation mechanism. Runtime failure recovery preserves a previous selection but cannot undo plugin side effects or guarantee data downgrades. A proposal or green CI does not approve or publish code. Maintainers review exact source and artifact bytes, then distribute accepted entries in a tested desktop release; they must not run untrusted proposal code with repository write tokens or signing keys. Remote catalog distribution, self-service publication, publisher identity verification and stronger isolation are not provided by this authoring path.

<a id="further-exploration"></a>
## Further Exploration

- [Bundle preparation](../../packages/desktop/bundle-preparation/README.md) — artifact and candidate validation.
- [Desktop marketplace](../../packages/desktop/bundle-marketplace/README.md) — discovery, installation and version observations.
- [Packaging decision](../../.agents/notes/implemented/architecture/2026-09-06-desktop-bundle-packaging.md) — packaged tools and verification boundaries.

<a id="dev-note"></a>
## Dev Note

None.
