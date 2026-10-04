"""Insert validated slide links at existing guide paragraphs without rewriting prose."""
from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass
from math import log
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
    topic: str = ""


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
        topic = ""
        for match in re.finditer(r'[^\n]+(?:\n(?![ \t]*\n)[^\n]+)*', part[left:right]):
            paragraph = match[0].strip()
            count = len(paragraph.encode('utf-8'))
            if paragraph.startswith('#'):
                topic = paragraph
                continue
            if paragraph.startswith(('>', '!', '<!--')) or count > MAX_PARAGRAPH_BYTES:
                continue
            if window and size + count > MAX_PARAGRAPH_BYTES:
                windows.append(window)
                window, size = [], 0
            window.append(_Paragraph(part_start + left + match.end(), paragraph, topic))
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


_STOP_WORDS = frozenset({"the", "and", "for", "with", "from", "that", "this", "into", "which", "when", "where", "have", "has", "are", "was", "were", "can", "not", "only", "slide", "machine", "read", "placement", "reference", "doctor", "words", "شرح", "الدكتور", "يعني", "اللي", "عشان", "كده", "بيقول"})


def _terms(text: str) -> set[str]:
    text = re.sub(r"\[Machine-read[^\n]*\]", "", text, flags=re.I)
    return {word for word in re.findall(r"[^\W\d_]{3,}", text.casefold()) if word not in _STOP_WORDS}


def _ocr_choices(figures: list[dict[str, Any]], paragraphs: list[_Paragraph]) -> list[tuple[int, int]]:
    """Rank medical OCR terms across the whole guide, including each paragraph's topic."""
    terms = [_terms(paragraph.topic + " " + paragraph.text) for paragraph in paragraphs]
    frequency = Counter(word for words in terms for word in words)
    figure_frequency = Counter(word for figure in figures for word in _terms(figure["slide_text"]))
    common = {word for word, count in figure_frequency.items() if len(figures) >= 4 and count > len(figures) / 2}
    choices = []
    for figure in figures:
        wanted = _terms(figure["slide_text"]) - common
        ranked = []
        for number, words in enumerate(terms):
            shared = wanted & words
            if len(shared) < 2:
                continue
            score = sum(log(1 + len(paragraphs) / frequency[word]) for word in shared)
            # Topic titles alone cannot establish the doctor's discussion.
            spoken = wanted & _terms(paragraphs[number].text)
            if len(spoken) >= 2:
                ranked.append((score, -number))
        if ranked:
            _, negative = max(ranked)
            choices.append((figure["page"], paragraphs[-negative].end))
    return choices


def _unlinked(text: str, figures: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    linked = {match[1].strip('<>').removeprefix('./') for match in IMAGE_LINK.finditer(text)}
    return {figure['page']: figure for figure in figures
                 if figure['markdown'].split('](<./', 1)[-1].removesuffix('>)') not in linked}


def place_ocr_figures(text: str, separator: str, figures: list[dict[str, Any]]) -> str:
    """Place known OCR matches without a service call, including during final salvage."""
    remaining = _unlinked(text, figures)
    paragraphs = [paragraph for window in _windows(text, separator) for paragraph in window]
    insertions: dict[int, list[str]] = {}
    for page, offset in _ocr_choices(list(remaining.values()), paragraphs):
        insertions.setdefault(offset, []).append(remaining.pop(page)["markdown"])
    return _insert(text, insertions)


def place_missing_figures(text: str, separator: str, figures: list[dict[str, Any]]) -> str:
    """Match OCR across the guide, then request bounded plans only for unresolved slides."""
    text = place_ocr_figures(text, separator, figures)
    remaining = _unlinked(text, figures)
    if not remaining:
        return text
    deadline = monotonic() + PLACEMENT_TIMEOUT_SECONDS
    requests = 0
    insertions: dict[int, list[str]] = {}
    windows = _windows(text, separator)
    for paragraphs in windows:
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
            try:
                with cancellation.deadline_scope(deadline - monotonic()):
                    response = agy_writer.request_json(prompt, SCHEMA, timeout=max(1, int(timeout)))
                choices = _choices(response, batch, paragraphs)
            except (agy_writer.AgyWriterError, OSError, ValueError, FigurePlacementError) as error:
                from pipeline_errors import interruption

                if interruption(str(error)) or not insertions:
                    raise
                return _insert(text, insertions)
            for page, offset in choices:
                insertions.setdefault(offset, []).append(remaining.pop(page)['markdown'])
        if not remaining:
            break
    return _insert(text, insertions)


def _insert(text: str, insertions: dict[int, list[str]]) -> str:
    for offset in sorted(insertions, reverse=True):
        text = text[:offset] + '\n\n' + '\n\n'.join(insertions[offset]) + '\n' + text[offset:]
    return text
