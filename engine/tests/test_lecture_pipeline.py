"""Deterministic lecture runs against temporary data and fake external writers."""

import io
import json
import re
import subprocess
import sys
from pathlib import Path
from threading import Event

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

import agy_writer
import cancellation
import mcp_server
import nlm_client
import web_figures
from lecture_pipeline import run_lecture_pipeline
from test_agy_writer import fake_agy as fake_agy
from test_agy_writer import lecture as lecture


@pytest.fixture
def pipeline(lecture, fake_agy, monkeypatch):
    workspace, root, _ = lecture
    # Only nlm inventory crosses this fake subprocess seam. Engine validation and
    # finalization still launch the real engine against this private workspace.
    binary = workspace / "bin/nlm"
    binary.write_text(f"#!{sys.executable}\n" + r'''
import json, sys
if sys.argv[1:3] == ["notebook", "get"]:
    print(json.dumps({"id": "test-notebook", "title": "Toxicology"}))
elif sys.argv[1:3] == ["source", "list"]:
    print(json.dumps([{"id": "audio", "title": "Corrosives.mp3", "type": "audio", "status": "ready"}]))
elif sys.argv[1:3] == ["content", "source"]:
    print("Corrosives cause burns. Explain the clinical treatment fully.\n\n" * 25)
else:
    print(json.dumps([{"id": "test-notebook", "title": "Toxicology"}]))
''')
    binary.chmod(0o755)
    config = workspace / "nlm.json"
    config.write_text(json.dumps({"nlm_executable": sys.executable}))
    monkeypatch.setattr(nlm_client, "CONFIG_PATH", str(config))
    monkeypatch.setattr(nlm_client, "_INVENTORY_CACHE_ROOT", root / ".transcriber-cache/inventory")
    original_run = subprocess.run

    def run(command, **kwargs):
        if command[1:3] == ["source", "list"]:
            return subprocess.CompletedProcess(command, 0, json.dumps([
                {"id": "audio", "title": "Corrosives.mp3", "type": "audio", "status": "ready"},
            ]), "")
        return original_run(command, **kwargs)

    monkeypatch.setattr(subprocess, "run", run)
    original_write = agy_writer.write

    def write(prompt, *args, **kwargs):
        result = original_write(prompt, *args, **kwargs)
        # The existing fake echoes evidence; a real writer excludes source metadata.
        text = re.sub(r"(?m)^> Raw auto-detected speech.*$", "", result.text)
        return agy_writer.WrittenPart(text, result.seconds)

    monkeypatch.setattr(agy_writer, "write", write)
    return workspace, root, {"module": "toxo", "lecture": "Corrosives", "confirmed": True}


def execute(pipeline, **extra):
    workspace, _, request = pipeline
    return json.loads(run_lecture_pipeline({**request, **extra}, workspace))


def test_review_places_missing_slide_links_without_rewriting_or_reextracting(pipeline, fake_agy, monkeypatch):
    from figure_fixtures import figure_manifest

    workspace, root, _ = pipeline
    source = root / 'Lecture/Clinical Slides.pdf'
    source.write_bytes(b'fake deck')
    metadata = root / 'module.json'
    metadata.write_text(json.dumps({**json.loads(metadata.read_text()), 'lecture_slides': {'Corrosives': 'Lecture/Clinical Slides.pdf'}}))
    directory = root / 'Transcripts/Figures/Corrosives'
    directory.mkdir(parents=True)
    (directory / 'page-001.png').write_bytes(b'fake figure')
    figure_manifest(source, directory, (1,))
    binary = workspace / 'bin/agy'
    body = binary.read_text()
    placement = '''if "SLIDE FIGURE PLACEMENT" in prompt:
    assert "Machine-read" in prompt or '"slide_text": "x"' in prompt
    print(json.dumps({"status": "SUCCESS", "response": json.dumps({"placements": [{"page": 1, "after_paragraph": 1}]})}))
    sys.exit(0)
'''
    binary.write_text(body.replace('if "Build the ordered topic map BEFORE" in prompt:', placement + 'if "Build the ordered topic map BEFORE" in prompt:'))
    monkeypatch.setattr(mcp_server, '_extract_figures', lambda *_: pytest.fail('valid figures must not be re-extracted for missing links'))
    review = mcp_server._apply_review
    reviewed_parts = []
    def apply(*args):
        result = review(*args)
        reviewed_parts.extend(path.read_text() for path in root.glob('.transcriber-cache/staged-drafts/*/part-*.md'))
        return result
    monkeypatch.setattr(mcp_server, '_apply_review', apply)
    result = execute(pipeline, _write_part_bytes=600)
    assert result['status'] == 'finalized', result
    saved = Path(result['paths']['transcript']).read_text()
    assert saved.count('page-001.png') == 1
    assert saved.index('page-001.png') < saved.index('## 🌟 IMP Points')
    assert sum('page-001.png' in part for part in reviewed_parts) == 1
    calls = [json.loads(line)['prompt'] for line in fake_agy.read_text().splitlines()]
    assert any('SLIDE FIGURE PLACEMENT' in prompt for prompt in calls)
    assert not any('Repair the findings' in prompt for prompt in calls)


