"""Exercise the writer boundary with a real executable and temporary module data."""

import io
import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

import agy_writer
import mcp_server
from exam_index import build_index, write_index
from lecture_registry import set_general_materials
from module_organization import PROPOSAL_SCHEMA
from module_registry import load_module


@pytest.fixture
def lecture(tmp_path, monkeypatch):
    root = tmp_path / "modules/toxo"
    for directory in ("Lecture", "Questions", "Transcripts", "Verbatim"):
        (root / directory).mkdir(parents=True)
    (root / "module.json").write_text(json.dumps({
        "schema_version": 1, "module_id": "toxo", "display_name": "Toxicology",
        "notebook": {"id": "test-notebook", "title": "Toxicology", "profile": None},
        "output": {"emoji": "🧪", "language": "Egyptian Arabic"},
    }))
    (root / "Lecture/Corrosives.mp3").write_bytes(b"fixture")
    (root / "Verbatim/Corrosives.verbatim.md").write_text(
        "# Corrosives\n\n" + "Corrosives cause burns. Explain the clinical treatment fully.\n\n" * 25,
    )
    (root / "Questions/Final 2023.txt").write_text(
        "1. Corrosives cause:\na. Burns\nb. Fever\nc. Cough\nd. Rash\n",
    )
    write_index(build_index(root / "Questions", "toxo"), root / "Questions")
    manifest = root / ".transcriber-cache/test-manifest.json"
    manifest.parent.mkdir()
    manifest.write_text(json.dumps({
        "title": "Corrosives", "recording_sources": ["Corrosives.mp3"],
        "write_part_bytes": 600, "read_part_bytes": 30000,
        "exam_style_profile": {"mcq": {"options": {"count": 4}}},
    }))
    monkeypatch.delenv("TRANSCRIBER_AGY", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("PATH", str(tmp_path / "bin"))
    return tmp_path, root, {"module": "toxo", "manifest_path": str(manifest)}


@pytest.fixture
def fake_agy(lecture, monkeypatch):
    workspace, _, _ = lecture
    binary = workspace / "bin/agy"
    binary.parent.mkdir()
    log = workspace / "agy-calls.jsonl"
    monkeypatch.setenv("AGY_LOG", str(log))
    binary.write_text(f"#!{sys.executable}\n" + r'''
import json, os, pathlib, sys, time
if sys.argv[1:] == ["--version"]:
    print("agy 1.0")
    sys.exit(0)
if sys.argv[1:] == ["models"]:
    if os.environ.get("AGY_MODELS_FAIL"):
        print("authentication unavailable", file=sys.stderr)
        sys.exit(1)
    print("gemini-3.8-flash-high\ngemini-test")
    sys.exit(0)
prompt = sys.argv[sys.argv.index("-p") + 1]
assert "--input-format" not in sys.argv
files = list(pathlib.Path.cwd().iterdir())
if files:
    assert [path.name for path in files] == ["prompt.md"]
    assert "Read the file prompt.md" in prompt and "all of it to the end" in prompt
    assert "do not run shell commands" in prompt
    prompt = files[0].read_text(encoding="utf-8")
    assert "The only permitted tool use is reading prompt.md" in prompt
    assert "Do not use any tools, do not read or write files" not in prompt
assert "--disable-slash-commands" in sys.argv
assert "--dangerously-skip-permissions" not in sys.argv
assert sys.argv[sys.argv.index("--output-format") + 1] == "json"
with open(os.environ["AGY_LOG"], "a") as stream:
    stream.write(json.dumps({"prompt": prompt, "model": sys.argv[sys.argv.index("--model") + 1], "cwd": str(pathlib.Path.cwd())}) + "\n")
mode = os.environ.get("AGY_MODE", "happy")
if mode == "permission":
    print("no output produced — a tool required the command permission", file=sys.stderr)
    sys.exit(1)
if mode == "exit":
    print("authentication expired", file=sys.stderr)
    sys.exit(2)
if mode == "timeout":
    time.sleep(10)
if mode == "invalid":
    print("not JSON")
    sys.exit(0)
if os.environ.get("AGY_JSON_RESPONSE"):
    text = pathlib.Path(os.environ["AGY_JSON_RESPONSE"]).read_text(encoding="utf-8")
    print(json.dumps({"status": "SUCCESS", "response": text}))
    sys.exit(0)
segment = prompt.split("VERBATIM SEGMENT", 1)[-1] if "VERBATIM SEGMENT" in prompt else ""
opening = "## 📖 Chronological Guide\n" if "(part 1 of" in segment else ""
text = opening + "### Corrosives\n" + segment if segment else "## 🌟 IMP Points\n## ❓ MCQs\n## ✍️ Written Questions\n## 🩺 Clinical Cases\n"
if mode == "short-always" or (mode == "short" and "Your previous answer had" not in prompt):
    text = "tiny"
if mode == "empty":
    text = ""
if mode == "repeated-heading" and segment and not opening:
    text = "## 📖 Chronological Guide\n" + text
print(json.dumps({"status": "FAILED" if mode == "status" else "SUCCESS", "response": text, "structured_output": {"guide": "truncated"}}))
''')
    binary.chmod(0o755)
    return log


def write_all(lecture, **extra):
    workspace, _, arguments = lecture
    try:
        output = mcp_server._write_parts_with_agy({**arguments, **extra}, workspace)
    except mcp_server.ToolError as error:
        output = str(error)
    return json.loads(output)


@pytest.mark.parametrize("size, guarded", [(60_000, True), (60_001, True), (60_001, False)])
def test_prompt_delivery_keeps_all_evidence_and_uses_file_only_above_byte_limit(monkeypatch, size, guarded):
    prefix = agy_writer.NO_TOOLS + "\n" if guarded else ""
    suffix = "\nSECRET-AT-THE-END"
    padding = size - len((prefix + suffix).encode("utf-8"))
    prompt = prefix + "غ" * (padding // 2) + "x" * (padding % 2) + suffix
    directories = []

    def fake_run(command, **kwargs):
        directory = Path(kwargs["cwd"])
        directories.append(directory)
        argument = command[command.index("-p") + 1]
        assert "--input-format" not in command and "input" not in kwargs
        if size <= 60_000:
            assert argument == prompt and not list(directory.iterdir())
        else:
            assert argument == agy_writer.FILE_READ_PROMPT and prompt not in command
            content = (directory / "prompt.md").read_text(encoding="utf-8")
            expected = prompt.replace(agy_writer.NO_TOOLS_RULE, agy_writer.FILE_READ_RULE) if guarded else agy_writer.FILE_READ_RULE + "\n\n" + prompt
            assert content == expected and content.endswith(suffix)
            assert agy_writer.NO_TOOLS_RULE not in content
        return subprocess.CompletedProcess(command, 0, json.dumps({"status": "SUCCESS", "response": "written"}), "")

    monkeypatch.setattr(subprocess, "run", fake_run)
    assert agy_writer._invoke(prompt, "{}", agy_writer.Invocation("fake-agy")) == "written\n\n"
    assert all(not directory.exists() for directory in directories)


def test_all_parts_stage_and_resume_without_rewriting(lecture, fake_agy):
    first = write_all(lecture, model="gemini-test")
    assert first["error"] is None
    assert first["received_parts"] == list(range(1, first["total_parts"] + 1))
    assert all(part["chars"] >= part["required_chars"] for part in first["staged"])
    assert "apply_review" in first["next"]
    assert "Ask the student" not in first["next"]
    assert "verify_provenance" in first["next"] and "finalize(confirmed=true)" in first["next"]
    assert "content" not in json.dumps(first)
    workspace, _, arguments = lecture
    context = mcp_server._resolve_draft_context(arguments, workspace)
    staged_directory = mcp_server._staged_draft_directory(context)
    assert json.loads((staged_directory / "layout.json").read_text())["alignment"] == "write"
    part_one = (staged_directory / "part-1.md").read_text()
    assert "truncated" not in part_one
    saved = json.loads(mcp_server._apply_review({**arguments, "from_parts": True}, workspace))
    assert saved["chars"] > 0 and "content" not in saved
    before = fake_agy.read_text()
    assert write_all(lecture)["staged"] == []
    assert fake_agy.read_text() == before
    replacement = write_all(lecture, parts=[1], model="gemini-test")
    assert [part["part"] for part in replacement["staged"]] == [1]
    calls = [json.loads(line) for line in fake_agy.read_text().splitlines()]
    assert all(call["model"] == "gemini-test" for call in calls)
    assert all(not Path(call["cwd"]).exists() for call in calls)


def test_short_answer_retries_then_stages_complete_segment(lecture, fake_agy, monkeypatch):
    monkeypatch.setenv("AGY_MODE", "short")
    completed = write_all(lecture, parts=[1])
    assert completed["error"] is None
    assert completed["staged"][0]["retried"] is True
    assert completed["staged"][0]["chars"] >= completed["staged"][0]["required_chars"]
    retry = json.loads(fake_agy.read_text().splitlines()[-1])["prompt"].split("Your previous answer had", 1)[1]
    assert "doctor's missing spoken points" in retry
    assert "Do not add slide or textbook content to reach the length" in retry


def test_multi_recording_slide_plan_stages_scopes_and_recovers_saved_parts(lecture, fake_agy):
    from phase_validation import SECTION_HEADINGS

    workspace, root, arguments = lecture
    sources = [f"Shock {cohort} part {part}.m4a" for cohort in ("boys", "girls") for part in (1, 2)]
    for index, source in enumerate(sources):
        (root / "Lecture" / source).write_bytes(b"audio")
        (root / "Verbatim" / (Path(source).stem + ".verbatim.md")).write_text(f"spoken{index} " * 3675)
    manifest = Path(arguments["manifest_path"])
    payload = json.loads(manifest.read_text())
    payload.update(title="Shock", recording_sources=sources)
    manifest.write_text(json.dumps(payload))
    directory = root / "Transcripts/Figures/Shock"
    directory.mkdir(parents=True)
    outline = "\n\n".join(f"--- page {page} ---\nTopic {page:02d}\n" + "slide " * 100 for page in range(1, 41))
    (directory / "slides.txt").write_text(outline)
    job = mcp_server._agy_draft_context(arguments, workspace)
    assert [scope["slide_range"] for scope in job.part_contexts] == [[1, 10], [11, 20], [21, 30], [31, 40]]
    prompt = mcp_server._agy_part_prompt(job, 2)
    assert "SLIDE RANGE FOR THIS PART: pages 11–20" in prompt
    assert "--- page 11 --- [ASSIGNED TO THIS PART]" in prompt
    assert "--- page 1 --- [ASSIGNED TO THIS PART]" not in prompt
    assert all(source in prompt for source in sources)
    assert "(شرح البنين) / (شرح البنات)" in prompt
    first = write_all(lecture, parts=[1])
    assert first["total_parts"] == 5 and first["staged"][0]["required_chars"] == 0
    for part in (2, 3, 4):
        mcp_server._stage_draft_part({**arguments, "part": part, "parts": 5, "content": f"### Topic {part * 10:02d}\nTiny continuation.\n\n"}, workspace)
    mcp_server._stage_draft_part({**arguments, "part": 5, "parts": 5, "content": "\n\n".join(SECTION_HEADINGS[1:]) + "\n"}, workspace)
    staged = mcp_server._staged_draft_directory(job.draft)
    complete_first = (staged / "part-1.md").read_text()
    short = json.loads(mcp_server._stage_draft_part({**arguments, "part": 1, "parts": 5,
        "content": SECTION_HEADINGS[0] + "\n### Topic 01\nTiny explanation.\n\n"}, workspace))
    assert short["guide_chars_so_far"] < short["required_chars"]
    assert "short_guide_parts" not in short
    with pytest.raises(mcp_server.ToolError, match="Chronological Guide"):
        mcp_server._apply_review({**arguments, "from_parts": True}, workspace)
    mcp_server._stage_draft_part({**arguments, "part": 1, "parts": 5, "content": complete_first}, workspace)
    mcp_server._apply_review({**arguments, "from_parts": True}, workspace)
    original = (staged / "part-2.md").read_bytes()
    retained = (staged / "part-1.md").read_bytes()
    (staged / "part-2.md").unlink()
    mcp_server._read_draft(arguments, workspace)
    assert (staged / "part-2.md").read_bytes() == original
    assert (staged / "part-1.md").read_bytes() == retained
    assert json.loads((staged / "layout.json").read_text())["alignment"] == "merged"
    (directory / "slides.txt").write_text(outline + "\nChanged outline.")
    mcp_server._agy_draft_context(arguments, workspace)
    assert not staged.exists()


@pytest.mark.parametrize("outline", [None, "Slide 1: Salicylates\nDose: 150 mg/kg", "x" * 40_000 + "omitted-tail"])
def test_guide_prompt_uses_slides_only_as_a_bounded_doctor_first_map(outline):
    part_context = {"part": 2, "total": 3}
    if outline is not None:
        part_context["slide_outline"] = outline
    prompt = agy_writer.guide_prompt(agy_writer.DraftingHandoffContext(), "Toxicology", "spoken segment", part_context)
    assert agy_writer.DOCTOR_FIRST in prompt
    assert "THIS verbatim segment" in prompt
    assert "No outside or textbook knowledge" in prompt
    assert "examples, stories, repetitions, exam tips, questions to students and side remarks" in prompt
    assert "Numbers, percentages, doses and lists that appear only in the slides" in prompt
    assert "each ### heading is the slide's own English title" in prompt
    assert "use a short English topic title" in prompt
    marker = "SLIDE OUTLINE REFERENCE (map only, not narration):\n"
    assert (marker in prompt) is (outline is not None)
    if outline is not None:
        block = prompt.split(marker, 1)[1].split("\nEND SLIDE OUTLINE REFERENCE", 1)[0]
        assert block == outline[:40_000] + ("\n[SLIDE OUTLINE TRUNCATED]" if len(outline) > 40_000 else "")
        assert "omitted-tail" not in prompt


def test_merged_prompt_keeps_full_outline_and_questions_prompt_enforces_editorial_rules():
    outline = "--- page 1 ---\nFirst topic\n" + "slide " * 8000 + "\n--- page 2 ---\nLast topic"
    context = agy_writer.DraftingHandoffContext()
    prompt = agy_writer.guide_prompt(context, "Toxicology", "spoken", {
        "part": 2, "total": 2, "merge_mode": "slides", "slide_range": [2, 2], "slide_outline": outline,
    })
    assert "--- page 2 --- [ASSIGNED TO THIS PART]\nLast topic" in prompt
    assert "SLIDE OUTLINE TRUNCATED" not in prompt
    assert "omit '## 📖 Chronological Guide'" in prompt
    questions = agy_writer.questions_prompt(context, "Toxicology", {}, {"headings": "", "exam_style_profile": {}})
    for rule in ("1–5 words per bullet", "longer than 10 words", "handwriting noise", "mark allocations",
                 "Section 3 with the options split", "Keep every badge and Source line unchanged"):
        assert rule in questions


@pytest.mark.parametrize("clean, raw", [
    ("Treatment of snake poisoning are", "Treatment of snake POISOnINE are. l caw wets dben es aden weaenee acre Cae = finition) (0.5 degree for ea"),
    ("Polyvalent antisnake venom must be used to all snake venom", "Poly valent antisnake venom must be used to all snake venoum ( Fale)"),
    ("Local sign are in viperidae", "Local sign are in viperidae (a) Mos marked. b. less marked. C. both. d. none"),
])
def test_cleaned_sourced_question_passes_verify_provenance(lecture, clean, raw):
    workspace, root, arguments = lecture
    (root / "Questions/Final 2023.txt").write_text("1. " + raw + "\n")
    write_index(build_index(root / "Questions", "toxo"), root / "Questions")
    draft = root / "Transcripts/Animal poisoning.draft.md"
    draft.write_text(f"## ✍️ Written Questions\n### Question 1 **[Past Exams - 2023]**\n"
                     f"**Question:** {clean}\n**Source:** Questions/Final 2023.txt\n"
                     "**Model Answer:**\n- Antivenin\n**Clinical Explanation:** شرح الدكتور.\n")
    assert "Every year badge is backed" in mcp_server._verify_provenance({
        "module": "toxo", "transcript": str(draft),
    }, workspace)


def test_validate_draft_reports_long_model_answer_with_question_heading(lecture):
    from phase_validation import SECTION_HEADINGS

    workspace, root, arguments = lecture
    draft = root / "Transcripts/Corrosives.draft.md"
    guide = (root / "Verbatim/Corrosives.verbatim.md").read_text()
    draft.write_text("\n\n".join(SECTION_HEADINGS[:1]) + "\n" + guide + "\n" +
                     "\n\n".join(SECTION_HEADINGS[1:4]) +
                     "\n### Question 1 **[IMP]**\n**Question:** Treatment of corrosive poisoning\n"
                     "**Model Answer:**\n- " + "word " * 11 + "\n**Clinical Explanation:** شرح الدكتور.\n" + SECTION_HEADINGS[4])
    with pytest.raises(mcp_server.ToolError, match="Question 1.*model_answer_too_long"):
        mcp_server._validate_draft({**arguments, "draft": str(draft)}, workspace)


def test_guide_continuation_receives_slide_text_but_not_already_linked_figures(lecture):
    from slide_figures import SELECTION_VERSION, SELECTION_VERSION_NAME

    workspace, root, arguments = lecture
    directory = root / "Transcripts/Figures/Corrosives"
    directory.mkdir(parents=True)
    for page in (1, 2):
        (directory / f"page-{page:03d}.png").write_bytes(b"figure")
    (directory / "figures.json").write_text(json.dumps({"source": "Corrosives.pdf", "figures": [
        {"page": page, "file": f"page-{page:03d}.png"} for page in (1, 2)
    ]}))
    (directory / SELECTION_VERSION_NAME).write_text(SELECTION_VERSION)
    (directory / "slides.txt").write_text("--- page 1 ---\nBurns\n--- page 2 ---\nAirway treatment\n")
    context = mcp_server._resolve_draft_context(arguments, workspace)
    staged = mcp_server._staged_part_path(context, 1)
    staged.parent.mkdir(parents=True)
    staged.write_text("### Burns\nSpoken explanation.\n![burn](<./Figures/Corrosives/page-001.png>)\n")
    job = mcp_server.AgyDraftContext(context, "Toxicology", ["burns", "airway"], ["burns", "airway"], arguments, workspace)
    prompt = mcp_server._agy_part_prompt(job, 2)
    figure_block = prompt.split("Reported figures (link only where this segment discusses them):\n", 1)[1].split("\n\nFigure placement:", 1)[0]
    figures = json.loads(figure_block)
    assert [figure["page"] for figure in figures] == [2]
    assert figures[0]["slide_text"] == "Airway treatment"
    assert "at most once" in prompt and "Skip a figure when unsure" in prompt


def test_guide_writer_receives_existing_figures_slide_text(lecture, fake_agy):
    _, root, _ = lecture
    directory = root / "Transcripts/Figures/Corrosives"
    directory.mkdir(parents=True)
    outline = "Slide 1: Corrosives\nSlide 2: Clinical treatment"
    (directory / "slides.txt").write_text(outline, encoding="utf-8")
    assert write_all(lecture, parts=[1])["error"] is None
    prompt = json.loads(fake_agy.read_text().splitlines()[0])["prompt"]
    assert "SLIDE OUTLINE REFERENCE (map only, not narration):\n" + outline in prompt


@pytest.mark.parametrize("authority", ["mapping", "definition"])
def test_guide_prompt_extracts_known_pdf_when_figures_are_absent(lecture, monkeypatch, authority):
    workspace, root, arguments = lecture
    (root / "Lecture/Corrosives.pdf").write_bytes(b"fixture")
    module_path = root / "module.json"
    module = json.loads(module_path.read_text())
    if authority == "mapping":
        module["lecture_slides"] = {"Corrosives": "Lecture/Corrosives.pdf"}
    else:
        module["lectures"] = [{"id": "corrosives", "title": "Corrosives",
                               "recordings": ["Corrosives.mp3"], "materials": ["Corrosives.pdf"]}]
    module_path.write_text(json.dumps(module))
    outline = "Corrosives\nTreatment: support the airway"
    def extract(command, **kwargs):
        assert command == ["pdftotext", "-layout", str(root / "Lecture/Corrosives.pdf"), "-"]
        return subprocess.CompletedProcess(command, 0, outline, "")
    monkeypatch.setattr(subprocess, "run", extract)
    context = mcp_server._resolve_draft_context(arguments, workspace)
    job = mcp_server.AgyDraftContext(context, "Toxicology", ["spoken segment"], ["spoken segment"], arguments, workspace)
    prompt = mcp_server._agy_part_prompt(job, 1)
    assert "SLIDE OUTLINE REFERENCE (map only, not narration):\n--- page 1 ---\n" + outline in prompt


def test_optional_powerpoint_library_absent_keeps_guide_prompt_usable(lecture, monkeypatch):
    workspace, root, arguments = lecture
    (root / "Lecture/Corrosives.pptx").write_bytes(b"fixture")
    monkeypatch.setitem(sys.modules, "pptx", None)
    context = mcp_server._resolve_draft_context(arguments, workspace)
    job = mcp_server.AgyDraftContext(context, "Toxicology", ["spoken segment"], ["spoken segment"], arguments, workspace)
    prompt = mcp_server._agy_part_prompt(job, 1)
    assert "SLIDE OUTLINE REFERENCE (map only, not narration):" not in prompt
    assert "spoken segment" in prompt and agy_writer.DOCTOR_FIRST in prompt


def test_second_short_answer_keeps_prior_part_and_stops(lecture, fake_agy, monkeypatch):
    write_all(lecture, parts=[1])
    monkeypatch.setenv("AGY_MODE", "short-always")
    failed = write_all(lecture)
    assert failed["failed_part"] == 2
    assert failed["received_parts"] == [1]
    assert "after one retry" in failed["error"]


@pytest.mark.parametrize(("mode", "error"), [
    ("permission", "permission auto-denial"), ("exit", "exited 2"),
    ("empty", "empty response"), ("status", "status 'FAILED'"),
    ("invalid", "invalid JSON"), ("timeout", "timed out after 1s"),
])
def test_writer_failures_report_progress_without_staging(lecture, fake_agy, monkeypatch, mode, error):
    write_all(lecture, parts=[1])
    monkeypatch.setenv("AGY_MODE", mode)
    failed = write_all(lecture, _agy_timeout=1)
    assert failed["failed_part"] == 2
    assert error in failed["error"]
    assert failed["staged"] == []
    assert failed["received_parts"] == [1]


def test_questions_prompt_keeps_verified_badges_and_source_paths(lecture, fake_agy):
    workspace, _, arguments = lecture
    found = json.loads(mcp_server._find_questions({"module": "toxo", "lecture": "Corrosives"}, workspace))
    assert found["entries"]
    completed = write_all(lecture)
    prompt = json.loads(fake_agy.read_text().splitlines()[-1])["prompt"]
    entries_text = prompt.split("FIND_QUESTIONS ENTRIES:\n", 1)[1].split("\n\nGUIDE HEADINGS:", 1)[0]
    assert json.loads(entries_text) == found
    for entry in found["entries"]:
        assert entry["badge"] in prompt
        assert all(paper["path"] in prompt for paper in entry["source_papers"])
    assert "### Corrosives" in prompt
    assert '"count": 4' in prompt
    assert completed["error"] is None


def test_absent_writer_preserves_begin_lecture_handoff(lecture):
    workspace, _, _ = lecture
    payload = json.loads(mcp_server._begin_lecture({"module": "toxo", "lecture": "Corrosives"}, workspace))
    assert "writer" not in payload
    assert "text" in payload and "contract" in payload
    assert "stage_draft_part" in payload["next"]


@pytest.mark.parametrize("writer", [True, False])
def test_begin_lecture_reports_general_materials_for_both_writer_routes(lecture, fake_agy, monkeypatch, writer):
    workspace, root, _ = lecture
    (root / "Lecture/Book.pdf").write_bytes(b"book")
    set_general_materials(load_module(root), ["Book.pdf"])
    if not writer:
        monkeypatch.setenv("TRANSCRIBER_AGY", "off")
    payload = json.loads(mcp_server._begin_lecture({"module": "toxo", "lecture": "Corrosives"}, workspace))
    assert payload["general_materials"] == ["Book.pdf"]
    assert (payload.get("writer") == "agy") is writer


def test_available_writer_begin_handoff_never_returns_long_text(lecture, fake_agy):
    workspace, _, _ = lecture
    stream = io.StringIO()
    server = mcp_server.Server(workspace, stdout=stream, agy_model="gemini-test")
    server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
        "name": "begin_lecture", "arguments": {"module": "toxo", "lecture": "Corrosives"},
    }})
    reply = json.loads(stream.getvalue())["result"]
    assert reply["isError"] is False
    payload = json.loads(reply["content"][0]["text"])
    assert payload["writer"] == "agy" and payload["model"] == "gemini-test"
    assert "write_parts_with_agy" in payload["next"]
    assert "text" not in payload and "contract" not in payload


