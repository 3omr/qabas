"""Coalesce repeated assessment sections without discarding distinct questions."""

from __future__ import annotations

import re
from difflib import SequenceMatcher
from itertools import accumulate

from phase_validation import (
    SECTION_HEADINGS,
    _question_block_matches,
    renumber_question_section,
)


def normalize_question_sections(text: str) -> str:
    """Remove exact repeated assessment blocks; keep different answers and all guide bytes."""
    headings = SECTION_HEADINGS[1:]
    opening = re.search(r"(?m)^" + re.escape(headings[0]) + r"$", text)
    if opening is None:
        return text
    start = opening.start()
    matches = list(re.finditer(r"(?m)^## .+$", text[start:]))
    # Incomplete or unknown sections still require ordinary structural review.
    if {match.group() for match in matches} != set(headings):
        return text
    changed = len(matches) != len(headings)
    bodies: dict[str, list[str]] = {heading: [] for heading in headings}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text) - start
        body = text[start + match.end():start + end].strip()
        if body not in bodies[match.group()]:
            bodies[match.group()].append(body)
    sections = []
    for index, heading in enumerate(headings):
        body = "\n\n".join(bodies[heading])
        if index:
            kind = ("MCQ", "Question", "Clinical Case")[index - 1]
            seen = set()
            duplicates = []
            for block in _question_block_matches(body, kind):
                key = renumber_question_section(block.group().strip(), kind)
                if key in seen:
                    duplicates.append(block)
                seen.add(key)
            for block in reversed(duplicates):
                body = body[:block.start()] + body[block.end():]
                changed = True
            body = renumber_question_section(body, kind)
        sections.append(heading + "\n" + body.strip())
    normalized = text[:start] + "\n\n".join(sections) + "\n"
    return normalized if changed else text


def normalize_question_parts(parts: list[str]) -> list[str]:
    """Keep source-aligned guide parts and map repair-part edges through assessment edits."""
    text = "".join(parts)
    revised = normalize_question_sections(text)
    return remap_revised_parts(parts, revised)


def remap_revised_parts(parts: list[str], revised: str) -> list[str]:
    """Preserve guide boundaries while mapping assessment replacements, including split fields."""
    text = "".join(parts)
    if revised == text:
        return parts
    edges = [0, *accumulate(map(len, parts))]
    edits = SequenceMatcher(None, text, revised).get_opcodes()
    mapped = []
    for edge in edges:
        for tag, start, end, new_start, new_end in edits:
            if start <= edge <= end:
                mapped.append(new_start + edge - start if tag == "equal" else new_start if edge == start else new_end)
                break
    return [revised[start:end] for start, end in zip(mapped, mapped[1:])]
