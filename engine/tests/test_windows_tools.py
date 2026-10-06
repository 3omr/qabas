"""Windows engine children discover tools installed after the app launched."""

import os
import sys
import types
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import windows_tools


class TestWindowsToolPath(unittest.TestCase):
    def test_refreshes_registry_paths_and_user_tool_links(self):
        registry = types.SimpleNamespace(
            HKEY_LOCAL_MACHINE="machine", HKEY_CURRENT_USER="user",
            OpenKey=lambda hive, key: nullcontext(hive),
            QueryValueEx=lambda handle, name: ("C:\\Fresh\\" + handle, 1),
        )
        environment = {"PATH": "C:\\Old", "USERPROFILE": "C:\\Users\\Student", "LOCALAPPDATA": "C:\\Local"}
        with patch.dict(os.environ, environment, clear=True), patch.dict(sys.modules, {"winreg": registry}), patch.object(sys, "platform", "win32"):
            windows_tools.refresh_tool_path()
            first = os.environ["PATH"]
            windows_tools.refresh_tool_path()
            self.assertEqual(os.environ["PATH"], first)
            self.assertEqual(os.environ["PATH"].split(";"), [
                "C:\\Old", "C:\\Fresh\\machine", "C:\\Fresh\\user",
                "C:\\Users\\Student\\.local\\bin", "C:\\Local\\Microsoft\\WinGet\\Links", "C:\\Local\\agy\\bin",
            ])

    def test_missing_registry_paths_preserve_inherited_path(self):
        def missing(*args):
            raise FileNotFoundError()
        registry = types.SimpleNamespace(HKEY_LOCAL_MACHINE=1, HKEY_CURRENT_USER=2, OpenKey=missing)
        with patch.dict(os.environ, {"PATH": "old"}, clear=True), patch.dict(sys.modules, {"winreg": registry}), patch.object(sys, "platform", "win32"):
            windows_tools.refresh_tool_path()
            self.assertEqual(os.environ["PATH"], "old")

    def test_posix_does_not_read_the_windows_registry(self):
        with patch.dict(os.environ, {"PATH": "original"}, clear=True), patch.object(sys, "platform", "linux"):
            windows_tools.refresh_tool_path()
            self.assertEqual(os.environ["PATH"], "original")
