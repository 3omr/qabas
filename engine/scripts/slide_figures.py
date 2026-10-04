#!/usr/bin/env python3
"""Rasterize the diagram-heavy pages of a lecture's slides.

Slides reach NotebookLM as a PPTX or a PDF, and NotebookLM answers in text.
Everything that was a picture -- the anatomy of the anterior chamber, a
gonioscopy view, the timeline of a toxidrome -- is simply gone by the time a
transcript is written. In ophthalmology and toxicology that is most of the
teaching.

This module takes the pages that carry a diagram and writes them next to the
transcript as PNGs, plus a figures.json describing each one, so the Agent can
reference them from the transcript with a relative image link.

Why "the pages that carry a diagram" can be decided mechanically, in two parts:

1. The page yields almost no extractable text -- so it is not prose that the
   transcript already covers. source_preparation computes that signal in
   aggregate as PdfInspection.sparse_page_ratio; here it is per page.
2. The page carries a distinct, non-template image. Text alone is not enough: a section
   divider reading just "Warfarin" has eight characters and no picture at all,
   and rendering it produces a blank slide with a title on it.

Images on more than half the pages are template art. PPTX image hashes ignore
duplicate files and inherited master/layout art; PDFs use image object IDs.
Explicit closing slides are excluded. Manifests identify the source bytes and
selection inputs so changed decks and obsolete selections require extraction.

This is deliberately *not* a preparation action. A preparation action replaces
a source with one artifact, and a slide deck needs to be uploaded *and*
illustrated -- those are not alternatives. Figures are also an output-side
concern: they land beside the transcript, not in the upload set.
"""

from __future__ import annotations

import hashlib
import json
import posixpath
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import cancellation
from figure_descriptions import (
    DescriptionError,
    describe_figures,
    description_options,
    image_hash,
    neutral_label,
    reading_reference,
    valid_reading,
)

SLIDE_EXTENSIONS = {".ppt", ".pptx", ".pps", ".ppsx"}
FIGURES_DIR_NAME = "Figures"
MANIFEST_NAME = "figures.json"
SLIDE_TEXT_NAME = "slides.txt"
# 4: a deck of picture-only slides (one full-slide image, no typed text) was
# recorded as "all text" on 2026-10-04 and the stale manifest was trusted;
# bumping makes every lecture select its figures again once.
# 5: the cause was trailing-slide trimming, which ate every picture-only page.
# 6: selected figures carry a machine-read description and a deck fingerprint.
SELECTION_VERSION = "6"
SELECTION_VERSION_NAME = ".selection-version"
DRAWING_NAMESPACE = "http://schemas.openxmlformats.org/drawingml/2006/main"
RELATIONSHIP_NAMESPACE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

# A page with fewer alphanumeric characters than this is picture, not prose.
# source_preparation.inspect_pdf uses the same threshold for the aggregate
# sparse_page_ratio; keeping them equal means the two agree about what "this
# page has no text" means.
TEXT_CHARACTER_FLOOR = 20
# 150 DPI is poppler's own default and renders a slide at roughly 1650x1275 --
# legible for a diagram without producing multi-megabyte files for a 60-slide
# deck.
DEFAULT_RESOLUTION = 150
SLIDE_CONVERSION_TIMEOUT = 300
RENDER_TIMEOUT = 300
TEXT_TIMEOUT = 180
IMAGE_LIST_TIMEOUT = 180


class FigureExtractionError(RuntimeError):
    """Raised when figures cannot be produced from a slide source."""


@dataclass(frozen=True)
class Figure:
    """One rendered slide page."""

    page: int
    image_path: Path
    text_characters: int
    embedded_images: int = 0
    reading: dict[str, str] | None = None

    @property
    def is_diagram(self) -> bool:
        return self.text_characters < TEXT_CHARACTER_FLOOR and self.embedded_images > 0


