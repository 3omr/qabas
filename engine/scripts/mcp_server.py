#!/usr/bin/env python3
"""Expose the transcriber engine as MCP tools over stdio.

The desktop app's chat needs to turn "اعمل تفريغ لمحاضرة Corrosives" into a
real transcription run. MCP is the boundary that lets it: the chat model picks
a route, this server runs the deterministic engine, and no model ever has to be
trusted with the pipeline's own logic.

The same server serves any other MCP client too -- Claude Code, Codex, the
Antigravity CLI -- so the desktop app and the existing skill workflow share
one implementation instead of drifting apart.

This speaks JSON-RPC 2.0 directly rather than depending on an MCP SDK. The
protocol surface a tool server needs is small (initialize, tools/list,
tools/call, ping), and this project deliberately ships no required third-party
dependencies -- a medical student installing it should not also be installing
a protocol library.

Destructive tools are gated. ``create_module``, ``apply_sync``, ``upload_recordings``,
``apply_review`` and ``finalize`` write to the user's study material or to
their NotebookLM, so they refuse to run until the caller passes
``confirmed: true`` -- which the UI sets only after the user clicks. A chat
model can propose them; it cannot fire them on its own. ``begin_lecture`` is
the student's start action and confirms uploads for that lecture without a
second confirmation question. That start also authorizes review, checks,
repairs and finalization of the lecture, with the confirmation flags set.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import zipfile
from collections.abc import Callable
from dataclasses import dataclass, field
from math import ceil
from pathlib import Path
from time import time_ns
from typing import Any

import agy_writer
from atomic_io import _atomic_write_text
from console import configure_console_streams
from draft_recovery import (
    draft_fingerprint,
    exact_saved_parts,
    legacy_saved_parts,
    saved_boundaries,
)
from draft_segments import DEFAULT_WRITE_PART_BYTES, segment_boundaries, write_segments
from engine_dispatch import build_entrypoint_command, dispatch_entrypoint
from engines import ENGINE_NAMES, NOTEBOOKLM_RAW, TRANSCRIPTION_ENGINES
from lecture_registry import lecture_units, manual_definition, unit_hidden
from multi_recording_plan import MergedPlan, merged_plan
from phase_validation import SECTION_HEADINGS
from recording_grouping import _group_recordings, recording_identity
from recording_grouping import _part_split as _part_split
from slide_figures import SLIDE_EXTENSIONS
from slide_figures import _safe_name as _safe_figure_name
from transcript_contract import (
    DraftingHandoffContext,
    build_drafting_contract,
    neutralize_guide_question_headings,
    validate_complete_transcript,
)
from transcript_matching import (
    RECORDING_EXTENSIONS,
    final_transcripts,
    module_final_transcripts,
    recording_filename_key,
    transcript_assignments,
)
from transcript_matching import (
    _is_final_transcript as _is_final_transcript,
)
from transcript_matching import (
    _match_key as _match_key,
)
from transcript_matching import (
    _title_contains_lecture as _title_contains_lecture,
)

PROTOCOL_VERSION = "2025-06-18"
SERVER_NAME = "universal-transcriber"
SCRIPTS_DIR = Path(__file__).resolve().parent

# A draft is the long one: five NotebookLM phases over a full recording.
DRAFT_TIMEOUT_SECONDS = 3 * 60 * 60
DEFAULT_TIMEOUT_SECONDS = 15 * 60
MIN_REVIEW_LENGTH_RATIO = 0.5
MIN_VERBATIM_GUIDE_RATIO = 0.5
CHECK_AND_FINALIZE_NEXT = (
    "Call validate_draft and verify_provenance. Repair any part they name with "
    "write_parts_with_agy(parts=[...]), then apply_review(module, manifest_path, from_parts=true, confirmed=true) "
    "and repeat both checks until they pass. Then call finalize(confirmed=true). "
    "Continue automatically under the student's begin_lecture authorization."
)

CONFIRMATION_REQUIRED = (
    "This tool changes the user's study material or their NotebookLM. "
    "Re-send it with \"confirmed\": true only after the user has agreed in "
    "the interface."
)


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    properties: dict[str, Any]
    handler: Callable[[dict[str, Any], Path], str]
    required: tuple[str, ...] = ()
    requires_confirmation: bool = False

    def schema(self) -> dict[str, Any]:
        properties = dict(self.properties)
        required = list(self.required)
        if self.requires_confirmation:
            properties["confirmed"] = {
                "type": "boolean",
                "description": (
                    "Must be true, and only after the user has explicitly "
                    "approved this action in the interface."
                ),
            }
            required.append("confirmed")
        return {
            "type": "object",
            "properties": properties,
            "required": required,
        }


class ToolError(RuntimeError):
    """A tool could not complete. Reported to the client, not a crash."""


@dataclass(frozen=True)
class DraftContext:
    path: Path
    module_root: Path
    manifest_path: Path
    title: str
    emoji: str
    recording_sources: tuple[str, ...]
    verbatim_sources: tuple[Path, ...]
    slides_path: Path | None
    figure_directories: tuple[Path, ...]


@dataclass(frozen=True)
class AgyDraftContext:
    draft: DraftContext
    module_title: str
    segments: list[str]
    floor_segments: list[str]
    arguments: dict[str, Any]
    workspace: Path
    part_contexts: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class VerbatimContext:
    path: Path
    lecture: str


def _run(command: list[str], workspace: Path, timeout: int) -> str:
    """Run an engine command and return its output for the model to read.

    stderr is folded in on failure because that is where the engine's Egyptian
    Arabic explanation of what went wrong lives -- discarding it would leave
    the chat saying only "it failed".
    """
    try:
        completed = subprocess.run(
            command,
            cwd=str(workspace),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise ToolError(
            f"Timed out after {timeout}s. Resume with --resume-latest rather "
            "than starting over."
        ) from None
    except OSError as error:
        raise ToolError(f"Could not run the engine: {error}") from error
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise ToolError(f"Engine exited {completed.returncode}.\n{detail}")
    return (completed.stdout or completed.stderr or "").strip() or "Done."


def _launcher(workspace: Path, *arguments: str) -> list[str]:
    return build_entrypoint_command(
        "run-transcription",
        ("--workspace", str(workspace), "--no-update-check", *arguments),
    )


def _module(arguments: dict[str, Any]) -> str:
    module = str(arguments.get("module", "")).strip()
    if not module:
        raise ToolError("A module id is required. Call list_modules first.")
    return module


def _module_by_display_name(arguments: dict[str, Any], workspace: Path) -> dict[str, Any]:
    """The arguments with a module named by its display name given its id.

    A student says "Ophthalmology", the panel shows "Ophthalmology", and the
    model passed "Ophthalmology" -- to a tool that knew the module only as
    `ophtha`, answered "No module named", and ended a transcription before its
    first step. The CLI already resolves `--module` through the registry's
    aliases (id, display name, and module.json `aliases`), which the registry
    guarantees are unique; this is that same resolution. A name that resolves
    to nothing is passed through, so the tool's own error still names it.
    """
    from module_registry import ModuleConfigError, resolve_module

    supplied = str(arguments.get("module", "")).strip()
    if not supplied:
        return arguments
    try:
        module = resolve_module(_discovered_modules(workspace), supplied)
    except ModuleConfigError:
        return arguments
    return {**arguments, "module": module.module_id}


def _resolved_workspace(workspace: Path) -> Path:
    return workspace.expanduser().resolve()


def _assert_workspace(arguments: dict[str, Any], workspace: Path) -> None:
    if "workspace" not in arguments:
        return
    supplied = arguments["workspace"]
    if not isinstance(supplied, str) or not supplied.strip():
        raise ToolError("workspace must be a non-empty path string when supplied.")

    server_workspace = _resolved_workspace(workspace)
    asserted_workspace = Path(supplied.strip()).expanduser().resolve()
    if asserted_workspace != server_workspace:
        raise ToolError(
            "Workspace mismatch: the server serves "
            f"{server_workspace}, but the call asserted {asserted_workspace}."
        )


def _manifest_path(arguments: dict[str, Any], workspace: Path) -> Path:
    raw_path = str(arguments.get("manifest_path", "")).strip()
    if not raw_path:
        raise ToolError("manifest_path is required to identify the lecture draft.")
    candidate = Path(raw_path).expanduser()
    if not candidate.is_absolute():
        candidate = workspace / candidate
    return candidate.resolve()


def _resolve_manifest_context(
    arguments: dict[str, Any], workspace: Path, error_label: str = "lecture manifest"
) -> tuple[Any, Any, Path]:
    from module_registry import ModuleConfigError, discover_modules, resolve_module
    from run_transcription import LauncherError, _source_manifest

    manifest_path = _manifest_path(arguments, workspace)
    try:
        module = resolve_module(discover_modules(workspace), _module(arguments))
        manifest = _source_manifest(str(manifest_path))
    except (LauncherError, ModuleConfigError) as error:
        raise ToolError(f"Could not resolve the {error_label}: {error}") from error
    return module, manifest, Path(manifest.manifest_path or manifest_path)


def _normalized_source_stem(name: str) -> str:
    stem = Path(name.replace("\\", "/")).stem.casefold()
    return re.sub(r"[^a-z0-9\u0600-\u06ff]+", " ", stem).strip()


def _verbatim_source_paths(module_root: Path, recording_sources: tuple[str, ...]) -> tuple[Path, ...]:
    verbatim_dir = module_root / "Verbatim"
    available = tuple(verbatim_dir.glob("*.verbatim.md")) if verbatim_dir.is_dir() else ()
    paths: list[Path] = []
    for source in recording_sources:
        source_stem = Path(source.replace("\\", "/")).stem
        expected = verbatim_dir / f"{source_stem}.verbatim.md"
        if expected.is_file():
            paths.append(expected.resolve())
            continue
        normalized = _normalized_source_stem(source)
        matches = [
            path
            for path in available
            if _normalized_source_stem(path.name.removesuffix(".verbatim.md")) == normalized
        ]
        if len(matches) == 1:
            paths.append(matches[0].resolve())
    return tuple(paths)


# Words every deck and recording of a module shares say nothing about which
# lecture a deck belongs to, and a bare number ("food poisoning (1).pptx",
# "Heavy Metals 1") once matched the wrong deck on the digit alone. Same rule
# as run_transcription._topic_tokens.
_GENERIC_SLIDE_TOKENS = frozenset({
    "lecture", "recording", "poison", "poisons", "poisoning", "part", "boys", "girls", "dr",
})


def _slide_tokens(name: str) -> set[str]:
    return {
        token for token in re.findall(r"[a-z0-9\u0600-\u06ff]+", name.casefold())
        if len(token) >= 3 and not token.isdigit() and token not in _GENERIC_SLIDE_TOKENS
    }


def _matching_local_slide(module: Any, lecture_title: str, sources: tuple[str, ...] | None = None) -> Path | None:
    definition = manual_definition(module, lecture_title, sources)
    if definition:
        from lecture_registry import lecture_file
        return next((lecture_file(module, name).resolve() for name in definition.materials
                     if lecture_file(module, name).is_file()
                     and Path(name).suffix.casefold() in SLIDE_EXTENSIONS | {".pdf"}), None)
    lecture_dir = module.paths.lecture
    if not lecture_dir.is_dir():
        return None
    from lecture_registry import lecture_file
    consumed = {lecture_file(module, name).resolve() for entry in module.lectures for name in entry.materials}
    # A module-wide book is never one lecture's deck.
    consumed |= {lecture_file(module, name).resolve() for name in module.general_materials}
    title_tokens = _slide_tokens(lecture_title)
    candidates = [
        path
        for path in lecture_dir.iterdir()
        if path.is_file() and path.resolve() not in consumed and path.suffix.casefold() in SLIDE_EXTENSIONS | {".pdf"}
    ]
    scored = [(len(title_tokens & _slide_tokens(path.stem)), path) for path in candidates]
    best_score = max((score for score, _path in scored), default=0)
    matches = [path for score, path in scored if score == best_score and score > 0]
    return matches[0].resolve() if len(matches) == 1 else None


def _local_slide_path(module: Any, manifest: Any) -> Path | None:
    definition = manual_definition(module, manifest.title, manifest.recording_sources)
    requested = getattr(manifest, "slides", None)
    if definition and not requested:
        return None
    if requested:
        candidate = Path(requested).expanduser()
        if not candidate.is_absolute():
            candidate = module.paths.root / candidate
        if candidate.is_file():
            return candidate.resolve()
    try:
        from module_registry import ModuleConfigError, configured_slide

        configured = configured_slide(module, manifest.title)
    except ModuleConfigError:
        configured = None
    return configured or _matching_local_slide(module, manifest.title, manifest.recording_sources)


def _figure_directories(
    module_root: Path, title: str, recording_sources: tuple[str, ...]
) -> tuple[Path, ...]:
    names = [Path(source.replace("\\", "/")).stem for source in recording_sources]
    names.append(title)
    unique_names = tuple(dict.fromkeys(name for name in names if name))
    figures_root = module_root / "Transcripts" / "Figures"
    available = [path for path in figures_root.glob("*") if path.is_dir()]
    directories: list[Path] = []
    for name in unique_names:
        expected = figures_root / _safe_figure_name(name)
        matches = [
            path for path in available if path.name.casefold() == expected.name.casefold()
        ]
        directories.append(
            expected if expected.is_dir() or len(matches) != 1 else matches[0]
        )
    return tuple(dict.fromkeys(directories))


def _example_transcript_path(workspace: Path) -> Path:
    return workspace / "modules" / "toxo" / "Transcripts" / "Corrosives 🧪.md"


def _drafting_handoff(
    workspace: Path, title: str, emoji: str, recording_sources: tuple[str, ...]
) -> str:
    example_path = _example_transcript_path(workspace)
    return build_drafting_contract(
        DraftingHandoffContext(
            lecture_title=title,
            emoji=emoji,
            recording_sources=recording_sources,
            example_path=example_path,
        )
    )


def _resolve_draft_context(
    arguments: dict[str, Any], workspace: Path
) -> DraftContext:
    from universal_transcribe import _draft_path_for_lecture

    module, manifest, manifest_path = _resolve_manifest_context(
        arguments, workspace, "lecture draft"
    )
    draft_path = Path(
        _draft_path_for_lecture(
            manifest.title, module.emoji, str(module.paths.transcripts)
        )
    ).resolve()
    return DraftContext(
        path=draft_path,
        module_root=module.paths.root,
        manifest_path=manifest_path,
        title=manifest.title,
        emoji=module.emoji,
        recording_sources=manifest.recording_sources,
        verbatim_sources=_verbatim_source_paths(
            module.paths.root, manifest.recording_sources
        ),
        slides_path=_local_slide_path(module, manifest),
        figure_directories=_figure_directories(
            module.paths.root, manifest.title, manifest.recording_sources
        ),
    )


def _recording_stem(source: str) -> str:
    return Path(source.replace("\\", "/")).stem


def _verbatim_contexts(module: Any, manifest: Any) -> tuple[VerbatimContext, ...]:
    contexts: list[VerbatimContext] = []
    for source in manifest.recording_sources:
        existing = _verbatim_source_paths(module.paths.root, (source,))
        path = (
            existing[0]
            if existing
            else (
                module.paths.verbatim / f"{_recording_stem(source)}.verbatim.md"
            ).resolve()
        )
        contexts.append(VerbatimContext(path, _recording_stem(source)))
    return tuple(contexts)



def _requested_engine(arguments: dict[str, Any]) -> str:
    requested = arguments.get("engine", NOTEBOOKLM_RAW)
    if isinstance(requested, str) and requested.strip() in ENGINE_NAMES:
        return requested.strip()
    valid = ", ".join(ENGINE_NAMES)
    raise ToolError(f"Unknown engine {requested!r}. Valid engines: {valid}.")


def _read_review_draft(draft_path: Path) -> str:
    try:
        return draft_path.read_text(encoding="utf-8")
    except FileNotFoundError as error:
        raise ToolError(
            f"No draft exists at {draft_path}; run start_draft first."
        ) from error
    except (OSError, UnicodeError) as error:
        raise ToolError(f"Could not read draft {draft_path}: {error}") from error


def _review_character_count(text: str) -> int:
    return len("".join(text.split()))


def _review_length_error(original: str, revised: str) -> str | None:
    original_length = _review_character_count(original)
    revised_length = _review_character_count(revised)
    if original_length and revised_length < original_length * MIN_REVIEW_LENGTH_RATIO:
        return (
            "the revised draft is less than half the original content "
            f"({revised_length:,}/{original_length:,} non-whitespace characters); "
            "send the full revision rather than a summary"
        )
    return None


_VERBATIM_HEADER_PATTERN = re.compile(
    r"\A# Verbatim transcript —[^\r\n]*\r?\n\r?\n"
    r"> Raw [^\r\n]* speech from `[^`\r\n]+`, [^\r\n]*\. Nothing here "
    r"has been summarised or reordered\.\r?\n\r?\n"
)


def _verbatim_body(text: str) -> tuple[str, str]:
    match = _VERBATIM_HEADER_PATTERN.match(text)
    if match is None:
        return text, "whole verbatim file (header not identifiable)"
    return text[match.end() :], "verbatim body (recognized header excluded)"


def _section_body(text: str, heading: str) -> str:
    start = text.find(heading)
    if start < 0:
        return ""
    following = [
        text.find(next_heading, start + len(heading))
        for next_heading in SECTION_HEADINGS
        if next_heading != heading
    ]
    end = min((position for position in following if position >= 0), default=len(text))
    return text[start + len(heading) : end]


def _verbatim_guide_error(
    verbatim: str, revised: str, source_label: str
) -> str | None:
    verbatim_count = _review_character_count(verbatim)
    guide_count = _review_character_count(_section_body(revised, SECTION_HEADINGS[0]))
    if verbatim_count and guide_count < verbatim_count * MIN_VERBATIM_GUIDE_RATIO:
        return (
            f"the Chronological Guide has {guide_count:,} non-whitespace characters, "
            f"but {source_label} has {verbatim_count:,}; it must contain at least "
            f"{MIN_VERBATIM_GUIDE_RATIO:.0%} of the source. The Chronological Guide "
            "must carry the doctor's complete explanation, not a summary"
        )
    return None


def _preserve_rejected_review(context: DraftContext, revised: str) -> Path:
    digest = hashlib.sha256(revised.encode("utf-8")).hexdigest()[:12]
    rejected_dir = context.module_root / ".transcriber-cache" / "rejected-reviews"
    rejected_path = rejected_dir / f"{context.path.name}.{digest}.md"
    _atomic_write_text(rejected_path, revised)
    return rejected_path


def _review_size_errors(
    original: str | None,
    revised: str,
    verbatim_baseline: tuple[str, str] | None = None,
) -> list[str]:
    errors: list[str] = []
    if original is not None:
        length_error = _review_length_error(original, revised)
        if length_error is not None:
            errors.append(length_error)
    if verbatim_baseline is not None:
        verbatim_text, source_label = verbatim_baseline
        guide_error = _verbatim_guide_error(verbatim_text, revised, source_label)
        if guide_error is not None:
            errors.append(guide_error)
    return errors


def _complete_review_errors(
    original: str | None,
    revised: str,
    context: DraftContext,
    verbatim_baseline: tuple[str, str] | None = None,
) -> list[str]:
    errors = _review_size_errors(original, revised, verbatim_baseline)
    errors.extend(
        validate_complete_transcript(
            revised,
            verbatim_sources=context.verbatim_sources,
            slides_path=context.slides_path,
            figure_directories=context.figure_directories,
        )
    )
    return errors


def _review_refusal(context: DraftContext, revised: str, errors: list[str]) -> ToolError:
    try:
        preserved_path = _preserve_rejected_review(context, revised)
    except OSError as error:
        return ToolError(
            "Review refused; the draft was left unchanged, but the "
            f"rejected text could not be preserved: {error}. Findings:\n- "
            + "\n- ".join(errors)
        )
    return ToolError(
        "Review refused; the draft was left unchanged. The submitted "
        f"text was preserved at {preserved_path}. Fix every finding:\n- "
        + "\n- ".join(errors)
    )


def _conversation_id(arguments: dict[str, Any]) -> str | None:
    supplied = arguments.get("conversation_id")
    if supplied is None:
        return None
    if not isinstance(supplied, str):
        raise ToolError("conversation_id must be a string when supplied.")
    return supplied.strip() or None


def _record_review(context: DraftContext, conversation_id: str | None) -> str | None:
    """Record the review in the ledger. Returns a warning instead of raising.

    The draft is already on disk by the time this runs, and that ordering is
    deliberate: bookkeeping lost is recoverable, a revision lost is not. So a
    ledger failure must not be reported as a failed call -- a caller told
    "could not record the review" would reasonably believe its revision did
    not land, when it did.
    """
    from batch_state import BatchStateError, record_review

    try:
        record_review(
            context.module_root / ".transcriber-cache",
            context.manifest_path,
            conversation_id,
        )
    except BatchStateError as error:
        return f"The draft was saved, but the batch ledger was not updated: {error}"
    return None


STAGED_DRAFTS_DIRECTORY = "staged-drafts"
STAGED_PARTS_TOTAL_FILE = "parts.txt"
STAGED_ALIGNMENT_FILE = "guide-alignment.txt"
STAGED_LAYOUT_FILE = "layout.json"


def _staged_draft_directory(context: DraftContext) -> Path:
    return (
        context.module_root
        / ".transcriber-cache"
        / STAGED_DRAFTS_DIRECTORY
        / context.path.name
    )


def _staged_part_path(context: DraftContext, part: int) -> Path:
    return _staged_draft_directory(context) / f"part-{part}.md"


def _staged_total(directory: Path) -> int | None:
    total_path = directory / STAGED_PARTS_TOTAL_FILE
    try:
        raw_total = total_path.read_text(encoding="ascii")
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError) as error:
        raise ToolError(f"Could not read staged draft metadata {total_path}: {error}") from error
    try:
        total = int(raw_total.strip())
    except ValueError as error:
        raise ToolError(f"Staged draft metadata is invalid: {total_path}") from error
    if total < 1:
        raise ToolError(f"Staged draft metadata is invalid: {total_path}")
    return total


def _staged_part_numbers(directory: Path) -> list[int]:
    if not directory.is_dir():
        return []
    numbers: list[int] = []
    for path in directory.glob("part-*.md"):
        match = re.fullmatch(r"part-(\d+)\.md", path.name)
        if match is not None and path.is_file():
            numbers.append(int(match.group(1)))
    return sorted(set(numbers))


def _positive_part_argument(arguments: dict[str, Any], name: str) -> int:
    value = arguments.get(name)
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ToolError(f"{name} must be an integer of at least 1.")
    return value


def _continuation_guide_text(part: int, content: str) -> str:
    if part == 1:
        return content
    return re.sub(r"\A(?:\s*" + re.escape(SECTION_HEADINGS[0]) + r"[ \t]*(?:\r?\n|$))+", "", content)


def _read_staged_draft(context: DraftContext) -> str:
    _recover_staged_parts(context)
    directory = _staged_draft_directory(context)
    total = _staged_total(directory)
    if total is None:
        raise ToolError(
            "No staged draft parts exist for this lecture; call "
            "stage_draft_part first."
        )
    received = _staged_part_numbers(directory)
    missing = [part for part in range(1, total + 1) if part not in received]
    if missing:
        missing_numbers = ", ".join(str(part) for part in missing)
        raise ToolError(f"Missing staged draft parts: {missing_numbers}.")
    try:
        return "".join(
            _continuation_guide_text(part, _staged_part_path(context, part).read_text(encoding="utf-8"))
            for part in range(1, total + 1)
        )
    except (OSError, UnicodeError) as error:
        raise ToolError(f"Could not read staged draft parts: {error}") from error


def _clear_staged_draft(context: DraftContext) -> None:
    directory = _staged_draft_directory(context)
    for path in directory.glob("part-*.md"):
        path.unlink()
    (directory / STAGED_PARTS_TOTAL_FILE).unlink(missing_ok=True)
    (directory / STAGED_ALIGNMENT_FILE).unlink(missing_ok=True)
    (directory / STAGED_LAYOUT_FILE).unlink(missing_ok=True)
    try:
        directory.rmdir()
    except FileNotFoundError:
        pass


def _read_verbatim_baseline(paths: tuple[Path, ...]) -> tuple[str, str] | None:
    if not paths:
        return None
    bodies = [_verbatim_body(_read_review_draft(path)) for path in paths]
    body, label = max(bodies, key=lambda source: _review_character_count(source[0]))
    if len(paths) > 1:
        label = f"longest single recording's {label}"
    return body, label


def _stage_part_inputs(arguments: dict[str, Any]) -> tuple[int, int, str, int]:
    part = _positive_part_argument(arguments, "part")
    total = _positive_part_argument(arguments, "parts")
    if part > total:
        raise ToolError(f"part {part} cannot be greater than parts {total}.")
    content = arguments.get("content")
    if not isinstance(content, str) or not content.strip():
        raise ToolError("content must be non-empty staged draft text.")
    part_bytes = len(content.encode("utf-8"))
    maximum = int(arguments.get("_max_part_bytes", DEFAULT_MAX_PART_BYTES) * 1.5)
    if part_bytes > maximum:
        raise ToolError(
            f"This part is {part_bytes:,} UTF-8 bytes; split it into smaller "
            f"parts of at most {maximum:,} bytes."
        )
    return part, total, content, part_bytes


def _write_staged_part(
    context: DraftContext, part: int, total: int, content: str
) -> Path:
    directory = _staged_draft_directory(context)
    existing_total = _staged_total(directory)
    if existing_total is not None and existing_total != total:
        raise _wrong_staged_total(directory, existing_total, total)
    try:
        directory.mkdir(parents=True, exist_ok=True)
        if existing_total is None:
            _atomic_write_text(directory / STAGED_PARTS_TOTAL_FILE, str(total))
        _atomic_write_text(_staged_part_path(context, part), _continuation_guide_text(part, content))
    except OSError as error:
        raise ToolError(f"Could not stage draft part {part}: {error}") from error
    return directory


def _wrong_staged_total(directory: Path, expected: int, received: int) -> ToolError:
    return ToolError(
        f"parts must stay {expected} for this staged draft; received {received}. "
        f"Use parts={expected}. Existing parts: {_staged_part_numbers(directory)}."
    )


def _staged_status(directory: Path, total: int, part_bytes: int) -> str:
    received = _staged_part_numbers(directory)
    return json.dumps(
        {
            "received_parts": received,
            "missing_parts": [
                number for number in range(1, total + 1) if number not in received
            ],
            "total_parts": total,
            "part_bytes": part_bytes,
        },
        ensure_ascii=False,
    )


def _review_payload(
    draft_path: Path,
    content: str,
    warning: str | None = None,
    route: str | None = None,
) -> str:
    payload: dict[str, Any] = {"path": str(draft_path), "content": content}
    if warning is not None:
        payload["warning"] = warning
    if route is not None:
        payload["route"] = route
    return json.dumps(payload, ensure_ascii=False)


# The contract is included in the result because the desktop Agent cannot be
# expected to discover repository references that were not attached to its chat.
VERBATIM_NEXT_STEP = build_drafting_contract()


def _start_result(
    engine: str, route: str, path: Path, output: str, next_step: str | None = None
) -> str:
    payload: dict[str, Any] = {
        "engine": engine,
        "route": route,
        "path": str(path),
        "output": output,
    }
    if next_step is not None:
        payload["next"] = next_step
    return json.dumps(payload, ensure_ascii=False)


def _start_verbatim(
    arguments: dict[str, Any], workspace: Path, engine: str
) -> str:
    module, manifest, _manifest_path = _resolve_manifest_context(arguments, workspace)
    contexts = _verbatim_contexts(module, manifest)
    outputs: list[str] = []
    for context in contexts:
        if context.path.is_file():
            continue
        command = _launcher(
            workspace,
            "--module", _module(arguments),
            "--engine", engine,
            "--lecture", context.lecture,
            "--output", str(context.path),
            "--json-events",
        )
        outputs.append(_run(command, workspace, DRAFT_TIMEOUT_SECONDS))
    contract = _drafting_handoff(
        workspace, manifest.title, module.emoji, manifest.recording_sources
    )
    payload = json.loads(_start_result(
        engine, "verbatim", contexts[0].path,
        "\n\n".join(outputs) or "All verbatims already exist.", contract,
    ))
    payload["paths"] = [str(context.path) for context in contexts]
    return json.dumps(payload, ensure_ascii=False)


def _start_pipeline(
    arguments: dict[str, Any], workspace: Path, engine: str, manifest: str
) -> str:
    context = _resolve_draft_context(arguments, workspace)
    command = _launcher(
        workspace,
        "--module",
        _module(arguments),
        "--engine",
        engine,
        "--source-manifest",
        manifest,
        "--draft-only",
        "--json-events",
    )
    output = _run(command, workspace, DRAFT_TIMEOUT_SECONDS)
    contract = _drafting_handoff(
        workspace, context.title, context.emoji, context.recording_sources
    )
    return _start_result(engine, "five-phase-pipeline", context.path, output, contract)


# --- handlers ---------------------------------------------------------------


def _doctor(arguments: dict[str, Any], workspace: Path) -> str:
    import io

    from dependency_doctor import report_json

    report = io.StringIO()
    report_json(report, live=bool(arguments.get("live")))
    return report.getvalue()


def _workspace_info(arguments: dict[str, Any], workspace: Path) -> str:
    resolved = _resolved_workspace(workspace)
    return json.dumps(
        {
            "workspace": str(resolved),
            "exists": resolved.exists(),
            "has_modules": (resolved / "modules").is_dir(),
        },
        ensure_ascii=False,
        indent=2,
    )


def _discovered_modules(workspace: Path) -> list[Any]:
    """Every configured module, with an empty workspace treated as empty.

    ``discover_modules`` raises when it finds none, which is right for the CLI
    -- a transcription needs a module. It is wrong here: a freshly chosen
    workspace with nothing in it yet is the normal first screen of setup, and
    a panel must render it as "no modules" rather than as a failure.

    The emptiness is checked directly instead of by matching the raised
    message, so a module that genuinely fails to load still surfaces as an
    error rather than silently vanishing from the list.
    """
    from module_registry import discover_modules, modules_root

    try:
        root = modules_root(workspace, None)
    except Exception as error:  # noqa: BLE001 - surfaced as a tool error
        raise ToolError(f"Could not resolve the modules folder: {error}") from error
    if not root.is_dir() or not any(
        path.is_dir() and not path.name.startswith(".") and (path / "module.json").is_file()
        for path in root.iterdir()
    ):
        return []
    try:
        return discover_modules(workspace, None)
    except Exception as error:  # noqa: BLE001 - surfaced as a tool error
        raise ToolError(f"Could not read the modules in {workspace}: {error}") from error


QUESTION_DOCUMENT_EXTENSIONS = frozenset({".pdf", ".doc", ".docx", ".ppt", ".pptx", ".ppsx", ".jpg", ".jpeg", ".png"})
NO_QUESTIONS_CONTRACT = (
    "No indexed questions are available. Write the question sections only from the "
    "lecture using **[IMP]**; never invent past-exam badges or years."
)


def _question_text_files(directory: Path) -> list[Path]:
    return [
        path
        for path in directory.glob("*")
        if path.is_file()
        and path.suffix.casefold() in {".txt", ".md"}
        and path.stat().st_size
    ]


def _empty_exam_status(directory: Path) -> dict[str, Any]:
    needs_conversion = any(
        path.is_file() and path.suffix.casefold() in QUESTION_DOCUMENT_EXTENSIONS
        for path in directory.glob("*")
    )
    return {
        "entries": 0,
        "sources": 0,
        "questions": 0,
        "dated": 0,
        "bank_only": 0,
        "damaged": 0,
        "status": "needs-conversion" if needs_conversion else "no-questions",
        "hint": "Run source sync/OCR to convert the question documents into searchable text."
        if needs_conversion
        else "Add question PDFs, then run source sync/OCR and build_exam_index.",
    }


def _questions_status(module: Any) -> str:
    from exam_index import ExamIndexError, load_index

    try:
        index = load_index(module.paths.questions)
        if index["module"] == module.module_id and index["questions"]:
            return "indexed"
    except (ExamIndexError, OSError, ValueError, KeyError, TypeError):
        # Library discovery must work before a bank or index has been prepared.
        pass
    return (
        "needs-conversion"
        if _empty_exam_status(module.paths.questions)["status"] == "needs-conversion"
        else "missing"
    )


def _list_modules(arguments: dict[str, Any], workspace: Path) -> str:
    """Structured, and local only.

    A sidebar redraws on every change, so this reads module.json and the
    folders rather than going out to NotebookLM -- the network answer is what
    audit_sources is for.
    """
    payload = [
        {
            "module": module.module_id,
            "display_name": module.display_name,
            "notebooks": [
                reference.notebook_id or reference.title
                for reference in module.notebook.notebooks
            ],
            "root": str(module.paths.root),
            "questions": _questions_status(module),
        }
        for module in _discovered_modules(workspace)
    ]
    return json.dumps(
        {"workspace": str(_resolved_workspace(workspace)), "modules": payload},
        ensure_ascii=False,
        indent=2,
    )


def _list_library(arguments: dict[str, Any], workspace: Path) -> str:
    from desktop_library import list_library

    try:
        payload = list_library(_resolved_workspace(workspace), arguments.get("remote", "cached"), _lecture_listing)
    except ValueError as error:
        raise ToolError(str(error)) from error
    return json.dumps(payload, ensure_ascii=False)


def _remote_recordings(module: Any, local: list[Path]) -> tuple[list[Path], str | None]:
    """The module's uploaded recordings that are not also sitting on disk.

    The audio is the large half of a lecture and the transcript is the
    deliverable, so a recording is routinely uploaded once and then deleted --
    and a module can be worked on entirely from the notebook, which the engine
    supports on purpose (``--engine notebooklm-raw`` reads the transcript back
    without ever opening the file). Listing only what is on disk then reports a
    module with thirteen recordings in its notebook as having three lectures,
    all of them done, which is the opposite of the truth.

    These come back as bare names rather than paths, because there is no path:
    they name a source inside a notebook. A caller that needs a file can see
    that ``paths`` is empty for them.

    A failure here is reported, never raised. The notebook is across a network
    behind an unofficial client; a panel that showed nothing because a listing
    timed out would be worse than one showing the local half and saying so.
    """
    from remote_inventory import module_inventory

    inventory = module_inventory(module)
    sources = inventory.sources
    on_disk = {path.stem.casefold() for path in local}
    remote: list[Path] = []
    for source in sources:
        if source.source_type.casefold() not in {"audio", "video"}:
            continue
        name = Path(source.title)
        if name.stem.casefold() in on_disk:
            continue
        remote.append(name)
    return remote, inventory.warning


def _list_lectures(arguments: dict[str, Any], workspace: Path) -> str:
    """Every local recording, and whether a transcript for it already exists.

    Recording citations in transcript headers establish which unit is done.
    Transcripts without recording citations use the legacy title rules.

    ``materials`` is returned beside ``lectures`` because ``Lecture/`` holds
    both. A caller given only the lecture list has no way to describe the
    slide decks and textbooks sitting next to the recordings, and a chat model
    asked what a module contains will then list the folder itself and present
    "Book.pdf" as a lecture awaiting transcription. Naming them as reference
    material is what stops that: they are what a lecture is explained *with*,
    never something to run the pipeline over.

    Recordings uploaded to the module's notebook count as lectures too, even
    when no copy remains on disk -- see ``_remote_recordings``.
    """
    if not isinstance(arguments.get("refresh", False), bool):
        raise ToolError("refresh must be a boolean")
    module = _registry_module(arguments, workspace)
    return json.dumps(_lecture_listing(module, arguments), ensure_ascii=False, indent=2)


def _lecture_listing(module: Any, arguments: dict[str, Any]) -> dict[str, Any]:
    files = [
        path for path in sorted(module.paths.lecture.rglob("*")) if path.is_file()
    ]
    recordings = [
        path for path in files if path.suffix.lower() in RECORDING_EXTENSIONS
    ]
    if arguments.get("_local_only"):
        recordings = _redo_recordings(module, recordings)
    from remote_inventory import Inventory, module_inventory
    from source_naming import normalize_source_stem

    inventory = Inventory([], None, available=False) if arguments.get("_local_only") else module_inventory(
        module, arguments.get("_remote", "refresh" if arguments.get("refresh") else "fresh")
    )
    on_disk = {normalize_source_stem(path.name) for path in recordings}
    remote = [Path(source.title) for source in inventory.sources
              if source.source_type.casefold() in {"audio", "video"}
              and normalize_source_stem(source.title) not in on_disk]
    warning = inventory.warning
    remote_names_all = {normalize_source_stem(source.title) for source in inventory.sources if source.source_type.casefold() in {"audio", "video"} or Path(source.title).suffix.casefold() in RECORDING_EXTENSIONS}
    # Grouped together, so a lecture split across a local part and an
    # uploaded one is still one lecture rather than two halves.
    lectures = _classify_lectures(
        recordings + remote,
        [
            path
            for path in sorted(module.paths.transcripts.glob("*"))
            if path.is_file()
        ],
        module,
    )
    remote_names = {path.name for path in remote}
    for lecture in lectures:
        lecture.update(_lecture_artifacts(module, lecture))
        _report_lecture_materials(module, lecture)
        lecture["in_notebook"] = all(normalize_source_stem(name) in remote_names_all
            for name in lecture.get("recording_sources", [])) if inventory.available and lecture.get("recording_sources") else None
        sources = [str(name) for name in lecture.get("recording_sources", [])]
        lecture["in_notebook_only"] = bool(sources) and all(
            name in remote_names for name in sources
        )
        # A notebook source has no path. Grouping stringifies whatever it
        # was given, so drop the ones that would read as a relative file
        # and leave a caller nothing to mistake for something openable.
        lecture["paths"] = [
            path
            for path in lecture.get("paths", [])
            if Path(path).name not in remote_names or Path(path).is_absolute()
        ]
    general_paths = {(module.paths.lecture / name).resolve() for name in module.general_materials}
    materials = [
        {"name": path.name, "path": str(path)}
        for path in files
        if path.suffix.lower() not in RECORDING_EXTENSIONS and path.resolve() not in general_paths
    ]
    payload: dict[str, Any] = {
        "module": module.module_id,
        "remote_as_of": inventory.remote_as_of,
        "lectures": lectures,
        "materials": materials,
        "general_materials": list(module.general_materials),
        "questions": _questions_status(module),
    }
    if warning is not None:
        payload["warning"] = warning
    return payload


def _report_lecture_materials(module: Any, lecture: dict[str, Any]) -> None:
    """Name the deck a lecture is written with, and whether the student chose it.

    A student's definition lists its materials. An automatic unit has none on
    record, yet the writer still finds its deck by title (_matching_local_slide);
    reporting that match keeps the library from saying "no slides" about a
    lecture whose guide is being organised by them. A matched deck is not
    claimed: the file listing still shows it unassigned until the student pins
    the lecture.
    """
    if lecture.get("materials"):
        lecture["materials_origin"] = "defined"
        return
    if lecture.get("origin") == "manual":
        return
    slide = _matching_local_slide(module, lecture["title"], tuple(lecture.get("recording_sources", [])))
    if slide is None:
        return
    try:
        name = slide.relative_to(module.paths.lecture.resolve()).as_posix()
    except ValueError:
        return
    lecture["materials"] = [name]
    lecture["materials_origin"] = "matched"


def _lecture_artifacts(module: Any, lecture: dict[str, Any]) -> dict[str, Any]:
    from universal_transcribe import _draft_path_for_lecture

    draft = Path(_draft_path_for_lecture(
        lecture["title"], module.emoji, str(module.paths.transcripts)
    ))
    sources = lecture["recording_sources"]
    verbatims = _verbatim_source_paths(module.paths.root, tuple(sources))
    transcript = lecture["transcript"]
    artifacts = {
        "transcript": str((module.paths.transcripts / transcript).resolve()) if transcript else None,
        "draft": str(draft.resolve()) if draft.is_file() else None,
        "verbatim": str(verbatims[0]) if len(sources) == 1 and verbatims else None,
        "verbatims": [str(path) for path in verbatims],
    }
    state = (
        "final" if artifacts["transcript"]
        else "draft" if artifacts["draft"]
        else "verbatim" if sources and len(verbatims) == len(sources)
        else "pending"
    )
    return {**artifacts, "state": state}


def _classify_lectures(recordings: list[Path], transcripts: list[str | Path], module: Any = None) -> list[dict[str, Any]]:
    """Keep recording unit titles stable while attaching their finished work."""
    finished = final_transcripts(transcripts)
    lectures = lecture_units(module, recordings) if module is not None else _group_recordings(recordings)
    assignments = transcript_assignments(finished, lectures)
    claimed: set[str] = set()
    for index, lecture in enumerate(lectures):
        transcript = assignments.get(index)
        lecture["transcribed"] = transcript is not None
        lecture["transcript"] = transcript.name if transcript else None
        lecture["transcript_title"] = transcript.title if transcript else None
        if transcript:
            claimed.add(transcript.name)
    if module is not None:
        hidden = {recording_filename_key(name) for name in module.hidden_recordings}
        for transcript in finished:
            sources = transcript.recording_sources
            associated = frozenset(recording_filename_key(name)
                for name in module.hidden_transcripts.get(transcript.name, ()))
            if sources and sources <= hidden or associated and associated <= hidden:
                claimed.add(transcript.name)
        for unit in lecture_units(module, recordings, include_hidden=True):
            if unit_hidden(module, unit):
                claimed.update(transcript.name for transcript in finished
                               if transcript.matches(unit["title"], unit["recording_sources"]))
    unclaimed = [transcript.name for transcript in finished if transcript.name not in claimed]
    return lectures + _orphan_transcripts(unclaimed)


def _orphan_transcripts(names: list[str]) -> list[dict[str, Any]]:
    """Finished transcripts whose recording is no longer in ``Lecture/``.

    A recording is often deleted once its transcript exists -- the audio is
    large and the transcript is the deliverable. Listing only what can still be
    transcribed then hides the finished work: a module whose recordings are all
    gone answers "no lectures" while its transcripts sit right there, which is
    the opposite of what "where do my lectures stand" should say.

    They come back with no ``recording_sources`` and ``parts`` of zero, which is
    also what keeps them from being offered as something to transcribe: there is
    no audio to run a pipeline over, and a caller that needs one can see that.
    """
    return [
        {
            "title": Path(name).stem,
            "origin": "auto",
            "materials": [],
            "recording_sources": [],
            "paths": [],
            "parts": 0,
            "transcribed": True,
            "transcript": name,
            "transcript_title": Path(name).stem,
        }
        for name in names
    ]


def _build_exam_index(arguments: dict[str, Any], workspace: Path) -> str:
    """Index the module's exam papers, once, from its question files.

    Without this the app had the policy but no way to carry it out: the
    composer offered "prepare the question file" and nothing behind it built
    one, so a model asked for it wrote its own -- a JSON mapping each filename
    to its raw OCR text, with no questions separated, no years, and no answers.
    The real index records a kind, the years it covers and a question count per
    file, which is what lets a drafted question carry an honest
    [Past Exams - <year>] badge instead of a guess.
    """
    return _run(
        _launcher(workspace, "--module", _module(arguments), "--build-exam-index"),
        workspace,
        DEFAULT_TIMEOUT_SECONDS,
    )


def _question_evidence(module: Any, title: str) -> list[str]:
    from slide_figures import SLIDE_TEXT_NAME

    definition = manual_definition(module, title)
    manifest_path = _cached_unit_manifest(module, title)
    if definition:
        title = definition.title
        sources = definition.recordings
    elif manifest_path:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        title = manifest["title"]
        sources = tuple(manifest["recording_sources"])
    else:
        units = lecture_units(module,
            [
                path
                for path in module.paths.lecture.rglob("*")
                if path.is_file() and path.suffix.casefold() in RECORDING_EXTENSIONS
            ]
        )
        sources = tuple(
            source
            for unit in units
            if _match_key(unit["title"]) == _match_key(title)
            for source in unit["recording_sources"]
        )
    paths = list(_verbatim_source_paths(module.paths.root, sources))
    paths.extend(
        directory / SLIDE_TEXT_NAME
        for directory in _figure_directories(module.paths.root, title, sources)
        if (directory / SLIDE_TEXT_NAME).is_file()
    )
    # Source sync's converted slide text is useful before figures have been extracted.
    slide = _matching_local_slide(module, definition.id if definition else title)
    if slide and slide.with_suffix(".txt").is_file():
        paths.append(slide.with_suffix(".txt"))
    if definition:
        from lecture_registry import lecture_file
        for name in definition.materials:
            material = lecture_file(module, name)
            text_path = material if material.suffix.casefold() in {".txt", ".md"} else material.with_suffix(".txt")
            if text_path.is_file():
                paths.append(text_path)
    texts = [path.read_text(encoding="utf-8") for path in dict.fromkeys(paths)]
    if not any(path.name == SLIDE_TEXT_NAME for path in paths):
        slide = _lecture_slide_path(module, title, sources)
        if slide and slide.with_suffix(".txt") not in paths:
            outline = _agy_slide_text(slide)
            if outline:
                texts.append(outline)
    return texts


def _find_questions(arguments: dict[str, Any], workspace: Path) -> str:
    from exam_index import INDEX_NAME, ExamIndexError, load_index
    from lecture_questions import MAX_QUESTIONS, ranked_questions
    from question_provenance import paper_backed_index, paper_texts

    title = str(arguments.get("lecture", "")).strip()
    terms = arguments.get("terms", [])
    if not title:
        raise ToolError("lecture is required for find_questions.")
    if not isinstance(terms, list) or any(not isinstance(term, str) for term in terms):
        raise ToolError("terms must be an array of strings.")
    module = next(
        (
            module
            for module in _discovered_modules(workspace)
            if module.module_id == _module(arguments)
        ),
        None,
    )
    if module is None:
        raise ToolError(
            f"No module named {_module(arguments)!r}. Call list_modules first."
        )
    if not (module.paths.questions / INDEX_NAME).is_file():
        return json.dumps(
            {
                "module": module.module_id,
                "lecture": title,
                "entries": [],
                "total": 0,
                "matched": 0,
                "returned": 0,
                "omitted": 0,
                **{
                    key: value
                    for key, value in _empty_exam_status(module.paths.questions).items()
                    if key != "entries"
                },
                "contract": NO_QUESTIONS_CONTRACT,
            },
            ensure_ascii=False,
        )
    try:
        index = load_index(module.paths.questions)
        verified = paper_backed_index(index, paper_texts(module.paths.questions), module.module_id)
        definition = manual_definition(module, title)
        ranked = ranked_questions(verified, definition.title if definition else title, _question_evidence(module, title), terms)
    except (ExamIndexError, OSError, ValueError, KeyError, TypeError) as error:
        raise ToolError(
            f"Could not read lecture questions: {error}. Rebuild with build_exam_index."
        ) from error
    payload = {
        "module": module.module_id,
        "lecture": title,
        "entries": [],
        "total": len(index["questions"]),
        "unverified": len(index["questions"]) - len(verified["questions"]),
        "matched": len(ranked),
        "returned": 0,
        "omitted": len(ranked),
    }
    selected: list[dict[str, Any]] = []
    for entry in ranked:
        if len(selected) == MAX_QUESTIONS:
            break
        candidate = {
            **payload,
            "entries": [*selected, entry],
            "returned": len(selected) + 1,
            "omitted": len(ranked) - len(selected) - 1,
        }
        if _json_bytes(candidate) <= arguments.get(
            "_max_part_bytes", DEFAULT_MAX_PART_BYTES
        ):
            selected.append(entry)
    payload.update(
        entries=selected, returned=len(selected), omitted=len(ranked) - len(selected)
    )
    return json.dumps(payload, ensure_ascii=False)


def _transcript_argument(arguments: dict[str, Any], field: str) -> str:
    value = str(arguments.get(field, "")).strip()
    if not value:
        raise ToolError(
            f"'{field}' is required: the draft or transcript file name, as "
            "start_draft reported it."
        )
    return value


def _validate_draft(arguments: dict[str, Any], workspace: Path) -> str:
    """Run the finalizer's checks over a draft without finalizing it."""
    return _run_draft_check(arguments, workspace, "validate_draft", "draft")


