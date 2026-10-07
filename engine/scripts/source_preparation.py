"""Cached preparation of Agent-selected NotebookLM source files.

The Agent decides relevance and the requested action in the temporary source
manifest.  This module performs conversion, local OCR and bounded page-image repair:
it never edits an original source and it never decides that a reference should
be included in a lecture by itself.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import textwrap
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from atomic_io import _atomic_write_text
from file_lock import exclusive_file_lock
from source_image_repair import (
    IMAGE_EXTENSIONS,
    ImageRepairError,
    local_image_text,
    local_pdf_ocr_is_reliable,
    transcribe_page_images,
)


class PreparationError(RuntimeError):
    """Raised when a selected source cannot be prepared safely."""


SUPPORTED_UPLOAD_EXTENSIONS = {
    ".pdf",
    ".pptx",
    ".docx",
    ".txt",
    ".md",
    ".m4a",
    ".mp3",
    ".wav",
    ".aac",
    ".mp4",
    ".ogg",
}
SLIDE_EXTENSIONS = {".ppt", ".pptx", ".pps", ".ppsx"}
AUTO_PREPARATION_ROOTS = ("Lecture", "Questions", "Exams")
LEGACY_DOCUMENT_EXTENSIONS = {".doc", ".xls", ".xlsx", ".odt", ".rtf", ".epub"}
VIDEO_EXTENSIONS = {".mp4", ".mkv", ".webm", ".avi", ".mov"}
MEDIA_CONVERSION_EXTENSIONS = VIDEO_EXTENSIONS | {".oga", ".opus", ".amr"}
ACTION_NAMES = {
    "auto",
    "use",
    "use_remote",
    "convert",
    "ocr",
    "compress",
    "chunk",
    "ignore",
    "wait",
}
CACHE_DIRS = {
    "convert": "converted",
    "ocr": "ocr",
    "compress": "compressed",
    "chunk": "chunks",
}


def automatic_preparation_manifest(source_root: str | Path) -> dict[str, list[dict[str, str]]]:
    """Build safe ``auto`` preparation entries for the module inventory.

    This manifest only selects deterministic format preparation.  It does not
    classify assessment provenance or decide which sources belong to a lecture.
    Those decisions remain owned by the agent's source manifest.
    """
    root = Path(source_root).expanduser().resolve()
    entries: list[dict[str, str]] = []
    for root_name in AUTO_PREPARATION_ROOTS:
        directory = root / root_name
        if not directory.is_dir():
            continue
        for path in sorted(
            directory.rglob("*"), key=lambda candidate: str(candidate).casefold()
        ):
            if not path.is_file() or any(
                part.startswith(".") for part in path.relative_to(directory).parts
            ):
                continue
            relative_path = path.relative_to(root).as_posix()
            entries.append({"path": relative_path, "role": "auto", "action": "auto"})
    return {"sources": entries}


@contextmanager
def _artifact_lock(cache_root: Path, destination: Path) -> Iterator[None]:
    lock_directory = cache_root / "locks"
    lock_key = hashlib.sha256(str(destination).encode("utf-8")).hexdigest()[:16]
    lock_path = lock_directory / f"artifact-{lock_key}.lock"
    with exclusive_file_lock(lock_path):
        yield


@dataclass(frozen=True)
class PreparationEntry:
    """One Agent decision for one local or remote source reference."""

    relative_path: str
    role: str = "reference"
    action: str = "auto"
    target_format: str | None = None
    relevance: str = ""
    allow_unspoken_additions: bool = False
    topics: tuple[str, ...] = ()
    pages: tuple[int, ...] = ()
    source_label: str = ""
    language: str = "eng+ara"
    max_upload_bytes: int | None = None


@dataclass(frozen=True)
class PreparedSource:
    relative_path: str
    original_path: str
    prepared_path: str
    action: str
    status: str
    role: str
    original_size: int = 0
    prepared_size: int = 0
    original_sha256: str = ""
    prepared_sha256: str = ""
    upload_extension: str = ""
    notes: str = ""
    relevance: str = ""
    allow_unspoken_additions: bool = False
    topics: tuple[str, ...] = ()
    pages: tuple[int, ...] = ()


@dataclass(frozen=True)
class PreparationRequest:
    source_root: Path
    cache_root: Path
    entry: PreparationEntry
    execute: bool
    large_source_bytes: int


@dataclass(frozen=True)
class PreparedArtifact:
    """Materialized or planned output metadata used to build a report entry."""

    action: str
    status: str
    path: Path
    notes: str


@dataclass
class PreparationReport:
    entries: list[PreparedSource] = field(default_factory=list)
    blocking_errors: list[str] = field(default_factory=list)
    source_errors: dict[str, str] = field(default_factory=dict)
    cache_root: str = ""
    execute: bool = False
    mutation_count: int = 0

    @property
    def ready(self) -> bool:
        return not self.blocking_errors and not self.source_errors

    @property
    def by_relative_path(self) -> dict[str, PreparedSource]:
        """Prepared sources keyed the way every caller looks them up.

        The key has to survive a Windows relative path: callers reach this
        through normalize_relative_source_path or source_sync._normalize_
        relative, both of which fold "\\" to "/" before looking up. Keying on a
        bare casefold made the match depend on the manifest and the platform
        agreeing on a separator.
        """
        return {
            normalize_prepared_key(entry.relative_path): entry for entry in self.entries
        }


def normalize_prepared_key(relative_path: str) -> str:
    """Fold a relative source path to the single key shape the engine uses."""
    return relative_path.replace("\\", "/").strip(" ./").casefold()


@dataclass(frozen=True)
class PdfInspection:
    page_count: int
    text_pages: int
    total_characters: int
    sparse_page_ratio: float
    garbage_ratio: float

    @property
    def needs_ocr(self) -> bool:
        return self.total_characters < 50 or self.sparse_page_ratio > 0.8


def _normalized_relative(path: str) -> str:
    return path.replace("\\", "/").strip(" ./").casefold()


def _entry_path(item: Any) -> str:
    if isinstance(item, str):
        return item.strip()
    if isinstance(item, dict):
        for key in ("path", "source", "name"):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return ""


def _entry_from_item(item: Any, role: str) -> PreparationEntry | None:
    relative_path = _entry_path(item)
    if not relative_path:
        return None
    details = item if isinstance(item, dict) else {}
    action = str(details.get("action", "auto")).strip().casefold()
    entry_role = str(details.get("type") or details.get("role") or role)
    if entry_role == "ignore" and action == "auto":
        action = "ignore"
    if action not in ACTION_NAMES:
        raise PreparationError(f"Unsupported source preparation action: {action}")
    pages = _page_numbers(details.get("pages"))
    topics = _string_tuple(details.get("topics"))
    max_upload = details.get("max_upload_bytes")
    if max_upload is not None and (not isinstance(max_upload, int) or max_upload < 1):
        raise PreparationError(f"max_upload_bytes must be a positive integer: {relative_path}")
    return PreparationEntry(
        relative_path=relative_path,
        role=entry_role,
        action=action,
        target_format=_target_format(details.get("target_format")),
        relevance=str(details.get("relevance") or details.get("why") or "").strip(),
        allow_unspoken_additions=bool(details.get("allow_unspoken_additions", False)),
        topics=topics,
        pages=pages,
        source_label=str(details.get("label") or details.get("source_label") or "").strip(),
        language=str(details.get("ocr_language") or details.get("language") or "eng+ara").strip(),
        max_upload_bytes=max_upload,
    )


def _string_tuple(value: Any) -> tuple[str, ...]:
    if isinstance(value, str) and value.strip():
        return (value.strip(),)
    if not isinstance(value, list):
        return ()
    return tuple(str(item).strip() for item in value if str(item).strip())


def _page_numbers(value: Any) -> tuple[int, ...]:
    if value is None:
        return ()
    raw_values = [value] if isinstance(value, (int, str)) else value
    if not isinstance(raw_values, list):
        raise PreparationError("pages must be an integer, range, or list")
    pages: set[int] = set()
    for raw_value in raw_values:
        if isinstance(raw_value, int):
            if raw_value < 1:
                raise PreparationError("PDF pages are one-based positive integers")
            pages.add(raw_value)
            continue
        if not isinstance(raw_value, str):
            raise PreparationError("PDF page selections must be integers or ranges")
        match = re.fullmatch(r"\s*(\d+)\s*(?:[-:]\s*(\d+)\s*)?", raw_value)
        if not match:
            raise PreparationError(f"Invalid PDF page range: {raw_value}")
        start = int(match.group(1))
        end = int(match.group(2) or start)
        if start < 1 or end < start:
            raise PreparationError(f"Invalid PDF page range: {raw_value}")
        pages.update(range(start, end + 1))
    return tuple(sorted(pages))


def _target_format(value: Any) -> str | None:
    if value is None:
        return None
    target = str(value).strip().casefold()
    if not target:
        return None
    return target if target.startswith(".") else f".{target}"


def manifest_entries(payload: dict[str, Any] | None) -> tuple[PreparationEntry, ...]:
    """Flatten the manifest's source groups while preserving first decisions."""
    if not payload:
        return ()
    grouped: list[tuple[str, str, Any]] = [
        ("reference", "sources", payload.get("sources", [])),
        ("recording", "recording_sources", payload.get("recording_sources", [])),
        ("slides", "slides", payload.get("slides")),
        ("reference", "references", payload.get("references", [])),
        ("assessment", "assessment_sources", payload.get("assessment_sources", [])),
        ("approved_upload", "approved_uploads", payload.get("approved_uploads", [])),
    ]
    selected: dict[str, PreparationEntry] = {}
    for role, group_name, values in grouped:
        items = values if isinstance(values, list) else [values]
        for item in items:
            entry = _entry_from_item(item, role)
            if not entry:
                continue
            key = _normalized_relative(entry.relative_path)
            if key in selected:
                previous = selected[key]
                raise PreparationError(
                    "Source manifest selects the same path more than once: "
                    f"{entry.relative_path} ({previous.role} and {group_name})"
                )
            selected[key] = entry
    return tuple(selected.values())


