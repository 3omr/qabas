"""Row-per-question workbooks index from their columns without a model request."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import agy_exam_index  # noqa: E402
import spreadsheet_questions  # noqa: E402
from exam_preparation import prepare_exam_file  # noqa: E402
from module_registry import load_module  # noqa: E402
from openpyxl import Workbook  # noqa: E402

HEADER = ["Text", "A", "B", "C", "D", "Correct", "Type", "category", "Year", "Explanation"]


class SpreadsheetQuestionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="qabas-workbook-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / "modules" / "cvs"
        self.questions = self.root / "Questions"
        self.questions.mkdir(parents=True)
        (self.root / "Lecture").mkdir()
        (self.root / "Transcripts").mkdir()
        (self.root / "module.json").write_text(json.dumps({
            "schema_version": 1, "module_id": "cvs", "display_name": "CVS", "notebook": {"id": "test-notebook"},
        }), encoding="utf-8")
        self.module = load_module(self.root)

    def workbook(self, name, rows, header=HEADER):
        path = self.questions / name
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "CVS"
        sheet.append(header)
        for row in rows:
            sheet.append(row)
        workbook.save(path)
        workbook.close()
        self.assertEqual(prepare_exam_file(self.module, f"Questions/{name}")["status"], "ready")
        return path

    def build(self, paths, **options):
        with patch("agy_exam_index.agy_writer.request_json", side_effect=AssertionError("no model request")), patch(
            "exam_question_review.review_paper", side_effect=AssertionError("no model review"),
        ):
            return agy_exam_index.build_index(self.module, paths, config={}, **options)

    def test_columns_map_to_grounded_questions_and_flag_only_defective_cells(self):
        bank = self.workbook("CVS bank.xlsx", [
            ["Which valve closes first?", "Mitral", "Aortic", "Tricuspid", "Pulmonary", "A", "MCQ", "Physiology", 2021, "S1 is mitral closure."],
            ["Which vessel carries oxygenated blood to the heart?", "Aorta", "Pulmonary vein", "Vena cava", "Coronary sinus", "Pulmonary vein", "MCQ", "Anatomy", "2022", None],
            ["Which drug is a beta blocker?", "Atenolol", "Amlodipine", None, None, "G", "MCQ", "Pharmacology", 2023, None],
            ["Which sound follows atrial contraction?", "S3", "S4", None, None, None, "MCQ", "Physiology", "2019/2020", None],
            ["Define cardiac output.", None, None, None, None, "Stroke volume times heart rate", "Written", "Physiology", None, None],
            [None, None, None, None, None, None, None, "Blank row note", None, None],
        ])
        events = []
        index = self.build([bank], report_progress=lambda done, total, message, **details: events.append(details))

        source = index["sources"][0]
        self.assertEqual((source["extractor"], source["review_status"], source["questions"], source["needs_review"]),
                         ("columns", "done", 5, 2))
        questions = {question["stem"]: question for question in index["questions"].values()}
        first = questions["Which valve closes first?"]
        occurrence = first["occurrences"][0]
        self.assertEqual((first["answer"], first["source_answer"], first["answer_status"]), ("a", "Mitral", "printed"))
        self.assertEqual((occurrence["year"], occurrence["year_source"], occurrence["answer_evidence"]),
                         (2021, "question", "F2 (Correct): A"))
        self.assertEqual(occurrence["locator"], {"type": "spreadsheet_row", "sheet": "CVS", "row": 2, "range": "A2:J2"})
        self.assertEqual((first["topic"], first["model_answer"]), ("Physiology", "S1 is mitral closure."))
        self.assertEqual(questions["Which vessel carries oxygenated blood to the heart?"]["answer"], "b")
        unmatched = questions["Which drug is a beta blocker?"]
        self.assertEqual((unmatched["answer"], unmatched["needs_review"]), (None, True))
        self.assertIn(spreadsheet_questions._UNMATCHED_ANSWER, unmatched["occurrences"][0]["review_reason"])
        unkeyed = questions["Which sound follows atrial contraction?"]
        self.assertEqual((unkeyed["answer_status"], unkeyed["years"], unkeyed["needs_review"]), ("no_key", [], True))
        self.assertIn(spreadsheet_questions._UNREAD_YEAR, unkeyed["occurrences"][0]["review_reason"])
        written = questions["Define cardiac output."]
        self.assertEqual((written["kind"], written["options"], written["needs_review"]), ("written", {}, False))
        self.assertEqual(written["occurrences"][0]["answer_text"], "Stroke volume times heart rate")
        self.assertNotIn("reviewing", [event.get("phase") for event in events])
        self.assertEqual(events[-1], {"phase": "done", "file": "CVS bank.xlsx", "questions": 5})

    def test_large_banks_map_every_batch_and_resume_without_a_model(self):
        rows = [[f"Question {number} about the heart?", "First", "Second", "Third", "Fourth", "ABCD"[number % 4], "MCQ", "CVS", 2018 + number % 6, None]
                for number in range(1, 301)]
        bank = self.workbook("Large.xlsx", rows)
        with patch("agy_exam_index.index_settings", return_value=(2_000, 2)):
            index = self.build([bank])
            resumed = self.build([bank])
        snapshot = agy_exam_index._source_snapshot(self.module, bank, 2_000)
        self.assertGreater(len(snapshot.batches), 10)
        self.assertEqual(index["sources"][0]["questions"], 300)
        self.assertEqual(sorted(index["sources"][0]["years"]), list(range(2018, 2024)))
        self.assertEqual(index, resumed)

    def test_a_sheet_without_question_columns_keeps_model_extraction(self):
        bank = self.workbook("Notes.xlsx", [["Which valve closes first?", "Mitral"]], header=["Question", "Answer"])
        units = agy_exam_index.read_source_units(bank)
        response = {"covered_unit_ids": [unit.id for unit in units], "questions": []}
        with patch("agy_exam_index.agy_writer.request_json", return_value=response) as request:
            index = agy_exam_index.build_index(self.module, [bank], config={})
        self.assertEqual(request.call_count, 1)
        self.assertNotIn("extractor", index["sources"][0])

    def test_option_and_answer_headings_and_letters(self):
        header = agy_exam_index.SourceUnit("S001R000001", {"type": "spreadsheet_row", "sheet": "S", "row": 1, "range": "A1:E1"}, "", tuple(
            agy_exam_index.SourceCell(f"{column}1", value, value)
            for column, value in zip("ABCDE", ["Question", "Option A", "choice b", "Answer", "Option A"])))
        columns = spreadsheet_questions.sheet_columns(header)
        self.assertEqual((columns.fields, columns.options), ({"stem": "A", "answer": "D"}, {"A": "B", "B": "C"}))
        cells = [agy_exam_index.SourceCell(f"{column}2", heading, value)
                 for column, heading, value in zip("ABCD", ["Question", "Option A", "choice b", "Answer"], ["Stem?", "One", "Two", "(b)"])]
        row = agy_exam_index.SourceUnit("S001R000002", {"type": "spreadsheet_row", "sheet": "S", "row": 2, "range": "A2:D2"},
                                        " | ".join(cell.text() for cell in cells), tuple(cells))
        self.assertEqual(spreadsheet_questions.row_question(row, columns)["correct_option"], "B")
        self.assertIsNone(spreadsheet_questions.sheet_columns(agy_exam_index.SourceUnit("S001R000001", header.locator, "", header.cells[:3])))
        self.assertIsNone(spreadsheet_questions.column_payload([row], {}))
        line = agy_exam_index.SourceUnit("L00001", {"type": "line", "line": 1}, "Stem?")
        self.assertIsNone(spreadsheet_questions.column_payload([line], {"S": header}))


if __name__ == "__main__":
    unittest.main()