def test_models_failure_keeps_writer_handoff_and_allows_writing(lecture, fake_agy, monkeypatch):
    workspace, _, _ = lecture
    monkeypatch.setenv("AGY_MODELS_FAIL", "1")
    payload = json.loads(mcp_server._begin_lecture({"module": "toxo", "lecture": "Corrosives"}, workspace))
    assert payload["writer"] == "agy"
    assert "write_parts_with_agy" in payload["next"]
    assert write_all(lecture, parts=[1])["error"] is None


def test_models_timeout_retries_longer_and_caches_success(lecture, fake_agy, monkeypatch):
    run = subprocess.run
    timeouts = []

    def transient_timeout(command, **kwargs):
        if command[1:] == ["models"]:
            timeouts.append(kwargs["timeout"])
            if len(timeouts) == 1:
                raise subprocess.TimeoutExpired(command, kwargs["timeout"])
        return run(command, **kwargs)

    monkeypatch.setattr(subprocess, "run", transient_timeout)
    ready = agy_writer.availability()
    assert ready.binary is not None and "gemini-test" in ready.models
    assert timeouts == [30, 90]
    monkeypatch.setenv("AGY_MODELS_FAIL", "1")
    assert agy_writer.availability() == ready
    assert timeouts == [30, 90]


@pytest.mark.parametrize("failure", ["timeout", "empty", "os_error"])
@pytest.mark.parametrize("write_failure", [False, True])
def test_failed_models_listing_defers_to_real_writer(lecture, fake_agy, monkeypatch, failure, write_failure):
    run = subprocess.run
    timeouts = []

    def failed_listing(command, **kwargs):
        if command[1:] == ["models"]:
            timeouts.append(kwargs["timeout"])
            if failure == "timeout":
                raise subprocess.TimeoutExpired(command, kwargs["timeout"])
            if failure == "os_error":
                raise OSError("listing unavailable")
            return subprocess.CompletedProcess(command, 0, "", "")
        return run(command, **kwargs)

    monkeypatch.setattr(subprocess, "run", failed_listing)
    if write_failure:
        monkeypatch.setenv("AGY_MODE", "exit")
    completed = write_all(lecture, parts=[1])
    assert timeouts == [30, 90]
    if write_failure:
        assert "agy exited 2: authentication expired" in completed["error"]
        assert completed["failed_part"] == 1
        assert completed["received_parts"] == []
    else:
        assert completed["error"] is None
        assert completed["received_parts"] == [1]
    # Failed listings must not poison the successful-listing cache.
    monkeypatch.setattr(subprocess, "run", run)
    assert "gemini-test" in agy_writer.availability().models


