"""Regressions from the ophtha Conjunctiva verbatim run (October 2026)."""

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import mcp_server
from agy_index_fixtures import write_agy_index
from draft_segments import write_segments
from exam_index import write_index
from phase_validation import SECTION_HEADINGS
from run_transcription import generate_auto_manifest


@pytest.fixture
def ophtha(tmp_path: Path) -> tuple[Path, dict, dict]:
    root = tmp_path / "modules" / "ophtha"
    for folder in ("Lecture", "Questions", "Verbatim", "Transcripts"):
        (root / folder).mkdir(parents=True)
    (root / "module.json").write_text(json.dumps({
        "schema_version": 1,
        "module_id": "ophtha",
        "display_name": "Ophthalmology",
        "notebook": {"id": "test-ophtha", "title": "Ophthalmology"},
        "output": {"emoji": "👁️", "language": "Egyptian Arabic"},
    }), encoding="utf-8")
    (root / "Lecture" / "Conjunctiva.mp3").write_bytes(b"fixture audio")
    paragraph = "الدكتور شرح Palpebral conjunctiva وتشريح الملتحمة بالتفصيل. " * 30 + "\n\n"
    (root / "Verbatim" / "Conjunctiva.verbatim.md").write_text(paragraph * 9, encoding="utf-8")
    papers = {
        "August 2023.txt": "1. Conjunctiva follicles consist of lymphoid tissue\n",
        "May 2023.txt": "1. Conjunctiva follicles consist of lymphoid tissue\n",
        "final_2023.txt": "7- Palpebral conjunctiva.\n",
        "final_2024.txt": "1. Conjunctiva follicles consist of lymphoid tissue\n",
        "Written Exam final 2024.txt": "1. Conjunctiva examination and characteristic clinical signs\n",
        "Final 25.txt": "1. Conjunctiva treatment and drug precautions\n",
        "Combined_2026.txt": "--- Final 2023 ---\n1. Conjunctiva complications after severe infection\n--- Page 2 ---\n2. Conjunctiva undated bank question\n",
    }
    for name, text in papers.items():
        (root / "Questions" / name).write_text(text, encoding="utf-8")
    (root / "Questions" / "ophthalmology_exams_bank.json").write_text("{}", encoding="utf-8")
    write_index(write_agy_index(root / "Questions", "ophtha"), root / "Questions")
    manifest = generate_auto_manifest(root, "Conjunctiva", discover_remote=False)
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    payload["write_part_bytes"] = len(paragraph.encode("utf-8"))
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    arguments = {"module": "ophtha", "manifest_path": str(manifest)}
    found = json.loads(mcp_server._find_questions({"module": "ophtha", "lecture": "Conjunctiva"}, tmp_path))
    return root, arguments, found


def _questions_part(entries: list[dict]) -> str:
    questions = "\n\n".join(
        f"### Question {number} {entry['badge']}\n\n**Question:** {entry['stem']}\n\n"
        f"**Source:** {'; '.join(paper['path'] for paper in entry['source_papers'])}\n\n"
        "**Model Answer:**\n- Tarsal adherence\n\n**Clinical Explanation:** الدكتور شرح تفاصيل الملتحمة."
        for number, entry in enumerate(entries, 1)
    )
    return "\n\n".join((
        SECTION_HEADINGS[1], "Important clinical points.",
        SECTION_HEADINGS[2], "No MCQs.",
        SECTION_HEADINGS[3], questions,
        SECTION_HEADINGS[4], "No clinical cases.",
    )) + "\n"


def _stage_guide(workspace: Path, root: Path, arguments: dict) -> Path:
    plan = json.loads(mcp_server._read_draft(arguments, workspace))
    assert plan["route"] == "verbatim"
    assert plan["write_parts"] == 9
    verbatim = (root / "Verbatim" / "Conjunctiva.verbatim.md").read_text(encoding="utf-8")
    manifest = json.loads(Path(arguments["manifest_path"]).read_text(encoding="utf-8"))
    for part, content in enumerate(write_segments(verbatim, manifest["write_part_bytes"]), 1):
        if part == 1:
            content = SECTION_HEADINGS[0] + "\n\n" + content
        mcp_server._stage_draft_part({**arguments, "part": part, "parts": 10, "content": content}, workspace)
    return mcp_server._resolve_draft_context(arguments, workspace).path


