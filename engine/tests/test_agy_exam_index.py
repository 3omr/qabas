"""Source-grounded agy question extraction and resumable index batches."""

import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import agy_exam_index  # noqa: E402
from exam_index import carry_over_repairs, write_index  # noqa: E402
from lecture_registry import list_module_files  # noqa: E402
from module_registry import load_module  # noqa: E402
from question_provenance import paper_backed_index  # noqa: E402


class AgyExamIndexTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="qabas-agy-exams-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "modules" / "pediatric"
        self.questions = self.root / "Questions"
        self.questions.mkdir(parents=True)
        (self.root / "Lecture").mkdir()
        (self.root / "Transcripts").mkdir()
        (self.root / "module.json").write_text(json.dumps({
            "schema_version": 1, "module_id": "pediatric", "display_name": "Pediatric",
            "notebook": {"id": "test-notebook"},
        }), encoding="utf-8")
        self.module = load_module(self.root)

    def test_partial_inventory_keeps_matching_papers_and_failures_independent(self):
        from desktop_library import question_index_status
        from exam_index import SCHEMA_VERSION
        from mcp_server import _exam_index_is_stale

        papers = [self.questions / name for name in ("A.txt", "B.txt", "C.txt")]
        for paper in papers:
            paper.write_text("1. Which symptom?\nA. Fever\nB. Pain\n", encoding="utf-8")
        bank = {"schema_version": SCHEMA_VERSION, "extractor": "agy", "module": "pediatric",
                "sources": [{"file": "A.txt", "sha256": hashlib.sha256(papers[0].read_bytes()).hexdigest(),
                             "questions": 3, "needs_review": 1}], "questions": {},
                "failed_sources": [{"file": "B.txt", "sha256": hashlib.sha256(papers[1].read_bytes()).hexdigest(),
                                    "error": "agy returned no grounded questions"}]}
        write_index(bank, self.questions)
        with patch("remote_inventory.module_inventory", return_value=SimpleNamespace(
            sources=[], warning=None, remote_as_of=None, available=False,
        )):
            inventory = {item["name"]: item for item in list_module_files(self.module)["files"]}
        self.assertTrue(inventory["A.txt"]["indexed"])
        self.assertEqual(inventory["A.txt"]["question_count"], 3)
        self.assertEqual(inventory["A.txt"]["question_review_count"], 1)
        self.assertTrue(inventory["B.txt"]["index_failed"])
        self.assertEqual(inventory["B.txt"]["index_error"], "agy returned no grounded questions")
        self.assertFalse(inventory["C.txt"]["indexed"])
        self.assertFalse(inventory["C.txt"]["index_failed"])
        self.assertEqual(question_index_status(self.module), {
            "exam_index": "partial", "question_files": 3,
            "question_index_counts": {"indexed": 1, "failed": 1, "pending": 1},
        })
        self.assertFalse(_exam_index_is_stale(bank, self.questions / "exam-index.json", self.module, papers[0]))
        papers[0].write_text("changed paper", encoding="utf-8")
        statuses = {}
        summary = question_index_status(self.module, statuses)
        self.assertFalse(statuses[papers[0]]["indexed"])
        self.assertNotIn("question_count", statuses[papers[0]])
        self.assertEqual(summary["exam_index"], "stale")
        self.assertEqual(summary["question_index_counts"], {"indexed": 0, "failed": 1, "pending": 2})
        self.assertTrue(_exam_index_is_stale(bank, self.questions / "exam-index.json", self.module, papers[0]))
        papers[1].write_text("changed failed paper", encoding="utf-8")
        question_index_status(self.module, statuses)
        self.assertFalse(statuses[papers[1]]["index_failed"])
        self.assertNotIn("index_error", statuses[papers[1]])

    def test_legacy_bank_remains_readable_with_a_new_unprepared_paper(self):
        from desktop_library import question_index_status
        from exam_index import build_index
        from mcp_server import _find_questions, _list_exam_questions, _questions_status

        source = self.questions / "2023.txt"
        source.write_text("1. Which symptom occurs in pneumonia?\nA. Fever\nB. Pain\n", encoding="utf-8")
        write_index(build_index(self.questions, "pediatric"), self.questions)
        (self.questions / "new.pdf").write_bytes(b"unread scan")
        summary = question_index_status(self.module)
        self.assertEqual(summary["exam_index"], "legacy")
        self.assertEqual(summary["question_index_counts"], {"indexed": 0, "failed": 0, "pending": 2})
        statuses = {}
        question_index_status(self.module, statuses)
        self.assertTrue(statuses[source]["index_legacy"])
        self.assertFalse(statuses[source]["indexed"])
        self.assertEqual(_questions_status(self.module), "indexed")
        lecture = json.loads(_find_questions({"module": "pediatric", "lecture": "pneumonia"}, self.root.parent.parent))
        self.assertEqual(lecture["total"], 1)
        file_questions = json.loads(_list_exam_questions({"module": "pediatric", "path": "Questions/2023.txt"}, self.root.parent.parent))
        self.assertEqual(file_questions["total"], 1)
        self.assertIn("pneumonia", file_questions["questions"][0]["stem"])

    def test_index_preserves_source_answer_explanation_and_file_location(self):
        source = self.questions / "2023.txt"
        source.write_text(
            "1. Which option is printed as correct?\n"
            "A. Option A text\n"
            "B. Option B text\n"
            "Correct answer: B. Option B text\n"
            "Explanation: This explanation is printed in the paper.\n",
            encoding="utf-8",
        )
        units = agy_exam_index.read_source_units(source)
        by_text = {unit.text: unit.id for unit in units}
        expected = {
            "covered_unit_ids": [unit.id for unit in units],
            "questions": [{
                "unit_ids": [by_text["1. Which option is printed as correct?"],
                             by_text["A. Option A text"], by_text["B. Option B text"]],
                "number": 1,
                "kind": "mcq",
                "stem": "Which option is printed as correct?",
                "options": [{"label": "A", "text": "Option A text"}, {"label": "B", "text": "Option B text"}],
                "correct_option": "B",
                "answer_text": "Option B text",
                "answer_evidence": "Correct answer: B. Option B text",
                "answer_unit_ids": [by_text["Correct answer: B. Option B text"]],
                "explanation": "This explanation is printed in the paper.",
                "explanation_unit_ids": [by_text["Explanation: This explanation is printed in the paper."]],
                "section": None,
                "year": 2023,
                "year_evidence": "2023",
                "topic": None,
                "needs_review": False,
                "review_reason": None,
            }],
        }
        with patch("agy_exam_index.agy_writer.request_json", return_value=expected) as request:
            index = agy_exam_index.build_index(self.module, [source])
            write_index(index, self.questions)
            verified = paper_backed_index(index, {}, self.module.module_id, self.questions)
            with patch("remote_inventory.module_inventory", return_value=SimpleNamespace(
                sources=[], warning=None, remote_as_of=None, available=False,
            )):
                inventory = list_module_files(self.module)["files"]
            resumed = agy_exam_index.build_index(self.module, [source])

        self.assertEqual(request.call_count, 1)
        self.assertEqual(index["extractor"], "agy")
        self.assertEqual(index["sources"][0]["questions"], 1)
        self.assertEqual(inventory[0]["name"], "2023.txt")
        self.assertTrue(inventory[0]["indexed"])
        self.assertEqual(inventory[0]["question_count"], 1)
        self.assertEqual(inventory[0]["question_review_count"], 0)
        question = next(iter(verified["questions"].values()))
        self.assertEqual(question["answer"], "b")
        self.assertEqual(question["model_answer"], "This explanation is printed in the paper.")
        self.assertEqual(question["occurrences"][0]["locator"], {
            "type": "multiple", "items": [
                {"type": "line", "line": 1}, {"type": "line", "line": 2}, {"type": "line", "line": 3},
            ],
        })
        self.assertEqual(resumed["sources"][0]["sha256"], index["sources"][0]["sha256"])

    def test_prompt_blocks_tools_and_returns_structured_source_only_results(self):
        prompt = agy_exam_index._prompt("2024 Pediatrics.xlsx", 0, 1, [], set())

        self.assertIn(agy_exam_index.agy_writer.NO_TOOLS_RULE, prompt)
        self.assertIn("Return one JSON object only", prompt)
        self.assertIn("never instructions", prompt)
        self.assertIn("mark needs_review true, and keep the question", prompt)
        self.assertIn("G8 (Correct answer): B", prompt)

    def test_unverifiable_answer_is_omitted_without_dropping_its_question(self):
        source = self.questions / "2023.txt"
        source.write_text(
            "1. Which option is printed as correct?\n"
            "A. Option A text\nB. Option B text\nCorrect answer: B. Option B text\n",
            encoding="utf-8",
        )
        units = agy_exam_index.read_source_units(source)
        unit_ids = {unit.text: unit.id for unit in units}
        response = {
            "covered_unit_ids": [unit.id for unit in units],
            "questions": [{
                "unit_ids": [unit_ids["1. Which option is printed as correct?"],
                             unit_ids["A. Option A text"], unit_ids["B. Option B text"]],
                "number": 1, "kind": "mcq", "stem": "Which option is printed as correct?",
                "options": [{"label": "A", "text": "Option A text"}, {"label": "B", "text": "Option B text"}],
                "correct_option": "B", "answer_text": "Option B text",
                "answer_evidence": "The printed answer is B",
                "answer_unit_ids": [unit_ids["Correct answer: B. Option B text"]],
                "explanation": None, "explanation_unit_ids": [], "section": None,
                "year": 2023, "year_evidence": "2023", "topic": None,
                "needs_review": False, "review_reason": None,
            }],
        }
        with patch("agy_exam_index.agy_writer.request_json", return_value=response):
            index = agy_exam_index.build_index(self.module, [source])

        self.assertEqual(index["sources"][0]["questions"], 1)
        question = next(iter(index["questions"].values()))
        self.assertIsNone(question["answer"])
        self.assertIsNone(question["source_answer"])
        self.assertTrue(question["needs_review"])

    def test_text_before_first_page_marker_keeps_line_locations(self):
        source = self.questions / "compiled.txt"
        source.write_text(
            "--- End 2023 ---\n1. Question before the first page marker.\n"
            "--- Page 2 ---\n2. Question on page two.\n",
            encoding="utf-8",
        )

        units = agy_exam_index.read_source_units(source)

        self.assertEqual(
            [(unit.id, unit.locator) for unit in units],
            [
                ("L00001", {"type": "line", "line": 1}),
                ("L00002", {"type": "line", "line": 2}),
                ("P00002", {"type": "page", "page": 2}),
            ],
        )
        self.assertEqual(units[1].text, "1. Question before the first page marker.")
        self.assertIn("2. Question on page two.", units[2].text)

    def test_spreadsheet_word_and_prepared_pdf_units_keep_document_locations(self):
        from docx import Document
        from openpyxl import Workbook

        spreadsheet = self.questions / "Exam.xlsx"
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "Pediatrics"
        sheet.append(["Question", "A", "B"])
        sheet.append(["Which finding identifies the condition?", "Finding one", "Finding two"])
        workbook.save(spreadsheet)
        workbook.close()
        workbook_units = agy_exam_index.read_source_units(spreadsheet)
        self.assertEqual(workbook_units[1].locator, {
            "type": "spreadsheet_row", "sheet": "Pediatrics", "row": 2, "range": "A2:C2",
        })
        self.assertIn("A2 (Question): Which finding identifies the condition?", workbook_units[1].text)

        word = self.questions / "Exam.docx"
        document = Document()
        document.add_paragraph("Question text in a paragraph.")
        table = document.add_table(rows=1, cols=2)
        table.cell(0, 0).text = "A. First option"
        table.cell(0, 1).text = "B. Second option"
        document.save(word)
        word_units = agy_exam_index.read_source_units(word)
        self.assertEqual(word_units[0].locator, {"type": "paragraph", "paragraph": 1})
        self.assertEqual(word_units[1].locator, {"type": "table_row", "table": 2, "row": 1})

        pdf = self.questions / "Exam.pdf"
        pdf.write_bytes(b"prepared in a separate OCR step")
        prepared = self.questions / "Exam.pdf.txt"
        prepared.write_text("--- Page 2 ---\nQuestion on the second page.\n", encoding="utf-8")
        pdf_units = agy_exam_index.read_source_units(pdf, prepared)
        self.assertEqual(pdf_units[0].locator, {"type": "page", "page": 2})
        self.assertEqual(pdf_units[0].text, "Question on the second page.")

    def test_each_required_batch_is_saved_and_reused_on_retry(self):
        source = self.questions / "questions.txt"
        source.write_text("\n".join(f"Source note {number}: " + "evidence " * 25 for number in range(3)), encoding="utf-8")

        def covered(prompt, _schema, **_options):
            evidence = json.loads(prompt.split("Evidence units: ", 1)[1])
            return {
                "covered_unit_ids": [unit["id"] for unit in evidence if unit["coverage"] == "required"],
                "questions": [],
            }

        with patch.object(agy_exam_index, "MAX_BATCH_CHARS", 260), patch(
            "agy_exam_index.agy_writer.request_json", side_effect=covered,
        ) as request:
            agy_exam_index.build_index(self.module, [source])
            agy_exam_index.build_index(self.module, [source])

        self.assertEqual(request.call_count, 3)

    def test_large_spreadsheet_batches_bound_questions_and_prompt_size(self):
        units = [
            agy_exam_index.SourceUnit(
                f"S001R{row:06d}",
                {"type": "spreadsheet_row", "sheet": "Pediatrics", "row": row,
                 "range": f"A{row}:AF{row}"},
                f"Question {row}: " + "source evidence " * 48,
            )
            for row in range(1, 504)
        ]

        batches = agy_exam_index._unit_batches(units)
        prompt_sizes = [
            len(agy_exam_index._prompt(
                "Pediatrics.xlsx", index, len(batches), batch,
                {unit.id for unit in core},
            ).encode("utf-8"))
            for index, (core, batch) in enumerate(batches)
        ]

        self.assertGreater(len(batches), 1)
        self.assertEqual([unit.id for core, _batch in batches for unit in core],
                         [unit.id for unit in units])
        self.assertLessEqual(max(len(core) for core, _batch in batches), 5)
        self.assertLessEqual(max(prompt_sizes), 20_000)

    def test_unquoted_model_explanation_is_omitted_without_dropping_question(self):
        source = self.questions / "2023.txt"
        source.write_text(
            "1. Which option is printed as correct?\n"
            "A. Option A text\nB. Option B text\nCorrect answer: B. Option B text\n",
            encoding="utf-8",
        )
        units = agy_exam_index.read_source_units(source)
        unit_ids = {unit.text: unit.id for unit in units}
        response = {
            "covered_unit_ids": [unit.id for unit in units],
            "questions": [{
                "unit_ids": [unit_ids["1. Which option is printed as correct?"],
                             unit_ids["A. Option A text"], unit_ids["B. Option B text"]],
                "number": 1, "kind": "mcq", "stem": "Which option is printed as correct?",
                "options": [{"label": "A", "text": "Option A text"}, {"label": "B", "text": "Option B text"}],
                "correct_option": "B", "answer_text": "Option B text",
                "answer_evidence": "Correct answer: B. Option B text",
                "answer_unit_ids": [unit_ids["Correct answer: B. Option B text"]],
                "explanation": "The incorrect option causes an unrelated medical condition.",
                "explanation_unit_ids": [unit_ids["1. Which option is printed as correct?"]],
                "section": None, "year": 2023, "year_evidence": "2023", "topic": None,
                "needs_review": False, "review_reason": None,
            }],
        }
        with patch("agy_exam_index.agy_writer.request_json", return_value=response):
            index = agy_exam_index.build_index(self.module, [source])

        question = next(iter(index["questions"].values()))
        self.assertEqual(index["sources"][0]["questions"], 1)
        self.assertEqual(question["model_answer"], "")
        self.assertIsNone(question["occurrences"][0]["explanation"])

    def test_literal_source_id_expression_and_string_year_are_normalized(self):
        source = self.questions / "2023.txt"
        source.write_text(
            "1. Which option is printed as correct?\n"
            "A. Option A text\nB. Option B text\nCorrect answer: B. Option B text\n",
            encoding="utf-8",
        )
        units = agy_exam_index.read_source_units(source)
        unit_ids = {unit.text: unit.id for unit in units}
        response = {
            "covered_unit_ids": [unit.id for unit in units],
            "questions": [{
                "unit_ids": [unit_ids["1. Which option is printed as correct?"],
                             unit_ids["A. Option A text"], unit_ids["B. Option B text"]],
                "number": 1, "kind": "mcq", "stem": "Which option is printed as correct?",
                "options": [{"label": "A", "text": "Option A text"}, {"label": "B", "text": "Option B text"}],
                "correct_option": "B", "answer_text": "Option B text",
                "answer_evidence": "Correct answer: B. Option B text",
                "answer_unit_ids": [unit_ids["Correct answer: B. Option B text"]],
                "explanation": None, "explanation_unit_ids": [], "section": None,
                "year": "2023", "year_evidence": "2023", "topic": None,
                "needs_review": False, "review_reason": None,
            }],
        }
        malformed = json.dumps(response).replace(
            '"unit_ids": ["L00001", "L00002"',
            '"unit_ids": ["L00001", "L00001".replace("1", "2")',
            1,
        )
        proposal_error = agy_exam_index.agy_writer.AgyProposalError("invalid JSON", malformed)

        with patch("agy_exam_index.agy_writer.request_json", side_effect=proposal_error):
            index = agy_exam_index.build_index(self.module, [source])

        question = next(iter(index["questions"].values()))
        self.assertEqual(index["sources"][0]["questions"], 1)
        self.assertEqual(question["years"], [2023])
        self.assertEqual(question["stem"], "Which option is printed as correct?")
        self.assertEqual(question["answer"], "b")

    def test_invalid_json_is_retried_against_the_same_source_units(self):
        source = self.questions / "questions.txt"
        source.write_text("1. Explain dehydration.\n", encoding="utf-8")
        unit = agy_exam_index.read_source_units(source)[0]
        response = {
            "covered_unit_ids": [unit.id],
            "questions": [{
                "unit_ids": [unit.id], "number": 1, "kind": "written", "stem": "Explain dehydration.",
                "options": [], "correct_option": None, "answer_text": None, "answer_evidence": None,
                "answer_unit_ids": [], "explanation": None, "explanation_unit_ids": [], "section": None,
                "year": None, "year_evidence": None, "topic": None,
                "needs_review": True, "review_reason": "The source does not print an answer.",
            }],
        }
        malformed = agy_exam_index.agy_writer.AgyProposalError("invalid JSON", '{"questions": [{"broken" "field"}]}')

        with patch("agy_exam_index.agy_writer.request_json", side_effect=[malformed, response]):
            index = agy_exam_index.build_index(self.module, [source])

        question = next(iter(index["questions"].values()))
        self.assertEqual(index["sources"][0]["questions"], 1)
        self.assertEqual(question["stem"], "Explain dehydration.")
        self.assertTrue(question["needs_review"])

    def _written_response(self, source, **overrides):
        units = agy_exam_index.read_source_units(source)
        question = {
            "unit_ids": [unit.id for unit in units], "number": 1, "kind": "written",
            "stem": "Explain dehydration.", "options": [], "correct_option": None,
            "answer_text": None, "answer_evidence": None, "answer_unit_ids": [],
            "explanation": None, "explanation_unit_ids": [], "section": None,
            "year": None, "year_evidence": None, "topic": None,
            "needs_review": False, "review_reason": None,
        }
        question.update(overrides)
        return {"covered_unit_ids": [unit.id for unit in units], "questions": [question]}

    def test_arabic_year_evidence_is_verified_and_mismatched_year_needs_review(self):
        cases = [
            ("paper.txt", "امتحان ٢٠٢٣", 2023),
            ("CamScanner ٢٩-١١-٢٠٢٣ ١٤.٤٧.txt", "CamScanner ٢٩-١١-٢٠٢٣ ١٤.٤٧.txt", 2023),
            ("paper.txt", "٢٠٢٣", 2023),
            ("paper.txt", "2019", 2023),
            ("paper.txt", "unprinted heading 2023", 2023),
        ]
        for filename, evidence, expected in cases:
            with self.subTest(evidence=evidence):
                source = self.questions / filename
                source.write_text("امتحان ٢٠٢٣\n1. Explain dehydration.\n", encoding="utf-8")
                response = self._written_response(source, year=2023, year_evidence=evidence)
                with patch("agy_exam_index.agy_writer.request_json", return_value=response):
                    index = agy_exam_index.build_index(self.module, [source])
                question = next(iter(index["questions"].values()))
                self.assertEqual(question["years"], [expected] if expected else [])
                rejected = evidence in {"2019", "unprinted heading 2023"}
                self.assertEqual(question["needs_review"], rejected)
                self.assertEqual(bool(question["occurrences"][0]["review_reason"]), rejected)
                if not rejected:
                    self.assertEqual(question["occurrences"][0]["year_source"], "paper" if filename.startswith("CamScanner") else "question")
                (self.questions / agy_exam_index.STATE_NAME).unlink()

    def test_header_year_outside_question_units_overrides_scan_filename(self):
        source = self.questions / "CamScanner ٢٩-١١-٢٠٢٣ ١٤.٤٧.txt"
        source.write_text("Date of exam: Tuesday:          1 8/١/٢٠٢٢\n1. Explain dehydration.\n", encoding="utf-8")
        units = agy_exam_index.read_source_units(source)
        response = self._written_response(
            source, unit_ids=[units[1].id], year=2022,
            year_evidence="Date of exam: Tuesday: 1 8/1/2022",
        )
        with patch("agy_exam_index.agy_writer.request_json", return_value=response):
            index = agy_exam_index.build_index(self.module, [source])
        with patch("agy_exam_index.agy_writer.request_json", side_effect=AssertionError("Use cached payload")):
            self.assertEqual(agy_exam_index.build_index(self.module, [source]), index)
        question = next(iter(index["questions"].values()))
        self.assertEqual(question["years"], [2022])
        self.assertEqual(question["occurrences"][0]["year_source"], "paper")
        self.assertFalse(question["needs_review"])
        self.assertEqual(index["sources"][0]["years"], [2022])
        self.assertEqual(index["sources"][0]["kind"], "past_exam")
        self.assertEqual(index["sources"][0]["needs_review"], 1)
        self.assertEqual(index["sources"][0]["review_reasons"], [
            "Filename year 2023 differs from the paper's printed year 2022",
        ])

    def test_header_year_evidence_from_another_batch_is_verified(self):
        source = self.questions / "paper.txt"
        source.write_text("Exam 2022\n" + "Source note.\n" * 6 + "1. Explain dehydration.\n", encoding="utf-8")
        question = self._written_response(source, unit_ids=["L00008"], year=2022, year_evidence="Exam 2022")["questions"][0]

        def response(prompt, _schema, **_options):
            units = json.loads(prompt.split("Evidence units: ", 1)[1])
            core_ids = [unit["id"] for unit in units if unit["coverage"] == "required"]
            return {"covered_unit_ids": core_ids, "questions": [question] if "L00008" in core_ids else []}

        with patch.object(agy_exam_index, "MAX_BATCH_CHARS", 150), patch("agy_exam_index.agy_writer.request_json", side_effect=response):
            index = agy_exam_index.build_index(self.module, [source])
        extracted = next(iter(index["questions"].values()))
        self.assertEqual(extracted["years"], [2022])
        self.assertEqual(extracted["occurrences"][0]["year_source"], "paper")
        self.assertFalse(extracted["needs_review"])

    def test_single_paper_year_fallback_preserves_question_review_semantics(self):
        cases = [
            ("End 2025.txt", "", None, None, 2025, "filename", False),
            ("scan 2023.txt", "Date of exam: 18/1/2022\n", None, None, 2022, "paper", False),
            ("scan 2023.txt", "Date of exam: 18/1/2022\n", 2023, "scan 2023.txt", 2022, "paper", False),
            ("paper.txt", "Exam 2022\n", 2020, "Unprinted exam 2020", 2022, "paper", True),
            ("paper.txt", "", 2020, "Unprinted exam 2020", None, None, True),
            ("End 2025.txt", "Exams 2022 and 2023\n", None, None, None, None, False),
            ("Bank 2025.txt", "", None, None, None, None, False),
            ("End 2024 2025.txt", "", None, None, None, None, False),
        ]
        for filename, header, year, evidence, expected, provenance, review in cases:
            with self.subTest(filename=filename, header=header, year=year):
                source = self.questions / filename
                source.write_text(header + "1. Explain dehydration.\n", encoding="utf-8")
                response = self._written_response(source, year=year, year_evidence=evidence)
                with patch("agy_exam_index.agy_writer.request_json", return_value=response):
                    index = agy_exam_index.build_index(self.module, [source])
                question = next(iter(index["questions"].values()))
                self.assertEqual(question["years"], [expected] if expected else [])
                occurrence = question["occurrences"][0]
                self.assertEqual(occurrence["year"], expected)
                self.assertEqual(occurrence["year_source"], provenance)
                self.assertEqual(question["needs_review"], review)
                self.assertEqual(bool(occurrence["review_reason"]), review)
                if review:
                    self.assertIn("cannot be verified", occurrence["review_reason"])
                (self.questions / agy_exam_index.STATE_NAME).unlink()

    def test_question_bank_keeps_only_verified_question_years(self):
        source = self.questions / "bank.txt"
        source.write_text("Exam 2022\n1. Explain dehydration.\nExam 2023\n2. Describe fluid loss.\n", encoding="utf-8")
        units = agy_exam_index.read_source_units(source)
        response = self._written_response(source, unit_ids=[units[1].id], year=2022, year_evidence="Exam 2022")
        response["questions"].append({
            **response["questions"][0], "unit_ids": [units[3].id], "stem": "Describe fluid loss.",
            "number": 2, "year": None, "year_evidence": None,
        })
        with patch("agy_exam_index.agy_writer.request_json", return_value=response):
            index = agy_exam_index.build_index(self.module, [source])
        questions = {question["number"]: question for question in index["questions"].values()}
        self.assertEqual(questions[1]["years"], [2022])
        self.assertEqual(questions[2]["years"], [])
        self.assertIsNone(questions[2]["occurrences"][0]["year_source"])
        self.assertFalse(questions[2]["needs_review"])
        self.assertEqual(index["sources"][0]["kind"], "question_bank")
        self.assertEqual(index["sources"][0]["years"], [2022, 2023])

    def test_ungrounded_stem_is_dropped_and_counted_while_valid_questions_resume(self):
        source = self.questions / "paper.txt"
        source.write_text("1. Explain dehydration.\n", encoding="utf-8")
        response = self._written_response(source)
        response["questions"].append({**response["questions"][0], "stem": "Describe unrelated quantum physics."})
        with patch("agy_exam_index.agy_writer.request_json", return_value=response):
            index = agy_exam_index.build_index(self.module, [source])
        with patch("agy_exam_index.agy_writer.request_json", side_effect=AssertionError("Must resume cached batch")):
            resumed = agy_exam_index.build_index(self.module, [source])
        self.assertEqual(index, resumed)
        self.assertEqual([q["stem"] for q in index["questions"].values()], ["Explain dehydration."])
        self.assertEqual(index["sources"][0]["dropped_questions"], 1)
        self.assertEqual(index["sources"][0]["dropped_question_reasons"], {"A question stem is not grounded": 1})

    def test_invalid_options_and_metadata_do_not_abort_other_questions(self):
        source = self.questions / "paper.txt"
        source.write_text("1. Explain dehydration.\nA. Fluid loss\nB. Reduced intake\n", encoding="utf-8")
        response = self._written_response(
            source, kind="mcq", number="bad", section=[], topic=42, review_reason={}, needs_review="false",
            correct_option="c", answer_unit_ids=["missing"],
            options=[{"label": "a", "text": "Fluid loss"}, {"label": "b", "text": "Reduced intake"},
                     {"label": "c", "text": "Quantum tunnelling"}],
        )
        response["questions"].append({**response["questions"][0], "options": [{"label": "a", "text": "Fluid loss"}]})
        with patch("agy_exam_index.agy_writer.request_json", return_value=response):
            index = agy_exam_index.build_index(self.module, [source])
        question = next(iter(index["questions"].values()))
        self.assertEqual(question["options"], {"a": "Fluid loss", "b": "Reduced intake"})
        self.assertIsNone(question["number"])
        self.assertIsNone(question["topic"])
        self.assertIsNone(question["answer"])
        self.assertTrue(question["needs_review"])
        self.assertIn("answer cannot be verified", question["occurrences"][0]["review_reason"])
        self.assertEqual(index["sources"][0]["dropped_questions"], 1)

    def test_structurally_failed_file_does_not_prevent_another_file_being_indexed(self):
        first, second = self.questions / "A.txt", self.questions / "B.txt"
        for source in (first, second):
            source.write_text("1. Explain dehydration.\n", encoding="utf-8")
        malformed = agy_exam_index.agy_writer.AgyProposalError("invalid JSON", "{broken")
        with patch("agy_exam_index.agy_writer.request_json", side_effect=[malformed, malformed, self._written_response(second)]):
            index = agy_exam_index.build_index(self.module, [first, second])
        self.assertEqual([source["file"] for source in index["sources"]], ["B.txt"])
        failure = index["failed_sources"][0]
        self.assertEqual(failure["file"], "A.txt")
        self.assertEqual(failure["sha256"], hashlib.sha256(first.read_bytes()).hexdigest())
        self.assertIn("after one repair attempt", failure["error"])
        with patch("agy_exam_index.agy_writer.request_json", return_value=self._written_response(first)) as request:
            retried = agy_exam_index.build_index(self.module, [first, second])
        self.assertEqual(request.call_count, 1)
        self.assertEqual(len(retried["sources"]), 2)
        self.assertEqual(retried["failed_sources"], [])

    def test_later_batch_failure_keeps_earlier_validated_batches_for_retry(self):
        source = self.questions / "paper.txt"
        source.write_text("\n".join(f"Source note {number}: " + "evidence " * 25 for number in range(3)), encoding="utf-8")
        seen = []

        def response(prompt, _schema, **_options):
            units = json.loads(prompt.split("Evidence units: ", 1)[1])
            core_ids = [unit["id"] for unit in units if unit["coverage"] == "required"]
            seen.append(core_ids)
            return {"covered_unit_ids": core_ids, "questions": []}

        def fail_second(prompt, schema, **options):
            if seen:
                return {"covered_unit_ids": [], "questions": []}
            return response(prompt, schema, **options)

        with patch.object(agy_exam_index, "MAX_BATCH_CHARS", 260):
            with patch("agy_exam_index.agy_writer.request_json", side_effect=fail_second):
                failed = agy_exam_index.build_index(self.module, [source])
            self.assertEqual(failed["sources"], [])
            self.assertEqual(failed["failed_sources"][0]["file"], source.name)
            state = json.loads((self.questions / agy_exam_index.STATE_NAME).read_text())
            self.assertEqual(list(state["files"][source.name]["batches"]), ["0"])
            with patch("agy_exam_index.agy_writer.request_json", side_effect=response):
                retried = agy_exam_index.build_index(self.module, [source])
        self.assertEqual(seen, [["L00001"], ["L00002"], ["L00003"]])
        self.assertEqual(retried["failed_sources"], [])
        self.assertEqual(retried["sources"][0]["file"], source.name)

    def test_incomplete_model_coverage_records_file_failure(self):
        source = self.questions / "questions.txt"
        source.write_text("One source line.\nSecond source line.\n", encoding="utf-8")
        units = agy_exam_index.read_source_units(source)
        payload = {"covered_unit_ids": [units[0].id], "questions": []}
        with patch("agy_exam_index.agy_writer.request_json", return_value=payload):
            index = agy_exam_index.build_index(self.module, [source])
        self.assertEqual(index["sources"], [])
        self.assertIn("cover every source unit", index["failed_sources"][0]["error"])

    def test_build_exam_index_cli_keeps_previous_publication_when_all_files_fail(self):
        import run_transcription

        config = Path(self.temporary.name) / "config.json"
        config.write_text("{}", encoding="utf-8")
        first, second = self.questions / "A.txt", self.questions / "B.txt"
        for source in (first, second):
            source.write_text("1. Explain dehydration.\n", encoding="utf-8")
        broken = {"covered_unit_ids": [], "questions": []}
        argv = ["run_transcription.py", "--workspace", self.temporary.name, "--module", "pediatric", "--build-exam-index"]
        for all_failed in (False, True):
            with self.subTest(all_failed=all_failed):
                (self.questions / agy_exam_index.STATE_NAME).unlink(missing_ok=True)
                target = self.questions / "exam-index.json"
                previous_bytes = target.read_bytes() if target.exists() else None
                stdout, stderr = io.StringIO(), io.StringIO()
                second_response = broken if all_failed else self._written_response(second)
                with patch.dict(os.environ, {"TRANSCRIBER_CONFIG_PATH": str(config), "TRANSCRIBER_WORKSPACE": self.temporary.name}), patch.object(
                    sys, "argv", argv,
                ), patch("agy_exam_index.agy_writer.request_json", side_effect=[broken, second_response]), redirect_stdout(stdout), redirect_stderr(stderr):
                    exit_code = run_transcription.main()
                self.assertEqual(exit_code, 1 if all_failed else 0, stderr.getvalue())
                self.assertIn("Failed: A.txt", stdout.getvalue())
                state = json.loads((self.questions / agy_exam_index.STATE_NAME).read_text())
                self.assertEqual(len(state["failed_sources"]), 2 if all_failed else 1)
                if all_failed:
                    self.assertIn("Failed: B.txt", stdout.getvalue())
                    self.assertEqual(target.read_bytes(), previous_bytes)
                else:
                    published = json.loads(target.read_text())
                    self.assertEqual(len(published["sources"]), 1)
                    self.assertEqual(len(published["failed_sources"]), 1)

    def test_build_exam_index_cli_without_papers_keeps_previous_publication(self):
        import run_transcription

        config = Path(self.temporary.name) / "config.json"
        config.write_text("{}", encoding="utf-8")
        target = self.questions / "exam-index.json"
        previous_bytes = b'{"schema_version": 2, "sources": [], "questions": {}}\n'
        target.write_bytes(previous_bytes)
        argv = ["run_transcription.py", "--workspace", self.temporary.name, "--module", "pediatric", "--build-exam-index"]
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, {"TRANSCRIBER_CONFIG_PATH": str(config), "TRANSCRIBER_WORKSPACE": self.temporary.name}), patch.object(
            sys, "argv", argv,
        ), patch("agy_exam_index.agy_writer.request_json", side_effect=AssertionError("No papers to extract")), redirect_stdout(stdout), redirect_stderr(stderr):
            exit_code = run_transcription.main()
        self.assertEqual(exit_code, 1)
        self.assertIn("No extractable question files", stderr.getvalue())
        self.assertEqual(target.read_bytes(), previous_bytes)

    def test_preparation_failure_is_published_while_readable_paper_is_indexed(self):
        import run_transcription

        first, second = self.questions / "A.txt", self.questions / "B.txt"
        first.write_bytes(b"\xff\xfe")
        second.write_text("1. Explain dehydration.\n", encoding="utf-8")
        ready, failures = run_transcription._prepare_exam_sources(self.module)
        self.assertEqual(ready, [second])
        self.assertEqual(failures[0]["file"], "A.txt")
        with patch("agy_exam_index.agy_writer.request_json", return_value=self._written_response(second)):
            index = agy_exam_index.build_index(self.module, ready, failed_sources=failures)
            published, target = run_transcription._publish_exam_index(self.module, ready, index)
        self.assertEqual(published["failed_sources"], failures)
        self.assertEqual(json.loads(target.read_text())["failed_sources"], failures)

    def test_manual_repairs_do_not_retain_occurrences_after_prepared_text_changes(self):
        source = self.questions / "Exam.pdf"
        source.write_bytes(b"unchanged original")
        original_hash = hashlib.sha256(b"unchanged original").hexdigest()
        old = {
            "schema_version": 2, "extractor": "agy", "module": self.module.module_id,
            "sources": [{"file": source.name, "sha256": original_hash, "units_sha256": "old-units"}],
            "questions": {"repaired": {
                "stem": "Reviewed question", "repaired_by_hand": True,
                "occurrences": [{"source": source.name, "unit_ids": ["P00001"]}],
            }},
        }
        write_index(old, self.questions)
        fresh = {
            "schema_version": 2, "extractor": "agy", "module": self.module.module_id,
            "sources": [{"file": source.name, "sha256": original_hash, "units_sha256": "new-units"}],
            "questions": {},
        }

        rebuilt = carry_over_repairs(fresh, self.questions)

        self.assertNotIn("repaired", rebuilt["questions"])


if __name__ == "__main__":
    unittest.main()
