# Agent Note: Recursive exam discovery and preserved derived text

Status: implemented

## Problem

Students organize question papers in subfolders and can use the same filename in different folders. Flat discovery omits those papers, while basename keys can merge their preparation, index and provenance records. An unowned text sibling named after a spreadsheet can be indexed as a separate paper and block preparation of its original.

## Decision

Question papers use POSIX paths relative to `Questions/` throughout discovery, preparation, extraction checkpoints, publication, inventory, question lookup, provenance, year overrides and file operations. Discovery excludes hidden entries and engine-derived files. Top-level identities remain bare filenames. Filename year parsing reads only the leaf filename, including when provenance receives a relative paper path. Assessment citations retain directory components so same-named papers cannot authorize each other's evidence.

An exact `<existing paper name>.txt` sibling is derived text even without an ownership receipt. Preparation preserves unowned bytes under the module's `.transcriber-cache/exam-text-backups/` before generating fresh text. Its preparation receipt records `preserved_text`; each backup also has a `receipt.json` identifying the original paper and retained path. Rename and trash preserve unowned derived siblings before they can become orphan papers. Failed extraction does not claim ownership of a future text file. Owned OCR receipts remain valid provenance inputs while staying hidden from discovery.

The [original-preservation decision](../feature/2026-10-06-exam-file-preparation.md), [legacy-sidecar decision](2026-10-10-automatic-exam-reading-sidecars.md), [selected-retry decision](2026-10-16-retry-selected-papers.md) and [self-repairing index decision](../feature/2026-10-29-self-repairing-exam-index.md) remain active for their preparation, OCR, fallback, retry and review rules; paper identities and unowned derived-text preservation follow this note.

## Alternatives considered

**Flattening papers.** Moving student originals changes their organization and creates filename conflicts. Relative identities retain the directory structure.

**Overwriting unowned derived text.** The naming convention identifies a derived sibling but does not authorize deleting its bytes. Retained backups permit preparation without data loss.

**Refusing preparation.** A stale sibling would keep blocking its original and require manual repair. Preservation allows the engine to continue safely.

## Consequences

Existing top-level indexes remain readable. Nested papers have independent cache and provenance records, and rename or removal invalidates their recorded evidence. Backups consume disk space and are not automatically deleted.

Regression tests cover nested discovery, duplicate leaf names, unchanged top-level identities, folder-year exclusion, nested PDF preparation, spreadsheet indexing with stale text, provenance selection, inventory, question lookup, year overrides, rename, trash and restore. Tests use fake model responses; they do not establish live extraction accuracy or provider speed. [The exam guide](../../../../docs/qabas/exams.md) documents the user-visible behavior.
