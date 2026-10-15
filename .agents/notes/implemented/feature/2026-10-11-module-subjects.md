# Agent Note: Subjects inside a module

Status: implemented

## Problem

Some modules hold more than one subject; a "Clinical pathology and radiology" module, for example, teaches two courses with separate lectures. The library listed every lecture of a module in one flat list, so a student could not keep each course's lectures together or see each course's progress.

## Decision

`module.json` may hold an ordered `subjects` list of `{id, title, created, updated}` with slug ids and unique titles of at most 120 characters, and a manual lecture definition may name one by `subject`. Absent fields mean the module has no subjects and every reader behaves as before. An unknown referent fails when the module loads.

The engine registry adds `create_subject`, `rename_subject`, `reorder_subjects`, `delete_subject` and `set_lecture_subject`, all written atomically under the existing lecture-registry lock and exposed as confirmed MCP tools. Deleting a subject removes it and clears its lectures' `subject` in the same write; lectures, files and transcripts stay. `define_lecture` keeps a lecture's subject unless the request names one, so editing files or the title does not move a lecture. Moving an automatic lecture defines it with its current recordings and materials and the chosen subject.

Subjects are presentation metadata. They do not move files, add NotebookLM notebooks, change transcript paths, or enter `definition_signature`, so moving a lecture never marks its transcript stale. Listings report each manual lecture's `subject` and the module's `subjects`; the chat's library tools therefore see them too.

The desktop groups the module page's lectures under collapsible subject headings, each with its own transcription count, and puts lectures without a subject last under "من غير مادة". The lecture manager shows one section per subject with rename and delete in the heading, a toolbar action to add a subject, a row-menu action per subject to move a lecture, and a subject selector in the lecture editor. Modules without subjects render exactly as before.

## Alternatives considered

**One module per subject.** Students already organize their library by the faculty's modules; splitting a module would also split its NotebookLM notebook, exam papers and question bank.

**Subject folders on disk.** Moving recordings and transcripts into subfolders would invalidate notebook source titles, transcript lookups and question provenance for a display grouping.

**Including the subject in the transcript signature.** The transcript depends on recordings and materials, not on where the lecture is listed.

## Consequences

Older engines ignore `subjects` and `subject`; a module edited by this version stays loadable there only if they ignore unknown fields, which they do for these keys. Exam papers and the question bank stay module-wide. Subject order is stored but the desktop has no reorder control yet; `reorder_subjects` is available to it and to tools.