def _verify_provenance(arguments: dict[str, Any], workspace: Path) -> str:
    """Hold every year badge against the paper it names."""
    return _run_draft_check(arguments, workspace, "verify_provenance", "transcript")


def _run_draft_check(arguments: dict[str, Any], workspace: Path, check: str, field: str) -> str:
    transcript = _transcript_argument(arguments, field)
    command = _launcher(workspace, "--module", _module(arguments), "--" + check.replace("_", "-"), transcript)
    if arguments.get("manifest_path"):
        command.extend(("--source-manifest", str(arguments["manifest_path"])))
    try:
        output = _run(command, workspace, DEFAULT_TIMEOUT_SECONDS)
    except ToolError as error:
        _record_draft_check(arguments, workspace, transcript, {check: str(error)})
        raise
    _record_draft_check(arguments, workspace, transcript, {check: None})
    return output


def _record_draft_check(arguments: dict[str, Any], workspace: Path, transcript: str, finding: dict[str, Any]) -> None:
    module = next((module for module in _discovered_modules(workspace) if module.module_id == _module(arguments)), None)
    if module is None:
        return
    path = Path(transcript).expanduser()
    if not path.is_absolute():
        path = next((base / path for base in (workspace, module.paths.transcripts, module.paths.root) if (base / path).is_file()), path)
    if not path.is_file():
        return
    fingerprint = draft_fingerprint(_read_review_draft(path))
    checks_path = _draft_checks_path(module.paths.root, path)
    checks = _read_optional_json(checks_path)
    if not isinstance(checks, dict) or checks.get("sha256") != fingerprint:
        checks = {"sha256": fingerprint}
    _atomic_write_text(checks_path, json.dumps({**checks, **finding}, ensure_ascii=False))


