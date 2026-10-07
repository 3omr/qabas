#!/usr/bin/env python3
"""Preflight check for the external tooling the transcription pipeline shells out to.

The pipeline depends on the `nlm` CLI plus a handful of document tools that are
not installable from PyPI. Without this check a missing tool surfaces only deep
inside a run, as a bare "ocrmypdf or pdfocr is required for scanned PDFs" after
the Agent has already built a manifest and uploaded sources.

Presence is not health. A tool can sit on PATH and still be unusable -- `nlm` is
installed but was never given credentials, a Python package is on disk but its
compiled extension will not import. `report(live=True)` therefore runs each
dependency's declared probe and reports a third state between "found" and
"missing": found, but not working. The probes are opt-in because running them
costs real seconds (a cold `libreoffice --version` is not fast).
"""

from __future__ import annotations

import glob
import importlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field

import agy_writer
from windows_tools import refresh_tool_path

MINIMUM_PYTHON_VERSION = (3, 10)

# A probe only has to prove the tool can start and do something trivial. Long
# timeouts defeat the point of a preflight check, and a tool that needs more
# than this to print its own version is broken in a way worth reporting.
PROBE_TIMEOUT_SECONDS = 20
# `nlm notebook list` is a network round trip to NotebookLM, and it is the only
# probe that proves authentication rather than mere installation.
NLM_PROBE_TIMEOUT_SECONDS = 45


def _version_key(path: str) -> tuple[int, ...]:
    """Order paths by the version numbers embedded in them, newest last.

    Ghostscript installs into a versioned directory (`gs\\10.03.1\\bin\\`), so a
    machine with two versions matches the glob twice. Plain string order is
    actively wrong here -- "gs9.56" sorts above "gs10.03.1" because '9' beats
    '1' -- and unsorted glob order is whatever the filesystem hands back, which
    makes the answer differ between runs on one machine.
    """
    return tuple(int(part) for part in re.findall(r"\d+", path))


