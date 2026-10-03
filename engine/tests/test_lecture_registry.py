"""Manual lecture ownership and the surgery Shock library regression."""

import io
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(
    0, str(Path(__file__).parents[1] / "scripts")
)

import lecture_registry as registry
import mcp_server
from module_registry import ModuleConfigError, load_module
from recording_grouping import _group_recordings
from run_transcription import LauncherError, _source_manifest, generate_auto_manifest
from source_naming import normalize_source_key, normalize_source_stem
from transcriber_models import RemoteSource

SHOCK = [
    "Shock boys part 1.m4a",
    "Shock boys part 2.m4a",
    "Shock girls part 1 - hypovolemic.m4a",
    "Shock girls part 2 - septic.m4a",
]


@pytest.fixture
def module(tmp_path, monkeypatch):
    root = tmp_path / "modules" / "surgery"
    for folder in ("Lecture", "Questions", "Transcripts"):
        (root / folder).mkdir(parents=True)
    (root / "module.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "module_id": "surgery",
                "display_name": "Surgery",
                "notebook": {"id": "test-notebook"},
            }
        ),
        encoding="utf-8",
    )
    for name in SHOCK + ["Shock.pptx", "Wound healing boys.m4a", "Book.pdf"]:
        (root / "Lecture" / name).write_bytes(b"fixture")
    monkeypatch.setattr("nlm_client.list_remote_sources", lambda *_: [])
    monkeypatch.setattr(
        "run_transcription.subprocess.run",
        lambda *_args, **_kwargs: SimpleNamespace(returncode=0, stdout="[]", stderr=""),
    )
    return load_module(root)


def test_surgery_shock_descriptions_group_in_part_order():
    # Read real filenames only; the regression also runs without installed study data.
    real = Path(__file__).parents[1] / "modules/surgery/Lecture"
    names = [path.name for path in real.glob("Shock*.m4a")] or SHOCK
    units = _group_recordings([Path(name) for name in reversed(names)])
    assert len(units) == 1
    assert units[0]["title"] == "Shock"
    assert units[0]["recording_sources"] == SHOCK


def test_manual_precedence_and_order_reach_manifest_and_library(module, tmp_path):
    order = [SHOCK[3], SHOCK[2]]
    definition = registry.define_lecture(
        module, "Student title", order, ["Shock.pptx", "Book.pdf"]
    )
    listing = json.loads(mcp_server._list_lectures({"module": "surgery"}, tmp_path))
    manual = next(unit for unit in listing["lectures"] if unit["origin"] == "manual")
    assert manual["id"] == definition["id"]
    assert manual["recording_sources"] == order
    assert all(
        not set(unit["recording_sources"]) & set(order)
        for unit in listing["lectures"]
        if unit["origin"] == "auto"
    )
    prepared = json.loads(
        mcp_server._prepare_manifest(
            {"module": "surgery", "lecture": definition["id"]}, tmp_path
        )
    )
    payload = json.loads(Path(prepared["manifest_path"]).read_text(encoding="utf-8"))
    assert payload["recording_sources"] == order
    assert payload["slides"]["path"] == "Lecture/Shock.pptx"
    assert payload["references"][0]["path"] == "Lecture/Book.pdf"
    assert _source_manifest(prepared["manifest_path"]).references[0]["role"] == "textbook"
    for source in [payload["slides"], *payload["references"]]:
        assert (module.paths.root / source["path"]).is_file()
    unit = mcp_server._begin_lecture_unit(
        {"module": "surgery", "lecture": definition["id"]}, tmp_path
    )
    assert unit["recording_sources"] == order


def test_transcript_claims_best_citation_unit_once(module, tmp_path):
    first = registry.define_lecture(module, "Shock", [SHOCK[0]], [])
    second = registry.define_lecture(module, "Shock", SHOCK[1:], [])
    transcript = module.paths.transcripts / "Shock 🔪.md"
    transcript.write_text(
        "# Shock\n> **الملفات المعتمدة:** "
        + " • ".join(f"`{name}`" for name in SHOCK)
        + "\n---\n",
        encoding="utf-8",
    )
    lectures = json.loads(mcp_server._list_lectures({"module": "surgery"}, tmp_path))[
        "lectures"
    ]
    assert [
        unit["id"] for unit in lectures if unit["transcript"] == str(transcript.resolve())
    ] == [second["id"]]
    assert not next(unit for unit in lectures if unit.get("id") == first["id"])[
        "transcribed"
    ]
    pending = json.loads(
        mcp_server._prepare_manifest(
            {"module": "surgery", "lecture": first["id"]}, tmp_path
        )
    )
    assert Path(pending["manifest_path"]).is_file()


