"""Independent assessment checkpoints under the Addiction prompt-size workload."""
import json
import re
import sys
from pathlib import Path
from threading import Barrier, Lock

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

import agy_writer
import mcp_server
from assessment_parts import HEADINGS, section_prompts
from lecture_emphasis import COVERAGE_SCHEMA, compact_points, ledger_path, read_ledger
from question_prompts import IMP_EMPTY_NOTICES, IMP_HEADINGS, _emphasis_minimum
from test_agy_writer import fake_agy as fake_agy
from test_agy_writer import lecture as lecture
from test_agy_writer import write_all


def _imp(points):
    categories = ("key_points", "class_questions", "warnings", "course_instructions", "exam_flagged")
    groups = []
    for index, category in enumerate(categories):
        rows = []
        for point in points:
            if point["category"] != category:
                continue
            if category == "warnings":
                rows.append("> [!WARNING]\n> " + point["quote"])
            elif category == "class_questions":
                rows.append("- **Q:** " + point["quote"] + " **Answer:** " + point.get("answer_quote", "Answer (مش مذكورة في المحاضرة)") + " «" + point["quote"] + "»")
            else:
                rows.append("- " + point["quote"])
        groups.append(IMP_HEADINGS[index] + "\n" + ("\n".join(rows) or IMP_EMPTY_NOTICES[index]))
    return HEADINGS[0] + "\n" + "\n".join(groups) + "\n"


def _question(section, number, stem, sourced=False):
    kind = ("", "MCQ", "Question", "Clinical Case")[section]
    badge = "**[Past Exams - 2023]**" if sourced else "**[IMP]**"
    fields = ("**Question:** " + stem + "\n**Options:**\na. Burns\nb. Fever\nc. Cough\nd. Rash\n**Correct Answer:** a. Burns\n" if section == 1
              else "**Question:** " + stem + "\n**Model Answer:**\n- Burns\n" if section == 2
              else "**Scenario:** " + stem + "\n**Questions:**\n1. Diagnosis?\n**Model Answer:**\n1. Burns\n")
    return f"### {kind} {number} {badge}\n" + fields + "**Clinical Explanation:** الدكتور شرح النقطة دي.\n" + ("**Source:** Questions/Final 2023.txt\n" if sourced else "")


