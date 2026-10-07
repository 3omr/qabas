# Agent Note: Managed Qabas library and chat storage

Status: implemented

English | [中文](2026-10-07-managed-library-workspace.zh.md)

## Problem

The engine library and chat workspace use independent locations. Choosing a chat folder does not load its modules, and changing the module default can hide existing files. Chat logs and attachment bytes live outside the student library.

## Decision

The [shared path helper](../../../../packages/util/home-paths/README.md) resolves the operating-system home plus `qabas/Qabas Library`, or the explicit `TRANSCRIBER_WORKSPACE` developer override. The [engine](../../../../packages/api/transcriber-engine/README.md) and Python resolver agree. Modules live under `modules`; the [Web bundle](../../../../packages/bundle/web-app/README.md), including Desktop, stores durable chats under `.qabas/sessions` and attachment bytes under `.qabas/attachments/v1`. Application settings, credentials and installed profiles retain their harness home.

The [workspace registry](../../../../packages/workspace/workspace/README.md) prepares one canonical managed root before activation. Root rename, removal, reorder and foreign creation reject at the registry and entity. Unrelated durable registrations remain stored and outside the managed workspace projection. The Remote baseline carries the managed identity. New chat creation resolves and attaches that workspace automatically; an explicit equivalent cwd is accepted and a foreign cwd is refused.

Historical chats retain their recorded cwd and remain readable. Active foreign adoption and resume reject. A historical fork creates a new library-rooted child while retaining the parent’s generations, bytes and lineage. The [workspace UI](../../../../packages/client/ui-workspace/README.md) uses the managed identity for New Session, removes directory-selection controls in wide and narrow navigation, and retains older chats under Previous chats. Saved flat grouping does not change managed presentation. Session rename, archive and ordering remain available.

Legacy chat and attachment relocation copies original bytes before serving the destination, accepts identical collisions and refuses different bytes. Session relocation holds source and destination writer leases. Completed relocation has a source-specific checkpoint; its retained source is a snapshot, and later writes there are not synchronized. Released generations, identifiers, parent relationships and recorded paths are never rewritten. Module adoption uses the engine’s library and module locks before inventory becomes available. Explicit developer roots remain isolated.

The [whole-library decision](2026-10-02-library-single-call-and-organization.md) and [exam-original decision](2026-10-06-exam-file-preparation.md) retain inventory, preparation, caching, reversible removal and organization ownership. This decision supplies their library location and connects chat storage to that location. Arabic coverage discovers dictionary files across every package group, including Session export and Desktop features.

## Alternatives considered

**Hide the picker without Host enforcement.** Existing Remote and entity operations can still create or mutate a different root.

**Change the global harness home.** That also relocates credentials, settings, profiles, recovery state and non-Web applications.

**Rewrite old chat headers to the library path.** Their released generations and persistence identities must remain intact.

## Consequences

One portable library contains modules, chat logs and attachment bytes. Source originals remain recoverable after relocation; divergent destination data and live writers prevent unsafe copying. Generic headless and SDK profiles keep their storage defaults. Per-session browser drafts and view preferences remain browser-local. Folder permissions, disk capacity and startup relocation errors fail explicitly rather than hiding data. Windows installation acceptance remains a target-machine check; source tests and installer CI do not prove a native installation run.
