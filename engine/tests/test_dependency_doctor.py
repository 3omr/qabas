import io
import json
import shlex
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS_DIR = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import agy_writer
import dependency_doctor


class TestDependencyDoctor(unittest.TestCase):
    def test_all_present_reports_success(self) -> None:
        with patch.object(dependency_doctor.shutil, "which", return_value="/usr/bin/x"), \
             patch.object(
                 dependency_doctor.importlib.util, "find_spec", return_value=object()
             ):
            out = io.StringIO()
            self.assertEqual(dependency_doctor.report(out), 0)
        self.assertIn("All required tooling is present", out.getvalue())

    def test_missing_required_tool_fails_with_an_install_hint(self) -> None:
        def only_poppler(name: str):
            return "/usr/bin/" + name if name in {"pdftotext", "pdfinfo"} else None

        with patch.object(dependency_doctor.shutil, "which", side_effect=only_poppler):
            out = io.StringIO()
            self.assertEqual(dependency_doctor.report(out), 1)

        text = out.getvalue()
        self.assertIn("Missing required tooling", text)
        self.assertIn("nlm", text)
        # The hint names the client the app can actually install: a pipx
        # package needs no elevation, where tmc/nlm ships no prebuilt binary
        # and would send a student to install a Go toolchain first.
        self.assertIn("pipx install notebooklm-mcp-cli", text)
        self.assertNotIn("tmc/nlm", text)

    def test_missing_optional_tool_does_not_fail(self) -> None:
        def no_ffmpeg(name: str):
            return None if name == "ffmpeg" else "/usr/bin/" + name

        with patch.object(dependency_doctor.shutil, "which", side_effect=no_ffmpeg), \
             patch.object(
                 dependency_doctor.importlib.util, "find_spec", return_value=object()
             ):
            out = io.StringIO()
            self.assertEqual(dependency_doctor.report(out), 0)

        text = out.getvalue()
        self.assertIn("Optional tooling not installed", text)
        self.assertIn("ffmpeg", text)

    def test_every_dependency_declares_a_purpose_and_install_hint(self) -> None:
        for dependency in dependency_doctor.DEPENDENCIES:
            self.assertTrue(dependency.purpose, dependency.name)
            self.assertTrue(dependency.install_hint, dependency.name)
            self.assertTrue(
                dependency.executables or dependency.python_module,
                f"{dependency.name} has nothing to look for",
            )

    def test_every_platform_install_hint_is_a_command_and_not_prose(self) -> None:
        # The desktop app's install button spawns this string directly, so it
        # has to be one executable command on each platform it ships to. The
        # two shapes that break it both used to be in here: a "-- then run
        # `nlm login`" tail, and the `apt ... / brew ...` pair that reads as a
        # choice to a person and as a path to a shell.
        for dependency in dependency_doctor.DEPENDENCIES:
            for platform in ("linux", "darwin", "win32"):
                with self.subTest(dependency=dependency.name, platform=platform), \
                     patch.object(dependency_doctor.sys, "platform", platform):
                    hint = dependency.install_hint_for_platform()
                    self.assertNotIn(" -- ", hint, dependency.name)
                    self.assertNotIn(" / ", hint, dependency.name)
                    self.assertNotIn("`", hint, dependency.name)
                    self.assertEqual(
                        hint, hint.strip(), f"{dependency.name} is padded"
                    )
                    self.assertTrue(
                        shlex.split(hint),
                        f"{dependency.name} has no command on {platform}",
                    )

    def test_windows_python_tools_have_installable_isolated_commands(self) -> None:
        with patch.object(dependency_doctor.sys, "platform", "win32"):
            hints = {item.name: item.install_hint_for_platform() for item in dependency_doctor.DEPENDENCIES}
        self.assertEqual(hints["nlm"], "uv tool install --python 3.12 notebooklm-mcp-cli")
        self.assertEqual(hints["ocrmypdf"], "uv tool install --python 3.12 ocrmypdf")
        self.assertEqual(hints["tesseract"], "winget install --exact --id tesseract-ocr.tesseract")

    def test_report_shows_the_current_platform_install_hint(self) -> None:
        expected_hints = {
            "linux": "apt install poppler-utils",
            "darwin": "brew install poppler",
            "win32": "winget install oschwartz10612.Poppler",
        }
        for platform, expected_hint in expected_hints.items():
            with self.subTest(platform=platform), \
                 patch.object(dependency_doctor.sys, "platform", platform), \
                     patch.object(dependency_doctor, "refresh_tool_path"), \
                 patch.object(dependency_doctor.shutil, "which", return_value=None), \
                 patch.object(
                     dependency_doctor.importlib.util, "find_spec", return_value=None
                 ), \
                 patch.object(dependency_doctor.glob, "glob", return_value=[]):
                out = io.StringIO()
                dependency_doctor.report(out)

            text = out.getvalue()
            self.assertIn(f"Install: {expected_hint}", text)
            for other_hint in expected_hints.values():
                if other_hint != expected_hint:
                    self.assertNotIn(other_hint, text)

    def test_every_executable_dependency_declares_a_probe(self) -> None:
        # A tool with no probe can only ever be checked for presence, which is
        # the weakness --doctor-live exists to fix. Python packages are probed
        # by importing them, so they need no argv.
        for dependency in dependency_doctor.DEPENDENCIES:
            if dependency.python_module:
                continue
            self.assertIsNotNone(
                dependency.probe,
                f"{dependency.name} cannot be liveness-checked",
            )


