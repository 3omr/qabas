#!/usr/bin/env python3
"""The student-facing transcript contract and complete-document validator.

Per-phase validation decides whether one NotebookLM answer is usable. This
module decides whether the Agent's assembled document is safe to keep.
"""

from __future__ import annotations

import json
import re
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from phase_validation import (
    SECTION_HEADINGS,
    guide_topic_errors,
    model_answer_length_errors,
    question_placement_errors,
)

MIN_SUBSTANCE_RATIO = 0.25
REFERENCE_PATH = (
    Path(__file__).resolve().parent
    if getattr(sys, "frozen", False)
    else Path(__file__).resolve().parent.parent
) / "references" / "drafting-and-editorial.md"
RASTER_IMAGE_SUFFIXES = frozenset({".gif", ".jpeg", ".jpg", ".png", ".webp"})
QUESTION_HEADING_PATTERN = re.compile(
    r"^### (?P<kind>MCQ|Question|Clinical Case|Case) (?P<number>\d+)"
    r"(?:[ \t]+[^\r\n]*)?$",
    flags=re.MULTILINE,
)
LEVEL_TWO_HEADING_PATTERN = re.compile(r"^## .+$", flags=re.MULTILINE)
QUESTION_SECTION_KINDS = {2: "MCQ", 3: "Question", 4: "Clinical Case"}


@dataclass(frozen=True)
class DraftingHandoffContext:
    """Lecture details needed to render the Agent's drafting handoff."""

    lecture_title: str = "<lecture title>"
    emoji: str = "<emoji>"
    recording_sources: tuple[str, ...] = ()
    example_path: Path | None = None
    web_figures: bool = True


def _reference_text() -> str:
    try:
        return REFERENCE_PATH.read_text(encoding="utf-8").strip()
    except OSError as error:
        return (
            f"The repository reference could not be inlined ({error}). Follow "
            "the exact rules above and report this missing reference to the user."
        )


def _provenance_header(context: DraftingHandoffContext) -> str:
    recordings = context.recording_sources or ("<recording>.verbatim.md",)
    source_list = " · ".join(f"`{Path(source).name}`" for source in recordings)
    return "\n".join(
        (
            f"# {context.emoji} {context.lecture_title}",
            "",
            f"> **الملفات المعتمدة:** {source_list}",
            "> **مصدر الشرح:** التفريغ الحرفي للتسجيل — كل نقطة هنا مردودة لسطر قاله الدكتور فعلاً.",
            "> **ملاحظة:** السلايدات والكتب للسياق المختار فقط؛ أي إضافة غير مشروحة تُوسم بوضوح كمصدر.",
        )
    )


def _example_note(example_path: Path | None) -> str:
    if example_path is None:
        return (
            "No local Corrosives example was found at handoff time. If it exists, "
            "it is optional user data and may be absent or edited."
        )
    return (
        f"Good local example (optional user data; it may be absent or edited): "
        f"{example_path}"
    )