def _draft_checks_path(module_root: Path, draft: Path) -> Path:
    return module_root / ".transcriber-cache" / "draft-checks" / f"{draft.name}.json"


def _extract_figures(arguments: dict[str, Any], workspace: Path) -> str:
    """Cut the slides worth showing out of a lecture's deck.

    The engine has done this since the beginning, and the drafting rules tell
    the writer to link the figures the doctor showed -- but no tool offered
    it, so a model that wanted figures reached for a shell and ran the
    launcher script by path. That works on this machine and on no student's:
    the packaged app ships no python3, no bash, and no skills/ directory in
    the workspace to point at. Figures were a dev-machine feature wearing a
    product's clothes.
    """
    command = [
        *_launcher(workspace, "--module", _module(arguments), "--extract-figures"),
    ]
    lecture = str(arguments.get("lecture", "")).strip()
    if lecture:
        command += ["--lecture", lecture]
    slides = str(arguments.get("slides", "")).strip()
    if slides:
        command += ["--slides", slides]
    if not lecture and not slides:
        raise ToolError(
            "Naming the lecture or the deck is required: pass 'lecture' to use "
            "the slides module.json configures for it, or 'slides' with a path "
            "to the deck."
        )
    return _run(command, workspace, DEFAULT_TIMEOUT_SECONDS)


def _audit_sources(arguments: dict[str, Any], workspace: Path) -> str:
    return _run(
        _launcher(workspace, "--module", _module(arguments),
                  "--sync-sources", "--audit-only"),
        workspace,
        DEFAULT_TIMEOUT_SECONDS,
    )


def _create_module(arguments: dict[str, Any], workspace: Path) -> str:
    module = _module(arguments)
    display = str(arguments.get("display_name") or module).strip()
    return _run(
        build_entrypoint_command(
            "manage-modules",
            (
                "--workspace",
                str(workspace),
                "create",
                "--module",
                module,
                "--display-name",
                display,
                "--notebook-title",
                display,
                "--apply",
            ),
        ),
        workspace,
        DEFAULT_TIMEOUT_SECONDS,
    )


def _apply_sync(arguments: dict[str, Any], workspace: Path) -> str:
    manifest = str(arguments.get("manifest_path", "")).strip()
    if not manifest:
        raise ToolError("manifest_path is required. Build it from audit_sources first.")
    from remote_inventory import invalidate

    module = _registry_module(arguments, workspace)
    try:
        return _run(
            _launcher(workspace, "--module", _module(arguments),
                      "--source-sync-manifest", manifest, "--apply"),
            workspace, DEFAULT_TIMEOUT_SECONDS,
        )
    finally:
        # A failed source sync may have already changed part of the notebook.
        invalidate(module)


def _upload_recordings(arguments: dict[str, Any], workspace: Path) -> str:
    from recording_uploads import upload_recordings
    from transcriber_models import TranscriberError

    if arguments.get("confirmed") is not True:
        raise ToolError(CONFIRMATION_REQUIRED)
    module = _registry_module(_module_by_display_name(arguments, workspace), workspace)
    try:
        payload = upload_recordings(module, arguments.get("files"))
    except (ValueError, OSError, TranscriberError) as error:
        raise ToolError(str(error)) from error
    payload["next"] = "Call begin_lecture again." if payload["status"] == "ready" else "Wait, then retry upload_recordings with the same files and confirmed=true to check readiness."
    return json.dumps(payload, ensure_ascii=False)


