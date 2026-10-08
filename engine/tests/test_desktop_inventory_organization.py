"""Desktop cache persistence, isolated library discovery and reviewed organization."""

import io
import json
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

import agy_writer
import lecture_registry
import mcp_server
import module_organization
import remote_inventory
from agy_index_fixtures import write_agy_index
from module_registry import ModuleConfigError, load_module
from source_naming import normalize_source_key, normalize_source_stem
from transcriber_models import Phase0Error, RemoteSource

RECORDINGS = ["Shock boys part 1.m4a", "Shock boys part 2.m4a", "Shock girls part 1.m4a"]


def create_module(workspace, identifier="surgery"):
    root = workspace / "modules" / identifier
    for folder in ("Lecture", "Questions", "Transcripts"):
        (root / folder).mkdir(parents=True)
    (root / "module.json").write_text(json.dumps({"schema_version": 1, "module_id": identifier,
        "display_name": identifier.title(), "notebook": {"id": f"nb-{identifier}"}}))
    for name in [*RECORDINGS, "Other.m4a", "Shock.pdf", "Book.pdf"]:
        (root / "Lecture" / name).write_bytes(b"fixture")
    return load_module(root)


def source(title, notebook="nb-surgery"):
    return RemoteSource("remote", title, normalize_source_key(title), normalize_source_stem(title),
                        "audio", notebook, status="ready")


@pytest.fixture
def module(tmp_path, monkeypatch):
    monkeypatch.setattr("nlm_client.load_config", lambda: {})
    monkeypatch.setattr("nlm_client.list_remote_sources", lambda *_: [])
    return create_module(tmp_path)


def expire(module):
    path = module.paths.root / ".transcriber-cache/remote-sources.json"
    payload = json.loads(path.read_text())
    for entry in payload["notebooks"].values():
        entry["fetched_at"] = (datetime.now(timezone.utc) - timedelta(minutes=11)).isoformat()
    path.write_text(json.dumps(payload))


def test_fresh_cache_shared_between_tools_refresh_and_expiry_refetch(module, tmp_path, monkeypatch):
    calls = []
    def listing(identifier, config):
        calls.append(identifier)
        return [source(RECORDINGS[0])]
    monkeypatch.setattr("nlm_client.list_remote_sources", listing)
    first = json.loads(mcp_server._list_lectures({"module": "surgery"}, tmp_path))
    inventory = lecture_registry.list_module_files(module)
    assert first["remote_as_of"] == inventory["remote_as_of"]
    assert next(entry for entry in inventory["files"] if entry["name"] == RECORDINGS[0])["in_notebook"] is True
    assert calls == ["nb-surgery"]
    lecture_registry.list_module_files(module, refresh=True)
    assert len(calls) == 2
    json.loads(mcp_server._list_lectures({"module": "surgery", "refresh": True}, tmp_path))
    assert len(calls) == 3
    expire(module)
    lecture_registry.list_module_files(module)
    assert len(calls) == 4
    cached = json.loads((module.paths.root / ".transcriber-cache/remote-sources.json").read_text())
    assert cached["notebooks"]["nb-surgery"]["sources"][0]["title"] == RECORDINGS[0]


@pytest.mark.parametrize("cached", [True, False])
def test_offline_inventory_retains_last_sources_or_reports_unknown(module, tmp_path, monkeypatch, cached):
    if cached:
        monkeypatch.setattr("nlm_client.list_remote_sources", lambda *_: [source(RECORDINGS[0])])
        lecture_registry.list_module_files(module)
        expire(module)
    def offline(*_):
        raise Phase0Error("connection refused")
    monkeypatch.setattr("nlm_client.list_remote_sources", offline)
    inventory = lecture_registry.list_module_files(module)
    entry = next(entry for entry in inventory["files"] if entry["name"] == RECORDINGS[0])
    assert entry["in_notebook"] is (True if cached else None)
    assert bool(inventory["remote_as_of"]) is cached
    assert "connection refused" in inventory["warning"]
    listing = json.loads(mcp_server._list_lectures({"module": "surgery"}, tmp_path))
    assert listing["lectures"] and bool(listing["remote_as_of"]) is cached
    assert "warning" in listing