def _safe_cache_stem(relative_path: str) -> str:
    stem = Path(relative_path).stem
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._")
    return safe or "source"


def _cache_destination(
    request: PreparationRequest,
    source_hash: str,
    action: str,
    extension: str,
) -> Path:
    entry = request.entry
    fingerprint = hashlib.sha256(
        json.dumps(
            [
                entry.relative_path if action != "ocr" else "page-images-v1",
                source_hash,
                action,
                extension,
                entry.language,
                entry.pages,
            ],
            ensure_ascii=False,
        ).encode("utf-8")
    ).hexdigest()[:12]
    directory = request.cache_root / CACHE_DIRS[action]
    # Keep the uploaded basename canonical (for example ``Final 2025.pdf``),
    # while using a content fingerprint in the cache directory. NotebookLM
    # then exposes a useful source title instead of an opaque cache filename,
    # and changing the original cannot reuse a stale derived artifact.
    stem = _safe_cache_stem(entry.relative_path)
    if action == "chunk" and entry.pages:
        page_text = "-".join(str(page) for page in entry.pages)
        stem = f"{stem}-pages-{page_text}"
    return directory / fingerprint / f"{stem}{extension}"


def _source_path(source_root: Path, relative_path: str) -> Path:
    candidate = (source_root / relative_path).resolve()
    try:
        candidate.relative_to(source_root.resolve())
    except ValueError as error:
        raise PreparationError(f"Source path escapes the module: {relative_path}") from error
    return candidate


