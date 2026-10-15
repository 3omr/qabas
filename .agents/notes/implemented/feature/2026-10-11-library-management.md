# Agent Note: Lecture and exam management pages

Status: implemented

## Problem

The owner found lecture and exam management hard to use. The module's lecture progress bar sat directly under the exam-bank banner and read as indexing progress. The lecture page repeated that banner, scattered its actions, put the drop zone after every card, and showed every file with an unlabelled "×" that acted immediately. The exam page labelled read-but-unindexed papers "جاهز", showed static text while the bank was built, and offered no bulk actions. First loads showed empty areas and refreshes replaced content.

## Decision

The module overview owns a labelled transcription section ("التفريغ: N من M جاهزة") with its own progress bar. The exam-bank card appears only on the overview and the exam page and shows live progress while an index build runs. The lecture-management page drops the banner.

Both management pages have a sticky toolbar with one primary action, and the whole page accepts dropped files with an overlay for external file drags only. Lectures are compact full-width rows (title, recording and material counts, ownership badge, transcript state) that expand to show files. A row menu offers rename (inline; Enter saves, Escape cancels), edit and remove lecture. Remove uses the existing hide/restore semantics and its dialog says files and transcripts are kept. Each file has two labelled actions: "شيل من المحاضرة" keeps the file in the module, and "ودّيه السلة" moves it to the trash after a confirmation that says it can be restored. The delete adapter keeps the trash entry id the engine now returns, so a toast offers Undo only when a restore identity exists. The edit dialog holds the title, ordered recordings (drag or Earlier/Later buttons), materials and an unassigned-file picker.

Exam rows show distinct states with icon and text: not read, reading, read but not indexed, indexed with question and review counts, failed with reason and Retry. Paper notes from the engine are shown under the paper; the fixed year-mismatch note is localized. Rows support selection and bulk move to trash. A streamed exam-index Remote forwards the engine's real MCP progress (papers done and total, current paper, part and split) to one progress presenter with elapsed time and Stop; the completion method stays for existing callers.

Uploads list each file with local preparation measured and an indeterminate saving phase until the engine acknowledges the import; no percentage is invented for a single-request transfer. A Skeleton primitive reserves row layout on first load, background refreshes keep current content, and each write shows a pending state on its own row. Menus move focus into their items and return it on Escape; dialogs trap focus.

## Alternatives considered

**Restyle the existing cards.** CSS alone cannot add undo identities, streamed progress or per-row pending state.

**Synthetic upload percentages.** The import Remote sends one request without transfer checkpoints, so a timer-driven bar would claim progress that did not happen.

**A separate subjects model now.** The lecture list renders grouped sections so a later subject grouping can reuse it, but subject persistence is a separate change.

## Consequences

Students see what each control changes before it changes, can undo trash moves, and can follow and stop index builds. The engine's `remove_file` result gains the trash entry id. English and Arabic dictionaries carry every new string; owner-local snapshots pin both. The rows were checked in the live preview at the app's pane width, including the expanded files, the trash confirmation and undo, the edit dialog and the live index progress.