def test_every_discovered_badge_passes_real_verbatim_provenance(ophtha, tmp_path):
    root, arguments, found = ophtha
    entries = found["entries"]
    short = next(entry for entry in entries if entry["stem"] == "Palpebral conjunctiva")
    assert short["badge"] == "**[Past Exams - 2023]**"
    assert {
        key: short["source_papers"][0][key]
        for key in ("source", "path", "section", "year")
    } == {
        "source": "final_2023.txt", "path": "Questions/final_2023.txt", "section": "", "year": 2023,
    }
    manifest = json.loads(Path(arguments["manifest_path"]).read_text(encoding="utf-8"))
    assert {paper["path"] for entry in entries for paper in entry["source_papers"]} <= {
        source["path"] for source in manifest["assessment_sources"]
    }
    assert any(entry["years"] == [2023, 2024] for entry in entries)
    assert any(not entry["years"] for entry in entries)
    assert all(2026 not in entry["years"] for entry in entries)
    draft = _stage_guide(tmp_path, root, arguments)
    mcp_server._stage_draft_part({**arguments, "part": 10, "parts": 10, "content": _questions_part(entries)}, tmp_path)
    mcp_server._apply_review({**arguments, "from_parts": True}, tmp_path)
    verified = mcp_server._verify_provenance({"module": "ophtha", "transcript": str(draft)}, tmp_path)
    assert "Every year badge is backed" in verified


def test_failed_provenance_can_be_repaired_by_replacing_only_part_10(ophtha, tmp_path, monkeypatch):
    root, arguments, found = ophtha
    draft = _stage_guide(tmp_path, root, arguments)
    short = next(entry for entry in found["entries"] if entry["stem"] == "Palpebral conjunctiva")
    revised_stem = "Write short notes on the anatomy and parts of the Palpebral Conjunctiva."
    bad = _questions_part([{**short, "stem": revised_stem}])
    mcp_server._stage_draft_part({**arguments, "part": 10, "parts": 10, "content": bad}, tmp_path)
    mcp_server._apply_review({**arguments, "from_parts": True}, tmp_path)
    assert revised_stem in draft.read_text()
    assert "**[IMP]**" in draft.read_text()
    assert "**[Past Exams - 2023]**" not in draft.read_text()
    assert "Every year badge is backed" in mcp_server._verify_provenance({"module": "ophtha", "transcript": str(draft)}, tmp_path)
    staged = root / ".transcriber-cache" / "staged-drafts" / draft.name
    retained = {path.name: path.read_bytes() for path in staged.iterdir() if path.name != "part-10.md"}
    # A new read/tool invocation must not discard the layout after a successful save.
    mcp_server._read_draft(arguments, tmp_path)
    good = _questions_part([short])
    for _ in range(2):
        status = json.loads(mcp_server._stage_draft_part({**arguments, "part": 10, "parts": 10, "content": good}, tmp_path))
        assert status["received_parts"] == list(range(1, 11))
        assert status["missing_parts"] == []
        mcp_server._apply_review({**arguments, "from_parts": True}, tmp_path)
        assert {path.name: path.read_bytes() for path in staged.iterdir() if path.name != "part-10.md"} == retained
    assert draft.read_text(encoding="utf-8").endswith(good)
    assert "Every year badge is backed" in mcp_server._verify_provenance({"module": "ophtha", "transcript": str(draft)}, tmp_path)
    # Finalization is an external engine subprocess; failure must preserve recovery state.
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: subprocess.CompletedProcess(a, 1, "", "finalizer refused"))
    with pytest.raises(mcp_server.ToolError, match="finalizer refused"):
        mcp_server._finalize(arguments, tmp_path)
    assert staged.is_dir()
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: subprocess.CompletedProcess(a, 0, "Finalized", ""))
    assert mcp_server._finalize(arguments, tmp_path) == "Finalized"
    assert not staged.exists()


