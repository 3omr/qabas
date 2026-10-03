"""Locate validation findings in the retained staged write layout."""

from __future__ import annotations

import re
from pathlib import Path

from guide_register import worst_msa_passage
from phase_validation import SECTION_HEADINGS


def _finding_offsets(message: str, draft: str) -> list[int]:
    question = re.search(r"(MCQ|(?:Written )?Question|Clinical Case) (\d+)", message)
    if question:
        kind = question[1].removeprefix("Written ")
        match = re.search(rf"(?m)^### {kind} {question[2]}\b", draft)
        if match:
            return [match.start()]
        section_index = {"MCQ": 2, "Question": 3, "Clinical Case": 4}[kind]
        if SECTION_HEADINGS[section_index] in draft:
            return [draft.index(SECTION_HEADINGS[section_index])]
    marker = re.search(r"editorial marker: (\w+)", message)
    if marker:
        return [match.start() for match in re.finditer(re.escape(marker[1]), draft)]
    line = re.search(r"(?:callout|narration) at line (\d+)", message)
    if line:
        return [sum(len(text) for text in draft.splitlines(keepends=True)[:int(line[1]) - 1])]
    if "unexpected top-level sections" in message:
        return [match.start() for match in re.finditer(r"(?m)^## .+$", draft) if match[0] not in SECTION_HEADINGS]
    quoted_heading = next((heading for heading in SECTION_HEADINGS if heading in message), None)
    if quoted_heading and quoted_heading in draft:
        return [draft.index(quoted_heading)]
    return []


def _staged_ranges(transcript: Path | None, draft: str) -> list[tuple[int, int, int]]:
    if transcript is None:
        return []
    directory = transcript.parent.parent / ".transcriber-cache" / "staged-drafts" / transcript.name
    paths = sorted(directory.glob("part-*.md"), key=lambda path: int(path.stem.split("-")[1]))
    segments = [path.read_text(encoding="utf-8") for path in paths]
    # A stale layout must never instruct the writer to replace an unrelated part.
    if "".join(segments) != draft:
        return []
    ranges = []
    start = 0
    for path, segment in zip(paths, segments):
        end = start + len(segment)
        ranges.append((int(path.stem.split("-")[1]), start, end))
        start = end
    return ranges


def format_findings(errors: list[str], draft: str, transcript: Path | None = None) -> list[str]:
    ranges = _staged_ranges(transcript, draft)
    headings = [(index + 1, heading, draft.find(heading)) for index, heading in enumerate(SECTION_HEADINGS)]
    findings = []
    for message in errors:
        offsets = _finding_offsets(message, draft)
        locations = set()
        for offset in offsets:
            section = next(((number, heading) for number, heading, start in reversed(headings) if 0 <= start <= offset), None)
            label = f"Section {section[0]} ({section[1][3:]})" if section else "Document header"
            part = next((part for part, start, end in ranges if start <= offset < end), None)
            if part is not None:
                label += f", re-send part {part}"
            locations.add(label)
        if not locations:
            locations.add("Document-wide; inspect all sections/parts")
        findings.append(f"[{'; '.join(sorted(locations))}] {message}")
    return findings


def narration_warnings(draft: str, transcript: Path | None = None) -> list[str]:
    passage = worst_msa_passage(draft)
    if not passage:
        return []
    ranges = _staged_ranges(transcript, draft)
    groups = [[line for line in passage if start <= line.offset < end]
              for _, start, end in ranges] if ranges else [passage]
    worst = max((group for group in groups if group),
                key=lambda group: sum(line.msa - 2 * line.egyptian for line in group))
    anchor = max(worst, key=lambda line: line.msa - 2 * line.egyptian)
    egyptian, msa = sum(line.egyptian for line in passage), sum(line.msa for line in passage)
    message = ("narration is in Modern Standard Arabic; write it in Egyptian colloquial "
               f"(narration at line {anchor.line}; passage markers: MSA={msa}, Egyptian={egyptian})")
    return format_findings([message], draft, transcript)