def test_invalidated_cache_refetches_but_preserves_offline_fallback(module, monkeypatch):
    monkeypatch.setattr("nlm_client.list_remote_sources", lambda *_: [source("Old.mp3")])
    remote_inventory.module_inventory(module)
    remote_inventory.invalidate(module)
    assert remote_inventory.module_inventory(module, "skip").sources[0].title == "Old.mp3"
    monkeypatch.setattr("nlm_client.list_remote_sources", lambda *_: [source("New.mp3")])
    assert remote_inventory.module_inventory(module).sources[0].title == "New.mp3"
    remote_inventory.invalidate(module)
    def offline(*_):
        raise Phase0Error("offline")
    monkeypatch.setattr("nlm_client.list_remote_sources", offline)
    cached = remote_inventory.module_inventory(module)
    assert cached.sources[0].title == "New.mp3" and cached.warning


def test_cache_keeps_notebooks_distinct_and_coalesces_concurrent_readers(module, monkeypatch):
    calls = []
    def listing(identifier, config):
        calls.append(identifier)
        time.sleep(0.01)
        return [source(identifier + ".mp3", identifier)]
    monkeypatch.setattr("nlm_client.list_remote_sources", listing)
    with ThreadPoolExecutor(max_workers=4) as pool:
        inventories = list(pool.map(lambda _: remote_inventory.module_inventory(module), range(8)))
    assert calls == ["nb-surgery"]
    assert all(inventory.sources[0].title == "nb-surgery.mp3" for inventory in inventories)
    other = remote_inventory.notebook_inventory(module, "another-nb", {})
    assert other.sources[0].title == "another-nb.mp3"
    assert remote_inventory.module_inventory(module).sources[0].title == "nb-surgery.mp3"


@pytest.mark.parametrize("remote", ["cached", "refresh", "skip"])
def test_library_isolates_corrupt_module_and_reports_index_status(module, tmp_path, monkeypatch, remote):
    built = create_module(tmp_path, "built")
    stale = create_module(tmp_path, "stale")
    for prepared in (built, stale):
        from exam_index import write_index
        question = prepared.paths.questions / "Paper.txt"
        question.write_text("1. What is the first symptom?\na. Fever\nb. Pain\nc. Cough\nd. Rash\n", encoding="utf-8")
        write_index(write_agy_index(prepared.paths.questions, prepared.module_id), prepared.paths.questions)
        if prepared == stale:
            question.write_text(question.read_text(encoding="utf-8") + "\n2. A changed question?\n", encoding="utf-8")
    broken = create_module(tmp_path, "broken")
    (broken.paths.root / "module.json").write_text("invalid JSON")
    calls = []
    def listing(identifier, config):
        calls.append(identifier)
        return []
    monkeypatch.setattr("nlm_client.list_remote_sources", listing)
    payload = json.loads(mcp_server._list_library({"remote": remote}, tmp_path))
    modules = {entry["module"]: entry for entry in payload["modules"]}
    assert payload["workspace"] == str(tmp_path)
    assert modules["broken"]["error"]
    assert modules["built"]["exam_index"] == "built"
    assert modules["stale"]["exam_index"] == "stale"
    assert modules["surgery"]["exam_index"] == "missing"
    assert modules["built"]["question_files"] == 1
    assert set(modules["surgery"]) >= {"lectures", "materials", "questions", "remote_as_of", "module", "display_name", "notebooks", "root"}
    assert len(calls) == (0 if remote == "skip" else 3)
    assert modules["surgery"]["lectures"][0]["in_notebook"] is (None if remote == "skip" else False)