def test_models_success_is_cached_and_home_binary_is_detected(lecture, fake_agy, monkeypatch):
    workspace, _, _ = lecture
    fallback = workspace / ".local/bin/agy"
    fallback.parent.mkdir(parents=True)
    (workspace / "bin/agy").rename(fallback)
    ready = mcp_server.agy_writer.availability()
    assert ready.binary == str(fallback)
    assert "gemini-test" in ready.models
    monkeypatch.setenv("AGY_MODELS_FAIL", "1")
    assert mcp_server.agy_writer.availability() == ready


def test_mcp_failure_returns_compact_progress_as_tool_error(lecture, fake_agy, monkeypatch):
    workspace, _, arguments = lecture
    write_all(lecture, parts=[1])
    monkeypatch.setenv("AGY_MODE", "permission")
    stream = io.StringIO()
    server = mcp_server.Server(workspace, stdout=stream)
    server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
        "name": "write_parts_with_agy", "arguments": arguments,
    }})
    reply = json.loads(stream.getvalue())["result"]
    assert reply["isError"] is True
    payload = json.loads(reply["content"][0]["text"])
    assert payload["failed_part"] == 2 and payload["received_parts"] == [1]


def test_failed_replacement_retains_original_and_next_retries_explicit_part(lecture, fake_agy, monkeypatch):
    completed = write_all(lecture)
    workspace, _, arguments = lecture
    context = mcp_server._resolve_draft_context(arguments, workspace)
    staged_part = mcp_server._staged_part_path(context, 1)
    original = staged_part.read_text()
    monkeypatch.setenv("AGY_MODE", "permission")
    failed = write_all(lecture, parts=[1])
    assert failed["failed_part"] == 1
    assert failed["received_parts"] == completed["received_parts"]
    assert failed["missing_parts"] == []
    assert "parts=[1]" in failed["next"]
    assert staged_part.read_text() == original