class TestLivenessProbes(unittest.TestCase):
    def test_probes_do_not_run_unless_live_is_requested(self) -> None:
        def fail_loudly(*_args: object, **_kwargs: object):
            raise AssertionError("the default report must not shell out")

        with patch.object(dependency_doctor.shutil, "which", return_value="/usr/bin/x"), \
             patch.object(
                 dependency_doctor.importlib.util, "find_spec", return_value=object()
             ), \
             patch.object(dependency_doctor.subprocess, "run", side_effect=fail_loudly), \
             patch.object(agy_writer, "binary_path", return_value=None):
            # agy reports its version on the default report when installed;
            # this test is about the liveness probes, not the optional writer.
            out = io.StringIO()
            self.assertEqual(dependency_doctor.report(out), 0)

        self.assertIn("--doctor-live", out.getvalue())

    def test_a_healthy_probe_passes_and_says_the_tooling_works(self) -> None:
        def succeed(command, **_kwargs: object):
            return subprocess.CompletedProcess(command, 0, "ok", "")

        with patch.object(dependency_doctor.shutil, "which", return_value="/usr/bin/x"), \
             patch.object(
                 dependency_doctor.importlib, "import_module", return_value=object()
             ), \
             patch.object(dependency_doctor.subprocess, "run", side_effect=succeed):
            out = io.StringIO()
            self.assertEqual(dependency_doctor.report(out, live=True), 0)

        self.assertIn("present and working", out.getvalue())

    def test_an_installed_but_unauthenticated_nlm_fails_the_check(self) -> None:
        # The whole point of --doctor-live: nlm is on PATH, so the presence
        # check is green, but it cannot reach NotebookLM.
        def fail_only_nlm(command, **_kwargs: object):
            if command[0].endswith("nlm"):
                return subprocess.CompletedProcess(command, 1, "", "not authenticated")
            return subprocess.CompletedProcess(command, 0, "ok", "")

        def which(name: str):
            return "/usr/bin/" + name

        with patch.object(dependency_doctor.shutil, "which", side_effect=which), \
             patch.object(
                 dependency_doctor.importlib, "import_module", return_value=object()
             ), \
             patch.object(dependency_doctor.subprocess, "run", side_effect=fail_only_nlm):
            out = io.StringIO()
            self.assertEqual(dependency_doctor.report(out, live=True), 1)

        text = out.getvalue()
        self.assertIn("installed but not working", text)
        self.assertIn("not authenticated", text)
        # `nlm login`, not `nlm auth`: no nlm build has an `auth` subcommand,
        # so the advice this screen gave was advice that fails.
        self.assertIn("nlm login", text)
        self.assertNotIn("nlm auth", text)

    def test_the_nlm_probe_is_the_call_the_engine_actually_makes(self) -> None:
        commands: list[list[str]] = []

        def capture(command, **_kwargs: object):
            commands.append(list(command))
            return subprocess.CompletedProcess(command, 0, "[]", "")

        with patch.object(dependency_doctor.shutil, "which", side_effect=lambda n: "/usr/bin/" + n), \
             patch.object(
                 dependency_doctor.importlib, "import_module", return_value=object()
             ), \
             patch.object(dependency_doctor.subprocess, "run", side_effect=capture):
            dependency_doctor.report(io.StringIO(), live=True)

        self.assertIn(["/usr/bin/nlm", "notebook", "list"], commands)

    def test_a_probe_that_times_out_is_reported_rather_than_hanging_the_check(self) -> None:
        def time_out(command, **_kwargs: object):
            raise subprocess.TimeoutExpired(command, 45)

        with patch.object(dependency_doctor.shutil, "which", return_value="/usr/bin/nlm"), \
             patch.object(
                 dependency_doctor.importlib, "import_module", return_value=object()
             ), \
             patch.object(dependency_doctor.subprocess, "run", side_effect=time_out):
            out = io.StringIO()
            self.assertEqual(dependency_doctor.report(out, live=True), 1)

        self.assertIn("timed out", out.getvalue())

    def test_a_python_package_that_is_present_but_will_not_import_is_unhealthy(self) -> None:
        def explode(name: str):
            raise ImportError(f"{name} has a broken native extension")

        with patch.object(dependency_doctor.shutil, "which", return_value="/usr/bin/x"), \
             patch.object(dependency_doctor.importlib.util, "find_spec", return_value=object()), \
             patch.object(dependency_doctor.importlib, "import_module", side_effect=explode), \
             patch.object(
                 dependency_doctor.subprocess,
                 "run",
                 side_effect=lambda c, **k: subprocess.CompletedProcess(c, 0, "", ""),
             ):
            out = io.StringIO()
            # genanki and reportlab are optional, so a broken import warns
            # loudly without failing the run.
            self.assertEqual(dependency_doctor.report(out, live=True), 0)

        text = out.getvalue()
        self.assertIn("Optional tooling installed but not working", text)
        self.assertIn("broken native extension", text)

    def test_an_unsupported_python_version_fails_the_check(self) -> None:
        with patch.object(dependency_doctor.shutil, "which", return_value="/usr/bin/x"), \
             patch.object(
                 dependency_doctor.importlib.util, "find_spec", return_value=object()
             ), \
             patch.object(dependency_doctor.sys, "version_info", (3, 9, 18)):
            out = io.StringIO()
            self.assertEqual(dependency_doctor.report(out), 1)

        self.assertIn("3.10+ is required", out.getvalue())


