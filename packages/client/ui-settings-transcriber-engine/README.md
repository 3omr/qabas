---
description: "Settings → Accounts and tools: one card per service Qabas needs (NotebookLM, agy, the Gemini key, the tools on this machine), each with its standing and the control that fixes it; plus the same checks as a first-run step."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-transcriber-engine

English | [中文](README.zh.md)

## Summary

Use Accounts and tools to see whether Qabas can transcribe and how to repair missing services. The page shows cards for NotebookLM, Antigravity `agy`, the Gemini key, and tools on this computer. Each card explains the service’s purpose and status, and offers its connection, test, key-save or installation control. The same engine checks run in the first-run setup step. In the Qabas composition, this page supplies service checks while `ui-settings-models` stays outside Settings by default.

## Table of Contents

- [Use this package](#use-this-package)
- [The cards](#the-cards)
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

The Web bundle mounts this package as a `settings.section` entry and as the `transcriber-engine` first-run step, and supplies the engine-facing Client provider and the credentials Remote. The page calls `ctx.transcriberEngine.doctor({ live: false }, signal)` on load and on Check again; the agy card's test calls it with `{ live: true }`. The page aborts the active signal when it unmounts or starts another check.

<a id="the-cards"></a>
## The cards

| Card | States | Control |
|---|---|---|
| NotebookLM | checking, not installed, connected, not connected | install, then the in-app sign-in below |
| Writing (Antigravity) | not installed, installed and untested, works, not answering | install, then Test agy, whose result names the fix (sign in, update, open agy) |
| Gemini key | saved, no key, from the environment | one key field; change and remove (asking once); a link to Google AI Studio |
| Tools on this computer | all ready, N missing | the missing required tools are listed with their install buttons; the rest fold behind Show all |

The Gemini key card writes `GEMINI_API_KEY` through `remote.credentials` and only ever learns whether a key is stored, never its value. It re-reads the state when `credentials/reference-updated` names that key. It states when the free daily quota renews on the student's own clock: Google resets it at midnight Pacific time, which [`src/client/quota.ts`](src/client/quota.ts) converts with daylight saving taken into account.

The injected `GeminiKey.check(): Promise<KeyCheck>` data call checks the stored key through `credentials.checkGeminiKey()` without passing a key from the browser. `KeyCheck` carries `status: works | invalid-key | quota | network | no-key`; quota results also carry `limit: daily | per-minute | unknown`. Remote refusals and transport failures become `network`. Consumers invoke this call explicitly; saving validates input and provisions the Google route and first default. [Host check semantics](../../api/settings-controller/README.md#use-this-package) define the authenticated request and its limits.

The settings page and first-run step receive the same `GeminiKey` data interface. Saving through `GeminiKey.save(key)` first stores `GEMINI_API_KEY` on the Host, then provisions an absent `providers.google = {}` profile in the `llm-pi-ai` namespace. Discovery selects the newest main Gemini Flash model, excluding preview, lite and specialist variants; `saveDefaultModelIfUnset` preserves any existing default. The key is never written into the profile or sent to discovery. Provisioning refusals are returned to the caller, while the saved credential remains available for retry. `remove()` unsets only the credential; the Google route and default remain for a later key. The Google daily-quota fallback across Gemini models remains provider-owned.

<a id="notebooklm-connection"></a>
## NotebookLM connection

The NotebookLM CLI must be installed before the setup page shows its sign-in control. On desktop, Connect opens Google's managed sign-in flow; the page streams PTY output, links printed URLs, and accepts a response only when `nlm` presents a prompt. After sign-in, `nlm login --check` confirms the session before the card reports connected, while the row uses `nlm notebook list` as its readiness probe.

The upstream `nlm login` command opens a managed browser and does not expose a supported URL-print fallback. If the native PTY is unavailable in the Web profile, the card says that the desktop application is required; it never tells the student to open a terminal or type a command.

-----

<a id="the-three-states"></a>
## The three states

`ready` means the tool is resolved; for `nlm`, it also requires the separate `nlm login --check` result to be connected. A presence-only report does not claim that a non-NotebookLM probe passed. `unset` means the engine could not resolve the tool. `attention` means the tool is resolved but a required probe or NotebookLM session check did not pass, which includes an installed but unauthenticated `nlm` CLI.

The setup step and accounts page offer “Prepare all tools”. The queue includes every missing application dependency, including optional converters and OCR tools; fresh reports skip executables provided by an earlier shared package. Each result shows a clear status, while stdout and stderr stay in per-tool details, closed after success and open after failure. The queue reports failed installs, continues with other tools, and stops on cancellation. Retrying runs discovery again and skips tools already installed. Separate Whisper and transcriber-anki dependencies are hidden. Account sign-in remains a separate user action.

The page never reconstructs installation choices from the browser platform. The Host derives a typed `install_route` from the engine's platform-specific `install_command` and sends both facts to the page, so a Windows report cannot expose a Linux `apt` route. User-scope routes run in-process; privileged routes use `pkexec`, then an ordered terminal fallback, then a copyable command with an explanation.

-----

<a id="check-actions"></a>
## Check actions

Initial load and Check again run the cheap presence check. Testing agy is explicit and disabled while a call is pending. For a missing tool, its row offers the Host-selected install action, streams stdout and stderr into labeled details, and runs a fresh presence check after a successful process. A missing package manager, privilege helper, or terminal is named in the row; failures open the output details and keep the copyable command available.

A dependency with `install_command: null` has no copyable or executable command; the Host classifies it as manual.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers one Settings section and one first-run step after their slots exist, binds its own locale namespace, and injects the engine capability and the Gemini key's calls into pure components. The page derives every standing from the report facts plus the separate `authStatus` result; it does not infer a state from a failure string or from the browser platform.

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Settings and first-run registration, the Gemini key's credential calls, locale wiring |
| [`src/client/AccountsSection.tsx`](src/client/AccountsSection.tsx) | The page: one card per service, and the key card |
| [`src/client/SetupStep.tsx`](src/client/SetupStep.tsx) | The first-run step, and the tool row both surfaces draw |
| [`src/client/standing.ts`](src/client/standing.ts) | A tool's localized purpose and hint, hidden tools, and standing |
| [`src/client/doctor.ts`](src/client/doctor.ts) | Check lifecycle and NotebookLM session state |
| [`src/client/gemini-key.ts`](src/client/gemini-key.ts) | Write-only credential calls and safe authenticated-check results |
| [`src/client/quota.ts`](src/client/quota.ts) | When the free daily quota renews, on the student's clock |
| [`src/client/DependencyInstall.tsx`](src/client/DependencyInstall.tsx) | Route explanation, streamed install output, buttons, and copyable fallback |
| [`src/client/InstallOutputDetails.tsx`](src/client/InstallOutputDetails.tsx) | Collapsed stdout and stderr details for tool installations |
| [`src/client/NotebookLmConnect.tsx`](src/client/NotebookLmConnect.tsx) | PTY transcript, URL links, prompt input, session check, and desktop-only fallback |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Simplified Chinese copy |
| [`src/client/AccountsSection.module.css`](src/client/AccountsSection.module.css), [`src/client/Controls.module.css`](src/client/Controls.module.css) | Card layout; install and sign-in controls |

</details>

**Runtime invariant:** No companion is published. The cards render the doctor report and credential status without owning state; standing rules are asserted by behavior specs.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Engine Remote capability](../../api/transcriber-engine/README.md) — Host command, report, cancellation, and error contract.
- [Settings domain](../ui-settings/README.md) — section registration and localized settings chrome.

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser page registers no tool, prompt section, or session event.

#### KV Cache effect

None; readiness checks do not assemble or send a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No automatic live probe** — the page does not spend network and desktop-tool time testing agy until the student asks.
- **Explicit key checks** — saving validates input and provisions settings; `GeminiKey.check` runs only when a consumer invokes it, and a successful catalog request does not prove generation quota.
- **Host-dependent installation** — the page can install `nlm` through `pipx` and can request privileged routes through `pkexec`; missing helpers leave a copyable, explained command rather than collecting a password.
- **Manual native verification** — automated tests use fake processes; the PTY spawn, real `nlm login`, Google sign-in, and Windows behavior require manual verification on the target desktop.
- **Web authentication** — `nlm login` does not provide a supported printed URL flow, so browser-only use cannot complete NotebookLM sign-in.
- **No Python row** — Python startup failure is reported as an engine error because the doctor must run inside Python before it can produce dependency rows.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

A student does not shop for providers or filter a list of eight tools: they need to know whether the app can run. The page therefore leads with standing, one card per service in the order a transcription needs them, and keeps each repair inside its card. The old pages offered the Gemini key twice, as a "Gemini API key" sign-in button and again as an "API key" field; the key card has one field.

</details>

FFmpeg is required for recording compression and participates in the missing-tool count and app-managed installation sequence.
