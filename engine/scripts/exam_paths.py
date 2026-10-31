"""Question paper paths use POSIX identities relative to Questions/."""

from pathlib import Path


def valid_exam_name(name: str, *, hidden: bool = False) -> bool:
    """Accept relative paper paths; only prepared references may include hidden entries."""
    return bool(name) and "\0" not in name and "\\" not in name and ":" not in name and not name.startswith("/") and all(
        part and part not in {".", ".."} and (hidden or not part.startswith(".")) for part in name.split("/")
    )


def question_directory(path: Path) -> Path | None:
    """Locate the module's Questions/ root, including papers in a folder also named Questions."""
    parents = [parent for parent in path.parents if parent.name == "Questions"]
    return next((parent for parent in parents if (parent.parent / "module.json").is_file()),
                parents[-1] if parents else None)


def question_name(path: Path) -> str:
    """Return the Questions-relative identity; standalone parser inputs keep their name."""
    directory = question_directory(path)
    if directory is not None:
        return path.relative_to(directory).as_posix()
    return path.as_posix() if not path.is_absolute() else path.name


def question_files(directory: Path) -> list[Path]:
    """List visible, contained files recursively, excluding the generated index."""
    return sorted(path for path in directory.rglob("*") if path.is_file()
                  and valid_exam_name(path.relative_to(directory).as_posix())
                  and path.resolve().is_relative_to(directory.resolve())
                  and path.name != "exam-index.json")
