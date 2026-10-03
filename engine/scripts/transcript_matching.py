"""Recording provenance and legacy title matching for finished transcripts."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any

RECORDING_EXTENSIONS = frozenset(
    {".oga", ".opus", ".amr", ".m4a", ".mp3", ".wav", ".aac", ".ogg", ".mp4", ".mkv", ".webm", ".avi", ".mov"}
)
NON_TRANSCRIPT_STEMS = frozenset({"index"})
ORDINAL_PREFIX = re.compile(
    r"^(?:(?:lec|lecture|محاضرة)(?=\s|\d)\s*)?\d{1,3}(?:[-._):]|\s+)(?=\s*\S)"
)
MATCH_SEPARATORS = re.compile(r"[\s._\-–—]+")
MATCH_SYMBOLS = frozenset({"\ufe0e", "\ufe0f", "\u200d", "\u20e3"})
SOURCE_LINE = re.compile(r"^>\s*\*\*الملفات المعتمدة:\*\*")


def _match_key(title: str) -> str:
    folded = unicodedata.normalize("NFKC", title).casefold()
    cleaned = "".join(
        character for character in folded
        if unicodedata.category(character) not in {"So", "Sk"}
        and character not in MATCH_SYMBOLS
    )
    return MATCH_SEPARATORS.sub(" ", ORDINAL_PREFIX.sub("", cleaned, count=1)).strip()


def _title_contains_lecture(candidate: str, lecture_title: str) -> bool:
    candidate_key = _match_key(candidate)
    lecture_key = _match_key(lecture_title)
    return bool(lecture_key) and (
        candidate_key == lecture_key
        or candidate_key.startswith(f"{lecture_key} ")
        or len(lecture_key) >= 6 and candidate_key.startswith(lecture_key)
    )


def _is_final_transcript(name: str) -> bool:
    return (
        Path(name).suffix.lower() == ".md"
        and not name.lower().endswith(".draft.md")
        and Path(name).stem.casefold() not in NON_TRANSCRIPT_STEMS
    )


def recording_filename_key(name: str) -> str:
    return unicodedata.normalize("NFKC", name.replace("\\", "/").rsplit("/", 1)[-1]).casefold()


def _header_recordings(path: Path) -> frozenset[str]:
    recordings: set[str] = set()
    with path.open(encoding="utf-8-sig") as transcript:
        for line in transcript:
            if line.strip() == "---" or line.startswith("## "):
                break
            if SOURCE_LINE.match(line):
                recordings.update(
                    recording_filename_key(name)
                    for name in re.findall(r"`([^`]+)`", line)
                    if Path(name).suffix.casefold() in RECORDING_EXTENSIONS
                )
    return frozenset(recordings)


@dataclass(frozen=True)
class FinalTranscript:
    name: str
    recording_sources: frozenset[str]

    @property
    def title(self) -> str:
        return Path(self.name).stem

    def matches(self, title: str, recordings: list[str] | tuple[str, ...]) -> bool:
        if self.recording_sources:
            return bool(recordings) and {
                recording_filename_key(name) for name in recordings
            } <= self.recording_sources
        return _title_contains_lecture(self.title, title)


def final_transcripts(paths: list[str | Path]) -> list[FinalTranscript]:
    """Paths carry header provenance; bare names support legacy grouping callers."""
    return [
        FinalTranscript(
            Path(path).name, _header_recordings(path) if isinstance(path, Path) else frozenset()
        )
        for path in paths if _is_final_transcript(Path(path).name)
    ]


def module_final_transcripts(directory: Path) -> list[FinalTranscript]:
    return final_transcripts([path for path in sorted(directory.glob("*")) if path.is_file()])


def matching_transcripts(
    transcripts: list[FinalTranscript], title: str, recordings: list[str] | tuple[str, ...]
) -> list[FinalTranscript]:
    matched = [transcript for transcript in transcripts if transcript.matches(title, recordings)]
    return sorted(matched, key=lambda transcript: not transcript.recording_sources)


def transcript_assignments(
    transcripts: list[FinalTranscript], units: list[dict[str, Any]]
) -> dict[int, FinalTranscript]:
    """Assign each transcript once, preferring the largest recording citation overlap."""
    assignments: dict[int, FinalTranscript] = {}
    for transcript in sorted(transcripts, key=lambda entry: not entry.recording_sources):
        candidates = []
        for index, unit in enumerate(units):
            if index in assignments:
                continue
            recordings = {recording_filename_key(name) for name in unit["recording_sources"]}
            overlap = len(recordings & transcript.recording_sources)
            if transcript.recording_sources and overlap and recordings <= transcript.recording_sources:
                score = (overlap, overlap / len(recordings), _match_key(transcript.title) == _match_key(unit["title"]))
            elif not transcript.recording_sources and transcript.matches(unit["title"], unit["recording_sources"]):
                score = (0, 0.0, _match_key(transcript.title) == _match_key(unit["title"]))
            else:
                continue
            candidates.append((score, index))
        if candidates:
            _, index = max(candidates, key=lambda candidate: (candidate[0], -candidate[1]))
            assignments[index] = transcript
    return assignments