def _resolve_manifest_entry(source_root: Path, entry: PreparationEntry) -> PreparationEntry:
    candidate = _source_path(source_root, entry.relative_path)
    if candidate.is_file() or "/" in entry.relative_path.replace("\\", "/"):
        return entry
    matches = sorted(
        path
        for directory_name in ("Lecture", "Questions", "Exams")
        for path in (source_root / directory_name).rglob(candidate.name)
        if path.is_file() and not any(part.startswith(".") for part in path.parts)
    )
    if len(matches) == 1:
        relative = matches[0].relative_to(source_root).as_posix()
        return replace(entry, relative_path=relative)
    if len(matches) > 1:
        raise PreparationError(f"Bare source name is ambiguous: {entry.relative_path}")
    return entry


def _source_stem(value: str) -> str:
    return re.sub(r"[^\w\u0600-\u06ff]+", " ", Path(value).stem.casefold()).strip()


def _cache_stem_variant(source_stem: str, candidate_stem: str) -> bool:
    """Recognize cache names produced by releases that suffixed a 12-char hash."""
    separator = f"{source_stem} "
    if not source_stem or not candidate_stem.startswith(separator):
        return False
    suffix = candidate_stem[len(separator) :]
    return bool(re.fullmatch(r"[0-9a-f]{12}", suffix))