def test_library_cached_uses_expired_cache_without_network_and_refresh_is_bounded(module, tmp_path, monkeypatch):
    for identifier in ["one", "two", "three", "four", "five"]:
        create_module(tmp_path, identifier)
    active, peak = 0, 0
    mutex = threading.Lock()
    def listing(identifier, config):
        nonlocal active, peak
        with mutex:
            active += 1
            peak = max(active, peak)
        time.sleep(0.02)
        with mutex:
            active -= 1
        return [source("Remote.mp3", identifier)]
    monkeypatch.setattr("nlm_client.list_remote_sources", listing)
    payload = json.loads(mcp_server._list_library({"remote": "refresh"}, tmp_path))
    assert len(payload["modules"]) == 6 and 1 < peak <= 4
    expire(module)
    def unexpected(*_):
        raise AssertionError("cached or skip must not fetch an existing inventory")
    monkeypatch.setattr("nlm_client.list_remote_sources", unexpected)
    for mode in ("cached", "skip"):
        cached = json.loads(mcp_server._list_library({"remote": mode}, tmp_path))
        assert all("error" not in entry for entry in cached["modules"])
        assert all(any("Remote.mp3" in lecture["recording_sources"] for lecture in entry["lectures"]) for entry in cached["modules"])


@pytest.fixture
def fake_agy(monkeypatch):
    monkeypatch.delenv("TRANSCRIBER_AGY")
    monkeypatch.setattr(agy_writer, "_SUCCESSFUL_MODELS", {})
    monkeypatch.setattr(agy_writer.shutil, "which", lambda name: "/fake/agy" if name == "agy" else None)
    response = {"lectures": [{"title": "Shock", "recordings": list(reversed(RECORDINGS)), "materials": ["Shock.pdf"]}], "notes": []}
    prompts = []
    def run(command, **kwargs):
        if command[1:] == ["models"]:
            return subprocess.CompletedProcess(command, 0, agy_writer.DEFAULT_MODEL, "")
        if command[1:] == ["--version"]:
            return subprocess.CompletedProcess(command, 0, "agy 1.2", "")
        assert Path(kwargs["cwd"]).is_dir() and not list(Path(kwargs["cwd"]).iterdir())
        assert command[command.index("--model") + 1] == "gemini-3.8-flash-low"
        assert kwargs["timeout"] == 240
        assert "--effort" not in command
        assert "--disable-slash-commands" in command and "--json-schema" in command
        assert command[command.index("--output-format") + 1] == "json"
        prompts.append(command[command.index("-p") + 1])
        return subprocess.CompletedProcess(command, 0, json.dumps({"status": "SUCCESS", "response": response.get("_response_text", json.dumps(response))}), "")
    monkeypatch.setattr(subprocess, "run", run)
    return response, prompts


def test_valid_organization_is_read_only_ordered_and_cached(module, tmp_path, fake_agy):
    response, prompts = fake_agy
    before = (module.paths.root / "module.json").read_bytes()
    proposal = json.loads(mcp_server._propose_organization({"module": "surgery"}, tmp_path))
    assert proposal["source"] == "agy"
    assert proposal["lectures"][0]["recordings"] == RECORDINGS
    assert proposal["lectures"][0]["change"] == "same"
    assert proposal["unassigned"] == {"recordings": ["Other.m4a"], "materials": ["Book.pdf"]}
    response["lectures"][0]["title"] = "Renamed"
    assert module_organization.propose_organization(module) == proposal
    assert len(prompts) == 1
    refreshed = module_organization.propose_organization(module, refresh=True)
    assert refreshed["lectures"][0]["title"] == "Renamed"
    assert refreshed["lectures"][0]["change"] == "changed"
    assert (module.paths.root / "module.json").read_bytes() == before


@pytest.mark.parametrize("failed", [False, True])
def test_notebook_only_recordings_survive_ai_and_automatic_organization(module, tmp_path, fake_agy, monkeypatch, failed):
    for path in module.paths.lecture.glob("*.m4a"):
        path.unlink()
    remote_names = ["Shock boys part 1.m4a", "Other girls.m4a"]
    monkeypatch.setattr("nlm_client.list_remote_sources", lambda *_: [source(name) for name in remote_names])
    response, prompts = fake_agy
    response["lectures"] = [
        {"title": "Shock", "recordings": [remote_names[0]], "materials": ["Shock.pdf"]},
        {"title": "Other", "recordings": [remote_names[1]], "materials": []},
    ]
    if failed:
        response["_response_text"] = "invalid JSON"
    proposal = module_organization.propose_organization(module)
    assert proposal["source"] == ("automatic" if failed else "agy")
    assert [(unit["title"], unit["recordings"], unit["materials"]) for unit in proposal["lectures"]] == [
        ("Shock", [remote_names[0]], ["Shock.pdf"]), ("Other", [remote_names[1]], []),
    ]
    assert proposal["unassigned"]["recordings"] == []
    context = json.loads(prompts[0].split("\n", 1)[1])
    assert context["recordings"] == dict.fromkeys(remote_names, "remote")
    assert context["remote_titles"] == remote_names
    assert "files" not in context
    applied = json.loads(mcp_server._registry_operation({"module": "surgery", "lectures": proposal["lectures"]}, tmp_path, "apply_organization"))
    assert [unit["recordings"] for unit in applied["lectures"]] == [[name] for name in remote_names]