def test_doctor_reports_installed_optional_writer(lecture, fake_agy):
    workspace, _, _ = lecture
    report = mcp_server._doctor({}, workspace)
    entry = next(entry for entry in json.loads(report)["dependencies"] if entry["name"] == "agy")
    assert entry["resolved"] and entry["status"] == "installed"
    assert entry["version"] == "agy 1.0" and not entry["required"]
    assert entry["model"] == "gemini-3.8-flash-high"


def test_surgery_concatenated_json_returns_last_proposal(lecture, fake_agy, monkeypatch):
    captured = Path(__file__).parent / "fixtures/agy_raw_proposal.txt"
    monkeypatch.setenv("AGY_JSON_RESPONSE", str(captured))
    proposal = agy_writer.request_json("Organize surgery", PROPOSAL_SCHEMA, model="gemini-3.8-flash-low")
    assert proposal["toolAction"] == "Submitting lecture proposals"
    assert [unit["title"] for unit in proposal["lectures"]] == ["Shock", "Wound healing", "Wound management"]
    assert len(proposal["notes"]) == 4
    assert json.loads(fake_agy.read_text().splitlines()[-1])["model"] == "gemini-3.8-flash-low"


@pytest.mark.parametrize("suffix", ["", '\n{"toolSummary": "done"}', "\nnot JSON"])
def test_schema_matching_object_survives_nonproposal_suffix(lecture, fake_agy, monkeypatch, suffix):
    workspace, _, _ = lecture
    expected = {"lectures": [], "notes": ["Keep this note."]}
    response = workspace / "response.txt"
    response.write_text(" \n" + json.dumps(expected) + suffix, encoding="utf-8")
    monkeypatch.setenv("AGY_JSON_RESPONSE", str(response))
    assert agy_writer.request_json("Organize", PROPOSAL_SCHEMA) == expected


