---
description: "Qabas Trash and restoration: current Qabas controls, saved data, recovery and limitations."
---

# Qabas Trash and restoration

## Summary

Qabas keeps reversible removals for modules, source files, hidden lectures and transcript outputs. The module page lists its recoverable entries; the library home lists removed modules. Trash currently accepts more than transcripts, which conflicts with the requested transcript-only policy.

## Table of Contents

- [Entry points and removal kinds](#entry-points-and-removal-kinds)
- [Stored results](#stored-results)
- [Recovery and limitations](#recovery-and-limitations)
- [Dev Note](#dev-note)

## Entry points and removal kinds

When entries exist, the module page shows a collapsed «سلة المحذوفات (n)» section; expanding it offers «رجّعه» per entry. A module card's menu offers «شيل الموديول», and library home lists removed modules under «موديولات اتشالت» with a separate «رجّعه» action. The lecture page removes final, draft or verbatim output after confirmation; management and exam menus can send files to Trash («ودّيه السلة»), and lecture management can hide a lecture. These are distinct operations in the [module view](../../packages/client/ui-library/src/client/views/Module.tsx), [home](../../packages/client/ui-library/src/client/views/Home.tsx), [lecture page](../../packages/client/ui-library/src/client/views/Lecture.tsx) and [engine Trash implementation](../../engine/scripts/library_trash.py).

## Stored results

Module-local entries live under `.transcriber-cache/trash/<entry>/`, with `.qabas-entry.json` recording the kind, affected paths and metadata restoration information. File removal moves a `Lecture/` or `Questions/` file and updates its owned references. Hidden lectures keep recordings in place and record visibility in `module.json`; restoring visibility does not recreate a discarded manual lecture definition.

Transcript removal moves the selected outputs and the artifacts they own into one entry. Final-output removal includes the lecture's figure directories and Anki exports and removes its row from `Transcripts/Index.md`; draft removal also moves the draft's staged parts and check record. Owned run checkpoints are moved and owned batch records are edited, so restoring the entry brings them back. Unrelated lectures remain separate. The entry's recorded paths determine what it owns; removing a final does not imply all original recordings were removed.

Whole-module removal moves `modules/<module>/` to `<home>/qabas/Qabas Library/.qabas-trash/modules/<module>--<stamp>/`. NotebookLM notebooks and sources remain untouched. Trash has no automatic expiry. See [removal and restore](../../engine/scripts/library_trash.py) for the saved metadata and [visibility](../../engine/scripts/lecture_registry.py) for hidden recordings.

## Recovery and limitations

Restore refuses occupied destinations rather than overwriting them. Module restoration also refuses a reused module ID; resolve that conflict before retrying. Engine activity guards can refuse removal while the module is busy. The browser hides transcript-removal controls while the lecture has an active job, but that browser state is not the engine's authority for excluding other processes.

Module-local restoration preserves unrelated later metadata where supported; a named conflict or changed progress can require manual resolution before recovery. Reload can refresh missing removed/restored listings, but also affects active jobs ([#53](https://github.com/3omr/qabas/issues/53), [#52](https://github.com/3omr/qabas/issues/52)).

The current file and module removal actions are not transcript-only ([#59](https://github.com/3omr/qabas/issues/59)). Hiding, source-file removal, whole-module removal and transcript removal must not be treated as interchangeable. Transcript-only Trash is the owner requirement in [#59](https://github.com/3omr/qabas/issues/59); the current engine still accepts source-file and module removals.

## Dev Note

None.
