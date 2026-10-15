"""Automatic review preserves paper evidence, bounds requests and retries independently."""

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from threading import Event
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import agy_exam_index
import agy_writer
import exam_question_review as review
from exam_index import write_index
from module_registry import load_module
from question_provenance import paper_backed_index


class QuestionReviewTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="qabas-question-review-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "modules" / "toxo"
        self.questions = self.root / "Questions"
        self.questions.mkdir(parents=True)
        (self.root / "Lecture").mkdir()
        (self.root / "Transcripts").mkdir()
        (self.root / "module.json").write_text(json.dumps({"schema_version": 1, "module_id": "toxo",
            "display_name": "Toxicology", "notebook": {"id": "test"}}))
        self.module = load_module(self.root)
        self.source = self.questions / "End 2021.txt"
        self.source.write_text('2021\n1) Which drug causes poisoning?\nA. Opium. *\nCB. Benzodiazepine. x\n')
        self.snapshot = agy_exam_index._source_snapshot(self.module, self.source, 12000)
        self.extraction = {"covered_unit_ids": [unit.id for unit in self.snapshot.units], "questions": [{
            "unit_ids": [unit.id for unit in self.snapshot.units][1:], "number": 1, "kind": "mcq",
            "stem": "1) Which drug causes poisoning?", "options": [{"label": "A", "text": "Opium. *"},
                {"label": "CB", "text": "Benzodiazepine. x"}], "correct_option": None, "answer_text": None,
            "answer_evidence": None, "answer_unit_ids": [], "explanation": None, "explanation_unit_ids": [],
            "section": "1-First Question (multiple choice):", "year": None, "year_evidence": None,
            "topic": None, "needs_review": True, "review_reason": "Student markings are ambiguous."}]}
        self.extracted, _ = agy_exam_index._validate_batch(self.extraction, self.snapshot.units,
            {unit.id for unit in self.snapshot.units}, self.snapshot)
        self.decision = {"id": "q1", "stem": "Which drug causes poisoning?",
            "options": {"a": "Opium.", "b": "Benzodiazepine."}, "answer": None,
            "answer_status": "uncertain", "evidence_type": None, "answer_evidence": None,
            "answer_unit_ids": [], "answer_page": None, "section": None, "drop": False,
            "source_defect": False, "review_reason": None}
        self.settings = review.review_settings({})

    def run_review(self, decision=None, cache=None):
        cache = {} if cache is None else cache
        with patch("exam_question_review._request", return_value={"questions": [decision or self.decision]}):
            return review.review_paper(self.snapshot, self.extracted, cache, self.settings, lambda: None)

    def test_skipped_questions_are_asked_again_once_and_otherwise_kept_unreviewed(self):
        second = copy.deepcopy(self.extracted[0])
        second["occurrence"] = copy.deepcopy(second["occurrence"])
        second["number"] = second["occurrence"]["number"] = 2
        extracted = [self.extracted[0], second]
        calls = []

        def request(_snapshot, items, *_args):
            calls.append([item["id"] for item in items])
            return {"questions": [self.decision] if "q1" in calls[-1] else []}

        with patch("exam_question_review._request", side_effect=request):
            reviewed, status, error = review.review_paper(self.snapshot, extracted, {}, self.settings, lambda: None)
        self.assertEqual((status, error), ("done", None))
        self.assertEqual(calls, [["q1", "q2"], ["q2"]])
        self.assertEqual(len(reviewed), 2)
        self.assertEqual(reviewed[0]["stem"], "Which drug causes poisoning?")
        self.assertIs(reviewed[1], second)

    def test_papers_are_reviewed_in_parallel_on_the_extraction_pool(self):
        from threading import Barrier

        second = self.questions / "End 2022.txt"
        second.write_text('2022\n1) Which drug causes poisoning?\nA. Opium. *\nCB. Benzodiazepine. x\n')
        meeting = Barrier(2, timeout=5)

        def extract(prompt, _schema, **_options):
            return self.extraction

        def request(snapshot, items, *_args):
            # Both papers must be under review at once for the barrier to open.
            meeting.wait()
            return {"questions": [{**self.decision, "id": item["id"]} for item in items]}

        with patch("agy_exam_index.agy_writer.request_json", side_effect=extract), \
                patch("exam_question_review._request", side_effect=request):
            index = agy_exam_index.build_index(self.module, [self.source, second], config={"exam_index_workers": 2})
        self.assertEqual(sorted(source["review_status"] for source in index["sources"]), ["done", "done"])

    def test_page_image_reading_corrects_ocr_in_place_and_keeps_provenance(self):
        from exam_index import index_from_sources

        ocr_stem = self.extracted[0]["stem"]
        corrected = {**self.decision, "stem": "Which drug causes poisoning?",
                     "options": {"a": "Opium.", "b": "Benzodiazepines."}}
        rewritten = {**self.decision, "stem": "Which antidote reverses opioid poisoning quickly?"}
        image = review._apply(self.extracted[0], corrected, self.snapshot, 2)
        self.assertEqual(image["options"], {"a": "Opium.", "b": "Benzodiazepines."})
        self.assertEqual(image["occurrence"]["source_options"], self.extracted[0]["options"])
        text_only = review._apply(self.extracted[0], corrected, self.snapshot, 0)
        self.assertEqual(text_only["options"]["b"], "Benzodiazepine. x")
        self.assertEqual(review._apply(self.extracted[0], rewritten, self.snapshot, 2)["stem"], ocr_stem)
        self.assertTrue(review.image_correction("Bronchospasm and pulmonary edema.", "Hronchospam and pulmonary                       edema."))
        self.assertFalse(review.image_correction("Mechanism of action of poisoning", "©\na               eel\n‘Meation                   of Poisoning ee"))
        record = agy_exam_index._source_record(self.snapshot, [image], {})
        backed = paper_backed_index(index_from_sources("toxo", [record]), {}, "toxo", self.questions)
        self.assertEqual([question["options"] for question in backed["questions"].values()], [image["options"]])
        forged = copy.deepcopy(image)
        forged["occurrence"]["options"]["b"] = "Barbiturates."
        record = agy_exam_index._source_record(self.snapshot, [forged], {})
        self.assertEqual(paper_backed_index(index_from_sources("toxo", [record]), {}, "toxo", self.questions)["questions"], {})

    def test_cleaned_question_retains_source_receipts_and_lecture_lookup(self):
        from exam_index import index_from_sources
        from mcp_server import _find_questions

        cleaned, status, error = self.run_review()
        self.assertEqual((status, error), ("done", None))
        question = cleaned[0]
        self.assertEqual(question["stem"], "Which drug causes poisoning?")
        self.assertEqual(question["options"], {"a": "Opium.", "b": "Benzodiazepine."})
        self.assertEqual(question["answer_status"], "uncertain")
        self.assertFalse(question["needs_review"])
        self.assertIsNone(question["section"])
        for field in ("source_quote", "unit_ids"):
            self.assertEqual(question["occurrence"][field], self.extracted[0]["occurrence"][field])
        record = agy_exam_index._source_record(self.snapshot, cleaned, {})
        index = index_from_sources("toxo", [record])
        backed = paper_backed_index(index, {}, "toxo", self.questions)
        self.assertEqual(len(backed["questions"]), 1)
        write_index(index, self.questions)
        found = json.loads(_find_questions({"module": "toxo", "lecture": "poisoning"}, self.root.parent.parent))
        self.assertEqual(found["total"], 1)
        self.assertEqual(found["entries"][0]["stem"], question["stem"])

    def test_hallucinated_fields_keep_the_original_independently(self):
        decision = {**self.decision, "stem": "Which drug causes myocardial infarction?",
            "options": {"a": "Fentanyl.", "b": "Benzodiazepine."}}
        question = self.run_review(decision)[0][0]
        self.assertEqual(question["stem"], self.extracted[0]["stem"])
        self.assertEqual(question["options"], {"a": "Opium. *", "b": "Benzodiazepine."})

    def test_swapped_option_text_keeps_original_printed_order_and_answer(self):
        key_unit = agy_exam_index.SourceUnit("L00005", {"type": "line", "line": 5}, "Correct answer: A")
        snapshot = copy.copy(self.snapshot)
        object.__setattr__(snapshot, "units", [*snapshot.units, key_unit])
        decision = {**self.decision, "options": {"a": "Benzodiazepine.", "b": "Opium."},
                    "answer": "a", "answer_status": "printed", "evidence_type": "printed_key",
                    "answer_evidence": "Correct answer: A", "answer_unit_ids": ["L00005"]}
        question = review._apply(self.extracted[0], decision, snapshot, 0)
        self.assertEqual(question["options"], {"a": "Opium. *", "b": "Benzodiazepine. x"})
        self.assertEqual(question["occurrence"]["options"], question["options"])
        self.assertEqual(question["answer"], "a")
        self.assertEqual(question["source_answer"], "Opium. *")

    def test_quotes_and_student_marks_have_no_new_content_words(self):
        self.assertTrue(review.supported_cleanup('"cannabis sativa\'?', '\\"cannabis sativa\' ? *'))
        self.assertTrue(review.supported_cleanup("Benzodiazepine.", "CB. Benzodiazepine. x"))
        self.assertFalse(review.supported_cleanup("Benzodiazepine causes coma", "CB. Benzodiazepine. x"))

    def test_invalid_answer_or_missing_evidence_remains_uncertain(self):
        for fields in ({"answer": "c"}, {"answer": "a"},
                       {"answer": "a", "evidence_type": "printed_key", "answer_evidence": "invented key", "answer_unit_ids": ["L00003"]}):
            with self.subTest(fields=fields):
                question = self.run_review({**self.decision, **fields})[0][0]
                self.assertIsNone(question["answer"])
                self.assertEqual(question["answer_status"], "uncertain")
                self.assertFalse(question["needs_review"])

    def test_printed_answer_requires_an_existing_option_and_cited_units(self):
        key_unit = agy_exam_index.SourceUnit("L00005", {"type": "line", "line": 5}, "Correct answer: A")
        snapshot = copy.copy(self.snapshot)
        object.__setattr__(snapshot, "units", [*snapshot.units, key_unit])
        decision = {**self.decision, "answer": "a", "answer_status": "printed", "evidence_type": "printed_key",
                    "answer_evidence": "Correct answer: A", "answer_unit_ids": ["L00005"]}
        question = review._apply(self.extracted[0], decision, snapshot, 0)
        self.assertEqual(question["answer"], "a")
        self.assertEqual(question["source_answer"], "Opium.")
        self.assertEqual(question["answer_status"], "printed")

    def test_image_answer_without_a_rendered_page_remains_uncertain(self):
        decision = {**self.decision, "answer": "a", "answer_status": "printed",
                    "evidence_type": "visible_in_page_image", "answer_evidence": "A. Opium. *",
                    "answer_unit_ids": ["L00003"], "answer_page": 1}
        question = self.run_review(decision)[0][0]
        self.assertIsNone(question["answer"])
        self.assertEqual(question["answer_status"], "uncertain")
        self.assertFalse(question["needs_review"])

    def test_only_genuine_illegibility_keeps_review_flag(self):
        for reason, expected in (("No official key; student marks are ambiguous", False),
                                 ("Last option truncated in source", True)):
            question = self.run_review({**self.decision, "source_defect": True, "review_reason": reason})[0][0]
            self.assertEqual(question["needs_review"], expected)
            self.assertEqual(question["review_reason"], reason if expected else None)

    def test_fragments_are_dropped_without_changing_other_receipts(self):
        self.assertEqual(self.run_review({**self.decision, "drop": True})[0], [])

    def test_cache_keys_change_with_questions_units_and_prompt_version(self):
        cache = {}
        self.run_review(cache=cache)
        key = cache["review"]["key"]
        with patch("exam_question_review._request", side_effect=AssertionError("review cache was ignored")):
            self.assertEqual(review.review_paper(self.snapshot, self.extracted, cache, self.settings, lambda: None)[1], "done")
        with patch("exam_question_review.REVIEW_PROMPT_VERSION", review.REVIEW_PROMPT_VERSION + 1):
            self.run_review(cache=cache)
        self.assertNotEqual(key, cache["review"]["key"])
        key = cache["review"]["key"]
        self.extracted[0]["number"] = 2
        self.run_review(cache=cache)
        self.assertNotEqual(key, cache["review"]["key"])

    def test_failure_publishes_extraction_and_retries_only_review(self):
        events = []
        with patch("agy_exam_index.agy_writer.request_json", return_value=self.extraction) as extraction:
            with patch("exam_question_review._request", side_effect=agy_writer.AgyWriterError("agy unavailable")):
                index = agy_exam_index.build_index(self.module, [self.source], config={},
                    report_progress=lambda done, total, message, **details: events.append(details))
        self.assertEqual(extraction.call_count, 1)
        self.assertEqual(index["sources"][0]["review_status"], "failed")
        self.assertEqual(index["failed_sources"], [])
        self.assertEqual(next(iter(index["questions"].values()))["stem"], self.extracted[0]["stem"])
        self.assertEqual([event["phase"] for event in events], ["queued", "reading", "extracting", "extracting", "reviewing", "done"])
        self.assertEqual(events[-1]["questions"], 1)
        with patch("agy_exam_index.agy_writer.request_json", side_effect=AssertionError("extraction was repeated")):
            with patch("exam_question_review._request", return_value={"questions": [self.decision]}) as request:
                index = agy_exam_index.build_index(self.module, [self.source], config={})
        self.assertEqual(request.call_count, 1)
        self.assertEqual(index["sources"][0]["review_status"], "done")

    def test_extraction_failure_omits_unknown_question_count_from_progress(self):
        events = []
        with patch("agy_exam_index.agy_writer.request_json", side_effect=agy_writer.AgyWriterError("authentication required")):
            index = agy_exam_index.build_index(self.module, [self.source], config={},
                report_progress=lambda done, total, message, **details: events.append({"done": done, "total": total, **details}))
        failed = events[-1]
        self.assertEqual(failed["phase"], "failed")
        self.assertEqual((failed["done"], failed["total"]), (1, 1))
        self.assertNotIn("questions", failed)
        self.assertEqual(len(index["failed_sources"]), 1)

    def test_malformed_cached_image_pages_fail_open_and_batch_metadata_is_reset(self):
        image_decision = {**self.decision, "answer": "a", "answer_status": "printed",
                          "evidence_type": "visible_in_page_image", "answer_evidence": "Visible star beside A",
                          "answer_page": 1}
        for field, malformed in (("image_pages", "1"), ("image_pages", [1]), ("batches", [])):
            with self.subTest(field=field, malformed=malformed):
                cache = {}
                with patch("exam_question_review._images_needed", return_value=True):
                    with patch("source_image_repair._render_pages", return_value=(Path("page-1.png"),)):
                        with patch("exam_question_review._request", return_value={"questions": [image_decision]}):
                            reviewed, status, _ = review.review_paper(self.snapshot, self.extracted, cache, self.settings, lambda: None)
                self.assertEqual(status, "done")
                self.assertEqual(reviewed[0]["answer"], "a")
                cache["review"][field] = malformed
                with patch("exam_question_review._request", side_effect=AssertionError("Invalid cache must fail open first")):
                    retained, status, error = review.review_paper(self.snapshot, self.extracted, cache, self.settings, lambda: None)
                self.assertEqual(status, "failed")
                self.assertIsNotNone(error)
                self.assertEqual(retained, self.extracted)
                self.assertIsInstance(cache["review"]["batches"], dict)

    def test_structured_progress_counts_terminal_papers_in_completion_order(self):
        second = self.questions / "Second.txt"
        second.write_text(self.source.read_text())
        unreadable = self.questions / "Missing.txt"
        release_first = Event()
        events = []

        def extract(prompt, _schema, **_options):
            if f"Source file: {self.source.name}" in prompt and not release_first.wait(timeout=5):
                raise agy_writer.AgyWriterError("Second paper did not finish")
            return self.extraction

        def progress(done, total, message, **details):
            events.append({"done": done, "total": total, **details})
            if details["phase"] == "done" and details["file"] == second.name:
                release_first.set()

        with patch("agy_exam_index.agy_writer.request_json", side_effect=extract):
            with patch("exam_question_review._request", return_value={"questions": [self.decision]}):
                index = agy_exam_index.build_index(self.module, [self.source, second, unreadable],
                    config={"exam_index_workers": 2}, report_progress=progress)
        terminal = [event for event in events if event["phase"] in {"done", "failed"}]
        self.assertEqual([event["file"] for event in terminal], [unreadable.name, second.name, self.source.name])
        self.assertEqual([event["done"] for event in terminal], [1, 2, 3])
        self.assertEqual([event["done"] for event in events], sorted(event["done"] for event in events))
        self.assertTrue(all(event["total"] == 3 for event in events))
        for event in events:
            if event["phase"] == "extracting":
                self.assertEqual((event["part"], event["parts"]), (1, 1))
        self.assertEqual(len(index["sources"]), 2)
        self.assertEqual(len(index["failed_sources"]), 1)

    def test_capacity_split_caches_review_leaves(self):
        questions = self.extracted * 4
        def request(_snapshot, items, *_args):
            if len(items) > 1:
                raise agy_writer.AgyWriterError("output truncated")
            return {"questions": [{**self.decision, "id": items[0]["id"]}]}
        cache = {}
        with patch("exam_question_review._request", side_effect=request) as invoke:
            result = review.review_paper(self.snapshot, questions, cache, self.settings, lambda: None)
        self.assertEqual(result[1], "done")
        self.assertEqual(len(result[0]), 4)
        self.assertEqual(invoke.call_count, 7)
        self.assertTrue(cache["review"]["batches"]["0"]["split"])

    def test_malformed_review_ids_fail_open(self):
        with patch("exam_question_review._request", return_value={"questions": [{**self.decision, "id": []}]}):
            cleaned, status, _ = review.review_paper(self.snapshot, self.extracted, {}, self.settings, lambda: None)
        self.assertEqual(status, "failed")
        self.assertEqual(cleaned, self.extracted)

    def test_missing_nullable_fields_and_invalid_page_fail_open(self):
        malformed = {key: value for key, value in self.decision.items()
                     if key not in {"answer", "answer_evidence", "evidence_type", "answer_page", "section", "review_reason"}}
        for decision in (malformed, {**self.decision, "answer_page": True}, {**self.decision, "answer_page": "1"}):
            with self.subTest(decision=decision):
                cache = {}
                cleaned, status, _ = self.run_review(decision, cache)
                self.assertEqual(status, "failed")
                self.assertEqual(cleaned, self.extracted)
                self.assertEqual(cache["review"]["status"], "failed")
                self.assertNotIn("decisions", cache["review"])

    def test_preparation_failures_are_counted_in_structured_progress(self):
        events = []
        index = agy_exam_index.build_index(self.module, [], config={},
            failed_sources=[{"file": "Broken.pdf", "error": "No readable text", "sha256": None, "cause": "source"}],
            report_progress=lambda done, total, message, **details: events.append({"done": done, "total": total, **details}))
        self.assertEqual(events, [{"done": 0, "total": 1, "phase": "queued", "file": "Broken.pdf"},
                                  {"done": 1, "total": 1, "phase": "failed", "file": "Broken.pdf", "cause": "source"}])
        self.assertEqual(index["failed_sources"][0]["file"], "Broken.pdf")

    def test_image_requests_render_with_configured_limits_and_reader(self):
        settings = review.review_settings({"exam_review_max_pages": 2, "exam_review_image_max_size": 800})
        with patch("exam_question_review._images_needed", return_value=True):
            with patch("source_image_repair._render_pages", return_value=(Path("page-1.png"),)) as render:
                with patch("exam_question_review._request", return_value={"questions": [self.decision]}) as request:
                    result = review.review_paper(self.snapshot, self.extracted, {}, settings, lambda: None)
        self.assertEqual(result[1], "done")
        self.assertEqual(render.call_args.kwargs, {"max_pages": 2, "image_max_size": 800})
        self.assertEqual(request.call_args.args[3], (Path("page-1.png"),))
        prompt = review._prompt(self.snapshot, review._question_inputs(self.extracted), [], (Path("page-1.png"),))
        self.assertIn("multimodal file reader", prompt)
        self.assertNotIn(agy_writer.NO_TOOLS_RULE, prompt)

    def test_review_config_rejects_invalid_budgets(self):
        for key in ("exam_review_batch_chars", "exam_review_batch_questions", "exam_review_max_pages",
                    "exam_review_image_max_size", "exam_review_timeout_seconds"):
            for value in (0, True, "100", 1000001):
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    review.review_settings({key: value})


