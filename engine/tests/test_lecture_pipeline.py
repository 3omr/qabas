"""Deterministic lecture runs against temporary data and fake external writers."""

import io
import json
import re
import subprocess
import sys
from pathlib import Path
from threading import Event
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

import agy_writer
import cancellation
import mcp_server
import nlm_client
import universal_transcribe
import web_figures
from lecture_pipeline import run_lecture_pipeline
from test_agy_writer import fake_agy as fake_agy
from test_agy_writer import lecture as lecture


@pytest.mark.parametrize(("lecture", "title"), [
    ("Addiction د. مصطفى", "Addiction د. مصطفى"),
    ("Addiction د. مصطفى.mp3", "Addiction د. مصطفى"),
    ("Corrosives.mp3", "Corrosives"),
    ("Corrosives", "Corrosives"),
    ("Dr. Ali.M4A", "Dr. Ali"),
    ("Lecture/topic.v2", "topic.v2"),
    ("Lecture/ topic.v2 ", "topic.v2"),
])
def test_dotted_lecture_titles_survive_draft_and_final_paths(tmp_path, lecture, title):
    args = SimpleNamespace(lecture=lecture, filename=None, output_dir=str(tmp_path))
    resolved_title = universal_transcribe._lecture_title(args, "🧪")
    target = universal_transcribe._output_target(args, {}, resolved_title, "🧪")
    draft = universal_transcribe._draft_path_for_lecture(lecture, "🧪", str(tmp_path))

    assert resolved_title == title
    assert draft == str(tmp_path / f"{title} 🧪.md.draft.md")
    assert universal_transcribe._draft_output_path(target) == draft
    identity = universal_transcribe.TranscriptIdentity("Toxicology", resolved_title, "🧪", lecture)
    universal_transcribe.commit_managed_transcript(identity, target, f"# {title}\n")

    assert (tmp_path / f"{title} 🧪.md").read_text() == f"# {title}\n"
    assert title in (tmp_path / "Index.md").read_text()


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


@pytest.mark.parametrize("placed", [True, False])
def test_review_places_missing_slide_links_without_rewriting_or_reextracting(pipeline, fake_agy, monkeypatch, placed):
    from figure_fixtures import figure_manifest
    from figure_placement import UNMATCHED_FIGURES_CALLOUT

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
    print(json.dumps({"status": "SUCCESS", "response": json.dumps({"placements": PLACEMENTS})}))
    sys.exit(0)
'''.replace('PLACEMENTS', '[{"page": 1, "after_paragraph": 1}]' if placed else '[]')
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
    # A slide without a matching paragraph is listed at the guide's end instead of failing review.
    assert (UNMATCHED_FIGURES_CALLOUT in saved) is not placed
    calls = [json.loads(line)['prompt'] for line in fake_agy.read_text().splitlines()]
    assert any('SLIDE FIGURE PLACEMENT' in prompt for prompt in calls)
    assert not any('Repair the findings' in prompt for prompt in calls)


@pytest.mark.parametrize('outcome', ['recovered', 'failed', 'missing-manifest'])
def test_initial_picture_extraction_retries_once_and_reports_exhausted_failure(pipeline, monkeypatch, outcome):
    from figure_fixtures import figure_manifest
    from module_registry import load_module

    workspace, root, _ = pipeline
    source = root / 'Lecture/Clinical Slides.pdf'
    source.write_bytes(b'synthetic slide source')
    metadata = root / 'module.json'
    metadata.write_text(json.dumps({**json.loads(metadata.read_text()), 'lecture_slides': {'Corrosives': 'Lecture/Clinical Slides.pdf'}}))
    directory = root / 'Transcripts/Figures/Corrosives'
    binary = workspace / 'bin/agy'
    placement = '''if "SLIDE FIGURE PLACEMENT" in prompt:
    print(json.dumps({"status": "SUCCESS", "response": json.dumps({"placements": [{"page": 1, "after_paragraph": 1}]})}))
    sys.exit(0)
