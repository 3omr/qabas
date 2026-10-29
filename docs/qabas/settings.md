---
description: "Qabas settings: current Qabas controls, saved data, recovery and limitations."
---

# Qabas settings

## Summary

Settings provides general reading and interface preferences plus checks for transcription services and local tools. Accounts and tools separates a program's presence from a live service test. A stored credential or installed executable alone does not establish that the next transcription will succeed.

## Table of Contents

- [Entry point and general preferences](#entry-point-and-general-preferences)
- [Accounts and tools](#accounts-and-tools)
- [Failures and limitations](#failures-and-limitations)
- [Dev Note](#dev-note)

## Entry point and general preferences

Open Settings, then General or Accounts and tools («الحسابات والأدوات»). General renders feature-owned rows, including language, appearance, font size, transcript display, composer Enter behavior and permissions. [General composition](../../packages/client/ui-settings-general/src/client/GeneralSection.tsx), [appearance](../../packages/client/ui-theme/src/client/index.ts), [language](../../packages/client/locale/src/client/index.ts), [transcript display](../../packages/client/ui-chat/src/client/apply.ts), [composer Enter behavior](../../packages/client/ui-conversation/src/client/apply.ts) and [permissions](../../packages/client/ui-permission-presets/src/client/index.ts) own those contributions. Permission controls affect allowed agent actions and are not reading preferences.

General settings use their owning settings services; the default file provider writes `<harness home>/settings.yaml`, outside the module. There is no per-module General settings file under `<home>/qabas/Qabas Library/modules/<module>/`. See the [settings file provider](../../packages/settings/settings-file/README.md).

## Accounts and tools

The [Accounts and tools page](../../packages/client/ui-settings-transcriber-engine/src/client/AccountsSection.tsx) provides a recheck control («افحص تاني»), a page-level install-all control («جهّز كل الأدوات») and one card per service. Its Arabic labels come from the [Arabic locale](../../packages/client/locale-ar/src/client/locales.ts).

| Card | Controls and current purpose |
|---|---|
| NotebookLM | Install the CLI if missing, connect the account, and check authorization; notebook speech retrieval and uploads depend on it |
| Antigravity | Install the CLI and run a live response test («اختبر Antigravity»); diagnostics distinguish installation from a provider response |
| Gemini key («مفتاح Gemini (بديل اختياري)») | Save, check or remove the optional API key; the client receives configured status rather than reading the key back, and a key supplied by an environment variable cannot be changed there |
| Local tools («أدوات على جهازك») | Show missing required tools, expand the full list and install individual tools |
| External illustrations («صور من برّه المحاضرة») | Toggle new grounded Wikimedia Commons illustration requests for lectures |

The [dependency doctor](../../engine/scripts/dependency_doctor.py) reports converters, media and reading dependencies such as FFmpeg, LibreOffice, Poppler, OCRmyPDF, Tesseract and Ghostscript. Requirements depend on the source format. Installers can fail and expose output details; they do not grant NotebookLM or Antigravity account access.

NotebookLM connection uses the [login flow](../../packages/client/ui-settings-transcriber-engine/src/client/NotebookLmConnect.tsx); an external console can be used when the native Windows flow requires it. Antigravity sign-in is separate from NotebookLM. A live test spends a provider request and can fail for authentication, model availability, quota or network reasons.

The Gemini card writes the `GEMINI_API_KEY` credential reference through the [credential Remote](../../packages/client/ui-settings-transcriber-engine/src/client/gemini-key.ts). Provisioning can add a Google route and select a default when absent; removing the key does not remove that route. Credential persistence belongs to the Host credential provider, not `module.json`. The [provisioning code](../../packages/client/ui-settings-transcriber-engine/src/client/gemini-provisioning.ts) defines those conditions.

External illustration preference is library-wide in `<home>/qabas/Qabas Library/.qabas-engine-settings.json`, not inside a module. `web_figures` is enabled when absent; corrupt preferences prevent optional requests and settings reads/updates report errors. Existing approved images stay valid when disabled. [Engine settings](../../engine/scripts/engine_settings.py) and [illustration behavior](transcription.md#figures-and-external-illustrations) own the details.

## Failures and limitations

Recheck presence after installation and run the relevant live test after fixing sign-in. A failed or cancelled login is not a connected account. Tool output and raw diagnostics may be technical; the page offers details instead of proving that every failure has a student-level explanation.

Asynchronous account results can expand cards and shift actions, and General exposes developer-oriented controls ([#62](https://github.com/3omr/qabas/issues/62)). Work/progress copy inconsistently names «عومر» and Antigravity ([#57](https://github.com/3omr/qabas/issues/57)). Provider quota interpretation can misreport a weekly reset ([#61](https://github.com/3omr/qabas/issues/61)). Live account behavior, platform installation and provider acceptance require verification on the installed app; temporary-library tests do not establish them.

## Dev Note

None.
