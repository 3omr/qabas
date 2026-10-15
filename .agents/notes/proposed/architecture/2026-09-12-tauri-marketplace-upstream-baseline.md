# Agent Note: Validate the Tauri marketplace against a fixed upstream release

Status: proposed

## Problem

Upstream `dsh-v0.1.5-rc.2` adds an Electron application under the same directory as the community Tauri application and changes released Session data and client composition. An unrestricted merge can replace the shell, misroute desktop build commands, or validate plugins against a different runtime from the installed application.

## Proposal

Adapt core and Web to the fixed tag `dsh-v0.1.5-rc.2` (`fb2c4b9e698e30edb738bca4cf0618587db7d203`) in an isolated worktree. Preserve the [Tauri carrier](../../implemented/architecture/2026-08-20-tauri-desktop-carrier.md), its deployment root, and the [community automation policy](../../implemented/process/2026-08-21-community-distribution-automation.md). The [upstream synchronization decision](../../implemented/process/2026-08-21-upstream-rc1-desktop-sync.md) retains ownership of dependency generation and aligned version declarations.

Exclude the Electron application and its build commands from this distribution. Keep the upstream private Node Host source available without adding it to the Tauri deployment roots. Validate the actual dependency closure rather than treating a directory name as proof of inclusion.

Complete upstream compatibility before expanding the [Bundle marketplace](2026-09-06-desktop-plugin-marketplace.md). Desktop and browser consumers should share the reviewed catalog and existing Cordis Bundle installation model. This proposal does not replace the carrier, installer, or marketplace decisions; their independent lifecycle and trust requirements remain active.

## Alternatives considered

**Merge the official desktop application wholesale.** Rejected because it replaces the selected Tauri carrier and conflicts with the existing desktop capability package name.

**Track every upstream master change during adaptation.** Rejected because a moving baseline makes compatibility evidence ambiguous. Evaluate another released tag in a separate update.

**Rewrite the runtime in Rust.** Rejected because it duplicates Cordis, provider, and Session behavior instead of maintaining marketplace capabilities through existing plugins.

## Acceptance criteria

- Desktop build commands resolve to the Tauri application, and the deployment closure excludes Electron.
- Native, runtime, and Bundle versions agree with the fixed Harness baseline.
- Focused marketplace, community workflow, client, build, packaged-runtime, and browser replay checks pass.
- Isolated Session upgrade checks preserve predecessor bytes and validate the current writer; restoring a previous application does not imply data downgrade support.
- Native macOS and Windows installation, plugin activation, restart recovery, and removal receive separate acceptance before release.

## Risks

Desktop registration unit tests explicitly mock generated Remote modules. Their source-only resolver admits only those named imports and rejects unmocked loading; packaged-runtime and browser tests retain the real generated modules. This separation prevents an existing build from hiding a clean-checkout test failure without substituting mocks for runtime acceptance.

Host APIs remain pre-stable. Unit tests alone do not establish packaged plugin loading, OS integration, or user-data migration safety. Generated remote modules, Session snapshots, documentation catalogs, and installer dependencies must be regenerated and reviewed with their owners. Existing application installations and real user homes remain outside adaptation tests.