@dataclass(frozen=True)
class FigureSet:
    lecture: str
    source_name: str
    output_dir: Path
    figures: tuple[Figure, ...] = ()
    total_pages: int = 0
    skipped_text_pages: int = 0
    text_path: Path | None = None
    source_fingerprint: dict[str, object] | None = None
    selection_inputs: dict[str, object] | None = None

    @property
    def manifest_path(self) -> Path:
        return self.output_dir / MANIFEST_NAME


def _run(command: list[str], timeout: int, description: str) -> subprocess.CompletedProcess[str]:
    try:
        completed = cancellation.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as error:
        raise FigureExtractionError(
            f"Required tool for {description} was not found: {command[0]}"
        ) from error
    except subprocess.TimeoutExpired as error:
        raise FigureExtractionError(f"{description} timed out") from error
    if completed.returncode != 0:
        detail = (completed.stderr.strip() or completed.stdout.strip())[:400]
        raise FigureExtractionError(f"{description} failed: {detail}")
    return completed


def page_texts(pdf_path: Path) -> list[str]:
    """The text of each page, in page order.

    pdftotext separates pages with a form feed, which is the same split
    source_preparation.inspect_pdf relies on.
    """
    if not shutil.which("pdftotext"):
        raise FigureExtractionError("pdftotext (poppler-utils) is required to find diagrams")
    extracted = _run(
        ["pdftotext", "-layout", str(pdf_path), "-"],
        TEXT_TIMEOUT,
        "slide text extraction",
    ).stdout
    pages = extracted.split("\f")
    if pages and not pages[-1].strip():
        pages.pop()
    return pages


def page_text_lengths(pdf_path: Path) -> list[int]:
    """Alphanumeric characters per page, in page order."""
    return [sum(character.isalnum() for character in page) for page in page_texts(pdf_path)]


def page_image_counts(pdf_path: Path, page_count: int) -> list[int]:
    """Distinct image objects per page, excluding objects on most (>50%) pages."""
    images: list[set[str]] = [set() for _ in range(page_count)]
    if not shutil.which("pdfimages"):
        raise FigureExtractionError("pdfimages (poppler-utils) is required to distinguish diagrams from templates")
    listing = _run(
        ["pdfimages", "-list", str(pdf_path)],
        IMAGE_LIST_TIMEOUT,
        "slide image listing",
    ).stdout
    for line in listing.splitlines()[2:]:
        fields = line.split()
        if not fields or not fields[0].isdigit():
            continue
        page = int(fields[0])
        if 1 <= page <= page_count:
            identity = ":".join(fields[10:12]) if len(fields) >= 12 else ":".join(fields[:2])
            images[page - 1].add(identity)
    return _non_template_counts(images)


def _non_template_counts(images: list[set[str]]) -> list[int]:
    frequency = Counter(identity for page in images for identity in page)
    repeated = {identity for identity, count in frequency.items() if count > 1 and count > len(images) / 2}
    return [len(page - repeated) for page in images]


def pptx_page_image_counts(source: Path) -> list[int]:
    """Hash slide-owned pictures; inherited master/layout art is decorative.

    Hashes also catch repeated pictures exported as different PDF object IDs.
    Presentation relationships preserve the actual slide order.
    """
    with zipfile.ZipFile(source) as archive:
        presentation = ET.fromstring(archive.read("ppt/presentation.xml"))
        relations = ET.fromstring(archive.read("ppt/_rels/presentation.xml.rels"))
        targets = {entry.attrib["Id"]: entry.attrib["Target"] for entry in relations}
        pages = []
        for slide in presentation.findall(".//{*}sldId"):
            name = posixpath.normpath(posixpath.join("ppt", targets[slide.attrib[f"{{{RELATIONSHIP_NAMESPACE}}}id"]])).lstrip("/")
            pages.append(_pptx_slide_hashes(archive, name))
    return _non_template_counts(pages)