@pytest.mark.parametrize("cached_verbatim", [False, True])
def test_full_procedure_finalizes_without_draft_payload(pipeline, fake_agy, cached_verbatim):
    if not cached_verbatim:
        (pipeline[1] / "Verbatim/Corrosives.verbatim.md").unlink()
    progress = []
    result = execute(pipeline, _report_progress=lambda *frame: progress.append(frame))
    assert result["status"] == "finalized", json.dumps(result, ensure_ascii=False)
    assert Path(result["paths"]["transcript"]).is_file()
    assert "Corrosives" in Path(result["paths"]["index"]).read_text()
    messages = [frame[2] for frame in progress]
    assert any("write_parts_with_agy: part 1" in message for message in messages)
    assert messages.index("validate_draft:") < messages.index("verify_provenance:") < messages.index("finalize:")
    assert all(re.match(r"^[a-z_]+:", message) for message in messages)
    assert all(message.startswith("write_parts_with_agy:") for message in messages if re.search(r"part \d+ of \d+", message))
    assert "Complete doctor's" not in json.dumps(result)
    calls = [json.loads(line) for line in fake_agy.read_text().splitlines()]
    assert any("Build the ordered topic map BEFORE" in call["prompt"] for call in calls)


@pytest.mark.parametrize("enabled", [True, False])
def test_pipeline_writer_visual_gap_reaches_review_resolution(pipeline, fake_agy, monkeypatch, enabled):
    workspace, root, _ = pipeline
    if not enabled:
        (workspace / ".qabas-engine-settings.json").write_text(json.dumps({"web_figures": False}))
    binary = workspace / "bin/agy"
    body = binary.read_text()
    marker = '<!-- qabas-web-figure ' + json.dumps({"description": "Burns", "search": "burns", "evidence": "Corrosives cause burns."}) + ' -->'
    binary.write_text(body.replace('if mode == "short-always"', f'if segment:\n    text += {marker!r}\nif mode == "short-always"'))
    original = web_figures.resolve_placeholders
    received = []

    def resolve(text, workspace, directory, evidence):
        received.append(text)
        assert marker in text
        assert "Corrosives cause burns." in evidence.text
        return original(text, workspace, directory, evidence)

    monkeypatch.setattr(web_figures, "resolve_placeholders", resolve)
    monkeypatch.setattr(web_figures, "_resolve_locked", lambda text, *_: web_figures.remove_placeholders(text))
    result = execute(pipeline)
    assert result["status"] == "finalized", result
    assert received
    assert "qabas-web-figure" not in Path(result["paths"]["transcript"]).read_text()
    assert (root / "Transcripts/Figures/Corrosives/.web-figures.lock").exists() is enabled
    prompts = [json.loads(line)["prompt"] for line in fake_agy.read_text().splitlines() if "VERBATIM SEGMENT" in json.loads(line)["prompt"]]
    assert prompts
    assert all((web_figures.placeholder_rules() in prompt) is enabled for prompt in prompts)
    if enabled:
        assert "mottled skin" in prompts[0] and "doctor's words" in prompts[0]
        assert '"evidence":"literal excerpt from the recording"' in prompts[0]


