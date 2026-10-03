import contextlib
import io
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import engine_dispatch  # noqa: E402
import mcp_server  # noqa: E402


class CommandBuilderTests(unittest.TestCase):
    @patch.object(sys, "frozen", False, create=True)
    def test_checkout_command_uses_interpreter_and_script_path(self) -> None:
        command = engine_dispatch.build_entrypoint_command(
            "run-transcription", ("--module", "toxo")
        )

        self.assertEqual(command[0], sys.executable)
        self.assertEqual(Path(command[1]), SCRIPTS_DIR / "run_transcription.py")
        self.assertEqual(command[2:], ["--module", "toxo"])

    @patch.object(sys, "frozen", True, create=True)
    def test_frozen_command_uses_executable_subcommand_and_arguments(self) -> None:
        command = engine_dispatch.build_entrypoint_command(
            "manage-modules", ("--workspace", "C:/Study", "list")
        )

        self.assertEqual(
            command,
            [sys.executable, "manage-modules", "--workspace", "C:/Study", "list"],
        )

    @patch.object(sys, "frozen", True, create=True)
    def test_mcp_launcher_uses_the_frozen_command_shape(self) -> None:
        command = mcp_server._launcher(Path("workspace"), "--doctor")

        self.assertEqual(
            command,
            [
                sys.executable,
                "run-transcription",
                "--workspace",
                "workspace",
                "--no-update-check",
                "--doctor",
            ],
        )

    def test_mcp_module_creation_uses_the_frozen_manager_subcommand(self) -> None:
        completed = types.SimpleNamespace(returncode=0, stdout="created", stderr="")
        with patch.object(sys, "frozen", True, create=True):
            with patch.object(mcp_server.subprocess, "run", return_value=completed) as run:
                mcp_server._create_module(
                    {"module": "toxo", "display_name": "Toxicology"},
                    Path("workspace"),
                )

        command = run.call_args.args[0]
        self.assertEqual(command[:2], [sys.executable, "manage-modules"])
        self.assertIn("create", command)


class DispatchTests(unittest.TestCase):
    def _fake_module(
        self, module_name: str, calls: dict[str, list[str]]
    ) -> types.ModuleType:
        module = types.ModuleType(module_name)

        def main() -> int:
            calls[module_name] = list(sys.argv[1:])
            return 0

        module.main = main  # type: ignore[attr-defined]
        return module

    def test_each_subcommand_reaches_its_entry_point_with_all_arguments(self) -> None:
        calls: dict[str, list[str]] = {}
        fake_modules = {
            target.module_name: self._fake_module(target.module_name, calls)
            for name, target in engine_dispatch.ENTRYPOINTS.items()
            if name != "mcp-server"
        }

        def default_main() -> int:
            calls["mcp_server"] = list(sys.argv[1:])
            return 0

        with patch.dict(sys.modules, fake_modules):
            for name, target in engine_dispatch.ENTRYPOINTS.items():
                with self.subTest(entrypoint=name):
                    arguments = [name, "--workspace", "/study", "--flag", "value"]
                    result = engine_dispatch.dispatch_entrypoint(
                        arguments, "mcp-server", default_main
                    )

                    self.assertEqual(result, 0)
                    self.assertEqual(
                        calls[target.module_name],
                        ["--workspace", "/study", "--flag", "value"],
                    )

    def test_direct_style_options_keep_the_default_entry_point(self) -> None:
        calls: list[str] = []

        def default_main() -> int:
            calls.extend(sys.argv[1:])
            return 0

        result = engine_dispatch.dispatch_entrypoint(
            ["--workspace", "/study"], "mcp-server", default_main
        )

        self.assertEqual(result, 0)
        self.assertEqual(calls, ["--workspace", "/study"])

    def test_unknown_subcommand_names_every_valid_subcommand(self) -> None:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            result = engine_dispatch.dispatch_entrypoint(
                ["not-a-command"], "mcp-server", lambda: 0
            )

        self.assertEqual(result, 2)
        message = stderr.getvalue()
        for name in engine_dispatch.ENTRYPOINTS:
            self.assertIn(name, message)


if __name__ == "__main__":
    unittest.main()
