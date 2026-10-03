"""Reversible library operations preserve outputs and reject active writers or occupied paths."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import lecture_registry
import library_trash as trash
import mcp_server
from file_lock import exclusive_file_lock
from module_activity import module_activity
from module_registry import ModuleConfigError, load_module
from universal_transcribe import _draft_path_for_lecture


class LibraryTrashTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.workspace = Path(temporary.name)
        self.root = self.workspace / "modules" / "surgery"
        for name in ("Lecture", "Questions", "Transcripts", "Verbatim", "Anki"):
            (self.root / name).mkdir(parents=True)
        (self.root / "module.json").write_text(json.dumps({"schema_version": 1, "module_id": "surgery",
            "display_name": "Surgery", "notebook": {"id": "notebook-kept"}, "output": {"emoji": "🧪"}}), encoding="utf-8")
        self.recording = self.root / "Lecture" / "Shock.mp3"
        self.recording.write_bytes(b"original recording")
        (self.root / "Lecture" / "Shock.pdf").write_bytes(b"slides")
        self.module = load_module(self.root)
        self.final = self.root / "Transcripts" / "Shock 🧪.md"
        self.final.write_text("> **الملفات المعتمدة:** `Shock.mp3`\n---\n# Clinical material\n", encoding="utf-8")
        self.draft = Path(_draft_path_for_lecture("Shock", self.module.emoji, str(self.root / "Transcripts")))
        self.draft.write_bytes(b"retained draft")
        self.verbatim = self.root / "Verbatim" / "Shock.verbatim.md"
        self.verbatim.write_bytes(b"spoken words")
        self.figures = self.root / "Transcripts" / "Figures" / "Shock"
        self.figures.mkdir(parents=True)
        (self.figures / "slide.png").write_bytes(b"figure bytes")
        (self.root / "Anki" / "Shock.apkg").write_bytes(b"deck bytes")
        (self.root / "Anki" / "Shock.tsv").write_bytes(b"cards\tanswers\n")
        self.index = self.root / "Transcripts" / "Index.md"
        self.row = '| 🧪 Shock | [فتح التفريغ](./Shock%20%F0%9F%A7%AA.md) | notes |\r\n'.encode()
        self.index_before = b'\xef\xbb\xbf# Index  \r\n\r\n| Title | Link | Notes |\r\n| :--- | :--- | :--- |\r\n' + self.row + b'| Other | [link](./Other.md) | kept  |\r\n---\r\nfooter\r\n'
        self.index.write_bytes(self.index_before)
        boundary = patch("nlm_client.list_remote_sources", return_value=[])
        boundary.start()
        self.addCleanup(boundary.stop)

    def state(self):
        listing = json.loads(mcp_server._list_library({"remote": "skip"}, self.workspace))
        return listing["modules"][0]["lectures"][0]["state"]

    def test_final_figures_anki_index_and_checkpoint_restore_byte_identically_with_draft_left(self):
        run = self.root / ".transcriber-cache" / "runs" / "completed-shock"
        run.mkdir(parents=True)
        checkpoint = {"title": "Shock", "recording_sources": ["Shock.mp3"], "status": "completed", "phases": {"guide": "completed"}}
        (run / "checkpoint.json").write_text(json.dumps(checkpoint))
        (run / "guide.md").write_bytes(b"old completed answer")
        ledger = self.root / ".transcriber-cache" / "batches" / "batch-1" / "batch.json"
        ledger.parent.mkdir(parents=True)
        ledger.write_text(json.dumps({"lectures": {"shock": {**checkpoint, "status": "verified"},
            "other": {"title": "Other", "recording_sources": ["Other.mp3"], "status": "running"}}}))
        before = {path.relative_to(self.root).as_posix(): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        removed = trash.remove_transcript(self.module, "Shock", ["final"])
        self.assertEqual(self.state(), "draft")
        self.assertEqual(self.index.read_bytes(), self.index_before.replace(self.row, b""))
        self.assertFalse(self.final.exists())
        self.assertFalse(self.figures.exists())
        self.assertFalse(run.exists())
        self.assertEqual(list(json.loads(ledger.read_text())["lectures"]), ["other"])
        self.assertEqual(self.recording.read_bytes(), b"original recording")
        self.assertEqual(trash.list_trash(self.module)[0]["kind"], "transcript")
        trash.restore_trash(self.module, removed["id"])
        self.assertEqual(self.state(), "final")
        self.assertEqual(self.index.read_bytes(), self.index_before)
        for name, contents in before.items():
            self.assertEqual((self.root / name).read_bytes(), contents, name)
        self.assertEqual(trash.list_trash(self.module), [])

    def test_selected_stages_leave_remaining_state_and_missing_kinds_refuse_before_moving(self):
        for invalid in ([], ["unknown"], ["final", "final"], [None], "final"):
            with self.subTest(invalid=invalid), self.assertRaises(ModuleConfigError):
                trash.remove_transcript(self.module, "Shock", invalid)
        before = self.final.read_bytes()
        self.draft.unlink()
        with self.assertRaisesRegex(ModuleConfigError, "no draft"):
            trash.remove_transcript(self.module, "Shock", ["final", "draft"])
        self.assertEqual(self.final.read_bytes(), before)
        trash.remove_transcript(self.module, "Shock", ["final"])
        self.assertEqual(self.state(), "verbatim")
        trash.remove_transcript(self.module, "Shock", ["verbatim"])
        self.assertEqual(self.state(), "pending")

    def test_restore_refuses_a_file_or_parent_that_now_occupies_an_original_path(self):
        entry = trash.remove_transcript(self.module, "Shock", ["final"])
        after = self.index.read_bytes()
        self.final.write_bytes(b"new student transcript")
        with self.assertRaisesRegex(ModuleConfigError, "Transcripts/Shock"):
            trash.restore_trash(self.module, entry["id"])
        self.assertEqual(self.final.read_bytes(), b"new student transcript")
        self.assertEqual(self.index.read_bytes(), after)
        self.final.unlink()
        self.figures.write_bytes(b"occupied directory path")
        with self.assertRaisesRegex(ModuleConfigError, "Figures/Shock"):
            trash.restore_trash(self.module, entry["id"])
        self.assertFalse(self.final.exists())

    def test_whole_module_removal_refuses_active_engine_and_legacy_module_locks(self):
        for lock in (module_activity(self.module), exclusive_file_lock(lecture_registry._lock_path(self.module)),
                     exclusive_file_lock(self.root / ".transcriber-cache" / "locks" / "lecture-existing.lock")):
            with lock:
                with self.assertRaisesRegex(ModuleConfigError, "running job"):
                    trash.remove_module(self.workspace, "surgery")
                with self.assertRaisesRegex(ModuleConfigError, "running job"):
                    trash.remove_transcript(self.module, "Shock", ["final"])
        self.assertTrue(self.final.is_file())
        self.assertTrue(self.root.is_dir())

    def test_whole_module_and_its_trash_restore_without_touching_notebook_and_refuse_reused_id(self):
        nested = trash.remove_transcript(self.module, "Shock", ["draft"])
        original = {path.relative_to(self.root): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        removed = trash.remove_module(self.workspace, "surgery")
        self.assertTrue(removed["notebook_untouched"])
        self.assertFalse(self.root.exists())
        self.assertEqual(json.loads(mcp_server._list_library({"remote": "skip"}, self.workspace))["modules"], [])
        listing = trash.list_removed_modules(self.workspace)
        self.assertEqual(listing[0]["trash_id"], removed["trash_id"])
        self.assertEqual(listing[0]["display_name"], "Surgery")
        self.root.mkdir()
        with self.assertRaisesRegex(ModuleConfigError, "modules/surgery"):
            trash.restore_module(self.workspace, removed["trash_id"])
        self.root.rmdir()
        restored = trash.restore_module(self.workspace, removed["trash_id"])
        self.assertTrue(restored["notebook_untouched"])
        for name, contents in original.items():
            self.assertEqual((self.root / name).read_bytes(), contents)
        self.assertEqual(trash.list_removed_modules(self.workspace), [])
        self.assertEqual(trash.list_trash(load_module(self.root))[0]["id"], nested["id"])

    def test_trash_lists_file_transcript_hidden_and_legacy_entries_newest_first(self):
        legacy = self.root / ".transcriber-cache" / "trash" / "20200101T000000000000Z" / "Questions" / "Old.pdf"
        legacy.parent.mkdir(parents=True)
        legacy.write_bytes(b"legacy bytes")
        lecture_registry.remove_file(self.module, "Lecture/Shock.pdf")
        trash.remove_transcript(self.module, "Shock", ["draft"])
        lecture_registry.hide_lecture(self.module, "Shock")
        entries = trash.list_trash(self.module)
        self.assertEqual([entry["kind"] for entry in entries], ["lecture", "transcript", "file", "file"])
        self.assertEqual(entries[-1]["paths"], ["Questions/Old.pdf"])
        trash.restore_trash(self.module, entries[0]["id"])
        self.assertEqual(load_module(self.root).hidden_recordings, ())
        trash.restore_trash(self.module, entries[-1]["id"])
        self.assertEqual((self.root / "Questions" / "Old.pdf").read_bytes(), b"legacy bytes")
        self.assertTrue(legacy.parent.parent.is_dir())

    def test_failed_move_rolls_back_all_outputs_and_does_not_edit_the_index(self):
        original = Path.rename
        moved = 0

        def fail_second(path, destination):
            nonlocal moved
            moved += 1
            if moved == 2:
                raise OSError("rename refused")
            return original(path, destination)

        with patch.object(Path, "rename", fail_second), self.assertRaisesRegex(OSError, "rename refused"):
            trash.remove_transcript(self.module, "Shock", ["final", "draft"])
        self.assertTrue(self.final.is_file())
        self.assertTrue(self.draft.is_file())
        self.assertTrue(self.figures.is_dir())
        self.assertEqual(self.index.read_bytes(), self.index_before)
        self.assertEqual(trash.list_trash(self.module), [])

    def test_new_index_edits_survive_restoring_the_removed_row(self):
        entry = trash.remove_transcript(self.module, "Shock", ["final"])
        other = b'| Added | [link](./Added.md) | keep  |\r\n'
        current = self.index.read_bytes() + other
        self.index.write_bytes(current)
        trash.restore_trash(self.module, entry["id"])
        self.assertEqual(self.index.read_bytes().replace(self.row, b""), current)

    def test_activity_in_another_process_refuses_removal_until_it_exits(self):
        code = "import sys; sys.path.insert(0, sys.argv[1]); from pathlib import Path; from module_registry import load_module; from module_activity import module_activity; module = load_module(Path(sys.argv[2]));\nwith module_activity(module):\n print('held', flush=True); sys.stdin.readline()"
        child = subprocess.Popen([sys.executable, "-c", code, str(SCRIPTS), str(self.root)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "held")
            with self.assertRaisesRegex(ModuleConfigError, "running job"):
                trash.remove_module(self.workspace, "surgery")
            child.communicate("release\n", timeout=20)
            self.assertEqual(child.returncode, 0)
            trash.remove_module(self.workspace, "surgery")
            self.assertFalse(self.root.exists())
        finally:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=20)

    def test_corrupt_metadata_and_outside_symlinks_cannot_restore_files(self):
        removed = trash.remove_transcript(self.module, "Shock", ["draft"])
        directory = self.root / ".transcriber-cache" / "trash" / removed["id"]
        metadata = directory / trash.META
        payload = json.loads(metadata.read_text())
        metadata.write_text(json.dumps({**payload, "paths": ["../outside.md"]}))
        with self.assertRaisesRegex(ModuleConfigError, "escapes|safe|relative|traversal"):
            trash.restore_trash(self.module, removed["id"])
        metadata.write_text(json.dumps({**payload, "edits": [{"path": "Lecture/Shock.mp3", "before": None, "after": "YQ=="}]}))
        with self.assertRaisesRegex(ModuleConfigError, "Invalid trash"):
            trash.restore_trash(self.module, removed["id"])
        metadata.write_text(json.dumps(payload))
        outside = self.workspace / "outside"
        outside.mkdir()
        self.draft.symlink_to(outside / "draft.md")
        with self.assertRaisesRegex(ModuleConfigError, "symbolic|occupied"):
            trash.restore_trash(self.module, removed["id"])
        self.assertFalse((outside / "draft.md").exists())

    def test_rehidden_lecture_has_one_current_entry_and_legacy_hidden_names_restore(self):
        lecture_registry.hide_lecture(self.module, "Shock")
        first = trash.list_trash(self.module)[0]
        trash.restore_trash(self.module, first["id"])
        lecture_registry.hide_lecture(self.module, "Shock")
        entries = trash.list_trash(self.module)
        self.assertEqual(len(entries), 1)
        self.assertNotEqual(first["id"], entries[0]["id"])
        # Legacy visibility metadata has no manifest; its retained recording names still restore.
        for manifest in (self.root / ".transcriber-cache" / "trash").glob("*/.qabas-entry.json"):
            manifest.write_text(json.dumps({**json.loads(manifest.read_text()), "state": "restored"}))
        legacy = trash.list_trash(self.module)[0]
        self.assertTrue(legacy["id"].startswith("hidden-"))
        trash.restore_trash(self.module, legacy["id"])
        self.assertEqual(load_module(self.root).hidden_recordings, ())

    def test_multipart_verbatims_share_one_entry_and_leave_other_outputs(self):
        self.recording.rename(self.recording.with_name("Shock part 1.mp3"))
        (self.root / "Lecture" / "Shock part 2.mp3").write_bytes(b"second recording")
        first = self.verbatim.with_name("Shock part 1.verbatim.md")
        self.verbatim.rename(first)
        second = self.verbatim.with_name("Shock part 2.verbatim.md")
        second.write_bytes(b"second verbatim")
        self.final.write_text("> **الملفات المعتمدة:** `Shock part 1.mp3`، `Shock part 2.mp3`\n---\n# Guide\n", encoding="utf-8")
        before = {path: path.read_bytes() for path in (first, second, self.final, self.draft, self.index)}
        removed = trash.remove_transcript(self.module, "Shock", ["verbatim"])
        self.assertFalse(first.exists())
        self.assertFalse(second.exists())
        self.assertEqual(removed["paths"], ["Verbatim/Shock part 1.verbatim.md", "Verbatim/Shock part 2.verbatim.md"])
        self.assertEqual(len(trash.list_trash(self.module)), 1)
        for path in (self.final, self.draft, self.index):
            self.assertEqual(path.read_bytes(), before[path])
        trash.restore_trash(self.module, removed["id"])
        for path, contents in before.items():
            self.assertEqual(path.read_bytes(), contents)

    def test_removed_draft_cannot_be_recreated_from_staged_parts_or_old_checks(self):
        cache = self.root / ".transcriber-cache"
        staged = cache / "staged-drafts" / self.draft.name
        staged.mkdir(parents=True)
        (staged / "part-1.md").write_bytes(b"old staged guide")
        checks = cache / "draft-checks" / (self.draft.name + ".json")
        checks.parent.mkdir(parents=True)
        checks.write_bytes(b'{"validate_draft": null}')
        entry = trash.remove_transcript(self.module, "Shock", ["draft"])
        self.assertFalse(staged.exists())
        self.assertFalse(checks.exists())
        self.assertTrue(self.final.exists())
        trash.restore_trash(self.module, entry["id"])
        self.assertEqual((staged / "part-1.md").read_bytes(), b"old staged guide")
        self.assertEqual(checks.read_bytes(), b'{"validate_draft": null}')

    def test_restoring_multiple_index_rows_preserves_later_unrelated_bytes(self):
        self.index.write_bytes(self.index_before + self.row)
        entry = trash.remove_transcript(self.module, "Shock", ["final"])
        added = b"a later note\r\n"
        current = self.index.read_bytes() + added
        self.index.write_bytes(current)
        trash.restore_trash(self.module, entry["id"])
        self.assertEqual(self.index.read_bytes(), self.index_before + self.row + added)

    def test_anki_outputs_follow_the_modules_emoji_and_keep_other_lectures(self):
        config = self.root / "module.json"
        config.write_text(json.dumps({**json.loads(config.read_text()), "output": {"emoji": "🩺"}}))
        self.final.rename(self.final.with_name("Shock 🩺.md"))
        other = self.root / "Anki" / "Other.apkg"
        other.write_bytes(b"other deck")
        blueprint = self.root / ".transcriber-cache" / "anki_blueprints" / "Shock.blueprint.json"
        blueprint.parent.mkdir(parents=True)
        blueprint.write_bytes(b"{}")
        module = load_module(self.root)
        entry = trash.remove_transcript(module, "Shock", ["final"])
        self.assertFalse((self.root / "Anki" / "Shock.apkg").exists())
        self.assertFalse(blueprint.exists())
        self.assertEqual(other.read_bytes(), b"other deck")
        trash.restore_trash(module, entry["id"])
        self.assertEqual((self.root / "Anki" / "Shock.apkg").read_bytes(), b"deck bytes")
        self.assertEqual(blueprint.read_bytes(), b"{}")

    def test_module_restoration_reports_a_busy_admission_gate(self):
        from module_activity import module_gate

        entry = trash.remove_module(self.workspace, "surgery")
        with exclusive_file_lock(module_gate(self.workspace, "surgery")):
            with self.assertRaisesRegex(ModuleConfigError, "surgery.*running job"):
                trash.restore_module(self.workspace, entry["trash_id"])
        self.assertFalse(self.root.exists())
        trash.restore_module(self.workspace, entry["trash_id"])
        self.assertTrue(self.root.is_dir())

    def test_mcp_removal_confirmation_and_activity_guard_use_real_handlers(self):
        import io

        stream = io.StringIO()
        server = mcp_server.Server(workspace=self.workspace, stdout=stream)
        arguments = {"module": "surgery", "lecture": "Shock", "kinds": ["final"]}
        def call(identifier, confirmed=False):
            server.handle({"id": identifier, "method": "tools/call", "params": {
                "name": "remove_transcript", "arguments": {**arguments, "confirmed": confirmed}}})
            return json.loads(stream.getvalue().splitlines()[-1])["result"]
        self.assertTrue(call(1)["isError"])
        self.assertTrue(self.final.exists())
        with module_activity(self.module):
            refused = call(2, True)
            self.assertTrue(refused["isError"])
            self.assertIn("running job", refused["content"][0]["text"])
        removed = call(3, True)
        self.assertFalse(removed["isError"])
        self.assertEqual(self.state(), "draft")
        self.assertEqual(trash.list_trash(self.module)[0]["kind"], "transcript")

    def test_unsafe_ids_are_refused_and_direct_cli_runs_without_a_chat(self):
        for name in ("../escape", "/absolute", "x/y", "x\\y", ""):
            with self.assertRaises(ModuleConfigError):
                trash.restore_module(self.workspace, name)
            with self.assertRaises(ModuleConfigError):
                trash.restore_trash(self.module, name)
        call = subprocess.run([sys.executable, str(SCRIPTS / "mcp_server.py"), "run-transcription", "--workspace", str(self.workspace),
            "--module", "surgery", "--remove-transcript", "Shock", "--transcript-kinds", "draft"], capture_output=True, text=True, timeout=20)
        self.assertEqual(call.returncode, 0, call.stderr)
        self.assertEqual(trash.list_trash(self.module)[0]["id"], json.loads(call.stdout)["id"])
        answer = json.loads(mcp_server._trash_operation({"module": "surgery"}, self.workspace, "remove_module"))
        self.assertTrue(answer["notebook_untouched"])
        restored = json.loads(mcp_server._trash_operation({"trash_id": answer["trash_id"]}, self.workspace, "restore_module"))
        self.assertEqual(restored["module"], "surgery")


if __name__ == "__main__":
    unittest.main()