def _registry_module(arguments: dict[str, Any], workspace: Path) -> Any:
    module = next((module for module in _discovered_modules(workspace)
                   if module.module_id == _module(arguments)), None)
    if module is None:
        raise ToolError(f"No module named {_module(arguments)!r}. Call list_modules first.")
    return module


def _registry_operation(arguments: dict[str, Any], workspace: Path, operation: str) -> str:
    import lecture_registry
    from module_registry import ModuleConfigError
    from source_preparation import PreparationError
    from transcriber_models import TranscriberError

    module = _registry_module(arguments, workspace)
    fields = {
        "define_lecture": ("title", "recordings", "materials", "id"),
        "set_general_materials": ("materials",),
        "apply_organization": ("lectures", "replace_existing", "general"),
        "hide_lecture": ("title",), "restore_recordings": ("recordings",),
        "delete_lecture": ("id",), "import_file": ("source_path", "kind", "name", "replace"),
        "rename_file": ("path", "new_name"), "remove_file": ("path",), "list_module_files": ("refresh",),
    }[operation]
    try:
        output = getattr(lecture_registry, operation)(module, **{
            key: arguments[key] for key in fields if key in arguments
        })
    except (ModuleConfigError, PreparationError, TranscriberError, OSError, ValueError, TypeError) as error:
        raise ToolError(f"{operation}: {error}") from error
    return json.dumps(output if output is not None else {"deleted": arguments["id"]}, ensure_ascii=False)


def _trash_operation(arguments: dict[str, Any], workspace: Path, operation: str) -> str:
    import library_trash
    from module_registry import ModuleConfigError

    answer: dict[str, Any] | list[dict[str, Any]]
    try:
        if operation == "remove_module":
            answer = library_trash.remove_module(workspace, _module(arguments))
        elif operation == "restore_module":
            answer = library_trash.restore_module(workspace, arguments.get("trash_id", ""))
        elif operation == "list_removed_modules":
            answer = library_trash.list_removed_modules(workspace)
        else:
            module = _registry_module(arguments, workspace)
            if operation == "remove_transcript":
                answer = library_trash.remove_transcript(module, arguments.get("lecture", ""), arguments.get("kinds", []))
            elif operation == "restore_trash":
                answer = library_trash.restore_trash(module, arguments.get("id", ""))
            else:
                answer = library_trash.list_trash(module)
    except (ModuleConfigError, OSError, ValueError, TypeError) as error:
        raise ToolError(f"{operation}: {error}") from error
    return json.dumps(answer, ensure_ascii=False)


def _trash_handler(operation: str) -> Callable[[dict[str, Any], Path], str]:
    def invoke(arguments: dict[str, Any], workspace: Path) -> str:
        return _trash_operation(arguments, workspace, operation)
    return invoke


def _propose_organization(arguments: dict[str, Any], workspace: Path) -> str:
    from module_organization import propose_organization
    from module_registry import ModuleConfigError

    module = _registry_module(arguments, workspace)
    try:
        return json.dumps(propose_organization(module, arguments.get("refresh", False)), ensure_ascii=False)
    except (ModuleConfigError, OSError) as error:
        raise ToolError(str(error)) from error


def _redo_argument(arguments: dict[str, Any]) -> bool:
    redo = arguments.get("redo", False)
    if not isinstance(redo, bool):
        raise ToolError("redo must be a boolean when supplied.")
    return redo


def _redo_recordings(module: Any, local: list[Path]) -> list[Path]:
    from run_transcription import _source_manifest

    names = {path.name.casefold(): path for path in local}
    directory = module.paths.root / ".transcriber-cache" / "manifests"
    for path in sorted(directory.glob("*.json")):
        manifest = _source_manifest(str(path))
        for source in manifest.recording_sources:
            names.setdefault(source.casefold(), Path(source))
    for transcript in module_final_transcripts(module.paths.transcripts):
        for source in sorted(transcript.recording_sources):
            names.setdefault(source.casefold(), Path(source))
    return list(names.values())


def _prepare_manifest(arguments: dict[str, Any], workspace: Path) -> str:
    """Build the ordered source manifest one lecture's transcription needs.

    start_draft, read_draft, apply_review and finalize all require a manifest,
    and nothing exposed a way to make one: the engine's --auto-manifest was
    reachable only from a terminal. A model asked to transcribe could either
    write the file by hand -- which is how the question bank ended up as a dump
    of raw OCR text -- or fail. It is a manifest, not a transcription, so it
    writes nothing outside the module's own cache and needs no confirmation.
    """
    _redo_argument(arguments)
    lecture = str(arguments.get("lecture", "")).strip()
    if not lecture:
        raise ToolError(
            "lecture is required: name the recording to build a manifest for. "
            "Call list_lectures to see the titles."
        )
    module_id = _module(arguments)
    for module in _discovered_modules(workspace):
        if module.module_id != module_id:
            continue
        local = [
            path
            for path in sorted(module.paths.lecture.rglob("*"))
            if path.is_file() and path.suffix.casefold() in RECORDING_EXTENSIONS
        ]
        if arguments.get("redo"):
            local = _redo_recordings(module, local)
        remote, warning = (
            ([], None)
            if arguments.get("redo") and local
            else _remote_recordings(module, local)
        )
        units = _classify_lectures(
            local + remote,
            [path for path in module.paths.transcripts.glob("*") if path.is_file()],
            module,
        )
        matched = [
            unit
            for unit in units
            if lecture.casefold() == unit["title"].casefold()
            or any(
                lecture.casefold() == source.casefold()
                for source in unit["recording_sources"]
            )
        ]
        matched = [unit for unit in units if unit.get("id") == lecture] or matched or _lecture_matches(units, lecture)
        sources = tuple(matched[0]["recording_sources"]) if len(matched) == 1 else None
        if len(matched) != 1 or not matched[0]["recording_sources"]:
            raise ToolError("No unique recording lecture matched; use a manual id or exact title")
        title = matched[0].get("id", matched[0]["title"])
        path = _prepare_unit_manifest(module, title, sources, bool(arguments.get("redo")))
        _initialize_redo(module, path, workspace)
        payload = {"module": module_id, "lecture": matched[0]["title"], "manifest_path": str(path)}
        if warning is not None:
            payload["warning"] = warning
        return json.dumps(payload, ensure_ascii=False)
    raise ToolError(f"No module named {module_id!r}. Call list_modules first.")


def _prepare_unit_manifest(
    module: Any, title: str, sources: tuple[str, ...] | None, redo: bool = False
) -> Path:
    from nlm_client import load_config
    from run_transcription import LauncherError, generate_auto_manifest

    definition = manual_definition(module, title, sources)
    display_title = definition.title if definition else title
    units = lecture_units(module, [
        path for path in module.paths.lecture.rglob("*")
        if path.is_file() and path.suffix.casefold() in RECORDING_EXTENSIONS
    ])
    assigned = transcript_assignments(module_final_transcripts(module.paths.transcripts), units)
    completed = [transcript for index, transcript in assigned.items()
                 if units[index]["recording_sources"] == list(sources or ())
                 and units[index]["title"] == display_title]
    if completed and not redo:
        raise ToolError(
            f"{title!r} is already transcribed: {module.paths.transcripts / completed[0].name}; pass redo=true to transcribe it again"
        )
    cached = _cached_unit_manifest(module, title, sources)
    if cached is not None:
        payload = json.loads(cached.read_text(encoding="utf-8"))
        slides = payload.get("slides")
        slide_path = slides.get("path") if isinstance(slides, dict) else slides
        if slide_path and not (module.paths.root / slide_path).is_file():
            payload.pop("slides")
            _atomic_write_text(cached, json.dumps(payload, ensure_ascii=False, indent=2))
        if redo and (not payload.get("redo") or payload.get("redo_completed")):
            payload.pop("redo_started", None)
            payload.pop("redo_completed", None)
            payload.update(
                redo=True,
                replaces_transcript=str(module.paths.transcripts / completed[0].name)
                if completed
                else None,
            )
            _atomic_write_text(cached, json.dumps(payload, ensure_ascii=False, indent=2))
        return cached
    try:
        return generate_auto_manifest(
            module.paths.root,
            title,
            str(load_config().get("nlm_executable") or "nlm"),
            recording_sources=sources,
            redo=redo,
            discover_remote=not (
                sources
                and len(_verbatim_source_paths(module.paths.root, sources))
                == len(sources)
            ),
        )
    except LauncherError as error:
        raise ToolError(f"Could not build a manifest for {title!r}: {error}") from error


def _initialize_redo(module: Any, manifest_path: Path, workspace: Path) -> None:
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not payload.get("redo") or payload.get("redo_started"):
        return
    context = _resolve_draft_context(
        {"module": module.module_id, "manifest_path": str(manifest_path)}, workspace
    )
    destination = context.path.with_name(context.path.name.removesuffix(".draft.md"))
    if not payload.get("replaces_transcript") and destination.is_file():
        payload["replaces_transcript"] = str(destination)
    archive = (
        module.paths.root / ".transcriber-cache" / "previous-drafts" / str(time_ns())
    )
    for label, artifact in (
        ("draft", context.path),
        ("staged", _staged_draft_directory(context)),
    ):
        if artifact.exists():
            archive.mkdir(parents=True, exist_ok=True)
            artifact.rename(archive / f"{label}-{artifact.name}")
    payload.pop("read_part_bytes", None)
    payload["redo_started"] = True
    _atomic_write_text(manifest_path, json.dumps(payload, ensure_ascii=False, indent=2))


def _lecture_matches(units: list[dict[str, Any]], lecture: str) -> list[dict[str, Any]]:
    by_id = [unit for unit in units if unit.get("id") == lecture]
    exact = by_id or [unit for unit in units if _match_key(unit["title"]) == _match_key(lecture)
                      or lecture in unit["recording_sources"]]
    return exact or [
        unit
        for unit in units
        if _title_contains_lecture(unit["title"], lecture)
        or (
            unit.get("transcript")
            and _match_key(Path(unit["transcript"]).stem) == _match_key(lecture)
        )
    ]


def _begin_lecture_unit(arguments: dict[str, Any], workspace: Path) -> dict[str, Any]:
    _redo_argument(arguments)
    lecture = str(arguments.get("lecture", "")).strip()
    if not lecture:
        raise ToolError(
            "lecture is required: name the recording to build a manifest for. "
            "Call list_lectures to see the titles."
        )
    units = json.loads(
        _list_lectures(
            {**arguments, "_local_only": bool(arguments.get("redo"))}, workspace
        )
    )["lectures"]
    matched = _lecture_matches(units, lecture)
    if arguments.get("redo") and (not matched or not matched[0]["recording_sources"]):
        matched = _lecture_matches(
            json.loads(_list_lectures(arguments, workspace))["lectures"], lecture
        )
    if len(matched) != 1 or not matched[0]["recording_sources"]:
        raise ToolError(
            f"Could not build a manifest for {lecture!r}: no unique recording lecture matched. "
            "Call list_lectures to see the titles."
        )
    if matched[0]["transcribed"] and not arguments.get("redo"):
        raise ToolError(
            f"{matched[0]['title']!r} is already transcribed: {matched[0]['transcript']}; pass redo=true to transcribe it again"
        )
    return matched[0]


def _cached_unit_manifest(module: Any, title: str, sources: tuple[str, ...] | None = None) -> Path | None:
    from lecture_registry import definition_signature
    from run_transcription import LauncherError, _source_manifest

    definition = manual_definition(module, title, sources)
    if definition:
        from lecture_registry import lecture_file
        if any(not lecture_file(module, name).is_file() for name in definition.materials):
            return None
        title = definition.title
    directory = module.paths.root / ".transcriber-cache" / "manifests"
    for path in sorted(directory.glob("*.json")):
        try:
            manifest = _source_manifest(str(path))
        except LauncherError as error:
            raise ToolError(f"Could not resolve the lecture manifest: {error}") from error
        payload = json.loads(path.read_text(encoding="utf-8"))
        if definition and payload.get("lecture_definition") != definition_signature(definition):
            continue
        if not definition and payload.get("lecture_definition"):
            continue
        if not definition:
            claimed = {f"Lecture/{name}" for entry in module.lectures for name in entry.materials}
            slide = payload.get("slides")
            slide_path = slide.get("path") if isinstance(slide, dict) else slide
            if slide_path in claimed:
                continue
        if sources is not None and manifest.recording_sources != sources:
            continue
        if _match_key(manifest.title) == _match_key(title):
            return path.resolve()
    return None


def _exam_index_is_stale(index: dict[str, Any], path: Path) -> bool:
    from exam_index import SCHEMA_VERSION

    papers = [
        paper for paper in path.parent.iterdir()
        if paper.is_file() and paper.suffix.lower() in {".txt", ".md"}
    ]
    indexed_names = {source["file"] for source in index["sources"]}
    return (
        index["schema_version"] != SCHEMA_VERSION
        or indexed_names != {paper.name for paper in papers}
        or any(paper.stat().st_mtime_ns > path.stat().st_mtime_ns for paper in papers)
    )


def _begin_exam_index(
    arguments: dict[str, Any], workspace: Path, module: Any
) -> dict[str, Any]:
    from exam_index import INDEX_NAME, ExamIndexError, load_index

    path = module.paths.questions / INDEX_NAME
    try:
        if not _question_text_files(path.parent):
            if path.is_file():
                existing = load_index(path.parent)
                if existing.get("module") == module.module_id and existing.get(
                    "questions"
                ):
                    return _exam_index_counts(existing)
            return _empty_exam_status(path.parent)
        index = load_index(path.parent) if path.is_file() else None
        if (
            index is None
            or index["module"] != module.module_id
            or _exam_index_is_stale(index, path)
        ):
            _build_exam_index(arguments, workspace)
            index = load_index(path.parent)
        return _exam_index_counts(index)
    except ExamIndexError as error:
        raise ToolError(str(error)) from error
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ToolError(
            f"Could not read the exam index at {path}: {error}. Rebuild with build_exam_index."
        ) from error


def _exam_index_counts(index: dict[str, Any]) -> dict[str, int]:
    questions = list(index["questions"].values())
    dated = sum(bool(question["years"]) for question in questions)
    return {
        "sources": len(index["sources"]), "questions": len(questions),
        "dated": dated, "bank_only": len(questions) - dated,
        "damaged": sum(not question["legible"] for question in questions),
    }


def _begin_next_call(arguments: dict[str, Any], parts: int, write_parts: int | None = None) -> str:
    arguments = {
        key: value for key, value in arguments.items() if not key.startswith("_")
    }
    staging = (
        f"parts={write_parts + 1}, and content=<guide for write segment 1>. "
        f"Stage guide parts 1..{write_parts} using write_segments boundaries, "
        f"then part {write_parts + 1} with sections 2–5."
        if write_parts is not None else
        "parts=<total draft parts>, and content=<first drafted part>."
    )
    if parts > 1:
        call = json.dumps({**arguments, "part": 2}, ensure_ascii=False)
        reading = f"Call read_draft({call}) and read every remaining read part before writing from the complete text. "
    else:
        reading = ""
    call = json.dumps({**arguments, "part": 1}, ensure_ascii=False)
    return reading + f"Call find_questions(module={arguments['module']!r}, lecture=<resolved lecture title>) before drafting questions. Call stage_draft_part with {call}, {staging}"


def _begin_draft_payload(arguments: dict[str, Any], workspace: Path) -> dict[str, Any]:
    context = _resolve_draft_context(arguments, workspace)
    if not context.path.is_file() and len(context.verbatim_sources) != len(context.recording_sources):
        _start_draft(arguments, workspace)
    payload = json.loads(_read_draft(arguments, workspace))
    payload["contract"] = _drafting_handoff(workspace, context.title, context.emoji, context.recording_sources)
    return payload


def _cached_figures(context: DraftContext) -> dict[str, Any] | None:
    from slide_figures import (
        MANIFEST_NAME,
        SELECTION_VERSION,
        SELECTION_VERSION_NAME,
        SLIDE_TEXT_NAME,
    )

    for directory in context.figure_directories:
        path = directory / MANIFEST_NAME
        if not path.is_file():
            continue
        try:
            if (directory / SELECTION_VERSION_NAME).read_text(encoding="utf-8").strip() != SELECTION_VERSION:
                continue
        except OSError:
            continue
        manifest = json.loads(path.read_text(encoding="utf-8"))
        if context.slides_path and manifest["source"] != context.slides_path.name:
            continue
        figures = [
            {
                "page": entry["page"],
                "path": str(directory / Path(entry["file"]).name),
                "markdown": f"![{context.title} — slide {entry['page']}](<./Figures/{directory.name}/{Path(entry['file']).name}>)",
            }
            for entry in manifest["figures"]
        ]
        if not all(Path(figure["path"]).is_file() for figure in figures):
            continue
        slide_text = directory / SLIDE_TEXT_NAME
        return {
            "status": "ready",
            "figures": figures,
            "slide_text": str(slide_text) if slide_text.is_file() else None,
        }
    return None


def _begin_figures(arguments: dict[str, Any], workspace: Path) -> dict[str, Any]:
    context = _resolve_draft_context(arguments, workspace)
    try:
        existing = _cached_figures(context)
        if existing is not None:
            return existing
        if context.slides_path is None:
            return {"status": "no-slides", "figures": []}
        output = _extract_figures(
            {
                "module": _module(arguments),
                "lecture": context.title,
                "slides": str(context.slides_path),
            },
            workspace,
        )
        extracted = _cached_figures(context)
        return extracted or {
            "status": "error",
            "figures": [],
            "error": "Extraction produced no figure manifest.",
            "output": output,
        }
    except (ToolError, OSError, ValueError, KeyError, TypeError) as error:
        return {"status": "error", "figures": [], "error": str(error)}


