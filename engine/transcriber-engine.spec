# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller onefile build for the re-entrant transcriber engine."""

from __future__ import annotations

import os
import platform
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules


ROOT = Path(SPECPATH).resolve()
SCRIPTS = ROOT / "scripts"


def _target_triple() -> str:
    supplied = os.environ.get("TRANSCRIBER_TARGET_TRIPLE", "").strip()
    if supplied:
        return supplied
    architecture = {
        "amd64": "x86_64",
        "arm64": "aarch64",
        "aarch64": "aarch64",
        "x86_64": "x86_64",
    }.get(platform.machine().casefold())
    if architecture is None:
        raise SystemExit(f"Unsupported host architecture: {platform.machine()}")
    system = platform.system().casefold()
    if system == "linux":
        return f"{architecture}-unknown-linux-gnu"
    if system == "darwin":
        return f"{architecture}-apple-darwin"
    if system == "windows":
        return f"{architecture}-pc-windows-msvc"
    raise SystemExit(f"Unsupported host operating system: {platform.system()}")


sys.path.insert(0, str(SCRIPTS))
target_triple = _target_triple()
output_name = f"transcriber-engine-{target_triple}"

# Imports inside the three user-facing entry points are intentionally lazy.
# Listing every local module makes those imports available after the dispatcher
# selects a subcommand from inside the frozen executable.
local_modules = {
    path.stem for path in SCRIPTS.glob("*.py") if path.stem != "mcp_server"
}
hiddenimports = sorted(local_modules | set(collect_submodules("engines")))

# universal_transcribe.py is loaded by file path by run_transcription.py, so it
# must exist beside the extracted entry-point modules in a onefile build.
datas = [
    (str(SCRIPTS / "universal_transcribe.py"), "."),
    (str(ROOT.parent / "package.json"), "."),
    (str(ROOT / "references"), "references"),
]
binaries: list[tuple[str, str]] = []

# These formats are reachable from run_transcription.py and must keep working
# without a Python installation. faster-whisper and genanki are deliberately
# excluded below: the first is a large optional local engine, and the second
# belongs to the separate transcriber-anki entry point, not this binary.
for package_name in ("reportlab", "openpyxl", "docx"):
    try:
        package_datas, package_binaries, package_hiddenimports = collect_all(
            package_name
        )
    except ImportError as error:
        raise SystemExit(
            "Missing frozen-build package "
            f"{package_name}; install requirements-build.txt first."
        ) from error
    datas.extend(package_datas)
    binaries.extend(package_binaries)
    hiddenimports.extend(package_hiddenimports)

a = Analysis(
    [str(SCRIPTS / "mcp_server.py")],
    pathex=[str(SCRIPTS)],
    binaries=binaries,
    datas=datas,
    hiddenimports=sorted(set(hiddenimports)),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["faster_whisper", "genanki"],
    noarchive=False,
)
pyz = PYZ(a.pure)

# The equivalent of `python -u`, and not cosmetic. run_transcription.py spawns
# the pipeline worker and reads its output as it arrives, which is what drives
# the live phase progress; a frozen worker with block-buffered stdout would
# deliver an hour of run in one burst at the end. The checkout path passes -u
# as an interpreter option, which a frozen executable has no argv for -- this
# is where the same thing is said to the bootloader instead.
options = [("u", None, "OPTION")]

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    options,
    name=output_name,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)