def _pptx_slide_hashes(archive: zipfile.ZipFile, name: str) -> set[str]:
    rel_name = posixpath.dirname(name) + "/_rels/" + posixpath.basename(name) + ".rels"
    relations = ET.fromstring(archive.read(rel_name))
    images = {entry.attrib["Id"]: entry.attrib["Target"] for entry in relations
              if entry.attrib.get("Type", "").endswith("/image") and entry.attrib.get("TargetMode") != "External"}
    hashes = set()
    for image in ET.fromstring(archive.read(name)).iter(f"{{{DRAWING_NAMESPACE}}}blip"):
        target = images.get(image.attrib.get(f"{{{RELATIONSHIP_NAMESPACE}}}embed", ""))
        if target:
            path = posixpath.normpath(posixpath.join(posixpath.dirname(name), target)).lstrip("/")
            hashes.add(hashlib.sha256(archive.read(path)).hexdigest())
    return hashes


def selected_pages(texts: list[str], images: list[int], *, include_text_pages: bool = False) -> list[int]:
    """Keep sparse pages with non-template images, excluding trailing closings.

    Explicit closing text is excluded even when it has images. A textless
    page with at most one distinct picture is treated as decorative only when
    it is the deck's last page and the page before it is not one too: a deck
    whose slides are each one full-slide picture (a scanned or exported deck)
    ended in twenty such pages, and trimming them one by one dropped every
    slide of the lecture.
    """
    def plain(index: int) -> str:
        return re.sub(r"[\u064b-\u065f]", "", texts[index]).strip()

    def lone_picture(index: int) -> bool:
        return not plain(index) and images[index] <= 1

    end = len(texts)
    while end:
        closing = re.fullmatch(r"(?:thank\s*you|thanks|شكرا(?:\s+لكم)?|questions)[\s!?؟.]*", plain(end - 1), re.I)
        decorative = end == len(texts) and lone_picture(end - 1) and not (end >= 2 and lone_picture(end - 2))
        if closing or decorative:
            end -= 1
        else:
            break
    return [index + 1 for index, text in enumerate(texts[:end])
            if include_text_pages or (sum(character.isalnum() for character in text) < TEXT_CHARACTER_FLOOR and images[index] > 0)]


def source_fingerprint(source: Path) -> dict[str, object]:
    """Hash the actual deck bytes, independent of its name or modification time."""
    digest = hashlib.sha256()
    size = 0
    with source.open("rb") as stream:
        while chunk := stream.read(65536):
            digest.update(chunk)
            size += len(chunk)
    return {"sha256": digest.hexdigest(), "size": size}


