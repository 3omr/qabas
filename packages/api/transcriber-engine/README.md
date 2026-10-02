---
description: "Host and Client capability for checking the transcriber engine's external tools before a long run, installing declared dependencies, and tracking NotebookLM session authentication separately from readiness."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-transcriber-engine

English | [中文](README.zh.md)

## Summary

Use this package to check whether the transcriber engine can start, connect NotebookLM, and list local and NotebookLM lectures before a long run. It also exposes workspace inventory and transcript files without a Session. It owns app-managed dependency installation and the Host-side copy operation for desktop file drops. Presence checks are cheap; live checks run engine probes, including NotebookLM readiness. NotebookLM session authentication is separate, so an expired session is not reported as ready. Valid reports survive missing or unhealthy tools so Settings can explain repair. The package owns the Remote namespace.

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

The `transcriberEngine/doctor` Remote accepts `{ live: false }` for presence only and `{ live: true }` for the slower probes. The result preserves the engine's `ok` and `exit_code` fields as data. Each dependency reports its purpose, requiredness, resolution, probe result, failure hint, one platform-specific `install_command`, and a Host-derived `install_route` (`user`, `privileged`, or `manual`). The route is derived from the engine's command at the Host boundary, not guessed by the browser.

The final `AbortSignal` belongs to the Remote call. It reaches the child process and terminates the doctor when the page or connection is disposed. A missing executable, failed process start, cancelled call, or invalid JSON rejects; a valid non-zero doctor report does not.

### Dependency installation

The streamed `transcriberEngine/install` Remote accepts a dependency name from the current doctor report. The Host runs user-scope commands in-process and streams stdout and stderr. The current `nlm` route is fixed to `pipx install notebooklm-mcp-cli`; the Host checks for `pipx` before spawning it. Privileged package-manager commands use `pkexec` with ignored stdin, so the operating system owns the password prompt; without `pkexec`, the Host tries its ordered terminal-emulator list with the command prefilled. If neither route is available, the stream leaves a copyable command and names the missing prerequisite. A successful process always triggers a fresh presence doctor before the stream reports `installed`.

### NotebookLM authentication

The `transcriberEngine/auth` stream starts the desktop host's PTY-backed `nlm login` command and yields its notices and detected prompts. `answerAuth` sends one line to the waiting process, and `cancelAuth` terminates it. The stream reports `authorized` only after `nlm login --check` exits successfully; it does not use the login process exit code. `transcriberEngine/authStatus` runs that same check for the initial Settings state and resolves an expired session as disconnected. A missing native PTY rejects with a desktop-only error; the upstream CLI opens a managed browser and does not provide a supported URL-print login flow for the Web profile.

### Module and lecture listing

The session-free `transcriberEngine/listModules` Remote calls the engine’s `list_modules` MCP tool and returns `{ workspace, modules }`. Each module has `module`, `display_name`, `notebooks`, and `root`; malformed or rejected answers raise `transcriber-engine/invalid-modules`.

The `transcriberEngine/listLectures` Remote starts the engine MCP server for one module. Its result combines local recordings with NotebookLM recordings, marks NotebookLM-only rows with `in_notebook_only`, and leaves their `paths` empty. A NotebookLM failure is returned in `warning` with the rest of the listing, so a browser can keep its disk view and show a plain explanation. The call is one-shot and cancellation reaches the child process. Lecture rows may include `state` (`pending`, `verbatim`, `draft`, or `final`) and nullable `transcript`, `draft`, and `verbatim` paths; engines that omit these fields remain supported.

### Student-owned lectures and files

`listModuleFiles`, `defineLecture`, `deleteLecture`, `importFile`, `renameFile`, `removeFile`, and `uploadRecordings` call the engine registry without a Session. The student's UI action supplies confirmation; the Host always passes `confirmed: true`. Modules must exist under `modules/` after realpath resolution, and file arguments cannot traverse outside the module. Engine refusals use `transcriber-engine/edit-rejected`; malformed results use `invalid-edit-result`; Host resolution or staging failures use `edit-unavailable` (all with the same prefix). Cancellation reaches the MCP process. Lecture listings retain optional `origin`, manual `id`, `materials`, and module-level `questions` status.

`importFile` accepts `{ module, name, kind, bytes, replace? }`, with canonical base64 `bytes`. The Host creates an exclusive owner-only OS temporary file using the original name, invokes `import_file`, and removes the staging directory after success, refusal, or cancellation. The result includes the module-relative destination and engine-reported kind and byte size, including converted recordings. `maxImportBytes` defaults to 128 MiB; the Connection HTTP body cap must accommodate base64 expansion plus the RPC envelope. The default 300 MiB cap carries 70 MiB recordings in one unary request. Notebook upload results preserve per-file readiness and errors; `processing` requires a later retry and does not count as uploaded.

### Workspace transcript files