def test_invalid_organization_drops_paths_duplicates_and_empty_titles(module, fake_agy):
    response, _prompts = fake_agy
    (module.paths.lecture / "alias.m4a").symlink_to(module.paths.lecture / RECORDINGS[0])
    response["lectures"] = [
        {"title": " ", "recordings": ["Other.m4a"], "materials": []},
        {"title": "Shock", "recordings": [RECORDINGS[0], "../outside.mp3", str(module.paths.lecture / RECORDINGS[1]), "Shock.pdf"], "materials": ["missing.pdf", "Shock.pdf"]},
        {"title": "Duplicate", "recordings": [RECORDINGS[0], "alias.m4a", "Other.m4a"], "materials": []},
    ]
    proposal = module_organization.propose_organization(module)
    assert [entry["recordings"] for entry in proposal["lectures"]] == [[RECORDINGS[0]], ["Other.m4a"]]
    assert proposal["lectures"][0]["materials"] == ["Shock.pdf"]
    assert len(proposal["notes"]) >= 5
    assert RECORDINGS[1] in proposal["unassigned"]["recordings"]


def test_ai_general_proposal_validates_paths_and_removes_conflicting_lecture_materials(module, fake_agy):
    (module.paths.lecture / "Alias.pdf").symlink_to(module.paths.lecture / "Book.pdf")
    response, prompts = fake_agy
    response["general"] = ["Book.pdf", "Alias.pdf", "Shock.pdf", "missing.pdf", "../outside.pdf", RECORDINGS[0]]
    proposal = module_organization.propose_organization(module)
    assert proposal["source"] == "agy"
    assert proposal["general"] == ["Book.pdf", "Shock.pdf"]
    assert proposal["lectures"][0]["materials"] == []
    assert proposal["unassigned"]["materials"] == []
    assert any("duplicate general material" in note for note in proposal["notes"])
    assert "module-wide" in prompts[0] and "general" in prompts[0]


def test_fallback_recognizes_module_references_but_keeps_lecture_slides(module, monkeypatch):
    names = ["general toxicology.pdf", "Course reference.pdf", "كتاب السموم.pdf", "Atlas.pdf"]
    for name in names:
        (module.paths.lecture / name).write_bytes(b"reference")
    monkeypatch.setenv("TRANSCRIBER_AGY", "off")
    proposal = module_organization.propose_organization(module)
    assert set(proposal["general"]) == {"Book.pdf", *names}
    assert next(lecture for lecture in proposal["lectures"] if lecture["title"] == "Shock")["materials"] == ["Shock.pdf"]
    assert proposal["unassigned"]["materials"] == []


def test_apply_organization_transfers_general_and_preserves_legacy_omissions(module, tmp_path):
    first = lecture_registry.define_lecture(module, "Mine", RECORDINGS, ["Shock.pdf", "Book.pdf"])
    result = json.loads(mcp_server._registry_operation({"module": "surgery", "lectures": [], "general": ["Book.pdf"]}, tmp_path, "apply_organization"))
    assert result["general"] == ["Book.pdf"]
    assert result["lectures"][0]["materials"] == ["Shock.pdf"]
    lecture_registry.apply_organization(module, [])
    assert load_module(module.paths.root).general_materials == ("Book.pdf",)
    lecture_registry.apply_organization(module, [{"id": first["id"], "title": "Mine", "recordings": RECORDINGS, "materials": ["Book.pdf"]}])
    assert load_module(module.paths.root).general_materials == ()
    result = lecture_registry.apply_organization(module, [{"id": first["id"], "title": "Mine", "recordings": RECORDINGS, "materials": ["Book.pdf"]}], general=["Book.pdf"])
    assert result["general"] == ["Book.pdf"] and result["lectures"][0]["materials"] == []
    lecture_registry.apply_organization(module, [], general=[])
    assert load_module(module.paths.root).general_materials == ()