def test_large_inline_revision_preserves_retained_parts_for_targeted_repair(ophtha, tmp_path):
    root, arguments, found = ophtha
    draft = _stage_guide(tmp_path, root, arguments)
    questions = _questions_part(found["entries"])
    mcp_server._stage_draft_part({**arguments, "part": 10, "parts": 10, "content": questions}, tmp_path)
    mcp_server._apply_review({**arguments, "from_parts": True}, tmp_path)
    revised = draft.read_text(encoding="utf-8") + "\nإضافة بعد المراجعة.\n"
    staged = root / ".transcriber-cache" / "staged-drafts" / draft.name
    before = {path.name: path.read_bytes() for path in staged.iterdir()}
    with pytest.raises(mcp_server.ToolError, match="Never send the whole draft"):
        mcp_server._apply_review({**arguments, "content": revised}, tmp_path)
    assert {path.name: path.read_bytes() for path in staged.iterdir()} == before
    mcp_server._stage_draft_part({**arguments, "part": 10, "parts": 10,
                                "content": questions + "\nإضافة بعد المراجعة.\n"}, tmp_path)
    mcp_server._apply_review({**arguments, "from_parts": True}, tmp_path)
    assert draft.read_text(encoding="utf-8") == revised


@pytest.mark.parametrize("resume", ["begin_lecture", "read_draft", "stage_draft_part"])
def test_legacy_saved_guide_recovers_parts_1_to_9_and_keeps_resent_questions(ophtha, tmp_path, monkeypatch, resume):
    root, arguments, found = ophtha
    draft = _stage_guide(tmp_path, root, arguments)
    short = next(entry for entry in found["entries"] if entry["stem"] == "Palpebral conjunctiva")
    bad = _questions_part([{**short, "stem": "Write short notes on the anatomy and parts of the Palpebral Conjunctiva."}])
    mcp_server._stage_draft_part({**arguments, "part": 10, "parts": 10, "content": bad}, tmp_path)
    mcp_server._apply_review({**arguments, "from_parts": True}, tmp_path)
    assert "**[IMP]**" in draft.read_text()
    assert "**[Past Exams - 2023]**" not in draft.read_text()
    assert "Every year badge is backed" in mcp_server._verify_provenance({"module": "ophtha", "transcript": str(draft)}, tmp_path)
    original = draft.read_text(encoding="utf-8")
    staged = root / ".transcriber-cache" / "staged-drafts" / draft.name
    # Pre-4e852fe saves lost the guide parts and had no boundary metadata.
    mcp_server._saved_boundaries_path(mcp_server._resolve_draft_context(arguments, tmp_path)).unlink()
    for part in range(1, 10):
        (staged / f"part-{part}.md").unlink()
    good = _questions_part([short])
    (staged / "part-10.md").write_text(good, encoding="utf-8")
    monkeypatch.setattr("nlm_client.list_remote_sources", lambda *args: [])
    if resume == "begin_lecture":
        status = json.loads(mcp_server._begin_lecture({"module": "ophtha", "lecture": "Conjunctiva"}, tmp_path))
        assert "verify_provenance failed" not in status["next"]
        assert "drafting_reference" not in status["next"]
    elif resume == "read_draft":
        status = json.loads(mcp_server._read_draft(arguments, tmp_path))
    else:
        status = json.loads(mcp_server._stage_draft_part({**arguments, "part": 10, "parts": 10, "content": good}, tmp_path))
    assert status["received_parts"] == list(range(1, 11))
    assert status["missing_parts"] == []
    assert (staged / "part-10.md").read_text(encoding="utf-8") == good
    guide = "".join((staged / f"part-{part}.md").read_text(encoding="utf-8") for part in range(1, 10))
    assert guide == original[:original.index(SECTION_HEADINGS[1])]
    assert all((staged / f"part-{part}.md").read_text(encoding="utf-8").endswith("\n\n") for part in range(1, 10))
    assert draft.read_text(encoding="utf-8") == original
    mcp_server._apply_review({**arguments, "from_parts": True}, tmp_path)
    assert draft.read_text(encoding="utf-8") == guide + good
    assert "Every year badge is backed" in mcp_server._verify_provenance({"module": "ophtha", "transcript": str(draft)}, tmp_path)


