import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

SCRIPTS_DIR = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from source_preparation import (
    _ocr_pdf,
    automatic_preparation_manifest,
    prepare_manifest_sources,
)


class SourcePreparationTests(unittest.TestCase):
    def test_automatic_manifest_covers_legacy_slides_and_question_pdfs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            (root / "Lecture").mkdir()
            (root / "Questions").mkdir()
            (root / "Lecture" / "wounds.ppsx").write_bytes(b"slides")
            (root / "Questions" / "Final.pdf").write_bytes(b"exam")

            manifest = automatic_preparation_manifest(root)

        self.assertEqual(
            [entry["path"] for entry in manifest["sources"]],
            ["Lecture/wounds.ppsx", "Questions/Final.pdf"],
        )
        self.assertTrue(all(entry["action"] == "auto" for entry in manifest["sources"]))

    def test_ocr_forces_replacement_with_bilingual_deskewed_text_layer(self) -> None:
        commands: list[list[str]] = []

        def capture_tool(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            commands.append(command)
            return subprocess.CompletedProcess(command, 0, "eng\nara\nosd" if "--list-langs" in command else "--force-ocr --rotate-pages --deskew", "")

        with tempfile.TemporaryDirectory() as temporary_directory:
            source = Path(temporary_directory) / "scan.pdf"
            destination = Path(temporary_directory) / "scan-ocr.pdf"
            source.write_bytes(b"pdf")
            with patch(
                "source_preparation.shutil.which",
                return_value="ocrmypdf.exe",
            ), patch(
                "source_preparation.subprocess.run",
                side_effect=capture_tool,
            ):
                _ocr_pdf(source, destination, "eng+ara")

        self.assertEqual(
            commands[-1][1:-1],
            ["--force-ocr", "--rotate-pages", "--deskew", "--output-type", "pdf", "--optimize", "0", "--language", "eng+ara", str(source)],
        )

    def test_concurrent_preparation_reuses_one_complete_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            source_root = Path(temporary_directory)
            text_file = source_root / "Questions" / "shared.txt"
            text_file.parent.mkdir()
            text_file.write_text("Shared question bank", encoding="utf-8")
            manifest = {
                "assessment_sources": [
                    {"path": "Questions/shared.txt", "type": "question_bank"}
                ]
            }

            with ThreadPoolExecutor(max_workers=2) as executor:
                reports = tuple(
                    executor.map(
                        lambda _: prepare_manifest_sources(
                            source_root, manifest, execute=True
                        ),
                        range(2),
                    )
                )

            prepared_sources = tuple(report.entries[0] for report in reports)

        self.assertTrue(all(source.status == "ready" for source in prepared_sources))
        self.assertEqual(
            {source.prepared_path for source in prepared_sources},
            {prepared_sources[0].prepared_path},
        )
        self.assertEqual(
            {source.prepared_sha256 for source in prepared_sources},
            {prepared_sources[0].prepared_sha256},
        )

    def test_legacy_slide_is_planned_without_modifying_original(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            source_root = Path(temporary_directory)
            slide = source_root / "Lecture" / "anatomy.ppt"
            slide.parent.mkdir()
            original = b"legacy slide bytes"
            slide.write_bytes(original)

            report = prepare_manifest_sources(
                source_root,
                {"slides": {"path": "Lecture/anatomy.ppt", "action": "auto"}},
                execute=False,
            )

            planned = report.entries[0]
            self.assertEqual(planned.action, "convert")
            self.assertEqual(planned.upload_extension, ".pdf")
            self.assertEqual(planned.status, "planned")
            self.assertEqual(slide.read_bytes(), original)
            self.assertFalse(Path(report.cache_root).exists())

    def test_remote_recording_reference_does_not_require_local_copy(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            report = prepare_manifest_sources(
                temporary_directory,
                {"recording_sources": ["Corrosive 1.m4a"]},
                execute=False,
            )

        self.assertTrue(report.ready)
        self.assertEqual(report.entries[0].status, "remote-only")
        self.assertEqual(report.entries[0].action, "use_remote")

    def test_remote_equivalent_skips_local_ocr_for_existing_source(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            pdf = Path(temporary_directory) / "Lecture" / "book.pdf"
            pdf.parent.mkdir()
            pdf.write_bytes(b"not a valid PDF; remote copy is authoritative")

            report = prepare_manifest_sources(
                temporary_directory,
                {"references": [{"path": "Lecture/book.pdf", "action": "auto"}]},
                execute=True,
                remote_titles=("book.txt",),
            )

        self.assertTrue(report.ready)
        self.assertEqual(report.entries[0].action, "use_remote")
        self.assertEqual(report.mutation_count, 0)

    def test_uninspectable_pdf_is_planned_for_ocr(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            pdf = Path(temporary_directory) / "Lecture" / "scan.pdf"
            pdf.parent.mkdir()
            pdf.write_bytes(b"not a valid PDF")

            report = prepare_manifest_sources(
                temporary_directory,
                {"references": [{"path": "Lecture/scan.pdf", "action": "auto"}]},
                execute=False,
            )

        self.assertTrue(report.ready)
        self.assertEqual(report.entries[0].action, "ocr")
        self.assertEqual(report.entries[0].upload_extension, ".pdf")

    def test_text_source_is_planned_for_uploadable_pdf(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            text_file = Path(temporary_directory) / "Questions" / "old.txt"
            text_file.parent.mkdir()
            text_file.write_text("question bank", encoding="utf-8")

            report = prepare_manifest_sources(
                temporary_directory,
                {"assessment_sources": [{"path": "Questions/old.txt", "type": "question_bank"}]},
                execute=False,
            )

        self.assertTrue(report.ready)
        self.assertEqual(report.entries[0].action, "convert")
        self.assertEqual(report.entries[0].upload_extension, ".pdf")

    def test_text_conversion_creates_cached_pdf_without_overwriting_source(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            text_file = Path(temporary_directory) / "Questions" / "old.txt"
            text_file.parent.mkdir()
            original = "Which drug?\nمعلومة"
            text_file.write_text(original, encoding="utf-8")

            report = prepare_manifest_sources(
                temporary_directory,
                {"assessment_sources": [{"path": "Questions/old.txt", "type": "question_bank"}]},
                execute=True,
            )

            prepared = Path(report.entries[0].prepared_path)
            self.assertTrue(prepared.is_file())
            self.assertEqual(text_file.read_text(encoding="utf-8"), original)

        self.assertTrue(report.ready)

    def test_cached_conversion_keeps_canonical_basename_and_tracks_source_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            source_root = Path(temporary_directory)
            text_file = source_root / "Questions" / "old.txt"
            text_file.parent.mkdir()
            text_file.write_text("first question", encoding="utf-8")
            first = prepare_manifest_sources(
                source_root,
                {"assessment_sources": [{"path": "Questions/old.txt", "type": "question_bank"}]},
                execute=True,
            )
            first_path = Path(first.entries[0].prepared_path)
            self.assertEqual(first_path.name, "old.pdf")

            text_file.write_text("second question", encoding="utf-8")
            second = prepare_manifest_sources(
                source_root,
                {"assessment_sources": [{"path": "Questions/old.txt", "type": "question_bank"}]},
                execute=True,
            )
            second_path = Path(second.entries[0].prepared_path)
            self.assertTrue(first_path.is_file())
            self.assertTrue(second_path.is_file())

            self.assertNotEqual(first_path.parent, second_path.parent)

    def test_relevant_reference_metadata_is_preserved_for_editorial_context(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            book = Path(temporary_directory) / "Lecture" / "book.pdf"
            book.parent.mkdir()
            book.write_bytes(b"book")

            report = prepare_manifest_sources(
                temporary_directory,
                {
                    "references": [
                        {
                            "path": "Lecture/book.pdf",
                            "type": "textbook",
                            "action": "use",
                            "relevance": "terminology for the taught mechanism",
                            "topics": ["mechanism"],
                            "allow_unspoken_additions": True,
                        }
                    ]
                },
                execute=False,
            )

        reference = report.entries[0]
        self.assertEqual(reference.role, "textbook")
        self.assertTrue(reference.allow_unspoken_additions)
        self.assertEqual(reference.topics, ("mechanism",))

    def test_agent_ignored_reference_is_not_prepared(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            ignored = Path(temporary_directory) / "Lecture" / "unrelated.ppt"
            ignored.parent.mkdir()
            ignored.write_bytes(b"unrelated")

            report = prepare_manifest_sources(
                temporary_directory,
                {"assessment_sources": [{"path": "Lecture/unrelated.ppt", "type": "ignore"}]},
                execute=True,
            )

        self.assertTrue(report.ready)
        self.assertEqual(report.entries[0].status, "ignored")
        self.assertEqual(report.mutation_count, 0)

    def test_chunk_requires_agent_selected_pages_before_execution(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            pdf = Path(temporary_directory) / "Lecture" / "book.pdf"
            pdf.parent.mkdir()
            pdf.write_bytes(b"pdf")

            report = prepare_manifest_sources(
                temporary_directory,
                {"references": [{"path": "Lecture/book.pdf", "action": "chunk"}]},
                execute=False,
            )

        self.assertFalse(report.ready)
        self.assertIn("explicit relevant PDF pages", report.blocking_errors[0])

    def test_unsafe_manifest_path_is_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            report = prepare_manifest_sources(
                temporary_directory,
                {"references": [{"path": "../private.pdf", "action": "use"}]},
                execute=False,
            )

        self.assertFalse(report.ready)
        self.assertIn("escapes the module", report.blocking_errors[0])

    def test_manifest_cannot_select_one_source_in_two_groups(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            report = prepare_manifest_sources(
                temporary_directory,
                {
                    "slides": "Lecture/topic.pdf",
                    "references": [{"path": "Lecture/topic.pdf", "action": "use"}],
                },
                execute=False,
            )

        self.assertFalse(report.ready)
        self.assertIn("more than once", report.blocking_errors[0])

    def test_bare_upload_name_resolves_unique_module_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            slide = Path(temporary_directory) / "Lecture" / "legacy.ppt"
            slide.parent.mkdir()
            slide.write_bytes(b"legacy")

            report = prepare_manifest_sources(
                temporary_directory,
                {"approved_uploads": ["legacy.ppt"]},
                execute=False,
            )

        self.assertTrue(report.ready)
        self.assertEqual(report.entries[0].relative_path, "Lecture/legacy.ppt")
        self.assertEqual(report.entries[0].upload_extension, ".pdf")


class AutomaticReadingTests(unittest.TestCase):
    def test_script_noise_selects_reading_but_clean_bilingual_text_is_used(self):
        from source_preparation import PreparationEntry, _auto_action, inspect_pdf
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "paper.pdf"
            source.write_bytes(b"pdf")
            for text, expected in [
                ("WI 5 3 \u200e\u202bكلبة الطب بدمياط\u202c 'A \u202bج\u202c١ " * 10, "ocr"),
                ("Explain the symptoms and treatment of pneumonia. اشرح أعراض المرض وعلاجه. " * 10, "use"),
            ]:
                with self.subTest(expected=expected), patch("source_preparation._pdf_text", return_value=("Pages: 1", text)):
                    self.assertEqual(_auto_action(source, PreparationEntry("paper.pdf"), 1000)[0], expected)
                    self.assertEqual(inspect_pdf(source).needs_ocr, expected == "ocr")

    def test_chopped_alphabetic_layout_requires_ocr_but_clean_exam_lines_do_not(self):
        from source_preparation import (
            LAYOUT_FRAGMENTATION_LIMIT,
            PreparationEntry,
            _auto_action,
            inspect_pdf,
        )
        chopped = "Cl\nassi\nfi\ncat\nionofpoi\nsoni\nngaccor\ndingto\ntheir\nmodeof\nactioninto\n" * 8
        clean = "Exam 2023\n1. Classification of poisoning according to their mode of action into\nA. Pain\nB. Lead\nC. Iron\nD. Tin\n" * 8
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "paper.pdf"
            source.write_bytes(b"pdf")
            for text, expected in [(chopped, "ocr"), (clean, "use")]:
                with self.subTest(expected=expected), patch("source_preparation._pdf_text", return_value=("Pages: 1", text)):
                    quality = inspect_pdf(source)
                    self.assertLess(quality.script_noise_ratio, quality.script_noise_limit)
                    self.assertEqual(quality.layout_fragmentation_ratio > LAYOUT_FRAGMENTATION_LIMIT, expected == "ocr")
                    self.assertEqual(_auto_action(source, PreparationEntry("paper.pdf"), 10000)[0], expected)

    def test_cached_failure_is_retried_and_second_failure_is_recorded(self):
        from source_image_repair import ImageRepairError
        from source_preparation import PreparationError, _ocr_artifact
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "out.pdf"
            failure = destination.parent / "repair-failed.txt"
            failure.write_text("old failure")
            with patch("source_preparation._local_ocr_artifact", return_value=None) as local, patch("source_preparation.transcribe_page_images", side_effect=ImageRepairError("unreadable")):
                for language in ["eng+ara", "eng"]:
                    with self.assertRaisesRegex(PreparationError, "unreadable"):
                        _ocr_artifact(destination, destination, language)
                self.assertEqual(local.call_count, 4)
                self.assertFalse(local.call_args_list[0].kwargs["stronger"])
                self.assertTrue(local.call_args_list[1].kwargs["stronger"])
                self.assertIn("unreadable", failure.read_text())

    def test_missing_tools_are_machine_readable(self):
        from source_preparation import PreparationError
        with patch("source_preparation.shutil.which", return_value=None):
            with self.assertRaisesRegex(PreparationError, 'ocr_tool_missing:.*ocrmypdf.*tesseract'):
                _ocr_pdf(Path("scan.pdf"), Path("out.pdf"), "eng+ara")


class ReadingToolAvailabilityTests(unittest.TestCase):
    def test_missing_language_data_reports_tesseract(self):
        from source_preparation import PreparationError
        with patch("source_preparation.shutil.which", side_effect=lambda name: "/fake/" + name), patch(
            "source_preparation.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "eng", "")
        ), self.assertRaisesRegex(PreparationError, 'ocr_tool_missing:.*tesseract'):
            _ocr_pdf(Path("scan.pdf"), Path("out.pdf"), "eng+ara")

    def test_retry_only_adds_flags_advertised_by_the_installed_reader(self):
        commands = []

        def run(command, **_kwargs):
            commands.append(command)
            output = "eng\nara" if "--list-langs" in command else "--force-ocr"
            return subprocess.CompletedProcess(command, 0, output, "")

        with tempfile.TemporaryDirectory() as temporary, patch(
            "source_preparation.shutil.which", side_effect=lambda name: "/fake/" + name
        ), patch("source_preparation.subprocess.run", side_effect=run):
            _ocr_pdf(Path(temporary) / "scan.pdf", Path(temporary) / "out.pdf", "eng+ara")
        self.assertIn("--force-ocr", commands[-1])
        self.assertNotIn("--rotate-pages", commands[-1])
        self.assertNotIn("--deskew", commands[-1])

    def test_invalid_noise_threshold_is_rejected_at_manifest_parsing(self):
        report = prepare_manifest_sources(Path("/tmp"), {"sources": [{
            "path": "scan.pdf", "ocr_script_noise_limit": 1.5,
        }]}, execute=False)
        self.assertIn("ocr_script_noise_limit", report.blocking_errors[0])


if __name__ == "__main__":
    unittest.main()
