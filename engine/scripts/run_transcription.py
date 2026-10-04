#!/usr/bin/env python3
"""Resolve one module and run its NotebookLM transcription pipeline."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import unicodedata
from collections.abc import Callable, Iterator
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # imported lazily at runtime, so only the checker sees it
    from question_bank import BankQuestion, QuestionBank

import events
from console import configure_console_streams
from engine_dispatch import build_entrypoint_command

# Names only. The engine modules themselves stay lazy, so an optional
# dependency is never imported by a run that does not use it.
from engines import ENGINE_NAMES, NOTEBOOKLM_RAW, TRANSCRIPTION_ENGINES
from exam_years import extract_filename_exam_years
from file_lock import exclusive_file_lock
from module_registry import (
    ModuleConfig,
    ModuleConfigError,
    configured_slide,
    discover_modules,
    normalize_module_name,
    resolve_module,
)
from recording_grouping import _group_recordings
from transcript_matching import (
    RECORDING_EXTENSIONS,
    matching_transcripts,
    module_final_transcripts,
    transcript_assignments,
)
from version_checker import __version__

# Configure the console at import, not just in main(). Every print() in this
# module can carry Arabic or an emoji filename, and callers that import it as a
# library -- the test suite, an embedding agent -- never reach main() to have
# the streams fixed for them. On a cp1252 Windows console those calls raise
# UnicodeEncodeError; on POSIX this is a no-op.
configure_console_streams()

# Wall-clock ceilings for the engine subprocess. The engine checkpoints every
# phase, so a run stopped at the ceiling resumes with --resume-latest rather than
# starting over. Generous by design: five NotebookLM phases plus OCR and slide
# conversion are legitimately slow.
AUDIT_TIMEOUT_SECONDS = 30 * 60
TRANSCRIPTION_TIMEOUT_SECONDS = 4 * 60 * 60


class LauncherError(RuntimeError):
    """Raised when automatic discovery cannot make one safe choice."""


@dataclass(frozen=True)
class RecordingSelection:
    engine: ModuleType
    recordings: list[Any]
    transcripts_dir: Path
    requested: str | None
    run_all: bool


@dataclass(frozen=True)
class EngineInvocation:
    engine_path: Path
    module: ModuleConfig
    notebook_ids: tuple[str, ...]
    recording: Any
    slides_path: Path | None
    additional_recordings: tuple[Any, ...] = ()
    approved_uploads: tuple[str, ...] = ()
    title: str | None = None
    exam_style_profile: dict[str, Any] | None = None
    assessment_sources: tuple[dict[str, Any], ...] = ()
    assessment_manifest_provided: bool = False
    draft_only: bool = False
    finalize_draft: bool = False
    source_manifest_path: str | None = None
    resume_run: str | None = None
    resume_latest: bool = False
    retry_phase: str | None = None
    recovery_phase: str | None = None
    recovery_response: str | None = None
    json_events: bool = False


@dataclass(frozen=True)
class SourceManifest:
    title: str
    recording_sources: tuple[str, ...]
    slides: str | None
    approved_uploads: tuple[str, ...]
    exam_style_profile: dict[str, Any]
    slides_action: str = "auto"
    assessment_sources: tuple[dict[str, Any], ...] = ()
    references: tuple[dict[str, Any], ...] = ()
    manifest_path: str | None = None


@dataclass(frozen=True)
class LauncherContext:
    """Everything a run needs, with the notebook resolved only if it is used.

    Resolving the notebook is a network call against the student's NotebookLM
    session, and it used to happen while the context was being built -- before
    anything had said what the run was for. So an expired session refused
    --build-exam-index, --extract-figures and --verify-provenance, none of
    which touch NotebookLM at all: indexing the module's own exam papers and
    cutting figures out of its own slide deck are local work on local files.
    A student whose cookie lapsed lost the offline half of the tool along with
    the online half, and the message told them to sign in to do something that
    needs no account.

    The resolution is the same, and still fails the same way for the runs that
    do reach NotebookLM; it just waits until one of them asks.
    """

    engine_path: Path
    engine: ModuleType
    config: dict[str, Any]
    module: ModuleConfig
    resolve_notebooks: Callable[[], tuple[Any, ...]]
    _resolved: list[tuple[Any, ...]] = field(default_factory=list)

    @property
    def notebooks(self) -> tuple[Any, ...]:
        if not self._resolved:
            self._resolved.append(self.resolve_notebooks())
        return self._resolved[0]

    @property
    def notebook(self) -> Any:
        return self.notebooks[0]


def _engine_path() -> Path:
    """Resolve the pipeline shipped beside this launcher; never search user data."""
    local_engine = Path(__file__).resolve().parent / "universal_transcribe.py"
    if not local_engine.is_file():
        raise LauncherError(f"Could not find bundled engine at {local_engine}")
    return local_engine


def _load_engine(engine_path: Path) -> ModuleType:
    # The launcher loads the engine by file path, so Python does not otherwise
    # know the repository root or the sibling runtime package.
    for import_root in (engine_path.parent, engine_path.parent.parent):
        import_root_text = str(import_root)
        if import_root_text not in sys.path:
            sys.path.insert(0, import_root_text)
    module_spec = importlib.util.spec_from_file_location(
        "universal_transcriber_launcher_engine", engine_path
    )
    if module_spec is None or module_spec.loader is None:
        raise LauncherError(f"Could not load engine: {engine_path}")
    engine = importlib.util.module_from_spec(module_spec)
    sys.modules[module_spec.name] = engine
    module_spec.loader.exec_module(engine)
    return engine


def _module_config_for_engine(
    engine_config: dict[str, Any], module: ModuleConfig
) -> dict[str, Any]:
    config = dict(engine_config)
    if module.notebook.profile:
        config["nlm_profile"] = module.notebook.profile
    config["default_subject"] = module.display_name
    config["_remote_inventory_module_root"] = str(module.paths.root)
    return config


def _resolved_notebooks(
    engine: ModuleType, config: dict[str, Any], module: ModuleConfig
) -> tuple[Any, ...]:
    resolved: list[Any] = []
    for notebook in module.notebook.notebooks:
        notebook_reference = notebook.notebook_id or notebook.title
        try:
            target = engine.resolve_notebook(
                config, notebook_reference, notebook.title or module.display_name
            )
        except engine.TranscriberError as error:
            raise LauncherError(f"Could not resolve module notebook: {error}") from error
        if target.notebook_uuid not in {item.notebook_uuid for item in resolved}:
            resolved.append(target)
    return tuple(resolved)


def _launcher_context(args: argparse.Namespace) -> LauncherContext:
    workspace = Path(args.workspace).expanduser().resolve()
    modules = discover_modules(workspace, args.modules_root)
    module = resolve_module(modules, args.module)
    engine_path = _engine_path()
    engine = _load_engine(engine_path)
    config = _module_config_for_engine(engine.load_config(), module)
    return LauncherContext(
        engine_path,
        engine,
        config,
        module,
        lambda: _resolved_notebooks(engine, config, module),
    )


def _recordings(
    engine: ModuleType, notebook_uuids: tuple[str, ...], config: dict[str, Any]
) -> list[Any]:
    remote_sources: list[Any] = []
    try:
        for notebook_uuid in notebook_uuids:
            remote_sources.extend(engine.list_remote_sources(notebook_uuid, config))
    except engine.TranscriberError as error:
        raise LauncherError(f"Could not read NotebookLM sources: {error}") from error
    seen: set[tuple[str, str]] = set()
    unique_sources: list[Any] = []
    for source in remote_sources:
        source_key = (source.notebook_uuid, source.normalized_name)
        if source_key in seen:
            continue
        seen.add(source_key)
        unique_sources.append(source)
    remote_sources = unique_sources
    recordings = [
        source
        for source in remote_sources
        if engine._remote_role_matches(source, "recording")
    ]
    if not recordings:
        raise LauncherError("No audio/video recording sources exist in the notebook")
    return recordings


def _pending_recordings(
    engine: ModuleType, recordings: list[Any], transcripts_dir: Path
) -> list[Any]:
    finished = module_final_transcripts(transcripts_dir)
    completed: set[str] = set()
    units = _group_recordings([Path(recording.title) for recording in recordings])
    for index in transcript_assignments(finished, units):
        completed.update(units[index]["paths"])
    return [recording for recording in recordings if str(Path(recording.title)) not in completed]


def _requested_recording(
    engine: ModuleType, recordings: list[Any], requested: str
) -> Any:
    requested_name = engine.normalize_source_key(requested)
    exact = [source for source in recordings if source.normalized_name == requested_name]
    matches = exact or [
        source
        for source in recordings
        if source.normalized_stem == engine.normalize_source_stem(requested)
    ]
    if len(matches) != 1:
        raise LauncherError(
            f"Recording '{requested}' did not resolve uniquely in NotebookLM"
        )
    return matches[0]


def _selected_recordings(selection: RecordingSelection) -> list[Any]:
    if selection.requested:
        return [
            _requested_recording(
                selection.engine, selection.recordings, selection.requested
            )
        ]
    pending = _pending_recordings(
        selection.engine, selection.recordings, selection.transcripts_dir
    )
    if selection.run_all or len(pending) <= 1:
        return pending
    names = "\n".join(f"- {source.title}" for source in pending)
    raise LauncherError(
        "Multiple pending recordings were found. Name one or pass --all:\n" + names
    )


def _topic_tokens(engine: ModuleType, source_name: str) -> set[str]:
    ignored = {"lecture", "recording", "poison", "poisons", "poisoning", "dr"}
    return {
        token
        for token in engine.normalize_source_stem(source_name).split()
        if len(token) >= 3 and token not in ignored
    }


def _matching_slides(
    engine: ModuleType, source_root: Path, recording_title: str
) -> Path | None:
    lecture_dir = source_root / "Lecture"
    if not lecture_dir.is_dir():
        return None
    recording_tokens = _topic_tokens(engine, recording_title)
    candidates = [
        source_file
        for source_file in lecture_dir.iterdir()
        if source_file.is_file()
        and source_file.suffix.lower() in {*engine.SLIDE_EXTENSIONS, ".pdf"}
        and "book" not in source_file.stem.lower()
    ]
    scored = [
        (len(recording_tokens & _topic_tokens(engine, source.name)), source)
        for source in candidates
    ]
    best_score = max((score for score, _source in scored), default=0)
    matches = [source for score, source in scored if score == best_score and score > 0]
    return matches[0] if len(matches) == 1 else None


def _requested_slides(requested: str, module: ModuleConfig) -> Path:
    requested_path = Path(requested).expanduser()
    slide_path = (
        requested_path.resolve()
        if requested_path.is_absolute()
        else (module.paths.root / requested_path).resolve()
    )
    try:
        slide_path.relative_to(module.paths.root.resolve())
    except ValueError as error:
        raise LauncherError(
            "Manifest slides must stay inside the selected module"
        ) from error
    if not slide_path.is_file():
        raise LauncherError(f"Slides file not found: {slide_path}")
    return slide_path


def _slides_path(
    requested: str | None,
    context: LauncherContext,
    recording_title: str,
) -> Path | None:
    if requested:
        return _requested_slides(requested, context.module)
    try:
        mapped = configured_slide(context.module, recording_title)
    except ModuleConfigError as error:
        raise LauncherError(str(error)) from error
    return mapped or _matching_slides(
        context.engine, context.module.paths.root, recording_title
    )


def _engine_command(invocation: EngineInvocation) -> list[str]:
    command = build_entrypoint_command(
        "universal-transcribe",
        (
            "--subject",
            invocation.module.display_name,
            "--emoji",
            invocation.module.emoji,
            "--lecture",
            invocation.title or invocation.recording.title,
            "--recording-source",
            invocation.recording.title,
            "--sources-root",
            str(invocation.module.paths.root),
            "--output-dir",
            str(invocation.module.paths.transcripts),
        ),
        interpreter_options=("-u",),
        script_path=invocation.engine_path,
    )
    for notebook_id in invocation.notebook_ids:
        command.extend(["--notebook-id", notebook_id])
    if invocation.slides_path:
        command.extend(["--pptx", str(invocation.slides_path)])
    for recording in invocation.additional_recordings:
        command.extend(["--recording-source", recording.title])
    for source_name in invocation.approved_uploads:
        command.extend(["--approved-upload", source_name])
    if invocation.exam_style_profile:
        command.extend(
            [
                "--exam-style-profile",
                json.dumps(
                    invocation.exam_style_profile,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
            ]
        )
    if invocation.assessment_manifest_provided:
        command.extend(
            [
                "--assessment-manifest",
                json.dumps(
                    invocation.assessment_sources,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
            ]
        )
    if invocation.source_manifest_path:
        command.extend(["--source-manifest", invocation.source_manifest_path])
    if invocation.title:
        command.append("--agent-reviewed")
    if invocation.json_events:
        command.append("--json-events")
    if invocation.draft_only:
        command.append("--draft-only")
    if invocation.finalize_draft:
        command.append("--finalize-draft")
    if invocation.resume_run:
        command.extend(["--resume-run", invocation.resume_run])
    if invocation.resume_latest:
        command.append("--resume-latest")
    if invocation.retry_phase:
        command.extend(["--retry-phase", invocation.retry_phase])
    if invocation.recovery_phase:
        command.extend(["--recovery-phase", invocation.recovery_phase])
    if invocation.recovery_response:
        command.extend(["--recovery-response", invocation.recovery_response])
    if invocation.module.notebook.profile:
        command.extend(["--nlm-profile", invocation.module.notebook.profile])
    return command


def _read_source_manifest(path: str) -> dict[str, Any]:
    manifest_path = Path(path).expanduser().resolve()
    if not manifest_path.is_file():
        raise LauncherError(f"Source manifest not found: {manifest_path}")
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise LauncherError(f"Source manifest is not valid JSON: {error}") from error
    if not isinstance(payload, dict):
        raise LauncherError("Source manifest must be a JSON object")
    return payload


def _manifest_recording_names(payload: dict[str, Any]) -> tuple[str, ...]:
    recordings = payload.get("recording_sources")
    if not isinstance(recordings, list) or not recordings or not all(
        isinstance(item, (str, dict)) and _manifest_source_name(item) for item in recordings
    ):
        raise LauncherError(
            "Source manifest requires a non-empty recording_sources list"
        )
    names = [_manifest_source_name(item) for item in recordings]
    normalized_recordings = [item.casefold().strip() for item in names]
    if len(set(normalized_recordings)) != len(normalized_recordings):
        raise LauncherError("Source manifest cannot repeat a recording source")
    return tuple(item.strip() for item in names)


def _manifest_source_name(item: str | dict[str, Any]) -> str:
    if isinstance(item, str):
        return item.strip()
    if not isinstance(item, dict):
        return ""
    for key in ("source", "path", "name"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _manifest_upload_names(payload: dict[str, Any]) -> tuple[str, ...]:
    uploads = payload.get("approved_uploads", [])
    if not isinstance(uploads, list) or not all(
        isinstance(item, str) and item.strip() for item in uploads
    ):
        raise LauncherError("Source manifest approved_uploads must be a string list")
    normalized_uploads: list[str] = []
    for item in uploads:
        candidate = item.strip().replace("\\", "/")
        if (
            candidate.startswith("/")
            or candidate == ".."
            or candidate.startswith("../")
            or "/../" in candidate
        ):
            raise LauncherError("Approved upload paths must stay inside the module")
        if "/" in candidate and not candidate.startswith(("Lecture/", "Questions/")):
            raise LauncherError(
                "Approved upload paths must start with Lecture/ or Questions/"
            )
        normalized_uploads.append(candidate.casefold())
    if len(set(normalized_uploads)) != len(normalized_uploads):
        raise LauncherError("Source manifest cannot repeat an approved upload")
    return tuple(item.strip() for item in uploads)


def _manifest_exam_style_profile(payload: dict[str, Any]) -> dict[str, Any]:
    profile = payload.get("exam_style_profile")
    if not isinstance(profile, dict) or not profile:
        raise LauncherError(
            "Source manifest requires a non-empty exam_style_profile object"
        )
    try:
        serialized = json.dumps(profile, ensure_ascii=False)
    except (TypeError, ValueError) as error:
        raise LauncherError(
            "Source manifest exam_style_profile must be JSON data"
        ) from error
    if len(serialized) > 20_000:
        raise LauncherError("Source manifest exam_style_profile is too large")
    return profile


def _manifest_assessment_sources(payload: dict[str, Any]) -> tuple[dict[str, Any], ...]:
    sources = payload.get("assessment_sources", [])
    if not isinstance(sources, list) or not all(
        isinstance(source, dict) for source in sources
    ):
        raise LauncherError("Source manifest assessment_sources must be an object list")
    normalized: list[dict[str, Any]] = []
    paths: set[str] = set()
    for source in sources:
        path = str(source.get("path", "")).strip()
        source_type = str(source.get("type", "")).strip()
        if not path or source_type not in {"past_exam", "question_bank", "ignore"}:
            raise LauncherError(
                "Each assessment source requires path and type "
                "(past_exam, question_bank, or ignore)"
            )
        has_year = source.get("year") is not None
        has_years = source.get("years") is not None
        if source_type == "past_exam" and not (has_year or has_years):
            raise LauncherError(
                f"Past exam manifest entry requires year or years: {path}"
            )
        if source_type != "past_exam" and (has_year or has_years):
            raise LauncherError(
                f"Only past_exam entries may declare year or years: {path}"
            )
        if has_year and has_years:
            single = {str(source.get("year")).strip()}
            raw_years = source.get("years")
            if not isinstance(raw_years, list):
                raw_years = [raw_years]
            multiple = {
                str(value).strip()
                for value in raw_years
            }
            if single != multiple:
                raise LauncherError(
                    f"Manifest year and years conflict for assessment source: {path}"
                )
        normalized_path = os.path.normpath(path)
        if normalized_path.startswith("..") or not (
            normalized_path == "Questions"
            or normalized_path.startswith("Questions" + os.sep)
        ):
            raise LauncherError("Manifest assessment paths must stay under Questions/")
        if normalized_path.casefold() in paths:
            raise LauncherError(f"Source manifest repeats assessment source: {path}")
        paths.add(normalized_path.casefold())
        normalized.append({**source, "path": normalized_path, "type": source_type})
    return tuple(normalized)


def _manifest_references(payload: dict[str, Any]) -> tuple[dict[str, Any], ...]:
    references = payload.get("references", [])
    if not isinstance(references, list) or not all(
        isinstance(reference, dict) for reference in references
    ):
        raise LauncherError("Source manifest references must be an object list")
    normalized: list[dict[str, Any]] = []
    paths: set[str] = set()
    for reference in references:
        path = _manifest_source_name(reference)
        if not path:
            raise LauncherError("Each reference requires a path or source")
        normalized_path = os.path.normpath(path)
        if normalized_path.startswith("..") or not normalized_path.startswith(
            ("Lecture" + os.sep, "Questions" + os.sep)
        ):
            raise LauncherError("Manifest reference paths must stay under Lecture/ or Questions/")
        key = normalized_path.casefold()
        if key in paths:
            raise LauncherError(f"Source manifest repeats reference: {path}")
        paths.add(key)
        normalized.append({**reference, "path": normalized_path})
    return tuple(normalized)


TOPIC_SYNONYMS: dict[str, str] = {
    "metal": "معادن",
    "heavy metal": "معادن",
    "heavy metals": "معادن",
    "metals": "معادن",
    "lead": "معادن",
    "arsenic": "معادن",
    "mercury": "معادن",
    "paracetamol": "paracetamol",
    "panadol": "paracetamol",
    "acetaminophen": "paracetamol",
    "corrosive": "corrosives",
    "corrosives": "corrosives",
    "acid": "corrosives",
    "alkali": "corrosives",
    "addiction": "addication",
    "dependence": "addication",
    "narcotic": "addication",
    "volatile": "kerosin",
    "hydrocarbon": "kerosin",
    "kerosene": "kerosin",
    "alcohol": "alcohol",
    "gas": "gaseous",
    "gaseous": "gaseous",
    "carbon monoxide": "gaseous",
    "snake": "animal",
    "scorpion": "animal",
    "viper": "animal",
    "plant": "plant",
    "atropine": "plant",
    "food": "food poisoning",
    "botulism": "food poisoning",
    "favism": "food poisoning",
    "psychotropic": "psychotropic",
    "antidepressant": "psychotropic",
    "salicylate": "salicylic",
    "salicylates": "salicylic",
    "salycylates": "salicylic",
    "aspirin": "salicylic",
    "acetyl salicylic": "salicylic",
    "acetyl salysilic": "salicylic",
    "أسبرين": "salicylic",
}


def _warn_remote_discovery(reason: str) -> None:
    print(
        f"[!] --auto-manifest remote discovery failed ({reason}); the manifest "
        "may be missing sources. Check `nlm login --check` and the notebook id.",
        file=sys.stderr,
        flush=True,
    )


def generate_auto_manifest(
    module_root: Path, lecture_query: str, nlm_executable: str = "nlm",
    *, recording_sources: tuple[str, ...] | None = None,
    redo: bool = False, discover_remote: bool = True,
) -> Path:
    from lecture_registry import (
        definition_signature,
        lecture_file,
        lecture_units,
        manual_definition,
    )
    from module_registry import load_module

    metadata_path = module_root / "module.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8")) if metadata_path.is_file() else {}
    module = load_module(module_root) if metadata.get("lectures") else None
    definition = manual_definition(module, lecture_query, recording_sources) if module else None
    if definition:
        lecture_query = definition.title
        recording_sources = definition.recordings
    lecture_dir = module_root / "Lecture"
    questions_dir = module_root / "Questions"
    query_clean = lecture_query.strip()
    query_stem = Path(query_clean).stem if Path(query_clean).suffix.casefold() in RECORDING_EXTENSIONS | {".pdf", ".pptx", ".ppsx"} else query_clean
    query_tokens = [
        tok
        for tok in re.findall(r"\w+", query_stem.casefold())
        if len(tok) > 1 and tok not in {"د", "دكتور", "dr", "part", "lecture", "1", "2", "3"}
    ]

    synonym_targets: list[str] = []
    for tok in query_tokens:
        if tok in TOPIC_SYNONYMS:
            synonym_targets.append(TOPIC_SYNONYMS[tok].casefold())
    for phrase, target in TOPIC_SYNONYMS.items():
        if phrase in query_stem.casefold():
            synonym_targets.append(target.casefold())

    slide_files: list[Path] = []
    book_files: list[Path] = []
    audio_files: list[Path] = []
    if lecture_dir.is_dir():
        for item in sorted(lecture_dir.rglob("*")):
            if item.name.startswith(".") or not item.is_file():
                continue
            suffix = item.suffix.lower()
            if suffix in {".pptx", ".pdf", ".ppsx", ".ppt", ".docx"}:
                if item.stem.casefold() in {"book", "textbook", "reference"}:
                    book_files.append(item)
                else:
                    slide_files.append(item)
            elif suffix in RECORDING_EXTENSIONS:
                audio_files.append(item)

    def score_match(name: str) -> int:
        name_lower = name.casefold()
        score = 0
        if query_stem.casefold() in name_lower or name_lower in query_stem.casefold():
            score += 50
        for tok in query_tokens:
            if tok in name_lower or name_lower in tok:
                score += 20
            elif len(tok) >= 4 and (tok[:4] in name_lower or name_lower[:4] in tok):
                score += 15
        for syn in synonym_targets:
            if syn in name_lower or name_lower in syn:
                score += 30
            elif len(syn) >= 4 and (syn[:4] in name_lower or name_lower[:4] in syn):
                score += 25
        return score

    consumed_materials = (
        {lecture_file(module, name) for entry in module.lectures for name in entry.materials}
        if module else set()
    )
    slide_files = [path for path in slide_files if path not in consumed_materials]
    book_files = [path for path in book_files if path not in consumed_materials]
    if definition and module:
        material_paths = [lecture_file(module, name) for name in definition.materials]
        missing = [path for path in material_paths if not path.is_file()]
        if missing:
            raise LauncherError(f"Lecture material does not exist: {missing[0]}")
        slide_files = [path for path in material_paths if not any(word in path.stem.casefold() for word in ("book", "textbook", "reference"))]
        book_files = [path for path in material_paths if path not in slide_files]
    best_slide = None
    best_slide_score = 0
    for slide in slide_files:
        score = score_match(slide.name)
        if score > best_slide_score:
            best_slide_score = score
            best_slide = slide

    if definition:
        best_slide = slide_files[0] if slide_files else None

    # Fallback to book file if no specific slide was matched
    if not definition and not best_slide and book_files:
        best_slide = book_files[0]

    matched_audio: list[str] = []
    units = lecture_units(module, audio_files) if module else _group_recordings(audio_files)
    if not definition and recording_sources is None:
        consumed = {name for entry in (module.lectures if module else ()) for name in entry.recordings}
        audio_files = [path for path in audio_files if path.name not in consumed]
    exact_units = [unit for unit in units if unit["title"].casefold() == query_stem.casefold()]
    if recording_sources is not None:
        matched_audio = list(recording_sources)
    elif len(exact_units) == 1:
        matched_audio = exact_units[0]["recording_sources"]
    elif Path(query_clean).suffix.casefold() in RECORDING_EXTENSIONS:
        matched_audio = [query_clean]
    else:
        for audio in audio_files:
            if score_match(audio.name) > 0:
                matched_audio.append(audio.name)

    if not matched_audio and len(audio_files) == 1:
        # One recording in Lecture/ is unambiguous whatever it is called. This
        # is the Arabic case: "مبيد حشرى.m4a" shares no token with "OPs", so
        # scoring can never match it.
        matched_audio = [audio_files[0].name]
        print(
            f"[Launcher] No name match for '{query_clean}'; using the only "
            f"recording in Lecture/: {audio_files[0].name}"
        )
    elif not matched_audio and audio_files:
        candidates = "\n".join(f"  - {audio.name}" for audio in sorted(
            audio_files, key=lambda path: path.name
        ))
        raise LauncherError(
            f"--auto-manifest could not match a recording for '{query_clean}'.\n"
            f"Lecture/ holds {len(audio_files)} recordings:\n{candidates}\n"
            "Rerun with the exact filename, or write the manifest by hand."
        )

    slide_path = best_slide.relative_to(module_root).as_posix() if best_slide else None

    assessment_sources: list[dict[str, Any]] = []
    if questions_dir.is_dir():
        for item in sorted(questions_dir.iterdir()):
            if item.name.startswith(".") or item.suffix.lower() not in {".pdf", ".txt", ".docx"}:
                continue
            years = extract_filename_exam_years(item.name)
            if years:
                assessment_sources.append({
                    "path": f"Questions/{item.name}",
                    "type": "past_exam",
                    "year": max(years),
                    "action": "auto",
                })
            else:
                assessment_sources.append({
                    "path": f"Questions/{item.name}",
                    "type": "question_bank",
                    "action": "auto",
                })

    # If local assessment or audio/slide sources are empty, attempt remote discovery via module.json
    slides_action = "auto"
    module_json_path = module_root / "module.json"
    if discover_remote and (not assessment_sources or not audio_files or not slide_files) and module_json_path.is_file():
        try:  # noqa: PLR1702 - remote discovery is one cohesive best-effort block
            from dataclasses import asdict

            from remote_inventory import module_inventory

            remote_module = module or load_module(module_root)
            inventory = module_inventory(remote_module, config={"nlm_executable": nlm_executable})
            if inventory.warning:
                _warn_remote_discovery(inventory.warning)
            remote_list = [asdict(source) for source in inventory.sources]
            need_remote_assessments = not assessment_sources
            need_remote_audio = recording_sources is None and (not audio_files or matched_audio == [f"{query_stem}.mp3"])
            for r_src in remote_list:
                r_title = str(r_src.get("title") or r_src.get("name") or "").strip()
                if not r_title:
                    continue
                r_lower = r_title.casefold()
                is_book = any(k in r_lower for k in ["book", "textbook", "reference"])
                is_exam = any(k in r_lower for k in ["exam", "final", "202", "questions", "bank", "august", "may", "دور"])

                # Match remote assessment files if none found locally
                if need_remote_assessments and is_exam and not is_book:
                    r_years = extract_filename_exam_years(r_title)
                    if r_years:
                        assessment_sources.append({
                            "path": f"Questions/{r_title}" if not r_title.startswith("Questions/") else r_title,
                            "type": "past_exam",
                            "year": max(r_years),
                            "action": "use_remote",
                        })
                    else:
                        assessment_sources.append({
                            "path": f"Questions/{r_title}" if not r_title.startswith("Questions/") else r_title,
                            "type": "question_bank",
                            "action": "use_remote",
                        })

                # Match remote audio files if no local audio matched
                if need_remote_audio and (any(r_lower.endswith(ext) for ext in [".mp3", ".m4a", ".wav", ".aac", ".ogg"]) or r_src.get("type") == "audio"):  # noqa: SIM102 - already seven levels deep; merging makes the line unreadable
                    if score_match(r_title) > 0:
                        if matched_audio == [f"{query_stem}.mp3"]:
                            matched_audio = [r_title]
                        elif r_title not in matched_audio:
                            matched_audio.append(r_title)
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, ModuleConfigError) as error:
            # Remote discovery is best effort, but a silent failure here left
            # the manifest short of sources and the draft built on them
            # without a word -- and this is the path remote-only mode uses.
            _warn_remote_discovery(f"{type(error).__name__}: {error}")

    exam_style_profile = {
        "mcq": {
            "register": "Short direct factual stems with parallel concise options",
            "max_stem_words": 20,
            "options": {
                "count": 4,
                "labels": "lowercase a. through d.",
            },
            "stem_patterns": [
                "The following ...:-",
                "... are:",
                "... except:-",
            ],
        },
        "written": {
            "command_patterns": [
                "Causes of ...: 1.... 2....",
                "Treatment of ...",
                "Mechanism of ...",
            ],
            "answer_shape": "Numbered keywords matching requested count",
        },
        "cases": {
            "style": "Standard Egyptian medical exam case breakdown matching subject conventions",
            "sub_questions_pattern": [
                "1. Diagnosis (or Most likely diagnosis)",
                "2. DDx (Differential diagnosis) or Characteristic Clinical Picture (CP)",
                "3. Investigations / Confirmatory laboratory tests",
                "4. Treatment / Management (TTT / Antidote / Emergency measures)",
            ],
            "answer_shape": "Ultra-concise keyword bullets under standard clinical headings (1 to 5 words per point)",
        },
        "sample_scope": "Same college past exams and official question bank",
    }

    matched_audio = [
        source for unit in _group_recordings([Path(name) for name in matched_audio])
        for source in unit["paths"]
    ] if recording_sources is None else matched_audio
    assignments = transcript_assignments(module_final_transcripts(module_root / "Transcripts"), units)
    completed = [transcript for index, transcript in assignments.items()
                 if units[index]["title"] == query_stem
                 and units[index]["recording_sources"] == matched_audio]
    if not units:
        completed = matching_transcripts(module_final_transcripts(module_root / "Transcripts"), query_stem, matched_audio)
    if completed and not redo:
        raise LauncherError(
            f"{query_stem!r} is already transcribed: "
            f"{module_root / 'Transcripts' / completed[0].name}"
        )
    payload: dict[str, Any] = {
        "title": query_stem,
        "recording_sources": matched_audio,
        "assessment_sources": assessment_sources,
        "exam_style_profile": exam_style_profile,
    }
    if definition:
        payload["lecture_definition"] = definition_signature(definition)
        payload["references"] = [
            {"path": path.relative_to(module_root).as_posix(), "role": "textbook", "action": "auto"}
            for path in material_paths if path != best_slide
        ]
    if slide_path is not None:
        payload["slides"] = {"path": slide_path, "action": slides_action}
    if redo:
        payload["redo"] = True
        payload["replaces_transcript"] = str(module_root / "Transcripts" / completed[0].name) if completed else None
    slug = definition.id if definition else re.sub(r"[^A-Za-z0-9_-]+", "-", query_stem).strip("-").lower() or "lecture"
    manifest_kind = "manual" if definition else "auto"
    # Beside the module, not in the system temp directory. A draft run is up to
    # three hours and the app hands this path back to be passed to start_draft,
    # read_draft, apply_review and finalize afterwards -- a path that a reboot
    # or a tmp sweep can delete underneath a run that is still working is a
    # failure with no explanation in it. The cache folder is already where the
    # module keeps its own working files.
    manifest_dir = module_root / ".transcriber-cache" / "manifests"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = manifest_dir / f"{slug}-{manifest_kind}-manifest.json"
    from atomic_io import _atomic_write_json
    from file_lock import exclusive_file_lock

    with exclusive_file_lock(module_root / ".transcriber-cache" / "lecture-registry.lock"):
        _atomic_write_json(manifest_path, payload)
    return manifest_path


def _source_manifest(path: str) -> SourceManifest:
    payload = _read_source_manifest(path)
    recordings = _manifest_recording_names(payload)
    title = payload.get("title")
    if not isinstance(title, str) or not title.strip():
        raise LauncherError("Source manifest requires a non-empty title")
    slides = payload.get("slides")
    slides_action = "auto"
    if slides is not None:
        slides_name = _manifest_source_name(slides)
        if not slides_name:
            raise LauncherError("Source manifest slides must include a path")
        if isinstance(slides, dict):
            slides_action = str(slides.get("action", "auto")).strip().casefold()
        slides = slides_name
    if slides_action not in {
        "auto",
        "use",
        "use_remote",
        "convert",
        "ocr",
        "compress",
        "chunk",
        "ignore",
        "wait",
    }:
        raise LauncherError(f"Unsupported slides action: {slides_action}")
    return SourceManifest(
        title=title.strip(),
        recording_sources=recordings,
        slides=slides.strip() if isinstance(slides, str) else None,
        slides_action=slides_action,
        approved_uploads=_manifest_upload_names(payload),
        exam_style_profile=_manifest_exam_style_profile(payload),
        assessment_sources=_manifest_assessment_sources(payload),
        references=_manifest_references(payload),
        manifest_path=str(Path(path).expanduser().resolve()),
    )


def _run_engine(command: list[str], source_root: Path, timeout: int, label: str) -> int:
    """Run the engine as a subprocess under a wall-clock ceiling.

    Without a timeout a wedged `nlm` call -- or a LibreOffice conversion that
    never returns -- hangs the launcher forever, which is especially bad when a
    sub-agent worker is waiting on it.
    """
    try:
        return subprocess.run(
            command, cwd=source_root, check=False, timeout=timeout
        ).returncode
    except subprocess.TimeoutExpired:
        print(
            f"[Launcher] {label} exceeded its {timeout}s limit and was stopped. "
            "Rerun with --resume-latest to continue from the last checkpoint.",
            file=sys.stderr,
            flush=True,
        )
        return 1


def _run_audit(command: list[str], source_root: Path) -> int:
    print("[Launcher] Starting read-only Phase 0 audit...", flush=True)
    return _run_engine(
        [*command, "--audit-only"], source_root, AUDIT_TIMEOUT_SECONDS, "Audit"
    )


def _needs_preflight_audit(invocation: EngineInvocation) -> bool:
    """Only a run that can upload sources needs the read-only preflight.

    --finalize-draft reads an existing draft and --recovery-phase applies an
    Agent-repaired response to a checkpoint. Neither uploads anything, so the
    separate audit subprocess was ~18s of NotebookLM traffic spent to validate
    a run that was never going to touch the notebook.
    """
    return not (invocation.finalize_draft or invocation.recovery_phase)


def _run_transcription(
    command: list[str], source_root: Path, invocation: EngineInvocation
) -> int:
    if _needs_preflight_audit(invocation):
        audit_exit_code = _run_audit(command, source_root)
        if audit_exit_code != 0:
            return audit_exit_code
        print(
            "[Launcher] Audit passed; starting the five transcription phases...",
            flush=True,
        )
    else:
        print(
            "[Launcher] Local-only invocation; skipping the read-only audit.",
            flush=True,
        )
    return _run_engine(
        command, source_root, TRANSCRIPTION_TIMEOUT_SECONDS, "Transcription"
    )


def _print_inventory(recordings: list[Any], pending: list[Any]) -> None:
    pending_ids = {source.source_id for source in pending}
    print("NotebookLM recordings:")
    for source in recordings:
        status = "pending" if source.source_id in pending_ids else "transcribed"
        print(f"- [{status}] {source.title}")


def _print_modules(modules: list[ModuleConfig]) -> None:
    print("Configured modules:")
    for module in modules:
        notebooks = ", ".join(
            reference.notebook_id or reference.title
            for reference in module.notebook.notebooks
        )
        print(f"- {module.module_id}: {module.display_name} -> {notebooks}")


def _lecture_key(
    module: ModuleConfig, recording: Any, manifest: SourceManifest | None
) -> str:
    title = manifest.title if manifest else recording.title
    recordings = manifest.recording_sources if manifest else (recording.title,)
    identity_parts = (module.module_id, title, *recordings)
    normalized = "\n".join(
        unicodedata.normalize("NFKC", part).strip().casefold().replace("\\", "/")
        for part in identity_parts
    )
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]


@contextmanager
def _lecture_lock(
    module: ModuleConfig, recording: Any, manifest: SourceManifest | None
) -> Iterator[None]:
    lecture_key = _lecture_key(module, recording, manifest)
    lock_directory = module.paths.root / ".transcriber-cache" / "locks"
    lock_path = lock_directory / f"lecture-{lecture_key}.lock"
    with ExitStack() as stack:
        try:
            lock_file = stack.enter_context(
                exclusive_file_lock(lock_path, blocking=False)
            )
        except BlockingIOError as error:
            title = manifest.title if manifest else recording.title
            raise LauncherError(
                f"Lecture '{title}' is already running (key: {lecture_key})"
            ) from error
        lock_file.seek(0)
        lock_file.truncate()
        json.dump(
            {
                "lecture_key": lecture_key,
                "module": module.module_id,
                "title": manifest.title if manifest else recording.title,
                "pid": os.getpid(),
            },
            lock_file,
            ensure_ascii=False,
        )
        lock_file.flush()
        yield


def _selection(
    args: argparse.Namespace,
    context: LauncherContext,
    recordings: list[Any],
) -> RecordingSelection:
    return RecordingSelection(
        engine=context.engine,
        recordings=recordings,
        transcripts_dir=context.module.paths.transcripts,
        requested=args.lecture,
        run_all=args.all,
    )


def _execute_recording(
    args: argparse.Namespace,
    context: LauncherContext,
    recording: Any,
    manifest: SourceManifest | None = None,
) -> int:
    additional = ()
    title = None
    approved_uploads: tuple[str, ...] = ()
    slides: Path | None = None
    if manifest:
        selected = tuple(
            _requested_recording(
                context.engine,
                _recordings(
                    context.engine,
                    tuple(notebook.notebook_uuid for notebook in context.notebooks),
                    context.config,
                ),
                source,
            )
            for source in manifest.recording_sources
        )
        recording, additional = selected[0], selected[1:]
        title = manifest.title
        approved_uploads = manifest.approved_uploads
        if manifest.slides and manifest.slides_action != "ignore":
            slides = (
                Path(manifest.slides)
                if manifest.slides_action == "use_remote"
                else _requested_slides(manifest.slides, context.module)
            )
    else:
        slides = _slides_path(args.slides, context, recording.title)
    invocation = EngineInvocation(
        engine_path=context.engine_path,
        module=context.module,
        notebook_ids=tuple(notebook.notebook_uuid for notebook in context.notebooks),
        recording=recording,
        slides_path=slides,
        additional_recordings=additional,
        approved_uploads=approved_uploads,
        title=title,
        exam_style_profile=(manifest.exam_style_profile if manifest else None),
        assessment_sources=(manifest.assessment_sources if manifest else ()),
        assessment_manifest_provided=manifest is not None,
        draft_only=args.draft_only,
        finalize_draft=args.finalize_draft,
        source_manifest_path=(manifest.manifest_path if manifest else None),
        resume_run=getattr(args, "resume_run", None),
        resume_latest=bool(getattr(args, "resume_latest", False)),
        retry_phase=getattr(args, "retry_phase", None),
        recovery_phase=getattr(args, "recovery_phase", None),
        recovery_response=getattr(args, "recovery_response", None),
        json_events=bool(getattr(args, "json_events", False)),
    )
    command = _engine_command(invocation)
    if args.audit_only:
        return _run_audit(command, context.module.paths.root)
    return _run_transcription(command, context.module.paths.root, invocation)


def _execute_selected(
    args: argparse.Namespace,
    context: LauncherContext,
    selected: list[Any],
    manifest: SourceManifest | None = None,
) -> int:
    if not selected:
        print(f"All recordings in module '{context.module.module_id}' are transcribed.")
        return 0
    for i, recording in enumerate(selected, 1):
        recording_manifest = manifest
        if recording_manifest is None:
            auto_manifest_path = generate_auto_manifest(
                context.module.paths.root,
                recording.title,
                str(context.config.get("nlm_executable") or "nlm"),
            )
            recording_manifest = _source_manifest(str(auto_manifest_path))
            print(f"\n[Batch {i}/{len(selected)}] >>> Generated Auto-Manifest for: {recording.title}")
        with _lecture_lock(context.module, recording, recording_manifest):
            exit_code = _execute_recording(args, context, recording, recording_manifest)
            if exit_code != 0:
                return exit_code
    return 0


AUDIO_SUFFIXES = RECORDING_EXTENSIONS


def _remote_recording(args: argparse.Namespace, context: LauncherContext) -> Path:
    """The recording named by --lecture, found in the notebook rather than on disk.

    notebooklm-raw never opens the audio -- it reads back the transcript
    NotebookLM already made -- so a module whose recordings live only in the
    notebook is not missing anything this engine needs. The returned Path is a
    name, not a file: the engine matches it against the remote source titles.
    """
    from nlm_client import list_remote_sources

    notebook_id = context.module.notebook.notebook_id
    if not notebook_id:
        raise LauncherError(
            f"No recording under {context.module.paths.lecture} matches "
            f"{args.lecture!r}, and the module names no notebook to look in."
        )
    wanted = normalize_module_name(args.lecture)
    audio = [
        source
        for source in list_remote_sources(notebook_id, context.config)
        if source.source_type.casefold() in {"audio", "video"}
    ]
    matches = [
        source for source in audio if wanted in normalize_module_name(source.title)
    ]
    if not matches:
        known = ", ".join(sorted(s.title for s in audio)) or "none"
        raise LauncherError(
            f"Nothing named {args.lecture!r} is on disk or in the notebook. "
            f"Audio in the notebook: {known}"
        )
    if len(matches) > 1:
        names = ", ".join(sorted(s.title for s in matches))
        raise LauncherError(f"{args.lecture!r} matches several recordings: {names}")
    return Path(matches[0].title)


def _transcription_recording(
    args: argparse.Namespace, context: LauncherContext
) -> Path:
    """The recording to transcribe: --lecture matched against Lecture/.

    Falls back to the notebook for engines that read the transcript remotely,
    which is the documented "remote-only mode" -- audio uploaded once, never
    kept locally.
    """
    from engines import NOTEBOOKLM_RAW

    lecture_dir = context.module.paths.lecture
    if not args.lecture:
        raise LauncherError(
            f"--engine {args.engine} needs --lecture naming the recording"
        )
    wanted = normalize_module_name(args.lecture)
    recordings = [
        path
        for path in sorted(lecture_dir.glob("*"))
        if path.is_file()
        and wanted in normalize_module_name(path.stem)
        and path.suffix.casefold() in AUDIO_SUFFIXES
    ]
    if not recordings:
        if args.engine == NOTEBOOKLM_RAW:
            return _remote_recording(args, context)
        raise LauncherError(f"No recording under {lecture_dir} matches {args.lecture!r}")
    if len(recordings) > 1:
        names = ", ".join(path.name for path in recordings)
        raise LauncherError(f"{args.lecture!r} matches several recordings: {names}")
    return recordings[0]


def _transcription_engine_for(
    args: argparse.Namespace, context: LauncherContext
) -> tuple[Any, str]:
    """The transcription backend named by --engine, plus its install hint.

    The hint is returned rather than raised because is_available() is the
    caller's gate: an engine that cannot run here is a sentence telling the
    user what to do, not a traceback.
    """
    from engines import NOTEBOOKLM_RAW, WHISPER, get_transcription_engine

    if args.engine == NOTEBOOKLM_RAW:
        engine = get_transcription_engine(
            NOTEBOOKLM_RAW,
            notebook_uuid=context.module.notebook.notebook_id,
            config=context.config,
        )
        hint = (
            "The nlm CLI is required for --engine notebooklm-raw, and the "
            "module must name a notebook. Run --doctor-live to check, or use "
            "--engine whisper to transcribe locally instead."
        )
        return engine, hint

    from engines.whisper import INSTALL_HINT

    return get_transcription_engine(WHISPER, model_size=args.whisper_model), INSTALL_HINT


def _verbatim_provenance(engine_name: str, args: argparse.Namespace, result: Any) -> str:
    """The one line in the file that says where this text came from.

    Worth its own function: the whole point of a verbatim transcript is that a
    later reader can tell whether it is a recognition or a reading, and which
    recogniser produced it.
    """
    from engines import NOTEBOOKLM_RAW

    if engine_name == NOTEBOOKLM_RAW:
        return (
            "read back from NotebookLM's own transcript of the audio "
            f"(`{result.model}`), with no AI processing applied"
        )
    return f"transcribed locally with faster-whisper ({result.model})"


def _run_local_transcription(args: argparse.Namespace, context: LauncherContext) -> int:
    """Transcribe a recording verbatim and write it out.

    This stops at the raw text on purpose. Restructuring it into the five
    sections here would mean paraphrasing the recording before anyone had read
    it, and the doctor's exact wording is the one thing the exam-style prompts
    treat as authoritative.

    Both transcription engines land here. They differ in where the words come
    from -- NotebookLM's own transcript, or a local recogniser -- and in
    nothing else the caller can see.
    """
    from engines import EngineError, EngineUnavailable

    recording = _transcription_recording(args, context)
    engine, install_hint = _transcription_engine_for(args, context)
    label = f"[{engine.name}]"
    if not engine.is_available():
        print(f"[!] {install_hint}", file=sys.stderr)
        return 1

    print(f"{label} Transcribing {recording.name}...")
    try:
        result = engine.transcribe(recording, language=args.language)
    except (EngineError, EngineUnavailable) as error:
        print(f"[!] {error}", file=sys.stderr)
        return 1

    target = (
        Path(args.output).expanduser()
        if args.output
        else context.module.paths.verbatim / f"{recording.stem}.verbatim.md"
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    body = result.with_timestamps() if args.timestamps else result.text
    header = (
        f"# Verbatim transcript — {recording.stem}\n\n"
        f"> Raw {result.language or 'auto-detected'} speech from `{recording.name}`, "
        f"{_verbatim_provenance(engine.name, args, result)}. Nothing here "
        f"has been summarised or reordered.\n\n"
    )
    target.write_text(header + body + "\n", encoding="utf-8")
    print(f"{label} {result.word_count} words -> {target}")
    print(
        "\nThis is the raw recording, not a transcript in the 5-section format. "
        "Write the sections from it."
    )
    return 0


def _requested_years(raw: str | None) -> tuple[int, ...]:
    """Parse --years as either a list (2022,2024) or a range (2020-2024)."""
    if not raw:
        return ()
    text = raw.strip()
    range_match = re.fullmatch(r"(\d{4})\s*-\s*(\d{4})", text)
    if range_match:
        first, last = int(range_match.group(1)), int(range_match.group(2))
        if first > last:
            first, last = last, first
        return tuple(range(first, last + 1))
    years = []
    for part in re.split(r"[,\s]+", text):
        if not part:
            continue
        if not re.fullmatch(r"\d{4}", part):
            raise LauncherError(f"--years expects four-digit years, got {part!r}")
        years.append(int(part))
    return tuple(sorted(set(years)))


def _requested_kinds(raw: str, default: tuple[str, ...]) -> tuple[str, ...]:
    from question_bank import KINDS

    if not raw.strip():
        return default
    kinds = tuple(part.strip().casefold() for part in raw.split(",") if part.strip())
    unknown = [kind for kind in kinds if kind not in KINDS]
    if unknown:
        raise LauncherError(
            f"--kinds accepts {', '.join(KINDS)}; got {', '.join(unknown)}"
        )
    return kinds


def _export_target(args: argparse.Namespace, context: LauncherContext, stem: str, suffix: str) -> Path:
    if args.output:
        return Path(args.output).expanduser()
    return context.module.paths.transcripts / f"{stem}.{suffix}"


def _run_question_bank(args: argparse.Namespace, context: LauncherContext) -> int:
    from bank_export import (
        ExportError,
        render_bank_markdown,
        write_csv,
        write_json,
        write_xlsx,
    )
    from question_bank import (
        KINDS,
        QuestionBankError,
        build_bank,
        filter_bank,
        render_summary,
        sample_exam,
    )

    if args.question_bank and args.exam:
        raise LauncherError("--question-bank and --exam are separate commands")

    try:
        bank = build_bank(context.module.paths.transcripts, context.module.module_id)
    except QuestionBankError as error:
        print(f"[!] {error}", file=sys.stderr)
        return 1

    years = _requested_years(args.years)
    output_format = args.format.strip().casefold()

    if args.exam:
        kinds = _requested_kinds(args.kinds, ("mcq",))
        questions = sample_exam(
            bank, args.count, kinds=kinds, years=years, seed=args.seed
        )
        if not questions:
            print("[!] No questions matched that selection", file=sys.stderr)
            return 1
        title = f"{context.module.display_name} exam ({len(questions)} questions)"
        return _write_exam(args, context, bank, questions, title, output_format)

    print(render_summary(bank))
    kinds = _requested_kinds(args.kinds, KINDS)
    questions = filter_bank(bank, kinds=kinds, years=years)
    try:
        if output_format == "csv":
            result = write_csv(bank, _export_target(args, context, "question-bank", "csv"), questions)
        elif output_format == "json":
            result = write_json(bank, _export_target(args, context, "question-bank", "json"), questions)
        elif output_format == "xlsx":
            result = write_xlsx(bank, _export_target(args, context, "question-bank", "xlsx"), questions)
        else:
            target = _export_target(args, context, "question-bank", "md")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(render_bank_markdown(bank, questions), encoding="utf-8")
            result = type("R", (), {"path": target, "written": len(questions)})()
    except ExportError as error:
        print(f"[!] {error}", file=sys.stderr)
        return 1
    print(f"\nWrote {result.written} question(s) to {result.path}")
    return 0


def _write_exam(
    args: argparse.Namespace,
    context: LauncherContext,
    bank: QuestionBank,
    questions: tuple[BankQuestion, ...],
    title: str,
    output_format: str,
) -> int:
    from bank_export import (
        ExportError,
        render_exam_html,
        render_exam_markdown,
        write_csv,
        write_docx,
    )

    try:
        if output_format == "html":
            target = _export_target(args, context, "exam", "html")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(render_exam_html(questions, title=title), encoding="utf-8")
            print(f"Wrote a self-grading paper with {len(questions)} question(s) to {target}")
            return 0
        if output_format == "docx":
            paper = _export_target(args, context, "exam", "docx")
            key = paper.with_name(f"{paper.stem}-answers{paper.suffix}")
            write_docx(bank, paper, questions, title=title)
            write_docx(bank, key, questions, title=f"{title} — answer key", with_answers=True)
            print(f"Wrote {paper} and {key}")
            return 0
        if output_format == "csv":
            result = write_csv(bank, _export_target(args, context, "exam", "csv"), questions)
            print(f"Wrote {result.written} question(s) to {result.path}")
            return 0
        paper_text, key_text = render_exam_markdown(questions, title=title)
        paper = _export_target(args, context, "exam", "md")
        key = paper.with_name(f"{paper.stem}-answers{paper.suffix}")
        paper.parent.mkdir(parents=True, exist_ok=True)
        paper.write_text(paper_text, encoding="utf-8")
        key.write_text(key_text, encoding="utf-8")
        # Two files on purpose: a paper with the answers under each question
        # cannot be sat.
        print(f"Wrote {paper} and {key}")
        return 0
    except ExportError as error:
        print(f"[!] {error}", file=sys.stderr)
        return 1


def _figure_slide_source(args: argparse.Namespace, context: LauncherContext) -> Path:
    """Which deck to illustrate: --slides if given, else the configured one."""
    if args.slides:
        candidate = Path(args.slides).expanduser()
        if not candidate.is_absolute():
            candidate = context.module.paths.root / candidate
        return candidate
    if not args.lecture:
        raise LauncherError(
            "--extract-figures needs --lecture (to find the configured slides) "
            "or --slides pointing at a deck"
        )
    configured = configured_slide(context.module, args.lecture)
    if configured:
        return configured
    raise LauncherError(
        f"No slides configured for '{args.lecture}' in module.json; "
        "pass --slides with the deck to illustrate."
        + _available_decks(context)
    )


def _available_decks(context: LauncherContext) -> str:
    """Name the decks that are actually there.

    The old message said to pass a deck and stopped, so the next move was a
    guess or a directory listing -- and a caller with no shell had neither.
    The module's own Lecture/ folder is the answer and the launcher is already
    standing in it.
    """
    lecture_dir = context.module.paths.root / "Lecture"
    decks = sorted(
        path.name
        for path in lecture_dir.glob("*")
        if path.suffix.lower() in {".pptx", ".ppt", ".pdf"}
    )
    if not decks:
        return f" No deck found in {lecture_dir}."
    listed = "".join(f"\n  Lecture/{name}" for name in decks)
    return f" Decks in this module:{listed}"


def _resolve_transcript(name: str, context: LauncherContext) -> Path:
    """A draft named any of the three ways a caller reasonably names it."""
    candidate = Path(name).expanduser()
    if candidate.is_file():
        return candidate
    for base in (context.module.paths.transcripts, context.module.paths.root):
        resolved = base / name
        if resolved.is_file():
            return resolved
    raise LauncherError(
        f"No such transcript: {name}. Drafts live in "
        f"{context.module.paths.transcripts}."
    )


def _draft_manifest(args: argparse.Namespace, context: LauncherContext, transcript: Path) -> dict[str, Any]:
    if args.source_manifest:
        _source_manifest(args.source_manifest)
        return json.loads(Path(args.source_manifest).read_text(encoding="utf-8"))
    title = transcript.name.removesuffix(".draft.md").removesuffix(".md")
    key = re.sub(r"[^\w]+", "", title).casefold()
    matches = []
    directory = context.module.paths.root / ".transcriber-cache" / "manifests"
    for path in sorted(directory.glob("*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        manifest_key = re.sub(r"[^\w]+", "", payload.get("title", "")).casefold()
        if manifest_key == key:
            _source_manifest(str(path))
            matches.append(payload)
    if len(matches) != 1:
        raise LauncherError("Pass --source-manifest for this draft; its exact exam style and assessment evidence are required.")
    return matches[0]


def _run_draft_validation(args: argparse.Namespace, context: LauncherContext) -> int:
    """Collect the finalizer's checks over the same draft and manifest."""
    from draft_diagnostics import format_findings
    from question_provenance import (
        assessment_catalog,
        assessment_verified_years,
        repair_saved_draft,
    )

    transcript = _resolve_transcript(args.validate_draft, context)
    manifest = _draft_manifest(args, context, transcript)
    catalog = assessment_catalog(context.module.paths.root, manifest)
    draft, corrections = repair_saved_draft(transcript, catalog)
    for correction in corrections:
        print("[AUTO-REPAIR] " + json.dumps(correction, ensure_ascii=False))
    errors = context.engine.pre_finalize_errors(
        draft, assessment_verified_years(catalog), manifest["exam_style_profile"], catalog
    )
    from web_figures import figure_reference_errors

    errors.extend(figure_reference_errors(draft, tuple((transcript.parent / "Figures").glob("*"))))
    for warning in context.engine.pre_finalize_warnings(draft, transcript):
        print(f"[WARNING] {warning}")
    if errors:
        print("[!] Editorial review required:\n" + "\n".join(format_findings(errors, draft, transcript)), file=sys.stderr)
        print("\nFix the affected parts and validate again. Confirmed badge repairs are saved; other text is unchanged.", file=sys.stderr)
        return 1
    print(f"{transcript.name} passes every check finalizing would run.")
    print("Provenance is a separate gate: run --verify-provenance too.")
    return 0