def test_legacy_ai_proposal_preserves_existing_general_and_cache_tracks_changes(module, fake_agy):
    lecture_registry.set_general_materials(module, ["Book.pdf"])
    current = load_module(module.paths.root)
    proposal = module_organization.propose_organization(current)
    assert proposal["general"] == ["Book.pdf"] and proposal["unassigned"]["materials"] == []
    lecture_registry.set_general_materials(module, [])
    changed = module_organization.propose_organization(load_module(module.paths.root))
    assert changed["general"] == [] and changed["unassigned"]["materials"] == ["Book.pdf"]


def test_surgery_captured_response_preserves_agy_notes(module, fake_agy):
    captured = (Path(__file__).parent / "fixtures/agy_raw_proposal.txt").read_text(encoding="utf-8")
    expected, _ = json.JSONDecoder().raw_decode(captured)
    for lecture in expected["lectures"]:
        for name in lecture["recordings"] + lecture["materials"]:
            (module.paths.lecture / name).write_bytes(b"fixture")
    response, _ = fake_agy
    response["_response_text"] = captured
    proposal = module_organization.propose_organization(module)
    assert proposal["source"] == "agy"
    assert proposal["notes"] == expected["notes"]
    assert [lecture["materials"] for lecture in proposal["lectures"]] == [lecture["materials"] for lecture in expected["lectures"]]


def test_automatic_surgery_materials_use_unique_best_title_match(module, monkeypatch):
    monkeypatch.setenv("TRANSCRIBER_AGY", "off")
    materials = ["Wound healing - Elwan.docx", "Wound healing.pptx", "Wound management - Dr Essam.ppt",
                 "WOUND_HEALING.PDF", "Wound.pdf", "Unrelated.pdf", "Dr Wound Healing.pdf", "Wound - Dr Healing.pptx"]
    for name in ["Wound healing boys.m4a", "Wound management boys.m4a", *materials]:
        (module.paths.lecture / name).write_bytes(b"fixture")
    proposal = module_organization.propose_organization(module)
    assignments = {lecture["title"]: lecture["materials"] for lecture in proposal["lectures"]}
    assert set(assignments["Wound healing"]) == {"Wound healing - Elwan.docx", "Wound healing.pptx", "WOUND_HEALING.PDF"}
    assert assignments["Wound management"] == ["Wound management - Dr Essam.ppt"]
    assert set(materials) - set(assignments["Wound healing"]) - set(assignments["Wound management"]) <= set(proposal["unassigned"]["materials"])
    assigned = [name for names in assignments.values() for name in names]
    assert len(assigned) == len(set(assigned))


def test_agy_duplicate_material_keeps_first_lecture_with_note(module, fake_agy):
    (module.paths.lecture / "alias.pdf").symlink_to(module.paths.lecture / "Shock.pdf")
    response, _ = fake_agy
    response["lectures"].append({"title": "Other", "recordings": ["Other.m4a"], "materials": ["Shock.pdf", "alias.pdf", "Book.pdf"]})
    proposal = module_organization.propose_organization(module)
    assert [lecture["materials"] for lecture in proposal["lectures"]] == [["Shock.pdf"], ["Book.pdf"]]
    assert proposal["unassigned"]["materials"] == []
    assert any("duplicate material 'Shock.pdf'" in note for note in proposal["notes"])
    assert any("duplicate material 'alias.pdf'" in note for note in proposal["notes"])


