"""Word-safe verbatim stretches sized for one model's guide answer."""

from __future__ import annotations

import re
from bisect import bisect_right
from itertools import accumulate
from typing import Any

DEFAULT_WRITE_PART_BYTES = 18_000


def _preferred_end(boundaries: list[int], start: int, end: int) -> int | None:
    candidate = bisect_right(boundaries, end) - 1
    return boundaries[candidate] if candidate >= 0 and boundaries[candidate] > start else None


def write_segments(content: str, budget: int = DEFAULT_WRITE_PART_BYTES) -> list[str]:
    """Preserve text exactly; prefer paragraphs, then sentences, then words.

    The budget counts unescaped UTF-8 bytes. A word longer than the budget
    stays intact. Prefer natural boundaries in the final 30% of each segment
    so a short paragraph does not turn into an unnecessarily small answer.
    """
    if budget < 1:
        raise ValueError("The write segment budget must be positive.")
    tokens = re.findall(r"\S+\s*|\s+", content)
    sizes = [0, *accumulate(len(token.encode("utf-8")) for token in tokens)]
    paragraphs = [index for index, token in enumerate(tokens, 1) if re.search(r"\n\s*\n", token)]
    sentences = [index for index, token in enumerate(tokens, 1) if re.search(r"[.!?؟。][\"'”’)]*\s+$", token)]
    segments: list[str] = []
    start = 0
    while start < len(tokens):
        end = max(start + 1, bisect_right(sizes, sizes[start] + budget) - 1)
        if end < len(tokens):
            near_end = bisect_right(sizes, sizes[start] + int(budget * 0.7)) - 1
            end = (
                _preferred_end(paragraphs, near_end, end)
                or _preferred_end(sentences, near_end, end)
                or end
            )
        segments.append("".join(tokens[start:end]))
        start = end
    return segments or [content]


def segment_boundaries(segments: list[str]) -> list[dict[str, Any]]:
    """Inclusive word ordinals disambiguate repeated first/last-word anchors."""
    boundaries: list[dict[str, Any]] = []
    word_offset = 0
    for part, segment in enumerate(segments, 1):
        words = segment.split()
        boundaries.append({
            "part": part,
            "start_word": word_offset + 1,
            "end_word": word_offset + len(words),
            "first": " ".join(words[:6])[:80],
            "last": " ".join(words[-6:])[-80:],
        })
        word_offset += len(words)
    return boundaries
