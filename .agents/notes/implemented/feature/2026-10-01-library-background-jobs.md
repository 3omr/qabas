# Agent Note: Background library jobs observe shared Session presentation

Status: implemented

English | [中文](2026-10-01-library-background-jobs.zh.md)

## Problem

The library-first interface makes study material directly readable, but sending every action to a visible conversation makes chat the working interface again. Students need queued transcription, progress, and questions in the library while retaining access to the underlying conversation.

## Decision

LibraryJobs owns stable job identities and FIFO admission under a validated concurrency setting. Each job owns one transcriber session; the runner observes public Session lifecycle snapshots, the Conversation Chat target, and ui-session's effective pending-interaction map. It answers the pending question's own object so library and composer answers settle one request. Local persistence retains job identities and outcomes without retaining answerable question objects.

The Session Controller's public `sessions.watch(id)` returns a `SessionWatch` with an opening `ready` promise and an idempotent asynchronous `release()`. Watches share the same Session event feed that panel navigation opens. The last background-only release closes the Remote iterator and retains the readable event window; a new watch opens a fresh snapshot. A session opened through panel navigation keeps its existing feed lifetime after every background watch releases. Scope removal and controller disposal close retained feeds, and a late release cannot close a replacement scope with the same identity.

The runner registers each watch and its observable subscriptions as Cordis effects before awaiting readiness or sending a prompt. Completion releases the retention, dismissal removes an already-released terminal record, and plugin disposal joins pending stream teardown. Releasing a client feed does not interrupt the Host Agent. Successful transcription requires the last transcriber call to be a successful finalize; module jobs require a normal recorded turn ending. Waiting questions retain concurrency slots and can be answered from either presentation.

## Alternatives considered

**Select the session and restore the previous selection.** Rejected because opening background work changes visible navigation and couples progress to the panel selection lifecycle.

**Implement a second event-stream projection inside the library.** Rejected because history paging, stream recovery, compact assistant records, and conversation assembly already have owners; duplicating them would create inconsistent progress and summaries.

**Return a release callback only after opening completes.** Rejected because a plugin disposed during its first history request must release the feed before that request finishes. A handle exposes cleanup immediately and readiness separately.

## Consequences

Background jobs receive progress and terminal-turn observations before any conversation is opened. Reload reattaches active sessions without sending their prompts again. Job records and concurrency accounting remain browser-client-local, without coordination across tabs. Normal conversation navigation and Host Agent lifetimes retain their existing behavior.

## Verification

Controller tests exercise shared retention, idempotent release, panel handoff, release during opening, business and assembly failures, removal, replacement scopes, and root disposal. A runner regression uses the real ClientSessions, UiConversation, and Chat definitions over the Session Controller's programmable Remote fake: a never-selected session publishes draft progress, shares a question, finishes, releases history, and admits queued work. A fresh controller reattaches a persisted job through saved history without selecting its session or resending the prompt. Disposal during an initial opening releases the feed without submitting the prompt. Fixture watch tests verify the public test double follows the same retention and selection rules.
