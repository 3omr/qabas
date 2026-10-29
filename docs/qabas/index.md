---
description: "Qabas feature reference: current Qabas controls, saved data, recovery and limitations."
---

# Qabas feature reference

## Summary

Qabas lets medical students organize recordings and study materials, prepare exam questions, and read lecture transcripts. This reference describes the controls and file behavior in this checkout. The child pages separate current behavior from issue-linked limitations; [issue #66](https://github.com/3omr/qabas/issues/66) tracks the documentation and remediation proposal.

## Table of Contents

- [Features](#features)
- [Storage and verification](#storage-and-verification)
- [Dev Note](#dev-note)

## Features

Open the library for study material and the conversation panel for the assistant. Settings contains account and tool readiness controls.

| Reference | Lookup scope |
|---|---|
| [Library](library.md) | Modules, NotebookLM notebooks, subjects, lecture grouping, sources and AI organization |
| [Transcription](transcription.md) | Start, Continue, Redo, pipeline stages, five sections, figures and finalization |
| [Exams](exams.md) | Papers, years, question reading, preparation, index builds and retries |
| [Chat](chat.md) | Assistant conversations, the unscoped composer, provider fallback and available actions |
| [Settings](settings.md) | General preferences, NotebookLM, Antigravity, Gemini, local tools and external illustrations |
| [Trash](trash.md) | Removed modules, files, lecture visibility and transcript recovery |

## Storage and verification

The default library is `<home>/qabas/Qabas Library/`, with each module under `modules/<module>/`. Child pages use paths relative to that module unless they explicitly name the library root. The operating-system home determines `<home>`; a developer override can select another workspace. The [Host workspace resolver](../../packages/api/transcriber-engine/src/workspace.ts) and [Python workspace resolver](../../engine/scripts/library_workspace.py) own selection.

The references are checked against source and temporary-library regression tests. Live NotebookLM sign-in, model generation, provider quotas, external image approval and installed desktop interaction are not established by those tests. A saved draft or successful automated check does not establish medical accuracy; inspect the recording and cited paper when an explanation or answer is uncertain.

Limitations link to the [Qabas issue tracker](https://github.com/3omr/qabas/issues): the October 28 manual-test issues #51–#63 and [#65](https://github.com/3omr/qabas/issues/65), plus the follow-ups for figure dispositions ([#67](https://github.com/3omr/qabas/issues/67)), exam sidecars ([#68](https://github.com/3omr/qabas/issues/68)) and index lock diagnostics ([#69](https://github.com/3omr/qabas/issues/69)). Timing observations from that QA corpus are not performance guarantees for this checkout.

## Dev Note

None.