@pytest.mark.parametrize("language", ["json", ""])
def test_fenced_organization_response_keeps_valid_proposal(lecture, fake_agy, monkeypatch, language):
    workspace, _, _ = lecture
    expected = {"lectures": [{"title": "Shock", "recordings": ["Shock boys.m4a"], "materials": []}], "notes": [], "general": []}
    response = workspace / "response.txt"
    response.write_text(f"```{language}\n" + json.dumps(expected, indent=2) + "\n```", encoding="utf-8")
    monkeypatch.setenv("AGY_JSON_RESPONSE", str(response))
    assert agy_writer.request_json("Organize", PROPOSAL_SCHEMA, model="gemini-3.8-flash-low") == expected


@pytest.mark.parametrize("text", ["garbage", '{}\n{"lectures": []}', '[{"lectures": [], "notes": []}]'])
def test_response_without_top_level_schema_match_raises(lecture, fake_agy, monkeypatch, text):
    workspace, _, _ = lecture
    response = workspace / "response.txt"
    response.write_text(text, encoding="utf-8")
    monkeypatch.setenv("AGY_JSON_RESPONSE", str(response))
    with pytest.raises(agy_writer.AgyWriterError):
        agy_writer.request_json("Organize", PROPOSAL_SCHEMA)


MARKDOWN_PART = "## 📖 Chronological Guide\n\n### Uncertainty\n\nالقرار فيه Uncertainty.\n\n"
COMPLETION = {
    "guide": "The transcript for Part 1 ('Critical thinking girls.m4a') has been generated with '## 📖 Chronological Guide'.",
    "toolAction": "Completing transcription task", "toolSummary": "Transcript completion",
}


