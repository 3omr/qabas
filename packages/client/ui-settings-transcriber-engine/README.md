---
description: "Web Settings readiness page for the transcriber engine: searchable tool rows with requiredness, three states, separate presence and live checks, app-managed installs, and explicit NotebookLM session state."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-transcriber-engine

English | [中文](README.zh.md)

## Summary

Use this Settings page to see whether the transcriber engine's tools are ready before a long run, install missing tools from the app, and connect NotebookLM without opening a terminal. Each row names the tool, its purpose, requiredness, and one of three states: ready, not installed, or installed but not working. Presence checks run on the initial load and through Check again; live probes are a separate action because NotebookLM readiness and cold desktop tools can take seconds. Repair details use the Host-declared install route, stream installer output, and retain a copyable fallback when the host cannot run the route.

## Table of Contents

- [Use this package](#use-this-package)
- [NotebookLM connection](#notebooklm-connection)
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

<a id="notebooklm-connection"></a>
## NotebookLM connection

Select the `nlm` row to see the connection card. It states that `nlm` is an unofficial NotebookLM client and that sessions can expire, so reconnecting is normal. The initial state runs `nlm login --check`, independently of the readiness probe. Connect to NotebookLM streams the native PTY conversation, turns printed URLs into links, and shows an input only when the output looks like a prompt. The card reports success only after `nlm login --check` passes, while the row still uses `nlm notebook list` as its readiness probe.

The upstream `nlm login` command opens a managed browser and does not expose a supported URL-print fallback. If the native PTY is unavailable in the Web profile, the card says that the desktop application is required; it never tells the student to open a terminal or type a command.

-----

<a id="the-three-states"></a>
## The three states

`ready` means the tool is resolved; for `nlm`, it also requires the separate `nlm login --check` result to be connected. A presence-only report does not claim that a non-NotebookLM probe passed. `unset` means the engine could not resolve the tool. `attention` means the tool is resolved but a required probe or NotebookLM session check did not pass, which includes an installed but unauthenticated `nlm` CLI.

The page never reconstructs installation choices from the browser platform. The Host derives a typed `install_route` from the engine's platform-specific `install_command` and sends both facts to the page, so a Windows report cannot expose a Linux `apt` route. User-scope routes run in-process; privileged routes use `pkexec`, then an ordered terminal fallback, then a copyable command with an explanation.

-----

<a id="check-actions"></a>
## Check actions

Initial load and Check again run the cheap presence check. Run live checks is explicit and disabled while a call is pending. For an unset row, the detail pane offers the Host-selected install action, streams stdout and stderr, and runs a fresh presence check after a successful process. A missing package manager, privilege helper, or terminal is named in the card; a failed process keeps its output and its copyable command. The page does not add another package manager command or raw probe output.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers one Settings section after the Settings slot exists, binds its own locale namespace, and injects the Client capability into a pure component. The component owns only the current request, abort controller, selected row, auth status, and pending/error state. It derives catalog statuses from the report facts plus the separate `authStatus` result; it does not infer a state from a failure string or from the browser platform.

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Settings registration and locale wiring |
| [`src/client/TranscriberEngineSection.tsx`](src/client/TranscriberEngineSection.tsx) | Request lifecycle, state mapping, catalog, and detail pane |
| [`src/client/DependencyInstall.tsx`](src/client/DependencyInstall.tsx) | Route explanation, streamed install output, buttons, and copyable fallback |
| [`src/client/NotebookLmConnect.tsx`](src/client/NotebookLmConnect.tsx) | PTY transcript, URL links, prompt input, session check, and desktop-only fallback |
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
- **Host-dependent installation** — the page can install `nlm` through `pipx` and can request privileged routes through `pkexec`; missing helpers leave a copyable, explained command rather than collecting a password.
- **Manual native verification** — automated tests use fake processes; the PTY spawn, real `nlm login`, Google sign-in, and Windows behavior require manual verification on the target desktop.
- **Web authentication** — `nlm login` does not provide a supported printed URL flow, so browser-only use cannot complete NotebookLM sign-in.
- **No Python row** — Python startup failure is reported as an engine error because the doctor must run inside Python before it can produce dependency rows.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The page is a second consumer of the catalog layout after Models. Its row hint carries purpose and requiredness, while the selected detail keeps the repair fields readable without teaching the catalog about engine-specific data.

</details>
