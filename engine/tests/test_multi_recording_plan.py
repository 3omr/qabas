"""Merged cohorts need scoped output calls without losing recording evidence."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

from multi_recording_plan import merged_plan

SOURCES = tuple(f"Shock {cohort} part {part}.m4a" for cohort in ("boys", "girls") for part in (1, 2))


class MergedPlanTests(unittest.TestCase):
    def test_four_recordings_14700_words_and_40_pages_make_four_guide_parts(self):
        texts = [f"spoken{index} " * 3675 for index in range(4)]
        outline = "\n\n".join(f"--- page {page} ---\nTopic {page:02d}\n" + "slide " * 100 for page in range(1, 41))
        plan = merged_plan(SOURCES, texts, outline, 18000)
        self.assertEqual([scope["slide_range"] for scope in plan.contexts], [[1, 10], [11, 20], [21, 30], [31, 40]])
        self.assertEqual(plan.layout["parts"], 5)
        self.assertEqual(plan.layout["alignment"], "merged")
        for segment in plan.segments:
            for source, text in zip(SOURCES, texts):
                self.assertIn(source, segment)
                self.assertIn(text, segment)
            self.assertIn("cohort: boys", segment)
            self.assertIn("cohort: girls", segment)
        changed = merged_plan(SOURCES, texts, outline + " changed", 18000)
        self.assertNotEqual(plan.layout, changed.layout)

    def test_without_slides_longest_segments_have_other_recordings_in_full(self):
        texts = ["primary " * 6000, "other " * 1000, "girls " * 1000, "more " * 1000]
        plan = merged_plan(SOURCES, texts, "", 18000)
        self.assertGreater(len(plan.segments), 1)
        for segment, scope in zip(plan.segments, plan.contexts):
            self.assertEqual(scope["primary_source"], SOURCES[0])
            for text in texts[1:]:
                self.assertIn(text, segment)
        self.assertEqual(plan.contexts[-1]["primary_segment"]["end_word"], 6000)

    def test_short_multi_recording_without_slides_stays_one_guide_part(self):
        plan = merged_plan(SOURCES, ["spoken " * 100 for _ in SOURCES], "", 18000)
        self.assertEqual(plan.contexts, [{"merge_mode": "whole"}])
        self.assertEqual(plan.layout["parts"], 2)

    def test_ranges_balance_slide_text_and_never_split_a_page(self):
        outline = "\n".join(f"--- page {page} ---\n" + "word " * (1 if page <= 4 else 100)
                            for page in range(1, 9))
        plan = merged_plan(SOURCES, ["spoken " * 100 for _ in SOURCES], outline, 18000)
        self.assertEqual([scope["slide_range"] for scope in plan.contexts], [[1, 6], [7, 8]])
        one_page = merged_plan(SOURCES, ["spoken " * 4000 for _ in SOURCES], "--- page 1 ---\nOnly page", 18000)
        self.assertEqual(one_page.contexts[0]["slide_range"], [1, 1])
        self.assertEqual(one_page.layout["parts"], 2)