def _begin_lecture(arguments: dict[str, Any], workspace: Path) -> str:
    arguments = _module_by_display_name(arguments, workspace)
    unit = _begin_lecture_unit(arguments, workspace)
    module = next(
        module
        for module in _discovered_modules(workspace)
        if module.module_id == _module(arguments)
    )
    manifest = _prepare_unit_manifest(
        module,
        unit.get("id", unit["title"]),
        tuple(unit["recording_sources"]),
        bool(arguments.get("redo")),
    )
    _initialize_redo(module, manifest, workspace)
    draft_arguments = {
        "module": module.module_id,
        "manifest_path": str(manifest),
        "_max_part_bytes": arguments.get("_max_part_bytes", DEFAULT_MAX_PART_BYTES),
        "_write_part_bytes": arguments.get("_write_part_bytes", DEFAULT_WRITE_PART_BYTES),
    }
    upload = _begin_upload_request({**draft_arguments, "redo": bool(arguments.get("redo"))}, workspace)
    if upload.get("status") == "needs_upload":
        upload["general_materials"] = list(module.general_materials)
        return json.dumps(upload, ensure_ascii=False)
    exam_index = _begin_exam_index(draft_arguments, workspace, module)
    figures = _begin_figures(draft_arguments, workspace)
    envelope = {
        "module": module.module_id,
        "lecture": unit["title"],
        "manifest_path": str(manifest),
        "exam_index": exam_index,
        "uploaded": upload["uploaded"],
        "figures": figures,
        "general_materials": list(module.general_materials),
        "next": _begin_next_call(
            {"module": module.module_id, "manifest_path": str(manifest)}, 9999, 999999
        ),
    }
    draft_arguments["_begin_overhead"] = _json_bytes(envelope)
    payload = _begin_draft_payload(draft_arguments, workspace)
    parts = payload.get("parts", 1)
    if exam_index["questions"] == 0:
        payload["contract"] += "\n\n" + NO_QUESTIONS_CONTRACT
    response: dict[str, Any] = {
        "module": module.module_id,
        "lecture": unit["title"],
        "manifest_path": str(manifest),
        "exam_index": exam_index,
        "uploaded": upload["uploaded"],
        "figures": figures,
        "general_materials": list(module.general_materials),
        "route": payload.get("route", "draft"),
        "path": payload["path"],
        "part": 1,
        "parts": parts,
        "text": payload["content"],
        "contract": payload["contract"],
        **{key: payload[key] for key in ("write_parts", "write_segments", "write_alignment", "stale_staged_draft", "received_parts", "missing_parts", "total_parts", "checks") if key in payload},
        **({"paths": payload["paths"]} if "paths" in payload else {}),
        "next": (payload["next"] if payload.get("route") != "verbatim" and "next" in payload else _begin_next_call(draft_arguments, parts, payload.get("write_parts"))).replace(
            "<resolved lecture title>", repr(unit["title"])
        )
        + (" " + NO_QUESTIONS_CONTRACT if exam_index["questions"] == 0 else ""),
    }
    ready = agy_writer.availability()
    if ready.binary is not None:
        response.pop("text")
        response.pop("contract")
        response.update(writer="agy", model=arguments.get("_agy_model", agy_writer.DEFAULT_MODEL))
        agy_call = "Call write_parts_with_agy(" + json.dumps({
            "module": module.module_id, "manifest_path": str(manifest),
        }, ensure_ascii=False) + "). The engine reads and stages the text; do not read or write the long parts yourself."
        response["next"] = agy_call if payload.get("route") == "verbatim" else response["next"] + " For targeted repairs, use write_parts_with_agy with an explicit parts array."
    return json.dumps(response, ensure_ascii=False)


def _begin_upload_request(arguments: dict[str, Any], workspace: Path) -> dict[str, Any]:
    from recording_uploads import file_details, upload_recordings
    from transcriber_models import TranscriberError

    context = _resolve_draft_context(arguments, workspace)
    if context.path.is_file() or len(context.verbatim_sources) == len(context.recording_sources):
        return {"uploaded": []}
    module, manifest, _path = _resolve_manifest_context(arguments, workspace)
    missing = [source for source in manifest.recording_sources
               if not _verbatim_source_paths(module.paths.root, (source,))]
    local = [source for source in missing
             if (module.paths.lecture / source).is_file() or (module.paths.root / source).is_file()]
    if not local:
        return {"uploaded": []}
    try:
        payload = upload_recordings(module, local)
    except (ValueError, OSError, TranscriberError) as error:
        payload = {"files": [{**file_details(module.paths.lecture / source), "error": str(error)} for source in local]}
    uploaded = [entry["name"] for entry in payload["files"] if entry.get("status") == "uploaded"]
    failures = [entry for entry in payload["files"] if not entry.get("ready")]
    if not failures:
        return {"uploaded": uploaded}
    return {
        "status": "needs_upload", "route": "needs_upload", "module": module.module_id,
        "lecture": manifest.title, "manifest_path": str(context.manifest_path),
        "uploaded": uploaded, "files": failures,
        "reason": "; ".join(entry.get("error", entry.get("message", "Upload failed")) for entry in failures),
        "notebook": payload.get("notebook", {"id": module.notebook.notebook_id, "title": module.notebook.title}),
        "next": "Resolve the reported upload/processing failure, then retry begin_lecture for this lecture.",
    }


def _start_draft(arguments: dict[str, Any], workspace: Path) -> str:
    manifest = str(arguments.get("manifest_path", "")).strip()
    if not manifest:
        raise ToolError(
            "manifest_path is required: a real transcription needs an ordered "
            "source manifest naming the recording(s) for this one lecture."
        )
    engine = _requested_engine(arguments)
    if engine in TRANSCRIPTION_ENGINES:
        return _start_verbatim(arguments, workspace, engine)
    context = _resolve_draft_context(arguments, workspace)
    manifest_payload = json.loads(context.manifest_path.read_text(encoding="utf-8"))
    if manifest_payload.get("redo") and len(context.verbatim_sources) == len(
        context.recording_sources
    ):
        return _start_verbatim(arguments, workspace, NOTEBOOKLM_RAW)
    return _start_pipeline(arguments, workspace, engine, manifest)


def _drafting_reference(_arguments: dict[str, Any], _workspace: Path) -> str:
    """The full editorial reference, on request.

    It used to travel inside every start_draft result, which put roughly
    14,700 characters into the one call a student makes most often. The rules a
    draft is actually validated against are still handed over with the work;
    this is the rest, and a caller that wants it asks once.
    """
    from transcript_contract import drafting_reference

    return drafting_reference()


DEFAULT_MAX_PART_BYTES = 240_000
READ_PART_BYTES = DEFAULT_MAX_PART_BYTES - 16_000
MAX_STAGE_PART_BYTES = int(DEFAULT_MAX_PART_BYTES * 1.5)


def _json_bytes(payload: Any) -> int:
    return len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))


def _text_bytes(content: str) -> int:
    return _json_bytes(content) - 2


def _text_parts(content: str, budget: int | None = None) -> list[str]:
    """``content`` cut on line boundaries into pieces of at most ``budget`` bytes.

    The budget includes JSON escaping and UTF-8 bytes, not character counts.
    Joining the parts gives back ``content`` exactly. A single line longer than
    the budget -- NotebookLM's transcript can be one unbroken paragraph -- is
    cut between characters, since a part that overflows would be spilled.
    """
    budget = READ_PART_BYTES if budget is None else budget
    if budget < 8:
        raise ToolError("The text part budget must be at least 8 bytes.")
    parts: list[str] = []
    current: list[str] = []
    size = 0
    for line in content.splitlines(keepends=True):
        while _text_bytes(line) > budget:
            if current:
                parts.append("".join(current))
                current, size = [], 0
            low, high = 1, len(line)
            while low < high:
                middle = (low + high + 1) // 2
                if _text_bytes(line[:middle]) <= budget:
                    low = middle
                else:
                    high = middle - 1
            cut = low
            parts.append(line[:cut])
            line = line[cut:]
        line_size = _text_bytes(line)
        if current and size + line_size > budget:
            parts.append("".join(current))
            current, size = [], 0
        current.append(line)
        size += line_size
    if current or not parts:
        parts.append("".join(current))
    return parts


def _paged_review_payload(
    arguments: dict[str, Any],
    path: Path,
    content: str,
    route: str | None = None,
    contract: str | None = None,
) -> str:
    """The review payload, one part at a time when the text is long.

    Text that fits in one part keeps the plain ``{path, content}`` shape. Longer
    text carries ``part`` and ``parts`` and names the next call, so reading all
    of it is a sequence of whole results rather than one truncated one.

    ``contract`` rides on the first part only. A verbatim that already exists
    is read without calling start_draft again -- NotebookLM need not be asked
    twice -- and start_draft is otherwise the only thing that hands it over.
    """
    parts = _text_parts(content, arguments.get("_part_budget"))
    if len(parts) == 1:
        if contract is None:
            return _review_payload(path, content, route=route)
        whole = json.loads(_review_payload(path, content, route=route))
        return json.dumps({**whole, "contract": contract}, ensure_ascii=False)
    requested = arguments.get("part", 1)
    if (
        isinstance(requested, bool)
        or not isinstance(requested, int)
        or not 1 <= requested <= len(parts)
    ):
        raise ToolError(f"part must be an integer from 1 to {len(parts)}.")
    payload: dict[str, Any] = {
        "path": str(path),
        "part": requested,
        "parts": len(parts),
        "content": parts[requested - 1],
    }
    if route is not None:
        payload["route"] = route
    if contract is not None and requested == 1:
        payload["contract"] = contract
    if requested < len(parts):
        payload["next"] = (
            f"This is part {requested} of {len(parts)}. Call read_draft again with "
            f"part={requested + 1}; do not write from an incomplete text."
        )
    return json.dumps(payload, ensure_ascii=False)


def _read_part_budget(
    context: DraftContext, arguments: dict[str, Any], metadata: dict[str, Any]
) -> int:
    limit = arguments.get("_max_part_bytes", DEFAULT_MAX_PART_BYTES)
    available = (
        limit
        - _json_bytes(metadata)
        - max(16_000, arguments.get("_begin_overhead", 0))
        - 1024
    )
    if available < 8:
        raise ToolError(
            "--max-part-bytes is too small for the lecture metadata and contract."
        )
    manifest = json.loads(context.manifest_path.read_text(encoding="utf-8"))
    budget = manifest.get("read_part_bytes", available)
    if budget > available:
        # New boundary metadata can use the old conservative headroom without
        # changing a persisted page (and therefore an older staged guide).
        hard_available = limit - _json_bytes(metadata) - arguments.get("_begin_overhead", 0) - 1024
        if "read_part_bytes" in manifest and budget <= hard_available:
            return int(budget)
        if (
            context.path.is_file()
            or _staged_total(_staged_draft_directory(context)) is not None
        ):
            raise ToolError(
                "Resume this draft with the previous --max-part-bytes limit to preserve guide alignment."
            )
        budget = available
    if manifest.get("read_part_bytes") != budget:
        manifest["read_part_bytes"] = budget
        _atomic_write_text(
            context.manifest_path, json.dumps(manifest, ensure_ascii=False, indent=2)
        )
    return int(budget)


def _paging_metadata(context: DraftContext, workspace: Path) -> dict[str, Any]:
    return {
        "path": str(context.path),
        "paths": [str(path) for path in context.verbatim_sources],
        "route": "verbatim",
        "contract": _drafting_handoff(
            workspace, context.title, context.emoji, context.recording_sources
        ),
    }


def _write_part_budget(context: DraftContext, arguments: dict[str, Any]) -> int:
    manifest = json.loads(context.manifest_path.read_text(encoding="utf-8"))
    budget = manifest.get("write_part_bytes", arguments.get("_write_part_bytes", DEFAULT_WRITE_PART_BYTES))
    if isinstance(budget, bool) or not isinstance(budget, int) or budget < 1:
        raise ToolError("write_part_bytes must be a positive integer.")
    if "write_part_bytes" not in manifest:
        manifest["write_part_bytes"] = budget
        _atomic_write_text(context.manifest_path, json.dumps(manifest, ensure_ascii=False, indent=2))
    return budget


def _staged_alignment(context: DraftContext) -> str | None:
    directory = _staged_draft_directory(context)
    if _staged_total(directory) is None:
        return None
    path = directory / STAGED_ALIGNMENT_FILE
    # Older staged drafts predate independent write segments.
    return path.read_text(encoding="ascii").strip() if path.is_file() else "read"


def _segment_layout(
    alignment: str, total: int, budget: int, segments: list[str]
) -> dict[str, Any]:
    return {
        "version": 1,
        "alignment": alignment,
        "parts": total,
        "segment_bytes": budget,
        "segments": [
            {**boundary, "sha256": hashlib.sha256(segment.encode("utf-8")).hexdigest()}
            for boundary, segment in zip(segment_boundaries(segments), segments)
        ],
    }


def _staging_layout(context: DraftContext, total: int, alignment: str) -> dict[str, Any]:
    manifest = json.loads(context.manifest_path.read_text(encoding="utf-8"))
    if alignment == "merged":
        return _merged_plan(context, manifest.get("write_part_bytes", DEFAULT_WRITE_PART_BYTES)).layout
    paths = context.verbatim_sources or (context.path,)
    text = "\n\n".join(_read_review_draft(path) for path in paths if path.is_file())
    if alignment == "write":
        budget = manifest.get("write_part_bytes", DEFAULT_WRITE_PART_BYTES)
        segments = write_segments(text, budget)
    else:
        budget = manifest.get("read_part_bytes", READ_PART_BYTES)
        segments = _text_parts(text, budget)
    return _segment_layout(alignment, total, budget, segments)


def _read_staged_layout(directory: Path) -> Any:
    try:
        return json.loads((directory / STAGED_LAYOUT_FILE).read_text(encoding="utf-8"))
    except (FileNotFoundError, UnicodeError, json.JSONDecodeError):
        # Unrecorded or damaged layouts cannot establish safe resume boundaries.
        return None
    except OSError as error:
        raise ToolError(f"Could not read staged draft layout in {directory}: {error}") from error


def _saved_boundaries_path(context: DraftContext) -> Path:
    return context.module_root / ".transcriber-cache" / "saved-draft-boundaries" / f"{context.path.name}.json"


def _recover_staged_parts(context: DraftContext) -> None:
    directory = _staged_draft_directory(context)
    total, layout = _staged_total(directory), _read_staged_layout(directory)
    if total is None or not context.path.is_file() or layout is None:
        return
    missing = [part for part in range(1, total + 1) if not _staged_part_path(context, part).is_file()]
    if not missing or layout != _staging_layout(context, total, _staged_alignment(context) or "read"):
        return
    text = _read_review_draft(context.path)
    snapshot = _read_optional_json(_saved_boundaries_path(context))
    parts = exact_saved_parts(text, layout, snapshot)
    if parts is None and layout["alignment"] != "merged":
        parts = legacy_saved_parts(text, layout, SECTION_HEADINGS)
    if parts is None:
        return
    _write_recovered_parts(context, parts, missing)


def _write_recovered_parts(context: DraftContext, parts: list[str], missing: list[int]) -> None:
    for part in missing:
        # Exclusive creation also preserves a part sent while recovery was running.
        try:
            with _staged_part_path(context, part).open("x", encoding="utf-8") as recovered:
                recovered.write(parts[part - 1])
        except FileExistsError:
            continue
        except OSError as error:
            raise ToolError(f"Could not recover staged draft part {part}: {error}") from error


def _read_optional_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, UnicodeError, json.JSONDecodeError):
        return None
    except OSError as error:
        raise ToolError(f"Could not read draft recovery metadata {path}: {error}") from error


def _saved_draft_status(context: DraftContext, arguments: dict[str, Any]) -> dict[str, Any]:
    checks = _read_optional_json(_draft_checks_path(context.module_root, context.path))
    if not isinstance(checks, dict) or checks.get("sha256") != draft_fingerprint(_read_review_draft(context.path)):
        checks = {}
    checks.pop("sha256", None)
    total = _staged_total(_staged_draft_directory(context))
    status = json.loads(_staged_status(_staged_draft_directory(context), total, 0)) if total else {}
    status.pop("part_bytes", None)
    return {**status, "checks": checks, "next": _saved_draft_next(context, arguments, checks)}


def _saved_draft_next(context: DraftContext, arguments: dict[str, Any], checks: dict[str, Any]) -> str:
    call = json.dumps({key: arguments[key] for key in ("module", "manifest_path")}, ensure_ascii=False)
    failures = " ".join(f"{check} failed: {error}" for check, error in checks.items() if error)
    total = _staged_total(_staged_draft_directory(context))
    checking = f"Run validate_draft(module={arguments['module']!r}, draft={str(context.path)!r}) and verify_provenance(module={arguments['module']!r}, transcript={str(context.path)!r}); once both pass, call finalize with {call}, confirmed=true."
    if checks.get("validate_draft", False) is None and checks.get("verify_provenance", False) is None:
        return f"Both checks passed for this saved draft. Call finalize with {call}, confirmed=true."
    if total is None:
        repair = f"Read the saved draft, repair the reported findings with apply_review(content=<complete revised draft>) or stage_draft_part, then {checking}"
    else:
        repair = (
            "Use write_parts_with_agy(parts=[...]) to replace only the part named by the checks. "
            f"For question or badge findings, re-send only part {total} (sections 2–5) with stage_draft_part using {call}, part={total}, parts={total}, content=<corrected sections 2–5>. "
            f"For guide findings, re-send only the affected guide part using the same parts={total}. "
            f"Keep existing parts; call apply_review with {call}, from_parts=true, confirmed=true, then {checking}"
        )
    return (failures + " " if failures else checking + " ") + repair


def _archive_staged_draft(context: DraftContext) -> None:
    directory = _staged_draft_directory(context)
    archive = context.module_root / ".transcriber-cache" / "stale-staged" / str(time_ns())
    try:
        archive.mkdir(parents=True)
        directory.rename(archive / directory.name)
    except OSError as error:
        raise ToolError(f"Could not move aside stale staged draft {directory}: {error}") from error


