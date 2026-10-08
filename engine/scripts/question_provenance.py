"""Resolve indexed questions through the real papers their occurrences cite."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from agy_exam_index import _supported
from exam_index import ExamIndexError, IndexedQuestion, load_index, parse_source
from exam_years import (
    extract_claimed_exam_years,
    extract_exam_years,
    extract_filename_exam_years,
)
from phase_validation import (
    BADGE_LIKE_PATTERN,
    _badge_years,
    _catalog_matches,
    _field_content,
    _options_content,
    _question_content,
    _question_number,
    _question_provenance_errors,
    _question_role_provenance_errors,
    _section_blocks,
    _source_field_errors,
    _source_fields,
    retained_question_fingerprint,
)
from provenance_audit import (
    audit,
    index_years,
    is_compiled_bank,
    normalize,
    split_sections,
    supported_years,
)
from transcriber_models import QuestionEvidence, QuestionProvenanceContext


def paper_texts(questions_dir: Path) -> dict[str, str]:
    return {
        path.name: path.read_text(encoding="utf-8", errors="replace")
        for path in questions_dir.glob("*")
        if path.is_file() and path.suffix.lower() in {".txt", ".md"}
    }


def _same_question(question: dict[str, Any], paper_question: IndexedQuestion) -> bool:
    actual = normalize(paper_question.stem)
    if normalize(question["stem"]) == actual:
        return True
    # Reviewed OCR repairs retain the identity of the damaged source question.
    original = question.get("repaired_from")
    return bool(
        question.get("repaired_by_hand")
        and original
        and normalize(original) == actual[:12]
    )


def _paper_occurrences(
    question: dict[str, Any], papers: dict[str, list[IndexedQuestion]]
) -> list[dict[str, Any]]:
    references = {
        (occurrence["source"], occurrence.get("section", ""))
        for occurrence in question.get("occurrences", [])
    }
    return [
        occurrence.as_dict()
        for source, section in sorted(references)
        for paper_question in papers.get(source, [])
        if _same_question(question, paper_question)
        for occurrence in paper_question.occurrences
        if occurrence.section == section
    ]


def paper_backed_index(
    index: dict[str, Any], corpus: dict[str, str], module_id: str,
    questions_dir: Path | None = None, *, source_names: set[str] | None = None,
) -> dict[str, Any]:
    if index["module"] != module_id:
        raise ExamIndexError("The exam index belongs to another module; rebuild it.")
    from exam_index import SCHEMA_VERSION
    if index.get("schema_version") == SCHEMA_VERSION and index.get("extractor") == "agy":
        return _agy_paper_backed_index(index, corpus, questions_dir, source_names)
    papers = {name: parse_source(name, text) for name, text in corpus.items()}
    questions = {}
    for key, question in index["questions"].items():
        occurrences = _paper_occurrences(question, papers)
        if not occurrences:
            continue
        years = extract_exam_years(" ".join(str(o["year"] or "") for o in occurrences))
        questions[key] = {
            **question,
            "years": list(years),
            "sources": sorted({o["source"] for o in occurrences}),
            "occurrences": occurrences,
        }
    return {**index, "questions": questions}


def _agy_occurrence_year_is_supported(
    occurrence: dict[str, Any], source_record: dict[str, Any], source_name: str, evidence: str,
) -> bool:
    """Keep an assigned year only when its source section or paper supports it."""
    section = occurrence.get("section", "")
    if not isinstance(section, str):
        return False
    section_years = extract_claimed_exam_years(section)
    year = occurrence.get("year")
    if year is None:
        return True
    if type(year) is not int:
        return False
    if section_years:
        return year in section_years
    if source_record.get("kind") == "question_bank":
        return str(year) in evidence
    return str(year) in evidence or year in extract_filename_exam_years(source_name)


def _verified_aggregate_stem(
    question: dict[str, Any], occurrences: list[dict[str, Any]], loaded: dict[str, dict[str, str]],
) -> str:
    """Use an aggregate stem only when source units or a recorded repair support it."""
    candidate = question.get("stem")
    if isinstance(candidate, str) and any(
        _supported(candidate, "\n".join(
            loaded[item["source"]][unit_id] for unit_id in item["unit_ids"]
        ))
        for item in occurrences
    ):
        return candidate
    repaired_from = question.get("repaired_from")
    if (isinstance(candidate, str) and question.get("repaired_by_hand") is True
        and isinstance(repaired_from, str) and any(
            isinstance(item.get("stem"), str)
            and normalize(repaired_from) == normalize(item["stem"])[:12]
            for item in occurrences
        )):
        return candidate
    return occurrences[0]["stem"]


def _agy_paper_backed_index(
    index: dict[str, Any], corpus: dict[str, str], questions_dir: Path | None, source_names: set[str] | None,
) -> dict[str, Any]:
    """Retain only model-extracted occurrences still bound to their original bytes."""
    from agy_exam_index import _verbatim, read_source_units, units_sha256
    from exam_index import SCHEMA_VERSION
    from exam_preparation import _hash

    if questions_dir is None:
        return {**index, "questions": {}}
    source_records = {
        source["file"]: source for source in index["sources"]
        if isinstance(source, dict) and isinstance(source.get("file"), str)
        and Path(source["file"]).name == source["file"]
        and (source_names is None or source["file"] in source_names)
    }
    loaded: dict[str, dict[str, str]] = {}
    for name, record in source_records.items():
        path = questions_dir / name
        if Path(name).name != name or not path.is_file():
            continue
        digest = _hash(path)
        if digest != record.get("sha256"):
            continue
        prepared_name = record.get("prepared_file", name)
        if not isinstance(prepared_name, str) or Path(prepared_name).name != prepared_name:
            continue
        prepared = questions_dir / prepared_name
        try:
            source_units = read_source_units(path, prepared if prepared != path else None)
        except (OSError, ValueError, RuntimeError, KeyError):
            continue
        if units_sha256(source_units) != record.get("units_sha256"):
            continue
        loaded[name] = {unit.id: unit.text for unit in source_units}
    questions: dict[str, Any] = {}
    for key, question in index["questions"].items():
        accepted = []
        for occurrence in question.get("occurrences", []):
            source = occurrence.get("source")
            if not isinstance(source, str):
                continue
            if source_names is not None and source not in source_names:
                continue
            source_unit_map = loaded.get(source)
            if source_unit_map is None:
                continue
            ids = occurrence.get("unit_ids")
            if not isinstance(ids, list) or not ids or any(unit_id not in source_unit_map for unit_id in ids):
                continue
            evidence = "\n".join(source_unit_map[unit_id] for unit_id in ids)
            occurrence_stem = occurrence.get("stem", question.get("stem", ""))
            if (evidence != occurrence.get("source_quote") or not isinstance(occurrence_stem, str)
                or not _supported(occurrence_stem, evidence)):
                continue
            if occurrence.get("kind", question.get("kind")) not in {"mcq", "written"}:
                continue
            source_options = occurrence.get("options", question.get("options", {}))
            if not isinstance(source_options, dict) or any(not _supported(option, evidence) for option in source_options.values()):
                continue
            occurrence_answer = occurrence.get("answer")
            if occurrence_answer is not None and occurrence_answer not in source_options:
                continue
            if (occurrence_answer is not None and occurrence.get("answer_text") is None
                and occurrence.get("source_answer") != source_options.get(occurrence_answer)):
                continue
            answer_ids = occurrence.get("answer_unit_ids", [])
            answer_evidence = occurrence.get("answer_evidence")
            answer_text = occurrence.get("answer_text")
            if occurrence.get("answer") is not None or answer_text is not None:
                if not answer_ids or any(unit_id not in source_unit_map for unit_id in answer_ids):
                    continue
                answer_source = "\n".join(source_unit_map[unit_id] for unit_id in answer_ids)
                if (not isinstance(answer_evidence, str)
                    or not _verbatim(answer_evidence, answer_source)
                    or (answer_text is not None and not _supported(answer_text, answer_source))):
                    continue
            explanation = occurrence.get("explanation")
            explanation_ids = occurrence.get("explanation_unit_ids", [])
            if explanation is not None and (
                not explanation_ids or any(unit_id not in source_unit_map for unit_id in explanation_ids)
                or not _supported(explanation, "\n".join(source_unit_map[unit_id] for unit_id in explanation_ids))
            ):
                continue
            if occurrence.get("topic") is not None and not _supported(occurrence["topic"], evidence):
                continue
            if not _agy_occurrence_year_is_supported(occurrence, source_records[source], source, evidence):
                continue
            accepted.append(occurrence)
        if accepted:
            first_options = accepted[0].get("options", question.get("options", {}))
            answers = {item.get("answer") for item in accepted if item.get("answer") is not None}
            answer_conflict = question.get("answer_conflict", False) or len(answers) > 1
            questions[key] = {
                **question,
                "stem": _verified_aggregate_stem(question, accepted, loaded),
                "options": first_options,
                "answer": None if answer_conflict else (next(iter(answers)) if answers else None),
                "answer_conflict": answer_conflict,
                "needs_review": question.get("needs_review", False) or answer_conflict,
                "occurrences": accepted,
                "years": sorted({item["year"] for item in accepted if item.get("year")}),
                "sources": sorted({item["source"] for item in accepted}),
            }
    return {**index, "schema_version": SCHEMA_VERSION, "questions": questions}


def load_paper_backed_index(questions_dir: Path, module_id: str) -> dict[str, Any]:
    return paper_backed_index(load_index(questions_dir), paper_texts(questions_dir), module_id, questions_dir)


def assessment_catalog(module_root: Path, manifest: dict[str, Any]) -> list[dict[str, Any]]:
    """Use one manifest's assessment evidence for offline checks and finalize."""
    from exam_years import extract_claimed_exam_years
    from source_naming import normalize_source_key

    catalog = []
    for source in manifest.get("assessment_sources", []):
        path = module_root / source["path"]
        years = source.get("years", [source.get("year", "")])
        catalog.append({
            "canonical_name": path.name,
            "normalized_name": normalize_source_key(path.name),
            "aliases": [path.name, source["path"]],
            "local_path": str(path),
            "role": source["type"],
            "verified_years": list(extract_claimed_exam_years(" ".join(map(str, years)))),
            "content_status": (
                "available" if path.is_file() or path.with_suffix(".txt").is_file()
                else "remote_only" if source.get("action") in {"use_remote", "remote_only"}
                else "missing"
            ),
        })
    return catalog