def test_heading_refusal_is_repaired_without_another_writer_call(pipeline, monkeypatch):
    original = agy_writer.write
    prompts = []

    def write(prompt, *args, **kwargs):
        prompts.append(prompt)
        output = original(prompt, *args, **kwargs)
        return agy_writer.WrittenPart(output.text.replace("## ❓ MCQs", "## ❓ Wrong"), output.seconds)

    monkeypatch.setattr(agy_writer, "write", write)
    result = execute(pipeline)
    assert result["status"] == "finalized", result
    assert "repaired automatically" in result["note"]
    assert not any("Repair the findings" in prompt for prompt in prompts)


def test_unavailable_writer_retains_sources_for_chat(pipeline, monkeypatch):
    monkeypatch.setenv("TRANSCRIBER_AGY", "off")
    result = execute(pipeline)
    assert result["status"] == "handoff"
    assert result["resume"]["manifest_path"]
    assert not list(pipeline[1].joinpath("Transcripts").glob("*.md"))


@pytest.mark.parametrize("redo", [False, True])
def test_cancel_mid_part_retains_completed_stages_and_continue_skips_them(pipeline, monkeypatch, fake_agy, redo):
    if redo:
        first = execute(pipeline, _write_part_bytes=600)
        assert first["status"] == "finalized"
        old_final = Path(first["paths"]["transcript"]).read_bytes()
    event = Event()
    original = agy_writer.write
    written = 0

    def write(prompt, *args, **kwargs):
        nonlocal written
        output = original(prompt, *args, **kwargs)
        written += 1
        if written == 2:
            event.set()
        return output

    monkeypatch.setattr(agy_writer, "write", write)
    with cancellation.request_scope(event), pytest.raises(cancellation.OperationCancelled):
        execute(pipeline, mode="redo" if redo else "transcribe", _write_part_bytes=600)
    if redo:
        assert Path(first["paths"]["transcript"]).read_bytes() == old_final
    stages = list(pipeline[1].glob(".transcriber-cache/staged-drafts/*/part-*.md"))
    assert [path.name for path in stages] == ["part-1.md"]
    first = stages[0].read_text()
    before = len(fake_agy.read_text().splitlines())
    monkeypatch.setattr(agy_writer, "write", original)
    result = execute(pipeline, mode="continue", _write_part_bytes=600)
    assert result["status"] == "finalized", json.dumps(result, ensure_ascii=False)
    later = [json.loads(line)["prompt"] for line in fake_agy.read_text().splitlines()[before:]]
    assert not any("(part 1 of" in prompt.split("VERBATIM SEGMENT", 1)[-1] for prompt in later if "VERBATIM SEGMENT" in prompt)
    assert first in Path(result["paths"]["transcript"]).read_text()


def test_mcp_button_authorization_and_progress(pipeline):
    workspace, _, request = pipeline
    output = io.StringIO()
    server = mcp_server.Server(workspace=workspace, stdout=output)
    server.handle({"id": 2, "method": "tools/call", "params": {
        "name": "run_lecture_pipeline", "arguments": {**request, "confirmed": False},
    }})
    assert json.loads(output.getvalue())["result"]["isError"]
    output.seek(0)
    output.truncate()
    server.handle({"id": 2, "method": "tools/call", "params": {
        "name": "run_lecture_pipeline", "arguments": request, "_meta": {"progressToken": "pipeline"},
    }})
    frames = [json.loads(line) for line in output.getvalue().splitlines()]
    assert frames[0]["method"] == "notifications/progress"
    assert json.loads(frames[-1]["result"]["content"][0]["text"])["status"] == "finalized"


def test_redo_keeps_previous_final_until_replacement_is_ready(pipeline, monkeypatch):
    first = execute(pipeline)
    assert first["status"] == "finalized"
    path = Path(first["paths"]["transcript"])
    previous = path.read_bytes()
    monkeypatch.setenv("TRANSCRIBER_AGY", "off")
    interrupted = execute(pipeline, mode="redo")
    assert interrupted["status"] == "handoff"
    assert path.read_bytes() == previous
    monkeypatch.delenv("TRANSCRIBER_AGY")
    resumed = execute(pipeline, mode="redo")
    assert resumed["status"] == "finalized", resumed
    assert Path(resumed["paths"]["transcript"]).is_file()
    assert "Corrosives" in Path(resumed["paths"]["index"]).read_text()


