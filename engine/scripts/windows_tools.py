"""Refresh tool discovery in engine children after a Windows installation."""

import ntpath
import os
import sys


def refresh_tool_path() -> None:
    """Include registered system/user PATH and uv/WinGet links on Windows."""
    if sys.platform != "win32":
        return
    import winreg

    paths = [os.environ.get("PATH", "")]
    for hive, key in (
        (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
        (winreg.HKEY_CURRENT_USER, "Environment"),
    ):
        try:
            with winreg.OpenKey(hive, key) as handle:
                value, _ = winreg.QueryValueEx(handle, "Path")
        except FileNotFoundError:
            # Either registry PATH is optional; retain the inherited PATH.
            continue
        paths.append(os.path.expandvars(value))
    for variable, suffix in (
        ("USERPROFILE", (".local", "bin")),
        ("LOCALAPPDATA", ("Microsoft", "WinGet", "Links")),
        ("LOCALAPPDATA", ("agy", "bin")),
    ):
        root = os.environ.get(variable)
        if root:
            paths.append(ntpath.join(root, *suffix))
    os.environ["PATH"] = ";".join(paths)