@pytest.mark.parametrize("failure", ["disabled", "missing", "invalid-json", "auth"])
def test_organization_failure_falls_back_without_api_key(module, monkeypatch, failure):
    monkeypatch.setenv("GOOGLE_API_KEY", "must-not-be-used")
    if failure != "disabled":
        monkeypatch.delenv("TRANSCRIBER_AGY")
        monkeypatch.setattr(agy_writer, "_SUCCESSFUL_MODELS", {})
        monkeypatch.setattr(agy_writer.shutil, "which", lambda _: None if failure == "missing" else "/fake/agy")
        if failure == "missing":
            monkeypatch.setattr(agy_writer.Path, "home", lambda: module.paths.root)
        def run(command, **kwargs):
            if command[1:] == ["models"]:
                return subprocess.CompletedProcess(command, 0, "gemini-3.8-flash-high", "")
            return subprocess.CompletedProcess(command, 1 if failure == "auth" else 0, "invalid", "authentication expired" if failure == "auth" else "")
        monkeypatch.setattr(subprocess, "run", run)
    proposal = module_organization.propose_organization(module)
    assert proposal["source"] == "automatic"
    assert next(lecture for lecture in proposal["lectures"] if lecture["title"] == "Shock")["recordings"] == RECORDINGS
    assert any("Automatic grouping used" in note for note in proposal["notes"])


@pytest.mark.parametrize("replace", [True, False])
def test_apply_organization_preserves_ids_and_optionally_retains_omitted_definitions(module, tmp_path, replace):
    first = lecture_registry.define_lecture(module, "Student Shock", RECORDINGS, ["Shock.pdf"])
    other = lecture_registry.define_lecture(module, "Other", ["Other.m4a"], [])
    payload = json.loads(mcp_server._registry_operation({"module": "surgery", "replace_existing": replace, "lectures": [
        {"id": first["id"], "title": "Updated", "recordings": RECORDINGS, "materials": ["Shock.pdf", "Book.pdf"]},
    ]}, tmp_path, "apply_organization"))
    definitions = {entry["id"]: entry for entry in payload["lectures"]}
    assert (other["id"] in definitions) is not replace
    assert definitions[first["id"]]["created"] == first["created"]
    assert definitions[first["id"]]["title"] == "Updated"
    assert len(load_module(module.paths.root).lectures) == (1 if replace else 2)


@pytest.mark.parametrize("invalid", ["path", "duplicate-recording", "duplicate-id"])
def test_apply_invalid_second_lecture_rolls_back_entire_update(module, invalid):
    lecture_registry.define_lecture(module, "Original", RECORDINGS, ["Shock.pdf"])
    before = (module.paths.root / "module.json").read_bytes()
    first = {"id": "first", "title": "First", "recordings": [RECORDINGS[0]], "materials": []}
    second = {"id": "second", "title": "Second", "recordings": ["Other.m4a"], "materials": []}
    if invalid == "path":
        second["materials"] = ["../Book.pdf"]
    elif invalid == "duplicate-recording":
        second["recordings"] = first["recordings"]
    else:
        second["id"] = first["id"]
    with pytest.raises(ModuleConfigError):
        lecture_registry.apply_organization(module, [first, second], replace_existing=True)
    assert (module.paths.root / "module.json").read_bytes() == before


def test_apply_atomic_replace_failure_leaves_original_and_confirmation_is_required(module, tmp_path, monkeypatch):
    before = (module.paths.root / "module.json").read_bytes()
    lectures = [{"title": "Shock", "recordings": RECORDINGS, "materials": []}]
    stream = io.StringIO()
    server = mcp_server.Server(tmp_path, stdout=stream)
    server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
        "name": "apply_organization", "arguments": {"module": "surgery", "lectures": lectures}}})
    assert json.loads(stream.getvalue())["result"]["isError"]
    def fail_replace(*_):
        raise OSError("disk unavailable")
    monkeypatch.setattr("atomic_io.os.replace", fail_replace)
    with pytest.raises(OSError):
        lecture_registry.apply_organization(module, lectures)
    assert (module.paths.root / "module.json").read_bytes() == before


@pytest.mark.parametrize("message,expected", [(None, "working"), ("not signed in", "not-signed-in"),
                                              ("model gemini unavailable", "model-unavailable")])
