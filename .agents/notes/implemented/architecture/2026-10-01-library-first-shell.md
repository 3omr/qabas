# Agent Note: The library is the app's first screen

Status: implemented

English | [中文](2026-10-01-library-first-shell.zh.md)

## Problem

Qabas opened on an empty chat. Everything a student owns — modules, lectures, how far each one has come, the finished transcripts — was reachable only by asking the chat, or through two partial lecture pickers (a right-sidebar tab and a strip above the composer) that listed the same lectures twice and could neither open a lecture nor start one. Asking "which lectures are left" cost a model request and ~15K tokens for a question the workspace already answers.

## Decision

A new client plugin, [ui-library](../../../../packages/client/ui-library/README.md), registers the `library` key in the layout's `main` slot and selects it at startup (`startupPanel`, default `library`). Its pages — front page, module, lecture — are drawn from the transcriber engine's `list_modules` and `list_lectures`, which are session-free and report each lecture's state (pending, verbatim, draft, final) and file paths. A module tree fills a new `sidebar.library` seat that [ui-sidebar](../../../../packages/client/ui-sidebar/README.md) declares above the workspace browser.

The library draws actions it does not perform. `ctx.library.registerAction` is keyed by id, so the package's own fallback actions — open a conversation on the `transcriber` agent preset with one sentence — can be replaced by a background runner without touching the pages. `registerOpener` lets a file viewer claim where transcripts open.

The conversation is unchanged and one click away: the sessions list, New Session, and "ask the assistant" on every page.

## Alternatives considered

**Keep the chat as the home screen and improve the pickers.** Rejected: the pickers answered "where do things stand" only partially and still routed every action through a typed sentence; the student asked for the chat to be secondary.

**Read the workspace through the workspace-files Remote.** Rejected because every call needs a session scope, and the library is a root panel with no session. The engine already owns the definition of a lecture; reading it twice would put the rule in a third place.

**Make the library a right-sidebar tab.** Rejected: a tab is scoped to a session and shares width with the conversation; the library is the primary surface.

## Consequences

The app's first screen makes no model request. The duplicated lecture pickers become removable once nothing else depends on them. Later surfaces (background jobs, the transcript editor, first-run setup) plug into `ctx.library` rather than into the conversation.
