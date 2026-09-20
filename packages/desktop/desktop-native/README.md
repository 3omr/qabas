---
description: "Authenticated loopback transport for plugins calling the Tauri desktop host, including configuration and failure behavior."
kind: "package-reference"
---

# @deepseek-ai/dsh-desktop-native

English | [中文](README.zh.md)

## Summary

Plugins can call native desktop operations through `ctx.desktop` while the Tauri application supervises Harness. Each call uses a private loopback bridge and a separate per-launch token. The provider also exposes the desktop-only PTY lifecycle used by NotebookLM authentication. The provider rejects non-loopback origins before sending credentials and rejects failed or timed-out operations.

## Table of Contents

- [Configuration](#configuration)
- [Implementation](#implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="configuration"></a>

## Configuration

The [desktop overlay](../../../apps/desktop/runtime/desktop.cordis.yml) mounts this provider with values supplied by Rust. It is a Cordis plugin, not an independently installable Profile Bundle.

| Field | Default | Meaning |
|---|---|---|
| `endpoint` | Required | Exact `http://127.0.0.1:<port>` origin, without user info, path, query, or fragment. |
| `token` | Required | Secret-role token for the native bridge, never placed in a URL. |
| `timeoutMs` | `5000` | Independent deadline in milliseconds for each operation. |
| `notifyOnTurnEnd` | `false` | Notify on live top-level completion or failure; enabled by the desktop overlay. |
| `startupToken` | Omitted | Per-child hexadecimal identity supplied by Rust; requires the launcher's `appReady` service. |

With `startupToken`, the provider acknowledges successful launcher startup over the authenticated private bridge. Mounting the provider or opening the HTTP listener does not send that acknowledgement. Unloading detaches the readiness listener, cancels in-flight acknowledgement transport, and awaits its settlement. Delivery failure logs no launch identity and leaves the native startup deadline in force. Rust accepts only its currently owned child identity and requires both the acknowledgement and an open listener before navigation. This confirms startup, not every plugin feature or future runtime health.

Background turn notifications omit task text and error details. The native host suppresses them while the main window is focused. Canceled or blocked turns, child sessions, and restored history do not notify; unloading the provider removes the observer. The provider logs notification failures without failing an already committed turn. OS notification permission is still required; clicking a notification does not select its Session.

Before sending an eligible task notification, the provider asks the synchronous `desktop/task-notification` waterfall. A policy calls `next()` to delegate or returns false to suppress that notification. Without listeners, delivery is permitted; a thrown policy suppresses delivery and logs a generic warning without changing the committed turn. The optional [Notification Controls Bundle](../notification-controls/README.md) supplies persistent switches. This policy does not govern direct `ctx.desktop.notify()` calls.

Profile selection reads validate the native JSON version, identifiers and fields within a 65536-byte response limit. Queue and cancellation forward exact identities through the authenticated bridge; neither restarts the runtime. The provider keeps no activation mirror. A timeout does not prove that a mutating request failed to commit; consumers retain prepared files and inspect selection before retry or cleanup.

Opening local-agent settings sends a fixed, argument-free request to the native host. It neither reads account data nor runs probes. The existing native extension window owns checks and saved choices; the browser receives no native command permission or bridge token.

NotebookLM authentication starts `nlm auth` through the native host's portable PTY, polls bounded output by cursor, and forwards one-line replies or cancellation. The process receives the same scrubbed environment and constructed PATH used by local agent probes. The native host never stores the authentication output as durable data.

<a id="implementation"></a>

## Implementation

<details>
<summary>Native bridge ownership</summary>

The [provider](src/index.ts) sends authenticated requests to the [Rust bridge](../../../apps/desktop/src-tauri/src/bridge.rs). Browser authentication belongs to the upstream Connection package and uses a different credential. NotebookLM output stays in the bounded native session and is polled by the engine capability; it is not a forwarded Cordis event. No runtime invariant companion is published because each request is independent and the provider keeps no mirrored native state.

</details>

<a id="model-experience"></a>

## Model Experience

### Native bridge operations

#### What the model sees

Nothing directly. `NativeDesktopHost.notify()` carries a consumer request and returns no model-facing text.

#### Token effect

Native operations add no prompt, message, schema, or tool result.

#### KV Cache effect

Native bridge traffic is outside model requests and preserves every reusable prefix.

### Installed desktop context

#### What the model sees

When `systemPrompt` is mounted, the provider registers the desktop orientation below. The desktop overlay disables the Web development context and its `DSH_WEB_URL` shell variable. Normal prompt assembly records the resulting text in `request/header`; a preset's complete persona still replaces the assembled system prompt. Unloading the provider removes its section. Bridge endpoints and credentials never enter this text.

##### Desktop orientation

```markdown
You are interacting with the user through Harness Desktop, a desktop application built on DeepSeek Harness. References to "this app" or "this interface" mean this desktop application unless the user names another target. The interface provides no implicit screenshot, DOM, or route context. The app manages its bundled runtime. Starting a separate web server or rebuilding a workspace does not update this installed app. Do not modify installed application resources or restart the desktop app unless the user explicitly asks. Work in the selected session workspace; it is separate from the app installation.
```

#### Token effect

The fixed section contributes system-prompt tokens while active; native calls add none. It contains no per-launch values.

#### KV Cache effect

The text remains a stable request prefix across turns. Changing or removing the section replaces earlier prompt tokens and can invalidate their reuse; provider cache availability remains external.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No native event stream**: NotebookLM output uses request polling rather than a general native event bus; menus dispatch into the WebView.
- **Manual PTY verification**: real `nlm auth`, browser sign-in, and Windows PTY behavior are not covered by the JavaScript bridge tests.
- **Trusted local plugins**: the token authenticates the Harness process, not each plugin inside it.

<a id="dev-note"></a>

### Dev Note

None.