def _reuse_staged_layout(context: DraftContext, layout: dict[str, Any]) -> str | None:
    directory = _staged_draft_directory(context)
    if not directory.exists():
        return None
    total = _staged_total(directory)
    if (
        total == layout["parts"]
        and _read_staged_layout(directory) == layout
        and _staged_alignment(context) == layout["alignment"]
    ):
        _recover_staged_parts(context)
        return None
    _archive_staged_draft(context)
    return f"moved aside: {total if total is not None else 'unknown'} parts from an older layout"


def _write_plan(context: DraftContext, arguments: dict[str, Any], text: str) -> dict[str, Any]:
    if len(context.recording_sources) != 1:
        plan = _merged_plan(context, _write_part_budget(context, arguments))
        stale = _reuse_staged_layout(context, plan.layout)
        return {"write_parts": len(plan.segments), "write_segments": plan.contexts, "write_alignment": "merged",
                **({"stale_staged_draft": stale} if stale else {})}
    budget = _write_part_budget(context, arguments)
    segments = write_segments(text, budget)
    layout = _segment_layout("write", len(segments) + 1, budget, segments)
    stale = _reuse_staged_layout(context, layout)
    return {
        "write_parts": len(segments),
        "write_segments": segment_boundaries(segments),
        "write_alignment": "write",
        **({"stale_staged_draft": stale} if stale else {}),
    }


def _read_draft(arguments: dict[str, Any], workspace: Path) -> str:
    context = _resolve_draft_context(arguments, workspace)
    _recover_staged_parts(context)
    if context.path.is_file():
        path, text, route = context.path, _read_review_draft(context.path), None
        metadata: dict[str, Any] = {
            "path": str(path),
            "contract": _drafting_handoff(
                workspace, context.title, context.emoji, context.recording_sources
            ),
        }
    else:
        paths = _complete_verbatim_paths(context)
        texts = [_read_review_draft(path) for path in paths]
        if len(paths) > 1:
            texts = [
                f"# Recording: {source} (cohort: {recording_identity(_recording_stem(source))[1]})\n\n{text}"
                for source, text in zip(context.recording_sources, texts)
            ]
        path, text, route = paths[0], "\n\n".join(texts), "verbatim"
        metadata = {"path": str(path), "route": route, "contract": VERBATIM_NEXT_STEP}
        if len(paths) > 1:
            metadata["paths"] = [str(path) for path in paths]
    paging_metadata = _paging_metadata(context, workspace)
    plan = _write_plan(context, arguments, text) if route == "verbatim" else {}
    paging_metadata.update(plan)
    budget = _read_part_budget(context, arguments, paging_metadata)
    payload = json.loads(
        _paged_review_payload(
            {**arguments, "_part_budget": budget},
            path,
            text,
            route=route,
            contract=VERBATIM_NEXT_STEP if route else None,
        )
    )
    if "paths" in metadata:
        payload["paths"] = metadata["paths"]
    if arguments.get("part", 1) == 1:
        payload.update(plan)
        if context.path.is_file():
            reading = payload.get("next", "")
            payload.update(_saved_draft_status(context, arguments))
            if reading:
                payload["next"] = reading + " " + payload["next"]
    return json.dumps(payload, ensure_ascii=False)


def _complete_verbatim_paths(context: DraftContext) -> tuple[Path, ...]:
    paths = context.verbatim_sources
    if not paths or len(paths) != len(context.recording_sources):
        raise ToolError(
            f"No draft exists at {context.path} and not every recording has a verbatim "
            "transcript for this lecture; run start_draft first."
        )
    return paths


def _guide_alignment(context: DraftContext, total: int) -> str:
    existing = _staged_alignment(context)
    if existing is not None:
        return existing
    if len(context.recording_sources) > 1:
        manifest = json.loads(context.manifest_path.read_text(encoding="utf-8"))
        plan = _merged_plan(context, manifest.get("write_part_bytes", DEFAULT_WRITE_PART_BYTES))
        if total == plan.layout["parts"]:
            return "merged"
    if len(context.recording_sources) == len(context.verbatim_sources) == 1:
        manifest = json.loads(context.manifest_path.read_text(encoding="utf-8"))
        segments = write_segments(_read_review_draft(context.verbatim_sources[0]), manifest.get("write_part_bytes", DEFAULT_WRITE_PART_BYTES))
        if total == len(segments) + 1:
            return "write"
    return "read"


def _aligned_verbatim_parts(context: DraftContext, total: int) -> list[str]:
    if len(context.recording_sources) != 1:
        return []
    if len(context.verbatim_sources) != 1:
        return []
    verbatim_path = context.verbatim_sources[0]
    manifest = json.loads(context.manifest_path.read_text(encoding="utf-8"))
    text = _read_review_draft(verbatim_path)
    if _guide_alignment(context, total) == "write":
        parts = write_segments(text, manifest.get("write_part_bytes", DEFAULT_WRITE_PART_BYTES))
        return parts if total == len(parts) + 1 else []
    parts = _text_parts(
        text,
        manifest.get("read_part_bytes", READ_PART_BYTES),
    )
    return parts if total > len(parts) else []


def _guide_part_counts(part: int, verbatim_text: str, content: str) -> dict[str, int]:
    verbatim_chars = _review_character_count(verbatim_text)
    return {
        "part": part, "guide_chars": _review_character_count(content),
        "verbatim_chars": verbatim_chars,
        "required_chars": ceil(verbatim_chars * MIN_VERBATIM_GUIDE_RATIO),
    }


def _staged_guide_counts(
    context: DraftContext, verbatim_parts: list[str]
) -> list[dict[str, int]]:
    return [
        _guide_part_counts(part, verbatim_text, _read_review_draft(path))
        for part, verbatim_text in enumerate(verbatim_parts, 1)
        if (path := _staged_part_path(context, part)).is_file()
    ]


def _short_guide_part_errors(context: DraftContext) -> list[str]:
    total = _staged_total(_staged_draft_directory(context))
    if total is None:
        return []
    counts = _staged_guide_counts(context, _aligned_verbatim_parts(context, total))
    shortfalls = [
        f"part {count['part']}: guide_chars={count['guide_chars']}, "
        f"verbatim_chars={count['verbatim_chars']}, "
        f"required_chars={count['required_chars']}, "
        f"missing_chars={count['required_chars'] - count['guide_chars']}"
        for count in counts
        if count["guide_chars"] < count["required_chars"]
    ]
    if not shortfalls:
        return []
    alignment = _guide_alignment(context, total)
    return [f"Short guide parts (aligned with verbatim {alignment} {'segments' if alignment == 'write' else 'parts'}):\n" + "\n".join(shortfalls)]


def _review_inputs(
    arguments: dict[str, Any], workspace: Path
) -> tuple[DraftContext, str | None, tuple[str, str] | None]:
    context = _resolve_draft_context(arguments, workspace)
    if context.path.is_file():
        return (
            context,
            _read_review_draft(context.path),
            _read_verbatim_baseline(context.verbatim_sources),
        )
    return context, None, _read_verbatim_baseline(_complete_verbatim_paths(context))


def _review_content(
    arguments: dict[str, Any], context: DraftContext, from_parts: bool
) -> str:
    if from_parts:
        return neutralize_guide_question_headings(_read_staged_draft(context))
    revised = arguments.get("content")
    if not isinstance(revised, str) or not revised.strip():
        raise ToolError("content must be a non-empty draft revision.")
    return neutralize_guide_question_headings(revised)


def _stage_draft_part(arguments: dict[str, Any], workspace: Path) -> str:
    context = _resolve_draft_context(arguments, workspace)
    _recover_staged_parts(context)
    total = _positive_part_argument(arguments, "parts")
    _write_part_budget(context, arguments)
    if "read_part_bytes" not in json.loads(context.manifest_path.read_text(encoding="utf-8")):
        _read_part_budget(context, arguments, _paging_metadata(context, workspace))
    existing_total = _staged_total(_staged_draft_directory(context))
    alignment = _guide_alignment(context, existing_total or total)
    layout = _staging_layout(context, existing_total or total, alignment)
    stale = _reuse_staged_layout(context, layout)
    if stale:
        alignment = _guide_alignment(context, total)
        layout = _staging_layout(context, total, alignment)
    existing_total = _staged_total(_staged_draft_directory(context))
    if existing_total is not None and existing_total != total:
        raise _wrong_staged_total(_staged_draft_directory(context), existing_total, total)
    part, total, content, part_bytes = _stage_part_inputs(arguments)
    directory = _write_staged_part(context, part, total, content)
    _atomic_write_text(directory / STAGED_ALIGNMENT_FILE, alignment)
    _atomic_write_text(directory / STAGED_LAYOUT_FILE, json.dumps(layout, ensure_ascii=False, indent=2))
    payload = json.loads(_staged_status(directory, total, part_bytes))
    if stale:
        payload["stale_staged_draft"] = stale
    if len(context.recording_sources) > 1:
        baseline = _read_verbatim_baseline(_complete_verbatim_paths(context))
        if baseline is not None:
            payload.update(_merged_guide_counts(context, baseline[0]))
        return json.dumps(payload, ensure_ascii=False)
    verbatim_parts = _aligned_verbatim_parts(context, total)
    if part <= len(verbatim_parts):
        counts = _staged_guide_counts(context, verbatim_parts)
        payload["guide_chars_so_far"] = sum(count["guide_chars"] for count in counts)
        payload["verbatim_chars_total"] = sum(
            _review_character_count(text) for text in verbatim_parts
        )
        short = [
            count
            for count in counts
            if count["part"] == part and count["guide_chars"] < count["required_chars"]
        ]
        if short:
            payload["short_guide_parts"] = short
            if alignment == "write":
                payload["write_segment"] = segment_boundaries(verbatim_parts)[part - 1]
                payload["next"] = (
                    f"Re-send part {part} with the doctor's complete explanation of "
                    f"write segment {part}; use its write_segments word range and anchors "
                    "from begin_lecture or read_draft part=1. Read part numbers are independent."
                )
            else:
                payload["next"] = (
                    f"Re-send part {part} with the doctor's complete explanation of "
                    f"verbatim part {part} (read it again with read_draft part={part} if needed)."
                )
    return json.dumps(payload, ensure_ascii=False)


def _agy_requested_parts(arguments: dict[str, Any], total: int, received: list[int]) -> list[int]:
    requested = arguments.get("parts")
    if requested is None:
        return [part for part in range(1, total + 1) if part not in received]
    if not isinstance(requested, list) or any(
        isinstance(part, bool) or not isinstance(part, int) or not 1 <= part <= total
        for part in requested
    ):
        raise ToolError(f"parts must be an array of integers from 1 to {total}.")
    return sorted(set(requested))


def _agy_slide_path(context: DraftContext) -> Path | None:
    if context.slides_path is not None:
        return context.slides_path
    from module_registry import load_module

    module = load_module(context.module_root)
    return _lecture_slide_path(module, context.title, context.recording_sources)


def _lecture_slide_path(module: Any, title: str, sources: tuple[str, ...]) -> Path | None:
    from module_registry import ModuleConfigError, configured_slide

    try:
        mapped = configured_slide(module, title)
    except ModuleConfigError:
        mapped = None
    slide = mapped or _matching_local_slide(module, title, sources)
    if slide is not None:
        return slide
    definition = manual_definition(module, title, sources)
    if definition:
        from lecture_registry import lecture_file

        return next((lecture_file(module, name) for name in definition.materials
                     if Path(name).suffix.casefold() in {".txt", ".md"}
                     and lecture_file(module, name).is_file()), None)
    return None


def _agy_slide_text(path: Path) -> str:
    """Best-effort reference extraction; optional slides must not block writing."""
    try:
        if path.suffix.casefold() in {".txt", ".md"}:
            return path.read_text(encoding="utf-8", errors="replace")
        if path.suffix.casefold() == ".pdf":
            extracted = subprocess.run(["pdftotext", "-layout", str(path), "-"],
                                       capture_output=True, text=True, encoding="utf-8",
                                       errors="replace", timeout=180)
            if extracted.returncode == 0:
                pages = extracted.stdout.split("\f")
                if pages and not pages[-1].strip():
                    pages.pop()
                return "\n\n".join(f"--- page {number} ---\n{text}" for number, text in enumerate(pages, 1))
            return ""
        if path.suffix.casefold() in {".pptx", ".ppsx"}:
            from pptx import Presentation

            return "\n\n".join(
                f"Slide {number}:\n" + "\n".join(shape.text for shape in slide.shapes if shape.has_text_frame)
                for number, slide in enumerate(Presentation(str(path)).slides, 1)
            )
    except (ImportError, OSError, ValueError, KeyError, zipfile.BadZipFile, subprocess.TimeoutExpired):
        return ""
    return ""


def _agy_slide_outline(context: DraftContext) -> str:
    from slide_figures import SLIDE_TEXT_NAME

    for directory in context.figure_directories:
        path = directory / SLIDE_TEXT_NAME
        if path.is_file():
            outline = _agy_slide_text(path)
            if outline.strip():
                return outline
    slide = _agy_slide_path(context)
    return _agy_slide_text(slide) if slide is not None else ""


def _agy_part_prompt(job: AgyDraftContext, part: int) -> str:
    context = job.draft
    handoff = DraftingHandoffContext(context.title, context.emoji, context.recording_sources)
    if part <= len(job.segments):
        previous = _staged_part_path(context, part - 1)
        figures = _cached_figures(context) or {}
        outline = _agy_slide_outline(context)
        scope = job.part_contexts[part - 1] if job.part_contexts else {}
        available = _agy_segment_figures(context, part, figures.get("figures", []), outline)
        if "slide_range" in scope:
            start, end = scope["slide_range"]
            available = [figure for figure in available if start <= figure["page"] <= end]
        return agy_writer.guide_prompt(handoff, job.module_title, job.segments[part - 1], {
            "part": part, "total": len(job.segments),
            "previous": _read_review_draft(previous) if previous.is_file() else "",
            "figures": available,
            "slide_outline": outline,
            **scope,
        })
    missing = [number for number in range(1, part) if not _staged_part_path(context, number).is_file()]
    if missing:
        raise ToolError(f"Stage guide parts {missing} before the questions part.")
    guide = "".join(_read_review_draft(_staged_part_path(context, number)) for number in range(1, part))
    questions = json.loads(_find_questions({
        **job.arguments, "lecture": context.title, "_max_part_bytes": DEFAULT_MAX_PART_BYTES,
    }, job.workspace))
    manifest = json.loads(context.manifest_path.read_text(encoding="utf-8"))
    return agy_writer.questions_prompt(handoff, job.module_title, questions, {
        "headings": "\n".join(re.findall(r"^#{2,6} .+$", guide, re.MULTILINE)),
        "exam_style_profile": manifest.get("exam_style_profile", {}),
        "observed_exam_style": _agy_observed_exam_style(job),
    })


def _agy_segment_figures(context: DraftContext, part: int, figures: list[dict[str, Any]], outline: str) -> list[dict[str, Any]]:
    from slide_figures import outline_pages

    linked: set[Path] = set()
    for number in range(1, part):
        path = _staged_part_path(context, number)
        if path.is_file():
            linked.update((context.path.parent / link.strip("<>")).resolve()
                          for link in re.findall(r"!\[[^\]]*\]\(<?([^\n]*?)>?\)", _read_review_draft(path)) if link)
    pages = outline_pages(outline)
    return [{**figure, "slide_text": pages.get(figure["page"], "")}
            for figure in figures
            if Path(figure["path"]).resolve() not in linked]


def _agy_observed_exam_style(job: AgyDraftContext) -> dict[str, Any]:
    from exam_index import INDEX_NAME, ExamIndexError
    from question_provenance import load_paper_backed_index

    questions_dir = job.draft.module_root / "Questions"
    if not (questions_dir / INDEX_NAME).is_file():
        return {}
    try:
        index = load_paper_backed_index(questions_dir, _module(job.arguments))
    except (ExamIndexError, OSError, ValueError, KeyError, TypeError) as error:
        raise ToolError(f"Could not read observed exam style: {error}. Rebuild with build_exam_index.") from error
    samples = [
        {"stem": question["stem"], "options": question["options"]}
        for question in index["questions"].values()
        if question["legible"] and question["options"]
    ][:8]
    return {"mcq": samples}


def _agy_write_checked(prompt: str, segment: str, part: int, arguments: dict[str, Any]) -> dict[str, Any]:
    model = arguments.get("model") or arguments.get("_agy_model", agy_writer.DEFAULT_MODEL)
    timeout = arguments.get("_agy_timeout", agy_writer.DEFAULT_TIMEOUT_SECONDS)
    written = agy_writer.write(prompt, model, timeout)
    counts = _guide_part_counts(part, segment, written.text)
    retried = counts["guide_chars"] < counts["required_chars"]
    seconds = written.seconds
    if retried:
        retry = (f"Your previous answer had {counts['guide_chars']} chars, the doctor's segment has "
                 f"{counts['verbatim_chars']}; restore the doctor's missing spoken points, examples, "
                 "stories, repetitions, exam tips, student questions and side remarks from THIS segment. "
                 "Do not add slide or textbook content to reach the length; do not invent or attribute "
                 "unspoken points to the doctor. Skip passages too garbled to understand. "
                 f"At least {counts['required_chars']} non-whitespace chars are required.")
        written = agy_writer.write(prompt + "\n\n" + retry, model, timeout)
        seconds += written.seconds
        counts = _guide_part_counts(part, segment, written.text)
        if counts["guide_chars"] < counts["required_chars"]:
            raise ToolError(f"agy part {part} remains short after one retry: {counts}. No replacement was staged.")
    return {"part": part, "chars": counts["guide_chars"], "required_chars": counts["required_chars"],
            "seconds": round(seconds, 2), "model": model, "retried": retried, "content": written.text}


def _merged_plan(context: DraftContext, budget: int) -> MergedPlan:
    paths = _complete_verbatim_paths(context)
    return merged_plan(context.recording_sources, [_read_review_draft(path) for path in paths], _agy_slide_outline(context), budget)


