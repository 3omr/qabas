"""Short exam answers and bounded OCR repairs preserve clinical meaning."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

from phase_validation import (
    SECTION_HEADINGS,
    question_placement_errors,
    validate_editorial_quality,
)
from provenance_audit import index_years, ocr_stem_matches
from transcript_contract import validate_complete_transcript


class AnswerLengthTests(unittest.TestCase):
    def test_long_model_answer_lines_report_question_heading_but_explanations_are_allowed(self):
        for heading in ("Question 1", "Clinical Case 1"):
            for prefix in ("", "- ", "1. "):
                with self.subTest(heading=heading, prefix=prefix):
                    body = f"### {heading} **[IMP]**\n**Model Answer:**\n{prefix}" + "word " * 11 + "\n**Clinical Explanation:**\n" + "explanation " * 40
                    transcript = "\n".join(SECTION_HEADINGS[:4]) + "\n" + body + "\n" + SECTION_HEADINGS[4]
                    errors = validate_complete_transcript(transcript)
                    self.assertTrue(any(heading in error and "11 words" in error for error in errors))
                    self.assertTrue(any("11 words" in error for error in validate_editorial_quality(body)))
                    self.assertFalse(any("40 words" in error for error in errors))

    def test_ten_word_answer_and_long_clinical_explanation_pass_length_check(self):
        text = "### Question 1 **[IMP]**\n**Model Answer:**\n- " + "word " * 10 + "\n**Clinical Explanation:**\n" + "explanation " * 40
        self.assertFalse(any("model_answer_too_long" in error for error in validate_editorial_quality(text)))


class OCRStemTests(unittest.TestCase):
    def test_specific_ocr_repairs_match_index_without_changing_years(self):
        pairs = (
            ("Treatment of snake poisoning are", "Treatment of snake POISOnINE are. l caw wets dben es aden weaenee acre Cae = finition) (0.5 degree for ea"),
            ("Polyvalent antisnake venom must be used to all snake venom", "Poly valent antisnake venom must be used to all snake venoum ( Fale)"),
            ("Local sign are in viperidae", "Local sign are in viperidae (a) Mos marked. b. less marked. C. both. d. none"),
            ("Describe treatment of snake bites", "Describe treatment of snake bites (0.5 degree for each)"),
        )
        for clean, raw in pairs:
            with self.subTest(raw=raw):
                self.assertTrue(ocr_stem_matches(clean, raw))
                self.assertEqual(index_years(clean, {"questions": {"key": {"stem": raw, "years": [2023]}}}), (2023,))

    def test_negation_dose_changes_and_unmarked_suffix_deletion_do_not_match(self):
        for clean, raw in (
            ("Antivenin must not be used for all snake bites", "Antivenin must be used for all snake bites"),
            ("Give antivenin dose 20 mg", "Give antivenin dose 10 mg"),
            ("Describe treatment of snake bites", "Describe treatment of snake bites and complications"),
            ("Describe second degree burn severity", "Describe second degree burn severity (3 degrees of burns)"),
        ):
            with self.subTest(clean=clean):
                self.assertFalse(ocr_stem_matches(clean, raw))


class QuestionPlacementTests(unittest.TestCase):
    def test_sourced_patient_scenarios_are_refused_as_written_questions(self):
        for stem in (
            "Male patient 35y old presented to emergency room with acute bleeding.",
            "Male patient 25y old was stabbed in right calf muscle with 2000 ml blood loss.",
            "A 25-year-old male presented with hemorrhage.",
        ):
            with self.subTest(stem=stem):
                block = "### Question 1 **[Past Exams (2023)]**\n**Question:**\n" + stem + "\n**Model Answer:**\nShock"
                self.assertTrue(any("[patient_scenario]" in error for error in question_placement_errors(block)))
                self.assertTrue(any("[patient_scenario]" in error for error in validate_complete_transcript(block)))
                self.assertTrue(any("[patient_scenario]" in error for error in validate_editorial_quality(block)))

    def test_factual_patient_question_and_generated_case_do_not_trigger_sourced_scenario_check(self):
        for badge, stem in (
            ("[Past Exams (2023)]", "List indications for transfusion in a patient with shock."),
            ("[IMP]", "Male patient 35y old presented with shock."),
        ):
            with self.subTest(badge=badge):
                block = f"### Question 1 **{badge}**\n**Question:**\n{stem}\n**Model Answer:**\nShock"
                self.assertEqual(question_placement_errors(block), [])

    def test_sourced_cases_must_precede_imp_cases_but_retained_subquestions_are_allowed(self):
        sourced = "### Clinical Case 1 **[Past Exams (2023)]**\n**Scenario:**\nMale patient 25y old was stabbed in the calf with 2000 ml blood loss.\n**Questions:**\n1. Type of shock?\n2. Transfusion management?\n**Model Answer:**\n1. Hemorrhagic shock\n2. Blood transfusion\n"
        supplement = "### Clinical Case 2 **[IMP]**\n**Scenario:**\nA bleeding patient.\n**Questions:**\n1. Treatment?\n**Model Answer:**\nResuscitation\n"
        self.assertEqual(question_placement_errors(sourced + supplement), [])
        self.assertTrue(any("[sourced_after_imp]" in error for error in question_placement_errors(supplement + sourced)))
        self.assertTrue(any("[sourced_after_imp]" in error for error in validate_complete_transcript(supplement + sourced)))


    def test_pruned_case_subquestions_must_be_renumbered(self):
        case = "### Clinical Case 1 **[Past Exams (2023)]**\n**Scenario:**\nA patient with shock.\n**Questions:**\n1. Type of shock?\n3. Transfusion management?\n**Model Answer:**\nHemorrhagic shock\n"
        self.assertTrue(any("[subquestion_numbering]" in error for error in question_placement_errors(case)))
        self.assertEqual(question_placement_errors(case.replace("3. Transfusion", "2. Transfusion")), [])