def test_addiction_71_points_are_written_and_reviewed_in_bounded_phases(lecture, monkeypatch):
    import nlm_client

    workspace, root, arguments = lecture
    # The owner incident had 71 points, including 39 class questions, with a large no-key bank.
    categories = ["class_questions"] * 39 + ["key_points"] * 22 + ["warnings"] * 7 + ["course_instructions"] * 2 + ["exam_flagged"]
    points = [{"quote": f"Corrosives important point {i}.", "emphasis_quote": f"Corrosives important point {i}.",
               "explanation": "Doctor stressed this medical point. " * 12, "category": category,
               "answer_quote": f"Corrosives important point {i}."} for i, category in enumerate(categories)]
    speech = "\n\n".join(point["quote"] for point in points)
    (root / "Verbatim/Corrosives.verbatim.md").write_text(speech)
    # Build real index data, with fifty in-scope no-key MCQs.
    from agy_index_fixtures import write_agy_index
    from exam_index import write_index
    paper = root / "Questions/Final 2023.txt"
    paper.write_text("\n\n".join(f"{i}. Corrosives cause {i}:\na. Burns\nb. Fever\nc. Cough\nd. Rash" for i in range(50)))
    index = write_agy_index(root / "Questions", "toxo")
    write_index(index, root / "Questions")
    manifest = json.loads(Path(arguments["manifest_path"]).read_text())
    manifest["write_part_bytes"] = 100000
    Path(arguments["manifest_path"]).write_text(json.dumps(manifest))
    budget = 16000
    monkeypatch.setattr(nlm_client, "load_config", lambda: {"emphasis_prompt_chars": budget, "emphasis_segment_chars": 4000, "lecture_writer_workers": 3})
    sizes, phases = [], []
    generated = {1: 0, 2: 0, 3: 0}
    lock = Lock()
    def json_model(prompt, schema, **_kwargs):
        with lock:
            sizes.append(len(prompt))
        if "Extract EVERY" in prompt:
            return {"points": [point for point in points if point["quote"] in prompt.split("SPOKEN SEGMENT:\n")[1]]}
        if schema == COVERAGE_SCHEMA:
            raw = prompt.split("SPOKEN EMPHASIS LEDGER:\n")[1]
            raw_points, raw = raw.split("\nSECTION 2:\n")
            section, blocks = raw.split("\nQUESTIONS BY FINGERPRINT:\n")
            batch = json.loads(raw_points)
            return {"sections": [{"point_id": point["id"], "quote": point["quote"]} for point in batch if point["quote"] in section],
                    "questions": [{"fingerprint": key, "point_ids": [point["id"] for point in batch if point["quote"] in block]} for key, block in json.loads(blocks).items()],
                    "unsupported_section2": []}
        return {"topics": []}
    def writer(prompt, *_args, **_kwargs):
        if "PHASE OUTPUT:" in prompt or "SPOKEN EMPHASIS LEDGER:\n" in prompt:
            with lock:
                sizes.append(len(prompt))
        if "Create only the body of the 🌟 IMP" in prompt and "PHASE OUTPUT:" not in prompt:
            batch = json.loads(prompt.split("SPOKEN EMPHASIS LEDGER:\n")[1])
            phases.append(0)
            assert all(set(point) <= {"id", "category", "quote", "explanation", "answer_quote"} for point in batch)
            return agy_writer.WrittenPart(_imp(batch), 0)
        if "PHASE OUTPUT:" in prompt:
            section = next(i for i in (1, 2, 3) if "Return ONLY " + HEADINGS[i] in prompt)
            context = mcp_server._resolve_draft_context(arguments, workspace)
            assert mcp_server._staged_part_path(context, 2).is_file()
            batch = json.loads(prompt.split("SPOKEN EMPHASIS LEDGER (the only authority for Section 2 and IMP):\n")[1].split("\n\n")[0])
            entries = json.loads(prompt.split("FIND_QUESTIONS ENTRIES:\n")[1].split("\n\nGUIDE HEADINGS:")[0])["entries"]
            count = int(re.search(r"Generate at least (\d+) additional", prompt)[1])
            with lock:
                phases.append(section)
                generated[section] += count
            body = "".join(_question(section, i + 1, entry["stem"], True) for i, entry in enumerate(entries))
            body += "".join(_question(section, i + 1, batch[0]["quote"] + f" test {i}") for i in range(count))
            return agy_writer.WrittenPart(HEADINGS[section] + "\n" + body, 0)
        return agy_writer.WrittenPart("## 📖 Chronological Guide\n### Corrosives\n" + speech + "\n\n", 0)
    monkeypatch.setattr(agy_writer, "request_json", json_model)
    monkeypatch.setattr(agy_writer, "write", writer)
    report = write_all(lecture)
    assert report["error"] is None, report
    assert report["total_parts"] == 5 and report["missing_parts"] == []
    assert max(sizes) <= budget
    assert phases.index(1) > phases.index(0) and phases.index(2) > phases.index(0) and phases.index(3) > phases.index(0)
    context = mcp_server._resolve_draft_context(arguments, workspace)
    ledger = read_ledger(ledger_path(context.path))
    assert len(ledger["points"]) == len(ledger["section_points"]) == 71
    assert len([phase for phase in phases if phase == 0]) > 1
    assert len([phase for phase in phases if phase == 1]) > 1
    # 30 key points, warnings and exam-flagged points ask each section for max(3, min(12, 30 // 6)).
    assert generated == {1: 5, 2: 5, 3: 5}
    before = list(sizes)
    assert write_all(lecture)["staged"] == []
    assert sizes == before


@pytest.mark.parametrize("n,expected", [(0, 0), (1, 1), (2, 2), (3, 3), (30, 5), (71, 11), (100, 12)])
def test_proportional_question_count(n, expected):
    assert _emphasis_minimum(n) == expected


def test_class_questions_do_not_generate_assessments():
    points = [{"id": "q1", "category": "class_questions", "quote": "Question?", "explanation": "Answer"}]
    prompts = section_prompts(1, points, [], lambda points, entries, count: json.dumps([points, entries, count]), 1000)
    assert prompts == ["[[], [], 0]"]


