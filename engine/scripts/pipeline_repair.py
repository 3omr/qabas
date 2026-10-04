"""Conservative lecture repairs using the engine's staging and validation internals."""

from __future__ import annotations

import json
import re
from dataclasses import replace
from pathlib import Path
from time import monotonic
from typing import Any

import cancellation
from atomic_io import _atomic_write_json
from draft_segments import write_segments
from phase_validation import (
    BADGE_LIKE_PATTERN,
    SECTION_HEADINGS,
    _catalog_matches,
    _normalize_case_block,
    _section_blocks,
    _source_fields,
    renumber_question_section,
    retained_question_fingerprint,
    validate_editorial_quality,
)
from question_provenance import (
    assessment_catalog,
    assessment_verified_years,
    evidenced_question,
    final_provenance_errors,
    local_assessment_catalog,
    record_provenance_repairs,
    repair_provenance_badges,
    retained_question_receipts,
)
from question_sections import normalize_question_sections
from transcript_parser import field_value, split_blocks


def affected_parts(detail: str) -> list[int]:
    """Use exact finding locations or the writer's failed/missing part report."""
    parts = {int(number) for number in re.findall(r"(?:re-send part |(?m:^part ))(\d+)", detail)}
    for group in re.findall(r"inspect placement in parts ([\d, ]+)", detail):
        parts.update(int(number) for number in re.findall(r"\d+", group))
    try:
        report = json.loads(detail)
    except ValueError:
        report = {}
    if isinstance(report, dict):
        parts.update(report.get("missing_parts", []))
        if report.get("failed_part"):
            parts.add(report["failed_part"])
    return sorted(parts)


def omit_support(context: Any, name: str, reason: str) -> None:
    """Persist a lecture-local omission; never change workspace preferences or source files."""
    payload = json.loads(context.manifest_path.read_text(encoding="utf-8"))
    omissions = payload.setdefault("pipeline_omissions", {})
    omissions[name] = reason
    _atomic_write_json(context.manifest_path, payload)