@pytest.mark.parametrize("response", [
    MARKDOWN_PART,
    json.dumps({"guide": MARKDOWN_PART}),
    "```json\n" + json.dumps({"guide": MARKDOWN_PART}) + "\n```",
    "```\n" + json.dumps({"guide": MARKDOWN_PART}) + "\n```",
    json.dumps({"guide": MARKDOWN_PART}) + '\n{"toolAction":"Finish","toolSummary":"Done"}',
    MARKDOWN_PART + json.dumps(COMPLETION),
    MARKDOWN_PART + json.dumps(COMPLETION, indent=2) + '\n{"toolSummary":"done"}\n',
    MARKDOWN_PART + '\n  {"guide":"Done","toolAction":"Finish task"}\n',
])
def test_real_writer_response_shapes_return_only_markdown(lecture, fake_agy, monkeypatch, response):
    workspace, _, _ = lecture
    captured = workspace / "response.txt"
    captured.write_text(response, encoding="utf-8")
    monkeypatch.setenv("AGY_JSON_RESPONSE", str(captured))
    assert agy_writer.write("Write the guide").text == MARKDOWN_PART


def test_json_inside_guide_is_preserved_when_completion_suffix_is_removed(lecture, fake_agy, monkeypatch):
    workspace, _, _ = lecture
    markdown = MARKDOWN_PART + '{"example": "clinical data"}\n\nMore explanation.\n\n'
    captured = workspace / "response.txt"
    captured.write_text(markdown + json.dumps(COMPLETION), encoding="utf-8")
    monkeypatch.setenv("AGY_JSON_RESPONSE", str(captured))
    assert agy_writer.write("Write the guide").text == markdown


