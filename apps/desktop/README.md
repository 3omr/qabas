# Harness Desktop

English | [中文](README.zh.md)

This app is the Tauri 2 desktop carrier for DeepSeek Harness on macOS and Windows. Rust owns the application lifecycle and native operating-system integration; the existing TypeScript Harness runtime and React Web profile remain the product core. The app therefore avoids bundling Chromium/Electron without rewriting the agent system into a second implementation.

## Architecture

**Add workspace** opens the in-app directory browser. Desktop composition pins both its Host and UI plugins instead of selecting a separate OS chooser process. The packaged plugin smoke exercises this same directory picker without a test-only replacement.

Windows Node launches convert canonical script paths to compatible ordinary paths when that conversion preserves the file identity; paths requiring extended syntax remain unchanged.

The application opens a lightweight system WebView immediately on a local loading page. A Rust supervisor starts the bundled official Node.js executable and the production `dsh web` dependency closure, waits for committed launcher startup and its loopback listener, then navigates the same WebView to the stable Harness origin. The [native provider](../../packages/desktop/desktop-native/README.md) acknowledges each child separately; a listening but incompletely started plugin tree does not qualify.

Browser access and native operations use independent credentials:

- The WebView opens the upstream launch-token URL. Harness exchanges it for an HttpOnly, SameSite=Strict cookie; HTTP RPC and the multiplexed WebSocket use that cookie. Unauthenticated requests receive HTTP 401. The native host redacts launch tokens before logging runtime output.
- Harness to native-host operations use a separate authenticated loopback bridge. It exposes status, show/focus, notification, autostart, per-child startup acknowledgement, and next-launch Profile selection/queue/cancel operations.

The Rust supervisor owns the complete child process tree. It uses a Unix process group on macOS and a Job Object on Windows, restarts an unexpected runtime exit on the same port, and terminates descendants on application exit. Window state, single-instance activation, standard window/edit shortcuts, the native menu, tray behavior, notifications, autostart, and updater plumbing are native Tauri capabilities. The application menu can export a bounded diagnostic text file; the exporter never reads sessions, configuration, credentials, or user files, and redacts desktop tokens, bearer credentials, API-key fields, and the home-directory prefix before writing.

A runtime restart does not navigate an already loaded WebView at the same origin when the launch token changes. The existing cookie authenticates reconnects; an unfinished initial page load remains eligible for navigation. This preserves the browser document rather than relying on text-draft persistence to recover transient input and attachment state.

Windows starts the runtime suspended and without a console window, then resumes it after Job assignment. Reported startup failures terminate and reap the child before retry. Shutdown closes Job process admission, retains member handles, and waits for their exit signals and an empty Job; cleanup errors are logged. Abrupt host termination between process creation and Job assignment can still leave a suspended child; this sequence is not atomic process creation. The [desktop lifecycle decision](../../.agents/notes/implemented/architecture/2026-08-20-tauri-desktop-carrier.md) records the platform verification requirements.

The File menu exposes **New Session**, with **Cmd+N** on macOS. The application menu exposes **Settings** and diagnostic export.

