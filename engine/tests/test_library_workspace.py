"""App-owned workspace resolution matches the Host default and developer override."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from library_workspace import prepare_workspace, workspace_path


class LibraryWorkspaceTests(unittest.TestCase):
    def test_fixed_home_library_ignores_harness_home(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            with patch.dict(os.environ, {"HOME": str(home), "USERPROFILE": str(home), "DSH_HOME": str(home / "harness"), "TRANSCRIBER_WORKSPACE": "   "}):
                self.assertEqual(workspace_path(), home / "qabas" / "Qabas Library")
                self.assertTrue((prepare_workspace(workspace_path()) / "modules").is_dir())

    def test_developer_override_expands_current_user_home(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            with patch.dict(os.environ, {"HOME": str(home), "USERPROFILE": str(home), "TRANSCRIBER_WORKSPACE": "~/developer-library"}):
                self.assertEqual(workspace_path(), home / "developer-library")


class LegacyModuleAdoptionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.workspace = self.home / "qabas" / "Qabas Library"
        self.legacy = self.home / "Qabas Library"
        environment = patch.dict(os.environ, {"HOME": str(self.home), "USERPROFILE": str(self.home), "TRANSCRIBER_WORKSPACE": ""})
        environment.start()
        self.addCleanup(environment.stop)

    def module(self, workspace, name):
        import json
        root = workspace / "modules" / name
        for folder in ("Lecture", "Questions", "Transcripts"):
            (root / folder).mkdir(parents=True)
        (root / "module.json").write_text(json.dumps({"schema_version": 1, "module_id": name,
            "display_name": name, "notebook": {"id": "notebook-kept"}}), encoding="utf-8")
        (root / "Lecture" / "recording.mp3").write_bytes(b"recorded lecture")
        (root / "Questions" / "past-paper.txt").write_bytes(b"original exam paper\r\n")
        return root

    def files(self, root):
        return {path.relative_to(root): path.read_bytes() for path in root.rglob("*") if path.is_file()}

    def test_adopts_legacy_modules_preserving_source_and_nine_new_modules(self):
        import json

        import mcp_server
        source = self.module(self.legacy, "surgery")
        original = self.files(source)
        existing = {name: self.files(self.module(self.workspace, name)) for name in
                    ("one", "two", "three", "four", "five", "six", "seven", "eight", "nine")}
        prepare_workspace(self.workspace)
        self.assertEqual(self.files(source), original)
        self.assertEqual(self.files(self.workspace / "modules" / "surgery"), original)
        for name, contents in existing.items():
            self.assertEqual(self.files(self.workspace / "modules" / name), contents)
        inventory = json.loads(mcp_server._list_library({"remote": "skip"}, self.workspace))
        self.assertEqual(len(inventory["modules"]), 10)
        for module in inventory["modules"]:
            self.assertNotIn("error", module)
            self.assertTrue(Path(module["root"]).is_relative_to(self.workspace))
            for lecture in module.get("lectures", []):
                self.assertTrue(all(Path(path).is_relative_to(self.workspace) for path in lecture.get("paths", [])))

    def test_equal_duplicate_is_accepted_and_divergent_paper_is_refused(self):
        import shutil
        source = self.module(self.legacy, "surgery")
        target = self.workspace / "modules" / "surgery"
        shutil.copytree(source, target)
        changed = target / "Questions" / "past-paper.txt"
        changed.write_bytes(b"different paper")
        with self.assertRaisesRegex(RuntimeError, "collision"):
            prepare_workspace(self.workspace)
        self.assertEqual(changed.read_bytes(), b"different paper")
        self.assertEqual((source / "Questions" / "past-paper.txt").read_bytes(), b"original exam paper\r\n")
        changed.write_bytes(b"original exam paper\r\n")
        prepare_workspace(self.workspace)
        self.assertEqual(self.files(source), self.files(target))

    def test_active_source_module_refuses_adoption(self):
        from module_activity import module_activity
        from module_registry import load_module
        source = self.module(self.legacy, "surgery")
        with module_activity(load_module(source)):
            with self.assertRaisesRegex(RuntimeError, "running job"):
                prepare_workspace(self.workspace)
        self.assertFalse((self.workspace / "modules" / "surgery" / "module.json").exists())

    def test_collision_checks_bytes_again_on_retry_with_preserved_size_and_timestamp(self):
        import shutil

        source = self.module(self.legacy, "surgery")
        target = self.workspace / "modules" / "surgery"
        shutil.copytree(source, target)
        paper = target / "Questions" / "past-paper.txt"
        paper.write_bytes(b"different exam paper")
        with self.assertRaisesRegex(RuntimeError, "collision"):
            prepare_workspace(self.workspace)
        paper.write_bytes((source / "Questions" / "past-paper.txt").read_bytes())
        recording = target / "Lecture" / "recording.mp3"
        metadata = recording.stat()
        recording.write_bytes(b"x" * metadata.st_size)
        os.utime(recording, ns=(metadata.st_atime_ns, metadata.st_mtime_ns))
        with self.assertRaisesRegex(RuntimeError, "collision"):
            prepare_workspace(self.workspace)

    def test_developer_override_skips_legacy_adoption(self):
        self.module(self.legacy, "surgery")
        with patch.dict(os.environ, {"TRANSCRIBER_WORKSPACE": str(self.workspace)}):
            prepare_workspace(self.workspace)
        self.assertEqual(list((self.workspace / "modules").iterdir()), [])

    def test_completed_adoption_keeps_later_target_edits_and_removals(self):
        import shutil

        source = self.module(self.legacy, "surgery")
        prepare_workspace(self.workspace)
        target = self.workspace / "modules" / "surgery"
        (target / "Questions" / "past-paper.txt").write_bytes(b"updated in new library")
        (target / "Lecture" / "recording.mp3").unlink()
        prepare_workspace(self.workspace)
        self.assertEqual((target / "Questions" / "past-paper.txt").read_bytes(), b"updated in new library")
        self.assertFalse((target / "Lecture" / "recording.mp3").exists())
        self.assertEqual((source / "Questions" / "past-paper.txt").read_bytes(), b"original exam paper\r\n")
        shutil.rmtree(target)
        prepare_workspace(self.workspace)
        self.assertFalse(target.exists())

    def test_retains_user_configuration_but_excludes_generated_inventory_and_locks(self):
        source = self.module(self.legacy, "surgery")
        cache = source / ".transcriber-cache"
        cache.mkdir()
        (cache / "remote-sources.json").write_text("generated inventory", encoding="utf-8")
        (cache / "idle.lock").touch()
        (source / "preferences.yml").write_bytes(b"custom setting: retained\n")
        original = self.files(source)
        prepare_workspace(self.workspace)
        target = self.workspace / "modules" / "surgery"
        self.assertEqual(self.files(source), original)
        self.assertEqual((target / "preferences.yml").read_bytes(), b"custom setting: retained\n")
        self.assertFalse((target / ".transcriber-cache" / "remote-sources.json").exists())
        self.assertFalse((target / ".transcriber-cache" / "idle.lock").exists())

    def test_preserves_user_lock_files_outside_engine_lease_locations(self):
        source = self.module(self.legacy, "surgery")
        preserved = {
            "Lecture/notes.lock": b"lecture notes",
            "Questions/paper.lock": b"original paper",
            "Transcripts/notes.lock": b"student transcript notes",
            "preferences.lock": b"user configuration",
            "Lecture/.web-figures.lock": b"student file",
            "Transcripts/Figures/lecture/notes.lock": b"figure notes",
            ".transcriber-cache/trash/entry/Lecture/paper.lock": b"recoverable original",
        }
        for name, contents in preserved.items():
            path = source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(contents)
        generated = (".transcriber-cache/locks/activity-idle.lock", "Transcripts/.transcriber-index.lock",
                     "Transcripts/Figures/lecture/.web-figures.lock")
        for name in generated:
            path = source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        original = self.files(source)
        prepare_workspace(self.workspace)
        target = self.workspace / "modules" / "surgery"
        self.assertEqual(self.files(source), original)
        for name, contents in preserved.items():
            self.assertTrue((target / name).is_file(), f"Missing adopted user file: {name}")
            self.assertEqual((target / name).read_bytes(), contents)
        for name in generated:
            self.assertFalse((target / name).exists())

    def test_corrupt_checkpoint_refuses_adoption_without_touching_target(self):
        self.module(self.legacy, "surgery")
        prepare_workspace(self.workspace)
        target = self.workspace / "modules" / "surgery"
        contents = self.files(target)
        checkpoint = next((self.workspace / ".qabas-adoption").glob("*.done"))
        checkpoint.write_text("incomplete", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "checkpoint"):
            prepare_workspace(self.workspace)
        self.assertEqual(self.files(target), contents)

    def test_active_target_module_refuses_adoption(self):
        from module_activity import module_activity
        from module_registry import load_module
        self.module(self.legacy, "surgery")
        target = self.module(self.workspace, "surgery")
        with module_activity(load_module(target)):
            with self.assertRaisesRegex(RuntimeError, "running job"):
                prepare_workspace(self.workspace)
        prepare_workspace(self.workspace)

    def test_linked_source_file_is_refused_without_copying(self):
        source = self.module(self.legacy, "surgery")
        link = source / "Lecture" / "linked.mp3"
        try:
            link.symlink_to(source / "Lecture" / "recording.mp3")
        except OSError as error:
            self.skipTest(f"Host does not allow symlinks: {error}")
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            prepare_workspace(self.workspace)
        self.assertFalse((self.workspace / "modules" / "surgery").exists())

    def test_linked_default_root_is_refused_even_after_argument_resolution(self):
        self.module(self.legacy, "surgery")
        outside = self.home / "outside"
        outside.mkdir()
        self.workspace.parent.mkdir()
        try:
            self.workspace.symlink_to(outside, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"Host does not allow symlinks: {error}")
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            prepare_workspace(workspace_path())
        self.assertFalse((outside / "modules").exists())

    def test_interrupted_publication_retries_without_partial_file_bytes(self):
        import library_workspace
        source = self.module(self.legacy, "surgery")
        original_link = library_workspace.os.link
        published = []

        def interrupt_after_first_file(staged, destination):
            if published:
                raise OSError("interrupted publication")
            original_link(staged, destination)
            published.append(destination)

        with patch.object(library_workspace.os, "link", interrupt_after_first_file):
            with self.assertRaisesRegex(OSError, "interrupted publication"):
                prepare_workspace(self.workspace)
        self.assertEqual(published[0].read_bytes(), (source / published[0].relative_to(self.workspace / "modules" / "surgery")).read_bytes())
        prepare_workspace(self.workspace)
        self.assertEqual(self.files(source), self.files(self.workspace / "modules" / "surgery"))


if __name__ == "__main__":
    unittest.main()
