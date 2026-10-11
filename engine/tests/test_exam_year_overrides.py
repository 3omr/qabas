"""Owner years remain durable across extraction, file lifecycle and lookup."""

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

import lecture_registry
import library_trash
import mcp_server
from agy_index_fixtures import write_agy_index
from exam_index import load_index, write_index
from exam_year_overrides import STORE_NAME, load_year_overrides, set_exam_year
from module_registry import ModuleConfigError, load_module
from question_provenance import load_paper_backed_index


class ExamYearOverrideTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.workspace = Path(temporary.name)
        self.root = self.workspace / "modules" / "toxo"
        for name in ("Lecture", "Questions", "Transcripts", "Verbatim"):
            (self.root / name).mkdir(parents=True)
        (self.root / "module.json").write_text(json.dumps({"schema_version": 1, "module_id": "toxo", "display_name": "Toxicology", "notebook": {"id": "test-notebook"}}), encoding="utf-8")
        self.paper = self.root / "Questions" / "Final 2021.txt"
        self.paper.write_text("Final examination 2021\n1. Which drug causes respiratory depression?\na. Opium\nb. Aspirin\n", encoding="utf-8")
        self.module = load_module(self.root)
        self.index = write_agy_index(self.module.paths.questions, "toxo")
        write_index(self.index, self.module.paths.questions)

    def test_round_trip_updates_index_and_lookup_without_model(self):
        from phase_validation import _badge_years
        from provenance_audit import index_years
        original = copy.deepcopy(load_index(self.module.paths.questions))
        with patch("agy_writer.request_json", side_effect=AssertionError("no model requests")):
            for year in (2022, 2023, 1900, 2100):
                result = json.loads(mcp_server._set_exam_year({"module": "toxo", "path": "Questions/Final 2021.txt", "year": year}, self.workspace))
                self.assertEqual(result, {"module": "toxo", "path": "Questions/Final 2021.txt", "year": year, "year_source": "owner"})
                verified = load_paper_backed_index(self.module.paths.questions, "toxo")
                question = next(iter(verified["questions"].values()))
                self.assertEqual(question["years"], [year])
                from question_provenance import (
                    assessment_verified_years,
                    local_assessment_catalog,
                )
                catalog = local_assessment_catalog(self.root)
                self.assertEqual(catalog[0]["verified_years"], [year])
                self.assertEqual(assessment_verified_years(catalog), {year})
                lookup = json.loads(mcp_server._find_questions({"module": "toxo", "lecture": "Respiratory depression"}, self.workspace))
                self.assertEqual(lookup["entries"][0]["years"], [year])
                self.assertEqual(lookup["entries"][0]["badge"], f"**[Past Exams - {year}]**")
                self.assertEqual(index_years(question["stem"], verified), (year,))
                self.assertEqual(_badge_years(f"**[Past Exams - {year}]**"), {year})
                rebuilt = copy.deepcopy(self.index)
                write_index(rebuilt, self.module.paths.questions)
                self.assertEqual(next(iter(rebuilt["questions"].values()))["years"], [year])
            result = set_exam_year(self.module, "Questions/Final 2021.txt", None)
        self.assertEqual(result["year"], 2021)
        restored = load_index(self.module.paths.questions)
        self.assertEqual(restored["questions"], original["questions"])

    def test_bank_choice_keeps_questions_undated_until_cleared(self):
        from question_provenance import local_assessment_catalog
        with patch("agy_writer.request_json", side_effect=AssertionError("no model requests")):
            result = json.loads(mcp_server._set_exam_year({"module": "toxo", "path": "Questions/Final 2021.txt", "year": "bank"}, self.workspace))
            self.assertEqual(result, {"module": "toxo", "path": "Questions/Final 2021.txt", "year": None, "year_source": "owner"})
            self.assertEqual(load_year_overrides(self.module.paths.questions), {"Final 2021.txt": "bank"})
            verified = load_paper_backed_index(self.module.paths.questions, "toxo")
            question = next(iter(verified["questions"].values()))
            self.assertEqual(question["years"], [])
            self.assertEqual(verified["sources"][0]["kind"], "question_bank")
            catalog = local_assessment_catalog(self.root)
            self.assertEqual((catalog[0]["role"], catalog[0]["verified_years"]), ("question_bank", []))
            lookup = json.loads(mcp_server._find_questions({"module": "toxo", "lecture": "Respiratory depression"}, self.workspace))
            self.assertEqual(lookup["entries"][0]["years"], [])
            self.assertNotIn("Past Exams", lookup["entries"][0]["badge"])
            listed = lecture_registry.list_module_files(self.module)["files"]
            paper = next(item for item in listed if item["path"] == "Questions/Final 2021.txt")
            self.assertEqual((paper["year"], paper["year_source"]), (None, "owner"))
            self.assertEqual(set_exam_year(self.module, "Questions/Final 2021.txt", None)["year"], 2021)

    def test_forged_owner_year_is_not_accepted_without_store(self):
        forged = copy.deepcopy(self.index)
        for question in forged["questions"].values():
            for occurrence in question["occurrences"]:
                occurrence.update(year=2022, year_source="owner")
        from question_provenance import paper_backed_index
        verified = paper_backed_index(forged, {}, "toxo", self.module.paths.questions)
        self.assertFalse(verified["questions"])

    def test_year_follows_rename_and_trash_restore(self):
        set_exam_year(self.module, "Questions/Final 2021.txt", 2023)
        lecture_registry.rename_file(self.module, "Questions/Final 2021.txt", "CamScanner.txt")
        self.assertEqual(load_year_overrides(self.module.paths.questions), {"CamScanner.txt": 2023})
        removed = library_trash.trash_file(self.module, "Questions/CamScanner.txt")
        self.assertTrue((self.module.paths.questions / STORE_NAME).is_file())
        library_trash.restore_trash(self.module, removed["id"])
        self.assertEqual(load_year_overrides(self.module.paths.questions), {"CamScanner.txt": 2023})
        index = write_agy_index(self.module.paths.questions, "toxo")
        write_index(index, self.module.paths.questions)
        self.assertEqual(next(iter(index["questions"].values()))["years"], [2023])
        with patch("nlm_client.list_remote_sources", return_value=[]):
            files = lecture_registry.list_module_files(self.module)["files"]
        paper = next(item for item in files if item["name"] == "CamScanner.txt")
        self.assertEqual((paper["year"], paper["year_source"]), (2023, "owner"))
        self.assertIn("review_status", paper)

    def test_image_answer_requires_the_exact_current_cached_decision(self):
        from agy_exam_index import PROMPT_VERSION, STATE_NAME
        from exam_question_review import REVIEW_PROMPT_VERSION
        from question_provenance import paper_backed_index

        index = copy.deepcopy(self.index)
        source = index["sources"][0]
        question = next(iter(index["questions"].values()))
        occurrence = question["occurrences"][0]
        occurrence.update(answer="a", source_answer="Opium", answer_text=None,
                          answer_evidence="A circled on page one", answer_unit_ids=[],
                          answer_evidence_type="visible_in_page_image", answer_page=1,
                          review_id="q1", review_cache_key="review-key", section=None)
        decision = {"id": "q1", "answer": "a", "answer_evidence": occurrence["answer_evidence"],
                    "evidence_type": "visible_in_page_image", "answer_page": 1, "drop": False}
        review = {"status": "done", "prompt_version": REVIEW_PROMPT_VERSION,
                  "units_sha256": source["units_sha256"], "key": "review-key",
                  "image_pages": 1, "decisions": [decision],
                  "applied_questions": {"q1": {field: occurrence.get(field) for field in ("stem", "options", "unit_ids", "source_quote", "number")}}}
        review["decisions"].append({**decision, "id": "qOther"})
        review["applied_questions"]["qOther"] = {**review["applied_questions"]["q1"], "stem": "Which drug causes salicylate toxicity?", "number": 2}
        state = {"prompt_version": PROMPT_VERSION, "files": {source["file"]: {
            "sha256": source["sha256"], "units_sha256": source["units_sha256"], "review": review}}}
        path = self.module.paths.questions / STATE_NAME
        path.write_text(json.dumps(state), encoding="utf-8")
        self.assertTrue(paper_backed_index(index, {}, "toxo", self.module.paths.questions)["questions"])
        for field, value in (("answer", "b"), ("answer_page", 2), ("answer_evidence", "Invented mark"), ("review_cache_key", "changed"), ("review_id", "qOther")):
            changed = copy.deepcopy(index)
            next(iter(changed["questions"].values()))["occurrences"][0][field] = value
            self.assertFalse(paper_backed_index(changed, {}, "toxo", self.module.paths.questions)["questions"])
        review["units_sha256"] = "changed"
        path.write_text(json.dumps(state), encoding="utf-8")
        self.assertFalse(paper_backed_index(index, {}, "toxo", self.module.paths.questions)["questions"])

    def test_prepared_pdf_citation_preserves_verified_owner_year(self):
        from provenance_audit import index_years
        from question_provenance import _cited_index

        index = copy.deepcopy(self.index)
        source = index["sources"][0]
        source.update(file="Scan.pdf", prepared_file="Scan.pdf.txt")
        question = next(iter(index["questions"].values()))
        question["occurrences"][0].update(source="Scan.pdf", year=1900, year_source="owner")
        cited = _cited_index(index, {"Scan.pdf.txt"})
        self.assertEqual(index_years(question["stem"], cited), (1900,))

    def test_owner_catalog_year_survives_an_empty_or_absent_index(self):
        from question_provenance import (
            assessment_verified_years,
            local_assessment_catalog,
        )

        set_exam_year(self.module, "Questions/Final 2021.txt", 2023)
        empty = load_index(self.module.paths.questions)
        empty["questions"] = {}
        write_index(empty, self.module.paths.questions)
        self.assertEqual(assessment_verified_years(local_assessment_catalog(self.root)), {2023})
        (self.module.paths.questions / "exam-index.json").unlink()
        self.assertEqual(assessment_verified_years(local_assessment_catalog(self.root)), {2023})
        original = self.module.paths.questions / "Scan.pdf"
        original.write_bytes(b"original scan")
        prepared = self.module.paths.questions / "Scan.pdf.txt"
        prepared.write_text(self.paper.read_text(encoding="utf-8"), encoding="utf-8")
        (self.module.paths.questions / STORE_NAME).write_text(json.dumps({"Scan.pdf": 2023}), encoding="utf-8")
        from question_provenance import assessment_catalog
        catalog = assessment_catalog(self.root, {"assessment_sources": [{"path": "Questions/Scan.pdf.txt", "type": "past_exam", "years": [2021]}]})
        self.assertEqual(catalog[0]["verified_years"], [2023])
        self.assertEqual(assessment_verified_years(catalog), {2023})

    def test_reviewed_conflicting_answers_are_uncertain_without_a_source_defect(self):
        from question_provenance import paper_backed_index

        self.paper.write_text("Final examination 2021\n1. Which drug causes respiratory depression?\n+ a. Opium\nb. Aspirin\n", encoding="utf-8")
        other = self.module.paths.questions / "Final 2022.txt"
        other.write_text("Final examination 2022\n1. Which drug causes respiratory depression?\na. Opium\n+ b. Aspirin\n", encoding="utf-8")
        index = write_agy_index(self.module.paths.questions, "toxo")
        question = next(iter(index["questions"].values()))
        self.assertTrue(question["answer_conflict"])
        self.assertEqual(question["answer_status"], "uncertain")
        self.assertIsNone(question["answer"])
        self.assertFalse(question["needs_review"])
        verified = paper_backed_index(index, {}, "toxo", self.module.paths.questions)
        question = next(iter(verified["questions"].values()))
        self.assertEqual(question["answer_status"], "uncertain")
        self.assertFalse(question["needs_review"])
        self.assertEqual({item["answer"] for item in question["occurrences"]}, {"a", "b"})
        for occurrence in question["occurrences"]:
            listing = mcp_server._exam_question_for_file("toxo-0001", question, occurrence)
            self.assertFalse(listing["needs_review"])
            self.assertEqual(listing["answer_status"], "printed")
        question["occurrences"][0].update(needs_review=True, review_reason="The source is truncated.")
        defective = paper_backed_index(verified, {}, "toxo", self.module.paths.questions)
        self.assertTrue(next(iter(defective["questions"].values()))["needs_review"])

    def test_invalid_year_or_nonpaper_refused(self):
        for value in (True, 1899, 2101, "2022", 2022.5):
            with self.assertRaises(ValueError):
                set_exam_year(self.module, "Questions/Final 2021.txt", value)
        for name in ("exam-index.json", ".exam-year-overrides.json", "Final 2021.txt.txt"):
            with self.assertRaises((ValueError, ModuleConfigError)):
                set_exam_year(self.module, f"Questions/{name}", 2022)
        (self.root / "Lecture" / "slide.pdf").write_bytes(b"slides")
        with self.assertRaises(ValueError):
            set_exam_year(self.module, "Lecture/slide.pdf", 2022)
        (self.module.paths.questions / STORE_NAME).write_text('{"paper.txt": true}')
        with self.assertRaises(ValueError):
            load_year_overrides(self.module.paths.questions)
