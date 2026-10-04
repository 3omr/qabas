"""Spoken topic scopes merge cohorts without letting slides partition the lecture."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

from multi_recording_plan import merged_plan
from topic_map import parse_topics

SOURCES = tuple(f"Shock {cohort} part {part}.m4a" for cohort in ("boys", "girls") for part in (1, 2))


def lecture_topics():
    texts = [" ".join(f"recording{index}word{word}" for word in range(3675)) for index in range(4)]
    topics = []
    for number in range(8):
        spans = []
        for source, text in zip(SOURCES, texts):
            words = text.split()
            start, end = len(words) * number // 8, len(words) * (number + 1) // 8
            spans.append({"recording": source, "cohort": "boys" if "boys" in source else "girls", "first_words": " ".join(words[start:start + 3]),
                          "last_words": " ".join(words[end - 3:end])})
        topics.append({"title": f"Topic {number + 1:02d}", "gloss": f"موضوع {number + 1:02d}", "spans": spans})
    return texts, {"topics": topics}


class MergedPlanTests(unittest.TestCase):
    def test_four_recordings_14700_words_group_topics_into_four_balanced_parts(self):
        texts, payload = lecture_topics()
        topics = parse_topics(payload, SOURCES, texts)
        plan = merged_plan(SOURCES, texts, "--- page 1 ---\nLearning objectives", 18000, topics)
        self.assertEqual([scope["topic_range"] for scope in plan.contexts], [[1, 2], [3, 4], [5, 6], [7, 8]])
        self.assertEqual([scope["verbatim_words"] for scope in plan.contexts], [3672, 3676, 3676, 3676])
        self.assertEqual(plan.layout["parts"], 5)
        for segment in plan.segments:
            self.assertIn("cohort: boys", segment)
            self.assertIn("cohort: girls", segment)
            for source in SOURCES:
                self.assertIn(source, segment)
        self.assertNotIn("recording0word3000", plan.segments[0])
        self.assertIn("NEIGHBOUR CONTEXT ONLY", plan.segments[0])
        changed = merged_plan(SOURCES, texts, "changed", 18000, topics)
        self.assertNotEqual(plan.layout, changed.layout)

    def test_failed_mapping_with_slides_uses_primary_segments_and_full_other_cohorts(self):
        texts = ["primary " * 6000, "other " * 1000, "girls " * 1000, "more " * 1000]
        plan = merged_plan(SOURCES, texts, "--- page 1 ---\nDivider", 18000)
        self.assertGreater(len(plan.segments), 1)
        for segment, scope in zip(plan.segments, plan.contexts):
            self.assertEqual(scope["merge_mode"], "timeline")
            self.assertEqual(scope["primary_source"], SOURCES[0])
            for text in texts[1:]:
                self.assertIn(text, segment)
        self.assertEqual(plan.contexts[-1]["primary_segment"]["end_word"], 6000)

    def test_short_multi_recording_without_map_stays_one_guide_part(self):
        plan = merged_plan(SOURCES, ["spoken " * 100 for _ in SOURCES], "--- page 1 ---\nDivider", 18000)
        self.assertEqual(plan.contexts, [{"merge_mode": "whole"}])
        self.assertEqual(plan.layout["parts"], 2)