def test_review_schema_has_no_null_enum_member():
    """Gemini refuses a function schema whose enum lists null, which failed every live review."""
    from exam_question_review import SCHEMA

    def walk(node):
        if isinstance(node, dict):
            assert None not in node.get("enum", []), node
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(SCHEMA)


def test_a_pdf_with_an_image_on_most_pages_is_reviewed_as_a_scan():
    """Scanned papers keep an OCR text layer, so their page images are what the review checks."""
    from subprocess import CompletedProcess

    header = "page   num  type   width height color comp bpc  enc interp  object ID\n" + "-" * 70 + "\n"
    scanned = header + "   1     0 image    1240  1754  gray    1   8  jpeg   no        7  0\n" \
        + "   2     1 image    1240  1754  gray    1   8  jpeg   no       12  0\n"
    digital = header + "   3     0 image     200   100  rgb     3   8  jpeg   no       30  0\n"
    for listing, pages, expected in ((scanned, 2, True), (digital, 8, False), (header, 2, False)):
        with patch("shutil.which", return_value="/usr/bin/pdfimages"), \
                patch("exam_question_review.cancellation.run", return_value=CompletedProcess([], 0, listing, "")):
            assert review._scanned_pdf(Path("paper.pdf"), pages) is expected
    with patch("shutil.which", return_value=None):
        assert review._scanned_pdf(Path("paper.pdf"), 2) is True
