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
                                  ["Snake venom. Scorpion sting. Antivenin. Snake antivenin."], [])
        self.assertEqual({entry["id"] for entry in ranked[:3]}, {"snake", "scorpion", "antivenin"})
        self.assertTrue(all(entry["score"] == 1 for entry in ranked[3:]))