def selection_fingerprint(inputs: object) -> str:
    """Identify selection options and per-page text/image observations."""
    return hashlib.sha256(json.dumps(inputs, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode("utf-8")).hexdigest()


def selection_options(*, resolution: int = DEFAULT_RESOLUTION, include_text_pages: bool = False) -> dict[str, object]:
    """Inputs shared by extraction and default cache consumers."""
    return {"version": SELECTION_VERSION, "text_character_floor": TEXT_CHARACTER_FLOOR,
            "resolution": resolution, "include_text_pages": include_text_pages,
            "description": description_options()}


def current_manifest(directory: Path, source: Path) -> dict | None:
    """Return a default extraction only when source, inputs and selected pages agree."""
    try:
        if (directory / SELECTION_VERSION_NAME).read_text(encoding="utf-8").strip() != SELECTION_VERSION:
            return None
        payload = json.loads((directory / MANIFEST_NAME).read_text(encoding="utf-8"))
        if payload["source"] != source.name or payload["source_fingerprint"] != source_fingerprint(source):
            return None
        inputs = payload["selection_inputs"]
        if not isinstance(inputs, dict) or any(inputs.get(key) != value for key, value in selection_options().items()):
            return None
        if payload["selection_fingerprint"] != selection_fingerprint(inputs):
            return None
        texts, images = inputs["page_texts"], inputs["page_image_counts"]
        if (not isinstance(texts, list) or not texts or not all(isinstance(text, str) for text in texts)
                or not isinstance(images, list) or len(texts) != len(images)
                or not all(type(count) is int and count >= 0 for count in images)):
            return None
        wanted = selected_pages(texts, images)
        expected = [{"page": page, "file": f"page-{page:03d}.png",
                     "text_characters": sum(character.isalnum() for character in texts[page - 1]),
                     "embedded_images": images[page - 1]} for page in wanted]
        entries = payload["figures"]
        if (not isinstance(entries, list) or len(entries) != len(expected)
                or payload["figures_fingerprint"] != selection_fingerprint(entries)
                or payload["total_pages"] != len(texts)
                or payload["skipped_text_pages"] != len(texts) - len(wanted)):
            return None
        for entry, selected in zip(entries, expected):
            if not isinstance(entry, dict) or {key: entry.get(key) for key in selected} != selected:
                return None
            reading = entry.get("reading")
            if not valid_reading(reading):
                return None
            if reading["method"] == "neutral" and reading["text"] != neutral_label(entry["page"]):
                return None
            image = directory / entry["file"]
            if image.is_file() and image_hash(image) != reading["image_sha256"]:
                return None
            typed = texts[entry["page"] - 1].strip()
            if (typed and (reading["method"] != "typed" or reading["text"] != typed)) or (not typed and reading["method"] == "typed"):
                return None
        return payload
    except (OSError, ValueError, KeyError, TypeError):
        return None


def content_figures(payload: dict) -> list[dict]:
    """Exclude recognized title/closing pages without invalidating extraction provenance."""
    selected = []
    for entry in payload["figures"]:
        reading = entry.get("reading", {}).get("text", "")
        if re.search(r"(?i)\bthank\s+you\b|شكرا", reading) and entry["page"] == payload.get("total_pages"):
            continue
        if entry["page"] == 1 and re.fullmatch(r"[\W_]*" + re.escape(payload.get("lecture", "")) + r"[\W_]*", reading, re.I):
            continue
        selected.append(entry)
    return selected


def outline_pages(outline: str) -> dict[int, str]:
    """Read page markers from extracted outlines, including optional PPTX text."""
    headings = list(re.finditer(r"(?m)^(?:--- page (\d+) ---|Slide (\d+):)\s*\n", outline))
    return {int(match.group(1) or match.group(2)): outline[match.end():headings[index + 1].start() if index + 1 < len(headings) else len(outline)].strip()
            for index, match in enumerate(headings)}


def slides_to_pdf(source: Path, output_dir: Path) -> Path:
    """Convert a slide deck to PDF. Returns the source unchanged if it is one.

    Note that .pptx reaches NotebookLM as a .pptx -- source_preparation only
    auto-converts the legacy formats -- so for the common case the PDF this
    needs does not exist yet and has to be made here.
    """
    if source.suffix.casefold() == ".pdf":
        return source
    executable = shutil.which("libreoffice") or shutil.which("soffice")
    if not executable:
        raise FigureExtractionError(
            "LibreOffice/soffice is required to render slides as figures"
        )
    output_dir.mkdir(parents=True, exist_ok=True)
    _run(
        [executable, "--headless", "--convert-to", "pdf", "--outdir", str(output_dir), str(source)],
        SLIDE_CONVERSION_TIMEOUT,
        "slide conversion",
    )
    generated = output_dir / f"{source.stem}.pdf"
    if not generated.is_file() or generated.stat().st_size == 0:
        raise FigureExtractionError("slide conversion did not produce a usable PDF")
    return generated


def _render_pages(
    pdf_path: Path, pages: list[int], destination: Path, resolution: int
) -> dict[int, Path]:
    """Render the given 1-based pages to PNG. Returns {page: written file}."""
    if not shutil.which("pdftoppm"):
        raise FigureExtractionError("pdftoppm (poppler-utils) is required to render figures")
    destination.mkdir(parents=True, exist_ok=True)
    written: dict[int, Path] = {}
    for page in pages:
        target = destination / f"page-{page:03d}"
        _run(
            [
                "pdftoppm",
                "-png",
                "-r",
                str(resolution),
                "-f",
                str(page),
                "-l",
                str(page),
                "-singlefile",
                str(pdf_path),
                str(target),
            ],
            RENDER_TIMEOUT,
            f"figure render for page {page}",
        )
        produced = target.with_suffix(".png")
        if produced.is_file() and produced.stat().st_size:
            written[page] = produced
    return written


def _safe_name(name: str) -> str:
    """A directory name that survives every filesystem this runs on."""
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name).strip(" .")
    return cleaned or "lecture"