def local_assessment_catalog(module_root: Path) -> list[dict[str, Any]]:
    """Expose local question papers for loss prevention when a manifest omits a source."""
    from exam_index import SCHEMA_VERSION, ExamIndexError, load_index

    questions_dir = module_root / "Questions"
    try:
        index = load_index(questions_dir)
    except (ExamIndexError, OSError, ValueError):
        index = None
    if index and index.get("schema_version") == SCHEMA_VERSION and index.get("extractor") == "agy":
        sources = [{"path": f"Questions/{source['file']}", "type": source["kind"], "years": source["years"]}
                   for source in index["sources"] if (questions_dir / source["file"]).is_file()]
        return assessment_catalog(module_root, {"assessment_sources": sources})
    sources = []
    for name, text in paper_texts(questions_dir).items():
        years = sorted({year for question in parse_source(name, text) for year in question.years})
        role = "question_bank" if is_compiled_bank(split_sections(text)) or not years else "past_exam"
        sources.append({"path": f"Questions/{name}", "type": role, "years": years})
    return assessment_catalog(module_root, {"assessment_sources": sources})


def _catalog_papers(catalog: list[dict[str, Any]]) -> tuple[dict[str, str], dict[str, Any] | None]:
    from exam_index import INDEX_NAME

    corpus = {}
    index = None
    for entry in catalog:
        path = _paper_path(entry)
        if entry.get("local_path") and path.is_file() and path.suffix.lower() in {".txt", ".md"}:
            corpus[path.name] = path.read_text(encoding="utf-8", errors="replace")
    directories = {Path(entry["local_path"]).parent for entry in catalog if entry.get("local_path")}
    for directory in sorted(directories):
        if not (directory / INDEX_NAME).is_file():
            continue
        try:
            stored = load_index(directory)
            index = paper_backed_index(stored, corpus, stored["module"], directory)
        except ExamIndexError:
            # Raw paper matching remains authoritative when the index is unusable.
            continue
        break
    return corpus, index


