"""Request-scoped cancellation and owned subprocess-tree cleanup for MCP work."""

from __future__ import annotations

import os
import signal
import subprocess
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from threading import Event
from time import monotonic
from typing import Any

_DEADLINE: ContextVar[float | None] = ContextVar("engine_deadline", default=None)


_CURRENT: ContextVar[Event | None] = ContextVar("engine_cancellation", default=None)


class OperationDeadlineExceeded(TimeoutError):
    """The owned effort budget elapsed; staged work remains available for salvage."""


@contextmanager
def deadline_scope(seconds: float) -> Iterator[None]:
    """Bound nested subprocesses and checkpoints without changing request cancellation."""
    previous = _DEADLINE.get()
    until = monotonic() + max(0, seconds)
    token = _DEADLINE.set(min(previous, until) if previous is not None else until)
    try:
        yield
    finally:
        _DEADLINE.reset(token)


def wait(seconds: float) -> None:
    """Back off in cancellable slices, including while no subprocess is running."""
    from time import sleep

    until = monotonic() + seconds
    while monotonic() < until:
        check_cancelled()
        event = _CURRENT.get()
        delay = min(.1, max(0, until - monotonic()))
        if event is not None:
            event.wait(delay)
        else:
            sleep(delay)
    check_cancelled()


class OperationCancelled(BaseException):
    """Stop work through optional-repair exception handlers without treating it as failure."""


def check_cancelled() -> None:
    """Raise when the owning MCP request has been cancelled."""
    event = _CURRENT.get()
    if event is not None and event.is_set():
        raise OperationCancelled("Engine request cancelled; staged parts retained.")
    deadline = _DEADLINE.get()
    if deadline is not None and monotonic() >= deadline:
        raise OperationDeadlineExceeded("Lecture repair budget exhausted")


@contextmanager
def request_scope(event: Event) -> Iterator[None]:
    """Bind one worker's cancellation event without leaking it into the next request."""
    token = _CURRENT.set(event)
    try:
        check_cancelled()
        yield
    finally:
        _CURRENT.reset(token)


def _kill_group(process: subprocess.Popen[Any], sig: int) -> None:
    try:
        os.killpg(process.pid, sig)
    except ProcessLookupError:
        # The owned process group has already exited.
        pass


def _terminate_tree(process: subprocess.Popen[Any]) -> None:
    """Terminate descendants and reap the owned child before its temporary files close."""
    if os.name == "nt":
        taskkill = os.path.join(os.environ.get("SYSTEMROOT", r"C:\Windows"), "System32", "taskkill.exe")
        subprocess.run([taskkill, "/PID", str(process.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        if process.poll() is None:
            process.kill()
        process.communicate()
        return
    _kill_group(process, signal.SIGTERM)
    try:
        process.communicate(timeout=.3)
    except subprocess.TimeoutExpired:
        # A descendant may hold a pipe open or ignore SIGTERM.
        pass
    finally:
        _kill_group(process, signal.SIGKILL)
    process.communicate()


def run(command: list[str], *, timeout: float, **options: Any) -> subprocess.CompletedProcess[Any]:
    """Run with subprocess.run semantics; cancellable requests own an isolated process tree.

    CLI callers without a request scope retain ordinary subprocess behavior.
    Captured pipes drain through communicate, including while polling cancellation.
    """
    deadline_at = _DEADLINE.get()
    if deadline_at is not None:
        timeout = min(timeout, max(.001, deadline_at - monotonic()))
    if _CURRENT.get() is None and deadline_at is None:
        return subprocess.run(command, timeout=timeout, **options)
    check_cancelled()
    check = options.pop("check", False)
    if options.pop("capture_output", False):
        options.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    options.setdefault("stdin", subprocess.DEVNULL)
    if os.name == "nt":
        options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]  # Windows-only constant
    else:
        options["start_new_session"] = True
    deadline = monotonic() + timeout
    with subprocess.Popen(command, **options) as process:
        try:
            while True:
                check_cancelled()
                remaining = deadline - monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(command, timeout)
                try:
                    stdout, stderr = process.communicate(timeout=min(.1, remaining))
                except subprocess.TimeoutExpired:
                    continue
                check_cancelled()
                completed = subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
                if check:
                    completed.check_returncode()
                return completed
        except BaseException:
            # Cancellation, deadlines and unexpected failures all release this owned tree.
            _terminate_tree(process)
            raise