def extract_figures(
    slide_source: Path | str,
    transcripts_dir: Path | str,
    lecture: str,
    *,
    resolution: int = DEFAULT_RESOLUTION,
    include_text_pages: bool = False,
) -> FigureSet:
    """Render a lecture's diagram pages into ``Transcripts/Figures/<lecture>/``.

    Only pages with almost no extractable text are rendered by default: a slide
    that is mostly prose is already in the transcript, and rendering all of them
    would bury the few that carry a diagram.
    """
    source = Path(slide_source).expanduser()
    if not source.is_file():
        raise FigureExtractionError(f"Slide source not found: {source}")
    if source.suffix.casefold() not in SLIDE_EXTENSIONS | {".pdf"}:
        raise FigureExtractionError(f"Not a slide source: {source.name}")

    output_dir = Path(transcripts_dir) / FIGURES_DIR_NAME / _safe_name(lecture)
    fingerprint = source_fingerprint(source)

    with tempfile.TemporaryDirectory(prefix="transcriber-figures-") as work_dir:
        pdf_path = slides_to_pdf(source, Path(work_dir))
        texts = page_texts(pdf_path)
        lengths = [sum(character.isalnum() for character in page) for page in texts]
        if not lengths:
            raise FigureExtractionError(f"No readable pages in {source.name}")
        images = pptx_page_image_counts(source) if source.suffix.casefold() in {".pptx", ".ppsx"} else page_image_counts(pdf_path, len(lengths))
        if len(images) != len(texts):
            raise FigureExtractionError("Slide image inventory does not match the rendered page count")
        wanted = selected_pages(texts, images, include_text_pages=include_text_pages)
        rendered = _render_pages(pdf_path, wanted, output_dir, resolution)
        try:
            readings = describe_figures(rendered, texts, output_dir)
        except DescriptionError as error:
            raise FigureExtractionError(str(error)) from error
        reference_texts = [text if text.strip() else (reading_reference(readings[page]) if page in readings else "")
                           for page, text in enumerate(texts, 1)]
        text_path = _write_slide_text(output_dir, source.name, reference_texts)

    if source_fingerprint(source) != fingerprint:
        raise FigureExtractionError("Slide source changed during extraction; retry with the current deck")

    figures = tuple(
        Figure(
            page=page,
            image_path=path,
            text_characters=lengths[page - 1],
            embedded_images=images[page - 1],
            reading=readings[page],
        )
        for page, path in sorted(rendered.items())
    )
    figure_set = FigureSet(
        lecture=lecture,
        source_name=source.name,
        output_dir=output_dir,
        figures=figures,
        total_pages=len(lengths),
        skipped_text_pages=len(lengths) - len(wanted),
        text_path=text_path,
        source_fingerprint=fingerprint,
        selection_inputs={**selection_options(resolution=resolution, include_text_pages=include_text_pages),
                          "page_texts": texts, "page_image_counts": images},
    )
    write_manifest(figure_set)
    retained = {figure.image_path.name for figure in figure_set.figures}
    for path in output_dir.iterdir():
        if path.is_file() and re.fullmatch(r"page-\d{3,}\.png", path.name) and path.name not in retained:
            path.unlink()
    return figure_set