class TestWindowsResolution(unittest.TestCase):
    def test_libreoffice_uses_windows_program_files_candidates(self) -> None:
        dependency = next(
            item for item in dependency_doctor.DEPENDENCIES if item.name == "libreoffice"
        )
        expected_path = r"C:\Program Files\LibreOffice\program\soffice.exe"

        def fake_glob(pattern: str):
            return [expected_path] if pattern == expected_path else []

        with patch.object(dependency_doctor.sys, "platform", "win32"), \
             patch.dict(
                 dependency_doctor.os.environ,
                 {
                     "ProgramFiles": r"C:\Program Files",
                     "ProgramFiles(x86)": r"C:\Program Files (x86)",
                 },
             ), \
             patch.object(dependency_doctor.shutil, "which", return_value=None), \
             patch.object(dependency_doctor.glob, "glob", side_effect=fake_glob):
            self.assertEqual(dependency.resolve(), expected_path)

    def test_ghostscript_globs_the_installed_version(self) -> None:
        dependency = next(
            item for item in dependency_doctor.DEPENDENCIES if item.name == "ghostscript"
        )
        expected_path = r"C:\Program Files\gs\gs10.03.1\bin\gswin64c.exe"
        patterns: list[str] = []

        def fake_glob(pattern: str):
            patterns.append(pattern)
            if pattern == r"C:\Program Files\gs\*\bin\gswin64c.exe":
                return [expected_path]
            return []

        with patch.object(dependency_doctor.sys, "platform", "win32"), \
             patch.dict(
                 dependency_doctor.os.environ,
                 {
                     "ProgramFiles": r"C:\Program Files",
                     "ProgramFiles(x86)": r"C:\Program Files (x86)",
                 },
             ), \
             patch.object(dependency_doctor.shutil, "which", return_value=None), \
             patch.object(dependency_doctor.glob, "glob", side_effect=fake_glob):
            self.assertEqual(dependency.resolve(), expected_path)

        self.assertIn(r"C:\Program Files\gs\*\bin\gswin64c.exe", patterns)
        self.assertNotIn(r"C:\Program Files\gs\gs10.03.1\bin\gswin64c.exe", patterns)

    def test_two_installed_ghostscripts_resolve_to_the_newer_one(self) -> None:
        # Both orderings a filesystem might hand back must give the same answer,
        # and string order would give the wrong one: "gs9.56" sorts above
        # "gs10.03.1" because '9' beats '1'.
        dependency = next(
            item for item in dependency_doctor.DEPENDENCIES if item.name == "ghostscript"
        )
        older = r"C:\Program Files\gs\gs9.56.1\bin\gswin64c.exe"
        newer = r"C:\Program Files\gs\gs10.03.1\bin\gswin64c.exe"

        for found in ([older, newer], [newer, older]):
            with self.subTest(order=found), \
                 patch.object(dependency_doctor.sys, "platform", "win32"), \
                 patch.dict(
                     dependency_doctor.os.environ,
                     {"ProgramFiles": r"C:\Program Files"},
                 ), \
                 patch.object(dependency_doctor.shutil, "which", return_value=None), \
                 patch.object(
                     dependency_doctor.glob, "glob",
                     side_effect=lambda pattern, hits=found: hits if "gswin64c" in pattern else [],
                 ):
                self.assertEqual(dependency.resolve(), newer)

    def test_windows_candidates_are_not_consulted_on_linux(self) -> None:
        dependency = next(
            item for item in dependency_doctor.DEPENDENCIES if item.name == "ghostscript"
        )
        with patch.object(dependency_doctor.sys, "platform", "linux"), \
             patch.object(dependency_doctor.shutil, "which", return_value=None), \
             patch.object(
                 dependency_doctor.glob,
                 "glob",
                 side_effect=AssertionError("Windows candidates must not be checked"),
             ):
            self.assertIsNone(dependency.resolve())


