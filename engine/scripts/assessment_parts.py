"""Plan bounded assessment requests and assemble Sections 2–5 deterministically.

The agy writer stages Section 2 IMP Points, Section 3 MCQs, Section 4 Written
Questions and Section 5 Clinical Cases as four parts after the guide. Each
section is written in one or more requests within ``emphasis_prompt_chars``;
whole ledger points and whole questions are packed into batches, so evidence
is never truncated to fit.
"""
from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from lecture_emphasis import GENERATED_CATEGORIES, bounded_prompt
from phase_validation import (
    SECTION_HEADINGS,
    patient_scenario_stem,
    renumber_question_section,
)
from question_prompts import IMP_EMPTY_NOTICES, IMP_HEADINGS, _emphasis_minimum

HEADINGS = SECTION_HEADINGS[1:]
# Index 0 is Section 2; the others name the find_questions kind each section receives.
KINDS = (None, "mcq", "written", "case")
PHASES = ("imp", "mcq", "written", "cases")
BLOCK_KINDS = (None, "MCQ", "Question", "Clinical Case")
FAILED = "ASSESSMENT_SECTION_FAILED"


class SectionFormatError(ValueError):
    """A writer response lacks a heading that section assembly requires."""


def eligible_points(points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return the points that generated IMP questions are written from."""
    return [point for point in points if point["category"] in GENERATED_CATEGORIES]


def assessment_kind(entry: dict[str, Any]) -> str:
    """Route a find_questions entry to mcq, written or case without changing index data."""
    kind = entry.get("kind")
    if kind == "mcq":
        return "mcq"
    if kind in ("case", "clinical_case") or patient_scenario_stem(entry["stem"]):
        return "case"
    return "written"


def section_errors(content: str, profile: dict[str, Any]) -> list[str]:
    """Run local format and editorial checks on one assessment section."""
    from phase_validation import (
        _case_field_errors,
        _mcq_field_errors,
        _written_field_errors,
        validate_editorial_quality,
    )
    from transcriber_models import QuestionEvidence

    evidence = QuestionEvidence({}, [], exam_style_profile=profile)
    return (validate_editorial_quality(content, profile) + _mcq_field_errors(content, evidence)
            + _written_field_errors(content, evidence) + _case_field_errors(content, 0))


def batches(items: list[Any], render: Callable[[list[Any]], str], budget: int) -> list[list[Any]]:
    """Greedily pack whole items in order; refuse only an item that alone exceeds the budget."""
    result: list[list[Any]] = []
    current: list[Any] = []
    for item in items:
        if current and len(render([*current, item])) > budget:
            result.append(current)
            current = []
        if not current:
            bounded_prompt(render([item]), budget)
        current.append(item)
    if current or not result:
        result.append(current)
    return result


def section_text(text: str, section: int) -> str:
    """Return one section's body from a writer response.

    A misspelled heading keeps its section icon and is accepted when it is the
    only heading with that icon; a response without any ``##`` heading is the body.
    """
    heading = HEADINGS[section]
    match = re.search(r"(?m)^" + re.escape(heading) + r"[ \t]*$", text)
    if match is None:
        icons = list(re.finditer(r"(?m)^## " + re.escape(heading.split()[1]) + r"[^\n]*$", text))
        if len(icons) == 1:
            match = icons[0]
        elif not re.search(r"(?m)^## ", text):
            return text.strip()
        else:
            raise SectionFormatError(f"missing {heading}")
    tail = text[match.end():]
    end = re.search(r"(?m)^## ", tail)
    return tail[:end.start() if end else len(tail)].strip()


def _imp_groups(body: str) -> list[str]:
    found = []
    for heading in IMP_HEADINGS:
        match = re.search(r"(?m)^" + re.escape(heading) + r"[ \t]*$", body)
        if match is None:
            raise SectionFormatError(f"missing {heading}")
        found.append(match)
    if [match.start() for match in found] != sorted(match.start() for match in found):
        raise SectionFormatError("IMP groups must follow this order: " + ", ".join(IMP_HEADINGS))
    ends = [match.start() for match in found[1:]] + [len(body)]
    return [body[match.end():end].strip() for match, end in zip(found, ends)]


def merge_section(section: int, bodies: list[str]) -> str:
    """Merge batch bodies in request order under one heading, renumbering questions."""
    if section == 0:
        groups: list[list[str]] = [[] for _ in IMP_HEADINGS]
        for body in bodies:
            for index, fragment in enumerate(_imp_groups(body)):
                if fragment and fragment not in IMP_EMPTY_NOTICES:
                    groups[index].append(fragment)
        merged = "\n".join(heading + "\n" + ("\n".join(groups[index]) or IMP_EMPTY_NOTICES[index])
                           for index, heading in enumerate(IMP_HEADINGS))
    else:
        merged = renumber_question_section("\n\n".join(body for body in bodies if body), str(BLOCK_KINDS[section]))
    return HEADINGS[section] + "\n" + merged + "\n\n"


def section_prompts(section: int, points: list[dict[str, Any]], entries: list[dict[str, Any]],
                    render: Callable[[list[dict[str, Any]], list[dict[str, Any]], int], str], budget: int) -> list[str]:
    """Plan Section 2 point batches, or sourced-question batches followed by generated-question batches.

    ``render(points, entries, count)`` builds one request asking for at least
    ``count`` generated IMP questions. Each of Sections 3–5 asks for
    ``_emphasis_minimum`` generated questions over the eligible points, split
    across that section's point batches; class questions and course
    instructions are covered by Section 2 only.
    """
    if section == 0:
        return [render(batch, [], 0) for batch in batches(points, lambda batch: render(batch, [], 0), budget)]
    prompts = []
    if entries:
        prompts += [render([], batch, 0) for batch in batches(entries, lambda batch: render([], batch, 0), budget)]
    eligible = eligible_points(points)
    if eligible:
        minimum = _emphasis_minimum(len(eligible))
        point_batches = batches(eligible, lambda batch: render(batch, [], minimum), budget)
        remaining = minimum
        for index, batch in enumerate(point_batches):
            count = max(1, -(-remaining // (len(point_batches) - index)))
            prompts.append(bounded_prompt(render(batch, [], count), budget))
            remaining = max(0, remaining - count)
    return prompts or [bounded_prompt(render([], [], 0), budget)]