def _provenance_catalog(args: argparse.Namespace, context: LauncherContext, transcript: Path) -> list[dict[str, Any]]:
    from exam_index import ExamIndexError, load_index
    from question_provenance import assessment_catalog

    try:
        manifest = _draft_manifest(args, context, transcript)
    except LauncherError:
        if args.source_manifest:
            raise
        try:
            index = load_index(context.module.paths.questions)
        except ExamIndexError:
            sources = [
                {"path": f"Questions/{path.name}", "type": "past_exam", "years": list(extract_filename_exam_years(path.name))}
                for path in context.module.paths.questions.glob("*")
                if path.suffix.casefold() in {".txt", ".md"}
            ]
        else:
            sources = [{"path": f"Questions/{source['file']}", "type": source["kind"], "years": source["years"]} for source in index["sources"]]
        manifest = {"assessment_sources": sources}
    return assessment_catalog(context.module.paths.root, manifest)


def _run_provenance_check(args: argparse.Namespace, context: LauncherContext) -> int:
    """Use the finalizer's Source reader and paper-backed year checks."""
    from draft_diagnostics import format_findings
    from question_provenance import final_provenance_errors, repair_saved_draft

    transcript = _resolve_transcript(args.verify_provenance, context)
    catalog = _provenance_catalog(args, context, transcript)
    draft, corrections = repair_saved_draft(transcript, catalog)
    for correction in corrections:
        print("[AUTO-REPAIR] " + json.dumps(correction, ensure_ascii=False))
    errors = final_provenance_errors(draft, catalog)
    checked = len(re.findall(r"(?m)^### (?:MCQ|Question|Clinical Case) \d+ .*Past Exams", draft))
    print(f"{checked} year badge(s) checked in {transcript.name}")
    if errors:
        print("[!] Provenance findings:\n" + "\n".join(format_findings(errors, draft, transcript)))
        print(
            "Copy the exact stem, badge and source_lines from find_questions. "
            "Re-stage only the affected part with the same parts total, then "
            "apply_review(from_parts=true) and run both checks again. "
            "Saved staged parts persist until finalize."
        )
        return 1
    print("Every year badge is backed by the paper it names.")
    return 0