def test_update_delete_preserve_files_and_schema_and_invalidate_cached_manifest(
    module, tmp_path
):
    created = registry.define_lecture(module, "First title", SHOCK[:2], ["Shock.pptx"])
    prepared = json.loads(
        mcp_server._prepare_manifest(
            {"module": "surgery", "lecture": created["id"]}, tmp_path
        )
    )
    updated = registry.define_lecture(
        module, "First title", list(reversed(SHOCK[:2])), [], id=created["id"]
    )
    assert updated["created"] == created["created"]
    prepared_again = json.loads(
        mcp_server._prepare_manifest(
            {"module": "surgery", "lecture": created["id"]}, tmp_path
        )
    )
    payload = json.loads(
        Path(prepared_again["manifest_path"]).read_text(encoding="utf-8")
    )
    assert payload["recording_sources"] == list(reversed(SHOCK[:2]))
    assert "slides" not in payload
    assert prepared_again["manifest_path"] == prepared["manifest_path"]
    registry.delete_lecture(module, created["id"])
    assert load_module(module.paths.root).lectures == ()
    assert (
        json.loads((module.paths.root / "module.json").read_text())["schema_version"] == 1
    )
    assert (module.paths.lecture / SHOCK[0]).is_file()


def test_rename_references_and_remove_to_recoverable_trash(module):
    registry.define_lecture(module, "Shock", SHOCK[:2], ["Shock.pptx"])
    registry.rename_file(module, "Lecture/Shock.pptx", "Clinical deck.pptx")
    assert load_module(module.paths.root).lectures[0].materials == ("Clinical deck.pptx",)
    registry.rename_file(module, "Lecture/" + SHOCK[0], "Start.m4a")
    assert load_module(module.paths.root).lectures[0].recordings == (
        "Start.m4a",
        SHOCK[1],
    )
    removed = registry.remove_file(module, "Lecture/Start.m4a")
    assert Path(removed["trash_path"]).read_bytes() == b"fixture"
    assert Path(removed["trash_path"]).is_relative_to(
        module.paths.root / ".transcriber-cache/trash"
    )
    assert not (module.paths.lecture / "Start.m4a").exists()
    assert load_module(module.paths.root).lectures[0].recordings == (SHOCK[1],)


@pytest.mark.parametrize(
    "name",
    [
        "../outside.m4a",
        "/outside.m4a",
        "sub/file.m4a",
        "..\\outside.m4a",
        "C:\\outside.m4a",
    ],
)
def test_import_refuses_unsafe_destination(module, tmp_path, name):
    source = tmp_path / "input.m4a"
    source.write_bytes(b"new")
    with pytest.raises(ModuleConfigError):
        registry.import_file(module, str(source), "recording", name)
    assert not (tmp_path / "outside.m4a").exists()


def test_import_refuses_overwrite_and_supports_explicit_replace(module, tmp_path):
    source = tmp_path / "input.m4a"
    source.write_bytes(b"new")
    registry.import_file(module, str(source), "recording", "New.m4a")
    source.write_bytes(b"replacement")
    with pytest.raises(ModuleConfigError, match="already exists"):
        registry.import_file(module, str(source), "recording", "New.m4a")
    assert (module.paths.lecture / "New.m4a").read_bytes() == b"new"
    registry.import_file(module, str(source), "recording", "New.m4a", replace=True)
    assert (module.paths.lecture / "New.m4a").read_bytes() == b"replacement"
    question = tmp_path / "Input.pdf"
    question.write_bytes(b"question")
    registry.import_file(module, str(question), "question", "Question.pdf")
    assert (module.paths.questions / "Question.pdf").is_file()


