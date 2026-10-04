"""Phase-0 regression: another lecture's handwritten notes must not stop finalize."""
import base64
import contextlib
import hashlib
import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

import nlm_client
import run_transcription as launcher
import universal_transcribe as engine
from module_registry import load_module
from source_image_repair import ImageRepairError, _validated_pages, transcribe_page_images
from source_preparation import prepare_manifest_sources

PAGE_TEXT = "Synthetic handwritten notes: thyroid hormones regulate metabolism. A dose is 5 mg. [illegible]"
PIXEL = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=")


def image_pdf(path: Path, pages: int = 1) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas = Canvas(str(path), pagesize=(120, 120))
    for _ in range(pages):
        canvas.drawImage(ImageReader(io.BytesIO(PIXEL)), 10, 10, 100, 100)
        canvas.showPage()
    canvas.save()


class SourceCommands:
    """Fake only external OCR, office, agy and NotebookLM commands; Poppler stays real."""

    def __init__(self, root: Path, reply: object = None):
        self.real_run = subprocess.run
        self.real_which = shutil.which
        self.root = root
        self.reply = reply if reply is not None else {"pages": [{"page": 1, "text": PAGE_TEXT}]}
        self.remote = [{"id": "recording", "title": "topic.mp3", "status": "ready"}]
        self.uploaded: list[Path] = []
        self.model_directories: list[Path] = []
        self.local_ocr_text = ""
        self.local_confidence = 95

    def which(self, name: str, *args, **kwargs):
        if name in {"agy", "ocrmypdf", "tesseract", "libreoffice"}:
            return f"/fake/{name}"
        return self.real_which(name, *args, **kwargs)

    def run(self, command, **kwargs):
        name = Path(command[0]).name
        if name == "ocrmypdf":
            if self.local_ocr_text:
                canvas = Canvas(command[-1])
                canvas.drawString(20, 750, self.local_ocr_text)
                canvas.save()
            else:
                shutil.copyfile(command[-2], command[-1])
            return subprocess.CompletedProcess(command, 0, "", "")
        if name == "tesseract":
            tsv = f"conf\ttext\n{self.local_confidence}\t{self.local_ocr_text}\n" if command[-1] == "tsv" else self.local_ocr_text
            return subprocess.CompletedProcess(command, 0, tsv, "")
        if name == "libreoffice":
            output = Path(command[command.index("--outdir") + 1]) / (Path(command[-1]).stem + ".pdf")
            image_pdf(output)
            return subprocess.CompletedProcess(command, 0, "", "")
        if name == "agy":
            directory = Path(kwargs["cwd"])
            self.model_directories.append(directory)
            assert directory != self.root and directory.is_dir()
            assert all(path.suffix == ".png" for path in directory.iterdir())
            if isinstance(self.reply, Exception):
                raise self.reply
            envelope = {"status": "SUCCESS", "response": json.dumps(self.reply)}
            return subprocess.CompletedProcess(command, 0, json.dumps(envelope), "")
        if name == "nlm":
            if command[1:3] == ["notebook", "list"]:
                payload = [{"id": "notebook", "title": "Synthetic module"}]
            elif command[1:3] == ["notebook", "get"]:
                payload = {"id": "notebook", "title": "Synthetic module"}
            elif command[1:3] == ["source", "list"]:
                payload = self.remote
            elif command[1:3] == ["source", "add"]:
                uploaded = Path(command[command.index("--file") + 1])
                self.uploaded.append(uploaded)
                self.remote.append({"id": str(len(self.remote)), "title": uploaded.name, "status": "ready",
                                    "sha256": hashlib.sha256(uploaded.read_bytes()).hexdigest()})
                payload = {}
            else:
                raise AssertionError(f"Unexpected NotebookLM mutation: {command}")
            return subprocess.CompletedProcess(command, 0, json.dumps(payload), "")
        return self.real_run(command, **kwargs)

    @contextlib.contextmanager
    def installed(self):
        binary = self.root / "nlm"
        binary.write_text("fake external executable", encoding="utf-8")
        # Disable process-global inventory caching to avoid touching any other module.
        with patch.dict("os.environ", {"TRANSCRIBER_AGY": "on"}), patch("shutil.which", side_effect=self.which), \
                patch("subprocess.run", side_effect=self.run), patch.object(nlm_client, "_INVENTORY_CACHE_ROOT", None):
            yield str(binary)


