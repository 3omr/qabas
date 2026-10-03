---
description: "Download, configure, and contribute to the community Tauri desktop distribution of DeepSeek Harness."
---

# Harness Desktop

Qabas owns its [Python transcription engine](engine/README.md) in this repository. Engine setup and checks require no skill checkout.

English | [中文](README.zh.md)

**DeepSeek Harness on your desktop. Your workspace, your models, your plugins.**

An open-source macOS and Windows app built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and Tauri 2. The agent runtime runs locally, with a system WebView for the interface and Rust for native integration. No bundled Electron or Chromium.

[Download](https://github.com/Bestbbb/deepseek-harness-desktop/releases/tag/desktop-v0.1.3-alpha.1) · [Getting started](#run) · [Documentation](docs/user/index.md) · [Report an issue](https://github.com/Bestbbb/deepseek-harness-desktop/issues)

![Harness Desktop workspace and conversation composer](docs/assets/desktop/harness-desktop-main.png)

> Unofficial community project. Not affiliated with or endorsed by DeepSeek. This source tree tracks upstream `dsh-v0.1.3-alpha.1`; check each download's release notes for its bundled version. Preview releases can contain breaking changes.

<a id="run"></a>

## Start in three steps

1. **Install the app.** Choose the macOS Apple Silicon DMG or Windows x64 installer from [Releases](https://github.com/Bestbbb/deepseek-harness-desktop/releases/tag/desktop-v0.1.3-alpha.1). Installer users do not need Node.js, pnpm, Rust, or a separate CLI.
2. **Connect a model.** Open **Settings → Models** to configure a provider or an OpenAI-compatible endpoint. Use the authentication method required by that provider.
3. **Choose a workspace.** Select a folder, model, and Agent preset, then describe the task.

The macOS preview is ad-hoc signed but not notarized; the Windows preview is unsigned. Your operating system may block the first launch. Read the release's verification and platform notes before approving a download.

## What you get

- **A local coding workspace.** Files, terminal tools, image input, persistent sessions, and the upstream Harness conversation interface.
- **Model choice.** DeepSeek's adapter plus the upstream `pi-ai` integration, with catalog providers and custom OpenAI-compatible endpoints.
- **Composable capabilities.** Cordis plugins, Agent presets, skills, and MCP integrations, with explicit configuration and permissions.
- **Native desktop controls.** Windows, menus, tray, shortcuts, runtime supervision, notifications, and diagnostic export.
- **Optional external agents.** Upstream Codex and Claude Code bundles can run delegated tasks after installation, configuration, and authentication.
- **An upstream-first codebase.** The desktop host reuses the Harness runtime and Web profile instead of maintaining a second agent implementation.

Local runtime does not mean offline inference. Requests go to your chosen model provider or gateway. Provider fees, subscriptions, and authentication requirements remain yours.

## Why Tauri instead of Electron?

The desktop app does not need to ship its own browser engine. Tauri uses WKWebView on macOS and WebView2 on Windows, while the existing TypeScript runtime runs in a supervised Node process.

| Layer | Responsibility |
|---|---|
| Rust + Tauri | Native windows, menus, operating-system integration, and process lifecycle |
| DeepSeek Harness | Agent execution, tools, permissions, sessions, and plugin composition |
| React + system WebView | The upstream conversation and settings interface |
| Provider adapters | Model requests, streaming, and provider-specific authentication |

This is not a GPUI interface or a full Rust rewrite. Avoiding bundled Chromium reduces one source of distribution overhead; it does not guarantee a fixed memory footprint or eliminate the need to profile long sessions.

## Models and gateways

Use **Settings → Models** to add a catalog provider or custom endpoint. The desktop app uses the upstream adapters rather than introducing another model gateway.

DeepSeek, OpenAI, Anthropic, Google, Kimi, GLM, and other providers depend on their available models and supported authentication methods. Bedrock, Vertex, Azure, and OAuth routes can require native setup rather than a generic API key. See the [provider guide](docs/user/guide/providers.md).

An OpenAI-compatible company gateway can keep routing, budgets, and organization policy outside the desktop app. A compatible endpoint still needs the correct model capabilities, including image support.

## Codex and Claude Code as subagents

These are optional Profile Bundles, not built-in accounts or interchangeable models. Their official package-local runtimes handle the delegated work and use their corresponding product authentication. Installing a bundle does not automatically grant its tools to every Agent preset.

See the [Codex provider](packages/subagent/subagent-codex/README.md) and [Claude Code provider](packages/subagent/subagent-claude-code/README.md) for installation, model selection, and unattended permission behavior. Pi's model library is included through upstream; a complete Pi coding-agent adapter is not included.

## Architecture

The app opens a local loading page, starts the bundled Node runtime, then opens the authenticated Harness Web profile. Desktop state has its own application-data directory and does not alter a separately installed CLI's profile.

The WebView exchanges the upstream launch token for an HttpOnly cookie. The Node-to-Rust native bridge uses a separate per-launch token. Rust supervises the runtime and its descendants. See [desktop architecture and development](apps/desktop/README.md) for the process, authentication, and packaging details.

<a id="run-from-source"></a>

## Build from source

Install the [desktop build prerequisites](apps/desktop/README.md#development), including a native compiler for your target platform. From this checkout:

```sh
pnpm install --frozen-lockfile
pnpm run desktop:prepare
pnpm run desktop:smoke
pnpm run desktop:dev
```

Build installers with `pnpm run desktop:build`. The [Desktop workflow](.github/workflows/desktop.yml) builds on macOS arm64 and Windows x64. After an upstream merge, `pnpm run desktop:sync` regenerates the runtime dependency list; `pnpm run desktop:verify` checks it before packaging.

## Security and release status

- Preview installers are not a substitute for signed, notarized distribution. Automatic updates are disabled until signing and an update endpoint are configured.
- Provider credentials use Harness's local credential storage, not macOS Keychain or Windows Credential Manager.
- Runtime diagnostics are bounded and redact common secret fields. They do not include session or configuration contents.
- Plugins and external agents execute code. A local bridge token is not a sandbox for trusted plugins, and external agents do not automatically inherit Harness's tool restrictions.
- Read the upstream [Safety Notice](SAFETY.md) before granting workspace access.

## Roadmap

The [desktop development guide](apps/desktop/README.md#following-upstream) describes release alignment. Further work includes OS credential storage, signed updates, runtime profiling, and richer local-agent integration. These are development directions, not features promised by the current installers.

## Upstream and contributing

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) owns the underlying agent framework. This repository owns the community desktop distribution, native integration, and packaging. Report desktop-specific problems here, with your OS, app version, and redacted diagnostics.

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [development guide](docs/development.md). Stars help people discover the project; reproducible bug reports and focused pull requests help improve it.

## License

[MIT](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency licenses. DeepSeek and DeepSeek Harness remain the names of their respective owners.
