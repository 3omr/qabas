"""Register evidence must distinguish narration from verbatim source material."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

from guide_register import narration_counts
from phase_validation import SECTION_HEADINGS
from universal_transcribe import pre_finalize_warnings

MSA = "أوضح الدكتور أهمية الفحص وأكد ضرورة العلاج.\n"
EGYPTIAN = "الدكتور بيقول إن ده مهم، وبيوضح اللي بنعمله عشان مش كل حالة زي دي.\n"


@pytest.mark.parametrize(("narration", "flagged"), [
    (EGYPTIAN * 8, False),
    (MSA * 4, True),
    (EGYPTIAN * 45 + MSA * 4, True),
    (MSA * 3, False),
    ((MSA + EGYPTIAN) * 4, False),
    ("> " + (MSA * 8).replace("\n", "\n> "), False),
    (("### " + MSA) * 8, False),
    ('*"' + MSA * 8 + '"*\n', False),
    ("الدكتور بيقول: «" + MSA * 8 + "»\n" + EGYPTIAN, False),
    ("```text\n" + MSA * 8 + "```\n", False),
    ("تناول المريض الدواء ثم انتقل إلى المنزل.\n" * 4, False),
    ("أَوْضَحَ الدكتور الفكرة وأَكَّدَ أهميتها.\n" * 4, True),
])
def test_narrative_register_warns_only_with_sustained_msa_evidence(narration, flagged):
    draft = SECTION_HEADINGS[0] + "\n" + narration + "\n" + SECTION_HEADINGS[1] + "\n" + MSA * 10
    warnings = pre_finalize_warnings(draft)
    assert bool(warnings) is flagged
    if flagged:
        assert "Section 1" in warnings[0]
        assert "narration is in Modern Standard Arabic; write it in Egyptian colloquial" in warnings[0]


def test_marker_counts_exclude_inline_quotes_and_medical_word_substrings():
    draft = (SECTION_HEADINGS[0] + '\nأوضح الدكتور الفكرة: "مش ده اللي بيقول عشان دي".\n'
             "الدكتور بيوضح إن ده Drug، مش فاكر المتناول؛ بيأكد مش متأكد.\n")
    counts = narration_counts(draft)
    assert sum(line.msa for line in counts) == 1
    assert sum(line.egyptian for line in counts) == 5