def build_drafting_contract(context: DraftingHandoffContext | None = None) -> str:
    """Inline the authoritative drafting rules in the tool result."""
    handoff = context or DraftingHandoffContext()
    from web_figures import placeholder_rules

    headings = "\n".join(SECTION_HEADINGS)
    return "\n\n".join(
        (
            "This file is recording source text, not a finished five-section transcript. "
            "Write the complete transcript yourself and obey every rule below. Do not call "
            "start_draft again to produce the sections: that route rewrites the lecture. "
            "Keep the .verbatim.md beside the finished transcript for line-by-line checking.",
            "The student's begin_lecture action authorizes completing this lecture automatically: "
            "apply_review(confirmed=true), validate_draft and verify_provenance, repair any affected "
            "parts and repeat both checks, then finalize(confirmed=true). Do not stop to ask again.",
            "Exact mandatory section headings, copied from phase_validation.SECTION_HEADINGS "
            "(do not rename, translate, or substitute emoji):\n" + headings,
            "Question discovery: call find_questions(module, lecture, terms=[optional key terms]) "
            "once instead of grep/read slices of exam-index.json. Use returned complete entries "
            "only within this lecture scope. Keep the examiner's stem wording, repairing only OCR "
            "joined words, misspellings, stray symbols, handwriting noise and mark allocations. "
            "Never change meaning, negation, facts or doses. Split inline options into Section 3 MCQs. "
            "Copy the exact badge. Copy every returned "
            "source_lines line literally inside the sourced question block, for example:\n"
            "**Source:** Questions/final_2023.txt\n"
            "Use exactly **Source:** (colon inside bold), followed by the path on the same line. "
            "For multiple papers use one **Source:** line per paper. These evidence-only lines "
            "are required in the draft and removed from the student transcript. A short topic such as Palpebral conjunctiva must stay verbatim, not become "
            "an expanded Write short notes question. Years are resolved through real source papers. "
            "If none are available, derive questions from the lecture with **[IMP]** and "
            "never invent past-exam years or badges.",
            "Question headings must be exactly:\n### MCQ N\n### Question N\n### Clinical Case N\n"
            "Use each form only inside its own section and number each section sequentially.",
            "Written and clinical-case Model Answers: English keywords, 1–5 words per bullet, "
            "never paragraphs. Lines over 10 words fail validation with the question heading. "
            "Put detailed reasoning exclusively in Egyptian-Arabic Clinical Explanation.",
            "No summarising rule: never summarize, compress, or omit any part of the doctor's "
            "lecture. Preserve the chronological progression, examples, clinical anecdotes, "
            "transitions, and emphasized points in natural Egyptian Arabic with English medical terms.",
            "Doctor-first guide: every narration sentence must come from THIS verbatim segment; "
            "never attribute unspoken points to the doctor. Slides are a map only: decode clear "
            "ASR medical terms, drugs, numbers or doses and optionally name spoken topics. "
            "Use ONE ### heading per doctor's topic: English title — Egyptian Arabic gloss, in the doctor's order. "
            "Slides never create headings or dictate order; no Learning objectives or divider headings. "
            "Merge later returns to a topic under its original heading. Do not narrate unspoken slide points. "
            "Under a discussed topic, at most ONE short important skipped-point callout: "
            "> **إضافة من الكتاب/السلايد — لم يشرحها الدكتور في التسجيل**. "
            "Other important unspoken slide/book items appear once at the end of the guide in ONE optional folded callout "
            "opened by > [!summary]- في السلايدات ومتشرحش, with every content line quoted. "
            "Include only ranked past-exam evidence and key numbers, classifications and definitions; omit when empty. "
            "No outside/textbook knowledge or length padding; skip unintelligible passages rather "
            "than inventing them. Keep spoken examples, stories, repetitions, exam tips, student "
            "questions and side remarks.",
            "Topic planning: write_parts_with_agy first organizes all verbatim into cached topics.json. "
            "A valid map uses topic ranges even for one recording; follow its returned parts count. "
            "Recording-segment fallback: read ALL read parts first. Part 1 supplies write_parts "
            "and write_segments independently of read paging. Each boundary has inclusive "
            "start_word/end_word ordinals (count whitespace-separated words in the complete "
            "verbatim, including its header) plus first/last word anchors. With N=write_parts, "
            "call stage_draft_part(part=k, parts=N+1) for guide segment k only. Put the provenance "
            "header and Section 1 heading in part 1; continue that guide in parts 2..N without "
            "repeating the heading. Part N+1 contains sections 2–5. Preserve separators when "
            "parts are joined. Do not write the whole guide in one call just because it was "
            "read in one call. Only staged drafts whose recorded layout matches the current "
            "write plan are resumed. Legacy or mismatching staged drafts are moved aside; "
            "follow the fresh write_parts and boundaries returned by the handoff. Multiple "
            "recordings retain the merged-guide rule below.",
            "Saved staged parts persist until finalize. If validate_draft or verify_provenance "
            "reports a problem after apply_review(from_parts=true), replace only the affected "
            "part with stage_draft_part using the same parts total, then apply_review(from_parts=true) "
            "again to rebuild from all retained parts. Missing parts of a matching saved draft "
            "are recovered automatically; existing parts are preserved. Follow total_parts and "
            "the saved draft's repair next call. Run both checks again before finalize.",
            "Multiple-recording merge rule: produce ONE Chronological Guide across write_parts "
            "staged parts, followed by sections 2–5 in part write_parts+1. Follow write_segments scopes: "
            "use the persisted spoken topic map and marked consecutive topic range, merging all cohorts' slices. "
            "If topic mapping fails, follow recording segments, never slide ranges. "
            "The size floor applies to the merged guide total, not each topic part. "
            "Merge repeated explanations without losing unique details; use (شرح البنين) / (شرح البنات) "
            "ONLY where cohorts differ. For unknown cohorts use recording names. "
            "Write conflicts between doctors, or between a doctor and the slides, side by side, "
            "and explicitly note that the exam follows the slides (الامتحان بيتبع السلايدات).",
            "Figures step: begin_lecture returns extracted figures and reuses previous extraction. "
            "If extraction failed, use extract_figures after resolving the reported error. "
            "Place only the reported images from `Transcripts/Figures/<lecture>/` "
            "at the point discussed in the Chronological Guide. Do not invent figures or links.",
            placeholder_rules() if handoff.web_figures else "External illustrations are disabled. Do not request external images.",
            "Start with this provenance-header shape (adapt the bracketed values, preserve the "
            "provenance fields):\n" + _provenance_header(handoff),
            _example_note(handoff.example_path),
            # Deliberately a pointer, not the file. Inlining the whole editorial
            # reference put ~14,700 characters into the result of every single
            # transcription, and a transcription is the one call a student makes
            # most. The rules above are the ones a draft is actually validated
            # against; the rest is guidance, and drafting_reference serves it to
            # a caller that wants it, once, when it wants it.
            "Everything above is checked when the draft is saved. For the full editorial "
            "reference -- section-by-section guidance, question formats, OCR handling and "
            "the figure rules -- call the drafting_reference tool once; it is not repeated "
            "here because it would be sent again on every transcription.",
        )
    )