def _cited_index(index: dict[str, Any] | None, sources: set[str]) -> dict[str, Any] | None:
    if index is None:
        return None
    questions = {}
    for key, question in index["questions"].items():
        occurrences = [o for o in question["occurrences"] if o["source"] in sources]
        if occurrences:
            questions[key] = {**question, "years": list(extract_exam_years(
                " ".join(str(o["year"] or "") for o in occurrences)
            ))}
    return {**index, "questions": questions}


def _cited_papers(context: QuestionProvenanceContext, corpus: dict[str, str]) -> dict[str, str]:
    names = {
        _paper_path(entry).name
        for field in _source_fields(context.block)
        for entry in _catalog_matches(field, context.evidence.evidence_catalog)
    }
    return {name: text for name, text in corpus.items() if name in names}


def _paper_path(entry: dict[str, Any]) -> Path:
    path = Path(entry.get("local_path") or entry["canonical_name"])
    if path.suffix.lower() in {".txt", ".md"}:
        return path
    prepared = path.with_name(path.name + ".txt")
    return prepared if prepared.is_file() else path.with_suffix(".txt")


def _final_block_provenance_errors(
    context: QuestionProvenanceContext, corpus: dict[str, str], index: dict[str, Any] | None
) -> list[str]:
    claimed = _badge_years(context.block)
    if not claimed and "Question Bank" not in context.block:
        return _question_provenance_errors(context.block, context.heading_prefix, context.evidence)
    label = f"{context.heading_prefix} {context.number}"
    fields = _source_fields(context.block)
    errors = []
    if not fields:
        errors.append(f"{label} [missing_source]: sourced question has no Source field")
        if claimed:
            errors.append(_year_mismatch(label, claimed, set()))
        return errors
    errors += _source_field_errors(fields, context.heading_prefix, context.number, context.evidence)[0]
    cited = _cited_papers(context, corpus)
    if not cited:
        return errors + _question_provenance_errors(context.block, context.heading_prefix, context.evidence)
    supported = set(supported_years(
        _provenance_stem(context), cited, _options_content(context.block), _cited_index(index, set(cited))
    ))
    unlocated = [name for name, text in cited.items() if not _confirmed_question(context, {name: text}, index)]
    if unlocated:
        errors.append(f"{label} [source_match_uncertain]: question wording is not conclusively located in cited papers {sorted(unlocated)}; automatic lookup must repair the citations or badge")
    if claimed - supported:
        errors.append(_year_mismatch(label, claimed, supported))
    if claimed and supported - claimed:
        errors.append(f"{label} [missing_supported_year]: source evidence contains years {sorted(supported - claimed)} not present in the badge")
    roles = {"past_exam" if supported else "question_bank"}
    errors += _question_role_provenance_errors(context, roles)
    return errors


