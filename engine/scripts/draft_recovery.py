"""Recover staged boundaries without changing the saved lecture text."""

from __future__ import annotations

import hashlib
import re
from itertools import accumulate
from typing import Any


def draft_fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def saved_boundaries(parts: list[str], layout: dict[str, Any]) -> dict[str, Any]:
    return {
        "sha256": draft_fingerprint("".join(parts)),
        "layout": layout,
        "lengths": [len(part) for part in parts],
    }


def exact_saved_parts(text: str, layout: dict[str, Any], snapshot: Any) -> list[str] | None:
    if not isinstance(snapshot, dict):
        return None
    lengths = snapshot.get("lengths")
    if (
        snapshot.get("layout") != layout
        or snapshot.get("sha256") != draft_fingerprint(text)
        or not isinstance(lengths, list)
        or len(lengths) != layout["parts"]
        or any(type(length) is not int or length < 0 for length in lengths)
        or sum(lengths) != len(text)
    ):
        return None
    offsets = [0, *accumulate(lengths)]
    return [text[start:end] for start, end in zip(offsets, offsets[1:])]


def legacy_saved_parts(text: str, layout: dict[str, Any], headings: tuple[str, ...]) -> list[str] | None:
    segments = layout["segments"]
    guide_start, questions_start = text.find(headings[0]), text.find(headings[1])
    if not segments or layout["parts"] != len(segments) + 1 or not 0 <= guide_start < questions_start:
        return None
    body_start = guide_start + len(headings[0])
    guide = text[body_start:questions_start]
    paragraphs = [match.end() for match in re.finditer(r"\n\s*\n", guide)]
    boundaries = [0]
    for segment in segments[:-1]:
        target = len(guide) * segment["end_word"] / segments[-1]["end_word"]
        cut = min(paragraphs or [len(guide)], key=lambda offset: abs(offset - target))
        boundaries.append(body_start + cut)
    boundaries.extend((questions_start, len(text)))
    return [text[start:end] for start, end in zip(boundaries, boundaries[1:])]