def drafting_reference() -> str:
    """The full editorial reference, served on request rather than on every call."""
    return _reference_text()


def neutralize_guide_question_headings(text: str) -> str:
    """Keep spoken case and quiz topics from posing as assessment headings.

    Titles such as "Case 1 — Upper GI bleeding" read exactly like the
    assessment sections' question headings, which the validator only accepts
    in Sections 3-5. Inside the Chronological Guide such a heading becomes
    "### Slide Case 1 ...", preserving the existing guide naming convention.
    """
    blocks = _section_blocks(text)
    if not blocks or blocks[0][0] != SECTION_HEADINGS[0]:
        return text
    _heading, start, end = blocks[0]
    guide = QUESTION_HEADING_PATTERN.sub(
        lambda match: f"### Slide {match.group('kind')} {match.group('number')}"
        + match.group(0)[len(f"### {match.group('kind')} {match.group('number')}"):],
        text[start:end],
    )
    return text[:start] + guide + text[end:]


def _section_blocks(text: str) -> list[tuple[str, int, int]]:
    matches = list(LEVEL_TWO_HEADING_PATTERN.finditer(text))
    return [
        (
            match.group(0),
            match.start(),
            matches[index + 1].start() if index + 1 < len(matches) else len(text),
        )
        for index, match in enumerate(matches)
    ]


def _heading_errors(text: str) -> list[str]:
    found = [match.group(0) for match in LEVEL_TWO_HEADING_PATTERN.finditer(text)]
    errors = [
        (
            f"section heading {index + 1}: expected {expected!r}, found "
            f"{found[index] if index < len(found) else '<missing>'!r}"
        )
        for index, expected in enumerate(SECTION_HEADINGS)
        if index >= len(found) or found[index] != expected
    ]
    errors.extend(
        f"unexpected section heading found after the five mandatory sections: {heading!r}"
        for heading in found[len(SECTION_HEADINGS) :]
    )
    return errors


def _section_index(blocks: list[tuple[str, int, int]], position: int) -> int | None:
    for index, (_heading, start, end) in enumerate(blocks):
        if start <= position < end:
            return index
    return None


def _question_heading_errors(text: str) -> list[str]:
    blocks = _section_blocks(text)
    errors: list[str] = []
    headings_by_section: dict[int, list[tuple[str, int]]] = {}
    for match in QUESTION_HEADING_PATTERN.finditer(text):
        section_index = _section_index(blocks, match.start())
        heading = match.group(0)
        kind = match.group("kind")
        if section_index not in QUESTION_SECTION_KINDS:
            section_name = blocks[section_index][0] if section_index is not None else "<none>"
            errors.append(
                f"question heading {heading!r} is outside an assessment section "
                f"under {section_name!r}"
            )
            continue
        expected_kind = QUESTION_SECTION_KINDS[section_index]
        headings_by_section.setdefault(section_index, []).append(
            (kind, int(match.group("number")))
        )
        if kind != expected_kind:
            errors.append(
                f"question heading in {blocks[section_index][0]!r}: expected "
                f"'### {expected_kind} N', found {heading!r}"
            )
    for section_index, expected_kind in QUESTION_SECTION_KINDS.items():
        numbers = [
            number
            for kind, number in headings_by_section.get(section_index, [])
            if kind == expected_kind
        ]
        if numbers and numbers != list(range(1, len(numbers) + 1)):
            errors.append(
                f"{expected_kind} headings must be numbered sequentially from 1; "
                f"found {numbers!r}"
            )
    return errors


