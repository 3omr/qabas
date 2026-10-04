"""Bounded lecture recovery without exposing repairable errors to the student."""

from __future__ import annotations

import json
import re
from hashlib import sha256
from pathlib import Path
from time import monotonic, time
from typing import Any

import agy_writer
import cancellation
from pipeline_errors import interruption, retry_delay
from pipeline_repair import (
    affected_parts,
    omit_support,
    recording_fallback,
    salvage,
    self_repair,
    split_write,
)

SLIDE_PICTURES_UNAVAILABLE = "Slide pictures could not be prepared; the transcript has none."


class _HandOff(Exception):
    """The remaining finding needs the bounded chat writer before final salvage."""


class _Stopped(Exception):
    def __init__(self, outcome: dict[str, Any]):
        self.outcome = outcome


def run_lecture_pipeline(arguments: dict[str, Any], workspace: Path) -> str:
    """Compose engine tools, bounded repairs, one chat handoff and validated salvage.

    Offline, exhausted daily/account quota, sign-in and absent recordings stop
    resumably. Other failures remain internal; original parts survive repair
    archival. No draft text appears in outcomes or chat handoffs.
    """
    import mcp_server as tools
    from file_lock import AlreadyLocked, exclusive_file_lock

    if arguments.get("confirmed") is not True:
        raise tools.ToolError(tools.CONFIRMATION_REQUIRED)
    if arguments.get("mode", "transcribe") not in {"transcribe", "redo", "continue"}:
        raise tools.ToolError("mode must be transcribe, redo or continue.")
    module = tools._registry_module(arguments, workspace)
    title = str(arguments.get("lecture", "")).strip().casefold()
    lease = module.paths.root / ".transcriber-cache" / "locks" / ("pipeline-" + sha256(title.encode()).hexdigest() + ".lock")
    try:
        with exclusive_file_lock(lease, blocking=False):
            return json.dumps(_run_pipeline(arguments, workspace), ensure_ascii=False)
    except AlreadyLocked:
        return json.dumps({"status": "completed", "note": "This lecture is already running in another job; that job retains its work."})


