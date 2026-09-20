---
description: "Web Settings readiness page for the transcriber engine: searchable tool rows with requiredness, three states, separate presence and live checks, and platform-specific repair commands."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-transcriber-engine

English | [中文](README.zh.md)

## Summary

Use this Settings page to see whether the transcriber engine's tools are ready before a long run. Each row names the tool, its purpose, requiredness, and one of three states: ready, not installed, or installed but not working. Presence checks run on the initial load and through Check again; live probes are a separate action because NotebookLM authentication and cold desktop tools can take seconds. Repair details render only the report's failure hint and current platform install command.

## Table of Contents

- [Use this package](#use-this-package)
- [The three states](#the-three-states)
- [Check actions](#check-actions)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Web bundle mounts this package as a `settings.section` entry and supplies the engine-facing Client provider. The page itself uses [`ui-settings-catalog`](../ui-settings-catalog/README.md) for its searchable list and selected detail pane.

The page calls `ctx.transcriberEngine.doctor({ live: false }, signal)` for the initial check and Check again. Run live checks calls the same capability with `{ live: true }`; the visible pending state stays active until the Remote settles. The page aborts the active signal when it unmounts or starts another check.

-----

<a id="the-three-states"></a>
## The three states

`ready` means the tool is resolved; a presence-only report does not claim that its probe passed. `unset` means the engine could not resolve the tool. `attention` means the tool is resolved but a live probe did not pass, which includes an installed but unauthenticated `nlm` CLI.

The page never reconstructs installation choices from the browser platform. It displays the single `install_command` returned by the engine, so a Windows report cannot expose a Linux `apt` line.

-----

<a id="check-actions"></a>
## Check actions

Initial load and Check again run the cheap presence check. Run live checks is explicit and disabled while a call is pending. For a missing or unhealthy row, the detail pane shows the report's `failure_hint` when present and its platform-specific `install_command`; it does not add another package manager command or raw probe output.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers one Settings section after the Settings slot exists, binds its own locale namespace, and injects the Client capability into a pure component. The component owns only the current request, abort controller, selected row, and pending/error state. It derives catalog statuses from `resolved`, `live`, and `probe.passed`; it does not infer a state from a failure string or from the Host platform.

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Settings registration and locale wiring |
| [`src/client/TranscriberEngineSection.tsx`](src/client/TranscriberEngineSection.tsx) | Request lifecycle, state mapping, catalog, and detail pane |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Simplified Chinese copy |
| [`src/client/TranscriberEngineSection.module.css`](src/client/TranscriberEngineSection.module.css) | Page-specific layout tokens |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Engine Remote capability](../../api/transcriber-engine/README.md) — Host command, report, cancellation, and error contract.
- [Settings catalog](../ui-settings-catalog/README.md) — the shared list and detail layout.
- [Settings domain](../ui-settings/README.md) — section registration and localized settings chrome.

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser page registers no tool, prompt section, or session event.

#### KV Cache effect

None; readiness checks do not assemble or send a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No automatic live probe** — the page does not spend network and desktop-tool time on live checks until the user asks for them.
- **No remediation button** — the page shows the engine's command but does not install software or run a shell command.
- **No Python row** — Python startup failure is reported as an engine error because the doctor must run inside Python before it can produce dependency rows.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The page is a second consumer of the catalog layout after Models. Its row hint carries purpose and requiredness, while the selected detail keeps the repair fields readable without teaching the catalog about engine-specific data.

</details>