def test_assessments_run_concurrently_and_continue_only_retries_failed_section(lecture, fake_agy, monkeypatch):
    workspace, _, arguments = lecture
    barrier = Barrier(3, timeout=10)
    entered = []
    original_write = agy_writer.write
    fail = True
    def writer(prompt, *args, **kwargs):
        if "PHASE OUTPUT:" in prompt:
            section = next(i for i in (1, 2, 3) if "Return ONLY " + HEADINGS[i] in prompt)
            context = mcp_server._resolve_draft_context(arguments, workspace)
            assert mcp_server._staged_part_path(context, 4).is_file()  # Three guide parts, then IMP.
            entered.append(section)
            if fail:
                barrier.wait()
                if section == 2:
                    raise agy_writer.AgyWriterError("writer unavailable")
        return original_write(prompt, *args, **kwargs)
    monkeypatch.setattr(agy_writer, "write", writer)
    report = write_all(lecture)
    assert report["failed_part"] == report["total_parts"] - 1, report
    assert sorted(entered) == [1, 2, 3]
    context = mcp_server._resolve_draft_context(arguments, workspace)
    directory = mcp_server._staged_draft_directory(context)
    retained = {path: path.read_bytes() for path in directory.glob("part-*.md")}
    ledger_before = (directory / "emphasis.json").read_bytes()
    fail = False
    entered.clear()
    before = len(fake_agy.read_text().splitlines())
    resumed = write_all(lecture)
    assert resumed["error"] is None and len(resumed["staged"]) == 1, resumed
    assert entered == [2]
    assert {path: path.read_bytes() for path in retained} == retained
    assert json.loads((directory / "emphasis.json").read_bytes())["segments"] == json.loads(ledger_before)["segments"]
    calls = [json.loads(line)["prompt"] for line in fake_agy.read_text().splitlines()[before:]]
    assert not any("VERBATIM SEGMENT" in prompt or "Extract EVERY" in prompt for prompt in calls)


def test_two_part_draft_resumes_without_rewriting_retained_guide_or_extracting(lecture, fake_agy):
    import hashlib

    workspace, _, arguments = lecture
    manifest = Path(arguments["manifest_path"])
    manifest.write_text(json.dumps({**json.loads(manifest.read_text()), "write_part_bytes": 100000}))
    first = write_all(lecture)
    assert first["error"] is None and first["total_parts"] == 5
    job = mcp_server._agy_draft_context(arguments, workspace)
    directory = mcp_server._staged_draft_directory(job.draft)
    retained = mcp_server._staged_part_path(job.draft, 1).read_bytes()
    combined = "".join(mcp_server._staged_part_path(job.draft, number).read_text() for number in range(2, 6))
    mcp_server._staged_part_path(job.draft, 2).write_text(combined)
    for number in range(3, 6):
        mcp_server._staged_part_path(job.draft, number).unlink()
    layout = json.loads((directory / "layout.json").read_text())
    layout.pop("assessment_sections")
    layout["parts"] = 2
    (directory / "layout.json").write_text(json.dumps(layout))
    (directory / "parts.txt").write_text("2")
    (directory / "questions-evidence.json").write_text(json.dumps({"key": mcp_server._questions_evidence_key(job), "content_sha256": hashlib.sha256(combined.encode()).hexdigest()}))
    before = fake_agy.read_bytes()
    resumed = write_all(lecture)
    assert resumed["error"] is None and resumed["staged"] == [] and resumed["total_parts"] == 5, resumed
    assert mcp_server._staged_part_path(job.draft, 1).read_bytes() == retained
    assert fake_agy.read_bytes() == before


@pytest.mark.parametrize("failure", ["missing", "unsupported"])
@pytest.mark.parametrize("succeeds", [False, True])
@pytest.mark.parametrize("requested", [False, True])
def test_imp_section_has_one_corrective_retry(lecture, fake_agy, monkeypatch, failure, succeeds, requested):
    from test_lecture_emphasis import POINT, SPOKEN

    workspace, root, arguments = lecture
    (root / "Verbatim/Corrosives.verbatim.md").write_text(SPOKEN)
    job = mcp_server._agy_draft_context(arguments, workspace)
    for part in range(1, len(job.segments) + 1):
        mcp_server._agy_stage_part(job, part)
    audits, writes = [], []
    def json_model(prompt, *_args, **_kwargs):
        if "Extract EVERY" in prompt:
            return {"points": [POINT]}
        audits.append(prompt)
        ledger = read_ledger(ledger_path(job.draft.path))
        if succeeds and len(audits) == 2:
            return {"sections": [{"point_id": ledger["points"][0]["id"], "quote": POINT["quote"]}], "questions": [], "unsupported_section2": []}
        return {"sections": [], "questions": [], "unsupported_section2": ["Slide-only claim"] if failure == "unsupported" else []}
    def writer(prompt, *_args, **_kwargs):
        writes.append(prompt)
        ledger = read_ledger(ledger_path(job.draft.path))
        return agy_writer.WrittenPart(_imp(compact_points(ledger["points"])), 0)
    monkeypatch.setattr(agy_writer, "request_json", json_model)
    monkeypatch.setattr(agy_writer, "write", writer)
    part = len(job.segments) + 1
    if requested:
        try:
            report = json.loads(mcp_server._write_requested_agy_parts(job, [part]))
        except mcp_server.ToolError as error:
            report = json.loads(str(error))
        assert (report["failed_part"] is None) == succeeds
        assert report["error"] is None if succeeds else report["error"].startswith("ASSESSMENT_SECTION_FAILED: ")
    elif succeeds:
        assert mcp_server._agy_stage_part(job, part)["retried"]
    else:
        with pytest.raises(mcp_server.ToolError, match="ASSESSMENT_SECTION_FAILED"):
            mcp_server._agy_stage_part(job, part)
    assert len(writes) == len(audits) == 2
    point = read_ledger(ledger_path(job.draft.path))["points"][0]
    correction = writes[1].split("CORRECTIVE SPOKEN EMPHASIS AUDIT:\n")[1]
    assert point["id"] in correction and POINT["quote"] in correction
    assert ("Slide-only claim" in correction) == (failure == "unsupported")
    assert mcp_server._staged_part_path(job.draft, part).is_file() == succeeds