The desktop overlay replaces Web development guidance with installed-app orientation recorded in applicable model request headers. It disables the Web-provided `DSH_WEB_URL` shell variable and does not identify the bundled installation as an editable source checkout. The [native provider](../../packages/desktop/desktop-native/README.md#model-experience) owns the exact prompt and its preset behavior.

The main window enables Tauri's native drag-and-drop events so the transcriber panel receives absolute dropped paths, including on Windows. Window creation remains in application setup; the configured loading window is not created automatically.

Desktop data lives under Tauri's application-data directory in a dedicated `harness` home. It does not mutate the user's CLI profile. Sessions, settings, and write-only credential storage therefore survive app updates while remaining isolated from a separately installed CLI.

The blue interlocking Harness mark identifies the community desktop distribution. The vector master is `src-tauri/icons/icon.svg`; Tauri-generated PNG, ICNS, and ICO assets package it for each platform. The loading page and documentation favicon use the same SVG. macOS uses a separate transparent monochrome tray template so the system can adapt it to the menu-bar appearance.

<a id="local-agent-extensions"></a>

## Local agent extensions

The **Agents** tab in **Extensions** is a curated offline directory for bundled agent adapters, not an open package registry. Search names, descriptions, or tool names; filter by adapter type or **Selected**. Expand **Details & permissions** to inspect provenance, CLI setup, and execution limits. Browsing does not contact a registry or run an agent.

Open **Extensions…** from the application menu. The packaged agent catalog contains Codex, Claude Code, and experimental Kimi Code/Qoder ACP entries. **Check this computer** uses the app's pinned Codex and Claude execution runtimes; Kimi/Qoder checks search absolute PATH entries and common per-user directories, including macOS nvm installations. Checks run on request, off the UI thread, with bounded output and ten-second command deadlines. They display execution source, program paths, versions, and recognized Codex/Claude login states without returning account details or starting inference. Kimi/Qoder authentication requires confirmation in their official CLI. Diagnostic subprocesses exclude API-key and token environment variables.

**Selected** includes unsaved choices, not live runtime status. Filtering and diagnostics preserve those choices, including hidden entries. **Save changes** writes the entire selection; **Discard changes** restores the last successful read or save without writing. A failed save preserves the draft for correction, and unreadable preferences disable editing. Closing the window discards unsaved changes.

Select agents and save to opt in. Choices live in `desktop-agents.json` inside the desktop Harness home and apply at the next runtime start. Finish active tasks before choosing **Retry Runtime**, then create a session using the **Local agents** preset. It grants only selected delegation tools; standard and user-authored presets remain unchanged. Uncheck and save to disable an agent after restart. Codex uses `never`, Claude Code uses `dontAsk`, and ACP uses `reject`; the panel offers no permission bypass. Delegation can consume the provider account's quota, and its native configuration remains provider-owned.

Build-time [dependency resolution](scripts/runtime-agent-probes.mjs) records relocatable paths to the Codex wrapper and Claude SDK native executable. Preflight uses those files without substituting a PATH CLI; missing or invalid metadata and missing payloads report unavailable. Source development prepares the same metadata with the marketplace resources. These checks do not start an app-server or SDK query, verify quota, or grant delegation tools. A recognized login is not an inference smoke test. Arbitrary package installation, marketplace publishing, and update/rollback management are not part of this curated entry point.

Kimi/Qoder use separately installed local executables, not bundled runtimes. Saving an ACP opt-in rejects a missing executable or Windows `.cmd` shim; a removed executable also rejects the next runtime start. The upstream ACP client supports one-shot results and cancellation, not continued child conversations, live tool traces, interactive approvals, or client-provided filesystem/terminal services. Separate processes share filesystem access and are not security sandboxes. Packaged-composition tests use a scripted ACP process; real Kimi/Qoder releases and accounts remain manual acceptance requirements before claiming compatibility.

The generated `desktop-presets/desktop-local-agents` directory is application-owned and refreshed at runtime start; do not edit it. Copy a preset through the normal preset UI for user-owned customization. The desktop roster keeps the shipped and user preset roots and adds its generated system root. Malformed preferences or a changed upstream optional-tool row reject startup instead of silently widening access.

<a id="curated-skill-installation"></a>

## Curated Skill installation

On macOS and Windows, publishing a Skill refuses an occupied destination, including an empty directory, even when another installer creates it during preparation.

Open **Extensions… → Skills**. The catalog ships with the app; its [manifest](loading/skills.json) pins each source revision, text file, and SHA-256. **Review download** fetches and displays the original Skill, license, and attribution text from GitHub without installing anything. Check the consent box to expose **Install reviewed version**. Installation fetches the same pinned bytes again and verifies every file before publishing the complete bundle into the isolated desktop home at `skills/frontend-design`. It executes no scripts or package-manager lifecycle hooks and never sends Harness API keys to the download host. Skill instructions can still influence agent tool use; consent is not a security sandbox.

The existing [filesystem Skill provider](../../packages/skill/skill-filesystem/README.md) discovers the installed files. A new standard session can list and load `frontend-design`; project and scoped Skills retain their normal priority. The extension's **Installed** state verifies files and ownership, not model behavior or current-session selection. Installation and removal do not erase instructions already retained in conversation history.

**Uninstall** requires confirmation and moves a verified bundle into `desktop-skill-recovery/removed-*/frontend-design` under the desktop home. The result displays its recovery path; no automatic purge or one-click restore is provided. Existing destinations, symbolic links, altered files, extra files, and missing receipts block replacement or removal. Preserve conflicting files and inspect them manually. Downloads reject redirects, mismatched hashes, files over 128 KiB, and requests exceeding fifteen seconds per file. Failed preparation leaves the installed directory unchanged; an interrupted process can leave an inert `.desktop-skill-stage-*` directory outside the scanned Skills root.

The catalog accepts only its reviewed, data-only bundles. Arbitrary source URLs, executable plugins, MCP installation, open submissions, automatic updates, and cross-version rollback are not supported. The [installation decision](../../.agents/notes/implemented/feature/2026-09-06-desktop-curated-skills.md) records the distinction from profile bundle installation and the verification limits.

## Bundle marketplace

Open **Settings → Plugins → Marketplace** in the main application. The desktop overlay mounts the [Cordis marketplace plugin](../../packages/desktop/bundle-marketplace/README.md) and its preparation service; the upstream Web profile stays unchanged. The [catalog builder](scripts/runtime-marketplace.mjs) packages optional [Focus Timer](../../packages/desktop/focus-timer/README.md), [Notification Controls](../../packages/desktop/notification-controls/README.md) and [Delegate Tasks](../../packages/desktop/delegation-launcher/README.md) Bundles from repository source, with exact artifact hashes and target-version compatibility. Browsing reads metadata on demand and starts no package manager or inference.

The native host supplies installation paths and versions from the selected runtime; staging and preparation history stay under `bundle-marketplace` in the isolated desktop Harness home. Missing runtime resources reject startup. Installation, reviewed version replacement and removal prepare a new combination for the next full app launch; they do not alter the running combination. **Installed** shows observed package versions and Bundle-owned use actions. The page accepts no arbitrary npm input or open submissions. Source-mode `desktop:dev` prepares its own generated catalog before starting Tauri.

<a id="development"></a>

## Development

### External plugin packaging verification

The [native Profile selection owner](../../.agents/notes/implemented/architecture/2026-09-07-desktop-profile-startup-selection.md) accepts candidates from the Cordis preparation service for the next full application launch. Runtime Retry does not consume the queue. Successful startup confirms the candidate; failed or interrupted startup retains the previous selection without changing the Harness home. The packaged native smoke exercises preparation, authenticated queueing, successful startup and failed-candidate recovery. It does not undo plugin side effects or support data downgrades.

The smoke configures the [Bundle preparation service](../../packages/desktop/bundle-preparation/README.md) with a private test catalog through a Cordis overlay. It prepares a reviewed self-contained Bundle with bundled pnpm in a private offline project, verifies that missing dependencies fail without losing an earlier candidate, and confirms the Profile remains unchanged until the separate install step. Install scripts are disabled, including those of bundled dependencies.

The service also copies and checks a candidate Profile with the normal boot-free config dump. The smoke separately launches that candidate through `dsh --profile candidate`, verifies its Host and browser contributions, and confirms the source Profile has not activated the plugin. This isolated acceptance launch does not implement production Profile switching or automatic rollback.

The runtime includes the desktop-pinned pnpm distribution and relocatable launchers beside Node. The [plugin smoke](scripts/smoke-plugins.mjs) invokes the packaged `dsh plugin` command with a private Harness home, a PATH containing only the packaged executables, disabled install scripts and pnpm hooks, and an offline fixture package. It verifies profile registration, a Host contribution, a real browser slot, failed installation, removal, and restart. Run `pnpm run desktop:smoke:plugins` after runtime preparation and installing the development Playwright Chromium browser. This is packaging acceptance, not an end-user installer, remote registry, permission sandbox, or transactional updater; the native extension window does not expose arbitrary Bundle installation.

Requirements: Node.js 22.19 or later in the 22.x line, or Node.js 24 or later; npm; pnpm 11.7; Rust stable; and the platform prerequisites from Tauri 2. Runtime preparation runs on its target operating system and architecture.

```sh
pnpm install --frozen-lockfile
pnpm run desktop:prepare
pnpm run desktop:smoke
pnpm run desktop:dev
```

`desktop:prepare` checks the desktop dependency manifest, builds Harness, deploys the production workspace graph, downloads the matching official Node.js 22.22.0 distribution, verifies its SHA-256 checksum, and materializes the Tauri resource directory. `desktop:smoke` launches that exact bundled runtime and checks rejected anonymous access, cookie login, model and session RPC, the multiplexed WebSocket event stream, and authenticated reconnects after a forced process restart.

The smoke also reads compressed v0 and v1 fixture Sessions through authenticated history RPC. It verifies complete converted v3 records, including the system message and embedded Assistant streams, byte-identical historical sources, no published successor generations, and identical conversion after restart. These private, keyless fixtures do not replace native GUI or representative user-data write-upgrade acceptance.

Preparation rebuilds the approved native dependencies against the bundled Node headers. The desktop's development dependencies pin `node-gyp` and npm's lifecycle runner; the runner receives that compiler explicitly instead of selecting npm's bundled version. It loads `node-pty`, `koffi`, and `sharp` with the bundled executable. On POSIX hosts, it also calls the Session lock's prebuilt `@deepseek-ai/node-addon-system/flock` binding with an invalid descriptor and requires the expected `EBADF` syscall error. A successful TypeScript build alone does not verify native loading.

Preparation replaces only an empty directory or a generated Harness Desktop runtime. `DSH_DESKTOP_RUNTIME_OUTPUT` may select another output, but files, directory links, unrelated nonempty directories, and paths containing the repository or user home are rejected before cleanup. Choose an empty directory when a previous output cannot prove its ownership; do not place personal files in generated runtime directories.

The release path builds installers on their target operating system:

```sh
pnpm run desktop:build
```

macOS produces an `.app` and `.dmg`; Windows produces a per-user NSIS `.exe` installer. The dependency tree contains many files, so the Windows profile avoids WiX/MSI's file-table limits. The [Desktop workflow](../../.github/workflows/desktop.yml) owns target-native preparation, smoke tests, Rust tests, and packaging on macOS arm64 and Windows x64 runners; a local macOS build does not verify Windows behavior.

Cross-compiling the Rust host does not prepare its native Node addons. Runtime preparation rejects a foreign operating system or architecture before replacing its output. Use the target-native workflow for complete installers; a Rust cross-compilation check is only source-compatibility evidence.

## Release gates

Preview macOS builds use an ad-hoc signing identity and are not notarized. Windows previews are unsigned. The operating system may block either preview; users must assess the source and release checksums before approving it. Automatic updates are disabled without a configured signing key and release endpoint. Developer ID notarization, Windows code signing, and signed updater metadata require owner-provided credentials kept in CI secrets, not this repository.

The current credential provider is Harness's write-only local provider inside the isolated desktop data directory. OS Keychain/Credential Manager migration can be added behind the same `credentials` Service without changing the WebView, agent runtime, or settings UI.

<a id="following-upstream"></a>

## Following upstream

Merge an exact upstream release tag in a separate branch, resolve the desktop overlay against the current Web profile, then run `pnpm run desktop:sync` and `pnpm install` to record its production dependency graph. `pnpm run desktop:verify` rejects a stale graph or missing preset plugin before packaging. Keep the CLI, desktop package, Cargo, and Tauri versions aligned. Build and smoke-test the bundled runtime on each release platform; do not copy one platform's dependency tree into another installer.