def test_notebook_only_recording_is_verified_and_preserves_source_title(
    module, tmp_path, monkeypatch
):
    source = RemoteSource("remote", "Uploaded lecture", normalize_source_key("Uploaded lecture"), normalize_source_stem("Uploaded lecture"), "audio")
    monkeypatch.setattr("nlm_client.list_remote_sources", lambda *_: [source])
    definition = registry.define_lecture(
        module, "Remote title", [source.title], ["Shock.pptx"]
    )
    unit = mcp_server._begin_lecture_unit(
        {"module": "surgery", "lecture": definition["id"]}, tmp_path
    )
    assert unit["paths"] == []
    assert unit["in_notebook_only"]
    prepared = json.loads(
        mcp_server._prepare_manifest(
            {"module": "surgery", "lecture": definition["id"]}, tmp_path
        )
    )
    assert _source_manifest(prepared["manifest_path"]).recording_sources == (
        source.title,
    )
    with pytest.raises(ModuleConfigError, match="NotebookLM"):
        registry.define_lecture(module, "Unverified", ["Nonexistent"], [])


def test_auto_manifest_omits_nonexistent_and_manually_consumed_materials(module):
    registry.define_lecture(module, "Private deck", SHOCK[:2], ["Shock.pptx", "Book.pdf"])
    manifest = generate_auto_manifest(
        module.paths.root,
        "Shock",
        recording_sources=tuple(SHOCK[2:]),
        discover_remote=False,
    )
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    assert "slides" not in payload
    assert not payload.get("references")
    (module.paths.lecture / "Book.pdf").unlink()
    with pytest.raises(LauncherError, match="material does not exist"):
        generate_auto_manifest(module.paths.root, "Private deck", discover_remote=False)


def test_inventory_reports_ownership_sizes_and_remote_presence(module, monkeypatch):
    definition = registry.define_lecture(module, "Mine", [SHOCK[0]], ["Shock.pptx"])
    monkeypatch.setattr(
        "nlm_client.list_remote_sources",
        lambda *_: [RemoteSource("remote", SHOCK[0], normalize_source_key(SHOCK[0]), normalize_source_stem(SHOCK[0]), "audio")],
    )
    inventory = registry.list_module_files(load_module(module.paths.root))
    recording = next(entry for entry in inventory["files"] if entry["name"] == SHOCK[0])
    assert recording["in_notebook"] is True
    assert recording["size_bytes"] == len(b"fixture")
    assert recording["lectures"][0]["id"] == definition["id"]
    assert recording["kind"] == "recording"


@pytest.mark.parametrize(
    "operation,arguments",
    [
        ("define_lecture", {"title": "Mine", "recordings": [SHOCK[0]], "materials": []}),
        ("delete_lecture", {"id": "mine"}),
        ("rename_file", {"path": "Lecture/" + SHOCK[0], "new_name": "new.m4a"}),
        ("remove_file", {"path": "Lecture/" + SHOCK[0]}),
        ("import_file", {"source_path": "unused", "kind": "recording"}),
    ],
)
def test_mcp_registry_writes_require_confirmation(module, tmp_path, operation, arguments):
    before = (module.paths.root / "module.json").read_bytes()
    stream = io.StringIO()
    server = mcp_server.Server(tmp_path, stdout=stream)
    server.handle(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": operation,
                "arguments": {"module": "surgery", **arguments},
            },
        }
    )
    reply = json.loads(stream.getvalue())["result"]
    assert reply["isError"]
    assert "confirmed" in reply["content"][0]["text"]
    assert (module.paths.root / "module.json").read_bytes() == before
    assert (module.paths.lecture / SHOCK[0]).is_file()


def test_manual_and_auto_same_title_keep_separate_sources_and_manifests(module, tmp_path):
    definition = registry.define_lecture(module, "Shock", SHOCK[:2], ["Shock.pptx"])
    manual = json.loads(
        mcp_server._prepare_manifest(
            {"module": "surgery", "lecture": definition["id"]}, tmp_path
        )
    )
    automatic = json.loads(
        mcp_server._prepare_manifest({"module": "surgery", "lecture": SHOCK[2]}, tmp_path)
    )
    assert manual["manifest_path"] != automatic["manifest_path"]
    manual_payload = json.loads(Path(manual["manifest_path"]).read_text(encoding="utf-8"))
    auto_payload = json.loads(
        Path(automatic["manifest_path"]).read_text(encoding="utf-8")
    )
    assert manual_payload["recording_sources"] == SHOCK[:2]
    assert auto_payload["recording_sources"] == SHOCK[2:]
    assert auto_payload.get("slides", {}).get("path") != "Lecture/Shock.pptx"
    assert "lecture_definition" not in auto_payload


