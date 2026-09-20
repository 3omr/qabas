---
description: "Host and Client capability for checking the transcriber engine's external tools before a long run, including optional liveness probes and platform-specific installation guidance."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-transcriber-engine

English | [中文](README.zh.md)

## Summary

Use this package to check whether the transcriber engine can start and to list a module's local and NotebookLM lectures before a long run. Presence checks are cheap; live checks run the engine's declared probes, including the NotebookLM authentication probe. A valid report is returned even when required tooling is missing or unhealthy, so the Settings page can explain the repair. The package owns the Remote namespace for these engine operations.

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

### Lecture listing

The `transcriberEngine/listLectures` Remote starts the engine MCP server for one module. Its result combines local recordings with NotebookLM recordings, marks NotebookLM-only rows with `in_notebook_only`, and leaves their `paths` empty. A NotebookLM failure is returned in `warning` with the rest of the listing, so a browser can keep its disk view and show a plain explanation. The call is one-shot and cancellation reaches the child process.

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

`TranscriberEngine` owns one Remote namespace and delegates doctor and lecture-listing invocations to `ctx.subprocess`. `doctor.ts` builds the current `python3` plus script argv in one function; the two runners bound collected output, pass cancellation to the provider, and validate complete engine answers at the subprocess boundary. The Client entry provides the same namespace through `ctx.transcriberEngine` so UI consumers do not reach through a raw Remote object.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host service and `transcriberEngine/doctor` Remote method |
| [`src/doctor.ts`](src/doctor.ts) | Engine path resolution, command construction, subprocess lifecycle, and JSON validation |
| [`src/lectures.ts`](src/lectures.ts) | MCP request, listing validation, warning conversion, and subprocess lifecycle |
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
- **One-shot engine calls** — each doctor or lecture listing starts a new process; the browser owns any display-time refresh policy and does not receive a server-side cache.
- **Engine-owned probe timing** — live probe deadlines remain in the engine; cancellation can stop the process but does not shorten a healthy probe.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The package name describes the expandable engine capability rather than the first `doctor` method, so dropped-recording import and run-progress methods can use the same Remote and Client provider wiring.

</details>
