# Agent Note: Cancellable Windows engine lock waits

Status: implemented

## Problem

An installed Windows engine reported exiting with `[Launcher Error] [Errno 36] Resource deadlock avoided` when a concurrent operation holds its lock through OCR or indexing. CRT `LK_LOCK` has a bounded retry interval, unlike an indefinite POSIX `flock(LOCK_EX)` wait. Treating every Windows locking OSError as contention also hides descriptor and other system failures. Exam extraction occupies the lecture-registry lock while running slow external tools.

## Decision

The engine acquires the Windows byte-0 range with repeated `LK_NBLCK` attempts separated by `cancellation.wait(.05)`. POSIX retains whole-file `flock` exclusivity and uses non-blocking attempts for cancellable waits. Both lock helpers accept an optional timeout in seconds. Leaving a lock block unlocks explicitly before the handle closes, because Windows releases a CRT byte lock on close only when system resources allow, and a contender could still find it held. Non-blocking misses and expired waits raise `ModuleBusy`, preserving `AlreadyLocked` and `BlockingIOError` compatibility; unrelated locking OSErrors propagate. Trash removal names module paths after resolving both the module root and the recorded path, because Windows can spell one directory with an 8.3 short name (`RUNNER~1`) on one side and the long name on the other.

Holder JSON starts after a reserved space at byte 0 so Windows contenders can read diagnostics without touching the locked range. Activity, preparation and index holders record `module`, `operation`, and `pid`; lecture holders retain `lecture_key` and `title` too. The launcher prints `Module <module> is busy: <operation>; wait for it to finish`. Removal keeps its existing ModuleConfigError interface while preserving the holder message. Cancellation releases activity handles before deleting lease files, without requiring a further cancellable gate acquisition.

Preparation serializes each paper with a separate lock and keeps its module activity lease throughout extraction. Registry-protected setup and publication surround extraction performed outside that registry lock. Publication rechecks the source hash and the paper's preparation record, reloads the whole state to preserve unrelated writers, and refuses a newly occupied student-text destination. Changed or removed source files require retry rather than receiving stale OCR text.

Desktop editing already forwards cancellation and deadlines through `runMcpTool` to the shared subprocess provider. Its Windows ordinary-process owner uses a kill-on-close Job Object, with a process-tree taskkill fallback. This change adds no independent killer. The [reversible-removals decision](../feature/2026-10-03-reversible-removals-and-fixed-library.md) continues to own module admission and removal semantics; this note owns wait behavior and holder diagnostics.

## Alternatives considered

**Use LockFileEx with a blocking native wait.** Polling the existing CRT primitive avoids a separate native ABI and lets the existing cancellation module interrupt waits and enforce deadlines directly.

**Keep LK_LOCK and translate its final errno.** A clearer error still rejects an operation whose holder legitimately needs more than ten seconds.

**Keep the registry locked during OCR.** This excludes unrelated registry work for the duration of external extraction. Per-paper serialization plus source and record revalidation preserves publication safety with shorter registry occupancy.

**Add a desktop process killer.** The shared subprocess owner already terminates the Windows process range; another killer would duplicate lifecycle ownership.

## Consequences

Contended locks can wait indefinitely by default, with cancellation checked between attempts and optional caller deadlines. Polling adds small periodic wakeups. Holder labels are diagnostics, not proof that a PID remains alive; OS locks remain the activity authority. Source mutation during extraction is visible as a retryable preparation error, and completed results for other papers remain in the reloaded state.

Process-based regressions cover a single 15-second holder, timeout and immediate-miss labels, prompt cancellation, system-error propagation, registry acquisition from a separate process during extraction, removal exclusion, source replacement, newly occupied output files, and cancellation cleanup. An owner-local expected-output file pins launcher busy text. Windows CI uses Python 3.12, installs engine requirements, and runs lock, preparation and module activity cases with `TRANSCRIBER_AGY=off`; Ubuntu is unchanged. Native Windows waits and installed-desktop child-tree cancellation still require Windows verification.