def test_saved_boundaries_recover_uneven_parts_exactly_and_preserve_present_parts(ophtha, tmp_path):
    root, arguments, found = ophtha
    draft = _stage_guide(tmp_path, root, arguments)
    # Unequal guide lengths make proportional recovery observably incorrect.
    original_second = (root / ".transcriber-cache" / "staged-drafts" / draft.name / "part-2.md").read_text(encoding="utf-8")
    mcp_server._stage_draft_part({**arguments, "part": 2, "parts": 10, "content": original_second + "Clinical detail. " * 80}, tmp_path)
    questions = _questions_part(found["entries"])
    mcp_server._stage_draft_part({**arguments, "part": 10, "parts": 10, "content": questions}, tmp_path)
    mcp_server._apply_review({**arguments, "from_parts": True}, tmp_path)
    staged = root / ".transcriber-cache" / "staged-drafts" / draft.name
    expected = {path.name: path.read_bytes() for path in staged.glob("part-*.md")}
    for part in range(1, 10):
        (staged / f"part-{part}.md").unlink()
    resent = questions + "\nQuestion correction.\n"
    (staged / "part-10.md").write_text(resent, encoding="utf-8")
    expected["part-10.md"] = resent.encode("utf-8")
    mcp_server._read_draft(arguments, tmp_path)
    assert {path.name: path.read_bytes() for path in staged.glob("part-*.md")} == expected
    mcp_server._apply_review({**arguments, "from_parts": True}, tmp_path)
    assert draft.read_bytes() == b"".join(expected[f"part-{part}.md"] for part in range(1, 11))


@pytest.mark.parametrize("part", [1, 10])
def test_wrong_parts_total_reports_exact_total_and_existing_parts(ophtha, tmp_path, part):
    root, arguments, found = ophtha
    draft = _stage_guide(tmp_path, root, arguments)
    mcp_server._stage_draft_part({**arguments, "part": 10, "parts": 10, "content": _questions_part(found["entries"])}, tmp_path)
    staged = root / ".transcriber-cache" / "staged-drafts" / draft.name
    before = {path.name: path.read_bytes() for path in staged.iterdir()}
    with pytest.raises(mcp_server.ToolError) as caught:
        mcp_server._stage_draft_part({**arguments, "part": part, "parts": 1, "content": "Correction"}, tmp_path)
    assert "Use parts=10" in str(caught.value)
    assert "Existing parts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]" in str(caught.value)
    assert {path.name: path.read_bytes() for path in staged.iterdir()} == before


def test_reviewed_ocr_repair_keeps_its_real_paper_reference(ophtha, tmp_path):
    root, arguments, _ = ophtha
    path = root / "Questions" / "exam-index.json"
    index = json.loads(path.read_text(encoding="utf-8"))
    short = next(q for q in index["questions"].values() if q["stem"] == "Palpebral conjunctiva")
    short.update(stem="Palpebral conjunctiva anatomy", repaired_by_hand=True, repaired_from="palpebral conjunctiva")
    path.write_text(json.dumps(index), encoding="utf-8")
    found = json.loads(mcp_server._find_questions({"module": "ophtha", "lecture": "Conjunctiva"}, tmp_path))
    repaired = next(entry for entry in found["entries"] if entry["stem"] == short["stem"])
    assert repaired["years"] == [2023]
    draft = root / "Transcripts" / "repaired.draft.md"
    draft.write_text(_questions_part([repaired]), encoding="utf-8")
    assert "Every year badge is backed" in mcp_server._verify_provenance({"module": "ophtha", "transcript": str(draft)}, tmp_path)


def test_unreasonable_year_claim_is_replaced_only_with_paper_backed_years(ophtha, tmp_path):
    root, _, found = ophtha
    short = next(entry for entry in found["entries"] if entry["stem"] == "Palpebral conjunctiva")
    draft = root / "Transcripts" / "future.draft.md"
    draft.write_text(_questions_part([{**short, "badge": "**[Past Exams - 2099]**"}]), encoding="utf-8")
    output = mcp_server._verify_provenance({"module": "ophtha", "transcript": str(draft)}, tmp_path)
    assert "[AUTO-REPAIR]" in output and "Every year badge is backed" in output
    assert "**[Past Exams - 2023]**" in draft.read_text(encoding="utf-8")
    assert "2099" not in draft.read_text(encoding="utf-8")


