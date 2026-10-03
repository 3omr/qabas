#!/usr/bin/env python3
"""Drive the user's own agent CLI, whichever one they are signed into.

The editorial review is the one step of this pipeline that genuinely needs a
language model. Everything else -- conversion, OCR, NotebookLM queries,
validation -- is deterministic and stays in the engine, where it costs nothing
per run.

For that one step the model comes from a CLI the user already installed and
signed into with their own subscription: Antigravity (``agy``), Claude Code
(``claude``), Codex (``codex``), or Gemini CLI (``gemini``). Nothing here
handles a password, a token,
or a session cookie; the vendor's own binary owns authentication, and this
module only spawns it. That is the whole reason the subscription works at all
without impersonating anybody's client.

The CLIs converge on the same headless shape -- one prompt in, NDJSON
out, resume by conversation id -- so a single normalizer covers them and the
rest of the app sees one event type.

Permissions are the sharp edge. In headless mode a tool call that needs
approval is auto-denied rather than prompted for, so a run that looks like it
started will do nothing and exit clean. ``preflight`` reports exactly which
allow-rules are missing before a run is launched, and writing them is a
separate call that the UI makes only after the user agrees -- these are the
user's own global CLI settings, not ours to edit quietly.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# A live probe asks the CLI to answer a trivial prompt. That costs tokens and
# takes seconds, so it is opt-in -- mirroring the engine's own --doctor vs
# --doctor-live split.
PROBE_PROMPT = "Reply with exactly: OK"
PROBE_TIMEOUT_SECONDS = 90
SHIM_SUFFIXES = frozenset({".cmd", ".bat"})


class AgentBackendError(RuntimeError):
    """A backend could not be started, or died before producing a result."""


@dataclass(frozen=True)
class AgentEvent:
    """One normalized event, whichever CLI produced it.

    ``raw`` is kept so a caller that knows a specific CLI can reach past the
    normalization without this module having to model every vendor field.
    """

    kind: str  # init | message | tool | result | raw
    raw: dict[str, Any] = field(default_factory=dict)
    text: str = ""
    tool_name: str = ""
    state: str = ""
    status: str = ""
    conversation_id: str = ""
    usage: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class PreflightResult:
    """Whether this backend could actually run right now, and what is missing."""

    name: str
    installed: bool
    executable: str = ""
    authenticated: bool | None = None  # None when not probed live
    missing_allow_rules: tuple[str, ...] = ()
    settings_path: str = ""
    hint: str = ""

    @property
    def ready(self) -> bool:
        return (
            self.installed
            and self.authenticated is not False
            and not self.missing_allow_rules
        )


def _resolve_command(executable: str) -> list[str] | None:
    """Return the argv prefix that actually launches ``executable``.

    On Windows a Node-installed CLI is usually a ``.cmd`` shim, and Windows
    cannot execute one through CreateProcess the way it executes a real .exe.
    Those get routed through ``cmd /c``. Everything else is launched directly:
    a blanket ``shell=True`` would make every argument subject to shell
    parsing, which is how a lecture title with an ampersand turns into command
    injection.
    """
    resolved = shutil.which(executable)
    if not resolved:
        return None
    if os.name == "nt" and Path(resolved).suffix.lower() in SHIM_SUFFIXES:
        return ["cmd", "/c", resolved]
    return [resolved]


def _iter_ndjson(stream: Any) -> Iterator[dict[str, Any]]:
    """Yield one parsed object per line, tolerating noise.

    Windows text mode leaves a trailing ``\\r`` on every line, and all three
    CLIs occasionally print a plain-prose line (a warning, a login notice)
    into the stream. Neither should abort a run that is otherwise fine.
    """
    for line in stream:
        text = line.strip().strip("\r")
        if not text or not text.startswith("{"):
            continue
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            yield payload


class AgentBackend(ABC):
    """One agent CLI, reduced to: can it run, and what does it emit."""

    name: str = ""
    executable: str = ""

    @abstractmethod
    def _command(self, prompt: str, conversation_id: str | None) -> list[str]:
        """The arguments after the executable for a single headless turn."""

    @abstractmethod
    def _normalize(self, payload: dict[str, Any]) -> AgentEvent:
        """Turn one of this CLI's own events into an AgentEvent."""

    def missing_allow_rules(self, workspace: Path) -> tuple[str, ...]:
        """Allow-rules this backend needs but does not have. Empty by default."""
        return ()

    def settings_path(self) -> Path | None:
        """Where this CLI keeps the permission allow-list, if it has one."""
        return None

    def preflight(self, workspace: Path, live: bool = False) -> PreflightResult:
        command = _resolve_command(self.executable)
        if command is None:
            return PreflightResult(
                name=self.name,
                installed=False,
                hint=f"{self.executable} is not on PATH. Install it and sign in.",
            )
        settings = self.settings_path()
        result = PreflightResult(
            name=self.name,
            installed=True,
            executable=command[-1],
            missing_allow_rules=self.missing_allow_rules(workspace),
            settings_path=str(settings) if settings else "",
        )
        if not live:
            return result
        authenticated, hint = self._probe(command, workspace)
        return PreflightResult(
            name=result.name,
            installed=True,
            executable=result.executable,
            authenticated=authenticated,
            missing_allow_rules=result.missing_allow_rules,
            settings_path=result.settings_path,
            hint=hint,
        )

    def _probe(self, command: list[str], workspace: Path) -> tuple[bool, str]:
        """Ask the CLI to answer a trivial prompt, to prove the login works."""
        try:
            completed = subprocess.run(
                [*command, *self._command(PROBE_PROMPT, None)],
                cwd=str(workspace),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=PROBE_TIMEOUT_SECONDS,
            )
        except (OSError, subprocess.SubprocessError) as error:
            return False, f"{self.name} could not be run: {error}"
        combined = f"{completed.stdout}\n{completed.stderr}".lower()
        for marker in ("not logged in", "authentication required", "please run /login"):
            if marker in combined:
                return False, f"{self.name} is installed but not signed in."
        if completed.returncode != 0:
            return False, f"{self.name} exited {completed.returncode} on a trivial prompt."
        return True, ""

    def run(
        self,
        prompt: str,
        workspace: Path,
        conversation_id: str | None = None,
    ) -> Iterator[AgentEvent]:
        """Run one turn, yielding normalized events as the CLI produces them.

        Output is streamed rather than collected so a UI can show a review in
        progress. The process is always reaped: a caller that stops consuming
        partway through still gets the child terminated.
        """
        command = _resolve_command(self.executable)
        if command is None:
            raise AgentBackendError(f"{self.executable} is not on PATH")
        argv = [*command, *self._command(prompt, conversation_id)]
        try:
            process = subprocess.Popen(
                argv,
                cwd=str(workspace),
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
        except OSError as error:
            raise AgentBackendError(f"Could not start {self.name}: {error}") from error
        try:
            assert process.stdout is not None
            for payload in _iter_ndjson(process.stdout):
                yield self._normalize(payload)
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()


class AntigravityBackend(AgentBackend):
    """Google Antigravity CLI -- signed in with a Google account."""

    name = "antigravity"
    executable = "agy"

    def settings_path(self) -> Path | None:
        return Path.home() / ".gemini" / "antigravity-cli" / "settings.json"

    def _command(self, prompt: str, conversation_id: str | None) -> list[str]:
        command = ["-p", prompt, "--output-format", "stream-json"]
        if conversation_id:
            command.extend(["--conversation", conversation_id])
        # --dangerously-skip-permissions is deliberately never passed: it would
        # auto-approve every tool against a directory holding the user's own
        # study material. The allow-list below is the narrow alternative.
        return command

    def required_allow_rules(self, workspace: Path) -> tuple[str, ...]:
        """The narrowest rules that let a review run and nothing more.

        A reviewing worker reads the draft and reruns the validator. It must
        not reach `nlm`, finalize a draft, or touch Index.md -- so those are
        simply never granted, which turns the skill's written rule into one
        the CLI enforces.
        """
        launcher = "run_transcription.py"
        return (
            f"command({launcher})",
            f"write_file({workspace.name}/)",
        )

    def missing_allow_rules(self, workspace: Path) -> tuple[str, ...]:
        settings = self.settings_path()
        granted: set[str] = set()
        if settings and settings.is_file():
            try:
                payload = json.loads(settings.read_text(encoding="utf-8"))
                allow = payload.get("permissions", {}).get("allow", [])
                granted = {str(rule) for rule in allow}
            except (OSError, json.JSONDecodeError, AttributeError):
                granted = set()
        return tuple(
            rule for rule in self.required_allow_rules(workspace) if rule not in granted
        )

    def _normalize(self, payload: dict[str, Any]) -> AgentEvent:
        event = str(payload.get("event", ""))
        if event == "init":
            return AgentEvent(
                kind="init",
                raw=payload,
                conversation_id=str(payload.get("conversation_id", "")),
            )
        if event == "step_update":
            update = payload.get("step_update") or {}
            step_type = str(update.get("step_type", ""))
            kind = "tool" if step_type == "tool" else "message"
            return AgentEvent(
                kind=kind,
                raw=payload,
                tool_name=str(update.get("tool_name", "")),
                state=str(update.get("state", "")),
                conversation_id=str(update.get("conversation_id", "")),
                usage=dict(update.get("usage") or {}),
            )
        if event == "result":
            result = payload.get("result") or {}
            return AgentEvent(
                kind="result",
                raw=payload,
                text=str(result.get("response", "")),
                status=str(result.get("status", "")),
                conversation_id=str(result.get("conversation_id", "")),
                usage=dict(result.get("usage") or {}),
            )
        return AgentEvent(kind="raw", raw=payload)


class ClaudeCodeBackend(AgentBackend):
    """Claude Code -- signed in with a Claude subscription."""

    name = "claude-code"
    executable = "claude"

    def _command(self, prompt: str, conversation_id: str | None) -> list[str]:
        command = ["-p", prompt, "--output-format", "stream-json", "--verbose"]
        if conversation_id:
            command.extend(["--resume", conversation_id])
        return command

    def _normalize(self, payload: dict[str, Any]) -> AgentEvent:
        kind_field = str(payload.get("type", ""))
        session = str(payload.get("session_id", ""))
        if kind_field == "system" and payload.get("subtype") == "init":
            return AgentEvent(kind="init", raw=payload, conversation_id=session)
        if kind_field == "assistant":
            message = payload.get("message") or {}
            blocks = message.get("content") or []
            for block in blocks:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    return AgentEvent(
                        kind="tool",
                        raw=payload,
                        tool_name=str(block.get("name", "")),
                        state="ACTIVE",
                        conversation_id=session,
                    )
            text = "".join(
                str(block.get("text", ""))
                for block in blocks
                if isinstance(block, dict) and block.get("type") == "text"
            )
            return AgentEvent(
                kind="message",
                raw=payload,
                text=text,
                conversation_id=session,
                usage=dict(message.get("usage") or {}),
            )
        if kind_field == "result":
            return AgentEvent(
                kind="result",
                raw=payload,
                text=str(payload.get("result", "")),
                status="ERROR" if payload.get("is_error") else "SUCCESS",
                conversation_id=session,
                usage=dict(payload.get("usage") or {}),
            )
        return AgentEvent(kind="raw", raw=payload, conversation_id=session)


class CodexBackend(AgentBackend):
    """OpenAI Codex CLI -- signed in with a ChatGPT subscription."""

    name = "codex"
    executable = "codex"

    def _command(self, prompt: str, conversation_id: str | None) -> list[str]:
        command = ["exec", "--json"]
        if conversation_id:
            command.extend(["resume", conversation_id])
        command.append(prompt)
        return command

    def _normalize(self, payload: dict[str, Any]) -> AgentEvent:
        # Codex's JSONL is the least settled of the three, so this reads the
        # fields it reliably carries and passes anything else through as raw
        # rather than guessing at a shape that may change.
        nested = payload.get("msg")
        message: dict[str, Any] = nested if isinstance(nested, dict) else payload
        kind_field = str(message.get("type", payload.get("type", "")))
        session = str(payload.get("session_id", payload.get("conversation_id", "")))
        if "session" in kind_field or kind_field == "task_started":
            return AgentEvent(kind="init", raw=payload, conversation_id=session)
        if "command" in kind_field or "tool" in kind_field or "exec" in kind_field:
            return AgentEvent(
                kind="tool",
                raw=payload,
                tool_name=str(message.get("command", kind_field)),
                conversation_id=session,
            )
        if "message" in kind_field or "delta" in kind_field:
            return AgentEvent(
                kind="message",
                raw=payload,
                text=str(message.get("message", message.get("text", ""))),
                conversation_id=session,
            )
        if "complete" in kind_field or kind_field == "task_complete":
            return AgentEvent(
                kind="result",
                raw=payload,
                text=str(message.get("last_agent_message", "")),
                status="SUCCESS",
                conversation_id=session,
            )
        return AgentEvent(kind="raw", raw=payload, conversation_id=session)

class GeminiCliBackend(AgentBackend):
    """Gemini CLI -- signed in with a Google account, no API key.

    This is the second Google route, and it is not the same door as
    Antigravity: ``agy`` spends the Antigravity session, while ``gemini``
    signs in through ``/auth`` and spends the Gemini Code Assist quota
    attached to the same account. A user who has one is not guaranteed the
    other, which is why both appear in preflight rather than one standing in
    for the other.

    Two things differ from the other three backends, and both are deliberate:

    * There is no headless resume flag, so ``conversation_id`` is ignored and
      every turn is a fresh one. Callers already treat the id as metadata for
      the ledger rather than as something they must round-trip, so nothing
      upstream breaks -- but a review prompt must carry its own context.
    * Permissions live under a different schema (``coreTools`` /
      ``excludeTools`` / ``--approval-mode``) than the ``permissions.allow``
      list the other backends share, so ``settings_path`` stays ``None`` and
      this module never edits it. ``--approval-mode yolo`` is the analogue of
      ``--dangerously-skip-permissions`` and is never passed, for the same
      reason.
    """

    name = "gemini-cli"
    executable = "gemini"

    def _command(self, prompt: str, conversation_id: str | None) -> list[str]:
        # conversation_id is accepted for interface symmetry and dropped: no
        # flag resumes a headless Gemini turn, and inventing one would make
        # every resumed run exit on an unknown argument.
        return ["--output-format", "stream-json", "-p", prompt]

    def _normalize(self, payload: dict[str, Any]) -> AgentEvent:
        # Gemini's stream-json mirrors Claude Code's event schema, so that
        # shape is read first. A build that emits its own single
        # ``{"response": ..., "stats": ...}`` object instead still lands as a
        # result rather than as an unusable raw event.
        kind_field = str(payload.get("type", ""))
        session = str(payload.get("session_id", ""))
        if kind_field == "system" and payload.get("subtype") == "init":
            return AgentEvent(kind="init", raw=payload, conversation_id=session)
        if kind_field == "assistant":
            message = payload.get("message") or {}
            blocks = message.get("content") or []
            for block in blocks:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    return AgentEvent(
                        kind="tool",
                        raw=payload,
                        tool_name=str(block.get("name", "")),
                        state="ACTIVE",
                        conversation_id=session,
                    )
            text = "".join(
                str(block.get("text", ""))
                for block in blocks
                if isinstance(block, dict) and block.get("type") == "text"
            )
            return AgentEvent(
                kind="message",
                raw=payload,
                text=text,
                conversation_id=session,
                usage=dict(message.get("usage") or {}),
            )
        if kind_field == "result":
            return AgentEvent(
                kind="result",
                raw=payload,
                text=str(payload.get("result", "")),
                status="ERROR" if payload.get("is_error") else "SUCCESS",
                conversation_id=session,
                usage=dict(payload.get("usage") or {}),
            )
        if not kind_field and "response" in payload:
            stats = payload.get("stats")
            return AgentEvent(
                kind="result",
                raw=payload,
                text=str(payload.get("response", "")),
                status="SUCCESS",
                conversation_id=session,
                usage=dict(stats) if isinstance(stats, dict) else {},
            )
        return AgentEvent(kind="raw", raw=payload, conversation_id=session)


BACKENDS: dict[str, type[AgentBackend]] = {
    AntigravityBackend.name: AntigravityBackend,
    ClaudeCodeBackend.name: ClaudeCodeBackend,
    CodexBackend.name: CodexBackend,
    GeminiCliBackend.name: GeminiCliBackend,
}


def get_backend(name: str) -> AgentBackend:
    try:
        return BACKENDS[name]()
    except KeyError:
        known = ", ".join(sorted(BACKENDS))
        raise AgentBackendError(f"Unknown agent backend {name!r}. Known: {known}") from None


def preflight_all(workspace: Path, live: bool = False) -> list[PreflightResult]:
    """Check every backend, so a settings screen can show them all at once."""
    return [
        backend_type().preflight(workspace, live=live)
        for backend_type in BACKENDS.values()
    ]


def apply_allow_rules(backend: AgentBackend, rules: tuple[str, ...]) -> Path:
    """Add ``rules`` to the backend's allow-list. Only call this with consent.

    This edits a settings file the user owns and that their other work uses,
    so it merges into whatever is already there and never rewrites unrelated
    keys. The UI is responsible for showing the exact rules first; nothing
    here asks.
    """
    settings = backend.settings_path()
    if settings is None:
        raise AgentBackendError(f"{backend.name} has no permission settings file")
    payload: dict[str, Any] = {}
    if settings.is_file():
        try:
            loaded = json.loads(settings.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                payload = loaded
        except (OSError, json.JSONDecodeError):
            payload = {}
    permissions = payload.setdefault("permissions", {})
    if not isinstance(permissions, dict):
        permissions = {}
        payload["permissions"] = permissions
    allow = permissions.setdefault("allow", [])
    if not isinstance(allow, list):
        allow = []
        permissions["allow"] = allow
    for rule in rules:
        if rule not in allow:
            allow.append(rule)
    settings.parent.mkdir(parents=True, exist_ok=True)
    settings.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return settings


def main() -> int:
    """Report backend readiness as JSON, for the desktop app and for humans."""
    import argparse

    parser = argparse.ArgumentParser(description="Inspect the available agent CLIs")
    parser.add_argument("--workspace", default=os.getcwd())
    parser.add_argument(
        "--live",
        action="store_true",
        help="Actually run each CLI on a trivial prompt to prove the login works",
    )
    arguments = parser.parse_args()
    workspace = Path(arguments.workspace).expanduser().resolve()
    results = preflight_all(workspace, live=arguments.live)
    print(
        json.dumps(
            [
                {
                    "name": result.name,
                    "installed": result.installed,
                    "executable": result.executable,
                    "authenticated": result.authenticated,
                    "missing_allow_rules": list(result.missing_allow_rules),
                    "settings_path": result.settings_path,
                    "ready": result.ready,
                    "hint": result.hint,
                }
                for result in results
            ],
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if any(result.ready for result in results) else 1


if __name__ == "__main__":
    sys.exit(main())
