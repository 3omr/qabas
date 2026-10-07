"""The app-owned library location shared by the Python entry points."""

from __future__ import annotations

import filecmp
import os
import shutil
import stat
import tempfile
from contextlib import ExitStack
from hashlib import sha256
from pathlib import Path

from file_lock import exclusive_file_lock
from module_activity import module_gate, module_removal_guard
from module_registry import load_module


def workspace_path() -> Path:
    """Developer override or the current user's Qabas Library, independent of cwd."""
    supplied = os.environ.get("TRANSCRIBER_WORKSPACE", "").strip()
    return Path(supplied).expanduser().resolve() if supplied else (Path.home() / "qabas" / "Qabas Library").resolve()


def prepare_workspace(path: Path) -> Path:
    """Prepare the library and adopt idle legacy modules once, retaining their originals."""
    path = path.expanduser().absolute()
    adopt = not os.environ.get("TRANSCRIBER_WORKSPACE", "").strip() and path.resolve() == workspace_path()
    if adopt:
        _refuse_links(Path.home() / "qabas" / "Qabas Library")
        _refuse_links(path)
    path = path.resolve()
    if adopt:
        _refuse_links(path / "modules")
    (path / "modules").mkdir(parents=True, exist_ok=True)
    if not adopt:
        return path
    legacy = Path.home() / "Qabas Library" / "modules"
    _refuse_links(legacy)
    _refuse_links(path / "modules")
    if not legacy.exists():
        return path
    if not legacy.is_dir():
        raise RuntimeError(f"Legacy modules path is not a directory: {legacy}")
    if legacy.resolve().is_relative_to(path) or path.is_relative_to(legacy.resolve()):
        raise RuntimeError(f"Legacy and current library paths overlap: {legacy}, {path}")
    records = path / ".qabas-adoption"
    _refuse_links(records / "adoption.lock")
    with exclusive_file_lock(records / "adoption.lock"):
        for source in sorted(legacy.iterdir()):
            if source.name.startswith("."):
                continue
            _refuse_links(source)
            if not source.is_dir() or not (source / "module.json").exists():
                continue
            checkpoint = records / (sha256(str(source.resolve()).encode()).hexdigest() + ".done")
            _refuse_links(checkpoint)
            if checkpoint.exists():
                if not checkpoint.is_file() or checkpoint.read_text(encoding="utf-8") != str(source.resolve()) + "\n":
                    raise RuntimeError(f"Invalid legacy module adoption checkpoint: {checkpoint}")
                continue
            _adopt_module(source, path / "modules" / source.name, records)
            with tempfile.TemporaryDirectory(prefix="receipt-", dir=records) as temporary:
                receipt = Path(temporary) / "done"
                with receipt.open("x", encoding="utf-8") as output:
                    output.write(str(source.resolve()) + "\n")
                    output.flush()
                    os.fsync(output.fileno())
                os.link(receipt, checkpoint)
    return path


def _refuse_links(path: Path) -> None:
    for candidate in (path, *path.parents):
        try:
            metadata = candidate.lstat()
        except FileNotFoundError:
            continue
        junction = getattr(metadata, "st_reparse_tag", 0) == getattr(stat, "IO_REPARSE_TAG_MOUNT_POINT", None)
        if stat.S_ISLNK(metadata.st_mode) or junction:
            raise RuntimeError(f"Library adoption refuses symlink or junction: {candidate}")


def _adopt_module(source: Path, target: Path, records: Path) -> None:
    """Publish only absent or byte-identical files while both module gates exclude writers."""
    _refuse_links(target)
    for root in (source, target):
        for entry in root.rglob("*"):
            _refuse_links(entry)
    module = load_module(source)
    _refuse_links(module_gate(source.parent.parent, module.module_id))
    _refuse_links(module_gate(target.parent.parent, module.module_id))
    with ExitStack() as guards:
        guards.enter_context(module_removal_guard(module))
        if (target / "module.json").exists():
            guards.enter_context(module_removal_guard(load_module(target)))
        else:
            guards.enter_context(exclusive_file_lock(module_gate(target.parent.parent, module.module_id), blocking=False))
        source_files, source_directories = _module_entries(source)
        _publish_module(source, target, records, source_files, source_directories)


def _module_entries(source: Path) -> tuple[list[Path], list[Path]]:
    source_files = []
    source_directories = []
    for entry in source.rglob("*"):
        _refuse_links(entry)
        relative = entry.relative_to(source)
        # OS leases are live state; the remote inventory is regenerated for the new root.
        cache_lock = (relative.parts[0] == ".transcriber-cache" and "trash" not in relative.parts[1:]
                      and entry.name.endswith(".lock"))
        figure_lock = (len(relative.parts) == 4 and relative.parts[:2] == ("Transcripts", "Figures")
                       and entry.name == ".web-figures.lock")
        if (cache_lock or figure_lock or relative == Path("Transcripts/.transcriber-index.lock")
                or relative == Path(".transcriber-cache/remote-sources.json")):
            continue
        if entry.is_dir():
            source_directories.append(relative)
        elif entry.is_file():
            source_files.append(relative)
        else:
            raise RuntimeError(f"Library adoption refuses special file: {entry}")
    return source_files, source_directories


def _publish_module(source: Path, target: Path, records: Path, source_files: list[Path], source_directories: list[Path]) -> None:
    filecmp.clear_cache()
    for relative in source_files:
        destination = target / relative
        _refuse_links(destination)
        if destination.exists() and (not destination.is_file() or not filecmp.cmp(source / relative, destination, shallow=False)):
            raise RuntimeError(f"Legacy module file collision: {destination}")
    for relative in [Path("."), *source_directories]:
        destination = target / relative
        _refuse_links(destination)
        if destination.exists() and not destination.is_dir():
            raise RuntimeError(f"Legacy module directory collision: {destination}")
    # Hard-link publication is exclusive and leaves an interrupted copy outside modules/.
    with tempfile.TemporaryDirectory(prefix="copy-", dir=records) as temporary:
        staged = Path(temporary)
        for relative in source_files:
            destination = staged / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / relative, destination)
        for relative in [Path("."), *source_directories]:
            _refuse_links(target / relative)
            (target / relative).mkdir(parents=True, exist_ok=True)
        for relative in sorted(source_files, key=lambda entry: entry == Path("module.json")):
            destination = target / relative
            _refuse_links(destination)
            try:
                os.link(staged / relative, destination)
            except FileExistsError as error:
                _refuse_links(destination)
                if not destination.is_file() or not filecmp.cmp(staged / relative, destination, shallow=False):
                    raise RuntimeError(f"Legacy module file collision: {destination}") from error