@pytest.mark.parametrize("corruption", ["aggregate_year", "missing_paper", "wrong_section", "invented_stem"])
def test_index_metadata_cannot_grant_an_unbacked_year(ophtha, tmp_path, corruption):
    root, arguments, _ = ophtha
    path = root / "Questions" / "exam-index.json"
    index = json.loads(path.read_text(encoding="utf-8"))
    short = next(q for q in index["questions"].values() if q["stem"] == "Palpebral conjunctiva")
    if corruption == "aggregate_year":
        short["years"] = [2027]
    elif corruption == "missing_paper":
        (root / "Questions" / "final_2023.txt").unlink()
    elif corruption == "wrong_section":
        short["occurrences"][0]["section"] = "Final 2027"
    else:
        short["stem"] = "Conjunctiva invented question absent from every paper"
    path.write_text(json.dumps(index), encoding="utf-8")
    if corruption == "missing_paper":
        with pytest.raises(mcp_server.ToolError, match="Exam index is stale.*build_exam_index"):
            mcp_server._find_questions({"module": "ophtha", "lecture": "Conjunctiva"}, tmp_path)
    else:
        found = json.loads(mcp_server._find_questions({"module": "ophtha", "lecture": "Conjunctiva"}, tmp_path))
        assert all(2027 not in entry["years"] for entry in found["entries"])
        if corruption == "aggregate_year":
            assert next(entry for entry in found["entries"] if entry["stem"] == short["stem"])["years"] == [2023]
        else:
            assert all(entry["stem"] != short["stem"] for entry in found["entries"])
    draft = root / "Transcripts" / "claim.draft.md"
    draft.write_text(f"### Question 1 **[Past Exams - 2027]**\n\n**Question:** {short['stem']}\n", encoding="utf-8")
    from question_provenance import assessment_catalog, final_provenance_errors

    catalog = assessment_catalog(root, json.loads(Path(arguments["manifest_path"]).read_text()))
    assert any("unbacked: [2027]" in error for error in final_provenance_errors(draft.read_text(), catalog))
    assert "Every year badge is backed" in mcp_server._verify_provenance({"module": "ophtha", "transcript": str(draft)}, tmp_path)
    repaired = draft.read_text()
    assert "2027" not in repaired
    assert short['stem'] in repaired
    assert final_provenance_errors(repaired, catalog) == []