def _agy_draft_context(arguments: dict[str, Any], workspace: Path) -> AgyDraftContext:
    arguments = _module_by_display_name(arguments, workspace)
    module, _, _ = _resolve_manifest_context(arguments, workspace)
    context = _resolve_draft_context(arguments, workspace)
    paths = _complete_verbatim_paths(context)
    _recover_staged_parts(context)
    text = "\n\n".join(_read_review_draft(path) for path in paths)
    part_contexts = []
    if len(paths) == 1:
        _write_plan(context, arguments, text)
        segments = write_segments(text, _write_part_budget(context, arguments))
        floor_segments = segments
    else:
        plan = _merged_plan(context, _write_part_budget(context, arguments))
        segments, part_contexts = plan.segments, plan.contexts
        floor_segments = [""] * len(segments)
        _reuse_staged_layout(context, plan.layout)
    return AgyDraftContext(context, module.display_name, segments, floor_segments, arguments, workspace, part_contexts)


def _agy_stage_part(job: AgyDraftContext, part: int) -> dict[str, Any]:
    prompt = _agy_part_prompt(job, part)
    total = len(job.segments) + 1
    segment = job.floor_segments[part - 1] if part < total else ""
    summary = _agy_write_checked(prompt, segment, part, job.arguments)
    _stage_draft_part({
        **job.arguments, "part": part, "parts": total, "content": summary.pop("content"),
    }, job.workspace)
    return summary


def _write_parts_with_agy(arguments: dict[str, Any], workspace: Path) -> str:
    job = _agy_draft_context(arguments, workspace)
    total = len(job.segments) + 1
    directory = _staged_draft_directory(job.draft)
    requested = _agy_requested_parts(arguments, total, _staged_part_numbers(directory))
    staged: list[dict[str, Any]] = []
    failed_part = None
    error = None
    report_progress = arguments.get("_report_progress")
    done = len(set(_staged_part_numbers(directory)) - set(requested))
    for part in requested:
        if report_progress is not None:
            report_progress(done, total, f"part {part} of {total}")
        try:
            staged.append(_agy_stage_part(job, part))
            done += 1
            if report_progress is not None:
                report_progress(done, total, f"part {part} of {total} complete")
        except (agy_writer.AgyWriterError, ToolError, OSError, UnicodeError) as failure:
            failed_part, error = part, str(failure)
            break
    received = _staged_part_numbers(directory)
    missing = [part for part in range(1, total + 1) if part not in received]
    baseline = _read_verbatim_baseline(job.draft.verbatim_sources)
    report = json.dumps({
        "staged": staged, "received_parts": received, "missing_parts": missing,
        "total_parts": total, "failed_part": failed_part, "error": error,
        **({"merged_guide": _merged_guide_counts(job.draft, baseline[0])}
           if len(job.draft.recording_sources) > 1 and baseline is not None else {}),
        "next": (f"Resolve the error and call write_parts_with_agy with parts={[failed_part, *[part for part in missing if part != failed_part]]}."
                 if error else "Call write_parts_with_agy for the remaining missing parts."
                 if missing else "Call apply_review(module, manifest_path, from_parts=true, confirmed=true). " + CHECK_AND_FINALIZE_NEXT),
    }, ensure_ascii=False)
    if error:
        raise ToolError(report)
    return report


def _merged_guide_counts(context: DraftContext, baseline: str) -> dict[str, int]:
    directory = _staged_draft_directory(context)
    staged_text = "".join(
        _read_review_draft(_staged_part_path(context, part))
        for part in _staged_part_numbers(directory)
    )
    baseline_chars = _review_character_count(baseline)
    return {
        "guide_chars_so_far": _review_character_count(_section_body(staged_text, SECTION_HEADINGS[0])),
        "verbatim_chars_total": baseline_chars,
        "required_chars": ceil(baseline_chars * MIN_VERBATIM_GUIDE_RATIO),
    }


def _save_review(context: DraftContext, revised: str, from_parts: bool) -> None:
    try:
        _atomic_write_text(context.path, revised)
    except OSError as error:
        raise ToolError(f"Could not atomically write draft {context.path}: {error}") from error
    if from_parts and not context.verbatim_sources:
        directory = _staged_draft_directory(context)
        total = _staged_total(directory)
        if total is not None:
            layout = _staging_layout(context, total, _staged_alignment(context) or "read")
            _atomic_write_text(directory / STAGED_LAYOUT_FILE, json.dumps(layout, ensure_ascii=False, indent=2))
    elif not from_parts and _staged_draft_directory(context).exists():
        _archive_staged_draft(context)
    if from_parts:
        _record_saved_boundaries(context)


def _record_saved_boundaries(context: DraftContext) -> None:
    directory = _staged_draft_directory(context)
    total = _staged_total(directory)
    layout = _read_staged_layout(directory)
    if total is not None and layout is not None:
        parts = [_continuation_guide_text(part, _read_review_draft(_staged_part_path(context, part))) for part in range(1, total + 1)]
        _atomic_write_text(_saved_boundaries_path(context), json.dumps(saved_boundaries(parts, layout)))


def _apply_review(arguments: dict[str, Any], workspace: Path) -> str:
    from_parts = arguments.get("from_parts", False)
    if not isinstance(from_parts, bool):
        raise ToolError("from_parts must be a boolean when supplied.")
    if from_parts and "content" in arguments:
        raise ToolError("content must be absent when from_parts is true.")
    context, original, verbatim_baseline = _review_inputs(arguments, workspace)
    revised = _review_content(arguments, context, from_parts)
    errors = _complete_review_errors(
        original, revised, context, verbatim_baseline
    )
    if errors:
        if (
            from_parts
            and verbatim_baseline is not None
            and _verbatim_guide_error(verbatim_baseline[0], revised, verbatim_baseline[1])
            is not None
        ):
            errors.extend(_short_guide_part_errors(context))
        raise _review_refusal(context, revised, errors)
    conversation_id = _conversation_id(arguments)
    _save_review(context, revised, from_parts)
    warning = _record_review(context, conversation_id)
    if from_parts:
        return json.dumps({
            "path": str(context.path), "chars": _review_character_count(revised),
            "warning": warning, "next": CHECK_AND_FINALIZE_NEXT,
        }, ensure_ascii=False)
    return _review_payload(context.path, revised, warning)


def _finalize(arguments: dict[str, Any], workspace: Path) -> str:
    manifest = str(arguments.get("manifest_path", "")).strip()
    if not manifest:
        raise ToolError("manifest_path is required to finalize the matching draft.")
    context = _resolve_draft_context(arguments, workspace)
    output = _run(
        _launcher(workspace, "--module", _module(arguments),
                  "--source-manifest", manifest, "--finalize-draft"),
        workspace,
        DEFAULT_TIMEOUT_SECONDS,
    )
    try:
        _clear_staged_draft(context)
    except OSError as error:
        output += f"\nTranscript finalized, but staged parts could not be cleared: {error}"
    return output


def _agent_status(arguments: dict[str, Any], workspace: Path) -> str:
    from agent_backend import preflight_all

    results = preflight_all(workspace, live=bool(arguments.get("live")))
    return json.dumps(
        [
            {
                "name": result.name,
                "installed": result.installed,
                "authenticated": result.authenticated,
                "missing_allow_rules": list(result.missing_allow_rules),
                "ready": result.ready,
                "hint": result.hint,
            }
            for result in results
        ],
        ensure_ascii=False,
        indent=2,
    )


MODULE_PROPERTY = {
    "module": {"type": "string", "description": "Module id, e.g. toxo"},
    "workspace": {
        "type": "string",
        "description": (
            "Optional workspace assertion. It must resolve to the server's "
            "workspace; it never selects a different workspace."
        ),
    },
}
MANIFEST_PROPERTY = {
    "manifest_path": {
        "type": "string",
        "description": "Path to the ordered source manifest for this lecture unit",
    },
}
ENGINE_PROPERTY = {
    "engine": {
        "type": "string",
        "enum": list(ENGINE_NAMES),
        "default": NOTEBOOKLM_RAW,
        "description": (
            "Optional transcription backend. If omitted, use notebooklm-raw: "
            "the verbatim route that reads back what the doctor said and "
            "stops so the Agent can write the five sections from checkable "
            "source text. Do not use notebooklm or whisper unless the user "
            "names it. notebooklm runs the five-phase pipeline; whisper "
            "transcribes locally and is the only backend that can write "
            "timestamps (the CLI flag is --timestamps)."
        ),
    }
}


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="doctor",
        description=(
            "Check the external tooling the pipeline needs (nlm, poppler, "
            "ocrmypdf, libreoffice, ghostscript, ffmpeg). Pass live to also "
            "prove nlm is authenticated and probe the optional agy writer's sign-in/model. "
            "Returns structured JSON. Call it when another tool has failed "
            "on a missing tool or an expired session, not as a first step: "
            "the app checks readiness itself, and a live probe on every "
            "question is a NotebookLM round trip the answer does not need."
        ),
        properties={"live": {"type": "boolean"}},
        handler=_doctor,
    ),
    Tool(
        name="agent_status",
        description=(
            "Report which agent CLI backends (antigravity, claude-code, "
            "codex) are installed, signed in, and permitted to run."
        ),
        properties={"live": {"type": "boolean"}},
        handler=_agent_status,
    ),
    Tool(
        name="workspace_info",
        description=(
            "Report the absolute workspace this server serves, whether it "
            "exists, and whether it has a modules/ folder. Read-only."
        ),
        properties={},
        handler=_workspace_info,
    ),
    Tool(
        name="list_modules",
        description=(
            "List the configured modules and their NotebookLM notebooks, "
            "alongside the workspace this server serves."
        ),
        properties={},
        handler=_list_modules,
    ),
    Tool(
        name="list_library",
        description="Read every module and its lecture listing with isolated errors and question-index status. Uses cached inventories by default; at most four notebooks are fetched concurrently.",
        properties={"remote": {"type": "string", "enum": ["cached", "refresh", "skip"], "default": "cached"}},
        handler=_list_library,
    ),
    Tool(
        name="list_lectures",
        description=(
            "List a module's lectures (recordings, plus finished transcripts "
            "whose recording is gone) and, separately, its reference materials "
            "-- slides, textbooks and papers that are never transcribed. Use "
            "this rather than listing the folder: it groups a lecture split "
            "across files into one unit and counts recordings that live only "
            "in the notebook, neither of which a directory listing can show."
        ),
        properties={**MODULE_PROPERTY, "refresh": {"type": "boolean", "default": False}},
        handler=_list_lectures,
        required=("module",),
    ),
    Tool(
        name="build_exam_index",
        description=(
            "Index the module's exam papers into Questions/exam-index.json: "
            "each file's kind, the years it covers, and how many questions it "
            "holds. Run it before drafting questions -- it is what lets a "
            "question carry an honest [Past Exams - <year>] badge. Never write "
            "this file by hand."
        ),
        properties=dict(MODULE_PROPERTY),
        handler=_build_exam_index,
        required=("module",),
    ),
    Tool(
        name="find_questions",
        description=("Read-only: return complete exam-index entries ranked for this lecture using its title, local slide/verbatim key terms, and optional terms. Includes exact stem, badge and source_papers paths/sections/years resolved from real papers by the same provenance rules as verify_provenance. Copy stem, badge and every source_lines line verbatim, including short topic stems. Source lines must be **Source:** Questions/<paper filename> inside the question block. Capped at 50 entries and the server payload byte limit, with total/matched/returned/omitted counts. Use once instead of grep and read slices of exam-index.json; review relevance against the taught lecture."),
        properties={**MODULE_PROPERTY, "lecture": {"type": "string"}, "terms": {"type": "array", "items": {"type": "string"}}},
        handler=_find_questions,
        required=("module", "lecture"),
    ),
    Tool(
        name="validate_draft",
        description=(
            "Run every check finalizing runs over a draft -- section "
            "structure, callouts, leaked engine text, year badges, IMP exam style/length, "
            "Source fields and source/year evidence -- and "
            "write nothing. Call it after writing the sections and before "
            "finalize: finalize validates too, but it also writes the "
            "student's transcript, and this is how to be sure first. It "
            "reports what is wrong; it never repairs anything."
        ),
        properties={
            **MODULE_PROPERTY,
            "manifest_path": {"type": "string", "description": "The exact manifest used by finalize; otherwise resolve the draft's cached lecture manifest."},
            "draft": {
                "type": "string",
                "description": (
                    "The draft's file name, as start_draft reported it, e.g. "
                    "'Corrosives 🧪.md.draft.md'"
                ),
            },
        },
        handler=_validate_draft,
        required=("module", "draft"),
    ),
    Tool(
        name="verify_provenance",
        description=(
            "Hold every [Past Exams - YYYY] badge in a transcript against the "
            "papers the module actually has, using the exam index. A badge is "
            "a promise to a student revising by it, so this is a gate before "
            "finalize, not a courtesy -- and it is a separate check from "
            "validate_draft. Reports unbacked years; changes nothing."
        ),
        properties={
            **MODULE_PROPERTY,
            "manifest_path": {"type": "string", "description": "The exact manifest used by finalize; otherwise resolve the draft's cached lecture manifest."},
            "transcript": {
                "type": "string",
                "description": (
                    "The draft or finished transcript's file name, e.g. "
                    "'Corrosives 🧪.md'"
                ),
            },
        },
        handler=_verify_provenance,
        required=("module", "transcript"),
    ),
    Tool(
        name="extract_figures",
        description=(
            "Render the slides that carry a picture out of a lecture's deck "
            "into Transcripts/Figures/<lecture>/, and return the markdown "
            "lines that link them. Pages that are only text are skipped. Call "
            "it before writing the sections, and link only the files it "
            "reports -- a figure reference to a file it did not produce is a "
            "broken image in the student's transcript."
        ),
        properties={
            **MODULE_PROPERTY,
            "lecture": {
                "type": "string",
                "description": (
                    "Lecture title. Its deck is taken from module.json's "
                    "lecture_slides; pass 'slides' as well when none is "
                    "configured."
                ),
            },
            "slides": {
                "type": "string",
                "description": (
                    "Path to the deck (.pptx or .pdf), relative to the module "
                    "folder, e.g. Lecture/corrosives.pptx"
                ),
            },
        },
        handler=_extract_figures,
        required=("module",),
    ),
    Tool(
        name="audit_sources",
        description=(
            "Read-only comparison of a module's local files against its "
            "NotebookLM inventory. Writes nothing; run before apply_sync."
        ),
        properties=dict(MODULE_PROPERTY),
        handler=_audit_sources,
        required=("module",),
    ),
    Tool(
        name="create_module",
        description=(
            "Create a module's folders and its NotebookLM notebook. "
            "Destructive: needs explicit user confirmation."
        ),
        properties={**MODULE_PROPERTY, "display_name": {"type": "string"}},
        handler=_create_module,
        required=("module",),
        requires_confirmation=True,
    ),
    Tool(
        name="apply_sync",
        description=(
            "Execute an approved sync manifest: uploads, replaces and deletes "
            "sources on NotebookLM. Destructive: needs explicit confirmation."
        ),
        properties={**MODULE_PROPERTY, **MANIFEST_PROPERTY},
        handler=_apply_sync,
        required=("module", "manifest_path"),
        requires_confirmation=True,
    ),
    Tool(
        name="upload_recordings",
        description=(
            "Upload only the named local recordings under the module's Lecture/ to its "
            "NotebookLM notebook after the student agrees. No deletes or replacements. "
            "Already uploaded files are reused. Waits for readiness with a timeout; "
            "if still processing, retry the same call to check readiness before begin_lecture."
        ),
        properties={**MODULE_PROPERTY, "files": {
            "type": "array", "items": {"type": "string"}, "minItems": 1,
            "description": "Exact recording paths returned by begin_lecture, or names under Lecture/.",
        }},
        handler=_upload_recordings,
        required=("module", "files"),
        requires_confirmation=True,
    ),
    Tool(
        name="begin_lecture",
        description=(
            "Recommended first call to transcribe a lecture: resolve its module and "
            "recording unit, reuse or prepare its manifest and exam index, and return "
            "an agy writer handoff when available, otherwise part 1 with the drafting contract "
            "and exact next call. Reuses an existing "
            "draft or complete verbatims; otherwise starts the default notebooklm-raw "
            "engine, fetching only missing recordings. Pass redo=true for a finished lecture; "
            "stale drafts are archived once, and finalize archives the old transcript. "
            "Also returns cached or newly extracted figures and nonfatal extraction errors. "
            "An existing saved draft recovers missing staged parts from a matching layout "
            "and returns staged status plus a check/repair next call, including known check failures. "
            "Missing question banks do not block the lecture. If local recordings need uploading, "
            "uploads them automatically: starting the lecture is confirmation. Reports uploaded names; "
            "needs_upload means upload failed or processing timed out, with exact files and reason. "
            "Use find_questions for complete relevant entries. Long-running."
        ),
        properties={
            **MODULE_PROPERTY,
            "lecture": {"type": "string", "description": "Lecture title as the library reports it"},
            "redo": {"type": "boolean", "default": False, "description": "Explicitly transcribe again; archive the existing transcript on finalize and resume this redo after errors."},
        },
        handler=_begin_lecture,
        required=("module", "lecture"),
    ),
    Tool(
        name="prepare_manifest",
        description=(
            "Build the ordered source manifest a transcription needs, for one "
            "lecture, and return its path. start_draft, read_draft, "
            "apply_review and finalize all require that path. Call this first "
            "and pass what it returns -- never write a manifest by hand. "
            "Pass redo=true to transcribe a finished lecture again safely."
        ),
        properties={
            **MODULE_PROPERTY,
            "lecture": {
                "type": "string",
                "description": "Lecture title as list_lectures reports it",
            },
            "redo": {"type": "boolean", "default": False, "description": "Explicitly transcribe again; preserve the existing transcript and resume this redo after errors."},
        },
        handler=_prepare_manifest,
        required=("module", "lecture"),
    ),
    Tool(
        name="start_draft",
        description=(
            "Start a lecture transcription. The default is notebooklm-raw, "
            "the verbatim route: it returns what was said and writes a "
            "Verbatim/*.verbatim.md file for the Agent to turn into the five "
            "sections. Do not select notebooklm or whisper unless the user "
            "explicitly names that backend. notebooklm runs the five-phase "
            "pipeline and writes a .draft.md; whisper transcribes locally "
            "and is the only route with timestamps. The result is JSON with "
            "the engine, route, output path, engine output, and the drafting "
            "rules. Long-running. Do NOT go looking for the transcript format "
            "before calling this: the exact headings and every rule a draft is "
            "checked against come back in the result, and none of them are "
            "needed until the verbatim text exists. Reading an old transcript "
            "to infer the format wastes a round trip and risks copying a "
            "mistake."
        ),
        properties={**MODULE_PROPERTY, **MANIFEST_PROPERTY, **ENGINE_PROPERTY},
        handler=_start_draft,
        required=("module", "manifest_path"),
    ),
    Tool(
        name="drafting_reference",
        description=(
            "The full editorial reference for writing a transcript: section-by-"
            "section guidance, question formats, OCR handling and the figure "
            "rules. Call it once when writing; start_draft carries the rules a "
            "draft is validated against, and this is the rest."
        ),
        properties={},
        handler=_drafting_reference,
        required=(),
    ),
    Tool(
        name="read_draft",
        description=(
            "Read the evidence-rich .draft.md for editorial review and return "
            "its absolute path with its text. If the selected start_draft run "
            "used a verbatim backend, return that .verbatim.md instead and "
            "mark the result as route=verbatim. Run start_draft first. A long "
            "text comes back in parts: the result then carries part and parts, "
            "and every part must be read before writing. The server --max-part-bytes "
            "limit defaults to 240000 bytes for the complete JSON payload. On the verbatim route, "
            "part 1 includes independent write_parts and write_segments word ranges/anchors "
            "for a single recording (default 18000 source UTF-8 bytes per write segment). "
            "Stage guide part k for write segment k with parts=write_parts+1; "
            "the last part contains sections 2–5. Then save them with "
            "apply_review(from_parts=true). For a saved draft with a matching staged layout, "
            "recover missing staged parts and report their status and the repair next call on part 1."
        ),
        properties={
            **MODULE_PROPERTY,
            **MANIFEST_PROPERTY,
            "part": {"type": "integer", "minimum": 1},
        },
        handler=_read_draft,
        required=("module", "manifest_path"),
    ),
    Tool(
        name="write_parts_with_agy",
        description="Write and stage missing guide segments and sections 2–5 through the authenticated agy CLI. Returns compact counts, never long text. Long-running, like start_draft; allow a three-hour client call timeout. Explicit parts replace those parts; default skips staged parts. Stops on failure and preserves progress.",
        properties={**MODULE_PROPERTY, **MANIFEST_PROPERTY,
                    "parts": {"type": "array", "items": {"type": "integer", "minimum": 1}},
                    "model": {"type": "string", "description": "Optional agy model override"}},
        handler=_write_parts_with_agy, required=("module", "manifest_path"),
    ),
    Tool(
        name="stage_draft_part",
        description=(
            "Store one part of the complete draft under the module cache. "
            "Parts may arrive out of order or be replaced; call apply_review "
            "with from_parts=true after every part is present."
            " Saved parts persist until finalize: after a failed check, replace only "
            "the affected part using the same parts total and save from_parts again."
            " Missing parts from a matching layout are recovered from the saved draft; "
            "existing parts are kept. Wrong totals report the required parts count and existing parts."
            " For a single recording, use parts=write_parts+1: guide part k covers "
            "write segment k, and the last part contains sections 2–5. Read paging is independent. "
            "Aligned guide parts report shortfalls and running character totals. "
            "Older staged drafts retain verbatim read-part alignment."
        ),
        properties={
            **MODULE_PROPERTY,
            **MANIFEST_PROPERTY,
            "part": {"type": "integer", "minimum": 1},
            "parts": {"type": "integer", "minimum": 1},
            "content": {
                "type": "string",
                "description": "One non-empty part of the complete revised draft",
            },
        },
        handler=_stage_draft_part,
        required=("module", "manifest_path", "part", "parts", "content"),
    ),
    Tool(
        name="apply_review",
        description=(
            "Atomically replace the lecture's .draft.md with the reviewed "
            "text only after complete-transcript validation; rejected text is "
            "preserved in the module cache. On the verbatim route, write parts "
            "with write_parts_with_agy (or stage_draft_part) and pass from_parts=true. "
            "Returns compact path/count status for staged parts. Destructive: needs "
            "explicit confirmation."
            " Successful from_parts saves retain every staged part and layout until finalize. "
            "To repair a failed check, replace only the affected part with the same parts total "
            "and save from_parts again. Inline full-content replacements move older staged parts aside."
            " Guide-ratio refusals from aligned staged parts identify each short guide part."
        ),
        properties={
            **MODULE_PROPERTY,
            **MANIFEST_PROPERTY,
            "content": {
                "type": "string",
                "description": "The complete revised draft text, not a summary",
            },
            "conversation_id": {
                "type": "string",
                "description": "Optional chat conversation id for ledger resume",
            },
            "from_parts": {
                "type": "boolean",
                "description": (
                    "Join staged parts instead of content; content must be absent"
                ),
            },
        },
        handler=_apply_review,
        required=("module", "manifest_path"),
        requires_confirmation=True,
    ),
    Tool(
        name="finalize",
        description=(
            "Commit a reviewed draft to the final transcript and update "
            "Index.md. Destructive: needs explicit user confirmation."
        ),
        properties={**MODULE_PROPERTY, **MANIFEST_PROPERTY},
        handler=_finalize,
        required=("module", "manifest_path"),
        requires_confirmation=True,
    ),
)