class TestJsonReport(unittest.TestCase):
    def test_json_and_human_reports_share_missing_required_verdict(self) -> None:
        with patch.object(dependency_doctor.shutil, "which", return_value=None), \
             patch.object(
                 dependency_doctor.importlib.util, "find_spec", return_value=None
             ):
            human = dependency_doctor.report(io.StringIO())
            json_out = io.StringIO()
            structured = dependency_doctor.report_json(json_out)

        payload = json.loads(json_out.getvalue())
        self.assertEqual(structured, human)
        self.assertEqual(payload["exit_code"], human)
        self.assertEqual(payload["ok"], human == 0)
        self.assertTrue(payload["python"]["supported"])

    def test_json_and_human_reports_share_probe_failure_verdict(self) -> None:
        def which(name: str):
            return "/usr/bin/" + name

        def fail_only_nlm(command, **_kwargs: object):
            if command[0].endswith("/nlm"):
                return subprocess.CompletedProcess(command, 1, "", "not authenticated")
            return subprocess.CompletedProcess(command, 0, "ok", "")

        with patch.object(dependency_doctor.shutil, "which", side_effect=which), \
             patch.object(
                 dependency_doctor.importlib.util, "find_spec", return_value=object()
             ), \
             patch.object(
                 dependency_doctor.importlib, "import_module", return_value=object()
             ), \
             patch.object(
                 dependency_doctor.subprocess, "run", side_effect=fail_only_nlm
             ):
            human = dependency_doctor.report(io.StringIO(), live=True)
            json_out = io.StringIO()
            structured = dependency_doctor.report_json(json_out, live=True)

        payload = json.loads(json_out.getvalue())
        nlm = next(item for item in payload["dependencies"] if item["name"] == "nlm")
        self.assertEqual(structured, human)
        self.assertEqual(payload["exit_code"], human)
        self.assertFalse(payload["ok"])
        self.assertEqual(nlm["probe"]["failure"], "not authenticated")
        self.assertFalse(nlm["probe"]["passed"])


if __name__ == "__main__":
    unittest.main()
