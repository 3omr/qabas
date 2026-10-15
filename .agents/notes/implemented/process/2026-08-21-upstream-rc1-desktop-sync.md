# Agent Note: Keep the desktop distribution aligned with upstream Harness

Status: implemented

## Problem

Harness Desktop was first cut from `dsh-v0.1.0-rc.8`, while upstream `dsh-v0.1.1-rc.1` changes the product composition around Profiles and installable Bundles, adds dynamic Cordis plugin surfaces and credential authorization flows, expands provider and multimodal behavior, and introduces optional Codex and Claude Code subagent providers. Keeping the desktop runtime pinned to rc.8 would split its model, plugin, and session behavior from the Harness version users expect. Replacing the desktop branch with upstream wholesale would instead remove the Tauri lifecycle, authenticated loopback boundary, packaged runtime closure, and public-community automation policy.

## Decision

The community history merges the exact public upstream tag `dsh-v0.1.2-rc.1` and retains the desktop implementation as a narrow overlay. The overlay consists of the Tauri app, the desktop runtime dependency root, the `ctx.desktop` seam and native provider, its profile patch, desktop tests and packaging workflow, and desktop-specific documentation. Package and Tauri versions follow the upstream Harness version so the bundled runtime manifest names the code it actually contains.

The desktop runtime boots the upstream `web` Profile and applies `desktop.cordis.yml` only as a final launch overlay. The runtime dependency root follows the current production Web closure, including plugin inventory, authorization, provider, and client packages. It does not fork the agent loop, LLM adapter abstraction, Profile loader, or plugin manager. [Dependency generation](../../../../scripts/sync-desktop-runtime.ts) and [release verification](../../../../scripts/verify-desktop-release.ts) reject stale package lists and divergent native/runtime versions before packaging.

The native menu bar is assembled from a typed `Submenu` slice because macOS omits ordinary top-level menu items. New Session belongs to the File submenu; inserting a `MenuItem` into the root list fails Rust compilation. Native macOS verification checks the visible File menu, enabled New Session item, and Cmd+N binding, while the [sidebar tests](../../../../packages/client/ui-sidebar/tests/sidebar-root.client.spec.tsx) cover delivery of the desktop new-session event.

The main window is built from its [Tauri configuration](../../../../apps/desktop/src-tauri/tauri.conf.json), with native drag-and-drop capture disabled. Tauri's default capture blocks the browser file-drop events used by the upstream attachment UI on Windows. The Rust configuration test rejects enabled capture or automatic window creation; the [attachment tests](../../../../packages/client/ui-attachment/tests/composer-attachments.client.spec.tsx) cover accepted, blocked, and cancelled browser drops. These checks do not replace a physical file-drop check in Windows WebView2.

The dependency generator preserves optional-only paths in the deployment root's `optionalDependencies`, including required descendants below an optional edge. A required path promotes that subtree into `dependencies`. Flattening every edge into a required dependency makes npm reject the packed runtime on other platforms with `EBADPLATFORM`, including the Linux ARM64 Landlock payload on an x64 runner. [Generator tests](../../../../scripts/sync-desktop-runtime.spec.ts) cover optional subtrees, cycles, required-path promotion, and overlapping direct declarations; the packed-install workflow retains its real npm consumer verification.

The desktop app's npm payload selects Rust source, capabilities, icons, and named native build inputs instead of the complete `src-tauri` directory. npm's explicit directory selection can traverse ignored Rust targets, including embedded runtime copies and existing installers. [Desktop release tests](../../../../scripts/desktop-release.spec.ts) pin the source-only selection, while target-native installer builds retain their independent resource assembly.

Codex and Claude Code remain independent optional upstream Profile Bundles: `@deepseek-ai/dsh-subagent-codex` and `@deepseek-ai/dsh-subagent-claude-code`. They are not added to the default desktop production closure. Installing one makes its dormant Host provider available after a Profile restart; a copied Agent Preset must separately enable the matching `subagent_codex` or `subagent_claude_code` tool. Each provider uses its pinned product runtime and the user's corresponding product authentication; Harness Desktop does not collect those product credentials or start a provider before a tool call.

The plugin forwarder explicitly waives pnpm's workspace-root mutation guard for its managed child process. A Profile is intentionally a one-package workspace; without that scoped setting pnpm 11 rejects `add` and `remove` at the root, including installation of the optional subagent bundles. The environment override leaves forwarded arguments untouched, so non-mutating verbs keep their normal semantics and users do not need to add pnpm's `-w` flag themselves.