def request(root: Path, binary: str, reference: str | None = None, **changes) -> engine.Phase0Request:
    manifest = {"recording_sources": ["topic.mp3"]}
    if reference:
        manifest["references"] = [{"path": reference, "role": "handout", "action": "auto"}]
    fields = {"config": {"nlm_executable": binary, "_inventory_cache_bypass": True},
              "requested_notebook_ids": ("notebook",), "subject": "Synthetic module", "sources_root": str(root),
              "lecture_name": "topic", "recording_sources": ("topic.mp3",), "slides_path": None,
              "agent_reviewed": True, "preparation_manifest": manifest}
    fields.update(changes)
    return engine.Phase0Request(**fields)


class SourceAutoRepairTests(unittest.TestCase):
    def test_unrelated_handwritten_pdf_neither_blocks_nor_uploads(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            scan = root / "Lecture" / "other lecture.pdf"
            image_pdf(scan)
            original = scan.read_bytes()
            commands = SourceCommands(root)
            with commands.installed() as binary:
                report = engine.run_phase0_sync(request(root, binary))
            self.assertEqual(report.blocking_errors, [])
            self.assertEqual(commands.uploaded, [])
            self.assertEqual(commands.model_directories, [])
            self.assertEqual(scan.read_bytes(), original)

    def test_selected_pdf_and_image_upload_cached_model_text_without_separate_approval(self):
        for extension in (".pdf", ".png"):
            with self.subTest(extension=extension), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                scan = root / "Lecture" / ("notes" + extension)
                scan.parent.mkdir()
                if extension == ".pdf":
                    image_pdf(scan)
                else:
                    scan.write_bytes(PIXEL)
                original = scan.read_bytes()
                image_pdf(root / "Lecture" / "unrelated.pdf")
                commands = SourceCommands(root)
                with commands.installed() as binary:
                    report = engine.run_phase0_sync(request(root, binary, f"Lecture/notes{extension}"))
                    uploaded = commands.uploaded[0]
                    text = commands.real_run(["pdftotext", str(uploaded), "-"], capture_output=True, text=True).stdout
                    # Removing the remote copy exercises repair-cache reuse, not remote reuse.
                    commands.remote = commands.remote[:1]
                    commands.reply = AssertionError("a second model read must not be needed")
                    cached = engine.run_phase0_sync(request(root, binary, f"Lecture/notes{extension}"))
                self.assertIn(PAGE_TEXT, " ".join(text.split()))
                self.assertIn("Model transcription", text)
                self.assertIn("Page 1", text)
                self.assertNotEqual(uploaded, scan)
                self.assertEqual(scan.read_bytes(), original)
                self.assertEqual(report.uploaded[0].prepared_sha256, cached.uploaded[0].prepared_sha256)
                self.assertTrue(all(not directory.exists() for directory in commands.model_directories))
                self.assertEqual(report.warnings, [])
                self.assertEqual(len(report.uploaded), 1)
                self.assertTrue(all(path.stem == "notes" for path in commands.uploaded))

    def test_low_confidence_ocr_uses_model_text_while_reliable_ocr_stays_local(self):
        local_text = "Local OCR text: this synthetic printed page contains enough readable text for source verification."
        for extension, confidence in ((".pdf", 33), (".pdf", 95), (".png", 33), (".png", 95)):
            with self.subTest(extension=extension, confidence=confidence), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source = root / "Lecture" / ("notes" + extension)
                source.parent.mkdir()
                if extension == ".pdf":
                    image_pdf(source)
                else:
                    source.write_bytes(PIXEL)
                commands = SourceCommands(root)
                commands.local_ocr_text = local_text
                commands.local_confidence = confidence
                if confidence == 95:
                    commands.reply = AssertionError("reliable local OCR must not need a model read")
                with commands.installed() as binary:
                    report = engine.run_phase0_sync(request(root, binary, f"Lecture/notes{extension}"))
                expected = PAGE_TEXT if confidence == 33 else local_text
                extracted = commands.real_run(["pdftotext", report.uploaded[0].path, "-"], capture_output=True, text=True).stdout
                self.assertIn(expected, " ".join(extracted.split()))
                self.assertEqual(report.warnings, [])

    def test_failed_model_reader_omits_selected_support_and_emits_job_warning(self):
        replies = (OSError("agy unavailable"), {"pages": [{"page": 1, "text": "[illegible]"}]})
        for reply in replies:
            with self.subTest(reply=type(reply).__name__), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                image_pdf(root / "Lecture" / "notes.pdf")
                # Model process failure is an OS/CLI boundary failure, not a swallowed coding error.
                commands = SourceCommands(root, reply)
                output = io.StringIO()
                with commands.installed() as binary, contextlib.redirect_stdout(output):
                    report = engine.run_phase0_sync(request(root, binary, "Lecture/notes.pdf",
                                                         slides_path="Lecture/notes.pdf", approved_uploads=("notes.pdf",)))
                    commands.reply = AssertionError("failed repair must also be cached")
                    engine.run_phase0_sync(request(root, binary, "Lecture/notes.pdf", slides_path="Lecture/notes.pdf"))
                self.assertEqual(report.blocking_errors, [])
                self.assertEqual(commands.uploaded, [])
                self.assertEqual(report.slide_source, "")
                self.assertEqual(report.omitted_sources, {"lecture/notes.pdf"})
                self.assertIn("Continuing without supporting document 'Lecture/notes.pdf'", report.warnings[0])
                self.assertIn("[SOURCE-WARNING] " + report.warnings[0], output.getvalue())

    def test_finalize_launcher_uses_lecture_manifest_despite_failed_module_sync(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "synthetic"
            root.mkdir()
            for name in ("Lecture", "Questions", "Transcripts"):
                (root / name).mkdir()
            (root / "module.json").write_text(json.dumps({
                "schema_version": 1, "module_id": "synthetic", "display_name": "Synthetic module",
                "emoji": "X", "notebook": {"id": "notebook", "title": "Synthetic module", "profile": None},
            }), encoding="utf-8")
            module = load_module(root)
            checkpoint = root / ".transcriber-cache" / "source-sync" / "state.json"
            checkpoint.parent.mkdir(parents=True)
            checkpoint.write_text(json.dumps({"status": "partial", "sources": []}), encoding="utf-8")
            manifest = root / "lecture.json"
            manifest.write_text(json.dumps({"title": "topic", "recording_sources": ["topic.mp3"],
                                           "assessment_sources": [], "exam_style_profile": {"mcq": {"register": "short"}}}), encoding="utf-8")
            invoked = root / "engine-invoked.txt"
            child = root / "fake_engine.py"
            child.write_text(f"from pathlib import Path\nPath({str(invoked)!r}).write_text('finalize')\n", encoding="utf-8")
            commands = SourceCommands(root)
            with commands.installed() as binary:
                context = launcher.LauncherContext(child, engine, {"nlm_executable": binary}, module,
                    lambda: engine.resolve_notebooks({"nlm_executable": binary}, ("notebook",), "Synthetic module"))
                args = launcher._parser().parse_args(["--source-manifest", str(manifest), "--finalize-draft"])
                code = launcher._run_context(args, "transcription", context)
            self.assertEqual(code, 0)
            self.assertEqual(invoked.read_text(), "finalize")
            self.assertEqual(json.loads(checkpoint.read_text())["status"], "partial")

    def test_empty_required_recording_blocks_with_plain_message(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            recording = root / "Lecture" / "topic.mp3"
            recording.parent.mkdir()
            recording.write_bytes(b"")
            commands = SourceCommands(root)
            commands.remote = []
            with commands.installed() as binary, self.assertRaisesRegex(engine.Phase0Error, "Required source.*topic.mp3.*Recording file is empty"):
                engine.run_phase0_sync(request(root, binary))
            self.assertEqual(commands.uploaded, [])

    def test_unreadable_required_exam_blocks_after_attempted_repair(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image_pdf(root / "Questions" / "Final 2025.pdf")
            assessment = {"path": "Questions/Final 2025.pdf", "type": "past_exam", "year": 2025}
            commands = SourceCommands(root, {"pages": []})
            with commands.installed() as binary, self.assertRaisesRegex(engine.Phase0Error, "Required source.*Final 2025.pdf.*unusable"):
                engine.run_phase0_sync(request(root, binary, assessment_sources=(assessment,),
                    preparation_manifest={"recording_sources": ["topic.mp3"], "assessment_sources": [assessment]}))
            self.assertEqual(commands.uploaded, [])

    def test_converted_image_only_slides_are_repaired_and_uploaded(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "Lecture" / "notes.ppt"
            source.parent.mkdir()
            source.write_bytes(b"synthetic legacy presentation")
            commands = SourceCommands(root)
            with commands.installed() as binary:
                report = engine.run_phase0_sync(request(root, binary, slides_path="Lecture/notes.ppt",
                    preparation_manifest={"recording_sources": ["topic.mp3"], "slides": "Lecture/notes.ppt"}))
            self.assertEqual(report.uploaded[0].upload_extension, ".pdf")
            self.assertIn("Model transcription", report.preparation.by_relative_path["lecture/notes.ppt"].notes)

    def test_unknown_supporting_format_is_omitted_without_upload(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "Lecture" / "notes.zip"
            source.parent.mkdir()
            source.write_bytes(b"unknown supporting format")
            commands = SourceCommands(root)
            with commands.installed() as binary:
                report = engine.run_phase0_sync(request(root, binary, "Lecture/notes.zip"))
            self.assertEqual(commands.uploaded, [])
            self.assertIn("No safe automatic converter", report.warnings[0])

    def test_explicit_remote_reference_requires_a_ready_notebook_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image_pdf(root / "Lecture" / "notes.pdf")
            commands = SourceCommands(root)
            with commands.installed() as binary, self.assertRaisesRegex(engine.Phase0Error, "use_remote.*no ready matching"):
                engine.run_phase0_sync(request(root, binary, preparation_manifest={
                    "recording_sources": ["topic.mp3"],
                    "references": [{"path": "Lecture/notes.pdf", "action": "use_remote"}],
                }))
            self.assertEqual(commands.uploaded, [])
            self.assertEqual(commands.model_directories, [])

    def test_page_cap_refuses_model_call_and_partial_model_pages_are_unusable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "large.pdf"
            image_pdf(source, 31)
            commands = SourceCommands(root)
            with commands.installed(), self.assertRaisesRegex(ImageRepairError, "1–30 pages"):
                transcribe_page_images(source, root / "repair.md")
            self.assertEqual(commands.model_directories, [])
        for reply in ([], [{"page": 2, "text": PAGE_TEXT}], [{"page": 1, "text": "[illegible]"}],
                      [{"page": True, "text": PAGE_TEXT}]):
            with self.subTest(reply=reply), self.assertRaises(ImageRepairError):
                _validated_pages(reply, 1)

    def test_repair_timeout_is_recorded_as_a_preparation_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image_pdf(root / "Lecture" / "notes.pdf")
            commands = SourceCommands(root, subprocess.TimeoutExpired("agy", 300))
            with commands.installed():
                report = prepare_manifest_sources(root, {"references": ["Lecture/notes.pdf"]}, execute=True)
            self.assertFalse(report.ready)
            self.assertIn("page-image transcription failed", report.source_errors["Lecture/notes.pdf"])
            self.assertTrue(all(not directory.exists() for directory in commands.model_directories))


if __name__ == "__main__":
    unittest.main()