_FILE_ARRAY = {"type": "array", "items": {"type": "string"}}
_REGISTRY_TOOLS: tuple[tuple[str, str, dict[str, Any], tuple[str, ...]], ...] = (
    ("define_lecture", "Create or update an explicit lecture with ordered recordings and materials. Missing local recordings must be verified NotebookLM source titles.",
     {"title": {"type": "string"}, "recordings": _FILE_ARRAY, "materials": _FILE_ARRAY, "id": {"type": "string"}}, ("title", "recordings", "materials")),
    ("set_general_materials", "Set module-wide material names relative to Lecture/, removing them from lecture definitions. Replaces the general list; does not change files or NotebookLM.",
     {"materials": _FILE_ARRAY}, ("materials",)),
    ("hide_lecture", "Hide a lecture's recordings and remove its definition without changing files, NotebookLM sources or transcripts. Use a manual id for ambiguous titles.",
     {"title": {"type": "string"}}, ("title",)),
    ("restore_recordings", "Restore hidden recording names without changing files, NotebookLM sources or recreating a manual definition.",
     {"recordings": _FILE_ARRAY}, ("recordings",)),
    ("delete_lecture", "Remove a lecture definition only; its files remain available for automatic grouping.", {"id": {"type": "string"}}, ("id",)),
    ("import_file", "Copy a selected file into Lecture/ or Questions/. Refuses overwrites unless replace=true.",
     {"source_path": {"type": "string"}, "kind": {"type": "string", "enum": ["recording", "material", "question"]}, "name": {"type": "string"}, "replace": {"type": "boolean", "default": False}}, ("source_path", "kind")),
    ("rename_file", "Rename an existing module file and update lecture references. path is relative to the module, including Lecture/ or Questions/.",
     {"path": {"type": "string"}, "new_name": {"type": "string"}}, ("path", "new_name")),
    ("remove_file", "Move a module file into .transcriber-cache/trash/ and drop its lecture references. path includes Lecture/ or Questions/.",
     {"path": {"type": "string"}}, ("path",)),
    ("list_module_files", "Read every Lecture/ and Questions/ file with size, kind, lecture ownership and NotebookLM presence; offline inventory uses the last cache plus a warning, or null without a cache.", {"refresh": {"type": "boolean", "default": False}}, ()),
)
def _registry_handler(operation: str) -> Callable[[dict[str, Any], Path], str]:
    def invoke(arguments: dict[str, Any], workspace: Path) -> str:
        return _registry_operation(arguments, workspace, operation)
    return invoke


TOOLS += tuple(
    Tool(name=name, description=description, properties={**MODULE_PROPERTY, **properties},
         handler=_registry_handler(name),
         required=("module", *required), requires_confirmation=name not in {"list_module_files", "set_general_materials"})
    for name, description, properties, required in _REGISTRY_TOOLS
)

TOOLS += (
    Tool(name="propose_organization", description="Read-only lecture organization proposal through agy, with validated local paths and deterministic fallback. Cached until inventory changes or refresh=true.",
         properties={**MODULE_PROPERTY, "refresh": {"type": "boolean", "default": False}},
         handler=_propose_organization, required=("module",)),
    Tool(name="apply_organization", description="Atomically apply reviewed lecture definitions. Keeps omitted manual definitions unless replace_existing=true. Requires student confirmation.",
         properties={**MODULE_PROPERTY, "lectures": {"type": "array", "items": {
             "type": "object", "properties": {"title": {"type": "string"}, "recordings": _FILE_ARRAY, "materials": _FILE_ARRAY, "id": {"type": "string"}},
             "required": ["title", "recordings", "materials"]}}, "replace_existing": {"type": "boolean", "default": False}, "general": _FILE_ARRAY},
         handler=_registry_handler("apply_organization"), required=("module", "lectures"), requires_confirmation=True),
)

TOOLS += (
    Tool(name="remove_transcript", description="Move selected final, draft or verbatim outputs to one restorable trash entry. Final also moves figures and Anki outputs and removes its index row. Recordings, definitions and NotebookLM remain unchanged. Refuses a running module.",
         properties={**MODULE_PROPERTY, "lecture": {"type": "string"}, "kinds": {"type": "array", "minItems": 1, "uniqueItems": True,
             "items": {"type": "string", "enum": ["final", "draft", "verbatim"]}}},
         handler=_trash_handler("remove_transcript"), required=("module", "lecture", "kinds"), requires_confirmation=True),
    Tool(name="list_trash", description="List restorable module files, transcript outputs and hidden lectures, newest first. No automatic purge.",
         properties=MODULE_PROPERTY, handler=_trash_handler("list_trash"), required=("module",)),
    Tool(name="restore_trash", description="Restore one module trash entry without overwriting any occupied destination. Hidden lectures restore their recordings without recreating definitions.",
         properties={**MODULE_PROPERTY, "id": {"type": "string"}}, handler=_trash_handler("restore_trash"), required=("module", "id"), requires_confirmation=True),
    Tool(name="remove_module", description="Move a whole module to the workspace trash, refusing a running job. Its NotebookLM notebook and sources are never changed.",
         properties=MODULE_PROPERTY, handler=_trash_handler("remove_module"), required=("module",), requires_confirmation=True),
    Tool(name="restore_module", description="Restore a removed module by trash_id. Refuses when that module id exists again; NotebookLM is not changed.",
         properties={"trash_id": {"type": "string"}}, handler=_trash_handler("restore_module"), required=("trash_id",), requires_confirmation=True),
    Tool(name="list_removed_modules", description="List removed modules in the workspace trash, newest first, without reading or changing NotebookLM.",
         properties={}, handler=_trash_handler("list_removed_modules")),
)

TOOLS_BY_NAME = {tool.name: tool for tool in TOOLS}


# --- JSON-RPC ---------------------------------------------------------------


@dataclass
class Server:
    workspace: Path
    stdout: Any = field(default_factory=lambda: sys.stdout)
    max_part_bytes: int = DEFAULT_MAX_PART_BYTES
    write_part_bytes: int = DEFAULT_WRITE_PART_BYTES
    agy_model: str = agy_writer.DEFAULT_MODEL
    agy_timeout: int = agy_writer.DEFAULT_TIMEOUT_SECONDS

    def _write(self, payload: dict[str, Any]) -> None:
        self.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.stdout.flush()

    def _result(self, request_id: Any, result: dict[str, Any]) -> None:
        self._write({"jsonrpc": "2.0", "id": request_id, "result": result})

    def _error(self, request_id: Any, code: int, message: str) -> None:
        self._write(
            {"jsonrpc": "2.0", "id": request_id,
             "error": {"code": code, "message": message}}
        )

    def handle(self, message: dict[str, Any]) -> None:
        method = str(message.get("method", ""))
        request_id = message.get("id")
        # A notification has no id and must never be answered.
        if request_id is None:
            return
        if method == "initialize":
            self._result(request_id, {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": _version()},
            })
            return
        if method == "ping":
            self._result(request_id, {})
            return
        if method == "tools/list":
            self._result(request_id, {
                "tools": [
                    {
                        "name": tool.name,
                        "description": tool.description,
                        "inputSchema": tool.schema(),
                    }
                    for tool in TOOLS
                ]
            })
            return
        if method == "tools/call":
            self._call(request_id, message.get("params") or {})
            return
        self._error(request_id, -32601, f"Unknown method: {method}")

    def _call(self, request_id: Any, params: dict[str, Any]) -> None:
        workspace = self.workspace
        name = str(params.get("name", ""))
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            arguments = {}
        tool = TOOLS_BY_NAME.get(name)
        if tool is None:
            self._error(request_id, -32602, f"Unknown tool: {name}")
            return
        try:
            if "module" in tool.properties:
                _assert_workspace(arguments, workspace)
                if name != "create_module":
                    arguments = _module_by_display_name(arguments, workspace)
        except ToolError as error:
            self._tool_result(request_id, str(error), is_error=True)
            return
        if tool.requires_confirmation and arguments.get("confirmed") is not True:
            self._tool_result(request_id, CONFIRMATION_REQUIRED, is_error=True)
            return
        meta = params.get("_meta")
        token = meta.get("progressToken") if isinstance(meta, dict) else None
        arguments = {**arguments, "_report_progress": None}
        if isinstance(token, (str, int, float)) and not isinstance(token, bool):
            def report_progress(done: int, total: int, message: str) -> None:
                self._write({"jsonrpc": "2.0", "method": "notifications/progress", "params": {
                    "progressToken": token, "progress": done, "total": total, "message": message,
                }})
            arguments["_report_progress"] = report_progress
        try:
            from contextlib import nullcontext

            from module_activity import module_activity

            removals = {"remove_file", "hide_lecture", "remove_transcript", "remove_module", "restore_module", "restore_trash"}
            activity = module_activity(_registry_module(arguments, workspace)) if "module" in tool.properties and name not in removals | {"create_module"} else nullcontext()
            with activity:
                output = self._invoke_tool(tool, arguments, workspace)
        except ToolError as error:
            self._tool_result(request_id, str(error), is_error=True)
            return
        except Exception as error:  # noqa: BLE001 - a tool must not kill the server
            self._tool_result(request_id, f"Unexpected failure: {error}", is_error=True)
            return
        self._tool_result(request_id, output)

    def _invoke_tool(self, tool: Tool, arguments: dict[str, Any], workspace: Path) -> str:
        return tool.handler({**arguments, "_max_part_bytes": self.max_part_bytes, "_write_part_bytes": self.write_part_bytes,
                             "_agy_model": self.agy_model, "_agy_timeout": self.agy_timeout}, workspace)

    def _tool_result(self, request_id: Any, text: str, is_error: bool = False) -> None:
        self._result(request_id, {
            "content": [{"type": "text", "text": text}],
            "isError": is_error,
        })

    def serve(self, stream: Any) -> int:
        for line in stream:
            text = line.strip()
            if not text:
                continue
            try:
                message = json.loads(text)
            except json.JSONDecodeError:
                self._error(None, -32700, "Parse error")
                continue
            if isinstance(message, dict):
                self.handle(message)
            else:
                # Valid JSON that is not a request object -- a batch array is
                # the realistic case. Answering keeps a strict client from
                # waiting forever for a reply that would never come.
                self._error(None, -32600, "Invalid Request: expected a JSON object")
        return 0


def _version() -> str:
    from version_checker import __version__

    return __version__


def main() -> int:
    import argparse

    configure_console_streams()
    parser = argparse.ArgumentParser(description=__doc__)
    from library_workspace import prepare_workspace, workspace_path

    parser.add_argument("--workspace", default=str(workspace_path()))
    parser.add_argument(
        "--max-part-bytes",
        type=int,
        default=DEFAULT_MAX_PART_BYTES,
        help="Maximum UTF-8 bytes for a complete begin_lecture/read_draft JSON payload (default: 240000)",
    )
    parser.add_argument(
        "--write-part-bytes", type=int, default=DEFAULT_WRITE_PART_BYTES,
        help="Target verbatim UTF-8 bytes per guide write segment; persisted per manifest (default: 18000)",
    )
    parser.add_argument("--agy-model", default=agy_writer.DEFAULT_MODEL)
    parser.add_argument("--agy-timeout", type=int, default=agy_writer.DEFAULT_TIMEOUT_SECONDS, help="Timeout in seconds per agy part (default: 600)")
    arguments = parser.parse_args()
    if arguments.max_part_bytes < 2048:
        parser.error("--max-part-bytes must be at least 2048")
    if arguments.write_part_bytes < 1:
        parser.error("--write-part-bytes must be positive")
    if arguments.agy_timeout < 1:
        parser.error("--agy-timeout must be positive")
    server = Server(
        workspace=prepare_workspace(Path(arguments.workspace)),
        max_part_bytes=arguments.max_part_bytes,
        write_part_bytes=arguments.write_part_bytes,
        agy_model=arguments.agy_model, agy_timeout=arguments.agy_timeout,
    )
    return server.serve(sys.stdin)


if __name__ == "__main__":
    sys.exit(dispatch_entrypoint(sys.argv[1:], "mcp-server", main))
