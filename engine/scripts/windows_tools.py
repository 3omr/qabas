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
    scoop = os.environ.get("SCOOP")
    if not scoop and os.environ.get("USERPROFILE"):
        scoop = ntpath.join(os.environ["USERPROFILE"], "scoop")
    if scoop:
        paths.extend([
            ntpath.join(scoop, "shims"),
            ntpath.join(scoop, "apps", "libreoffice", "current", "LibreOffice", "program"),
        ])
    unique: list[str] = []
    seen: set[str] = set()
    for group in paths:
        for path in group.split(";"):
            if path and ntpath.normcase(path) not in seen:
                seen.add(ntpath.normcase(path))
                unique.append(path)
    os.environ["PATH"] = ";".join(unique)