def test_structured_continuation_without_heading_keeps_complete_explanation(lecture, fake_agy, monkeypatch):
    workspace, _, _ = lecture
    continuation = "القرار فيه Uncertainty. " * 100 + "\n\n"
    captured = workspace / "response.txt"
    captured.write_text(json.dumps({"guide": continuation}), encoding="utf-8")
    monkeypatch.setenv("AGY_JSON_RESPONSE", str(captured))
    assert agy_writer.write("Continue the guide without a heading").text == continuation.rstrip() + "\n\n"


@pytest.mark.parametrize("response", [json.dumps(COMPLETION), '{"toolAction":"Finish","toolSummary":"Done"}'])
def test_metadata_only_response_keeps_existing_staged_part(lecture, fake_agy, monkeypatch, response):
    write_all(lecture, parts=[1])
    workspace, _, arguments = lecture
    context = mcp_server._resolve_draft_context(arguments, workspace)
    part_path = mcp_server._staged_part_path(context, 1)
    original = part_path.read_text()
    captured = workspace / "response.txt"
    captured.write_text(response, encoding="utf-8")
    monkeypatch.setenv("AGY_JSON_RESPONSE", str(captured))
    failed = write_all(lecture, parts=[1])
    assert "only completion metadata" in failed["error"]
    assert failed["staged"] == []
    assert part_path.read_text() == original


