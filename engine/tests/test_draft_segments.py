"""Write stretches must survive Arabic/JSON output limits without losing words."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

from draft_segments import write_segments


@pytest.mark.parametrize(
    ("text", "budget", "expected"),
    [
        ("alpha beta\n\ngamma delta epsilon zeta", 16, ["alpha beta\n\n", "gamma delta ", "epsilon zeta"]),
        ("alpha beta. gamma delta epsilon", 16, ["alpha beta. ", "gamma delta ", "epsilon"]),
        ("الدكتور شرح. الحالة الطبية والعلاج", 30, ["الدكتور شرح. ", "الحالة الطبية ", "والعلاج"]),
        ("abcdefghijk tail", 5, ["abcdefghijk ", "tail"]),
        ("no sentence boundaries here", 12, ["no sentence ", "boundaries ", "here"]),
    ],
)
def test_write_segments_preserve_text_at_natural_boundaries(text, budget, expected):
    segments = write_segments(text, budget)
    assert segments == expected
    assert "".join(segments) == text
    assert [word for segment in segments for word in segment.split()] == text.split()