def _write_slide_text(output_dir: Path, source_name: str, texts: list[str]) -> Path:
    """Save the deck's own words beside its pictures.

    The text is already in hand -- it is what decides which pages are diagrams
    -- and a writer needs it to say what the slide said. Dropping it meant the
    only way to read a deck was to run `pdftotext` from a shell, on a file the
    caller first had to convert itself if the deck was a .pptx. Both problems
    end here: one call, and the page numbers match the figure filenames.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / SLIDE_TEXT_NAME
    body = "".join(
        f"--- page {index} ---\n{page.strip()}\n\n" for index, page in enumerate(texts, 1)
    )
    path.write_text(f"# Slide text from {source_name}\n\n{body}", encoding="utf-8")
    return path


def write_manifest(figure_set: FigureSet) -> Path:
    """Record what was rendered, so a rerun and the Agent agree on the set."""
    figure_set.output_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "lecture": figure_set.lecture,
        "source": figure_set.source_name,
        "source_fingerprint": figure_set.source_fingerprint,
        "selection_inputs": figure_set.selection_inputs,
        "selection_fingerprint": selection_fingerprint(figure_set.selection_inputs) if figure_set.selection_inputs else None,
        "total_pages": figure_set.total_pages,
        "skipped_text_pages": figure_set.skipped_text_pages,
        "figures": [
            {
                "page": figure.page,
                "file": figure.image_path.name,
                "text_characters": figure.text_characters,
                "embedded_images": figure.embedded_images,
                "reading": figure.reading,
            }
            for figure in figure_set.figures
        ],
    }
    payload["figures_fingerprint"] = selection_fingerprint(payload["figures"])
    path = figure_set.manifest_path
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (figure_set.output_dir / SELECTION_VERSION_NAME).write_text(SELECTION_VERSION, encoding="utf-8")
    return path


def render_reference_markdown(figure_set: FigureSet) -> str:
    """The markdown the Agent pastes into the transcript, relative to it.

    Paths are relative to the Transcripts directory, which is where the
    transcript lives, so the links resolve in Obsidian and on GitHub alike.
    """
    if not figure_set.figures:
        return ""
    lines = [f"<!-- figures from {figure_set.source_name} -->"]
    for figure in figure_set.figures:
        relative = (
            Path(FIGURES_DIR_NAME) / _safe_name(figure_set.lecture) / figure.image_path.name
        )
        # Angle brackets because a lecture named "Corrosive 1" puts a space in
        # the path, and a bare markdown link stops at the space: Obsidian read
        # "./Figures/Corrosive" and offered to create it. Every path gets them,
        # so a lecture renamed to something with a space cannot break silently.
        lines.append(
            f"![{figure_set.lecture} — slide {figure.page}](<./{relative.as_posix()}>)"
        )
    return "\n".join(lines) + "\n"


def render_report(figure_set: FigureSet) -> str:
    """One-paragraph summary for the CLI."""
    text_line = (
        f"\n  slide text -> {figure_set.text_path}" if figure_set.text_path else ""
    )
    if not figure_set.figures:
        return (
            f"No diagram pages found in {figure_set.source_name} "
            f"({figure_set.total_pages} pages, none meet the diagram selection rules).{text_line}"
        )
    return (
        f"{len(figure_set.figures)} figure(s) from {figure_set.source_name} "
        f"-> {figure_set.output_dir}\n"
        f"  {figure_set.skipped_text_pages} of {figure_set.total_pages} pages skipped as text"
        f"{text_line}"
    )


__all__ = [
    "DEFAULT_RESOLUTION",
    "FIGURES_DIR_NAME",
    "Figure",
    "FigureExtractionError",
    "FigureSet",
    "TEXT_CHARACTER_FLOOR",
    "extract_figures",
    "page_image_counts",
    "page_text_lengths",
    "render_reference_markdown",
    "render_report",
    "slides_to_pdf",
    "write_manifest",
]