@pytest.mark.parametrize("legacy_parts", [False, True])
def test_continuation_headings_do_not_duplicate_assembled_guide(lecture, fake_agy, monkeypatch, legacy_parts):
    monkeypatch.setenv("AGY_MODE", "repeated-heading")
    completed = write_all(lecture)
    assert completed["error"] is None
    workspace, _, arguments = lecture
    context = mcp_server._resolve_draft_context(arguments, workspace)
    for part in range(2, completed["total_parts"]):
        part_path = mcp_server._staged_part_path(context, part)
        assert not part_path.read_text().startswith("## 📖 Chronological Guide")
        if legacy_parts:
            part_path.write_text("\n## 📖 Chronological Guide\n\n" + part_path.read_text())
    saved = json.loads(mcp_server._apply_review({**arguments, "from_parts": True, "confirmed": True}, workspace))
    draft = Path(saved["path"]).read_text()
    assert draft.count("## 📖 Chronological Guide") == 1
    assert draft.count("### Corrosives") == completed["total_parts"] - 1
    assert "## ❓ MCQs" in draft


def test_questions_handoff_distinguishes_observed_index_style_from_empty_bank(lecture, fake_agy):
    workspace, root, _ = lecture
    completed = write_all(lecture)
    assert completed["error"] is None
    prompt = json.loads(fake_agy.read_text().splitlines()[-1])["prompt"]
    observed = json.loads(prompt.split("OBSERVED INDEXED EXAM STYLE:\n", 1)[1])
    assert observed["mcq"][0]["stem"] == "Corrosives cause"
    assert observed["mcq"][0]["options"]["a"] == "Burns"
    for paper in (root / "Questions").iterdir():
        paper.unlink()
    assert write_all(lecture, parts=[completed["total_parts"]])["error"] is None
    prompt = json.loads(fake_agy.read_text().splitlines()[-1])["prompt"]
    assert json.loads(prompt.split("OBSERVED INDEXED EXAM STYLE:\n", 1)[1]) == {}


def test_every_agy_part_prompt_teaches_colloquial_narration(lecture, fake_agy):
    """The MSA opening regression affected both guide and assessment writing."""
    assert write_all(lecture)["error"] is None
    prompts = [json.loads(line)["prompt"] for line in fake_agy.read_text().splitlines()]
    for prompt in prompts:
        assert "Egyptian colloquial Arabic" in prompt
        assert "medical terms in English" in prompt
        assert "doctor's quotes verbatim" in prompt
        assert "sourced questions' examiner wording, repairing OCR only" in prompt
        for marker in ("بيقول", "بيوضح", "عشان", "مش", "ده", "دي", "اللي", "إن",
                       "أوضح", "أكد", "أشار", "تناول", "انتقل إلى"):
            assert marker in prompt
        assert "MSA narration verbs" in prompt and "wrong here" in prompt
        assert "Good:" in prompt and "Bad:" in prompt