def test_sourced_written_patient_scenario_is_routed_to_cases_without_index_edits():
    from assessment_parts import assessment_kind
    entry = {"kind": "written", "stem": "A patient presented with corrosive poisoning. What is the treatment?"}
    assert assessment_kind(entry) == "case"
    assert entry["kind"] == "written"
    assert assessment_kind({"kind": "written", "stem": "List complications of corrosives."}) == "written"


def test_review_edits_to_guide_parts_keep_accepted_assessments_for_later_writes(lecture, fake_agy):
    workspace, _, arguments = lecture
    manifest = Path(arguments["manifest_path"])
    manifest.write_text(json.dumps({**json.loads(manifest.read_text()), "write_part_bytes": 100000}))
    first = write_all(lecture)
    assert first["error"] is None and first["total_parts"] == 5, first
    context = mcp_server._resolve_draft_context(arguments, workspace)
    guide = mcp_server._staged_part_path(context, 1)
    # Review-time slide placement edits guide bytes after the sections' receipts were written.
    guide.write_text(guide.read_text() + "\nReview placed this paragraph beside its slide.\n\n")
    mcp_server._apply_review({**arguments, "from_parts": True}, workspace)
    sections = {number: mcp_server._staged_part_path(context, number).read_bytes() for number in range(2, 6)}
    before = fake_agy.read_bytes()
    resumed = write_all(lecture)
    assert resumed["error"] is None and resumed["staged"] == [], resumed
    assert {number: mcp_server._staged_part_path(context, number).read_bytes() for number in range(2, 6)} == sections
    assert fake_agy.read_bytes() == before


def test_assessment_sections_in_a_guide_part_are_cut_when_staged_and_when_recovered(lecture, fake_agy, monkeypatch):
    workspace, _, arguments = lecture
    manifest = Path(arguments["manifest_path"])
    manifest.write_text(json.dumps({**json.loads(manifest.read_text()), "write_part_bytes": 100000}))
    original_write = agy_writer.write
    extra = "## 🌟 IMP Points\n- invented\n\n## ❓ MCQs\n### MCQ 1 **[IMP]**\n**Question:** Invented?\n"
    def writer(prompt, *args, **kwargs):
        written = original_write(prompt, *args, **kwargs)
        if "PHASE OUTPUT:" in prompt or "Extract EVERY" in prompt:
            return written
        return agy_writer.WrittenPart(written.text + "\n\n" + extra, written.seconds)
    monkeypatch.setattr(agy_writer, "write", writer)
    first = write_all(lecture)
    assert first["error"] is None and first["total_parts"] == 5, first
    context = mcp_server._resolve_draft_context(arguments, workspace)
    guide = mcp_server._staged_part_path(context, 1)
    assert "## 🌟 IMP Points" not in guide.read_text()
    # A guide staged by an earlier build keeps its sections until recovery cuts them.
    guide.write_text(guide.read_text() + extra)
    sections = {number: mcp_server._staged_part_path(context, number).read_bytes() for number in range(2, 6)}
    mcp_server._recover_staged_parts(context)
    assert "## 🌟 IMP Points" not in guide.read_text()
    before = fake_agy.read_bytes()
    resumed = write_all(lecture)
    assert resumed["error"] is None and resumed["staged"] == [], resumed
    assert {number: mcp_server._staged_part_path(context, number).read_bytes() for number in range(2, 6)} == sections
    assert fake_agy.read_bytes() == before
