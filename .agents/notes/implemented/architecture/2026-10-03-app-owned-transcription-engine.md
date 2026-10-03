# Agent Note: App-owned transcription engine

Status: implemented

English | [中文](2026-10-03-app-owned-transcription-engine.zh.md)

## Problem

Qabas's launcher and grouping tests depend on a separately released skill checkout. A student's desktop installation cannot rely on that checkout, and a skill release notification cannot identify an application upgrade.

## Decision

Qabas owns `engine/`, copied from the universal-transcriber skill repository at `c1168da`. It retains tracked engine scripts, runtime editorial guidance, one shared grouping fixture, and engine tests. Anki distribution, mirror, installer, and skill release machinery remain outside the app. The app version comes from its own package metadata; this copy contains no skill release lookup or update notification.

The Host resolves `TRANSCRIBER_ENGINE_ROOT`, then legacy `TRANSCRIBER_SKILL_ROOT`, then `engine/` relative to its package. Source scripts take precedence over the directory's frozen executable. The MCP patch reads the Host's `mcpCommand` getter after its service becomes available; both paths share workspace-file selection and launcher errors. Workspace data is never searched for engine code. PyInstaller includes the editorial reference and app version, and its entry dispatcher keeps child workers inside the same binary.

Desktop preparation copies the native onefile sidecar and profile patch into `runtime/app/engine/`. The Tauri resource mapping carries that directory, and the native host applies the engine patch alongside its desktop overlay. Missing sidecars refuse preparation. Each release platform builds its own sidecar; binary freezing does not provide cross-compilation.

Python and TypeScript read one grouping case file. The browser fallback groups boys/girls recordings in the same cohort and part order as the Python engine. Root commands run unittest, ruff and mypy through the engine's venv when present; engine CI also runs the pytest desktop cases. Engine development prose and copied runtime prompt data remain English-only.

This decision extends the [session-free workspace owner](../feature/2026-10-01-transcriber-library-workspace.md) and [lecture registry owner](../feature/2026-10-02-lecture-manager-wiring.md). Their inventory, path-containment, cancellation, and write semantics remain active; neither is superseded.

## Alternatives considered

**Keep the skill checkout as a runtime dependency.** This prevents independent application installation and couples app tests and release guidance to the skill distribution.

**Remove the legacy root variable immediately.** Existing installations already configure it. A lower-priority legacy override preserves those setups while the app's default requires no external checkout.

**Keep a second grouping fixture and compare checkout copies.** A conditional byte comparison leaves drift undetected when the other repository is absent. One app-owned fixture always checks both implementations.

## Consequences

Qabas maintains Python engine fixes, dependency gates and native frozen builds independently. NotebookLM, OCR, media and office tools remain external system dependencies; the sidecar removes the Python interpreter requirement from the desktop carrier, not those tools. Explicit legacy overrides intentionally select external code; ordinary installation and tests use the app-owned copy.

The 641 unittest cases exclude the skill distribution's 75 cases from the original 716: 21 Anki extraction, three Anki generation, 38 release-version, and 13 skill update cases. Three course-data checks skip without local course files. Pytest additionally exercises the function-based desktop cases. An import-blocking unittest run records zero skill-checkout imports; focused Host and profile tests pin root precedence, cwd independence, frozen subcommands and missing-engine refusal. Native installer and frozen-binary acceptance remain target-platform checks in desktop CI.
