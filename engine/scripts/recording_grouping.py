"""Shared lecture identity and ordered recording grouping for desktop and launcher."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

# A trailing part marker: "Corrosives Part 2", "Corrosives (2)", "Corrosives 2",
# "Corrosives جزء 2".
#
# The (?<!\d) is load-bearing. Without it, \d{1,2} anchored at the end happily
# matches the LAST TWO digits of a longer number, so "Revision 2024" split into
# "Revision 20" part 24 -- and "Revision 2024" beside "Revision 2025" merged
# into one fake lecture titled "Revision 20". Requiring the digit run to be
# complete is what actually keeps a year from being read as a part number.
PART_SUFFIX = re.compile(
    r"[\s._\-–—]*[(\[]?\s*"
    r"(?:part|pt|ch|chapter|جزء|الجزء)?"
    r"\s*\.?\s*(?<!\d)(\d{1,2})\s*[)\]]?$",
    re.IGNORECASE,
)


def _part_split(stem: str) -> tuple[str, int | None]:
    """Split a recording stem into its lecture title and part number."""
    # Descriptions after an explicit part marker do not change lecture identity.
    stem = re.sub(
        r"((?:part|pt|ch|chapter|جزء|الجزء)\s*\.?\s*\d{1,2})(?:\s*[-–—:]\s*.+)$",
        r"\1", stem, flags=re.IGNORECASE,
    )
    match = PART_SUFFIX.search(stem)
    if not match:
        return stem, None
    base = stem[: match.start()].strip(" .-_–—")
    if not base:
        # The whole stem was a number. There is no title to group under.
        return stem, None
    return base, int(match.group(1))


COHORT_SUFFIX = re.compile(r"\s+(boys|girls|بنين|بنات)$", re.IGNORECASE)
COHORT_NAMES = {"boys": "boys", "بنين": "boys", "girls": "girls", "بنات": "girls"}
COHORT_ORDER = {"boys": 0, "girls": 1, "unknown": 2}


def recording_identity(stem: str) -> tuple[str, str, int | None]:
    base, part = _part_split(stem)
    match = COHORT_SUFFIX.search(base)
    if match is None:
        return base, "unknown", part
    return base[:match.start()].strip(), COHORT_NAMES[match.group(1).casefold()], part


def _group_recordings(paths: list[Path]) -> list[dict[str, Any]]:
    """Group trailing cohort/part markers; lone uncohorted parts keep their title."""
    groups: dict[str, list[tuple[str, int | None, Path]]] = {}
    for path in paths:
        base, cohort, part = recording_identity(path.stem)
        groups.setdefault(base.casefold(), []).append((cohort, part, path))

    units: list[dict[str, Any]] = []
    for members in groups.values():
        members.sort(key=lambda member: (
            COHORT_ORDER[member[0]], member[1] is None, member[1], member[2].name
        ))
        cohort, _, first = members[0]
        title = (
            recording_identity(first.stem)[0]
            if len(members) > 1 or cohort != "unknown" else first.stem
        )
        units.append({
            "title": title,
            "origin": "auto",
            "materials": [],
            "recording_sources": [path.name for _, _, path in members],
            "paths": [str(path) for _, _, path in members],
            "parts": len(members),
        })
    return units
