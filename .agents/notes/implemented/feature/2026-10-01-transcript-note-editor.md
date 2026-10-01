# Agent Note: Transcripts open in an Obsidian-style editor

Status: implemented

English | [中文](2026-10-01-transcript-note-editor.zh.md)

## Problem

A finished transcript could only be read in the right sidebar's document preview, which needs a chat session, cannot edit, and drew a transcript's callouts as plain quotes. Students keep their notes in Obsidian and asked for transcripts to open in the app the same way.

## Decision

A new client plugin, [ui-note](../../../../packages/client/ui-note/README.md), registers a `note` main panel with tabs and becomes the library's file opener. It edits in CodeMirror 6 with an Obsidian-style live preview built purely from decorations over the markdown syntax tree: the line under the cursor shows its markdown, other lines render headings, emphasis, lists, callouts, figures and `[[wikilinks]]`. Lines take their own text direction, so Egyptian Arabic and English terms mix correctly. Reading mode, outline, search and word count complete it.

Files go through the transcriber engine's session-free `readFile` / `readFileBytes` / `writeFile`. Every save carries the version last read and the host refuses a stale one; the panel then offers "use the version on disk" or "keep my changes", because the engine may rewrite an open transcript.

## Alternatives considered

**Extend the document preview.** Rejected: it is a session-scoped, read-only side tab; editing and tabs are a different surface.

**Embed a full Markdown WYSIWYG editor.** Rejected: it would rewrite the source on save, and the engine and Obsidian both read the file as markdown. Decorations keep the text exactly as typed.

**Last-write-wins saving.** Rejected: a finalize or figure extraction while the note is open would be lost silently.

## Consequences

Transcripts are readable and correctable without a chat. CodeMirror becomes a dependency of one client package.
