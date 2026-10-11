"""Module-specific terms must outrank ubiquitous toxicology vocabulary."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

from lecture_questions import ranked_questions


class SpecificityTests(unittest.TestCase):
    def test_generic_poisoning_title_cannot_flood_the_top_results(self):
        questions = {f"generic-{number}": {"stem": f"Aspirin poisoning item {number}", "options": {}}
                     for number in range(80)}
        questions.update({
            "snake": {"stem": "Snake venom poisoning", "options": {}},
            "scorpion": {"stem": "Scorpion sting poisoning", "options": {}},
            "antivenin": {"stem": "Antivenin dose", "options": {}},
        })
        ranked = ranked_questions({"questions": questions}, "Animal poisoning",
                                  ["Snake venom. Scorpion sting. Antivenin. Snake antivenin. Scorpion antivenin dose. Snake venom and scorpion sting."], [])
        self.assertEqual({entry["id"] for entry in ranked[:3]}, {"snake", "scorpion", "antivenin"})
        self.assertEqual(len(ranked), 3)

    def test_salycylates_returns_dated_aspirin_questions_before_bank_and_excludes_other_poisons(self):
        from lecture_questions import MAX_QUESTIONS
        from salicylate_fixtures import EVIDENCE, questions

        index = {"questions": questions()}
        ranked = ranked_questions(index, "Salycylates acetyl salysilic acid", [EVIDENCE], [])
        self.assertEqual({entry["id"] for entry in ranked[:2]}, {"death", "toxicity"})
        self.assertEqual(len(ranked), 57)
        self.assertTrue(all(entry["id"].startswith("bank-") for entry in ranked[2:]))
        self.assertEqual(len(ranked[:MAX_QUESTIONS]), 50)
        self.assertEqual({year for entry in ranked[:2] for year in entry["years"]}, {2022, 2025})
        self.assertEqual(ranked, ranked_questions(index, "Salycylates acetyl salysilic acid", [EVIDENCE], []))
        searched = ranked_questions(index, "Salycylates acetyl salysilic acid", [EVIDENCE], ["Opium", "coma", "gastric lavage"])
        self.assertEqual({entry["id"] for entry in searched}, {entry["id"] for entry in ranked})

    def test_topic_spelling_options_and_printed_answers_supply_topic_hits(self):
        questions = {
            "options": {"stem": "As regarding toxicity", "options": {"a": "Salicylates"}},
            "answer": {"stem": "Identify the poison", "options": {}, "occurrences": [
                {"source": "Exam.txt", "answer_status": "printed", "answer_text": "Salicylate"}]},
            "unverified": {"stem": "Identify the poison", "options": {}, "occurrences": [
                {"source": "Exam.txt", "answer_status": "unverified", "answer_text": "Salicylate"}]},
            "different": {"stem": "Salbutamol overdose", "options": {}},
        }
        for title in ("Salycylates", "SÁLICCYLATES", "Salicylate", "salicylattes"):
            with self.subTest(title=title):
                ranked = ranked_questions({"questions": questions}, title, [], [])
                self.assertEqual({entry["id"] for entry in ranked}, {"options", "answer"})