@pytest.mark.parametrize("variant", ["incident", "missing_source", "wrong_paper", "bad_options_and_document", "repaired"])
def test_validate_and_provenance_cover_every_finalizer_finding(ophtha, tmp_path, variant):
    """Conjunctiva falsely passed both gates before finalize refused five findings."""
    import universal_transcribe as engine
    from question_provenance import assessment_catalog

    root, arguments, found = ophtha
    fixture = Path(__file__).parent / "fixtures" / "conjunctiva"
    manifest_path = Path(arguments["manifest_path"])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["exam_style_profile"] = json.loads((fixture / "exam-style.json").read_text(encoding="utf-8"))
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    short = next(entry for entry in found["entries"] if entry["stem"] == "Palpebral conjunctiva")
    if variant == "incident":
        draft_text = (fixture / "incident.draft.md").read_text(encoding="utf-8")
    else:
        draft_text = SECTION_HEADINGS[0] + "\n\nشرح المحاضرة.\n\n" + _questions_part([short])
        if variant == "missing_source":
            draft_text = draft_text.replace("**Source:** Questions/final_2023.txt", "**Source**: Questions/final_2023.txt")
        elif variant == "wrong_paper":
            draft_text = draft_text.replace("**Source:** Questions/final_2023.txt", "**Source:** Questions/final_2024.txt")
        elif variant == "bad_options_and_document":
            draft_text = draft_text.replace("No MCQs.", "### MCQ 1 **[IMP]**\n**Question:** Short stem?\n**Options:**\na. First\nb. Second\n**Correct Answer:** c. Missing\n**Clinical Explanation:** شرح")
            draft_text += "\n## Unexpected section\n"
    draft = root / "Transcripts" / "Conjunctiva 👁️.md.draft.md"
    draft.write_text(draft_text, encoding="utf-8")
    staged = root / ".transcriber-cache" / "staged-drafts" / draft.name
    staged.mkdir(parents=True)
    split = draft_text.index(SECTION_HEADINGS[1])
    (staged / "part-1.md").write_text(draft_text[:split], encoding="utf-8")
    (staged / "part-2.md").write_text(draft_text[split:], encoding="utf-8")
    (staged / "parts.txt").write_text("2", encoding="utf-8")
    before = {path.name: path.read_bytes() for path in staged.iterdir()}
    catalog = assessment_catalog(root, manifest)
    years = set(engine._year_map_from_catalog(catalog))
    findings = engine.pre_finalize_errors(draft_text, years, manifest["exam_style_profile"], catalog)
    checks = {**arguments, "draft": str(draft), "transcript": str(draft)}
    from question_provenance import final_provenance_errors, repair_provenance_badges

    repaired, corrections = repair_provenance_badges(draft_text, catalog)
    repaired_findings = engine.pre_finalize_errors(repaired, years, manifest["exam_style_profile"], catalog)
    if variant == "repaired":
        assert not findings
    else:
        assert findings
        with pytest.raises(engine.ValidationError) as finalization:
            engine.finalize_student_document(draft_text, years, manifest["exam_style_profile"], catalog)
        for finding in findings:
            assert finding in str(finalization.value)
    if variant in {"missing_source", "wrong_paper"}:
        assert any("missing_source" in error or "source_year_mismatch" in error for error in final_provenance_errors(draft_text, catalog))
        assert corrections
        assert short["stem"] in repaired
        assert "**[Past Exams - 2023]**" in repaired
        assert re.search(r"\*\*Source:\*\* (?:Questions/)?final_2023\.txt", repaired)
        assert "Questions/final_2024.txt" not in repaired
    if repaired_findings:
        with pytest.raises(mcp_server.ToolError) as validation:
            mcp_server._validate_draft(checks, tmp_path)
        for finding in repaired_findings:
            assert finding in str(validation.value)
        assert "Section 4" in str(validation.value) or variant == "bad_options_and_document"
        if variant == "incident":
            assert "Section 3" in str(validation.value)
            assert "observed exam length" in str(validation.value)
            assert "clinical-vignette" in str(validation.value)
    else:
        assert "passes every check" in mcp_server._validate_draft(checks, tmp_path)
    assert "Every year badge is backed" in mcp_server._verify_provenance(checks, tmp_path)
    assert draft.read_text(encoding="utf-8") == repaired
    assert final_provenance_errors(repaired, catalog) == []
    assert {path.name: path.read_bytes() for path in staged.iterdir()} == before


@pytest.mark.parametrize("separator", ["\n**Source:** ", "; "])
def test_discovery_source_lines_pass_both_gates_and_finalize_for_multiple_papers(ophtha, tmp_path, separator):
    import universal_transcribe as engine
    from question_provenance import assessment_catalog

    root, arguments, found = ophtha
    entry = next(entry for entry in found["entries"] if entry["years"] == [2023, 2024])
    sources = entry["source_lines"]
    assert len(sources) == 3
    draft_text = SECTION_HEADINGS[0] + "\n\nشرح.\n\n" + _questions_part([entry])
    old = "**Source:** " + "; ".join(paper["path"] for paper in entry["source_papers"])
    source_field = "**Source:** " + separator.join(line.removeprefix("**Source:** ") for line in sources)
    draft_text = draft_text.replace(old, source_field)
    draft = root / "Transcripts" / "Conjunctiva 👁️.md.draft.md"
    draft.write_text(draft_text, encoding="utf-8")
    checks = {**arguments, "draft": str(draft), "transcript": str(draft)}
    assert "passes every check" in mcp_server._validate_draft(checks, tmp_path)
    assert "Every year badge is backed" in mcp_server._verify_provenance(checks, tmp_path)
    manifest = json.loads(Path(arguments["manifest_path"]).read_text(encoding="utf-8"))
    finalized = engine.finalize_student_document(draft_text, {2023, 2024}, manifest["exam_style_profile"], assessment_catalog(root, manifest))
    assert "**Source:**" not in finalized
    assert entry["stem"] in finalized


