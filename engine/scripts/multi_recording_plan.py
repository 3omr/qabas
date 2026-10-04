"""Deterministic merged-guide scopes shared by writing, staging and recovery."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from itertools import accumulate
from math import ceil
from pathlib import Path
from typing import Any

from draft_segments import segment_boundaries, write_segments
from recording_grouping import recording_identity
from topic_map import topic_fingerprint


@dataclass(frozen=True)
class MergedPlan:
    segments: list[str]
    contexts: list[dict[str, Any]]
    layout: dict[str, Any]


def _label(source: str, text: str) -> str:
    cohort = recording_identity(Path(source.replace("\\", "/")).stem)[1]
    return f"# Recording: {source} (cohort: {cohort})\n\n{text}"


def _topic_groups(weights_by_topic: list[int], count: int) -> list[list[int]]:
    numbers = list(range(len(weights_by_topic)))
    count = min(count, len(numbers))
    weights = list(accumulate(max(1, weight) for weight in weights_by_topic))
    cuts = [0]
    for part in range(1, count):
        target = weights[-1] * part / count
        cuts.append(min(range(cuts[-1] + 1, len(numbers) - (count - part) + 1),
                        key=lambda cut: abs(weights[cut - 1] - target)))
    cuts.append(len(numbers))
    return [numbers[start:end] for start, end in zip(cuts, cuts[1:])]


def _topic_segment(topics: list[dict[str, Any]], recordings: dict[str, str]) -> str:
    blocks = []
    for topic in topics:
        blocks.append(f"## Assigned topic: {topic['title']} — {topic['gloss']}")
        for span in topic["spans"]:
            text = recordings[span["recording"]]
            start, end = span["start"], span["end"]
            before = " ".join(text[:start].split()[-60:])
            after = " ".join(text[end:].split()[:60])
            blocks.append(_label(span["recording"],
                f"NEIGHBOUR CONTEXT ONLY (do not narrate): {before}\n"
                f"ASSIGNED VERBATIM:\n{text[start:end]}\n"
                f"NEIGHBOUR CONTEXT ONLY (do not narrate): {after}"))
    return "\n\n".join(blocks)


def merged_plan(sources: tuple[str, ...], texts: list[str], outline: str, budget: int,
                topics: list[dict[str, Any]] | None = None) -> MergedPlan:
    """Partition spoken topics; absent a valid map, use recording segments even with slides."""
    words = sum(len(text.split()) for text in texts)
    full = "\n\n".join(_label(source, text) for source, text in zip(sources, texts))
    contexts: list[dict[str, Any]]
    if topics:
        recordings = dict(zip(sources, texts))
        volumes = [sum(len(recordings[span["recording"]][span["start"]:span["end"]].split())
                       for span in topic["spans"]) for topic in topics]
        groups = _topic_groups(volumes, max(2, ceil(words / 4000)) if words >= 5000 else 1)
        segments = [_topic_segment([topics[index] for index in group], recordings) for group in groups]
        names = [{key: topic[key] for key in ("title", "gloss", "slide_title") if key in topic} for topic in topics]
        contexts = [{"merge_mode": "topics", "topic_range": [group[0] + 1, group[-1] + 1],
                     "topics": names, "verbatim_words": sum(volumes[index] for index in group)} for group in groups]
    elif words < 5000:
        segments, contexts = [full], [{"merge_mode": "whole"}]
    else:
        primary = max(range(len(texts)), key=lambda index: len(texts[index].split()))
        stretches = write_segments(texts[primary], budget)
        references = "\n\n".join(_label(source, text) for index, (source, text) in enumerate(zip(sources, texts)) if index != primary)
        segments = [_label(sources[primary], stretch) + "\n\nREFERENCE RECORDINGS (merge only this primary segment's topics):\n" + references for stretch in stretches]
        contexts = [{"merge_mode": "timeline", "primary_source": sources[primary], "primary_segment": boundary}
                    for boundary in segment_boundaries(stretches)]
    layout = {"version": 3, "alignment": "merged", "parts": len(segments) + 1, "segment_bytes": budget,
              "fingerprint": topic_fingerprint(sources, texts, outline),
              "topics_sha256": hashlib.sha256(json.dumps(topics, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
              "sources": [{"name": source, "sha256": hashlib.sha256(text.encode()).hexdigest()} for source, text in zip(sources, texts)],
              "outline_sha256": hashlib.sha256(outline.encode()).hexdigest(), "segments": contexts}
    return MergedPlan(segments, contexts, layout)
