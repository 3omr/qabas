"""A saved draft is not refused for what its writer could not change.

A deck's own "Case 1" and "MCQ 2" slides name guide headings that look like
question headings; a deck with only text slides yields no figure to link; and
a deck matched by a bare number is the wrong deck.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

import mcp_server  # noqa: E402
import phase_validation  # noqa: E402
from phase_validation import SECTION_HEADINGS  # noqa: E402
from transcript_contract import (  # noqa: E402
    _figure_errors,
    neutralize_guide_question_headings,
)

GUIDE = SECTION_HEADINGS[0]


class GuideHeadingTests(unittest.TestCase):
    def test_slide_case_and_quiz_headings_in_the_guide_keep_their_title(self):
        text = (
            f"# 🔪 Shock\n\n{GUIDE}\n\n### Case 1 — Upper GI bleeding\n\nشرح\n\n"
            f"### MCQ 2 — النمط الإكلينيكي\n\nشرح\n\n{SECTION_HEADINGS[1]}\n\n"
            f"{SECTION_HEADINGS[2]}\n\n### MCQ 1 **[IMP]**\n"
        )
        fixed = neutralize_guide_question_headings(text)
        self.assertIn("### Slide Case 1 — Upper GI bleeding", fixed)
        self.assertIn("### Slide MCQ 2 — النمط الإكلينيكي", fixed)
        # Assessment sections are untouched.
        self.assertIn("### MCQ 1 **[IMP]**", fixed)
        self.assertNotIn("### Slide MCQ 1", fixed)

    def test_text_without_a_guide_first_is_left_alone(self):
        text = f"{SECTION_HEADINGS[2]}\n\n### MCQ 1 **[IMP]**\n"
        self.assertEqual(neutralize_guide_question_headings(text), text)


class FigureRequirementTests(unittest.TestCase):
    def test_a_deck_whose_extraction_selected_nothing_needs_no_link(self):
        with tempfile.TemporaryDirectory() as root:
            deck = Path(root, "Shock.pptx")
            deck.write_bytes(b"deck")
            figures = Path(root, "Figures", "Shock")
            figures.mkdir(parents=True)
            missing = Path(root, "Figures", "Shock boys part 1")
            (figures / "figures.json").write_text(json.dumps({"figures": []}), encoding="utf-8")
            self.assertEqual(_figure_errors("# no images", deck, [missing, figures]), [])
            (figures / "figures.json").write_text(json.dumps({"figures": [{"page": 6}]}), encoding="utf-8")
            errors = _figure_errors("# no images", deck, [missing, figures])
            self.assertEqual(len(errors), 1)
            # Only the directory that exists is named.
            self.assertIn(str(figures), errors[0])
            self.assertNotIn(str(missing), errors[0])


class SlideMatchingTests(unittest.TestCase):
    def test_numbers_and_shared_words_do_not_match_a_deck(self):
        self.assertEqual(mcp_server._slide_tokens("food poisoning (1)"), {"food"})
        self.assertEqual(mcp_server._slide_tokens("Heavy Metals 1"), {"heavy", "metals"})

    def test_an_automatic_lecture_reports_the_deck_it_is_written_with(self):
        with tempfile.TemporaryDirectory() as root:
            lecture_dir = Path(root, "Lecture")
            lecture_dir.mkdir()
            for name in ("food poisoning (1).pptx", "plant.pptx", "Book.pdf"):
                (lecture_dir / name).write_bytes(b"x")
            module = SimpleNamespace(
                paths=SimpleNamespace(lecture=lecture_dir, root=Path(root)), lectures=(), general_materials=("Book.pdf",),
            )
            with patch.object(mcp_server, "manual_definition", return_value=None):
                food = {"title": "Food poisoning", "origin": "auto", "recording_sources": ["Food poisoning.mp3"]}
                mcp_server._report_lecture_materials(module, food)
                self.assertEqual(food["materials"], ["food poisoning (1).pptx"])
                self.assertEqual(food["materials_origin"], "matched")
                metals = {"title": "Heavy Metals 1", "origin": "auto", "recording_sources": ["Heavy Metals 1.mp3"]}
                mcp_server._report_lecture_materials(module, metals)
                self.assertNotIn("materials", metals)
                book = {"title": "Book review", "origin": "auto", "recording_sources": ["Book review.mp3"]}
                mcp_server._report_lecture_materials(module, book)
                self.assertNotIn("materials", book)
            defined = {"title": "Shock", "origin": "manual", "materials": ["Shock.pptx"]}
            mcp_server._report_lecture_materials(module, defined)
            self.assertEqual(defined["materials_origin"], "defined")
            empty = {"title": "Shock", "origin": "manual", "materials": []}
            mcp_server._report_lecture_materials(module, empty)
            self.assertNotIn("materials_origin", empty)


class FifthOptionTests(unittest.TestCase):
    def test_an_answer_naming_option_e_is_an_option_label(self):
        options = "- **a.** one\n- **b.** two\n- **c.** three\n- **d.** four\n- **e.** Septic shock\n"
        block = f"**Options:**\n{options}\n**Correct Answer:** **e.** Septic shock\n"
        self.assertEqual(phase_validation._correct_answer_errors(block, 12, options), [])
        wrong = f"**Options:**\n{options}\n**Correct Answer:** **e.** Cardiogenic shock\n"
        self.assertTrue(phase_validation._correct_answer_errors(wrong, 12, options))

    def test_a_sourced_question_keeps_its_paper_s_five_options_but_a_built_one_follows_the_module(self):
        options = "**Options:**\n- **a.** one\n- **b.** two\n- **c.** three\n- **d.** four\n- **e.** five\n"
        sourced = "### MCQ 1 **[Past Exams - 2023]**\n" + options
        built = "### MCQ 2 **[IMP]**\n" + options
        self.assertEqual(phase_validation._option_shape_errors(sourced, 1, {}), [])
        self.assertTrue(phase_validation._option_shape_errors(built, 2, {}))


if __name__ == "__main__":
    unittest.main()