def test_compiled_bank_badges_use_question_years_in_all_three_checks(ophtha, tmp_path):
    import universal_transcribe as engine
    from question_provenance import assessment_catalog, assessment_verified_years

    root, arguments, found = ophtha
    manifest_path = Path(arguments["manifest_path"])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["assessment_sources"] = [source for source in manifest["assessment_sources"] if source["path"] == "Questions/Combined_2026.txt"]
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    entry = next(entry for entry in found["entries"] if "complications" in entry["stem"])
    draft_text = SECTION_HEADINGS[0] + "\n\nشرح.\n\n" + _questions_part([entry])
    draft = root / "Transcripts" / "Conjunctiva 👁️.md.draft.md"
    draft.write_text(draft_text, encoding="utf-8")
    assert "passes every check" in mcp_server._validate_draft({**arguments, "draft": str(draft)}, tmp_path)
    assert "Every year badge is backed" in mcp_server._verify_provenance({**arguments, "transcript": str(draft)}, tmp_path)
    catalog = assessment_catalog(root, manifest)
    assert assessment_verified_years(catalog) == {2023}
    assert entry["stem"] in engine.finalize_student_document(draft_text, {2023}, manifest["exam_style_profile"], catalog)


def test_sourced_case_scenario_is_checked_by_all_three_gates(ophtha, tmp_path):
    import universal_transcribe as engine
    from question_provenance import assessment_catalog, assessment_verified_years

    root, arguments, found = ophtha
    entry = next(entry for entry in found["entries"] if entry["stem"] == "Palpebral conjunctiva")
    draft_text = SECTION_HEADINGS[0] + "\n\nشرح.\n\n" + _questions_part([])
    draft_text = draft_text.replace("No clinical cases.", f"### Clinical Case 1 {entry['badge']}\n**Scenario:** {entry['stem']}\n{entry['source_lines'][0]}\n**Model Answer:** Tarsal adherence\n**Clinical Explanation:** شرح.")
    draft = root / "Transcripts" / "Conjunctiva 👁️.md.draft.md"
    draft.write_text(draft_text, encoding="utf-8")
    assert "passes every check" in mcp_server._validate_draft({**arguments, "draft": str(draft)}, tmp_path)
    assert "Every year badge is backed" in mcp_server._verify_provenance({**arguments, "transcript": str(draft)}, tmp_path)
    manifest = json.loads(Path(arguments["manifest_path"]).read_text(encoding="utf-8"))
    catalog = assessment_catalog(root, manifest)
    finalized = engine.finalize_student_document(draft_text, assessment_verified_years(catalog), manifest["exam_style_profile"], catalog)
    assert "**Scenario:** Palpebral conjunctiva" in finalized
    assert "**Source:**" not in finalized


