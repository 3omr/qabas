"""Conservative lecture repairs using the engine's staging and validation internals."""

from __future__ import annotations

import json
import re
from dataclasses import replace
from pathlib import Path
from typing import Any

import cancellation
from atomic_io import _atomic_write_json
from draft_segments import write_segments
from phase_validation import SECTION_HEADINGS, validate_editorial_quality
from question_provenance import (
    assessment_catalog,
    assessment_verified_years,
    final_provenance_errors,
)
from transcript_parser import split_blocks


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


def salvage(request: dict[str, Any], workspace: Path) -> list[str]:
    """Save only validated content; archive rejected stages and preserve doctor text.

    Invalid assessment blocks are removed, never rebadged as sourced questions.
    If guide repair is impossible, complete verbatim text is retained explicitly
    rather than replaced by an invented explanation. Every resulting draft passes
    the ordinary complete-transcript, editorial and provenance checks before save.
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
    years = assessment_verified_years(catalog)
    profile = manifest.get("exam_style_profile", {})
    notes = []
    if _figure_errors(text, context.slides_path, context.figure_directories):
        omit_support(context, "figures", "Optional figures could not be validated")
        omit_support(context, "web_figures", "Optional external illustrations could not be validated")
        notes.append("Optional figures that could not be validated were left out.")
        context = tools._resolve_draft_context(request, workspace)
        text = IMAGE_LINK.sub("", text)
    if "qabas-web-figure" in text:
        omit_support(context, "web_figures", "Unresolved optional illustration requests")
        notes.append("Unresolved optional illustrations were left out.")
    text = remove_placeholders(text)
    guide = tools._section_body(text, SECTION_HEADINGS[0])
    candidate = _scaffold(guide, ["", "", "", ""])
    baseline = tools._read_verbatim_baseline(context.verbatim_sources)
    guide_errors = tools._complete_review_errors(None, candidate, context, baseline)
    guide_errors += engine.pre_finalize_errors(candidate, years, profile, catalog)
    if guide_errors:
        if context.slides_path or IMAGE_LINK.search(guide):
            omit_support(context, "figures", "The explanation containing figures could not be validated")
            omit_support(context, "web_figures", "The explanation containing illustrations could not be validated")
            context = tools._resolve_draft_context(request, workspace)
            notes.append("Optional illustrations in the replaced explanation were left out.")
        paths = tools._complete_verbatim_paths(context)
        bodies = [tools._verbatim_body(tools._read_review_draft(path))[0] for path in paths]
        # Source headers are bookkeeping, not spoken explanation. Keep speech bytes
        # while demoting structural headings that would create extra final sections.
        guide = "\n\n".join(re.sub(r"(?m)^#{1,6} (.+)$", r"**\1**", body) for body in bodies)
        guide = re.sub(r"(?m)^> Raw auto-detected speech.*$", "", guide)
        notes.append("The doctor's full recorded text was retained; an explanation that could not be validated was left out.")
    bodies = [tools._section_body(text, heading) for heading in SECTION_HEADINGS[1:]]
    kept: list[str] = [bodies[0]]
    removed = 0
    for offset, body in enumerate(bodies[1:], 1):
        valid = []
        for block in split_blocks(body):
            cancellation.check_cancelled()
            check_bodies = ["", "", "", ""]
            check_bodies[offset] = block
            check_text = _scaffold(guide, check_bodies)
            errors = validate_editorial_quality(check_text, profile) + final_provenance_errors(check_text, catalog)
            errors += tools._complete_review_errors(None, check_text, context, baseline)
            if errors:
                removed += 1
            else:
                valid.append(block)
        kept.append("\n\n".join(valid))
    candidate = _scaffold(guide, kept)
    errors = tools._complete_review_errors(None, candidate, context, baseline)
    errors += engine.pre_finalize_errors(candidate, years, profile, catalog)
    if errors:
        # Unvalidated tips are optional; the complete doctor text is not.
        kept[0] = ""
        candidate = _scaffold(guide, kept)
        notes.append("Supporting tips that could not be validated were left out.")
        errors = tools._complete_review_errors(None, candidate, context, baseline)
        errors += engine.pre_finalize_errors(candidate, years, profile, catalog)
    if errors:
        raise tools.ToolError("Salvage validation: " + "; ".join(errors))
    if removed:
        notes.append(f"{removed} question(s) that could not be validated were left out.")
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
