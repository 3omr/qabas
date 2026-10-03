"""Resolve indexed questions through the real papers their occurrences cite."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from exam_index import ExamIndexError, IndexedQuestion, load_index, parse_source
from exam_years import extract_exam_years
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
)
from provenance_audit import normalize, supported_years
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
    index: dict[str, Any], corpus: dict[str, str], module_id: str
) -> dict[str, Any]:
    if index["module"] != module_id:
        raise ExamIndexError("The exam index belongs to another module; rebuild it.")
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


def load_paper_backed_index(questions_dir: Path, module_id: str) -> dict[str, Any]:
    return paper_backed_index(load_index(questions_dir), paper_texts(questions_dir), module_id)


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
            index = paper_backed_index(stored, corpus, stored["module"])
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
    return path if path.suffix.lower() in {".txt", ".md"} else path.with_suffix(".txt")


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
    if claimed - supported:
        errors.append(_year_mismatch(label, claimed, supported))
    if claimed and supported - claimed:
        errors.append(f"{label} [missing_supported_year]: source evidence contains years {sorted(supported - claimed)} not present in the badge")
    roles = {"past_exam" if supported else "question_bank"}
    errors += _question_role_provenance_errors(context, roles)
    return errors


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