@pytest.mark.parametrize("case_format", ["markdown", "quoted", "legacy_tip"])
def test_redo_with_guide_tip_preserves_sections_during_validation(ophtha, tmp_path, monkeypatch, case_format):
    """Critical-thinking redo: an ordinary guide TIP swallowed sections 2–5."""
    import universal_transcribe as engine

    root, arguments, _ = ophtha
    final = root / "Transcripts" / "Conjunctiva 👁️.md"
    final.write_text("# Existing transcript\n", encoding="utf-8")
    draft = final.with_name(final.name + ".draft.md")
    draft.write_text("Previous draft", encoding="utf-8")
    monkeypatch.setenv("TRANSCRIBER_AGY", "off")
    begun = json.loads(mcp_server._begin_lecture({
        "module": "ophtha", "lecture": "Conjunctiva", "redo": True,
    }, tmp_path))
    arguments["manifest_path"] = begun["manifest_path"]
    _stage_guide(tmp_path, root, arguments)
    context = mcp_server._resolve_draft_context(arguments, tmp_path)
    first = mcp_server._staged_part_path(context, 1)
    tip = "> [!TIP]\n> الدكتور بيوضح مثال إكلينيكي في الدليل الزمني.\n\n"
    first.write_text(first.read_text(encoding="utf-8") + tip, encoding="utf-8")
    cases = []
    for number in (1, 2):
        case = (
            f"### Clinical Case {number} **[IMP]**\n"
            "**Scenario:** A patient has conjunctival inflammation.\n"
            "**Questions:** Diagnosis?\n**Model Answer:** Conjunctivitis\n"
            "**Clinical Explanation:** الدكتور بيوضح الحالة بالتفصيل.\n"
        )
        if case_format == "legacy_tip":
            case = case.replace(f"### Clinical Case {number}", f"**🩺 Clinical Case {number}:**")
        if case_format != "markdown":
            case = "\n".join("> " + line for line in case.splitlines()) + "\n"
        if case_format == "legacy_tip":
            case = "> [!TIP]\n" + case
        cases.append(case)
    assessment = _questions_part([]).replace("No clinical cases.", "\n".join(cases))
    mcp_server._stage_draft_part({
        **arguments, "part": 10, "parts": 10, "content": assessment,
    }, tmp_path)
    mcp_server._apply_review({**arguments, "from_parts": True, "confirmed": True}, tmp_path)
    draft_text = draft.read_text(encoding="utf-8")
    assert not engine._section_structure_errors(draft_text)
    assert "passes every check" in mcp_server._validate_draft({**arguments, "draft": draft.name}, tmp_path)
    finalized = engine.finalize_student_document(draft_text, set())
    assert finalized.split(SECTION_HEADINGS[1])[0] == engine._student_document_from_draft(draft_text).split(SECTION_HEADINGS[1])[0]
    assert tip in finalized
    assert not engine._section_structure_errors(finalized)
    assert finalized.count("### Clinical Case ") == 1
    assert "Conjunctivitis" in finalized
    assert final.read_text(encoding="utf-8") == "# Existing transcript\n"
    assert [path.read_text(encoding="utf-8") for path in (root / ".transcriber-cache/previous-drafts").rglob("draft-*")] == ["Previous draft"]


def test_register_warning_points_to_worst_part_and_allows_finalize(ophtha, tmp_path, capsys):
    """The agy MSA opening must warn during both validate_draft and finalize."""
    import universal_transcribe as engine
    from question_provenance import assessment_catalog, assessment_verified_years

    root, arguments, found = ophtha
    entry = next(entry for entry in found["entries"] if entry["stem"] == "Palpebral conjunctiva")
    parts = [
        SECTION_HEADINGS[0] + "\n" + "الدكتور بيوضح إن ده مهم عشان مش حفظ.\n" * 45,
        "أوضح الدكتور أهمية الفحص وأكد ضرورة العلاج.\n" * 4,
        _questions_part([entry]),
    ]
    draft = root / "Transcripts" / "Conjunctiva 👁️.md.draft.md"
    draft_text = "".join(parts)
    draft.write_text(draft_text, encoding="utf-8")
    directory = root / ".transcriber-cache/staged-drafts" / draft.name
    directory.mkdir(parents=True)
    for number, part in enumerate(parts, 1):
        (directory / f"part-{number}.md").write_text(part, encoding="utf-8")
    manifest = json.loads(Path(arguments["manifest_path"]).read_text())
    catalog = assessment_catalog(root, manifest)
    years = assessment_verified_years(catalog)
    assert not engine.pre_finalize_errors(draft_text, years, manifest["exam_style_profile"], catalog)
    warning = engine.pre_finalize_warnings(draft_text, draft)[0]
    assert "Section 1 (📖 Chronological Guide), re-send part 2" in warning
    validation = mcp_server._validate_draft({**arguments, "draft": str(draft)}, tmp_path)
    assert warning in validation and "[WARNING]" in validation
    assert "passes every check" in validation
    finalized = engine.finalize_student_document(draft_text, years, manifest["exam_style_profile"],
                                                 catalog, transcript=draft)
    assert warning in capsys.readouterr().out
    assert parts[1] in finalized
    assert draft.read_text() == draft_text
    # Stale staged parts must never recommend replacing an unrelated part.
    (directory / "part-1.md").write_text("stale", encoding="utf-8")
    assert "re-send part" not in engine.pre_finalize_warnings(draft_text, draft)[0]
