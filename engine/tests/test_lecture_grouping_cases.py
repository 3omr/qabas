"""The grouping rule, exercised against the case file the desktop app shares.

The rule exists twice -- here in Python, and again in TypeScript in the
desktop app's sidebar, which lists the workspace itself rather than starting a
subprocess to redraw. One case file is what keeps the two from drifting: a
change to either implementation that the other does not follow fails both
suites.
"""

import json
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).parents[1]
ENGINE_ROOT = REPO_ROOT
sys.path.insert(0, str(ENGINE_ROOT / "scripts"))

import mcp_server

CASES_PATH = ENGINE_ROOT / "references" / "lecture-grouping-cases.json"


def _load_cases() -> list[dict]:
    return json.loads(CASES_PATH.read_text(encoding="utf-8"))["cases"]


class LectureGroupingCaseTests(unittest.TestCase):
    def test_the_case_file_is_actually_populated(self) -> None:
        # A suite that silently runs zero cases would pass forever.
        self.assertGreaterEqual(len(_load_cases()), 10)

    def test_every_shared_case(self) -> None:
        for case in _load_cases():
            with self.subTest(case["name"]):
                recordings = [
                    Path("Lecture") / name
                    for name in case["files"]
                    if Path(name).suffix.lower() in mcp_server.RECORDING_EXTENSIONS
                ]
                lectures = mcp_server._classify_lectures(recordings, case["transcripts"])
                self.assertEqual(
                    [
                        {
                            "title": lecture["title"],
                            "sources": lecture["recording_sources"],
                            "transcribed": lecture["transcribed"],
                        }
                        for lecture in lectures
                    ],
                    case["lectures"],
                )


if __name__ == "__main__":
    unittest.main()