@dataclass(frozen=True)
class Dependency:
    """One external tool or Python package the pipeline can call."""

    name: str
    # Any one of these executables satisfies the dependency.
    executables: tuple[str, ...]
    purpose: str
    install_hint: str
    required: bool
    python_module: str | None = None
    # Arguments appended to the resolved executable to prove it actually works.
    # None means presence is all that can be checked cheaply.
    probe: tuple[str, ...] | None = None
    probe_timeout: int = PROBE_TIMEOUT_SECONDS
    # What a failing probe means, in the user's terms. Without this a bare
    # non-zero exit code tells nobody what to do next.
    probe_failure_hint: str = ""
    # Overrides for platforms whose package manager or bundled app differs.
    install_hints: Mapping[str, str] = field(default_factory=dict)
    # Absolute path/glob templates used only when PATH did not find an executable.
    platform_paths: Mapping[str, tuple[str, ...]] = field(default_factory=dict)

    def install_hint_for_platform(self) -> str:
        return self.install_hints.get(sys.platform, self.install_hint)

    def resolve(self) -> str | None:
        if self.python_module:
            found = importlib.util.find_spec(self.python_module)
            return self.python_module if found else None
        for executable in self.executables:
            path = shutil.which(executable)
            if path:
                return path
        for pattern in self._platform_path_patterns():
            matches = glob.glob(pattern)
            if matches:
                return max(matches, key=_version_key)
        return None

    def _platform_path_patterns(self) -> tuple[str, ...]:
        if sys.platform != "win32":
            return ()
        patterns = self.platform_paths.get(sys.platform, ())
        expanded: list[str] = []
        for template in patterns:
            candidate = template
            for variable in ("ProgramFiles", "ProgramFiles(x86)"):
                marker = "{" + variable + "}"
                if marker not in candidate:
                    continue
                root = os.environ.get(variable)
                if not root:
                    candidate = ""
                    break
                candidate = candidate.replace(marker, root)
            if candidate:
                expanded.append(candidate)
        return tuple(expanded)

    def check(self, location: str) -> str | None:
        """Run the probe. Returns None when healthy, else why it is not.

        ``location`` is whatever ``resolve()`` returned -- an executable path,
        or a module name for the Python packages.
        """
        if self.python_module:
            try:
                importlib.import_module(self.python_module)
            except Exception as error:  # noqa: BLE001 - any import failure is a failure
                return f"{type(error).__name__}: {error}"
            return None

        if not self.probe:
            return None

        try:
            completed = subprocess.run(
                [location, *self.probe],
                capture_output=True,
                text=True, encoding="utf-8", errors="replace",
                timeout=self.probe_timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return f"`{' '.join((self.name, *self.probe))}` timed out after {self.probe_timeout}s"
        except OSError as error:
            return f"could not be executed ({error})"

        if completed.returncode != 0:
            detail = (completed.stderr.strip() or completed.stdout.strip()).splitlines()
            first_line = detail[0][:200] if detail else f"exit code {completed.returncode}"
            return first_line
        return None


DEPENDENCIES: tuple[Dependency, ...] = (
    Dependency(
        name="nlm",
        executables=("nlm",),
        purpose="Every NotebookLM query, upload, and source listing",
        # notebooklm-mcp-cli, not github.com/tmc/nlm. Both expose `nlm` and
        # both serve `notebook list`, `source` and `chat`, so the pipeline does
        # not care -- but only one of them can be installed by a student. This
        # one is a Python package, so pipx installs it with no elevation, no
        # password and no terminal, which is what the desktop app's install
        # button actually does. tmc/nlm is a Go program that publishes no
        # prebuilt binary, so reaching it means installing a Go toolchain
        # first, and it was named here while its sign-in command was written
        # as `nlm auth` -- a form neither client has.
        # A pure command, not prose: the desktop app's install button runs this
        # string, so anything unexecutable in it -- a "then run ..." tail, two
        # commands joined by a slash -- becomes a spawn error. Signing in is a
        # separate step and lives in `probe_failure_hint`, which is where the
        # doctor already reports an installed-but-unauthenticated `nlm`.
        install_hint="pipx install notebooklm-mcp-cli",
        install_hints={"win32": "uv tool install --python 3.12 notebooklm-mcp-cli"},
        required=True,
        # Exactly the call the engine makes first on every run
        # (universal_transcribe.py: `nlm notebook list`), so a green probe here
        # means the real pipeline's first step will work too.
        probe=("notebook", "list"),
        probe_timeout=NLM_PROBE_TIMEOUT_SECONDS,
        probe_failure_hint=(
            "nlm is installed but could not list your notebooks -- it is most "
            "likely unauthenticated, or the session expired. Run `nlm login` "
            "to sign in again; `nlm login --check` reports the session alone."
        ),
    ),
    Dependency(
        name="poppler-utils",
        executables=("pdftotext",),
        purpose="Reading a PDF's text layer to decide whether it needs OCR",
        install_hint="apt install poppler-utils / brew install poppler",
        install_hints={
            "linux": "apt install poppler-utils",
            "darwin": "brew install poppler",
            "win32": "scoop install poppler",
        },
        required=True,
        probe=("-v",),
    ),
    Dependency(
        name="poppler-utils (pdfinfo)",
        executables=("pdfinfo",),
        purpose="Counting PDF pages for the source quality report",
        install_hint="apt install poppler-utils / brew install poppler",
        install_hints={
            "linux": "apt install poppler-utils",
            "darwin": "brew install poppler",
            "win32": "scoop install poppler",
        },
        required=True,
        probe=("-v",),
    ),
    Dependency(
        name="poppler-utils (pdftoppm)",
        executables=("pdftoppm",),
        purpose="Rendering diagram slides as figures (--extract-figures)",
        install_hint="apt install poppler-utils / brew install poppler",
        install_hints={
            "linux": "apt install poppler-utils",
            "darwin": "brew install poppler",
            "win32": "scoop install poppler",
        },
        required=False,
        probe=("-v",),
    ),
    Dependency(
        name="poppler-utils (pdfimages)",
        executables=("pdfimages",),
        purpose="Telling a diagram slide apart from a title-only divider",
        install_hint="apt install poppler-utils / brew install poppler",
        install_hints={
            "linux": "apt install poppler-utils",
            "darwin": "brew install poppler",
            "win32": "scoop install poppler",
        },
        required=False,
        probe=("-v",),
    ),
    Dependency(
        name="tesseract",
        executables=("tesseract",),
        purpose="Recognizing text in scanned PDFs with OCRmyPDF",
        install_hint="apt install tesseract-ocr",
        install_hints={
            "linux": "apt install tesseract-ocr",
            "darwin": "brew install tesseract",
            "win32": "scoop install tesseract",
        },
        required=False,
        probe=("--version",),
        platform_paths={"win32": (r"{ProgramFiles}\Tesseract-OCR\tesseract.exe",)},
    ),
    Dependency(
        name="ocrmypdf",
        executables=("ocrmypdf", "pdfocr"),
        purpose="OCR for scanned past-exam PDFs that carry no text layer",
        install_hint="apt install ocrmypdf / brew install ocrmypdf",
        install_hints={
            "linux": "apt install ocrmypdf",
            "darwin": "brew install ocrmypdf",
            "win32": "uv tool install --python 3.12 ocrmypdf",
        },
        required=False,
        probe=("--version",),
    ),
    Dependency(
        name="libreoffice",
        executables=("libreoffice", "soffice"),
        purpose="Converting PPTX/PPSX/DOCX slides to PDF, for upload and for figures",
        install_hint="apt install libreoffice / brew install --cask libreoffice",
        install_hints={
            "linux": "apt install libreoffice",
            "darwin": "brew install --cask libreoffice",
            "win32": "scoop install extras/libreoffice",
        },
        required=False,
        probe=("--version",),
        platform_paths={
            "win32": (
                r"{ProgramFiles}\LibreOffice\program\soffice.exe",
                r"{ProgramFiles(x86)}\LibreOffice\program\soffice.exe",
            ),
        },
    ),
    Dependency(
        name="ghostscript",
        executables=("gs", "ghostscript"),
        purpose="Compressing PDFs that exceed the NotebookLM upload limit",
        install_hint="apt install ghostscript / brew install ghostscript",
        install_hints={
            "linux": "apt install ghostscript",
            "darwin": "brew install ghostscript",
            "win32": "scoop install ghostscript",
        },
        required=False,
        probe=("--version",),
        platform_paths={
            "win32": (
                r"{ProgramFiles}\gs\*\bin\gswin64c.exe",
                r"{ProgramFiles}\gs\*\bin\gswin32c.exe",
                r"{ProgramFiles(x86)}\gs\*\bin\gswin64c.exe",
                r"{ProgramFiles(x86)}\gs\*\bin\gswin32c.exe",
            ),
        },
    ),
    Dependency(
        name="ffmpeg",
        executables=("ffmpeg",),
        purpose="Normalizing recordings in formats NotebookLM will not accept",
        install_hint="apt install ffmpeg / brew install ffmpeg",
        install_hints={
            "linux": "apt install ffmpeg",
            "darwin": "brew install ffmpeg",
            "win32": "scoop install ffmpeg",
        },
        required=False,
        probe=("-version",),
    ),
    Dependency(
        name="genanki",
        executables=(),
        purpose="Building native .apkg decks in transcriber-anki (.tsv works without it)",
        install_hint="pip install -r requirements.txt",
        required=False,
        python_module="genanki",
    ),
    Dependency(
        name="faster-whisper",
        executables=(),
        purpose=(
            "Local verbatim transcription (--engine whisper), no account needed. "
            "Not needed for --engine notebooklm-raw, which reads the transcript "
            "NotebookLM already made"
        ),
        install_hint="pip install faster-whisper",
        required=False,
        python_module="faster_whisper",
    ),
    Dependency(
        name="openpyxl",
        executables=(),
        purpose="Excel export of the question bank (--format xlsx)",
        install_hint="pip install openpyxl",
        required=False,
        python_module="openpyxl",
    ),
    Dependency(
        name="python-docx",
        executables=(),
        purpose="Word export of an exam paper (--format docx)",
        install_hint="pip install python-docx",
        required=False,
        python_module="docx",
    ),
    Dependency(
        name="reportlab",
        executables=(),
        purpose="Rendering plain-text question banks to PDF before upload",
        install_hint="pip install -r requirements.txt",
        required=False,
        python_module="reportlab",
    ),
)


@dataclass(frozen=True)
class _PythonCheck:
    running: str
    minimum: str
    supported: bool


@dataclass(frozen=True)
class _DependencyCheck:
    dependency: Dependency
    location: str | None
    probe_failure: str | None


@dataclass(frozen=True)
class _DoctorEvaluation:
    python: _PythonCheck
    dependencies: tuple[_DependencyCheck, ...]
    live: bool

    @property
    def exit_code(self) -> int:
        required_failed = any(
            check.dependency.required
            and (check.location is None or check.probe_failure is not None)
            for check in self.dependencies
        )
        return int(not self.python.supported or required_failed)


def _python_check() -> _PythonCheck:
    version = sys.version_info
    running = ".".join(str(part) for part in version[:3])
    minimum = ".".join(str(part) for part in MINIMUM_PYTHON_VERSION)
    return _PythonCheck(running, minimum, version[:2] >= MINIMUM_PYTHON_VERSION)


def _print_python_version(stream, python: _PythonCheck | None = None) -> bool:
    """Report the running interpreter. Returns False when it is too old."""
    python = python or _python_check()
    if python.supported:
        print(f"  ✔ {'python':22} [required] {python.running}", file=stream)
        return True
    print(
        f"  ✖ {'python':22} [required] {python.running} -- "
        f"{python.minimum}+ is required",
        file=stream,
    )
    return False


def _evaluate(live: bool) -> _DoctorEvaluation:
    refresh_tool_path()
    from ocr_data import configure_ocr_data

    configure_ocr_data()
    checks: list[_DependencyCheck] = []
    for dependency in DEPENDENCIES:
        location = dependency.resolve()
        failure = dependency.check(location) if live and location else None
        checks.append(_DependencyCheck(dependency, location, failure))
    return _DoctorEvaluation(_python_check(), tuple(checks), live)


def _print_dependency_status(check: _DependencyCheck, stream) -> None:
    dependency = check.dependency
    label = "required" if dependency.required else "optional"
    if check.location is None:
        mark = "✖" if dependency.required else "○"
        print(f"  {mark} {dependency.name:22} [{label}] not found", file=stream)
    elif check.probe_failure is not None:
        print(
            f"  ⚠ {dependency.name:22} [{label}] {check.location} -- not working",
            file=stream,
        )
    else:
        print(f"  ✔ {dependency.name:22} [{label}] {check.location}", file=stream)
    print(f"      {dependency.purpose}", file=stream)


def _print_missing_optional(checks: list[_DependencyCheck], stream) -> None:
    if not checks:
        return
    print("\nOptional tooling not installed:", file=stream)
    for check in checks:
        dependency = check.dependency
        print(
            f"  ○ {dependency.name}: needed only for "
            f"{dependency.purpose[0].lower()}{dependency.purpose[1:]}\n"
            f"    Install: {dependency.install_hint_for_platform()}",
            file=stream,
        )


def _print_unhealthy_optional(checks: list[_DependencyCheck], stream) -> None:
    if not checks:
        return
    print("\nOptional tooling installed but not working:", file=stream)
    for check in checks:
        dependency = check.dependency
        print(f"  ⚠ {dependency.name}: {check.probe_failure}", file=stream)
        if dependency.probe_failure_hint:
            print(f"    {dependency.probe_failure_hint}", file=stream)


def _print_unhealthy_required(checks: list[_DependencyCheck], stream) -> None:
    if not checks:
        return
    print(
        "\nRequired tooling is installed but not working -- transcription "
        "cannot run:",
        file=stream,
    )
    for check in checks:
        dependency = check.dependency
        print(f"  ⚠ {dependency.name}: {check.probe_failure}", file=stream)
        print(
            f"    {dependency.probe_failure_hint or 'Install: ' + dependency.install_hint_for_platform()}",
            file=stream,
        )


def _print_missing_required(checks: list[_DependencyCheck], stream) -> None:
    if not checks:
        return
    print("\nMissing required tooling -- transcription cannot run:", file=stream)
    for check in checks:
        dependency = check.dependency
        print(
            f"  ✖ {dependency.name}\n"
            f"    Install: {dependency.install_hint_for_platform()}",
            file=stream,
        )


def report(stream=sys.stdout, *, live: bool = False) -> int:
    """Print the dependency report. Returns 0 when the check passes."""
    evaluation = _evaluate(live)
    print("Universal Transcriber dependency check", file=stream)
    if live:
        print("(running liveness probes -- this takes a few seconds)", file=stream)
    print("", file=stream)
    _print_python_version(stream, evaluation.python)
    for check in evaluation.dependencies:
        _print_dependency_status(check, stream)

    missing_required = [
        check for check in evaluation.dependencies
        if check.dependency.required and check.location is None
    ]
    missing_optional = [
        check for check in evaluation.dependencies
        if not check.dependency.required and check.location is None
    ]
    unhealthy_required = [
        check for check in evaluation.dependencies
        if check.dependency.required and check.probe_failure is not None
    ]
    unhealthy_optional = [
        check for check in evaluation.dependencies
        if not check.dependency.required and check.probe_failure is not None
    ]
    print("\nagy: " + json.dumps(agy_writer.doctor_entry(live), ensure_ascii=False), file=stream)
    _print_missing_optional(missing_optional, stream)
    _print_unhealthy_optional(unhealthy_optional, stream)
    _print_unhealthy_required(unhealthy_required, stream)
    _print_missing_required(missing_required, stream)
    if evaluation.exit_code:
        return evaluation.exit_code
    if live:
        print("\nAll required tooling is present and working.", file=stream)
    else:
        print(
            "\nAll required tooling is present. Run with --doctor-live to check "
            "that it actually works (including whether `nlm` is authenticated).",
            file=stream,
        )
    return evaluation.exit_code


def _dependency_json(check: _DependencyCheck, live: bool) -> dict[str, object]:
    dependency = check.dependency
    probe = None
    if live:
        probe = {
            "ran": check.location is not None,
            "passed": (
                None
                if check.location is None
                else check.probe_failure is None
            ),
            "failure": check.probe_failure,
        }
    return {
        "name": dependency.name,
        "purpose": dependency.purpose,
        "required": dependency.required,
        "resolved": check.location is not None,
        "path": check.location,
        "probe": probe,
        "failure_hint": dependency.probe_failure_hint,
        "install_command": dependency.install_hint_for_platform(),
    }


def _evaluation_json(evaluation: _DoctorEvaluation) -> dict[str, object]:
    return {
        "platform": sys.platform,
        "live": evaluation.live,
        "python": {
            "version": evaluation.python.running,
            "minimum_version": evaluation.python.minimum,
            "supported": evaluation.python.supported,
        },
        "dependencies": [
            _dependency_json(check, evaluation.live)
            for check in evaluation.dependencies
        ] + [agy_writer.doctor_entry(evaluation.live)],
        "ok": evaluation.exit_code == 0,
        "exit_code": evaluation.exit_code,
    }


def report_json(stream=sys.stdout, *, live: bool = False) -> int:
    """Write the dependency report as JSON and return its exit code."""
    evaluation = _evaluate(live)
    json.dump(_evaluation_json(evaluation), stream, ensure_ascii=False, indent=2)
    print(file=stream)
    return evaluation.exit_code


if __name__ == "__main__":
    raise SystemExit(report())