def _substance_errors(text: str, verbatim_sources: Iterable[Path]) -> list[str]:
    source_paths = tuple(verbatim_sources)
    if not source_paths:
        return []
    source_bytes = 0
    errors: list[str] = []
    for source_path in source_paths:
        try:
            source_bytes = max(source_bytes, len(source_path.read_bytes()))
        except OSError as error:
            errors.append(f"could not read verbatim source {source_path}: {error}")
    if errors or source_bytes == 0:
        return errors
    transcript_bytes = len(text.encode("utf-8"))
    ratio = transcript_bytes / source_bytes
    if ratio < MIN_SUBSTANCE_RATIO:
        errors.append(
            f"substance ratio is {ratio:.1%} ({transcript_bytes:,}/{source_bytes:,} UTF-8 bytes); "
            f"expected at least {MIN_SUBSTANCE_RATIO:.1%} of the verbatim source"
        )
    return errors


def current_slide_figures(directory: Path, slides_path: Path | None) -> tuple[Path, ...] | None:
    """Return manifest-listed rasters, including missing files; None requires extraction.

    Deck bytes and recorded selection inputs must agree with the manifest.
    An empty tuple is a successful text-only extraction. Loose files and manifests
    for a different deck do not contribute. Unsafe or malformed entries invalidate
    the extraction manifest.
    """
    try:
        from slide_figures import current_manifest

        payload = current_manifest(directory, slides_path) if slides_path else json.loads((directory / "figures.json").read_text(encoding="utf-8"))
        if payload is None:
            return None
        entries = payload["figures"]
        if not isinstance(entries, list):
            return None
        paths = []
        for entry in entries:
            name = entry["file"]
            if (not isinstance(name, str) or Path(name).name != name
                    or Path(name).suffix.casefold() not in RASTER_IMAGE_SUFFIXES):
                return None
            path = directory / name
            if not path.resolve().is_relative_to(directory.resolve()):
                return None
            paths.append(path)
        return tuple(paths)
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None


def _figure_errors(
    text: str, slides_path: Path | None, figure_directories: Iterable[Path]
) -> list[str]:
    from web_figures import IMAGE_LINK, figure_reference_errors

    # The last candidate is the current title; earlier recording names are stale.
    directories = tuple(figure_directories)[-1:]
    errors = figure_reference_errors(text, directories)
    if slides_path is None or not slides_path.is_file():
        return errors
    directory = directories[0] if directories else None
    figures = current_slide_figures(directory, slides_path) if directory else None
    if figures is None:
        return [*errors, f"figures: deck {slides_path} needs extraction into {directory}; no current figures.json"]
    links = {match[1].strip("<>").removeprefix("./") for match in IMAGE_LINK.finditer(text)}
    for image in figures:
        if not image.is_file():
            errors.append(f"figures: manifest-listed raster is missing: {image}; run extract_figures")
        link = f"Figures/{image.parent.name}/{image.name}"
        if link not in links:
            errors.append(f"figures: missing slide link ![slide](<./{link}>) in Chronological Guide")
    return errors


def validate_complete_transcript(
    text: str,
    *,
    verbatim_sources: Iterable[Path] = (),
    slides_path: Path | None = None,
    figure_directories: Iterable[Path] = (),
) -> list[str]:
    """Return every complete-transcript finding without changing the text."""
    errors = _heading_errors(text)
    errors.extend(_question_heading_errors(text))
    errors.extend(model_answer_length_errors(text))
    errors.extend(question_placement_errors(text))
    errors.extend(_figure_errors(text, slides_path, figure_directories))
    guide = next((text[start:end] for heading, start, end in _section_blocks(text) if heading == SECTION_HEADINGS[0]), "")
    errors.extend(guide_topic_errors(guide))
    for heading, start, end in _section_blocks(text):
        if heading != SECTION_HEADINGS[0] and re.search(r"^> \[!summary\]", text[start:end], re.MULTILINE | re.I):
            errors.append("folded unspoken summary belongs only at the end of the Chronological Guide")
    errors.extend(_substance_errors(text, verbatim_sources))
    return errors


__all__ = [
    "DraftingHandoffContext",
    "MIN_SUBSTANCE_RATIO",
    "REFERENCE_PATH",
    "SECTION_HEADINGS",
    "build_drafting_contract",
    "drafting_reference",
    "validate_complete_transcript",
]