def split_write(request: dict[str, Any], workspace: Path, parts: list[int], detail: str) -> None:
    """Write smaller source slices, then stage one replacement in the unchanged layout."""
    import mcp_server as tools

    job = tools._agy_draft_context(request, workspace)
    total = len(job.segments) + 1
    for part in parts:
        cancellation.check_cancelled()
        if part == total:
            tools._agy_stage_part(job, part)
            continue
        source = job.segments[part - 1]
        chunks = write_segments(source, max(256, min(4000, len(source.encode("utf-8")) // 2)))
        written = []
        seen_headings: set[str] = set()
        for index, chunk in enumerate(chunks):
            cancellation.check_cancelled()
            segments = list(job.segments)
            segments[part - 1] = chunk
            prompt = tools._agy_part_prompt(replace(job, segments=segments), part)
            prompt += f"\nWrite only subsegment {index + 1}/{len(chunks)} of this part. Preserve all its spoken content.\n{detail[:8000]}"
            answer = tools._agy_write_checked(prompt, chunk, part, request)["content"]
            if index:
                answer = answer.replace(SECTION_HEADINGS[0], "")
            lines = []
            for line in answer.splitlines():
                if line.startswith("### "):
                    if line in seen_headings:
                        continue
                    seen_headings.add(line)
                lines.append(line)
            written.append("\n".join(lines))
            reporter = request.get("_report_progress")
            if reporter:
                reporter(index + 1, len(chunks), f"part {part} subsegment {index + 1} of {len(chunks)}")
        tools._stage_draft_part({**request, "part": part, "parts": total, "content": "\n\n".join(written)}, workspace)


def recording_fallback(request: dict[str, Any], workspace: Path) -> None:
    """Retain existing stages as repair text before dropping a broken cached topic proposal."""
    import mcp_server as tools

    context = tools._resolve_draft_context(request, workspace)
    directory = tools._staged_draft_directory(context)
    numbers = tools._staged_part_numbers(directory)
    if numbers:
        text = "".join(tools._read_review_draft(tools._staged_part_path(context, number)) for number in numbers)
        tools._seed_repair_parts(context, text)
    elif directory.exists():
        tools._archive_staged_draft(context)


def _scaffold(guide: str, bodies: list[str]) -> str:
    return SECTION_HEADINGS[0] + "\n" + guide.strip() + "\n\n" + "\n\n".join(
        heading + "\n" + body.strip() for heading, body in zip(SECTION_HEADINGS[1:], bodies)
    ) + "\n"


def _rewrite_question(request: dict[str, Any], block: str, kind: str, errors: list[str]) -> str:
    """Attempt one bounded agy replacement of one assessment, never the lecture guide."""
    import agy_writer
    import mcp_server as tools
    from pipeline_errors import interruption

    prompt = (agy_writer.NO_TOOLS + "\nRepair ONLY this question block. Return one ### " + kind
              + " block, no section headings or surrounding prose. Fix the findings below. "
              "Preserve sourced question/scenario wording, sub-questions, options, badge and Source fields; "
              "change only the invalid answer, explanation or formatting. Never append another question.\n"
              + "\n".join(errors)[:4000] + "\n\nQUESTION TO REPAIR:\n"
              + block.encode("utf-8")[:tools.MAX_INLINE_REVIEW_BYTES].decode("utf-8", errors="ignore"))
    remaining = request.get("_salvage_rewrite_until", monotonic() + agy_writer.DEFAULT_TIMEOUT_SECONDS) - monotonic()
    if remaining <= 0:
        return block
    try:
        with cancellation.deadline_scope(remaining):
            answer = tools._agy_write_checked(prompt, "", 1, request)["content"].strip()
            cancellation.check_cancelled()
    except (agy_writer.AgyWriterError, tools.ToolError, cancellation.OperationDeadlineExceeded) as error:
        if interruption(str(error)):
            raise
        return block
    blocks = split_blocks(answer)
    headings = re.findall(r"(?m)^(?:[ \t]*>[ \t]*)?(?:### |\*\*🩺 Clinical Case \d+:?\*\*)", answer)
    if len(blocks) != 1 or len(headings) != 1 or not re.match(r"^### " + re.escape(kind) + r" \d+\b", answer) or re.search(r"(?m)^## ", answer):
        return block
    # Writers may return 1 for an isolated question; reporting uses its original number.
    heading = block.splitlines()[0].split("**", 1)[0].strip()
    return re.sub(r"^### " + re.escape(kind) + r" \d+", heading, answer, count=1)


def _question_wording(block: str, kind: str) -> tuple[str, ...]:
    fields = ("Scenario", "Questions") if kind == "Clinical Case" else ("Question", "Options") if kind == "MCQ" else ("Question",)
    values = []
    for field in fields:
        value = field_value(block, field)
        if field == "Questions":
            value = re.sub(r"(?m)^\s*(?:>\s*)?\d+[.)]\s+", "", value)
        values.append(re.sub(r"\s+", " ", value).strip())
    return tuple(values)


def _source_excerpt(block: str, kind: str) -> str:
    """Keep source wording/options/subquestions without asserting an invalid generated answer."""
    fields = ("Scenario", "Questions") if kind == "Clinical Case" else ("Question", "Options") if kind == "MCQ" else ("Question",)
    heading = re.sub(r"^### ", "", block.splitlines()[0])
    lines = ["> [!note]- Retained source assessment: " + heading]
    for name in fields:
        wording = field_value(block, name) or field_value(block, name + " (verbatim)")
        if wording:
            lines.extend("> " + line for line in wording.splitlines())
    lines.extend("> **Source:** " + source for source in _source_fields(block))
    if "<!-- qabas-retained-question -->" in block:
        lines.append("> Provenance is unconfirmed; the original question is retained as practice.")
    lines.append("> Answer omitted because it could not be validated.")
    return "\n".join(lines)


def _retained_slide_references(guide: str, figures: list[dict[str, Any]]) -> tuple[str, list[str]]:
    """Keep content-slide links during salvage without spending another model call."""
    from figure_placement import place_ocr_figures

    guide = place_ocr_figures(SECTION_HEADINGS[0] + "\n\n" + guide, "", figures).split(SECTION_HEADINGS[0], 1)[1]
    missing = [figure["markdown"] for figure in figures if figure["markdown"] not in guide]
    notes = []
    if missing:
        guide += "\n\n> [!note]- Slide references without a confirmed paragraph match\n" + "\n".join("> " + link for link in missing) + "\n"
        notes.append(f"{len(missing)} unmatched slide reference(s) retained at the end of the guide.")
    return guide, notes


def salvage(request: dict[str, Any], workspace: Path) -> list[str]:
    """Repair sourced questions; prune only unevidenced items after one rewrite attempt.

    Unrepairable paper-backed assessments retain their wording and options as
    source excerpts without an unvalidated answer. Every saved candidate passes ordinary complete-transcript, editorial
    and provenance checks. Complete verbatim text replaces an invalid guide.
    """
    import mcp_server as tools
    import universal_transcribe as engine
    from transcript_contract import _figure_errors
    from web_figures import IMAGE_LINK, remove_placeholders

    context = tools._resolve_draft_context(request, workspace)
    directory = tools._staged_draft_directory(context)
    numbers = tools._staged_part_numbers(directory)
    text = ("".join(tools._read_review_draft(tools._staged_part_path(context, number)) for number in numbers)
            if numbers else tools._read_review_draft(context.path) if context.path.is_file() else "")
    manifest = json.loads(context.manifest_path.read_text(encoding="utf-8"))
    catalog = assessment_catalog(context.module_root, manifest)
    local_catalog = local_assessment_catalog(context.module_root)
    known_paths = {entry["local_path"] for entry in catalog}
    extra_sources = [entry for entry in local_catalog if entry["local_path"] not in known_paths]
    catalog += extra_sources
    text = normalize_question_sections(text)
    corrections: list[dict[str, Any]] = []
    retained_questions = retained_question_receipts(context.path)
    years = assessment_verified_years(catalog)
    profile = manifest.get("exam_style_profile", {})
    notes = []
    figures = tools._cached_figures(context)
    from web_figures import figure_reference_errors

    removed_links = []

    def retained_image(match: re.Match[str]) -> str:
        if figure_reference_errors(match[0], context.figure_directories):
            removed_links.append(match[1])
            return ""
        return match[0]

    text = IMAGE_LINK.sub(retained_image, text)
    if removed_links:
        notes.append("Optional figures that could not be validated were left out: " + "; ".join(removed_links) + ".")
    if figures is None and _figure_errors(text, context.slides_path, context.figure_directories):
        omit_support(context, "figures", "Slide extraction could not be validated")
        context = tools._resolve_draft_context(request, workspace)
        text = IMAGE_LINK.sub("", text)
        notes.append("Slide pictures that could not be validated were left out.")
    if "qabas-web-figure" in text:
        omit_support(context, "web_figures", "Unresolved optional illustration requests")
        notes.append("Unresolved optional illustrations were left out.")
    text = remove_placeholders(text)
    guide = tools._section_body(text, SECTION_HEADINGS[0])
    if figures is not None:
        guide, figure_notes = _retained_slide_references(guide, figures["figures"])
        notes.extend(figure_notes)
    candidate = _scaffold(guide, ["", "", "", ""])
    baseline = tools._read_verbatim_baseline(context.verbatim_sources)
    guide_errors = tools._complete_review_errors(None, candidate, context, baseline)
    guide_errors += engine.pre_finalize_errors(candidate, years, profile, catalog, retained_questions=retained_questions)
    if guide_errors:
        paths = tools._complete_verbatim_paths(context)
        bodies = [tools._verbatim_body(tools._read_review_draft(path))[0] for path in paths]
        # Source headers are bookkeeping, not spoken explanation. Keep speech bytes
        # while demoting structural headings that would create extra final sections.
        guide = "\n\n".join(re.sub(r"(?m)^#{1,6} (.+)$", r"**\1**", body) for body in bodies)
        guide = re.sub(r"(?m)^> Raw auto-detected speech.*$", "", guide)
        if figures is not None:
            guide, figure_notes = _retained_slide_references(guide, figures["figures"])
            notes.extend(figure_notes)
        notes.append("The doctor's full recorded text was retained; an explanation that could not be validated was left out.")
    bodies = [tools._section_body(text, heading) for heading in SECTION_HEADINGS[1:]]
    kept: list[str] = [bodies[0]]
    excerpts: list[str] = []
    removed: list[str] = []
    for offset, body in enumerate(bodies[1:], 1):
        kind = ("MCQ", "Question", "Clinical Case")[offset - 1]

        def question_errors(block: str, offset: int = offset, kind: str = kind) -> list[str]:
            check_bodies = ["", "", "", ""]
            # Complete-document numbering is checked on the full retained draft.
            check_bodies[offset] = renumber_question_section(block, kind)
            check_text = _scaffold(guide, check_bodies)
            return (validate_editorial_quality(check_text, profile, retained_questions=retained_questions) + final_provenance_errors(check_text, catalog)
                    + tools._complete_review_errors(None, check_text, context, baseline))

        counter = 0

        def assessment_heading(match: re.Match[str], kind: str = kind) -> str:
            nonlocal counter
            counter += 1
            tail = re.sub(r"^\s*(?:\*\*)?\d*(?:\*\*)?\s*", "", match[1])
            return f"### {kind} {counter} " + tail

        body = re.sub(r"(?m)^### (?:MCQ|Question|Clinical Case)\b([^\n]*)", assessment_heading, body)
        blocks = _section_blocks(body, kind)
        remainder = body
        for block in blocks:
            remainder = remainder.replace(block, "", 1)
        if (BADGE_LIKE_PATTERN.search(remainder) or _source_fields(remainder)
                or re.search(r"(?m)^(?:>\s*)?(?:### |\*\*(?:Question|Scenario)(?: \(verbatim\))?:\*\*)", remainder)):
            source = evidenced_question(f"### {kind} {len(blocks) + 1}\n" + remainder, kind, catalog)
            if source is not None:
                excerpts.append(_source_excerpt(source, kind))
                notes.append(f"Unparsed {kind} assessment retained as a source excerpt.")
            else:
                removed.append(f"Unparsed {kind} assessment")
        valid = []
        for block in blocks:
            cancellation.check_cancelled()
            block = _normalize_case_block(block) if kind == "Clinical Case" else re.sub(r"(?m)^>[ \t]?", "", block)
            label = block.splitlines()[0].removeprefix("### ")
            sourced = evidenced_question(block, kind, catalog)
            block = sourced or block
            block, badge_repairs = repair_provenance_badges(block, catalog)
            corrections.extend(badge_repairs)
            retained_questions.update(repair["retained_fingerprint"] for repair in badge_repairs if "retained_fingerprint" in repair)
            retained = sourced or (block if retained_question_fingerprint(block, kind) in retained_questions else None)
            errors = question_errors(block)
            if errors:
                revised = _rewrite_question(request, block, kind, errors)
                if retained and _question_wording(revised, kind) != _question_wording(retained, kind):
                    revised = block
                if sourced:
                    # The evidence established before rewriting remains authoritative.
                    revised = evidenced_question(revised, kind, catalog) or block
                errors = question_errors(revised)
                if errors and retained:
                    excerpts.append(_source_excerpt(retained, kind))
                    notes.append(f"Retained {label} as a source excerpt; its answer or assessment formatting could not be validated.")
                    continue
                if errors:
                    removed.append(label)
                    continue
                block = revised
            valid.append(block)
        kept.append(renumber_question_section("\n\n".join(valid), kind))
    kept[0] += "\n\n" + "\n\n".join(excerpts)
    candidate = _scaffold(guide, kept)
    errors = tools._complete_review_errors(None, candidate, context, baseline)
    errors += engine.pre_finalize_errors(candidate, years, profile, catalog, retained_questions=retained_questions)
    if errors:
        # Unvalidated tips are optional; the complete doctor text is not.
        kept[0] = "\n\n".join(excerpts)
        candidate = _scaffold(guide, kept)
        notes.append("Supporting tips that could not be validated were left out.")
        errors = tools._complete_review_errors(None, candidate, context, baseline)
        errors += engine.pre_finalize_errors(candidate, years, profile, catalog, retained_questions=retained_questions)
    if errors:
        raise tools.ToolError("Salvage validation: " + "; ".join(errors))
    if removed:
        notes.append(f"{len(removed)} question(s) that could not be validated were left out.")
        notes.append("Left-out questions: " + "; ".join(removed) + ".")
    used_paths = {entry["local_path"] for field in _source_fields(candidate) for entry in _catalog_matches(field, catalog)}
    additions = [entry for entry in extra_sources if entry["local_path"] in used_paths]
    if additions:
        # Finalize and both CLI checks must read the same located paper evidence.
        manifest = json.loads(context.manifest_path.read_text(encoding="utf-8"))
        manifest.setdefault("assessment_sources", []).extend(
            {"path": str(Path(entry["local_path"]).relative_to(context.module_root)),
             "type": entry["role"], "years": entry["verified_years"]} for entry in additions)
        _atomic_write_json(context.manifest_path, manifest)
    record_provenance_repairs(context.path, corrections)
    parts = tools._seed_repair_parts(context, candidate)
    tools._save_review(context, candidate, parts)
    warning = tools._record_review(context, None)
    if warning:
        notes.append(warning)
    _atomic_write_json(context.module_root / ".transcriber-cache" / "pipeline-notes" / (context.path.name + ".json"), notes)
    return notes


def self_repair(request: dict[str, Any], workspace: Path) -> bool:
    """Normalize known heading mistakes without rewriting or dropping doctor passages."""
    import mcp_server as tools
    from transcript_contract import neutralize_guide_question_headings

    context = tools._resolve_draft_context(request, workspace)
    total = tools._staged_total(tools._staged_draft_directory(context))
    if total is None:
        return False
    changed = False
    for part in tools._staged_part_numbers(tools._staged_draft_directory(context)):
        cancellation.check_cancelled()
        path = tools._staged_part_path(context, part)
        text = tools._read_review_draft(path)
        revised = neutralize_guide_question_headings(text)
        if part == total:
            # A misspelled assessment heading is recognizable from its section icon.
            for heading in SECTION_HEADINGS[1:]:
                revised = re.sub(r"(?m)^## " + re.escape(heading.split()[1]) + r"[^\n]*$", heading, revised)
        if revised != text:
            tools._write_staged_part(context, part, total, revised)
            changed = True
    return changed