For a bare first-party package passed to `plugin add`, the forwarder also pins the spec to the running DSH release. The npm `latest` tag intentionally lags the prerelease `next` tag for some rc.1 Bundles; resolving a bare optional provider through `latest` otherwise selects the obsolete 0.0.1 graph, whose unpublished `dsh-type-meta` dependency makes the documented install command fail. Explicit versions, tags, aliases, URLs, paths, and third-party packages remain unchanged.

The [community automation policy](2026-08-21-community-distribution-automation.md) remains an intentional overlay during this and later upstream merges: standard public runners replace private upstream pools, upstream issue-project mutations remain manual stubs, and credentialed real-provider E2E stays manual-only.

The [Markdown wrapping check](../../../../scripts/verify-md-wrap.ts) discovers system-prompt snapshots with a wildcard basename and filters back to the exact Markdown filename. Node 22's literal-basename glob traversal treats linked snapshot files as directories and throws `ENOTDIR`. Real-path deduplication preserves the original corpus; focused fixtures verify linked files and reject hard-wrapped prose without admitting other snapshot extensions.

The [runtime closure verifier](../../../../scripts/verify-runtime-closure.ts) traverses application entry manifests as well as package and vendor manifests. Both desktop and Python deploy roots declare the required peers reached through the CLI dependency graph; preset-only discovery cannot see those edges. A fixture reaches a missing peer through an application entry, then verifies the repaired declaration.

[Runtime output preparation](../../../../apps/desktop/scripts/runtime-output.mjs) checks directory ownership before recursive cleanup. Empty outputs receive a marker so an interrupted build remains replaceable; completed older outputs require both the runtime manifest and the desktop deployment package identity. Physical-path checks reject the repository, user home, their ancestors, and directory-link outputs. Link materialization unlinks a symlink or Windows junction before copying its target, never recursively removes the link. [Output tests](../../../../scripts/desktop-runtime-output.spec.ts) verify replacement and preservation of unowned files through real Node subprocesses.

Translation discovery excludes generated desktop resources, downloaded runtime archives, Rust targets, and generated native metadata in both its traversal and file predicate. The source desktop READMEs remain in the bilingual corpus; packaging a copy does not turn that copy into an independent documentation source.

The [manual browser benchmark](../../../../apps/web/tests/complex-history.perf.ts) follows the upstream compact-sidebar controls and independent Chat/Trajectory history windows. It verifies fixture cardinality separately from mounted DOM rows, so pagination and virtualization do not require shrinking the workload or rendering all records at once. Test-body and cleanup failures remain independently visible. Its Chromium timing and heap reports supplement desktop verification; they neither establish native WebView performance nor replace a credentialed model task.

## Alternatives considered

- **Keep the desktop release on rc.8.** Rejected because provider, multimodal, credential, plugin, and subagent behavior would immediately diverge from the public Harness release line.
- **Rebuild the new upstream behavior in Rust.** Rejected because Profiles, Cordis plugins, model adapters, and agent orchestration are TypeScript product semantics; duplicating them would create two incompatible Harness implementations.
- **Bundle and activate Codex and Claude Code for every desktop user.** Rejected because their platform payloads, product trust boundaries, and authentication requirements are optional. Host availability and per-Agent permission stay explicit and independently removable.
- **Accept upstream CI and issue workflows unchanged.** Rejected because their private runners, organization App, and Project board do not exist in the community repository.

## Consequences

- The desktop application receives the selected upstream release's provider, multimodal, authorization, Profile, plugin, and subagent framework without a second implementation.
- The Tauri and authenticated local-host boundaries remain isolated from ordinary Web and headless Profiles.
- Codex and Claude Code can be used as subagent providers after explicit Profile installation, Profile restart, Agent Preset enablement, and product authentication; synchronization alone does not silently grant either tool.
- Profile plugin installation remains usable with pnpm 11 from both the standalone CLI and pnpm-launched test or development processes.
- Versionless first-party Bundle installation stays on the desktop runtime's DSH release instead of mixing npm release channels; users can still request another version or tag explicitly.
- Future upstream tags are merged into the same history and must preserve the documented community and desktop overlays rather than copying individual upstream files by hand.
