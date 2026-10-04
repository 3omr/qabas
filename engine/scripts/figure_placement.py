"""Insert validated slide links at existing guide paragraphs without rewriting prose."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from time import monotonic
from typing import Any

import agy_writer
import cancellation
from phase_validation import SECTION_HEADINGS
from web_figures import IMAGE_LINK

MAX_REQUESTS = 12
MAX_FIGURES_PER_REQUEST = 10
MAX_PARAGRAPH_BYTES = 12000
PLACEMENT_TIMEOUT_SECONDS = 180
SCHEMA = {'type': 'object', 'properties': {'placements': {'type': 'array', 'items': {
    'type': 'object', 'properties': {'page': {'type': 'integer'}, 'after_paragraph': {'type': 'integer'}},
    'required': ['page', 'after_paragraph'], 'additionalProperties': False}}},
    'required': ['placements'], 'additionalProperties': False}


class FigurePlacementError(RuntimeError):
    """A bounded model placement could not be validated; no prose is replaced."""


@dataclass(frozen=True)
class _Paragraph:
    end: int
    text: str


def _windows(text: str, separator: str) -> list[list[_Paragraph]]:
    heading = text.find(SECTION_HEADINGS[0])
    if heading < 0:
        return []
    start = heading + len(SECTION_HEADINGS[0])
    end = text.find(SECTION_HEADINGS[1], start)
    if end < 0:
        end = len(text)
    windows = []
    offset = 0
    for part in text.split(separator) if separator else [text]:
        part_start = offset
        offset += len(part) + len(separator)
        left, right = max(0, start - part_start), min(len(part), end - part_start)
        if right <= left:
            continue
        window: list[_Paragraph] = []
        size = 0
        for match in re.finditer(r'[^\n]+(?:\n(?![ \t]*\n)[^\n]+)*', part[left:right]):
            paragraph = match[0].strip()
            count = len(paragraph.encode('utf-8'))
            if paragraph.startswith(('#', '>', '!', '<!--')) or count > MAX_PARAGRAPH_BYTES:
                continue
            if window and size + count > MAX_PARAGRAPH_BYTES:
                windows.append(window)
                window, size = [], 0
            window.append(_Paragraph(part_start + left + match.end(), paragraph))
            size += count
        if window:
            windows.append(window)
    return windows


def _choices(response: dict[str, Any], figures: list[dict[str, Any]], paragraphs: list[_Paragraph]) -> list[tuple[int, int]]:
    placements = response.get('placements')
    if not isinstance(placements, list) or len(placements) > len(figures):
        raise FigurePlacementError('Invalid slide placement response')
    pages = {figure['page'] for figure in figures}
    seen = set()
    choices = []
    for entry in placements:
        if (not isinstance(entry, dict) or set(entry) != {'page', 'after_paragraph'}
                or type(entry['page']) is not int or entry['page'] not in pages or entry['page'] in seen
                or type(entry['after_paragraph']) is not int or not 1 <= entry['after_paragraph'] <= len(paragraphs)):
            raise FigurePlacementError('Unknown, duplicate or out-of-range slide placement')
        seen.add(entry['page'])
        choices.append((entry['page'], paragraphs[entry['after_paragraph'] - 1].end))
    return choices


def place_missing_figures(text: str, separator: str, figures: list[dict[str, Any]]) -> str:
    """Request at most twelve bounded guide-window plans; unresolved links remain findings."""
    linked = {match[1].strip('<>').removeprefix('./') for match in IMAGE_LINK.finditer(text)}
    remaining = {figure['page']: figure for figure in figures
                 if figure['markdown'].split('](<./', 1)[-1].removesuffix('>)') not in linked}
    if not remaining:
        return text
    deadline = monotonic() + PLACEMENT_TIMEOUT_SECONDS
    requests = 0
    insertions: dict[int, list[str]] = {}
    for paragraphs in _windows(text, separator):
        candidates = list(remaining.values())
        for first in range(0, len(candidates), MAX_FIGURES_PER_REQUEST):
            cancellation.check_cancelled()
            timeout = min(60, deadline - monotonic())
            if requests >= MAX_REQUESTS or timeout <= 0:
                return _insert(text, insertions)
            batch = candidates[first:first + MAX_FIGURES_PER_REQUEST]
            prompt = ('SLIDE FIGURE PLACEMENT: match selected slides to the existing spoken explanation below. '
                      'Return only page numbers and the paragraph after which each matching slide belongs. '
                      'Descriptions marked Machine-read are OCR/vision matching hints, never the doctor\'s words; '
                      'do not quote them or add narration. Never assign an unrelated image; omit uncertain matches. '
                      'Only Chronological Guide paragraphs are supplied; do not change their text or headings.\n'
                      + json.dumps({'figures': [{'page': figure['page'], 'slide_text': figure['slide_text'][:650]} for figure in batch],
                                    'paragraphs': [{'number': number, 'text': paragraph.text} for number, paragraph in enumerate(paragraphs, 1)]}, ensure_ascii=False))
            requests += 1
            with cancellation.deadline_scope(deadline - monotonic()):
                response = agy_writer.request_json(prompt, SCHEMA, timeout=max(1, int(timeout)))
            for page, offset in _choices(response, batch, paragraphs):
                insertions.setdefault(offset, []).append(remaining.pop(page)['markdown'])
        if not remaining:
            break
    return _insert(text, insertions)


def _insert(text: str, insertions: dict[int, list[str]]) -> str:
    for offset in sorted(insertions, reverse=True):
        text = text[:offset] + '\n\n' + '\n\n'.join(insertions[offset]) + '\n' + text[offset:]
    return text