def _run_exam_index(args: argparse.Namespace, context: LauncherContext) -> int:
    """Build the module's exam index, once, from its question papers."""
    from exam_index import (
        ExamIndexError,
        build_index,
        carry_over_repairs,
        render_summary,
        write_index,
    )

    try:
        index = build_index(context.module.paths.questions, context.module.module_id)
        index = carry_over_repairs(index, context.module.paths.questions)
        target = write_index(index, context.module.paths.questions)
    except ExamIndexError as error:
        print(f"[!] {error}", file=sys.stderr)
        return 1
    print(render_summary(index))
    print(f"\n-> {target}")
    damaged = [
        key for key, question in index["questions"].items() if not question["legible"]
    ]
    if damaged:
        print(
            f"\n[!] {len(damaged)} question(s) the scan left unreadable. They are "
            "kept, not dropped -- read them once and repair the stems in the "
            "index rather than re-deciding them in every transcript:"
        )
        for key in damaged[:10]:
            print(f"    {key}: {index['questions'][key]['stem'][:70]}")
    return 0


def _run_figure_extraction(args: argparse.Namespace, context: LauncherContext) -> int:
    from slide_figures import (
        DEFAULT_RESOLUTION,
        FigureExtractionError,
        extract_figures,
        render_reference_markdown,
        render_report,
    )

    source = _figure_slide_source(args, context)
    from lecture_registry import manual_definition

    definition = manual_definition(context.module, args.lecture) if args.lecture else None
    lecture = definition.title if definition else args.lecture or source.stem
    try:
        figure_set = extract_figures(
            source,
            context.module.paths.transcripts,
            lecture,
            resolution=args.figure_resolution or DEFAULT_RESOLUTION,
            include_text_pages=args.all_slide_pages,
        )
    except FigureExtractionError as error:
        print(f"[!] {error}", file=sys.stderr)
        return 1

    print(render_report(figure_set))
    markdown = render_reference_markdown(figure_set)
    if markdown:
        print("\nPaste into the transcript where the doctor showed them:\n")
        print(markdown)
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Multi-module transcription launcher")
    from library_workspace import workspace_path

    parser.add_argument("--workspace", default=str(workspace_path()))
    parser.add_argument("--modules-root")
    parser.add_argument("--module")
    parser.add_argument("--slides")
    preferences = parser.add_mutually_exclusive_group()
    preferences.add_argument("--get-engine-settings", action="store_true")
    preferences.add_argument("--set-web-figures", choices=("on", "off"))
    parser.add_argument(
        "--source-manifest",
        help=(
            "Agent-approved JSON manifest for source selection, uploads, and "
            "multi-part lectures"
        ),
    )
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--lecture")
    target.add_argument("--all", action="store_true")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--list-modules", action="store_true")
    parser.add_argument(
        "--doctor",
        action="store_true",
        help=(
            "Check that the external tooling the pipeline shells out to (nlm, "
            "poppler, ocrmypdf, libreoffice, ghostscript, ffmpeg, genanki) is "
            "installed, then exit"
        ),
    )
    parser.add_argument(
        "--doctor-live",
        action="store_true",
        help=(
            "Like --doctor, but actually runs each tool to prove it works -- "
            "most importantly whether `nlm` is authenticated. Slower, and the "
            "only version of the check that catches an installed-but-unusable "
            "tool before a run wastes half an hour on it"
        ),
    )
    parser.add_argument(
        "--doctor-json",
        action="store_true",
        help=(
            "Emit the dependency check as JSON for desktop and other programmatic "
            "callers; combine with --doctor-live to include liveness probes"
        ),
    )
    parser.add_argument(
        "--json-events",
        action="store_true",
        help=(
            "Emit machine-readable NDJSON progress on stdout, one JSON object "
            "per line, and move the Egyptian Arabic log to stderr. For a "
            "desktop UI or any other caller that is a program, not a person"
        ),
    )
    parser.add_argument("--audit-only", action="store_true")
    parser.add_argument(
        "--extract-figures",
        action="store_true",
        help=(
            "Render the diagram pages of this lecture's slides into "
            "Transcripts/Figures/<lecture>/ and exit. Slides reach NotebookLM "
            "as text, so every picture in them is lost by the time a transcript "
            "is written; this is what puts them back"
        ),
    )
    parser.add_argument(
        "--figure-resolution",
        type=int,
        default=None,
        help="DPI for --extract-figures (default 150)",
    )
    parser.add_argument(
        "--verify-provenance",
        metavar="TRANSCRIPT",
        help=(
            "Check a finished transcript's badges against the module's exam "
            "index and papers: every **[Past Exams - YYYY]** must be a year "
            "the cited paper actually supports. Exits non-zero when a badge "
            "claims provenance the sources do not"
        ),
    )
    parser.add_argument(
        "--validate-draft",
        metavar="DRAFT",
        help=(
            "Run every check finalizing runs over a draft and write nothing: "
            "section structure, callouts, leaked engine text, and year badges "
            "against the module's exam index. A writer can then be sure "
            "before reaching for --finalize-draft, which writes the student's "
            "transcript. Provenance is a separate gate: --verify-provenance"
        ),
    )
    parser.add_argument(
        "--build-exam-index",
        action="store_true",
        help=(
            "Read the module's Questions/ papers once into Questions/"
            "exam-index.json: every question with its options, answer, the "
            "file and section it came from, and the year that section can "
            "honestly claim. Drafting then looks a question up instead of "
            "re-matching it against raw OCR text on every run"
        ),
    )
    parser.add_argument(
        "--engine",
        choices=ENGINE_NAMES,
        # No default here on purpose. The default IS notebooklm-raw, but it is
        # applied in _resolve_engine() after the operation is classified, so
        # that "the user named a backend" stays distinguishable from "nobody
        # said". Defaulting in argparse would erase that distinction, and the
        # refusal below depends on it.
        default=None,
        help=(
            "Which backend to use for a direct --lecture transcription "
            "(default: notebooklm-raw). "
            "notebooklm-raw (default) reads back the transcript NotebookLM "
            "already made and stops, leaving the Agent to write the sections "
            "from the raw text. notebooklm runs the five-section pipeline, "
            "and whisper recognises the audio locally. Manifest, sync, audit, "
            "draft and finalize operations keep their existing pipeline "
            "dispatch; use --timestamps with whisper for segment times."
        ),
    )
    parser.add_argument(
        "--whisper-model",
        default="medium",
        help="faster-whisper model size for --engine whisper (default medium)",
    )
    parser.add_argument(
        "--language",
        default="",
        help=(
            "Force a language for --engine whisper. Left unset the recogniser "
            "follows the recording, which is what these lectures need -- they "
            "switch between Arabic and English mid-sentence"
        ),
    )
    parser.add_argument(
        "--timestamps",
        action="store_true",
        help="Write the verbatim transcript with a timestamp per segment",
    )
    parser.add_argument(
        "--question-bank",
        action="store_true",
        help=(
            "Collect every question in the module's transcripts into one bank, "
            "marking repeats, then exit"
        ),
    )
    parser.add_argument(
        "--exam",
        action="store_true",
        help="Draw an exam paper and a separate answer key from the bank, then exit",
    )
    parser.add_argument("--count", type=int, default=50, help="Questions in the --exam paper")
    parser.add_argument(
        "--years",
        help="Restrict to these past-exam years: a list (2022,2024) or a range (2020-2024)",
    )
    parser.add_argument(
        "--kinds",
        default="",
        help="Question kinds to include: mcq, written, case (comma separated)",
    )
    parser.add_argument(
        "--format",
        default="md",
        help=(
            "Output format: md, csv, json, html (self-grading paper), xlsx "
            "(needs openpyxl) or docx (needs python-docx)"
        ),
    )
    parser.add_argument("--output", help="Where to write the export (default: alongside Transcripts)")
    parser.add_argument("--seed", type=int, help="Make --exam sampling reproducible")
    parser.add_argument(
        "--all-slide-pages",
        action="store_true",
        help=(
            "With --extract-figures, render every slide rather than only the "
            "ones carrying a diagram"
        ),
    )
    parser.add_argument(
        "--sync-sources",
        action="store_true",
        help="Run the Agent-supervised module-wide source synchronization workflow",
    )
    parser.add_argument(
        "--source-sync-manifest",
        help="Agent-approved module source synchronization manifest",
    )
    parser.add_argument(
        "--auto-manifest",
        help="Automatically generate a complete manifest for the given lecture name/keyword",
    )
    parser.add_argument(
        "--transcribe-all-pending",
        action="store_true",
        help="Automatically discover and transcribe all pending untranscribed lectures in the module",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Execute an approved source synchronization plan",
    )
    output_mode = parser.add_mutually_exclusive_group()
    output_mode.add_argument(
        "--draft-only",
        action="store_true",
        help="Write a draft for Agent review without updating the final transcript",
    )
    output_mode.add_argument(
        "--finalize-draft",
        action="store_true",
        help="Finalize the reviewed .draft.md and update the transcript/index",
    )
    parser.add_argument("--resume-run", help="Resume a saved run by ID or checkpoint directory")
    parser.add_argument(
        "--resume-latest",
        action="store_true",
        help="Resume the newest incomplete run for this lecture",
    )
    parser.add_argument(
        "--retry-phase",
        choices=("guide", "imp", "mcqs", "written", "cases"),
        help="Retry this phase and dependent phases from a saved run",
    )
    parser.add_argument(
        "--recovery-phase",
        choices=("guide", "imp", "mcqs", "written", "cases"),
        help="Phase repaired by the Agent response supplied with --recovery-response",
    )
    parser.add_argument(
        "--recovery-response",
        help="Path inside the run cache to the Agent-repaired phase response",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"Qabas engine {__version__}",
    )
    visibility = parser.add_mutually_exclusive_group()
    visibility.add_argument("--hide-lecture", metavar="TITLE", help="Hide a lecture without changing files or notebook sources")
    visibility.add_argument("--restore-recordings", nargs="+", metavar="NAME", help="Restore hidden recording names")
    visibility.add_argument("--remove-transcript", metavar="TITLE")
    parser.add_argument("--transcript-kinds", nargs="+", choices=("final", "draft", "verbatim"))
    visibility.add_argument("--list-trash", action="store_true")
    visibility.add_argument("--restore-trash", metavar="ID")
    visibility.add_argument("--remove-module", metavar="MODULE")
    visibility.add_argument("--restore-module", metavar="TRASH_ID")
    visibility.add_argument("--list-removed-modules", action="store_true")
    parser.add_argument(
        "--no-update-check",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    return parser


# Flags that say what this invocation IS, regardless of any backend. The
# engine name used to serve double duty as the operation selector, which is
# why changing its default could silently reroute a sync or a finalize; these
# are listed rather than derived so that adding a flag is a decision about
# routing, not an accident of naming.
PIPELINE_OPERATION_FLAGS = (
    "auto_manifest",
    "source_manifest",
    "source_sync_manifest",
    "transcribe_all_pending",
    "all",
    "list",
    "audit_only",
    "extract_figures",
    "verify_provenance",
    "validate_draft",
    "build_exam_index",
    "question_bank",
    "exam",
    "apply",
    "draft_only",
    "finalize_draft",
    "resume_run",
    "resume_latest",
    "retry_phase",
    "recovery_phase",
    "recovery_response",
)


def _operation_for(args: argparse.Namespace) -> str:
    """Classify the invocation before selecting a transcription backend."""
    if getattr(args, "sync_sources", False):
        return "source-sync"
    if any(bool(getattr(args, flag, False)) for flag in PIPELINE_OPERATION_FLAGS):
        return "pipeline"
    if getattr(args, "lecture", None):
        return "lecture-transcription"
    return "pipeline"


def _route_for(args: argparse.Namespace, operation: str) -> str:
    """Choose a backend only after the invocation's operation is known."""
    if operation != "lecture-transcription":
        return "pipeline"
    return "verbatim" if args.engine in TRANSCRIPTION_ENGINES else "pipeline"


def _resolve_engine(args: argparse.Namespace, operation: str) -> None:
    """Apply the default backend, and refuse a named one the operation cannot use.

    A verbatim backend transcribes one recording. It has nothing to do for a
    sync, an audit, a manifest run or a finalize, and before the operation and
    the backend were separated those combinations failed with a message saying
    so. Defaulting silently would turn that refusal into a five-phase pipeline
    run: the caller asks for what the doctor said and receives NotebookLM's
    paraphrase, with nothing in the output to tell them which they got.
    """
    named = args.engine is not None
    # Remembered because the five-phase pipeline must be asked for by name,
    # not reached by omission -- see _assert_pipeline_was_asked_for.
    args.engine_named = named
    if args.engine is None:
        args.engine = NOTEBOOKLM_RAW
    if named and operation != "lecture-transcription" and args.engine in TRANSCRIPTION_ENGINES:
        raise LauncherError(
            f"--engine {args.engine} transcribes a single recording named by "
            "--lecture, and this invocation is doing something else. Drop "
            "--engine to let the operation run, or name the recording."
        )


def _assert_pipeline_was_asked_for(args: argparse.Namespace) -> None:
    """Refuse to run the five-phase pipeline nobody named.

    notebooklm-raw is the route for every
    transcription until the user names another, and the default now says so
    too. But the default is a *backend* choice, and --draft-only is a
    *pipeline* flag: a run that passes a manifest and --draft-only reaches the
    five phases whatever the backend default is.

    That gap was reached in practice. An agent fetched the verbatim transcript,
    then -- instead of writing the five sections from it, which is its own work
    and has no tool -- ran the launcher again with a manifest and --draft-only
    and had NotebookLM write them. The user asked for what the doctor said and
    received a paraphrase, and nothing in between reported a choice, because no
    choice was expressed.

    So the pipeline has to be named. A caller that means it says so and is
    obeyed; a caller that fell into it is told where it is and what the other
    route is.
    """
    if getattr(args, "engine_named", False):
        return
    raise LauncherError(
        "This run would start the five-phase NotebookLM pipeline, which "
        "rewrites the lecture instead of quoting it, and nothing named it. "
        "Pass --engine notebooklm to ask for it on purpose. To transcribe "
        "what was actually said, drop --draft-only and the manifest and pass "
        "--lecture <name>: that writes Verbatim/<name>.verbatim.md, and the "
        "five sections are then written from that text by the Agent."
    )


def _run_context(args: argparse.Namespace, operation: str, context: LauncherContext) -> int:
    if args.verify_provenance:
        return _run_provenance_check(args, context)
    if args.validate_draft:
        return _run_draft_validation(args, context)
    if args.build_exam_index:
        return _run_exam_index(args, context)
    if args.extract_figures:
        return _run_figure_extraction(args, context)
    if args.question_bank or args.exam:
        return _run_question_bank(args, context)
    if args.auto_manifest:
        if args.source_manifest:
            raise LauncherError("--auto-manifest cannot be combined with --source-manifest")
        auto_manifest_path = generate_auto_manifest(
            context.module.paths.root,
            args.auto_manifest,
            str(context.config.get("nlm_executable") or "nlm"),
        )
        args.source_manifest = str(auto_manifest_path)
        print(f"[Auto-Manifest] Generated manifest: {auto_manifest_path}")
    if operation == "source-sync":
        if args.lecture or args.all or args.list or args.slides or args.source_manifest:
            raise LauncherError(
                "--sync-sources cannot be combined with lecture selection or --source-manifest"
            )
        if args.apply == args.audit_only:
            raise LauncherError(
                "--sync-sources requires exactly one of --audit-only or --apply"
            )
        from source_sync import (
            SourceSyncError,
            SourceSyncRequest,
            apply_source_sync,
            audit_source_sync,
            discover_local_sources,
            render_source_sync_report,
        )

        if not args.source_sync_manifest:
            if args.apply:
                raise LauncherError("--apply requires --source-sync-manifest")
            print("\n=== Module Source Sync Inventory ===")
            print(f"Module: {context.module.module_id}")
            for path in discover_local_sources(context.module.paths.root):
                print(f"[PENDING AGENT REVIEW] {path}")
            print("Create an Agent-reviewed manifest, then rerun the audit.")
            print("=== End Module Source Sync Inventory ===\n")
            return 0
        try:
            sync_request = SourceSyncRequest(
                context.engine,
                context.config,
                context.module.module_id,
                context.module.paths.root,
                context.notebooks,
                args.source_sync_manifest,
            )
            report = (
                apply_source_sync(sync_request)
                if args.apply
                else audit_source_sync(sync_request)
            )
        except SourceSyncError as error:
            raise LauncherError(str(error)) from error
        print(render_source_sync_report(report))
        return 0 if report.status in {"planned", "completed"} else 1
    if _route_for(args, operation) == "verbatim":
        return _run_local_transcription(args, context)
    recordings = _recordings(
        context.engine,
        tuple(notebook.notebook_uuid for notebook in context.notebooks),
        context.config,
    )
    pending = _pending_recordings(
        context.engine, recordings, context.module.paths.transcripts
    )
    if args.list:
        _print_inventory(recordings, pending)
        return 0
    manifest = (
        _source_manifest(args.source_manifest)
        if args.source_manifest
        else None
    )
    if args.transcribe_all_pending:
        if args.lecture or args.source_manifest or args.auto_manifest:
            raise LauncherError(
                "--transcribe-all-pending cannot be combined with --lecture, --source-manifest, or --auto-manifest"
            )
        selected = pending
        manifest = None
    elif manifest:
        if args.lecture or args.all or args.slides:
            raise LauncherError(
                "--source-manifest cannot be combined with --lecture, "
                "--all, or --slides"
            )
        selected = [
            _requested_recording(
                context.engine, recordings, manifest.recording_sources[0]
            )
        ]
    else:
        if not args.audit_only:
            raise LauncherError(
                "A source manifest is required for a real transcription; "
                "pass --auto-manifest, --transcribe-all-pending, or --source-manifest"
            )
        selected = _selected_recordings(_selection(args, context, recordings))
    # A lecture manifest validates current selected files in phase 0; a module-wide
    # sync checkpoint also includes unrelated files and cannot gate that lecture.
    if not args.audit_only and manifest is None:
        from source_sync import source_sync_preflight

        pending_sync = source_sync_preflight(context.module.paths.root)
        if pending_sync:
            raise LauncherError(
                "Module source sync requires Agent review before transcription: "
                + "; ".join(pending_sync)
            )
    if not (args.audit_only or args.finalize_draft or args.recovery_phase):
        _assert_pipeline_was_asked_for(args)
    return _execute_selected(args, context, selected, manifest)


def main() -> int:
    configure_console_streams()
    args = _parser().parse_args()
    operation = _operation_for(args)
    try:
        _resolve_engine(args, operation)
    except LauncherError as error:
        print(f"[!] {error}", file=sys.stderr)
        return 1
    if args.json_events:
        # Before the first print: the launcher's own Arabic progress has to
        # move to stderr too, or it corrupts the stream the engine writes.
        events.enable()
    if args.doctor or args.doctor_live or args.doctor_json:
        if args.doctor_json:
            from dependency_doctor import report_json as dependency_report
        else:
            from dependency_doctor import report as dependency_report
        return dependency_report(live=args.doctor_live)
    try:
        if bool(args.recovery_phase) != bool(args.recovery_response):
            raise LauncherError(
                "--recovery-phase and --recovery-response must be supplied together"
            )
        if args.recovery_response and not (args.resume_run or args.resume_latest):
            raise LauncherError("Agent recovery requires --resume-run or --resume-latest")
        if args.recovery_response and args.retry_phase:
            raise LauncherError("Agent recovery cannot be combined with --retry-phase")
        from library_workspace import prepare_workspace

        workspace = prepare_workspace(Path(args.workspace))
        if args.get_engine_settings or args.set_web_figures:
            from engine_settings import read_settings, set_settings

            preferences = (set_settings(workspace, args.set_web_figures == "on")
                      if args.set_web_figures else read_settings(workspace))
            print(json.dumps(preferences))
            return 0
        if args.list_modules:
            _print_modules(discover_modules(workspace, args.modules_root))
            return 0
        answer: dict[str, Any] | list[dict[str, Any]]
        if args.remove_module or args.restore_module or args.list_removed_modules:
            import library_trash

            if args.remove_module:
                answer = library_trash.remove_module(workspace, args.remove_module)
            elif args.restore_module:
                answer = library_trash.restore_module(workspace, args.restore_module)
            else:
                answer = library_trash.list_removed_modules(workspace)
            print(json.dumps(answer, ensure_ascii=False))
            return 0
        if args.remove_transcript or args.restore_trash or args.list_trash:
            import library_trash

            module = resolve_module(discover_modules(workspace, args.modules_root), args.module)
            if args.remove_transcript:
                answer = library_trash.remove_transcript(module, args.remove_transcript, args.transcript_kinds or [])
            elif args.restore_trash:
                answer = library_trash.restore_trash(module, args.restore_trash)
            else:
                answer = library_trash.list_trash(module)
            print(json.dumps(answer, ensure_ascii=False))
            return 0
        if args.hide_lecture is not None or args.restore_recordings is not None:
            from lecture_registry import hide_lecture, restore_recordings

            module = resolve_module(discover_modules(workspace, args.modules_root), args.module)
            result = hide_lecture(module, args.hide_lecture) if args.hide_lecture is not None else restore_recordings(module, args.restore_recordings)
            print(json.dumps(result, ensure_ascii=False))
            return 0
        from module_activity import module_activity

        module = resolve_module(discover_modules(workspace, args.modules_root), args.module)
        with module_activity(module):
            context = _launcher_context(args)
            return _run_context(args, operation, context)
    except (LauncherError, ModuleConfigError, OSError) as error:
        print(f"[Launcher Error] {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
