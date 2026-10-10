#!/usr/bin/env python3
"""Cancellable advisory locks; Windows contenders poll the agreed byte-0 range.

Holder JSON starts at byte 1 so Windows contenders can read it while byte 0 is
locked. Busy requests preserve BlockingIOError compatibility; other OS errors
propagate unchanged.
"""

from __future__ import annotations

import errno
import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from time import monotonic
from typing import IO

from cancellation import check_cancelled, wait

try:  # POSIX
    import fcntl

    _HAVE_FCNTL = True
except ModuleNotFoundError:  # Windows
    fcntl = None  # type: ignore[assignment]
    _HAVE_FCNTL = False

try:  # Windows
    import msvcrt

    _HAVE_MSVCRT = True
except ModuleNotFoundError:  # POSIX
    msvcrt = None  # type: ignore[assignment]
    _HAVE_MSVCRT = False


_CONTENTION_ERRNOS = frozenset(
    code for code in (errno.EACCES, errno.EAGAIN, getattr(errno, "EDEADLOCK", None), getattr(errno, "EDEADLK", None))
    if code is not None
)


class AlreadyLocked(BlockingIOError):
    """Raised when a non-blocking lock request finds the file already held."""


class ModuleBusy(AlreadyLocked):
    """A lock miss or timeout, with the holder's module and operation when available."""

    def __init__(self, module: str, operation: str) -> None:
        self.module = module
        self.operation = operation
        super().__init__(f"Module {module} is busy: {operation}; wait for it to finish")


def _busy(handle: IO[str]) -> ModuleBusy:
    handle.seek(1)
    try:
        metadata = json.loads(handle.read())
    except (ValueError, UnicodeError):
        metadata = {}
    if not isinstance(metadata, dict):
        metadata = {}
    return ModuleBusy(str(metadata.get("module", Path(str(handle.name)).stem)),
                      str(metadata.get("operation", "a running job")))


def write_lock_metadata(handle: IO[str], *, module: str, operation: str) -> None:
    """Publish holder diagnostics after the locked byte; callers must own the lock."""
    handle.seek(0)
    handle.truncate()
    handle.write(" " + json.dumps({"module": module, "operation": operation, "pid": os.getpid()}, ensure_ascii=False))
    handle.flush()


def lock_file(handle: IO[str], *, blocking: bool = True, timeout: float | None = None) -> None:
    """Acquire exclusively, waiting cancellably unless non-blocking or timeout expires.

    Timeout is measured in seconds. A miss raises ModuleBusy (an AlreadyLocked);
    closing the handle releases the lock. POSIX retains whole-file flock locks.
    """
    if timeout is not None and timeout < 0:
        raise ValueError("Lock timeout must be non-negative")
    deadline = None if timeout is None else monotonic() + timeout
    while True:
        check_cancelled()
        try:
            if _HAVE_FCNTL:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            elif _HAVE_MSVCRT:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)  # type: ignore[attr-defined]  # Windows CRT only
            else:
                raise RuntimeError("No file locking primitive is available on this platform")
            return
        except OSError as error:
            # CRT LK_NBLCK reports contention as EACCES (EDEADLOCK on some CRTs); flock may use EAGAIN.
            if error.errno not in _CONTENTION_ERRNOS:
                raise
            if not blocking or (deadline is not None and monotonic() >= deadline):
                raise _busy(handle) from error
        wait(.05 if deadline is None else min(.05, max(0, deadline - monotonic())))


@contextmanager
def exclusive_file_lock(
    lock_path: Path | str, *, blocking: bool = True, timeout: float | None = None,
    module: str | None = None, operation: str | None = None
) -> Iterator[IO[str]]:
    """Open ``lock_path`` and hold an exclusive lock on it for the block.

    Timeout is in seconds; waits honor request cancellation. Optional module
    and operation fields publish holder diagnostics. Custom JSON writers must
    reserve byte 0 and write metadata from byte 1. Yields the owned handle.
    """
    path = Path(lock_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+", encoding="utf-8") as handle:
        lock_file(handle, blocking=blocking, timeout=timeout)
        if operation is not None:
            write_lock_metadata(handle, module=module or path.stem, operation=operation)
        yield handle


__all__ = [
    "AlreadyLocked",
    "ModuleBusy",
    "write_lock_metadata",
    "exclusive_file_lock",
    "lock_file",
]
