---
layout: page
title: Harness Desktop
description: "A community desktop app for DeepSeek Harness. Bring your models, work in local projects, and extend with plugins."
---

<main class="dsh-home"><section class="dsh-hero"><div class="dsh-hero-copy">

# DeepSeek Harness for your desktop.

Work in your local projects with your choice of models and a plugin-based agent.

<div class="dsh-actions">

[Download](https://github.com/Bestbbb/deepseek-harness-desktop/releases/tag/desktop-v0.1.3-alpha.1) [Read the guide](guide/index.md)

</div></div><div class="dsh-hero-preview">

![Harness Desktop conversation workspace before a model is configured](../assets/desktop/harness-desktop-main.png)

</div></section>

<section class="dsh-models"><div class="dsh-models-copy">

## Choose your model.

Configure DeepSeek, other supported providers, or an OpenAI-compatible gateway. Your provider handles inference and billing.

[Model setup and authentication](guide/providers.md)

</div><div class="dsh-models-preview">

![Harness Desktop Models settings with provider configuration controls](../assets/desktop/harness-desktop-models.png)

</div></section>

<section class="dsh-extension">

## A desktop app with room to extend.

Harness owns the agent runtime. Tauri supplies the native window and operating-system integration.

<div class="dsh-extension-grid"><div>

### Native where it matters

System WebView, native menus, keyboard shortcuts, runtime supervision, and diagnostic export. No bundled Electron or Chromium.

[Desktop architecture](../../apps/desktop/README.md)

</div><div>

### Plugins at the core

Use Cordis plugins, Agent presets, skills, and MCP integrations. Optional Codex and Claude Code bundles add delegated agents after setup.

[Plugin development](develop/basic/index.md)

</div></div></section>

<section class="dsh-start">

## Start with a local project.

1. **Install.** Choose the macOS Apple Silicon or Windows x64 installer from the release assets.
2. **Connect.** Configure your model provider in Settings, using its supported authentication method.
3. **Work.** Choose a workspace and an Agent preset, then describe your task.

<div class="dsh-preview-note">

### Before you install

This is a community preview, not an official DeepSeek product. macOS previews are ad-hoc signed and not notarized; Windows previews are unsigned. Check each release's platform notes and bundled version.

Local execution is not offline inference. Plugins and external agents run code; review permissions before granting workspace access. Automatic updates are not configured.

[Download](https://github.com/Bestbbb/deepseek-harness-desktop/releases/tag/desktop-v0.1.3-alpha.1)

</div></section>

<footer class="dsh-home-footer">

[Source on GitHub](https://github.com/Bestbbb/deepseek-harness-desktop)

[Upstream Harness](https://github.com/deepseek-ai/deepseek-harness)

[MIT license](../../LICENSE)

</footer></main>