def _compatible_remote_extension(local: str, remote: str) -> bool:
    local_extension = Path(local).suffix.casefold()
    remote_extension = Path(remote).suffix.casefold()
    if not local_extension or not remote_extension or local_extension == remote_extension:
        return True
    slide_files = SLIDE_EXTENSIONS | {".pdf"}
    if local_extension in slide_files and remote_extension in slide_files:
        return True
    document_files = {".pdf", ".docx", ".txt", ".md"} | IMAGE_EXTENSIONS
    if local_extension in document_files and remote_extension in document_files:
        return True
    media_files = MEDIA_CONVERSION_EXTENSIONS | {".m4a", ".mp3", ".wav", ".aac", ".ogg"}
    return local_extension in media_files and remote_extension in media_files


def _remote_equivalent(entry: PreparationEntry, remote_titles: tuple[str, ...]) -> bool:
    entry_stem = _source_stem(entry.relative_path)
    return bool(entry_stem) and any(
        (
            entry_stem == _source_stem(title)
            or _cache_stem_variant(entry_stem, _source_stem(title))
        )
        and _compatible_remote_extension(entry.relative_path, title)
        for title in remote_titles
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source_file:
        for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _run_tool(command: list[str], timeout: int, description: str) -> None:
    try:
        completed = subprocess.run(
            command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, check=False
        )
    except FileNotFoundError as error:
        raise PreparationError(f"Required tool for {description} was not found") from error
    except subprocess.TimeoutExpired as error:
        raise PreparationError(f"{description} timed out") from error
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise PreparationError(f"{description} failed: {detail[:400]}")


def _pdf_text(path: Path) -> tuple[str, str]:
    if not shutil.which("pdfinfo") or not shutil.which("pdftotext"):
        raise PreparationError("pdfinfo and pdftotext are required for PDF inspection")
    try:
        metadata = subprocess.run(
            ["pdfinfo", str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60, check=False
        )
        extracted = subprocess.run(
            ["pdftotext", "-layout", str(path), "-"],
            capture_output=True,
            text=True, encoding="utf-8", errors="replace",
            timeout=180,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise PreparationError("PDF inspection timed out") from error
    if metadata.returncode or extracted.returncode:
        detail = extracted.stderr.strip() or metadata.stderr.strip() or "PDF inspection failed"
        raise PreparationError(detail[:400])
    return metadata.stdout, extracted.stdout


def inspect_pdf(path: Path) -> PdfInspection:
    metadata, extracted = _pdf_text(path)
    page_match = re.search(r"^Pages:\s+(\d+)", metadata, flags=re.MULTILINE)
    declared_pages = int(page_match.group(1)) if page_match else 0
    pages = extracted.split("\f")
    if pages and not pages[-1].strip():
        pages.pop()
    page_count = declared_pages or max(len(pages), 1)
    counts = [sum(character.isalnum() for character in page) for page in pages]
    if len(counts) < page_count:
        counts.extend([0] * (page_count - len(counts)))
    garbage = sum(
        1 for character in extracted if ord(character) < 32 and character not in "\n\r\t\f"
    ) + extracted.count("\ufffd")
    return PdfInspection(
        page_count=page_count,
        text_pages=sum(count >= 20 for count in counts),
        total_characters=sum(counts),
        sparse_page_ratio=sum(count < 20 for count in counts) / max(page_count, 1),
        garbage_ratio=garbage / max(len(extracted), 1),
    )


def _auto_action(source: Path, entry: PreparationEntry, large_limit: int) -> tuple[str, str, str]:
    extension = source.suffix.casefold()
    if extension in SLIDE_EXTENSIONS - {".pptx"}:
        return "convert", ".pdf", "legacy slide format needs a searchable PDF"
    if extension in LEGACY_DOCUMENT_EXTENSIONS:
        return "convert", ".pdf", "legacy document format needs a searchable PDF"
    if extension in {".txt", ".md"}:
        return "convert", ".pdf", "text source is converted to an uploadable PDF"
    if extension in MEDIA_CONVERSION_EXTENSIONS and extension not in SUPPORTED_UPLOAD_EXTENSIONS:
        return "convert", ".m4a", "media container is normalized to .m4a with ffmpeg for NotebookLM"
    if extension in IMAGE_EXTENSIONS:
        return "ocr", ".pdf", "image needs searchable source text"
    if extension == ".pdf":
        try:
            quality = inspect_pdf(source)
        except PreparationError:
            return "ocr", ".pdf", "PDF inspection failed; a searchable OCR copy is required"
        if quality.needs_ocr or quality.garbage_ratio > 0.02:
            return "ocr", ".pdf", "PDF has no reliable searchable text layer"
    if source.stat().st_size > (entry.max_upload_bytes or large_limit):
        return "wait", extension, "large source retained for an extended upload wait"
    return "use", extension, "source is already eligible"


def _target_for_action(
    source: Path, entry: PreparationEntry, large_limit: int
) -> tuple[str, str, str]:
    if entry.action == "auto":
        return _auto_action(source, entry, large_limit)
    action = entry.action
    if action == "use" and source.suffix.casefold() in (
        IMAGE_EXTENSIONS | SLIDE_EXTENSIONS | LEGACY_DOCUMENT_EXTENSIONS
        | MEDIA_CONVERSION_EXTENSIONS | {".pdf", ".txt", ".md"}
    ):
        return _auto_action(source, entry, large_limit)
    extension = entry.target_format or source.suffix.casefold()
    if action in {"use", "use_remote", "ignore", "wait"}:
        return action, extension, "Agent selected no local mutation"
    if action in {"convert", "ocr", "compress", "chunk"}:
        if action in {"compress", "chunk"} and source.suffix.casefold() != ".pdf":
            raise PreparationError(f"{action} requires a PDF source: {entry.relative_path}")
        if action == "ocr" and source.suffix.casefold() not in IMAGE_EXTENSIONS | {".pdf"}:
            raise PreparationError(f"ocr requires a PDF or raster image: {entry.relative_path}")
        if action == "chunk" and not entry.pages:
            raise PreparationError(f"chunk action requires explicit relevant PDF pages: {entry.relative_path}")
        if action in {"ocr", "compress", "chunk"}:
            extension = ".pdf"
        if action == "convert" and source.suffix.casefold() in MEDIA_CONVERSION_EXTENSIONS:
            extension = entry.target_format or ".m4a"
        if action == "convert" and source.suffix.casefold() in SLIDE_EXTENSIONS:
            extension = entry.target_format or ".pdf"
        if action == "convert" and source.suffix.casefold() in LEGACY_DOCUMENT_EXTENSIONS:
            extension = entry.target_format or ".pdf"
        if action == "convert" and source.suffix.casefold() in {".txt", ".md"}:
            extension = entry.target_format or ".pdf"
        return action, extension, f"Agent requested {action}"
    raise PreparationError(f"Unsupported source preparation action: {action}")


def _ensure_output(path: Path, description: str) -> None:
    if not path.is_file() or path.stat().st_size == 0:
        raise PreparationError(f"{description} did not produce a usable file")


def _convert_slides(source: Path, destination: Path) -> None:
    executable = shutil.which("libreoffice") or shutil.which("soffice")
    if not executable:
        raise PreparationError("LibreOffice/soffice is required to convert legacy slides")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="transcriber-slides-") as output_dir:
        _run_tool(
            [
                executable,
                "--headless",
                "--convert-to",
                "pdf",
                "--outdir",
                output_dir,
                str(source),
            ],
            300,
            "slide conversion",
        )
        generated = Path(output_dir) / f"{source.stem}.pdf"
        _ensure_output(generated, "slide conversion")
        shutil.copy2(generated, destination)


def _convert_text(source: Path, destination: Path) -> None:
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfgen.canvas import Canvas
    except ImportError as error:
        raise PreparationError("reportlab is required to convert text sources to PDF") from error
    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas = Canvas(str(destination), pagesize=A4)
    width, height = A4
    font_name = "Helvetica"
    try:
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont

        font_path = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
        if font_path.is_file():
            pdfmetrics.registerFont(TTFont("TranscriberSans", str(font_path)))
            font_name = "TranscriberSans"
    except (ImportError, OSError):
        pass
    canvas.setFont(font_name, 9)
    y = height - 48
    for raw_line in source.read_text(encoding="utf-8", errors="replace").splitlines():
        wrapped_lines = textwrap.wrap(raw_line, width=125) or [""]
        for line in wrapped_lines:
            canvas.drawString(42, y, line)
            y -= 12
            if y < 42:
                canvas.showPage()
                canvas.setFont(font_name, 9)
                y = height - 48
    canvas.save()


def _convert_media(source: Path, destination: Path) -> None:
    executable = shutil.which("ffmpeg")
    if not executable:
        raise PreparationError("ffmpeg is required to normalize unsupported media")
    destination.parent.mkdir(parents=True, exist_ok=True)
    _run_tool(
        [
            executable,
            "-nostdin",
            "-y",
            "-i",
            str(source),
            "-vn",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            str(destination),
        ],
        1800,
        "media conversion",
    )


def _convert_source(source: Path, destination: Path) -> None:
    extension = source.suffix.casefold()
    if extension in SLIDE_EXTENSIONS or extension in LEGACY_DOCUMENT_EXTENSIONS:
        _convert_slides(source, destination)
    elif extension in MEDIA_CONVERSION_EXTENSIONS:
        _convert_media(source, destination)
    elif extension in {".txt", ".md"} and destination.suffix.casefold() == ".pdf":
        _convert_text(source, destination)
    else:
        raise PreparationError(f"No safe converter is registered for {source.name}")


def _ocr_pdf(source: Path, destination: Path, language: str) -> None:
    executable = shutil.which("ocrmypdf") or shutil.which("pdfocr")
    if not executable:
        raise PreparationError("ocrmypdf or pdfocr is required for scanned PDFs")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if Path(executable).stem.casefold() == "ocrmypdf":
        command = [
            executable,
            "--force-ocr",
            "--deskew",
            "--output-type",
            "pdf",
            "--optimize",
            "0",
            "--language",
            language,
            str(source),
            str(destination),
        ]
    else:
        command = [executable, str(source), str(destination)]
    _run_tool(command, 300, "PDF OCR")


def _compress_pdf(source: Path, destination: Path) -> bool:
    executable = shutil.which("gs") or shutil.which("ghostscript")
    if not executable:
        raise PreparationError("Ghostscript (gs) is required to compress a large PDF")
    destination.parent.mkdir(parents=True, exist_ok=True)
    _run_tool(
        [
            executable,
            "-sDEVICE=pdfwrite",
            "-dCompatibilityLevel=1.4",
            "-dPDFSETTINGS=/ebook",
            "-dNOPAUSE",
            "-dQUIET",
            "-dBATCH",
            f"-sOutputFile={destination}",
            str(source),
        ],
        1800,
        "PDF compression",
    )
    return destination.stat().st_size < source.stat().st_size


def _chunk_pdf(source: Path, destination: Path, pages: tuple[int, ...]) -> None:
    if not pages:
        raise PreparationError("chunk action requires explicit relevant PDF pages")
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError as error:
        raise PreparationError("pypdf is required to extract relevant PDF pages") from error
    reader = PdfReader(str(source))
    writer = PdfWriter()
    for page_number in pages:
        index = page_number - 1
        if index >= len(reader.pages):
            raise PreparationError(f"Selected PDF page is outside the document: {page_number}")
        writer.add_page(reader.pages[index])
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as output_file:
        writer.write(output_file)


def _execute_action(
    source: Path,
    destination: Path,
    entry: PreparationEntry,
    action: str,
) -> str:
    if action == "convert":
        _convert_source(source, destination)
        return "converted without modifying the original"
    if action == "ocr":
        _ocr_pdf(source, destination, entry.language)
        return f"OCR language: {entry.language}"
    if action == "compress":
        if not _compress_pdf(source, destination):
            return "compression did not reduce size; original retained"
        return "compressed copy is smaller than the original"
    if action == "chunk":
        _chunk_pdf(source, destination, entry.pages)
        return "filtered to Agent-selected relevant pages"
    raise PreparationError(f"Cannot execute preparation action: {action}")


def _build_prepared_source(
    request: PreparationRequest,
    source: Path,
    artifact: PreparedArtifact,
    original_hash: str,
) -> PreparedSource:
    prepared_path = artifact.path
    prepared_exists = prepared_path.is_file()
    prepared_size = prepared_path.stat().st_size if prepared_exists else 0
    prepared_hash = _sha256(prepared_path) if prepared_exists else ""
    if prepared_path == source:
        prepared_size = source.stat().st_size
        prepared_hash = original_hash
    entry = request.entry
    return PreparedSource(
        relative_path=entry.relative_path,
        original_path=str(source),
        prepared_path=str(prepared_path),
        action=artifact.action,
        status=artifact.status,
        role=entry.role,
        original_size=source.stat().st_size,
        prepared_size=prepared_size,
        original_sha256=original_hash,
        prepared_sha256=prepared_hash,
        upload_extension=prepared_path.suffix.casefold(),
        notes=artifact.notes,
        relevance=entry.relevance,
        allow_unspoken_additions=entry.allow_unspoken_additions,
        topics=entry.topics,
        pages=entry.pages,
    )


def _usable_pdf(path: Path) -> bool:
    if not path.is_file() or not path.stat().st_size:
        return False
    try:
        quality = inspect_pdf(path)
    except PreparationError:
        return False
    return not quality.needs_ocr and quality.garbage_ratio <= 0.02


def _local_ocr_artifact(source: Path, destination: Path, language: str, deadline: float) -> str | None:
    """Return local OCR provenance, or None for an unusable PDF text/confidence check."""
    with tempfile.TemporaryDirectory(prefix="qabas-local-ocr-") as temporary:
        if source.suffix.casefold() in IMAGE_EXTENSIONS:
            text = local_image_text(source, language)
            _atomic_write_text(destination.parent / "page-transcription.md", f"Local tesseract OCR; page: 1.\n\n{text}\n")
            _convert_text(destination.parent / "page-transcription.md", destination)
            return "Local tesseract OCR; page: 1."
        local_pdf = Path(temporary) / "ocr.pdf"
        _ocr_pdf(source, local_pdf, language)
        if _usable_pdf(local_pdf) and local_pdf_ocr_is_reliable(source, language, deadline):
            shutil.copyfile(local_pdf, destination)
            return f"OCR language: {language}"
    return None


def _ocr_artifact(source: Path, destination: Path, language: str) -> str:
    text_path = destination.parent / "page-transcription.md"
    failure_path = destination.parent / "repair-failed.txt"
    if text_path.is_file():
        if not _usable_pdf(destination):
            _convert_text(text_path, destination)
        return text_path.read_text(encoding="utf-8").splitlines()[0]
    if failure_path.is_file():
        raise PreparationError(failure_path.read_text(encoding="utf-8"))
    try:
        local_note = _local_ocr_artifact(source, destination, language, time.monotonic() + 300)
    except (PreparationError, ImageRepairError):
        # OCR tool/quality errors permit image reading; filesystem failures propagate.
        local_note = None
    if local_note is not None:
        return local_note
    try:
        provenance = transcribe_page_images(source, text_path)
    except ImageRepairError as error:
        message = f"No usable source text after local OCR and page-image repair: {error}"
        _atomic_write_text(failure_path, message + "\n")
        raise PreparationError(message) from error
    _convert_text(text_path, destination)
    return provenance


def _materialize_artifact(
    source: Path, destination: Path, entry: PreparationEntry, action: str
) -> PreparedArtifact:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if action == "ocr":
        # A text sidecar also records provenance on cache hits and after interrupted PDF rendering.
        if (destination.parent / "page-transcription.md").is_file() or not _usable_pdf(destination):
            note = _ocr_artifact(source, destination, entry.language)
        else:
            note = f"Reused local OCR cache; language: {entry.language}"
    elif destination.is_file() and destination.stat().st_size:
        text_path = destination.parent / "page-transcription.md"
        note = text_path.read_text(encoding="utf-8").splitlines()[0] if text_path.is_file() else "reused deterministic cache artifact"
    else:
        note = _execute_action(source, destination, entry, action)
    _ensure_output(destination, f"{action} for {entry.relative_path}")
    if (destination.suffix.casefold() == ".pdf" and action == "convert"
            and source.suffix.casefold() in SLIDE_EXTENSIONS | LEGACY_DOCUMENT_EXTENSIONS
            and not _usable_pdf(destination)):
        # Office conversion may preserve scanned pages without producing source text.
        with tempfile.TemporaryDirectory(prefix="qabas-converted-ocr-") as temporary:
            converted = Path(temporary) / "converted.pdf"
            shutil.copyfile(destination, converted)
            note = _ocr_artifact(converted, destination, entry.language)
    return PreparedArtifact(action, "ready", destination, note)


def _prepared_entry(request: PreparationRequest) -> PreparedSource:
    entry = request.entry
    source = _source_path(request.source_root, entry.relative_path)
    if not source.is_file():
        if entry.action == "use_remote" or (
            entry.action == "auto" and entry.role == "recording"
        ):
            return PreparedSource(entry.relative_path, "", "", "use_remote", "remote-only", entry.role)
        if entry.action == "auto" and entry.role == "approved_upload":
            return PreparedSource(entry.relative_path, "", "", "use", "deferred", entry.role)
        raise PreparationError(f"Selected source was not found locally: {entry.relative_path}")
    original_size = source.stat().st_size
    original_hash = _sha256(source)
    action, extension, note = _target_for_action(
        source, entry, request.large_source_bytes
    )
    if action in {"use", "use_remote", "ignore", "wait"}:
        return _build_prepared_source(
            request,
            source,
            PreparedArtifact(
                action,
                "ready" if action != "ignore" else "ignored",
                source,
                note,
            ),
            original_hash,
        )
    destination = _cache_destination(
        request, original_hash, action, extension
    )
    if not request.execute:
        return _build_prepared_source(
            request,
            source,
            PreparedArtifact(action, "planned", destination, note),
            original_hash,
        )
    try:
        with _artifact_lock(request.cache_root, destination.parent / "repair" if action == "ocr" else destination):
            artifact = _materialize_artifact(source, destination, entry, action)
    except (PreparationError, OSError) as error:
        return _build_prepared_source(
            request, source, PreparedArtifact(action, "failed", source, str(error)), original_hash
        )
    prepared_path = artifact.path
    execution_note = artifact.notes
    if action == "compress" and prepared_path.stat().st_size >= original_size:
        return _build_prepared_source(
            request,
            source,
            PreparedArtifact("wait", "ready", source, execution_note),
            original_hash,
        )
    return _build_prepared_source(
        request,
        source,
        PreparedArtifact(action, "ready", prepared_path, execution_note),
        original_hash,
    )


def prepare_manifest_sources(
    source_root: str | Path,
    payload: dict[str, Any] | None,
    *,
    execute: bool,
    cache_root: str | Path | None = None,
    large_source_bytes: int = 80 * 1024 * 1024,
    remote_titles: tuple[str, ...] = (),
    execution_paths: set[str] | None = None,
) -> PreparationReport:
    """Prepare manifest sources, retaining per-file tool failures for scoped callers.

    ``execution_paths`` limits execution to normalized relative paths; other
    entries remain planned. Invalid manifest decisions are blocking errors.
    """
    root = Path(source_root).expanduser().resolve()
    cache = Path(cache_root or root / ".transcriber-cache").expanduser().resolve()
    report = PreparationReport(cache_root=str(cache), execute=execute)
    try:
        entries = manifest_entries(payload)
    except PreparationError as error:
        report.blocking_errors.append(str(error))
        return report
    for entry in entries:
        if entry.action == "auto" and _remote_equivalent(entry, remote_titles):
            entry = replace(entry, action="use_remote")
        try:
            entry = _resolve_manifest_entry(root, entry)
            prepared = _prepared_entry(
                PreparationRequest(
                    root, cache, entry,
                    execute and (execution_paths is None or normalize_prepared_key(entry.relative_path) in execution_paths),
                    large_source_bytes,
                )
            )
        except PreparationError as error:
            report.blocking_errors.append(str(error))
            continue
        report.entries.append(prepared)
        if prepared.status == "failed":
            report.source_errors[prepared.relative_path] = prepared.notes
        if prepared.action in CACHE_DIRS and prepared.status in {"planned", "ready"}:
            report.mutation_count += 1
    return report


def inventory_preparation_manifest(source_root: str | Path, payload: dict[str, Any] | None) -> dict[str, Any]:
    """Include safe automatic preparation for files absent from the lecture manifest."""
    root = Path(source_root).resolve()
    selected = {
        normalize_prepared_key(_resolve_manifest_entry(root, entry).relative_path)
        for entry in manifest_entries(payload)
    }
    combined = dict(payload or {})
    automatic = automatic_preparation_manifest(root)["sources"]
    existing_sources = combined.get("sources", [])
    combined["sources"] = [*(existing_sources if isinstance(existing_sources, list) else [existing_sources]), *(
        entry for entry in automatic if normalize_prepared_key(entry["path"]) not in selected
    )]
    return combined


def render_preparation_report(report: PreparationReport) -> str:
    """Render a compact audit line that exposes decisions without source content."""
    lines = [
        f"Preparation cache: {report.cache_root}",
        f"Preparation actions: {len(report.entries)} selected, {report.mutation_count} mutation(s)",
    ]
    for entry in report.entries:
        if entry.action in {"use", "wait", "use_remote", "ignore"}:
            continue
        lines.append(
            f"[PREP:{entry.status.upper()}] {entry.relative_path}: "
            f"{entry.action} -> {entry.upload_extension} ({entry.notes})"
        )
    lines.extend(f"[PREP-BLOCKING] {error}" for error in report.blocking_errors)
    lines.extend(f"[PREP-FAILED] {path}: {error}" for path, error in report.source_errors.items())
    return "\n".join(lines)
