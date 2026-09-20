---
description: "Host and Client capability for checking the transcriber engine's external tools before a long run, including optional liveness probes and platform-specific installation guidance."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-transcriber-engine

English | [中文](README.zh.md)

## Summary

Use this package to check whether the transcriber engine can start, connect NotebookLM, and list a module's local and NotebookLM lectures before a long run. It also owns the Host-side copy operation used by desktop file drops. Presence checks are cheap; live checks run the engine's declared probes, including the NotebookLM authentication probe. A valid report is returned even when required tooling is missing or unhealthy, so the Settings page can explain the repair. The package owns the Remote namespace for these engine operations.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the package in the Host composition beside the subprocess provider and the API Remote assembly; the Web bundle already supplies the row for it.

### Engine location

The launcher is resolved from `TRANSCRIBER_SKILL_ROOT`, falling back to `<cwd>/skills/universal-transcriber`. The doctor runs with `TRANSCRIBER_WORKSPACE` as both its working directory and `--workspace` value, falling back to the Host cwd. A missing launcher or workspace returns an actionable `transcriber-engine/not-found` error that names the setting to fix.

### Doctor result

The `transcriberEngine/doctor` Remote accepts `{ live: false }` for presence only and `{ live: true }` for the slower probes. The result preserves the engine's `ok` and `exit_code` fields as data. Each dependency reports its purpose, requiredness, resolution, probe result, failure hint, and one platform-specific `install_command`.

The final `AbortSignal` belongs to the Remote call. It reaches the child process and terminates the doctor when the page or connection is disposed. A missing executable, failed process start, cancelled call, or invalid JSON rejects; a valid non-zero doctor report does not.

### NotebookLM authentication

The `transcriberEngine/auth` stream starts the desktop host's PTY-backed `nlm auth` command and yields its notices and detected prompts. `answerAuth` sends one line to the waiting process, and `cancelAuth` terminates it. The stream reports `authorized` only when the same live doctor sees `dependencies[name === 'nlm'].probe.passed === true`; it does not use the auth process exit code. A missing native PTY or failed spawn rejects with an actionable `nlm auth` fallback for the Settings page.

### Lecture listing

The `transcriberEngine/listLectures` Remote starts the engine MCP server for one module. Its result combines local recordings with NotebookLM recordings, marks NotebookLM-only rows with `in_notebook_only`, and leaves their `paths` empty. A NotebookLM failure is returned in `warning` with the rest of the listing, so a browser can keep its disk view and show a plain explanation. The call is one-shot and cancellation reaches the child process.

### Importing dropped files

The `transcriberEngine/importFiles` Remote accepts a module id, `Lecture` or `Questions`, and absolute source paths. It resolves the selected folder through the module layout, refuses a module or destination that escapes the workspace, and copies each accepted source without moving the original. `Lecture` accepts the shared recording, slide, and document formats; `Questions` accepts the shared document and slide formats. Existing destination names are refused rather than renamed or overwritten. The result reports every filed destination and every rejected source, so one unsupported file does not prevent accepted files in the same drop from landing. Cancellation is checked before layout resolution and between files.

### Minimal composition

```yaml
- id: transcriber-engine
  name: '@deepseek-ai/dsh-api-transcriber-engine'
```

The generated [configuration catalog](../../../docs/config-catalog.md) has no package settings; the two `TRANSCRIBER_*` environment inputs are the engine integration convention shared with the MCP registration.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`TranscriberEngine` owns one Remote namespace and delegates doctor and lecture-listing invocations to `ctx.subprocess`; the import method uses the Host filesystem only after resolving a module-local destination. The authentication stream uses the optional native desktop PTY adapter, while `auth.ts` owns frame rendering, prompt detection, and the probe-backed success decision. `doctor.ts` builds the current `python3` plus script argv in one function; the runners bound collected output, pass cancellation to the provider, and validate complete engine answers at the process boundary. The Client entry provides the same namespace through `ctx.transcriberEngine` so UI consumers do not reach through a raw Remote object.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host service and `transcriberEngine` Remote methods |
| [`src/doctor.ts`](src/doctor.ts) | Engine path resolution, command construction, subprocess lifecycle, and JSON validation |
| [`src/auth.ts`](src/auth.ts) | PTY conversation frames and the NotebookLM probe decision |
| [`src/lectures.ts`](src/lectures.ts) | MCP request, listing validation, warning conversion, and subprocess lifecycle |
| [`src/import.ts`](src/import.ts) | Module-local destination resolution, format admission, collision refusal, copying, and mixed results |
| [`src/types.ts`](src/types.ts) | Wire report types and Remote error details |
| [`src/client/index.ts`](src/client/index.ts) | Client provider over `remote.transcriberEngine` |
| — | No runtime invariant companion is published; each doctor call returns one subprocess report and the capability owns no independent event stream or mutable projection. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Remote assembly](../remotes/README.md) — the selected namespace mount that makes the Host service reachable from the browser.
- [Subprocess capability](../../subprocess/subprocess/README.md) — process resolution, collected output, and cancellation ownership.
- [Transcriber engine Settings page](../../client/ui-settings-transcriber-engine/README.md) — the three-state readiness presentation.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package registers no tool, prompt section, or session event.

#### KV Cache effect

None; readiness checks do not assemble or send a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Current launcher only** — the package invokes `python3` with `run_transcription.py`; the frozen engine binary is not supported until its argv contract exists.
- **Native authentication verification** — the PTY spawn and a real Google sign-in are manual checks on each target desktop; the automated tests use a fake terminal and a recorded doctor report.
- **One-shot engine calls** — each doctor or lecture listing starts a new process; imports are direct Host copies, and the browser owns any display-time refresh policy.
- **Engine-owned probe timing** — live probe deadlines remain in the engine; cancellation can stop the process but does not shorten a healthy probe.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The package name describes the expandable engine capability rather than the first `doctor` method, so dropped-recording import and run-progress methods can use the same Remote and Client provider wiring.

</details>
