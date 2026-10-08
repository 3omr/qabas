"""Exam original preservation, extraction, retry, and derived-text invalidation."""

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

from desktop_library import question_index_status
from exam_index import build_index, carry_over_repairs, write_index
from exam_preparation import clean_exam_texts, exam_file_status, prepare_exam_file
from lecture_registry import import_file, list_module_files, remove_file, rename_file
from module_registry import ModuleConfigError, load_module

PAPER = "1. What is the first symptom?\na. Fever\nb. Cough\nc. Pain\nd. Rash\n"


class ExamPreparationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="qabas-exams-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "modules" / "pediatric"
        for directory in ("Questions", "Lecture", "Transcripts"):
            (self.root / directory).mkdir(parents=True)
        (self.root / "module.json").write_text(json.dumps({
            "schema_version": 1, "module_id": "pediatric", "display_name": "Pediatric",
            "notebook": {"id": "test-notebook"},
        }), encoding="utf-8")
        self.module = load_module(self.root)
        self.source = self.root / "Questions" / "2023.pdf"
        self.source.write_bytes(b"original scan")

    def prepare(self, text=PAPER):
        with patch("exam_preparation._extract", return_value=text):
            return prepare_exam_file(self.module, "Questions/2023.pdf")

    def test_reads_a_paper_and_hides_derived_text_from_the_inventory(self):
        self.assertEqual(self.prepare()["status"], "ready")
        self.assertEqual(self.source.read_bytes(), b"original scan")
        self.assertEqual(len(build_index(self.source.parent, "pediatric")["questions"]), 1)
        inventory = SimpleNamespace(sources=[], warning=None, remote_as_of=None, available=False)
        with patch("remote_inventory.module_inventory", return_value=inventory):
            files = list_module_files(self.module)["files"]
        self.assertEqual([file["name"] for file in files], ["2023.pdf"])
        self.assertEqual(files[0]["preparation"], "ready")
        self.assertEqual(question_index_status(self.module)["question_files"], 1)

    def test_inventory_marks_a_retired_parser_index_stale(self):
        self.prepare()
        inventory = SimpleNamespace(sources=[], warning=None, remote_as_of=None, available=False)
        with patch("remote_inventory.module_inventory", return_value=inventory):
            before = list_module_files(self.module)["files"][0]
            self.assertEqual(before["preparation"], "ready")
            self.assertFalse(before["indexed"])
            write_index(build_index(self.source.parent, "pediatric"), self.source.parent)
            after = list_module_files(self.module)["files"][0]
            self.assertFalse(after["indexed"])
            self.assertNotIn("question_count", after)
            self.source.write_bytes(b"changed scan")
            changed = list_module_files(self.module)["files"][0]
            self.assertFalse(changed["indexed"])
            self.assertNotIn("question_count", changed)

    def test_corrupt_index_is_stale_without_hiding_original_management(self):
        self.prepare()
        index = self.source.parent / "exam-index.json"
        index.write_text("{incomplete index")
        self.assertEqual(question_index_status(self.module)["exam_index"], "stale")
        inventory = SimpleNamespace(sources=[], warning=None, remote_as_of=None, available=False)
        with patch("remote_inventory.module_inventory", return_value=inventory):
            self.assertFalse(list_module_files(self.module)["files"][0]["indexed"])
        self.source.write_bytes(b"replacement scan")
        self.assertEqual(self.prepare()["status"], "ready")
        self.assertEqual(index.read_text(), "{incomplete index")
        self.assertEqual(question_index_status(self.module)["exam_index"], "stale")

    def test_empty_or_invalid_text_is_a_visible_reading_failure(self):
        for content in (b" \n\t", b"\xff\xfe"):
            target = self.source.parent / "empty.txt"
            target.write_bytes(content)
            status = exam_file_status(self.module, target)
            self.assertEqual(status["preparation"], "failed")
            self.assertTrue(status["preparation_error"])

    def test_text_replacement_does_not_prune_an_independent_double_suffix_paper(self):
        first = self.source.parent / "paper.txt"
        second = self.source.parent / "paper.txt.txt"
        first.write_text(PAPER.replace("first symptom", "first treatment"))
        second.write_text(PAPER)
        write_index(build_index(self.source.parent, "pediatric"), self.source.parent)
        replacement = Path(self.temporary.name) / "paper.txt"
        replacement.write_text(PAPER.replace("first symptom", "best investigation"))
        import_file(self.module, str(replacement), "question", replace=True)
        retained = json.loads((self.source.parent / "exam-index.json").read_text())["questions"]
        self.assertEqual(len(retained), 1)
        self.assertEqual(next(iter(retained.values()))["sources"], ["paper.txt.txt"])

    def test_rechecking_unchanged_text_preserves_its_manual_repairs(self):
        text = self.source.parent / "paper.txt"
        text.write_text(PAPER)
        previous = build_index(self.source.parent, "pediatric")
        question = next(iter(previous["questions"].values()))
        question["repaired_by_hand"] = True
        question["stem"] = "What is the first clinical symptom?"
        index = write_index(previous, self.source.parent)
        original = index.read_bytes()
        self.assertEqual(prepare_exam_file(self.module, "Questions/paper.txt")["status"], "ready")
        self.assertEqual(index.read_bytes(), original)
        fresh = carry_over_repairs(build_index(self.source.parent, "pediatric"), self.source.parent)
        self.assertEqual(next(iter(fresh["questions"].values()))["stem"], "What is the first clinical symptom?")

    def test_missing_or_unreadable_cached_text_is_prepared_again(self):
        self.prepare()
        cache = self.source.parent / "2023.pdf.txt"
        for content in (b" \n", b"\xff\xfe"):
            cache.write_bytes(content)
            self.assertEqual(exam_file_status(self.module, self.source)["preparation"], "pending")
            self.assertEqual(self.prepare()["status"], "ready")
            self.assertIn("first symptom", cache.read_text())

    def test_cache_recovery_preserves_repairs_for_unchanged_original_bytes(self):
        self.prepare()
        previous = build_index(self.source.parent, "pediatric")
        question = next(iter(previous["questions"].values()))
        question["repaired_by_hand"] = True
        question["stem"] = "What is the first clinical symptom?"
        index = write_index(previous, self.source.parent)
        original = index.read_bytes()
        (self.source.parent / "2023.pdf.txt").write_bytes(b"")
        self.assertEqual(self.prepare()["status"], "ready")
        self.assertEqual(index.read_bytes(), original)
        fresh = carry_over_repairs(build_index(self.source.parent, "pediatric"), self.source.parent)
        self.assertEqual(next(iter(fresh["questions"].values()))["stem"], "What is the first clinical symptom?")

    def test_cache_is_reused_only_for_unchanged_original_bytes(self):
        self.prepare()
        with patch("exam_preparation._extract", side_effect=AssertionError("must reuse")):
            self.assertEqual(prepare_exam_file(self.module, "Questions/2023.pdf")["status"], "ready")
        self.source.write_bytes(b"replacement scan")
        self.assertEqual(exam_file_status(self.module, self.source)["preparation"], "pending")
        self.prepare(PAPER.replace("symptom", "treatment"))
        self.assertIn("treatment", (self.source.parent / "2023.pdf.txt").read_text())

    def test_failed_reading_preserves_the_original_and_can_be_retried(self):
        self.prepare()
        self.source.write_bytes(b"new unreadable scan")
        with patch("exam_preparation._extract", side_effect=RuntimeError("OCR tool missing")):
            result = prepare_exam_file(self.module, "Questions/2023.pdf")
        self.assertEqual(result["status"], "failed")
        self.assertEqual(self.source.read_bytes(), b"new unreadable scan")
        self.assertFalse((self.source.parent / "2023.pdf.txt").exists())
        self.assertEqual(exam_file_status(self.module, self.source)["preparation_error"], "OCR tool missing")
        self.assertEqual(self.prepare()["status"], "ready")

    def test_generated_text_never_replaces_a_student_file(self):
        text = self.source.parent / "2023.pdf.txt"
        text.write_text("student notes", encoding="utf-8")
        with self.assertRaisesRegex(ModuleConfigError, "replace a user file"):
            self.prepare()
        self.assertEqual(text.read_text(), "student notes")

    def test_replace_rename_and_trash_remove_old_text_and_index(self):
        replacement = Path(self.temporary.name) / "replacement.pdf"
        replacement.write_bytes(b"replacement")
        for operation in ("replace", "rename", "trash"):
            if not self.source.exists():
                self.source.write_bytes(b"original scan")
            self.prepare()
            index = self.source.parent / "exam-index.json"
            write_index(build_index(self.source.parent, "pediatric"), self.source.parent)
            if operation == "replace":
                import_file(self.module, str(replacement), "question", "2023.pdf", replace=True)
            elif operation == "rename":
                rename_file(self.module, "Questions/2023.pdf", "2024.pdf")
            else:
                removed = remove_file(self.module, "Questions/2023.pdf")
                self.assertTrue(Path(removed["trash_path"]).is_file())
            self.assertFalse((self.source.parent / "2023.pdf.txt").exists())
            self.assertEqual(json.loads(index.read_text())["questions"], {})
            self.assertNotEqual(question_index_status(self.module)["exam_index"], "built")

    def test_adding_a_paper_preserves_manual_repairs_from_unchanged_papers(self):
        self.prepare()
        previous = build_index(self.source.parent, "pediatric")
        key, question = next(iter(previous["questions"].items()))
        question["repaired_by_hand"] = True
        question["stem"] = "What is the first clinical symptom?"
        write_index(previous, self.source.parent)
        source = Path(self.temporary.name) / "2024.txt"
        source.write_text(PAPER.replace("first symptom", "best treatment"))
        import_file(self.module, str(source), "question")
        fresh = carry_over_repairs(build_index(self.source.parent, "pediatric"), self.source.parent)
        self.assertEqual(fresh["questions"][key]["stem"], "What is the first clinical symptom?")
        self.assertEqual(len(fresh["questions"]), 2)

    def test_external_deletion_removes_only_owned_text(self):
        self.prepare()
        notes = self.source.parent / "notes.txt"
        notes.write_text("student notes", encoding="utf-8")
        self.source.unlink()
        clean_exam_texts(self.module)
        self.assertFalse((self.source.parent / "2023.pdf.txt").exists())
        self.assertEqual(notes.read_text(), "student notes")

    def test_rejects_paths_outside_questions(self):
        (self.root / "Lecture" / "2023.pdf").write_bytes(b"lecture")
        for name in ("Lecture/2023.pdf", "Questions/../../module.json"):
            with self.assertRaises(ModuleConfigError):
                prepare_exam_file(self.module, name)

    def test_docx_paragraphs_remain_separate_for_question_parsing(self):
        from docx import Document
        document = Document()
        for line in PAPER.splitlines():
            document.add_paragraph(line)
        target = self.source.parent / "2024.docx"
        document.save(str(target))
        self.assertEqual(prepare_exam_file(self.module, "Questions/2024.docx")["status"], "ready")
        self.assertIn("\na. Fever\n", target.with_name("2024.docx.txt").read_text())

    @unittest.skipUnless(shutil.which("pdfinfo") and shutil.which("pdftotext"), "Poppler is required")
    def test_searchable_pdf_uses_real_text_extraction(self):
        from reportlab.pdfgen.canvas import Canvas
        canvas = Canvas(str(self.source))
        for at, line in enumerate(PAPER.replace("first symptom", "first symptom to evaluate in a child with suspected acute infection").splitlines()):
            canvas.drawString(40, 780 - at * 25, line)
        canvas.save()
        result = prepare_exam_file(self.module, "Questions/2023.pdf")
        self.assertEqual(result["status"], "ready", result)
        text = self.source.parent / "2023.pdf.txt"
        self.assertIn("first symptom", text.read_text())
        self.assertEqual(len(build_index(self.source.parent, "pediatric")["questions"]), 1)

    def test_original_citations_find_prepared_text_for_provenance(self):
        from question_provenance import _paper_path, paper_backed_index, paper_texts
        self.prepare()
        self.assertEqual(_paper_path({"local_path": str(self.source)}), self.source.with_name("2023.pdf.txt"))
        index = build_index(self.source.parent, "pediatric")
        verified = paper_backed_index(index, paper_texts(self.source.parent), "pediatric")
        self.assertEqual(len(verified["questions"]), 1)
        self.assertEqual(next(iter(verified["questions"].values()))["years"], [2023])

    def test_malformed_ownership_state_refuses_removing_any_student_file(self):
        state = self.root / ".transcriber-cache" / "exam-texts.json"
        state.parent.mkdir(parents=True)
        state.write_text(json.dumps({"2023.pdf": {"text": "../../module.json", "sha256": "x"}}))
        with self.assertRaisesRegex(ModuleConfigError, "preparation record"):
            clean_exam_texts(self.module)
        self.assertTrue((self.root / "module.json").exists())
        self.assertTrue(self.source.exists())

    @unittest.skipUnless(shutil.which("tesseract"), "Tesseract is required")
    def test_scanned_image_uses_real_local_ocr(self):
        from PIL import Image, ImageDraw, ImageFont
        font = ImageFont.truetype("DejaVuSans.ttf", 36)
        image = Image.new("RGB", (1600, 900), "white")
        draw = ImageDraw.Draw(image)
        for at, line in enumerate(PAPER.replace("first symptom", "first symptom in a child with suspected infection").splitlines()):
            draw.text((70, 70 + at * 90), line, font=font, fill="black")
        target = self.source.parent / "2024.png"
        image.save(target)
        original = target.read_bytes()
        result = prepare_exam_file(self.module, "Questions/2024.png")
        self.assertEqual(result["status"], "ready", result)
        self.assertEqual(target.read_bytes(), original)
        self.assertIn("first symptom", target.with_name("2024.png.txt").read_text())