def test_upload_failure_requests_student_action_without_chat(pipeline, monkeypatch):
    (pipeline[1] / "Verbatim/Corrosives.verbatim.md").unlink()
    original = subprocess.run

    def run(command, **kwargs):
        if command[1:3] == ["source", "list"]:
            return subprocess.CompletedProcess(command, 1, "", "NotebookLM sign-in expired")
        return original(command, **kwargs)

    monkeypatch.setattr(subprocess, "run", run)
    result = execute(pipeline)
    assert result["status"] == "stopped"
    assert result["kind"] == "auth"
    assert "NotebookLM" in result["reason"]
    assert not list(pipeline[1].glob("Transcripts/*.md"))


@pytest.mark.parametrize("message,kind", [
    ("agy exited 1: ECONNRESET", "network"),
    ("agy authentication expired", "auth"),
    ("agy account quota exhausted; resets in 5 hours", "quota"),
])
def test_student_owned_interruption_keeps_parts_for_continue(pipeline, monkeypatch, message, kind):
    original = agy_writer.write
    count = 0

    def write(prompt, *args, **kwargs):
        nonlocal count
        count += 1
        if count == 2:
            raise agy_writer.AgyWriterError(message)
        return original(prompt, *args, **kwargs)

    monkeypatch.setattr(agy_writer, "write", write)
    result = execute(pipeline, _write_part_bytes=600)
    assert result["status"] == "stopped" and result["kind"] == kind
    first = next(pipeline[1].glob(".transcriber-cache/staged-drafts/*/part-1.md"))
    retained = first.read_bytes()
    monkeypatch.setattr(agy_writer, "write", original)
    resumed = execute(pipeline, mode="continue", _write_part_bytes=600)
    assert resumed["status"] == "finalized", resumed
    assert retained.decode().strip() in Path(resumed["paths"]["transcript"]).read_text()


@pytest.mark.parametrize("message", [
    "429 RESOURCE_EXHAUSTED requestsPerMinute limit, retryDelay: 1s",
    "HTTP 503 overloaded", "agy timed out after 600s", "agy returned invalid JSON: truncated output",
])
def test_transient_provider_errors_back_off_and_resume_missing_parts(pipeline, monkeypatch, message):
    original = agy_writer.write
    count = 0
    waits = []

    def write(prompt, *args, **kwargs):
        nonlocal count
        count += 1
        if count == 2:
            raise agy_writer.AgyWriterError(message)
        return original(prompt, *args, **kwargs)

    monkeypatch.setattr(agy_writer, "write", write)
    monkeypatch.setattr(cancellation, "wait", lambda seconds: waits.append(seconds))
    result = execute(pipeline, _write_part_bytes=600)
    assert result["status"] == "finalized", result
    assert waits and waits[0] >= 1
    assert "temporary provider error" in result["note"]


def test_last_resort_prunes_an_unverifiable_question_and_finalizes(pipeline, monkeypatch):
    original = agy_writer.write
    question = ("### MCQ 1 **[Past Exams - 2023]**\n**Question:** Made up assessment stem?\n"
                "**Options:**\na. First\nb. Second\nc. Third\nd. Fourth\n"
                "**Correct Answer:** a\n**Clinical Explanation:** كلام عن موضوع المحاضرة\n"
                "**Source:** Not-a-paper.txt\n")

    def write(prompt, *args, **kwargs):
        output = original(prompt, *args, **kwargs)
        if "VERBATIM SEGMENT" not in prompt:
            return agy_writer.WrittenPart(output.text.replace("## ❓ MCQs\n", "## ❓ MCQs\n" + question), output.seconds)
        return output

    monkeypatch.setattr(agy_writer, "write", write)
    handoff = execute(pipeline, _pipeline_repair_rounds=3)
    assert handoff["status"] == "handoff", handoff
    result = execute(pipeline, mode="continue", salvage=True,
                     resume_manifest=handoff["resume"]["manifest_path"])
    assert result["status"] == "finalized", result
    text = Path(result["paths"]["transcript"]).read_text()
    assert "Made up assessment stem" not in text
    assert "Corrosives cause burns" in text
    assert "1 question(s)" in result["note"]
    assert list(pipeline[1].glob(".transcriber-cache/stale-staged/*/*/part-*.md"))


