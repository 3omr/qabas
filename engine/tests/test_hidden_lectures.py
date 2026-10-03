"""Reversible library hiding, with transcript and source ownership preserved."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import lecture_registry as registry
import mcp_server
import remote_inventory
from module_organization import _context
from module_registry import ModuleConfigError, load_module
from transcriber_models import RemoteSource


class HiddenLecturesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.workspace = Path(self.temporary.name)
        self.root = self.workspace / "modules" / "surgery"
        for folder in ("Lecture", "Questions", "Transcripts"):
            (self.root / folder).mkdir(parents=True)
        self.config = self.root / "module.json"
        self.config.write_text(json.dumps({"schema_version": 1, "module_id": "surgery",
                                          "display_name": "Surgery", "notebook": {"id": "nb"}}), encoding="utf-8")
        self.names = ["Shock boys part 1.m4a", "Shock girls part 1.m4a"]
        for name in self.names + ["Shock.pdf", "Wound.mp3"]:
            (self.root / "Lecture" / name).write_bytes(b"retained")
        self.module = load_module(self.root)
        boundary = patch("nlm_client.list_remote_sources", return_value=[])
        boundary.start()
        self.addCleanup(boundary.stop)

    def listing(self):
        return json.loads(mcp_server._list_library({"remote": "skip"}, self.workspace))["modules"][0]["lectures"]

    def test_automatic_hide_and_partial_restore_preserve_files_and_suppress_orphans(self):
        transcript = self.root / "Transcripts" / "Shock final.md"
        transcript.write_text("> **الملفات المعتمدة:** `" + "` • `".join(self.names) + "`\n---\n", encoding="utf-8")
        before = {path: path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        result = registry.hide_lecture(self.module, "Shock")
        self.assertEqual(result["recordings"], self.names)
        self.assertEqual([unit["title"] for unit in self.listing()], ["Wound"])
        files = registry.list_module_files(load_module(self.root))
        hidden = [entry for entry in files["files"] if entry.get("hidden")]
        self.assertEqual({entry["name"] for entry in hidden}, set(self.names))
        self.assertTrue(all(entry["lectures"] == [] for entry in hidden))
        self.assertEqual(_context(load_module(self.root))["recordings"], {"Wound.mp3": "local"})
        for path, contents in before.items():
            if path != self.config:
                self.assertEqual(path.read_bytes(), contents)
        self.assertEqual(registry.restore_recordings(self.module, [self.names[0]])["recordings"], [self.names[0]])
        shock = next(unit for unit in self.listing() if unit["title"] == "Shock")
        self.assertEqual(shock["recording_sources"], [self.names[0]])
        self.assertEqual(load_module(self.root).hidden_recordings, (self.names[1],))

    def test_defined_hide_removes_definition_and_retains_legacy_transcript_association(self):
        definition = registry.define_lecture(self.module, "Student title", self.names, [])
        transcript = self.root / "Transcripts" / "Student title.md"
        transcript.write_text("# Legacy transcript without a recording header\n", encoding="utf-8")
        registry.hide_lecture(self.module, definition["id"])
        current = load_module(self.root)
        self.assertEqual(current.lectures, ())
        self.assertEqual(current.hidden_transcripts, {transcript.name: tuple(self.names)})
        self.assertEqual([unit["title"] for unit in self.listing()], ["Wound"])
        registry.restore_recordings(current, self.names)
        self.assertEqual(load_module(self.root).hidden_transcripts, {})
        self.assertTrue(any(unit["title"] == "Student title" for unit in self.listing()))
        self.assertEqual(load_module(self.root).lectures, ())

    def test_hidden_recordings_are_refused_by_definition_and_bulk_organization_until_restored(self):
        registry.hide_lecture(self.module, "Shock")
        before = self.config.read_bytes()
        for operation in (
            lambda: registry.define_lecture(self.module, "Hidden", self.names, []),
            lambda: registry.apply_organization(self.module, [{"title": "Hidden", "recordings": self.names, "materials": []}], True),
        ):
            with self.assertRaisesRegex(ModuleConfigError, "restore_recordings"):
                operation()
            self.assertEqual(self.config.read_bytes(), before)
        registry.restore_recordings(self.module, self.names)
        self.assertEqual(registry.define_lecture(self.module, "Restored", self.names, [])["recordings"], self.names)

    def test_invalid_names_and_unknown_or_ambiguous_titles_preserve_metadata(self):
        before = self.config.read_bytes()
        for names in (["../escape.mp3"], ["/escape.mp3"], ["bad\x00.mp3"], ["bad\\name.mp3"], ["x.mp3", "X.mp3"], [], "Shock.mp3"):
            with self.assertRaises(ModuleConfigError):
                registry.restore_recordings(self.module, names)
            self.assertEqual(self.config.read_bytes(), before)
        for title in ("", "Unknown"):
            with self.assertRaises(ModuleConfigError):
                registry.hide_lecture(self.module, title)
        registry.define_lecture(self.module, "Same", [self.names[0]], [])
        registry.define_lecture(self.module, "Same", [self.names[1]], [])
        before = self.config.read_bytes()
        with self.assertRaisesRegex(ModuleConfigError, "Ambiguous"):
            registry.hide_lecture(self.module, "Same")
        self.assertEqual(self.config.read_bytes(), before)

    def test_failed_atomic_write_keeps_definition_and_visibility(self):
        registry.define_lecture(self.module, "Shock", self.names, [])
        before = self.config.read_bytes()
        with patch("atomic_io.os.replace", side_effect=OSError("replace refused")):
            with self.assertRaises(OSError):
                registry.hide_lecture(self.module, "Shock")
        self.assertEqual(self.config.read_bytes(), before)
        self.assertEqual(load_module(self.root).hidden_recordings, ())

    def test_remote_only_definition_can_be_hidden_and_restored_offline(self):
        payload = json.loads(self.config.read_text())
        payload["lectures"] = [{"id": "remote", "title": "Remote", "recordings": ["Remote.mp3"],
                                "materials": [], "created": "today", "updated": "today"}]
        self.config.write_text(json.dumps(payload), encoding="utf-8")
        with patch("nlm_client.list_remote_sources", side_effect=AssertionError("must not fetch")):
            self.assertEqual(registry.hide_lecture(load_module(self.root), "Remote")["recordings"], ["Remote.mp3"])
            self.assertEqual(registry.restore_recordings(self.module, ["Remote.mp3"])["recordings"], ["Remote.mp3"])

    def test_cached_notebook_only_automatic_unit_can_be_hidden_without_remote_changes(self):
        source = RemoteSource("remote-id", "Remote.mp3", "remote", "remote", "audio", "nb", status="ready")
        with patch("nlm_client.list_remote_sources", return_value=[source]):
            remote_inventory.module_inventory(self.module, "refresh")
        with patch("nlm_client.list_remote_sources", side_effect=AssertionError("must not fetch")):
            self.assertEqual(registry.hide_lecture(self.module, "Remote")["recordings"], ["Remote.mp3"])
            listing = json.loads(mcp_server._list_lectures({"module": "surgery"}, self.workspace))
        self.assertFalse(any(unit["title"] == "Remote" for unit in listing["lectures"]))
        self.assertEqual(registry.restore_recordings(self.module, ["Remote.mp3"])["recordings"], ["Remote.mp3"])
        self.assertTrue(any(unit["title"] == "Remote" for unit in self.listing()))

    def test_malformed_persisted_visibility_metadata_is_refused(self):
        original = json.loads(self.config.read_text())
        for fields in (
            {"hidden_recordings": "Shock.mp3"}, {"hidden_recordings": ["../outside.mp3"]},
            {"hidden_recordings": ["SHOCK.mp3", "Shock.mp3"]}, {"hidden_transcripts": []},
            {"hidden_transcripts": {"../Shock.md": ["Shock.mp3"]}}, {"hidden_transcripts": {"Shock.md": []}},
        ):
            with self.subTest(fields=fields):
                self.config.write_text(json.dumps({**original, **fields}), encoding="utf-8")
                with self.assertRaises(ModuleConfigError):
                    load_module(self.root)

    def test_hidden_rename_and_manual_all_hidden_payload_keep_listing_semantics(self):
        definition = registry.define_lecture(self.module, "Shock", self.names, [])
        payload = json.loads(self.config.read_text())
        payload["hidden_recordings"] = self.names
        self.config.write_text(json.dumps(payload), encoding="utf-8")
        self.assertFalse(any(unit.get("id") == definition["id"] for unit in self.listing()))
        registry.rename_file(load_module(self.root), "Lecture/" + self.names[0], "Renamed.m4a")
        self.assertIn("Renamed.m4a", load_module(self.root).hidden_recordings)
        self.assertNotIn(self.names[0], load_module(self.root).hidden_recordings)

    def test_mcp_and_direct_cli_visibility_calls_need_no_chat_or_transcription_backend(self):
        output = mcp_server._registry_operation({"module": "surgery", "title": "Shock"}, self.workspace, "hide_lecture")
        self.assertEqual(json.loads(output)["recordings"], self.names)
        completed = subprocess.run([sys.executable, str(SCRIPTS / "run_transcription.py"), "--workspace", str(self.workspace),
                                    "--module", "surgery", "--restore-recordings", *self.names], capture_output=True, text=True, timeout=20)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(completed.stdout)["recordings"], self.names)
        completed = subprocess.run([sys.executable, str(SCRIPTS / "run_transcription.py"), "--workspace", str(self.workspace),
                                    "--module", "surgery", "--hide-lecture", "Shock"], capture_output=True, text=True, timeout=20)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(completed.stdout)["recordings"], self.names)


if __name__ == "__main__":
    unittest.main()
