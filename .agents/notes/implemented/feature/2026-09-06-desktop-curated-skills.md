# Agent Note: Pinned data-only desktop Skill installation

Status: implemented

## Problem

An extension directory does not make a remote Skill available to Harness. Installation needs identifiable content, complete resources, user consent, and a removal path that preserves user changes without introducing a second plugin execution system.

## Decision

The desktop ships a curated manifest of exact GitHub revisions and SHA-256 hashes for reviewed text-only Skill bundles. The first entry is Anthropic's Frontend Design Skill with its license and repository attribution notices. Only the privileged local extension window can request download, installation, or removal; requests name a catalog id and revision, never an arbitrary URL, executable, or destination. Preview text uses text nodes, not HTML or executable Markdown.

Downloads reject redirects, use bounded response sizes and deadlines, and carry no Harness account credentials. Installation verifies the entire bundle in private temporary storage before a non-replacing directory rename publishes it under the desktop home. The existing filesystem Skill provider owns discovery, priority, and instruction loading. No scripts, dependency resolvers, or preparation hooks run during installation. The installer records the pinned file list and refuses to replace existing destinations. Removal verifies that record and all files, then moves the bundle to uniquely allocated recovery storage outside the scanned root.

The [agent opt-in decision](2026-09-06-desktop-local-agent-opt-ins.md) still owns SDK/ACP activation and next-launch preferences. The [profile bundle decision](../../archived/simplification/2026-08-09-remove-repository-plugin.md) still owns executable third-party Plugin installation. A directory of text instructions is not a Cordis Plugin or profile patch; this installer does not recreate repository-plugin wrappers or preparation executables.

Windows publication uses `MoveFileExW` without replacement or cross-volume copy flags. Canonical parent paths preserve long-path support. Rust's `fs::rename` can replace empty directories on Windows filesystems that support `FileRenameInfoEx`, so it cannot enforce the installer's no-replacement rule. The occupied-directory regression and simultaneous publishers exercise the native operation rather than a preflight existence check. See the [Win32 move options](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw).

## Alternatives considered

**Download moving branch heads or accept arbitrary repositories.** Rejected because the inspected instructions could differ from the installed content, and undeclared resources or executable dependencies would bypass the curated scope.

**Write directly into the live Skill directory.** Rejected because discovery could observe a partial bundle. Ordinary filesystem rename is also insufficient because it can replace an existing empty directory; publication must reject any occupied destination.

**Delete installed directories recursively.** Rejected because local edits and unrelated files belong to the user. Verification refuses changed bundles, and recovery storage makes ordinary removal reversible by the user.

## Consequences

The catalog is offline and versioned with the desktop app; review and installation require GitHub access. The source Skill and license remain unchanged. A hash proves identity, not safety: loaded instructions can influence tool use, and same-user hostile filesystem races are not an OS isolation guarantee. Existing conversation history remains intact after removal. New sessions provide the reliable discovery acceptance path; UI status reports verified installation, not model invocation.

Rust tests exercise integrity rejection, occupied destinations, modified and extra files, linked roots, non-replacing concurrent publication, and recoverable removal. Bilingual browser expectations cover review consent, failed installs, retry, and removal confirmation. A keyless packaged-profile lifecycle checks discovery before installation, loading after installation, and absence after removal; an explicit network smoke checks the real pinned download and its loading. Real-model behavior, native Windows execution, arbitrary bundles, remote catalog refresh, updates, one-click recovery, and recovery-storage purging remain outside this implementation.
