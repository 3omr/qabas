"""Deterministic merged-guide scopes shared by writing, staging and recovery."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from itertools import accumulate
from math import ceil
from pathlib import Path
from typing import Any

from draft_segments import segment_boundaries, write_segments
from recording_grouping import recording_identity
from slide_figures import outline_pages


@dataclass(frozen=True)
class MergedPlan:
    segments: list[str]
    contexts: list[dict[str, Any]]
    layout: dict[str, Any]


def _label(source: str, text: str) -> str:
    cohort = recording_identity(Path(source.replace("\\", "/")).stem)[1]
    return f"# Recording: {source} (cohort: {cohort})\n\n{text}"


def _page_groups(pages: dict[int, str], count: int) -> list[list[int]]:
    numbers = sorted(pages)
    count = min(count, len(numbers))
    weights = list(accumulate(max(1, len(pages[number].split())) for number in numbers))
    cuts = [0]
    for part in range(1, count):
        target = weights[-1] * part / count
        cuts.append(min(range(cuts[-1] + 1, len(numbers) - (count - part) + 1),
                        key=lambda cut: abs(weights[cut - 1] - target)))
    cuts.append(len(numbers))
    return [numbers[start:end] for start, end in zip(cuts, cuts[1:])]


def merged_plan(sources: tuple[str, ...], texts: list[str], outline: str, budget: int) -> MergedPlan:
    words = sum(len(text.split()) for text in texts)
    full = "\n\n".join(_label(source, text) for source, text in zip(sources, texts))
    pages = outline_pages(outline) or ({1: outline} if outline.strip() else {})
    contexts: list[dict[str, Any]]
    if pages:
        groups = _page_groups(pages, max(2, ceil(words / 4000)))
        segments = [full] * len(groups)
        contexts = [{"merge_mode": "slides", "slide_range": [group[0], group[-1]]} for group in groups]
    elif words < 5000:
        segments, contexts = [full], [{"merge_mode": "whole"}]
    else:
        primary = max(range(len(texts)), key=lambda index: len(texts[index].split()))
        stretches = write_segments(texts[primary], budget)
        references = "\n\n".join(_label(source, text) for index, (source, text) in enumerate(zip(sources, texts)) if index != primary)
        segments = [_label(sources[primary], stretch) + "\n\nREFERENCE RECORDINGS (merge only this primary segment's topics):\n" + references for stretch in stretches]
        contexts = [{"merge_mode": "timeline", "primary_source": sources[primary], "primary_segment": boundary}
                    for boundary in segment_boundaries(stretches)]
    layout = {"version": 2, "alignment": "merged", "parts": len(segments) + 1, "segment_bytes": budget,
              "sources": [{"name": source, "sha256": hashlib.sha256(text.encode()).hexdigest()} for source, text in zip(sources, texts)],
              "outline_sha256": hashlib.sha256(outline.encode()).hexdigest(), "segments": contexts}
    return MergedPlan(segments, contexts, layout)