def _confirmed_question(context: QuestionProvenanceContext, cited: dict[str, str], index: dict[str, Any] | None) -> bool:
    stem = _provenance_stem(context)
    if index_years(stem, _cited_index(index, set(cited))) is not None:
        return True
    locations = audit(stem, cited, _options_content(context.block))
    return any(hit.found for hit in locations)


def repair_provenance_badges(draft: str, catalog: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """Resolve sourced badges against every local paper; retain unlocated wording as IMP."""
    corpus, index = _catalog_papers(catalog)
    evidence = QuestionEvidence({}, [], evidence_catalog=catalog)
    corrections = []
    for kind in ("MCQ", "Question", "Clinical Case"):
        for block in _section_blocks(draft, kind):
            normalized = re.sub(r"(?m)^([ \t]*(?:> )?\*\*Source)\*\*:", r"\1:**", block)
            context = QuestionProvenanceContext(
                normalized, kind, _question_number(block, kind), evidence, tuple(BADGE_LIKE_PATTERN.findall(block))
            )
            revised, correction = _repaired_badge(context, corpus, index)
            if normalized != block and correction is None:
                heading = block.splitlines()[0]
                correction = {"question": f"{kind} {context.number}", "before": heading, "after": heading,
                              "evidenced_years": sorted(_badge_years(revised)),
                              "note": "Malformed Source field repaired"}
            if correction is not None:
                draft = draft.replace(block, revised, 1)
                corrections.append(correction)
    return draft, corrections


def evidenced_question(block: str, kind: str, catalog: list[dict[str, Any]]) -> str | None:
    """Locate a sourced badge independently of editorial errors or a broken Source line.

    Return the question with conclusive sources and evidenced years, or None
    when no local paper/index occurrence establishes its provenance. Partial
    year support protects the question and repairs its badge to supported years.
    """
    badges = tuple(BADGE_LIKE_PATTERN.findall(block))
    if not any("past exams" in badge.casefold() or "question bank" in badge.casefold() for badge in badges):
        return None
    corpus, index = _catalog_papers(catalog)
    context = QuestionProvenanceContext(block, kind, _question_number(block, kind),
                                        QuestionEvidence({}, [], evidence_catalog=catalog), badges)
    sources = [name for name, text in corpus.items()
               if _confirmed_question(context, {name: text}, index)]
    if not sources:
        return None
    revised = re.sub(r"(?m)^[ \t]*(?:> )?\*\*Source:\*\*[^\n]*(?:\n|$)", "", block).rstrip()
    revised += "\n" + "\n".join(f"**Source:** {name}" for name in sorted(sources)) + "\n"
    years = supported_years(_provenance_stem(context), {name: corpus[name] for name in sources},
                            _options_content(block), _cited_index(index, set(sources)))
    if not years and not any(entry.get("role") == "question_bank" and _paper_path(entry).name in sources
                             for entry in catalog):
        return None
    repaired, _corrections = repair_provenance_badges(revised, catalog)
    return repaired


def record_provenance_repairs(transcript: Path, corrections: list[dict[str, Any]]) -> None:
    """Persist automatic corrections beside draft-check metadata for job reporting."""
    import json

    from atomic_io import _atomic_write_json

    if not corrections:
        return
    path = transcript.parent.parent / ".transcriber-cache" / "review-repairs" / f"{transcript.name}.json"
    previous = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else []
    _atomic_write_json(path, previous + corrections)


def retained_question_receipts(transcript: Path) -> set[str]:
    """Read exact-question retention receipts issued by engine repair, never Markdown comments."""
    import json

    journal = transcript.parent.parent / ".transcriber-cache" / "review-repairs" / f"{transcript.name}.json"
    records = json.loads(journal.read_text(encoding="utf-8")) if journal.is_file() else []
    return {entry["retained_fingerprint"] for entry in records
            if isinstance(entry, dict) and re.fullmatch(r"[a-f0-9]{64}", str(entry.get("retained_fingerprint", "")))}


def repair_saved_draft(transcript: Path, catalog: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """Persist retention receipts before atomically publishing repaired badges/citations."""
    from atomic_io import _atomic_write_text

    draft, corrections = repair_provenance_badges(transcript.read_text(encoding="utf-8"), catalog)
    if corrections:
        record_provenance_repairs(transcript, corrections)
        _atomic_write_text(transcript, draft)
    return draft, corrections


def _repaired_badge(context: QuestionProvenanceContext, corpus: dict[str, str], index: dict[str, Any] | None) -> tuple[str, dict[str, Any] | None]:
    block = context.block
    if not any("Past Exams" in badge or "Question Bank" in badge for badge in context.badges):
        return block, None
    # Search every paper independently: an uncertain second citation cannot veto a located first one.
    original_citations = _cited_papers(context, corpus)
    cited = {name: text for name, text in original_citations.items()
             if _confirmed_question(context, {name: text}, index)}
    if not cited:
        cited = {name: text for name, text in corpus.items()
                 if _confirmed_question(context, {name: text}, index)}
    years = supported_years(_provenance_stem(context), cited, _options_content(block), _cited_index(index, set(cited)))
    located = bool(cited)
    badge = "**[Past Exams - " + ", ".join(map(str, years)) + "]**" if years else "**[Question Bank]**" if located else "**[IMP]**"
    has_bank_badge = any("Question Bank" in badge for badge in context.badges)
    expected_sources = sorted(cited)
    actual_sources = sorted(_cited_papers(context, corpus))
    if located and _badge_years(block) == set(years) and has_bank_badge == (not years) and actual_sources == expected_sources and not _source_field_errors(_source_fields(block), context.heading_prefix, context.number, context.evidence)[0]:
        return block, None
    heading = re.search(r"(?m)^(?:> )?### .+$", block)
    if heading is None:
        return block, None
    before = heading.group()
    after = BADGE_LIKE_PATTERN.sub("", before).rstrip() + " " + badge
    revised = block[:heading.start()] + after + block[heading.end():]
    if located and cited == original_citations and not _source_field_errors(_source_fields(block), context.heading_prefix, context.number, context.evidence)[0]:
        return revised, {"question": f"{context.heading_prefix} {context.number}", "before": before,
                         "after": after, "evidenced_years": list(years), "sources": sorted(cited)}
    revised = re.sub(r"(?m)^[ \t]*(?:> )?\*\*Source(?::\*\*|\*\*:)[^\n]*(?:\n|$)", "", revised).rstrip() + "\n"
    if located:
        revised += "\n".join(f"**Source:** {name}" for name in expected_sources) + "\n"
    else:
        revised += "\n<!-- qabas-retained-question -->\nProvenance note: No question occurrence was confirmed in the local papers or exam index; retained as an important practice question with original wording and options.\n"
    return revised, {"question": f"{context.heading_prefix} {context.number}", "before": before,
                     "after": after, "evidenced_years": list(years), "sources": sorted(cited),
                     "note": "Located in paper evidence" if located else "Unlocated question retained as IMP",
                     **({"retained_fingerprint": retained_question_fingerprint(revised, context.heading_prefix)} if not located else {})}


def _provenance_stem(context: QuestionProvenanceContext) -> str:
    if context.heading_prefix == "Clinical Case":
        return _field_content(context.block, "Scenario")
    return _question_content(context.block)


def _year_mismatch(label: str, claimed: set[int], supported: set[int]) -> str:
    return (
        f"{label} [source_year_mismatch]: claimed years {sorted(claimed)}; "
        f"evidenced years {sorted(supported)} -- unbacked: {sorted(claimed - supported)}"
    )


def final_provenance_errors(draft: str, catalog: list[dict[str, Any]]) -> list[str]:
    """Check Source fields and question-level year evidence through one reader."""
    corpus, index = _catalog_papers(catalog)
    year_map: dict[int, list[str]] = {}
    for entry in catalog:
        for year in entry.get("verified_years", []):
            year_map.setdefault(year, []).append(entry["canonical_name"])
    evidence = QuestionEvidence(year_map, [], evidence_catalog=catalog)
    errors = []
    for kind in ("MCQ", "Question", "Clinical Case"):
        for block in _section_blocks(draft, kind):
            context = QuestionProvenanceContext(
                block, kind, _question_number(block, kind), evidence, tuple(BADGE_LIKE_PATTERN.findall(block))
            )
            errors += _final_block_provenance_errors(context, corpus, index)
    return list(dict.fromkeys(errors))


def assessment_verified_years(catalog: list[dict[str, Any]]) -> set[int]:
    """Include a compiled bank's real section years, never its compilation year."""
    from engine_utils import _catalog_entry_is_available

    corpus, _index = _catalog_papers(catalog)
    years = {
        year for entry in catalog if _catalog_entry_is_available(entry)
        for year in entry.get("verified_years", [])
        if entry.get("role") == "past_exam" and _paper_path(entry).name not in corpus
    }
    for name, text in corpus.items():
        for question in parse_source(name, text):
            years.update(question.years)
    return years
