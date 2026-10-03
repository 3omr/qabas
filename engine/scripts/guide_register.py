"""Conservative register evidence from chronological guide narration only."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from transcript_parser import GUIDE, H2, SECTION_MARKERS

EGYPTIAN_MARKERS = re.compile(
    r"(?<!\w)[وف]?(?:بيقول|بيوضح|عشان|علشان|مش|ده|دي|دا|اللي|إن|احنا|إحنا|"
    r"إيه|ليه|كده|كدة|دلوقتي|مفيش|هنشوف|بنشوف|يعني)(?!\w)"
)
MSA_MARKERS = re.compile(
    r"(?<!\w)[وف]?(?:(?:أوضح|أكد|أشار|موضحا|مؤكدا|مشيرا)(?!\w)|"
    r"(?:تناول|انتقل|بدأ|استعرض)\s+الدكتور\b|انتقل\s+إلى\b)"
)
QUOTES = re.compile(r'''"[^"]*"|“[^”]*”|«[^»]*»|‘[^’]*’|(?<!\w)'[^'\n]*'(?!\w)''')
NARRATIVE_WINDOW = 40
MIN_MSA_MARKERS = 8


@dataclass(frozen=True)
class NarrationLine:
    line: int
    offset: int
    egyptian: int
    msa: int


def narration_counts(draft: str) -> list[NarrationLine]:
    headings = list(H2.finditer(draft))
    guide = next((index for index, heading in enumerate(headings)
                  if any(marker in heading["title"].casefold()
                         for marker in SECTION_MARKERS[GUIDE])), None)
    if guide is None:
        return []
    start = headings[guide].end()
    end = headings[guide + 1].start() if guide + 1 < len(headings) else len(draft)
    # Preserve offsets and line numbers, including multiline verbatim quotations.
    unquoted = QUOTES.sub(lambda match: re.sub(r"[^\n]", " ", match[0]), draft[start:end])
    return _narrative_lines(unquoted, start, draft[:start].count("\n") + 1)


def _narrative_lines(guide: str, offset: int, line_number: int) -> list[NarrationLine]:
    counts = []
    fence = ""
    for line in guide.splitlines(keepends=True):
        stripped = line.lstrip()
        if stripped.startswith(("```", "~~~")):
            fence = "" if stripped.startswith(fence) and fence else stripped[:3]
        elif not fence and stripped.strip() and not stripped.startswith(("#", ">", "|", "---", "![")):
            normalized = "".join(char for char in unicodedata.normalize("NFKC", line)
                                 if not unicodedata.combining(char))
            counts.append(NarrationLine(line_number, offset,
                                        len(EGYPTIAN_MARKERS.findall(normalized)),
                                        len(MSA_MARKERS.findall(normalized))))
        offset += len(line)
        line_number += 1
    return counts


def worst_msa_passage(draft: str) -> list[NarrationLine]:
    """A local passage catches drift that later colloquial prose would conceal.

    Eight MSA markers and a 2:1 ratio separate the faulty agy opening from
    the other 18 finalized reference transcripts; evidence remains advisory.
    """
    counts = narration_counts(draft)
    worst: list[NarrationLine] = []
    worst_score = -1
    for start in range(len(counts)):
        passage = counts[start:start + NARRATIVE_WINDOW]
        egyptian, msa = sum(line.egyptian for line in passage), sum(line.msa for line in passage)
        if msa >= MIN_MSA_MARKERS and msa >= 2 * egyptian and msa - 2 * egyptian > worst_score:
            worst, worst_score = passage, msa - 2 * egyptian
    return worst
