#!/usr/bin/env python3
"""Structured NDJSON progress events, for callers that are programs.

Normal pipeline output is Egyptian Arabic prose meant for a person watching a
terminal. A desktop UI cannot drive a progress bar from that, so
``--json-events`` turns stdout into one JSON object per line and moves the
Arabic to stderr. Both streams stay live: the UI reads events while the user
can still be shown the human log.

The shape deliberately mirrors what the Antigravity CLI already emits for its
own headless mode -- ``init`` at the start of an attempt, a ``phase`` line per
state change, and a final ``result`` -- because that shape was measured against
a real UI's needs and found sufficient. Reusing it means one parser in the app
covers both the engine and the agent.

Before a run directory exists there is no sink, so instrumentation can sit on
hot paths without an opt-out. Every run attaches a file sink; ``--json-events``
adds the stdout sink for callers that want a live process stream.

Thread safety is not optional here. The five phases run concurrently in
threads (``_run_checkpointed_phases``), so two phases changing state at the
same instant would otherwise interleave half-written lines and hand the UI
malformed JSON.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO

# The one writer. ``None`` means no event sink has been attached yet.
_EMITTER: _Emitter | None = None


@dataclass
class _Sink:
    stream: TextIO
    file_path: Path | None = None


def _warn_file_failure(path: Path, error: Exception) -> None:
    try:
        print(f"[Events] File mirror disabled for {path}: {error}", file=sys.stderr)
    except Exception:
        # A broken stderr must not turn an observability failure into a run failure.
        pass


def _close_file_sink(sink: _Sink) -> None:
    try:
        sink.stream.close()
    except Exception as error:
        if sink.file_path is not None:
            _warn_file_failure(sink.file_path, error)


class _Emitter:
    """Serializes one event per line onto every attached sink."""

    def __init__(self, stream: TextIO | None = None) -> None:
        self._sinks: list[_Sink] = []
        self._lock = threading.Lock()
        if stream is not None:
            self._sinks.append(_Sink(stream))

    def attach_stream(self, stream: TextIO) -> None:
        with self._lock:
            if any(sink.file_path is None for sink in self._sinks):
                return
            self._sinks.append(_Sink(stream))

    def attach_file(self, stream: TextIO, path: Path) -> None:
        replaced_sink: _Sink | None = None
        with self._lock:
            for sink in self._sinks:
                if sink.file_path is not None:
                    replaced_sink = sink
                    self._sinks.remove(sink)
                    break
            self._sinks.append(_Sink(stream, path))
        if replaced_sink is not None:
            _close_file_sink(replaced_sink)

    def has_file(self, path: Path) -> bool:
        with self._lock:
            return any(sink.file_path == path for sink in self._sinks)

    def has_stream(self) -> bool:
        with self._lock:
            return any(sink.file_path is None for sink in self._sinks)

    def has_sinks(self) -> bool:
        with self._lock:
            return bool(self._sinks)

    def close_file(self) -> None:
        with self._lock:
            file_sinks = [sink for sink in self._sinks if sink.file_path is not None]
            self._sinks = [sink for sink in self._sinks if sink.file_path is None]
        for sink in file_sinks:
            _close_file_sink(sink)

    def _write_sink(self, sink: _Sink, line: str) -> None:
        try:
            sink.stream.write(line)
            sink.stream.flush()
        except Exception as error:
            if sink.file_path is None:
                raise
            # The file is only a mirror; remove a dead handle and preserve the run.
            self._sinks.remove(sink)
            _warn_file_failure(sink.file_path, error)
            _close_file_sink(sink)

    def emit(self, event: str, **fields: Any) -> None:
        # ``event`` leads so a reader can dispatch on the first key without
        # parsing the whole object.
        payload: dict[str, Any] = {"event": event}
        payload.update(fields)
        # ensure_ascii=False keeps Arabic readable in the stream rather than
        # exploding every letter into a \uXXXX escape.
        line = json.dumps(payload, ensure_ascii=False, default=str)
        with self._lock:
            for sink in tuple(self._sinks):
                self._write_sink(sink, line + "\n")


def enable(stream: TextIO | None = None) -> None:
    """Add ``stream`` (default stdout) and move human output to stderr.

    The redirection is the whole trick: rebinding ``sys.stdout`` to stderr
    means the several hundred existing ``print()`` calls move off the event
    stream without being touched. Only this module keeps a reference to the
    real stdout, so nothing else can contaminate the NDJSON.
    """
    global _EMITTER
    if _EMITTER is not None and _EMITTER.has_stream():
        return
    target = stream if stream is not None else sys.stdout
    # Windows text mode turns "\n" into "\r\n", which is legal NDJSON but
    # leaves a stray \r on every parsed line. Ask for Unix endings; a stream
    # that refuses is handled by the reader stripping \r anyway.
    reconfigure = getattr(target, "reconfigure", None)
    if reconfigure:
        try:
            reconfigure(newline="\n")
        except (ValueError, OSError):
            pass
    if stream is None:
        sys.stdout = sys.stderr
    if _EMITTER is None:
        _EMITTER = _Emitter(target)
    else:
        _EMITTER.attach_stream(target)


def attach_file(run_dir: Path) -> None:
    """Attach ``events.ndjson`` in ``run_dir`` without making it required."""
    global _EMITTER
    path = Path(run_dir) / "events.ndjson"
    emitter = _EMITTER
    if emitter is not None and emitter.has_file(path):
        return
    try:
        stream = path.open("a", encoding="utf-8", newline="\n")
    except OSError as error:
        _warn_file_failure(path, error)
        return
    if emitter is None:
        emitter = _Emitter()
        _EMITTER = emitter
    emitter.attach_file(stream, path)


def disable() -> None:
    """Stop emitting and close any attached file mirror."""
    global _EMITTER
    emitter = _EMITTER
    _EMITTER = None
    if emitter is not None:
        emitter.close_file()


def close_file() -> None:
    """Close the file mirror while leaving an optional stdout sink attached."""
    global _EMITTER
    emitter = _EMITTER
    if emitter is None:
        return
    emitter.close_file()
    if not emitter.has_sinks():
        _EMITTER = None


def is_enabled() -> bool:
    """Return whether at least one event sink is attached."""
    emitter = _EMITTER
    return emitter is not None and emitter.has_sinks()


def emit(event: str, **fields: Any) -> None:
    """Emit one event, or do nothing when events are off."""
    emitter = _EMITTER
    if emitter is None:
        return
    emitter.emit(event, **fields)


def emit_init(**fields: Any) -> None:
    """Announce the run: what is about to happen, and the phases to expect."""
    emit("init", **fields)


def emit_phase(phase: str, state: str, **fields: Any) -> None:
    """Report a phase state change.

    ``state`` is the engine's own checkpoint vocabulary -- running, validated,
    failed, repaired -- plus ``reused`` for a phase a resumed run skipped.
    Passing it through rather than mapping it to a private set of names keeps
    the event stream honest about what the checkpoint file says.
    """
    emit("phase", phase=phase, state=state, **fields)


def emit_result(status: str, **fields: Any) -> None:
    """Emit the terminal event. Exactly one per run."""
    emit("result", status=status, **fields)


class PhaseTimer:
    """Times a phase so DONE events can carry a duration.

    Started phases are tracked by name, which is safe because a phase runs at
    most once per run -- a retry goes through a fresh run directory.
    """

    def __init__(self) -> None:
        self._started: dict[str, float] = {}
        self._lock = threading.Lock()

    def start(self, phase: str) -> None:
        with self._lock:
            self._started[phase] = time.monotonic()

    def elapsed(self, phase: str) -> float | None:
        """Seconds since ``start``, or None if this phase was never started."""
        with self._lock:
            began = self._started.get(phase)
        if began is None:
            return None
        return round(time.monotonic() - began, 3)


PHASE_TIMER = PhaseTimer()


__all__ = [
    "PHASE_TIMER",
    "PhaseTimer",
    "attach_file",
    "close_file",
    "disable",
    "emit",
    "emit_init",
    "emit_phase",
    "emit_result",
    "enable",
    "is_enabled",
]
