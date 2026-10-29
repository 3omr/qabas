---
description: "Qabas library: current Qabas controls, saved data, recovery and limitations."
---

# Qabas library

## Summary

The library groups study material into modules and lectures. A module can contain subjects, local recordings, reference files, NotebookLM sources and transcription outputs. Library cards count artifact states; they do not establish whether a background job has succeeded.

## Table of Contents

- [Entry points](#entry-points)
- [Modules and notebooks](#modules-and-notebooks)
- [Subjects and lecture management](#subjects-and-lecture-management)
- [AI organization](#ai-organization)
- [Failures and limitations](#failures-and-limitations)
- [Dev Note](#dev-note)

## Entry points

Open the library home, then a module card. The module page offers lecture management and exam management, lecture filters, source inventory and recoverable removals. A lecture opens its transcript or draft, with the doctor's verbatim text in a separate fold. [Home](../../packages/client/ui-library/src/client/views/Home.tsx), [module](../../packages/client/ui-library/src/client/views/Module.tsx) and [lecture](../../packages/client/ui-library/src/client/views/Lecture.tsx) views define these controls; [Arabic copy](../../packages/client/locale-ar/src/client/locales.ts) supplies their labels.

## Modules and notebooks

Add module («أضف موديول») accepts a display name and a lowercase folder identifier containing letters, digits and hyphens, beginning with a letter or digit; the engine additionally rejects a trailing or repeated hyphen. Arabic display names are accepted, but their automatic folder suggestion can be empty; enter a valid identifier separately. Creation checks duplicate aliases and existing directories. The engine reuses the NotebookLM notebook whose title matches the display name or creates one; when several notebooks match, creation fails and asks for explicit notebook IDs, which the dialog has no control to supply. NotebookLM availability and authentication can therefore block creation.

Creation saves `module.json` with display name, aliases and notebook IDs, and creates `Lecture/`, `Questions/` and `Transcripts/`. Notebook content remains remote; saving a notebook ID is not a local copy of its sources. [Module creation](../../engine/scripts/manage_modules.py) and the [creation dialog](../../packages/client/ui-library/src/client/views/Setup.tsx) own this behavior. Module removal and restoration are described in [Trash](trash.md).

## Subjects and lecture management

Lecture management can create and rename subjects, delete a subject, and move a lecture into or out of a subject. Deleting a subject clears the assignment while retaining lectures, source files and transcripts. Ordered subjects and lecture assignments live in `module.json`; subjects do not move files or change the notebook. The [lecture registry](../../engine/scripts/lecture_registry.py) also supports subject reordering, although the manager does not expose a reorder control.

Automatic grouping recognizes trailing part and cohort markers, compares recording bases without case, and orders the recordings within each unit. Manual definitions select and order recordings and assign materials; they take precedence over automatically inferred units. A recording can exist locally under `Lecture/` or as a NotebookLM recording without a local copy. Material assignments require local files. The editor supports lecture rename, recording order, source reassignment and hiding; it refuses to remove the last recording through a move. Hiding retains the recordings, removes the manual definition and also hides the lecture's matching final transcripts from the library; restoring visibility does not recreate that definition. See [grouping](../../engine/scripts/recording_grouping.py), [registry](../../engine/scripts/lecture_registry.py) and [manager](../../packages/client/ui-library/src/client/views/Manage.tsx).

File selection and drag-and-drop import material into `Lecture/`; the manager distinguishes unassigned files, lecture-specific files and general material. Upload sends selected recording sources to NotebookLM. Importing a file locally does not itself mean NotebookLM has processed it. File rename updates owned references; removal uses [Trash](trash.md).

## AI organization

The manager menu's «رتّبها بالـ AI» requests a proposed division into lectures and general material. The student reviews selected rows and titles before applying it. A proposal may use agy, with filename-based grouping as a fallback. It does not transcribe the lecture. The saved proposal is `.transcriber-cache/organization-proposal.json`; accepted definitions and general-material assignments go into `module.json`. [Proposal generation](../../engine/scripts/module_organization.py) validates files against the inventory, and the [review view](../../packages/client/ui-library/src/client/views/Proposal.tsx) controls acceptance.

## Failures and limitations

Inventory and edit failures appear as errors with retry controls where provided. Restore a hidden lecture or removed item through [Trash](trash.md); changing a subject is not a file-recovery operation. [Transcription recovery](transcription.md#recovery-and-limitations) covers retained drafts and job failures.

The client retains cached library data, and mutation refresh is incomplete: subject moves, index removal and removed/restored modules can leave stale views ([#53](https://github.com/3omr/qabas/issues/53)). A reload can refresh inventory, but also affects [running jobs](transcription.md#recovery-and-limitations). Case-only duplicate lecture listings remain a reconciliation problem even though automatic grouping already case-folds names ([#56](https://github.com/3omr/qabas/issues/56)).

There is no module-rename control. Arabic-only names need a separate folder identifier, and empty modules, click feedback, menu latency, rename ordering, persistent save confirmations, subject placeholder copy and mixed-script layout have known usability gaps ([#62](https://github.com/3omr/qabas/issues/62)). Those findings are limitations, not promises that a particular delay reproduces on every machine. [Cache](../../packages/client/ui-library/src/client/cache.ts), [refresh logic](../../packages/client/ui-library/src/client/service.ts) and the linked views are the current implementation.

## Dev Note

None.