def test_shared_materials_do_not_allow_duplicate_recording_ownership(module):
    registry.define_lecture(module, "Boys", SHOCK[:2], ["Shock.pptx"])
    registry.define_lecture(module, "Girls", SHOCK[2:], ["Shock.pptx"])
    before = (module.paths.root / "module.json").read_bytes()
    with pytest.raises(ModuleConfigError, match="only one"):
        registry.define_lecture(module, "Duplicate", [SHOCK[0]], [])
    assert (module.paths.root / "module.json").read_bytes() == before


def test_confirmed_mcp_definition_is_visible_in_library_and_inventory(module, tmp_path):
    stream = io.StringIO()
    server = mcp_server.Server(tmp_path, stdout=stream)
    for request_id, operation, arguments in [
        (
            1,
            "define_lecture",
            {
                "module": "Surgery",
                "title": "Chosen lecture",
                "recordings": [SHOCK[0]],
                "materials": ["Shock.pptx"],
                "confirmed": True,
            },
        ),
        (2, "list_module_files", {"module": "Surgery"}),
        (3, "list_lectures", {"module": "Surgery"}),
    ]:
        server.handle(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "tools/call",
                "params": {"name": operation, "arguments": arguments},
            }
        )
    replies = [json.loads(line)["result"] for line in stream.getvalue().splitlines()]
    assert all(not reply["isError"] for reply in replies)
    definition, inventory, library = [
        json.loads(reply["content"][0]["text"]) for reply in replies
    ]
    assert definition["id"] == "chosen-lecture"
    assert (
        next(entry for entry in inventory["files"] if entry["name"] == "Shock.pptx")[
            "lectures"
        ][0]["id"]
        == definition["id"]
    )
    assert next(
        unit for unit in library["lectures"] if unit.get("id") == definition["id"]
    )["recording_sources"] == [SHOCK[0]]


@pytest.mark.parametrize("replace", ["false", 1])
def test_import_nonboolean_replace_cannot_authorize_overwrite(module, tmp_path, replace):
    source = tmp_path / "input.m4a"
    source.write_bytes(b"replacement")
    with pytest.raises(ModuleConfigError, match="boolean"):
        registry.import_file(module, str(source), "recording", SHOCK[0], replace=replace)
    assert (module.paths.lecture / SHOCK[0]).read_bytes() == b"fixture"


@pytest.mark.parametrize("names", [None, "Book.pdf", ["../Book.pdf"], ["/Book.pdf"], ["missing.pdf"],
                                    [SHOCK[0]], ["Book.pdf", "Book.pdf"], ["Book.pdf", "book.pdf"]])
def test_module_rejects_invalid_general_materials(module, names):
    path = module.paths.root / "module.json"
    payload = json.loads(path.read_text())
    payload["general_materials"] = names
    path.write_text(json.dumps(payload))
    with pytest.raises(ModuleConfigError):
        load_module(module.paths.root)


def test_general_materials_validate_nested_paths_and_reject_symlink_escapes(module, tmp_path):
    nested = module.paths.lecture / "references"
    nested.mkdir()
    (nested / "Atlas.pdf").write_bytes(b"atlas")
    registry.set_general_materials(module, ["references/Atlas.pdf"])
    assert load_module(module.paths.root).general_materials == ("references/Atlas.pdf",)
    outside = tmp_path / "Outside.pdf"
    outside.write_bytes(b"outside")
    (nested / "Escape.pdf").symlink_to(outside)
    with pytest.raises(ModuleConfigError, match="escapes"):
        registry.set_general_materials(module, ["references/Escape.pdf"])
    assert load_module(module.paths.root).general_materials == ("references/Atlas.pdf",)