def _run_pipeline(arguments: dict[str, Any], workspace: Path) -> dict[str, Any]:
    import mcp_server as tools

    mode = arguments.get("mode", "transcribe")
    report = arguments.get("_report_progress")
    max_rounds = int(arguments.get("_pipeline_repair_rounds", 6))
    base_delay = float(arguments.get("_pipeline_retry_delay", 2))
    seconds = max(.001, float(arguments.get("_pipeline_budget_seconds", 10800)))
    deadline = monotonic() + seconds
    reserve = min(120, seconds / 10)
    recovery_until = deadline - reserve
    rounds = 0
    step = "begin_lecture"
    findings = ""
    notes: list[str] = []
    request = {**arguments, "confirmed": True, "_pipeline_run": True}
    resume: dict[str, str] | None = None

    def progress(name: str, done: int = 0, total: int = 1, message: str = "") -> None:
        nonlocal step
        step = name
        cancellation.check_cancelled()
        if report:
            report(done, total, name + ":" + (" " + message if message else ""))

    def check_stop(detail: str) -> None:
        stopped = interruption(detail)
        if stopped:
            raise _Stopped({"status": "stopped", "step": step, "kind": stopped.kind,
                            "reason": stopped.reason,
                            **({"reset_at": stopped.reset_at} if stopped.reset_at else {}),
                            **({"resume": resume} if resume else {})})

    def call(name: str, fields: dict[str, Any], *, final: bool = False) -> str:
        progress(name)
        remaining = (deadline if final else recovery_until) - monotonic()
        with cancellation.deadline_scope(remaining):
            output: str = getattr(tools, "_" + name)({
                **fields, "_report_progress": lambda done, total, message: progress(name, done, total, message),
            }, workspace)
        cancellation.check_cancelled()
        try:
            payload = json.loads(output)
        except ValueError:
            notes.extend(line for line in output.splitlines() if line.startswith(("[SOURCE-WARNING]", "[WARNING]")))
        else:
            if isinstance(payload, dict) and payload.get("warning"):
                notes.append(str(payload["warning"]))
            if name == "begin_lecture" and payload.get("figures", {}).get("status") == "error":
                context = tools._resolve_draft_context({**fields, "module": payload["module"],
                                                       "manifest_path": payload["manifest_path"]}, workspace)
                omit_support(context, "figures", str(payload["figures"]["error"])[:300])
                notes.append(SLIDE_PICTURES_UNAVAILABLE)
        progress(name, 1)
        return output

    def attempt(name: str, fields: dict[str, Any]) -> str:
        nonlocal rounds, findings
        while True:
            try:
                output = call(name, fields)
                if name == "begin_lecture":
                    payload = json.loads(output)
                    if payload.get("status") == "needs_upload":
                        reason = payload.get("reason", "recordings still processing")
                        check_stop(reason)
                        raise tools.ToolError(reason)
                return output
            except _Stopped:
                raise
            except Exception as error:
                # The recovery boundary owns unexpected step failures as well as refusals;
                # request cancellation derives from BaseException and passes through.
                findings = str(error)
                check_stop(findings)
                if name == "begin_lecture" and "no unique recording lecture matched" in findings:
                    listing = json.loads(tools._list_lectures({**fields, "refresh": True}, workspace))
                    check_stop(str(listing.get("warning", "")))
                    if not tools._lecture_matches(listing["lectures"], str(fields.get("lecture", ""))):
                        check_stop("recording for the selected lecture is missing")
                if rounds >= max_rounds or monotonic() >= recovery_until:
                    raise _HandOff(findings) from error
                rounds += 1
                progress(name, message="Repairing lecture inputs")
                transient = re.search(r"\b(?:429|5\d\d)\b|RESOURCE_EXHAUSTED|rate.?limit|per[_ -]?minute|requestsperminute|overload|high demand|timed? ?out|timeout|truncat|invalid JSON|empty response|still processing", findings, re.I)
                if transient:
                    delay = min(retry_delay(findings, rounds - 1, base_delay), max(0, recovery_until - monotonic()))
                    cancellation.wait(delay)
                    notes.append("A temporary provider error was retried.")
                    continue
                if name == "begin_lecture":
                    fields = {**fields, "refresh": True}
                    continue
                context = tools._resolve_draft_context(request, workspace)
                if rounds == 1 and self_repair(request, workspace):
                    notes.append("Draft structure was repaired automatically.")
                    continue
                if "figure" in findings.casefold():
                    if "missing slide link" in findings and tools._cached_figures(context) is not None:
                        parts = affected_parts(findings)
                        if parts and rounds <= 3:
                            call("write_parts_with_agy", {**request, "parts": parts, "_repair_findings": findings[:8000]})
                            notes.append("Guide parts with missing figures were repaired.")
                        continue
                    try:
                        call("extract_figures", {**request, "lecture": context.title})
                    except (tools.ToolError, OSError, ValueError) as extraction:
                        check_stop(str(extraction))
                        omit_support(context, "figures", str(extraction)[:300])
                        omit_support(context, "web_figures", str(extraction)[:300])
                        notes.append(SLIDE_PICTURES_UNAVAILABLE)
                    # Review refreshes extracted inputs and resolves placeholders again.
                    if name != "apply_review":
                        call("apply_review", {**request, "from_parts": True})
                    continue
                parts = affected_parts(findings)
                if parts and rounds <= 3:
                    writing = {**request, "parts": parts, "_repair_findings": findings[:8000]}
                    try:
                        if rounds < 3:
                            call("write_parts_with_agy", writing)
                            notes.append("Affected lecture parts were rewritten.")
                        else:
                            progress("write_parts_with_agy", message="Writing smaller source pieces")
                            with cancellation.deadline_scope(recovery_until - monotonic()):
                                split_write({**writing, "_report_progress": lambda done, total, message: progress(
                                    "write_parts_with_agy", done, total, message)}, workspace, parts, findings)
                            notes.append("An affected part was rewritten in smaller pieces.")
                    except (tools.ToolError, agy_writer.AgyWriterError, OSError, ValueError) as writing_error:
                        check_stop(str(writing_error))
                        findings = str(writing_error)
                    if name not in {"write_parts_with_agy", "apply_review"}:
                        call("apply_review", {**request, "from_parts": True})
                    continue
                if rounds <= 4:
                    try:
                        prepared = json.loads(call("begin_lecture", {**request, "redo": False, "refresh": True,
                                                                    "_pipeline_progress": progress}))
                        if prepared.get("status") == "needs_upload":
                            check_stop(str(prepared.get("reason", "")))
                            raise tools.ToolError(str(prepared.get("reason", "recordings still processing")))
                        tools._recover_staged_parts(tools._resolve_draft_context(request, workspace))
                        notes.append("Lecture sources and cached preparation were refreshed.")
                        continue
                    except _Stopped:
                        raise
                    except Exception as preparing_error:
                        check_stop(str(preparing_error))
                        findings = str(preparing_error)
                        recording_fallback(request, workspace)
                        notes.append("Retained recording-based parts remain available for repair.")
                        raise _HandOff(findings) from preparing_error
                raise _HandOff(findings) from error

    def handoff() -> dict[str, Any]:
        return {"status": "handoff", "step": step, "findings": findings[:8000],
                "deadline": int((time() + max(0, deadline - monotonic())) * 1000),
                "note": "\n".join(dict.fromkeys(notes)),
                **({"resume": resume} if resume else {})}

    def finalize(*, final: bool = False) -> dict[str, Any]:
        context = tools._resolve_draft_context(request, workspace)
        invoke = (lambda name, fields: call(name, fields, final=True)) if final else attempt
        invoke("validate_draft", {**request, "draft": str(context.path)})
        invoke("verify_provenance", {**request, "transcript": str(context.path)})
        summary = invoke("finalize", request)
        return {"status": "finalized", "paths": {"transcript": str(context.path).removesuffix(".draft.md"),
                                                  "index": str(context.path.parent / "Index.md")},
                "summary": summary, "note": "\n".join(dict.fromkeys(notes))}

    try:
        if arguments.get("resume_manifest"):
            request["manifest_path"] = arguments["resume_manifest"]
            tools._resolve_draft_context(request, workspace)
        else:
            redo = mode == "redo"
            if mode == "continue":
                module = tools._registry_module(arguments, workspace)
                cached = tools._cached_unit_manifest(module, str(arguments.get("lecture", "")))
                if cached is not None:
                    retained = tools._resolve_draft_context({**request, "manifest_path": str(cached)}, workspace)
                    payload = json.loads(cached.read_text(encoding="utf-8"))
                    redo = payload.get("redo_started") is True and (
                        retained.path.is_file() or tools._staged_total(tools._staged_draft_directory(retained)) is not None)
            begun = json.loads(attempt("begin_lecture", {**request, "redo": redo, "_pipeline_progress": progress}))
            request.update(module=begun["module"], manifest_path=begun["manifest_path"])
        resume = {"module": request["module"], "manifest_path": request["manifest_path"]}
        if arguments.get("salvage"):
            raise _HandOff("Chat repair is complete; retain only validated content")
        context = tools._resolve_draft_context(request, workspace)
        tools._recover_staged_parts(context)
        directory = tools._staged_draft_directory(context)
        total = tools._staged_total(directory)
        missing = total is not None and len(tools._staged_part_numbers(directory)) < total
        if not context.path.is_file() or missing:
            attempt("write_parts_with_agy", request)
        attempt("apply_review", {**request, "from_parts": True})
        return finalize()
    except _Stopped as stopped:
        return stopped.outcome
    except Exception as error:
        findings = str(error)
        try:
            check_stop(findings)
            if not arguments.get("salvage"):
                return handoff()
            if resume is not None:
                progress("apply_review", message="Retaining validated content")
                with cancellation.deadline_scope(max(.001, deadline - monotonic())):
                    notes.extend(salvage(request, workspace))
                return finalize(final=True)
            return {"status": "completed", "note": "No transcript could be validated; existing study files were retained."}
        except _Stopped as stopped:
            return stopped.outcome
        except Exception as salvage_error:
            try:
                check_stop(str(salvage_error))
            except _Stopped as stopped:
                return stopped.outcome
            findings = str(salvage_error)
            notes.append("A validated transcript could not be committed; all retained parts remain available for Continue.")
            return handoff()