def test_doctor_live_reports_agy_health_without_hard_failure(monkeypatch, message, expected):
    monkeypatch.delenv("TRANSCRIBER_AGY")
    monkeypatch.setattr(agy_writer.shutil, "which", lambda _: "/fake/agy")
    def run(command, **kwargs):
        if command[1:] == ["--version"]:
            return subprocess.CompletedProcess(command, 0, "agy 1.2", "")
        assert not list(Path(kwargs["cwd"]).iterdir())
        assert kwargs["timeout"] == 20
        return subprocess.CompletedProcess(command, int(message is not None),
            json.dumps({"status": "SUCCESS", "response": '{"ok":true}'}), message or "")
    monkeypatch.setattr(subprocess, "run", run)
    entry = agy_writer.doctor_entry(live=True)
    assert entry["status"] == expected
    assert entry["version"] == "agy 1.2" and not entry["required"]
    assert entry["probe"]["passed"] is (message is None)


def test_disabled_doctor_does_not_run_agy(monkeypatch):
    def unexpected(*_args, **_kwargs):
        raise AssertionError("disabled writer must not run")
    monkeypatch.setattr(subprocess, "run", unexpected)
    entry = agy_writer.doctor_entry(live=True)
    assert entry["status"] == "disabled" and entry["probe"] is None


@pytest.mark.parametrize("success", [True, False])
def test_source_sync_invalidates_cache_even_after_partial_failure(module, tmp_path, monkeypatch, success):
    monkeypatch.setattr("nlm_client.list_remote_sources", lambda *_: [source("Before.mp3")])
    remote_inventory.module_inventory(module)
    def sync(command, **kwargs):
        assert "--source-sync-manifest" in command
        return subprocess.CompletedProcess(command, 0 if success else 1, "complete" if success else "", "partial failure")
    monkeypatch.setattr(subprocess, "run", sync)
    arguments = {"module": "surgery", "manifest_path": str(tmp_path / "source-sync.json")}
    if success:
        mcp_server._apply_sync(arguments, tmp_path)
    else:
        with pytest.raises(mcp_server.ToolError):
            mcp_server._apply_sync(arguments, tmp_path)
    monkeypatch.setattr("nlm_client.list_remote_sources", lambda *_: [source("After.mp3")])
    assert remote_inventory.module_inventory(module).sources[0].title == "After.mp3"


def test_inventory_is_reused_by_a_new_short_lived_process(module, tmp_path, monkeypatch):
    monkeypatch.setattr("nlm_client.list_remote_sources", lambda *_: [source(RECORDINGS[0])])
    first = remote_inventory.module_inventory(module)
    program = (
        "import json,sys; sys.path.insert(0,sys.argv[1]); "
        "import mcp_server,nlm_client; from pathlib import Path; "
        "nlm_client.list_remote_sources=lambda *_: (_ for _ in ()).throw(AssertionError('unexpected network')); "
        "print(mcp_server._list_lectures({'module':'surgery'},Path(sys.argv[2])))"
    )
    completed = subprocess.run([sys.executable, "-c", program,
        str(Path(mcp_server.__file__).parent), str(tmp_path)], capture_output=True, text=True, timeout=10)
    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    assert payload["remote_as_of"] == first.remote_as_of
    assert "warning" not in payload


def test_fallback_keeps_nested_recording_paths_and_manual_ids_unique(module, fake_agy, monkeypatch):
    nested = module.paths.lecture / "nested"
    nested.mkdir()
    (nested / "Nested boys part 1.m4a").write_bytes(b"audio")
    response, _ = fake_agy
    definition = lecture_registry.define_lecture(module, "Mine", RECORDINGS, [])
    module = load_module(module.paths.root)
    response["lectures"] = [
        {"title": "Split one", "recordings": [RECORDINGS[0]], "materials": [], "existing_id": definition["id"]},
        {"title": "Split two", "recordings": RECORDINGS[1:], "materials": [], "existing_id": definition["id"]},
    ]
    proposal = module_organization.propose_organization(module)
    ids = [lecture["existing_id"] for lecture in proposal["lectures"] if "existing_id" in lecture]
    assert ids == [definition["id"]]
    monkeypatch.setenv("TRANSCRIBER_AGY", "off")
    fallback = module_organization.propose_organization(module, refresh=True)
    assert any("nested/Nested boys part 1.m4a" in lecture["recordings"] for lecture in fallback["lectures"])