'''
    binary.write_text(binary.read_text().replace('if "Build the ordered topic map BEFORE" in prompt:', placement + 'if "Build the ordered topic map BEFORE" in prompt:'))
    external_run = cancellation.run
    extractions = []
    def run(command, **kwargs):
        if '--extract-figures' not in command:
            return external_run(command, **kwargs)
        extractions.append(command)
        if outcome == 'missing-manifest':
            return subprocess.CompletedProcess(command, 0, 'Extraction finished', '')
        if len(extractions) == 1 or outcome == 'failed':
            return subprocess.CompletedProcess(command, 1, '', 'Slide conversion failed')
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'page-001.png').write_bytes(b'synthetic picture')
        figure_manifest(source, directory, (1,))
        return subprocess.CompletedProcess(command, 0, 'One slide picture extracted', '')
    monkeypatch.setattr(cancellation, 'run', run)
    result = execute(pipeline, _write_part_bytes=600)
    assert result['status'] == 'finalized', result
    assert len(extractions) == 2
    transcript = Path(result['paths']['transcript']).read_text()
    note = 'Slide pictures could not be prepared; the transcript has none.'
    if outcome == 'recovered':
        assert 'page-001.png' in transcript
        assert note not in result['note']
    else:
        assert 'page-001.png' not in transcript
        assert result['note'].splitlines().count(note) == 1
        manifest = mcp_server._cached_unit_manifest(load_module(root), 'Corrosives')
        assert json.loads(manifest.read_text())['pipeline_omissions']['figures']


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
        assert '"evidence":"6-15 consecutive words copied exactly from the lecture verbatim"' in prompts[0]
        assert "misspellings included" in prompts[0]


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


def test_unavailable_writer_fails_with_guide_findings_instead_of_publishing_recording(pipeline, monkeypatch):
    monkeypatch.setenv("TRANSCRIBER_AGY", "off")
    result = execute(pipeline)
    assert result["status"] == "failed", result
    assert result["reason"].startswith("The Chronological Guide still fails validation after automatic repair:")
    assert result["reason"] == result["salvage_error"] + "\nLast error: agy is turned off (TRANSCRIBER_AGY=off)."
    assert "resume" in result
    assert not (pipeline[1] / "Transcripts/Corrosives 🧪.md").exists()
    assert not list(pipeline[1].glob("Transcripts/Corrosives*.md"))


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
    original_writer = agy_writer.write
    monkeypatch.setattr(agy_writer, "write", lambda *_args, **_kwargs: (_ for _ in ()).throw(agy_writer.AgyWriterError("agy authentication expired")))
    interrupted = execute(pipeline, mode="redo")
    assert interrupted["status"] == "stopped"
    assert path.read_bytes() == previous
    monkeypatch.setattr(agy_writer, "write", original_writer)
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


def test_last_resort_prunes_an_invalid_generated_question_and_finalizes(pipeline, monkeypatch):
    original = agy_writer.write
    question = ("### MCQ 1 **[IMP]**\n**Question:** Made up assessment stem?\n"
                "**Options:**\na. First\nb. Second\nc. Third\nd. Fourth\n"
                "**Correct Answer:** a\n**Clinical Explanation:** كلام عن موضوع المحاضرة\n")

    def write(prompt, *args, **kwargs):
        output = original(prompt, *args, **kwargs)
        if "VERBATIM SEGMENT" not in prompt:
            return agy_writer.WrittenPart(output.text.replace("## ❓ MCQs\n", "## ❓ MCQs\n" + question), output.seconds)
        return output

    monkeypatch.setattr(agy_writer, "write", write)
    result = execute(pipeline, _pipeline_repair_rounds=3)
    assert result["status"] == "finalized", result
    text = Path(result["paths"]["transcript"]).read_text()
    assert "Made up assessment stem" not in text
    assert "Corrosives cause burns" in text
    assert "1 question(s)" in result["note"]
    assert list(pipeline[1].glob(".transcriber-cache/stale-staged/*/*/part-*.md"))



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


def test_exhausted_repairs_fail_with_unwritten_parts_instead_of_looping(pipeline, monkeypatch):
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
    assert result["status"] == "failed", result
    assert count <= 4
    assert result["reason"] == ("Lecture parts 2, 3, 4 of 4 were not written, so the Chronological Guide is incomplete."
                                "\nLast error: 503 overloaded")
    assert not list(pipeline[1].glob("Transcripts/Corrosives*.md"))


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
    result = execute(pipeline, _pipeline_repair_rounds=2)
    assert result["status"] == "finalized", result
    text = Path(result["paths"]["transcript"]).read_text()
    assert "missing.png" not in text
    assert "Corrosives cause burns" in text
    assert "Optional figures" in result["note"]


def test_overlapping_jobs_wait_for_the_same_finalized_outcome(pipeline):
    from concurrent.futures import ThreadPoolExecutor

    entered, waiting, release = Event(), Event(), Event()

    def owner_progress(*_):
        if not entered.is_set():
            entered.set()
            assert release.wait(30), 'follower did not reach the lecture lock'

    def follower_progress(_done, _total, message):
        if 'Waiting for the active lecture' in message:
            waiting.set()

    with ThreadPoolExecutor(max_workers=2) as executor:
        try:
            owner = executor.submit(execute, pipeline, _report_progress=owner_progress)
            assert entered.wait(30), 'owner did not acquire the lecture lock'
            follower = executor.submit(execute, pipeline, _report_progress=follower_progress)
            assert waiting.wait(30), 'duplicate job completed before the owner finalized'
        finally:
            release.set()
        completed = owner.result(timeout=60)
        assert follower.result(timeout=60) == completed
    assert completed['status'] == 'finalized'
    assert Path(completed['paths']['transcript']).is_file()


@pytest.mark.parametrize("recorded", [True, False])
def test_continue_repairs_saved_draft_budget_mismatch(pipeline, monkeypatch, recorded):
    first = execute(pipeline)
    final = Path(first["paths"]["transcript"])
    draft = final.with_name(final.name + ".draft.md")
    draft.write_bytes(final.read_bytes())
    final.unlink()
    module = mcp_server._registry_module(pipeline[2], pipeline[0])
    manifest = mcp_server._cached_unit_manifest(module, "Corrosives")
    request = {**pipeline[2], "manifest_path": str(manifest)}
    context = mcp_server._resolve_draft_context(request, pipeline[0])
    mcp_server._seed_repair_parts(context, draft.read_text())
    stages = mcp_server._staged_draft_directory(context)
    before = (stages / "part-1.md").read_bytes()
    if not recorded:
        (stages / "layout.json").unlink()
        (stages / "guide-alignment.txt").unlink()
    payload = json.loads(manifest.read_text())
    payload["read_part_bytes"] = 900000
    manifest.write_text(json.dumps(payload))
    begun = json.loads(mcp_server._begin_lecture({**request, "_max_part_bytes": 60000}, pipeline[0]))
    assert begun["manifest_path"] == str(manifest)
    assert len(json.dumps(begun).encode()) < 60000
    assert (stages / "part-1.md").read_bytes() == before
    assert bool(list(context.module_root.glob(".transcriber-cache/stale-staged/*/*/part-1.md"))) is (not recorded)


def test_redo_archives_even_a_started_redo_before_begin(pipeline, monkeypatch):
    first = execute(pipeline)
    final = Path(first["paths"]["transcript"])
    previous = final.read_bytes()
    draft = final.with_name(final.name + ".draft.md")
    draft.write_bytes(previous)
    module = mcp_server._registry_module(pipeline[2], pipeline[0])
    manifest = mcp_server._cached_unit_manifest(module, "Corrosives")
    context = mcp_server._resolve_draft_context({**pipeline[2], "manifest_path": str(manifest)}, pipeline[0])
    mcp_server._seed_repair_parts(context, draft.read_text())
    payload = json.loads(manifest.read_text())
    payload.update(redo=True, redo_started=True, read_part_bytes=900000)
    manifest.write_text(json.dumps(payload))
    original = mcp_server._begin_lecture
    starts = []

    def begin(arguments, workspace):
        result = original(arguments, workspace)
        starts.append(json.loads(result))
        return result

    monkeypatch.setattr(mcp_server, "_begin_lecture", begin)
    result = execute(pipeline, mode="redo", _pipeline_repair_rounds=0)
    assert result["status"] == "finalized"
    assert starts[0].get("route") == "verbatim"
    archived = list(pipeline[1].glob(".transcriber-cache/previous-drafts/*/draft-*"))
    assert [path.read_bytes() for path in archived] == [previous]
    assert list(pipeline[1].glob(".transcriber-cache/previous-drafts/*/staged-*/part-1.md"))


@pytest.mark.parametrize("mode", ["transcribe", "continue"])
def test_begin_failure_salvage_resolves_cached_manifest(pipeline, monkeypatch, mode):
    first = execute(pipeline)
    final = Path(first["paths"]["transcript"])
    draft = final.with_name(final.name + ".draft.md")
    draft.write_bytes(final.read_bytes())
    final.unlink()

    def broken_begin(*_):
        raise mcp_server.ToolError("synthetic preparation failure")

    monkeypatch.setattr(mcp_server, "_begin_lecture", broken_begin)
    result = execute(pipeline, mode=mode, _pipeline_repair_rounds=0)
    assert result["status"] == "finalized"
    assert final.is_file()


def test_continue_uses_recorded_write_budget_after_manifest_changes(pipeline):
    begun = json.loads(mcp_server._begin_lecture({**pipeline[2], "_write_part_bytes": 600}, pipeline[0]))
    manifest = Path(begun["manifest_path"])
    request = {**pipeline[2], "manifest_path": str(manifest)}
    context = mcp_server._resolve_draft_context(request, pipeline[0])
    # The real staging operation records the segment boundaries and their budget.
    mcp_server._stage_draft_part({**request, "part": 1, "parts": begun["write_parts"] + 1,
                                  "content": "Retained guide part\n"}, pipeline[0])
    directory = mcp_server._staged_draft_directory(context)
    before = {path.name: path.read_bytes() for path in directory.iterdir()}
    payload = json.loads(manifest.read_text())
    payload["write_part_bytes"] = 20000
    manifest.write_text(json.dumps(payload))
    resumed = json.loads(mcp_server._begin_lecture({**request, "_write_part_bytes": 20000}, pipeline[0]))
    assert resumed["write_segments"] == begun["write_segments"]
    assert json.loads(manifest.read_text())["write_part_bytes"] == 600
    assert {path.name: path.read_bytes() for path in directory.iterdir()} == before


@pytest.mark.parametrize("raises", [True, False])
def test_optional_exam_index_failure_is_attempted_once(pipeline, monkeypatch, raises):
    root = pipeline[1]
    (root / 'Questions/A.pdf').write_bytes(b'paper')
    builds = []

    def build(*_):
        builds.append(True)
        if raises:
            raise mcp_server.ToolError('A.pdf: synthetic indexing failure')
        path = root / 'Questions/exam-index.json'
        payload = json.loads(path.read_text())
        payload['failed_sources'] = [{'file': 'A.pdf', 'sha256': None, 'error': 'synthetic indexing failure'}]
        path.write_text(json.dumps(payload))

    monkeypatch.setattr(mcp_server, '_build_exam_index', build)
    begin = mcp_server._begin_lecture
    begins = []

    def retry_begin(arguments, workspace):
        begins.append(True)
        if len(begins) == 1:
            raise mcp_server.ToolError('synthetic input refresh needed')
        return begin(arguments, workspace)

    monkeypatch.setattr(mcp_server, '_begin_lecture', retry_begin)
    result = execute(pipeline)
    assert result['status'] == 'finalized', result
    assert len(builds) == 1
    assert 'Past-exam years are missing for 1 papers' in result['note']
    assert 'A.pdf' in result['note']


def test_begin_failure_without_content_keeps_index_and_first_reason(pipeline, monkeypatch):
    root = pipeline[1]
    (root / 'Verbatim/Corrosives.verbatim.md').unlink()
    index = root / 'Transcripts/Index.md'
    index.parent.mkdir(exist_ok=True)
    index.write_bytes(b'existing index\n')
    calls = []

    def begin(*_):
        calls.append(True)
        raise mcp_server.ToolError('original preparation failure' if len(calls) == 1 else 'later preparation failure')

    monkeypatch.setattr(mcp_server, '_begin_lecture', begin)
    result = execute(pipeline, _pipeline_repair_rounds=2)
    assert result['status'] == 'failed', result
    assert result['reason'] == 'original preparation failure'
    assert index.read_bytes() == b'existing index\n'
    assert list(index.parent.iterdir()) == [index]


def test_headings_only_salvage_without_verbatim_does_not_publish(pipeline):
    from phase_validation import SECTION_HEADINGS

    begun = json.loads(mcp_server._begin_lecture(pipeline[2], pipeline[0]))
    context = mcp_server._resolve_draft_context({**pipeline[2], 'manifest_path': begun['manifest_path']}, pipeline[0])
    context.path.write_text('\n\n'.join(SECTION_HEADINGS) + '\n')
    (pipeline[1] / 'Verbatim/Corrosives.verbatim.md').unlink()
    before = context.path.read_bytes()
    result = execute(pipeline, salvage=True, resume_manifest=begun['manifest_path'])
    assert result['status'] == 'failed', result
    assert context.path.read_bytes() == before
    assert not context.path.with_name(context.path.name.removesuffix('.draft.md')).exists()
    assert not (context.path.parent / 'Index.md').exists()


@pytest.mark.parametrize("general", ["Book.pdf", "Corrosives.pdf"])
def test_general_book_is_not_slides_and_cached_assignment_is_removed(pipeline, monkeypatch, general):
    from module_registry import load_module
    from run_transcription import generate_auto_manifest

    root = pipeline[1]
    (root / 'Lecture' / general).write_bytes(b'book')
    metadata = root / 'module.json'
    metadata.write_text(json.dumps({**json.loads(metadata.read_text()), 'general_materials': [general]}))
    manifest = generate_auto_manifest(root, 'Corrosives', recording_sources=('Corrosives.mp3',), discover_remote=False)
    payload = json.loads(manifest.read_text())
    assert not payload.get('slides')
    import universal_transcribe
    from run_transcription import _matching_slides

    assert _matching_slides(universal_transcribe, root, 'Corrosives') is None
    payload['slides'] = 'Lecture/' + general
    manifest.write_text(json.dumps(payload))
    monkeypatch.setattr(mcp_server, '_extract_figures', lambda *_: pytest.fail('no lecture slides'))
    cached = mcp_server._prepare_unit_manifest(load_module(root), 'Corrosives', ('Corrosives.mp3',), False)
    assert not json.loads(cached.read_text()).get('slides')
    result = execute(pipeline)
    assert result['status'] == 'finalized', result
    assert 'missing figures' not in result['note']


def test_exam_artifacts_are_not_inventory_or_assessment_candidates(pipeline):
    from exam_preparation import _hash
    from run_transcription import generate_auto_manifest
    from universal_transcribe import (
        _lecture_inventory_preparation_manifest,
        build_deduplication_plan,
        prepare_manifest_sources,
        scan_local_sources,
    )

    root = pipeline[1]
    questions = root / 'Questions'
    paper = questions / 'A.pdf'
    paper.write_bytes(b'paper')
    (questions / 'A.pdf.txt').write_text('derived')
    (questions / 'A.txt').write_text('sidecar')
    (questions / 'exam-index.json').write_text('{}')
    (questions / 'state.json').write_text('{}')
    state = root / '.transcriber-cache/exam-texts.json'
    state.parent.mkdir(parents=True, exist_ok=True)
    state.write_text(json.dumps({'A.pdf': {'sha256': _hash(paper), 'text': 'A.pdf.txt'}}))
    (questions / 'Final 2023.txt').unlink()
    sources = scan_local_sources(str(root))
    assert [source.relative_path for source in sources if source.relative_path.startswith('Questions/')] == ['Questions/A.pdf']
    _, _, uploads = build_deduplication_plan(sources, [])
    assert [source.relative_path for source in uploads if source.relative_path.startswith('Questions/')] == ['Questions/A.pdf']
    planned = prepare_manifest_sources(str(root), _lecture_inventory_preparation_manifest(str(root), None), execute=False)
    assert [entry.relative_path for entry in planned.entries if entry.relative_path.startswith('Questions/')] == ['Questions/A.pdf']
    manifest = generate_auto_manifest(root, 'Corrosives', recording_sources=('Corrosives.mp3',), discover_remote=False)
    assert [entry['path'] for entry in json.loads(manifest.read_text())['assessment_sources']] == ['Questions/A.pdf']
    payload = json.loads(manifest.read_text())
    payload['assessment_sources'] += [{'path': 'Questions/' + name, 'type': 'question_bank', 'action': 'auto'}
                                      for name in ('A.pdf.txt', 'A.txt', 'exam-index.json')]
    manifest.write_text(json.dumps(payload))
    from module_registry import load_module

    cached = mcp_server._prepare_unit_manifest(load_module(root), 'Corrosives', ('Corrosives.mp3',))
    assert [entry['path'] for entry in json.loads(cached.read_text())['assessment_sources']] == ['Questions/A.pdf']



def test_spreadsheet_banks_are_classified_and_a_cached_manifest_gains_them(pipeline):
    from exam_preparation import _hash
    from module_registry import load_module
    from run_transcription import generate_auto_manifest

    root = pipeline[1]
    questions = root / 'Questions'
    (questions / 'Final 2023.txt').unlink()
    (questions / 'Infection questions.xlsx').write_bytes(b'workbook')
    manifest = generate_auto_manifest(root, 'Corrosives', recording_sources=('Corrosives.mp3',), discover_remote=False)
    assert json.loads(manifest.read_text())['assessment_sources'] == [
        {'path': 'Questions/Infection questions.xlsx', 'type': 'question_bank', 'action': 'auto'}]
    # An older engine listed the derived text; a later bank arrived after the manifest was cached.
    workbook = questions / 'Infection questions.xlsx'
    (questions / 'Infection questions.xlsx.txt').write_text('derived')
    state = root / '.transcriber-cache/exam-texts.json'
    state.parent.mkdir(parents=True, exist_ok=True)
    state.write_text(json.dumps({workbook.name: {'sha256': _hash(workbook), 'text': 'Infection questions.xlsx.txt'}}))
    payload = json.loads(manifest.read_text())
    payload['assessment_sources'] = [{'path': 'Questions/Infection questions.xlsx.txt', 'type': 'question_bank', 'action': 'auto'}]
    manifest.write_text(json.dumps(payload))
    (questions / 'Pediatrics 2021.xls').write_bytes(b'legacy workbook')
    cached = mcp_server._prepare_unit_manifest(load_module(root), 'Corrosives', ('Corrosives.mp3',))
    assert json.loads(cached.read_text())['assessment_sources'] == [
        {'path': 'Questions/Infection questions.xlsx', 'type': 'question_bank', 'action': 'auto'},
        {'path': 'Questions/Pediatrics 2021.xls', 'type': 'past_exam', 'year': 2021, 'action': 'auto'},
    ]

def test_direct_finalize_refuses_a_scaffold_without_publishing(pipeline):
    from phase_validation import SECTION_HEADINGS

    begun = json.loads(mcp_server._begin_lecture(pipeline[2], pipeline[0]))
    request = {**pipeline[2], 'manifest_path': begun['manifest_path']}
    context = mcp_server._resolve_draft_context(request, pipeline[0])
    context.path.write_text('\n\n'.join(SECTION_HEADINGS) + '\n')
    before = context.path.read_bytes()
    with pytest.raises(mcp_server.ToolError, match='no narrated body'):
        mcp_server._finalize(request, pipeline[0])
    assert context.path.read_bytes() == before
    assert not context.path.with_name(context.path.name.removesuffix('.draft.md')).exists()
    assert not (context.path.parent / 'Index.md').exists()


@pytest.mark.parametrize("workers,concurrent", [(3, True), (1, False)])
def test_earlier_guide_parts_are_written_concurrently_up_to_the_configured_workers(pipeline, monkeypatch, workers, concurrent):
    import threading
    import time

    original = agy_writer.write
    guard = threading.Lock()
    active = peak = 0

    def write(prompt, *args, **kwargs):
        nonlocal active, peak
        with guard:
            active += 1
            peak = max(peak, active)
        try:
            time.sleep(.2)
            return original(prompt, *args, **kwargs)
        finally:
            with guard:
                active -= 1

    monkeypatch.setattr(agy_writer, "write", write)
    monkeypatch.setattr(nlm_client, "load_config", lambda: {"lecture_writer_workers": workers})
    result = execute(pipeline, _write_part_bytes=600)
    assert result["status"] == "finalized", result
    assert (peak > 1) is concurrent
    assert Path(result["paths"]["transcript"]).read_text().count("Corrosives cause burns") == 25


def test_exam_refresh_runs_beside_preparation_and_precedes_the_final_guide_part(pipeline, monkeypatch):
    import threading

    order = []
    prepared = threading.Event()
    refresh, begin, prompt = mcp_server._begin_exam_index, mcp_server._begin_lecture, mcp_server._agy_part_prompt

    def exam_index(*args):
        assert prepared.wait(30), "begin_lecture waited for the exam refresh"
        order.append("exam index")
        return refresh(*args)

    def begin_lecture(*args):
        prepared.set()
        return begin(*args)

    def part_prompt(job, part):
        if part >= len(job.segments):
            order.append(f"part {part}")
        return prompt(job, part)

    monkeypatch.setattr(mcp_server, "_begin_exam_index", exam_index)
    monkeypatch.setattr(mcp_server, "_begin_lecture", begin_lecture)
    monkeypatch.setattr(mcp_server, "_agy_part_prompt", part_prompt)
    result = execute(pipeline, _write_part_bytes=600)
    assert result["status"] == "finalized", result
    assert order[0] == "exam index" and len(order) > 1


def test_concurrent_parts_link_each_figure_once(tmp_path, monkeypatch):
    from types import SimpleNamespace

    staged = {1: "Intro\n![Slide 2](<./Figures/Deck/page-002.png>)\n"}
    monkeypatch.setattr(mcp_server, "_staged_part_path", lambda _context, number: tmp_path / f"part-{number}.md")
    for number, text in staged.items():
        (tmp_path / f"part-{number}.md").write_text(text)
    content = "Detail\n![Slide 2](<./Figures/Deck/page-002.png>)\n![Slide 3](<./Figures/Deck/page-003.png>)\nMore\n"
    assert mcp_server._without_linked_figures(SimpleNamespace(), 2, content) == (
        "Detail\n![Slide 3](<./Figures/Deck/page-003.png>)\nMore\n")
