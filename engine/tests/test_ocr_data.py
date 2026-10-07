"""The frozen OCR directory includes language data and output renderer configs."""

import hashlib
import json
import os
import sys
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]))
sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import ocr_data

import prepare_ocr_data


class TestOcrData(unittest.TestCase):
    def test_download_rejects_mismatched_model_without_writing_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "tessdata.manifest.json").write_text(json.dumps({"files": [{
                "name": "ara.traineddata", "url": "https://example.test/model", "sha256": hashlib.sha256(b"expected").hexdigest(),
            }]}), encoding="utf-8")
            with patch.object(prepare_ocr_data.urllib.request, "urlopen", return_value=BytesIO(b"corrupt")):
                with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                    prepare_ocr_data.prepare(root)
            self.assertFalse((root / ".build/tessdata/ara.traineddata").exists())

    def test_bundled_models_override_an_empty_scoop_data_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / "tessdata"
            data.mkdir()
            for language in ("ara", "eng", "osd"):
                (data / f"{language}.traineddata").write_bytes(b"model")
            (data / "configs").mkdir()
            for renderer in ("pdf", "txt", "tsv", "hocr"):
                (data / "configs" / renderer).write_text("renderer", encoding="utf-8")
            with patch.object(sys, "_MEIPASS", directory, create=True), patch.dict(os.environ, {"TESSDATA_PREFIX": "empty-scoop-directory"}):
                ocr_data.configure_ocr_data()
                self.assertEqual(os.environ["TESSDATA_PREFIX"], str(data))

    def test_prepares_renderer_subdirectories_and_reuses_verified_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            renderer = b"tessedit_create_pdf 1\n"
            (root / "tessdata.manifest.json").write_text(json.dumps({"files": [{
                "name": "configs/pdf", "url": "https://example.test/pdf", "sha256": hashlib.sha256(renderer).hexdigest(),
            }]}), encoding="utf-8")
            with patch.object(prepare_ocr_data.urllib.request, "urlopen", return_value=BytesIO(renderer)):
                data = prepare_ocr_data.prepare(root)
            self.assertEqual((data / "configs/pdf").read_bytes(), renderer)
            with patch.object(prepare_ocr_data.urllib.request, "urlopen", side_effect=AssertionError("verified asset must not download")):
                self.assertEqual(prepare_ocr_data.prepare(root), data)

    def test_refuses_a_bundled_directory_missing_renderer_configs(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / "tessdata"
            data.mkdir()
            for language in ("ara", "eng", "osd"):
                (data / f"{language}.traineddata").write_bytes(b"model")
            with patch.object(sys, "_MEIPASS", directory, create=True), patch.dict(os.environ, {"TESSDATA_PREFIX": "original"}):
                with self.assertRaisesRegex(RuntimeError, "configs/pdf"):
                    ocr_data.configure_ocr_data()
                self.assertEqual(os.environ["TESSDATA_PREFIX"], "original")
