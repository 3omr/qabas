# Agent Note: Keep Qabas client packages in the shipped composition

Status: implemented

## Problem

Qabas ships a Tauri shell that launches the Web profile. Uncomposed lecture panels and an Electron child-process host add package, build and documentation maintenance without a product consumer. The answering-provider chip belongs to an uncomposed lecture helper, so students cannot see it.

## Decision

The Web profile's `ui-library` owns lecture navigation and actions. The repository omits `ui-transcriber`, `ui-transcriber-composer` and `apps/desktop-host`, including their dictionaries, compiler references and publication exceptions. The composed `ui-chat` plugin owns `ChatModelChip` in `conversation.input.model`, its English `chat` keys and its provider-projection tests; `locale-ar` supplies the matching Egyptian Arabic keys.

Lecture-grouping, run-state and workspace-reader regression specs live in the retained `transcriber-workspace` library rather than the removed UI package.

The [student UI decision](../feature/2026-10-11-qabas-student-ui-consistency.md) remains active because its naming, bidi and provider-display rules still guide the shipped library and chat. The [Electron packaging decision](../../archived/architecture/2026-08-25-electron-desktop-packaging-and-updates.md) is a historical snapshot. The [Tauri carrier decision](../architecture/2026-08-20-tauri-desktop-carrier.md) owns the shipped shell.

## Alternatives considered

**Retain unused packages.** No shipped composition consumes the lecture panels or Electron host. Their build and locale entries provide no student functionality.

**Remove the provider chip with the lecture helper.** Students still need to identify the actual answering provider, including Gemini fallback. The composed Chat plugin can provide this presentation through the existing model seat.

**Compose the lecture helper to expose the chip.** The library already owns lecture choices. Composing the helper would duplicate that interface solely to recover an unrelated control.

## Consequences

The repository gives up the separate lecture sidebar, lecture-helper draft controls and Electron host implementation. Reintroduction requires a current composition and owner. Tauri continues to launch the Web profile with the engine patch. The chip changes browser presentation only; durable requests, provider routing and saved model selection retain their existing owners.