The `readFile`, `readFileBytes`, `writeFile`, and `stat` Remotes require no Session. Paths are absolute or relative to the same `TRANSCRIBER_WORKSPACE` root as the engine. Both lexical resolution and realpath containment must stay inside that root, including symlink targets. `readFileBytes({ path, relativeTo? }, signal)` resolves figure links from the directory of the existing workspace file named by `relativeTo`. Its `bytes` result is base64 for JSON transport. `readFile({ path }, signal)` decodes UTF-8 strictly. Both return `{ absolutePath, version, text | bytes }`; `stat({ path })` returns `{ absolutePath, version, bytes }`, where `bytes` is the file size. Directories and missing files are refused.

`writeFile({ path, text, expectedVersion }, signal)` replaces only existing `.md` files and returns `{ absolutePath, version }`. The opaque version includes nanosecond mtime and ctime, size, and a SHA-256 content digest; callers compare it for equality. A mismatch raises `transcriber-engine/file-conflict`. Host writes to the same canonical file are serialized and recheck the version after staging, before the same-directory atomic rename. Failed staging, conflict, or cancellation before rename leaves the target intact and removes the temporary file. Rename is the commit point; cancellation after it cannot undo the edit.

File refusals use `transcriber-engine/path-outside-workspace`, `file-not-found`, `file-not-regular`, `file-too-large`, `file-not-utf8`, `file-not-markdown`, and `file-unavailable` (each file code has the `transcriber-engine/` prefix). Invalid wire types use `gateway/input-invalid`; invalid paths and empty paths or versions use `gateway/bad-request`. Cancellation uses `gateway/cancelled`. Config byte limits are inclusive and apply during reads, without truncation. `stat` hashes incrementally without retaining file content.

### Importing dropped files

The `transcriberEngine/importFiles` Remote accepts a module id, `Lecture` or `Questions`, and absolute source paths. It resolves the selected folder through the module layout, refuses a module or destination that escapes the workspace, and copies each accepted source without moving the original. `Lecture` accepts the shared recording, slide, and document formats; `Questions` accepts the shared document and slide formats. Existing destination names are refused rather than renamed or overwritten. The result reports every filed destination and every rejected source, so one unsupported file does not prevent accepted files in the same drop from landing. Cancellation is checked before layout resolution and between files.

### Minimal composition

```yaml
- id: transcriber-engine
  name: '@deepseek-ai/dsh-api-transcriber-engine'
```

The generated [configuration catalog](../../../docs/config-catalog.md) owns the validated `maxTextBytes` (8 MiB), `maxImageBytes` (16 MiB), `mcpOutputMaxBytes` (4 MiB per captured listing stream), and `mcpGraceMs` (5000 ms) defaults. The two `TRANSCRIBER_*` environment inputs are the engine integration convention shared with the MCP registration.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`TranscriberEngine` owns one Remote namespace and delegates doctor, install, and inventory invocations to `ctx.subprocess`; imports and workspace-file operations use the Host filesystem after their path checks. The authentication stream uses the optional native desktop PTY adapter, while `auth.ts` owns frame rendering, prompt detection, and the `nlm login --check` decision. `doctor.ts` builds the current `python3` plus script argv in one function; `install.ts` classifies the doctor command, selects the privilege route, streams process output, and re-probes after success. The runners bound collected output, pass cancellation to the provider, and validate complete engine answers at the process boundary. The Client entry provides the same namespace through `ctx.transcriberEngine` so UI consumers do not reach through a raw Remote object.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host service and `transcriberEngine` Remote methods |
| [`src/doctor.ts`](src/doctor.ts) | Engine path resolution, command construction, subprocess lifecycle, and JSON validation |
| [`src/install.ts`](src/install.ts) | Host-side route selection, package-manager launch, streamed output, and post-install re-probe |
| [`src/auth.ts`](src/auth.ts) | PTY conversation frames and the `nlm login --check` decision |
| [`src/mcp.ts`](src/mcp.ts) | Shared MCP requests, response framing, and subprocess lifecycle |
| [`src/modules.ts`](src/modules.ts), [`src/lectures.ts`](src/lectures.ts) | Inventory validation and lecture warning conversion |
| [`src/files.ts`](src/files.ts) | Workspace containment, bounded file reads, version hashing, and atomic Markdown writes |
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
- **Native authentication verification** — the PTY spawn and a real Google sign-in are manual checks on each target desktop; the automated tests use a fake terminal, fake installer processes, and recorded doctor data.
- **Browser authentication** — the upstream `nlm login` command opens a managed browser rather than printing a URL, so the Web profile reports that the desktop application is required.
- **Privilege helper availability** — privileged installs need `pkexec`, or a detected terminal emulator plus `sudo`; no application code handles an operating-system password.
- **One-shot engine calls** — each doctor, inventory listing, or registry edit starts a new process; desktop path drops use direct Host copies, and the browser owns display-time refresh policy.
- **External filesystem races** — local writers must coordinate with the Host to guarantee compare-and-replace semantics. Portable Node rename does not atomically compare a version; an external edit in the final check-to-rename interval can be overwritten. Concurrent replacement of ancestor directories also requires OS-level filesystem isolation.
- **Engine-owned probe timing** — live probe deadlines remain in the engine; cancellation can stop the process but does not shorten a healthy probe.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The package name describes the expandable engine capability rather than the first `doctor` method, so dropped-recording import and run-progress methods can use the same Remote and Client provider wiring.

</details>