def test_module_rejects_overlapping_general_and_lecture_ownership(module):
    registry.define_lecture(module, "Mine", SHOCK[:2], ["Book.pdf"])
    path = module.paths.root / "module.json"
    payload = json.loads(path.read_text())
    payload["general_materials"] = ["Book.pdf"]
    path.write_text(json.dumps(payload))
    with pytest.raises(ModuleConfigError, match="both general"):
        load_module(module.paths.root)


def test_general_validation_rejects_recordings_disguised_as_material_symlinks(module):
    (module.paths.lecture / "Audio.pdf").symlink_to(module.paths.lecture / SHOCK[0])
    with pytest.raises(ModuleConfigError, match="Wrong file kind"):
        registry.set_general_materials(module, ["Audio.pdf"])


def test_general_transfer_removes_material_from_every_lecture_and_lecture_claim_moves_it_back(module):
    first = registry.define_lecture(module, "Boys", SHOCK[:2], ["Book.pdf", "Shock.pptx"])
    registry.define_lecture(module, "Girls", SHOCK[2:], ["Book.pdf"])
    registry.set_general_materials(module, ["Book.pdf"])
    current = load_module(module.paths.root)
    assert current.general_materials == ("Book.pdf",)
    assert [lecture.materials for lecture in current.lectures] == [("Shock.pptx",), ()]
    registry.define_lecture(module, "Boys", SHOCK[:2], ["Book.pdf"], id=first["id"])
    current = load_module(module.paths.root)
    assert current.general_materials == ()
    assert current.lectures[0].materials == ("Book.pdf",)


def test_general_and_lecture_aliases_cannot_share_the_same_material(module):
    (module.paths.lecture / "Alias.pdf").symlink_to(module.paths.lecture / "Book.pdf")
    registry.define_lecture(module, "Mine", SHOCK[:2], ["Alias.pdf"])
    registry.set_general_materials(module, ["Book.pdf"])
    assert load_module(module.paths.root).lectures[0].materials == ()
    registry.define_lecture(module, "Mine", SHOCK[:2], ["Alias.pdf"], id="mine")
    assert load_module(module.paths.root).general_materials == ()


def test_general_setting_is_atomic_and_invalid_organization_does_not_partially_apply(module, monkeypatch):
    definition = registry.define_lecture(module, "Mine", SHOCK[:2], ["Book.pdf"])
    path = module.paths.root / "module.json"
    before = path.read_bytes()
    with pytest.raises(ModuleConfigError):
        registry.apply_organization(module, [{"id": definition["id"], "title": "Changed", "recordings": SHOCK[:2], "materials": []}], general=["missing.pdf"])
    assert path.read_bytes() == before
    def fail(*_):
        raise OSError("disk unavailable")
    monkeypatch.setattr("atomic_io.os.replace", fail)
    with pytest.raises(OSError):
        registry.set_general_materials(module, ["Book.pdf"])
    assert path.read_bytes() == before


def test_general_references_follow_rename_and_remove(module):
    registry.set_general_materials(module, ["Book.pdf"])
    registry.rename_file(module, "Lecture/Book.pdf", "Course book.pdf")
    assert load_module(module.paths.root).general_materials == ("Course book.pdf",)
    registry.remove_file(module, "Lecture/Course book.pdf")
    assert load_module(module.paths.root).general_materials == ()


def test_mcp_general_setting_needs_no_confirmation_and_reaches_both_listings(module, tmp_path):
    stream = io.StringIO()
    server = mcp_server.Server(tmp_path, stdout=stream)
    server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
        "name": "set_general_materials", "arguments": {"module": "Surgery", "materials": ["Book.pdf"]},
    }})
    assert not json.loads(stream.getvalue())["result"]["isError"]
    current = load_module(module.paths.root)
    entry = next(entry for entry in registry.list_module_files(current)["files"] if entry["name"] == "Book.pdf")
    assert entry["general"] is True and entry["lectures"] == []
    listing = json.loads(mcp_server._list_lectures({"module": "surgery"}, tmp_path))
    assert listing["general_materials"] == ["Book.pdf"]
    assert "Book.pdf" not in [material["name"] for material in listing["materials"]]
    library = json.loads(mcp_server._list_library({"remote": "skip"}, tmp_path))
    assert library["modules"][0]["general_materials"] == ["Book.pdf"]
