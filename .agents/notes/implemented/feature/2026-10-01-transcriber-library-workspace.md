# Agent Note: Session-free transcriber library workspace

Status: implemented

English | [中文](2026-10-01-transcriber-library-workspace.zh.md)

## Problem

The study library needs modules, lecture progress, transcript editing, and figure reads before a student opens a chat Session. The Session-scoped file service cannot identify this workspace without a Session, and its provider-readable file policy is broader than the library’s workspace-only access.

## Decision

[The transcriber engine API](../../../../packages/api/transcriber-engine/README.md) owns session-free inventory and file Remotes. Inventory calls share an MCP runner and validate engine JSON; optional progress fields preserve answers from older engines. File paths derive from one live workspace resolver, then pass lexical and realpath containment checks. A related-image base file and its target must both be existing workspace files.

The resolver selects an existing absolute directory saved in `$DSH_HOME/transcriber/workspace.json`, then `TRANSCRIBER_WORKSPACE`, then cwd. Missing, unreadable, malformed, relative, and stale settings use the fallback. `workspace` reports the selected path, source, directory existence, and immediate module directory count without Python. `setWorkspace` validates an absolute existing directory or creates it and `modules/` when authorized, then persists the selection through an exclusive owner-only temporary file and atomic rename. Node’s operating-system home plus `.dsh` supplies the default Harness home; blank `DSH_HOME` is ignored and current-user tilde paths are expanded. Reusing the shared home-paths helper requires a dependency addition, which the authorized change excludes.

`createModule` validates lowercase letters, digits, and hyphens, maps `displayName` to `display_name`, and passes `confirmed: true` after UI confirmation. A configurable deadline bounds the engine call, whose text and typed refusals reach the caller. Host listings have no cache: subsequent calls read a fresh engine process. Browser display caches retain their own refresh policy.

Validated deployment caps apply before retaining complete results and while reading chunks. Versions include nanosecond mtime and ctime, size, and SHA-256 content. `stat` hashes incrementally without retaining content. Markdown writes serialize by canonical target inside one service, stage exclusively in the target directory, and repeat the version check before atomic rename. Rename commits the edit; failures before it preserve the complete target.

## Alternatives considered

**A synthetic chat Session.** Library access has no chat lifecycle. Creating a Session only to use its file API introduces durable records and selects a filesystem policy unrelated to the engine root.

**Whole-file reads followed by a cap.** Oversized files consume memory before refusal, and separately acquired pathname metadata can assign another write’s version to the bytes. Opened-handle reads keep content and metadata together and bound retained bytes.

**Unconditional transcript replacement.** This overwrites edits made since the library loaded the transcript. Version checks and service-local serialization refuse stale and simultaneous library writes.

**Process-start-only workspace selection.** Changing an environment variable requires restarting the application and provides no session-free setup operation. A shared saved setting lets subsequent Host and engine calls use the student’s selected library.

## Consequences

This is Host filesystem access under the engine root, independent of Session sandbox providers. Symlink escapes and lexical traversal outside that root are refused. Portable Node APIs provide atomic rename but no atomic version-comparing rename: external writers can change a target between the final check and rename. Hostile concurrent ancestor replacement requires OS-level isolation. The service does not claim cross-process locking. Temporary files are owner-only and exclusively created; cleanup failure reports a filesystem error.

The Session file service and its [read-authority decision](../architecture/2026-09-09-workspace-file-read-authority.md) retain their own consumers and policy; this decision supersedes neither. Inventory and file tests cover containment, inclusive caps, optional progress, conflicts, simultaneous library writes, and staging or rename failure. A real Loader composition pins the module inventory and configured file cap without creating a Session. Workspace and fake-MCP tests cover saved-setting precedence, fallback, persistence, cancellation, slug refusals, deadlines, and fresh listings after creation. The Loader composition also pins setup and confirmed module creation. No model request or Session event is produced. Cancellation cannot undo directory creation or committed engine edits; a failed setting write preserves the previous selection.