def test_unavailable_writer_last_resort_retains_complete_doctor_text(pipeline, monkeypatch):
    monkeypatch.setenv("TRANSCRIBER_AGY", "off")
    handoff = execute(pipeline)
    assert handoff["status"] == "handoff", handoff
    result = execute(pipeline, mode="continue", salvage=True,
                     resume_manifest=handoff["resume"]["manifest_path"])
    assert result["status"] == "finalized", result
    assert "doctor's full recorded text" in result["note"]
    assert Path(result["paths"]["transcript"]).read_text().count("Corrosives cause burns") == 25



def test_oversized_output_is_rewritten_in_smaller_source_pieces(pipeline, monkeypatch):
    original = agy_writer.write
    slices = []

    def write(prompt, *args, **kwargs):
        smaller = "Write only subsegment" in prompt
        clean = prompt.split("\nWrite only subsegment", 1)[0]
        output = original(clean, *args, **kwargs)
        if "VERBATIM SEGMENT" in prompt and not smaller:
            return agy_writer.WrittenPart(output.text * 200, output.seconds)
        if smaller:
            slices.append(prompt)
        return output

    monkeypatch.setattr(agy_writer, "write", write)
    result = execute(pipeline, _max_part_bytes=100000)
    assert result["status"] == "finalized", result
    assert len(slices) >= 2
    assert "smaller pieces" in result["note"]


def test_repair_deadline_hands_off_instead_of_looping(pipeline, monkeypatch):
    original = agy_writer.write
    count = 0

    def write(prompt, *args, **kwargs):
        nonlocal count
        count += 1
        if count >= 2:
            raise agy_writer.AgyWriterError("503 overloaded")
        return original(prompt, *args, **kwargs)

    monkeypatch.setattr(agy_writer, "write", write)
    monkeypatch.setattr(cancellation, "wait", lambda seconds: None)
    result = execute(pipeline, _pipeline_repair_rounds=2, _write_part_bytes=600)
    assert result["status"] == "handoff", result
    assert count <= 4
    assert list(pipeline[1].glob(".transcriber-cache/staged-drafts/*/part-1.md"))


def test_missing_local_and_remote_recording_is_a_student_stop(pipeline, monkeypatch):
    (pipeline[1] / "Lecture/Corrosives.mp3").unlink()
    (pipeline[1] / "Verbatim/Corrosives.verbatim.md").unlink()
    original = subprocess.run

    def run(command, **kwargs):
        if command[1:3] == ["source", "list"]:
            return subprocess.CompletedProcess(command, 0, "[]", "")
        return original(command, **kwargs)

    monkeypatch.setattr(subprocess, "run", run)
    result = execute(pipeline)
    assert result["status"] == "stopped" and result["kind"] == "missing-recording"
    assert not list(pipeline[1].glob("Transcripts/*.md"))


def test_last_resort_omits_an_unverifiable_optional_figure(pipeline, monkeypatch):
    original = agy_writer.write

    def write(prompt, *args, **kwargs):
        output = original(prompt, *args, **kwargs)
        if "VERBATIM SEGMENT" in prompt:
            return agy_writer.WrittenPart(output.text + "\n![optional](<./Figures/missing.png>)\n", output.seconds)
        return output

    monkeypatch.setattr(agy_writer, "write", write)
    handoff = execute(pipeline, _pipeline_repair_rounds=2)
    assert handoff["status"] == "handoff", handoff
    result = execute(pipeline, mode="continue", salvage=True,
                     resume_manifest=handoff["resume"]["manifest_path"])
    assert result["status"] == "finalized", result
    text = Path(result["paths"]["transcript"]).read_text()
    assert "missing.png" not in text
    assert "Corrosives cause burns" in text
    assert "Optional figures" in result["note"]
    assert json.loads(Path(handoff["resume"]["manifest_path"]).read_text())["pipeline_omissions"]["figures"]
