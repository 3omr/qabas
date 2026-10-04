"""External medical illustrations fail closed at HTTP, model and durable-file inputs."""

import base64
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

import agy_writer
import engine_settings
import mcp_server
import web_figures as web
from phase_validation import SECTION_HEADINGS
from run_transcription import generate_auto_manifest
from transcript_contract import (
    DraftingHandoffContext,
    build_drafting_contract,
    validate_complete_transcript,
)
from universal_transcribe import finalize_student_document

REAL_SUBPROCESS_RUN = subprocess.run

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
EVIDENCE = "The keloid grows beyond the original wound."
REQUEST = {"description": "Keloid extending beyond the wound", "search": "keloid scar", "evidence": EVIDENCE}
PLACEHOLDER = '<!-- qabas-web-figure ' + json.dumps(REQUEST) + ' -->'
GUIDE = '## 📖 Chronological Guide\n' + EVIDENCE + '\n' + PLACEHOLDER
YES = {"answer": "yes", "confidence": 0.96, "reason": "Clearly extends beyond the wound."}
NO = {"answer": "no", "confidence": 0.99, "reason": "Only normal skin is visible."}


def page(index, license_name="CC BY-SA 4.0", license_url="https://creativecommons.org/licenses/by-sa/4.0/"):
    return {"index": index, "title": f"File:Scar-{index}.png", "imageinfo": [{
        "url": f"https://upload.wikimedia.org/wikipedia/commons/scar-{index}.png",
        "descriptionurl": f"https://commons.wikimedia.org/wiki/File:Scar-{index}.png",
        "size": len(PNG), "mime": "image/png", "extmetadata": {
            key: {"value": field} for key, field in {
                "LicenseShortName": license_name, "LicenseUrl": license_url,
                "Artist": '<a href="/wiki/User:Photographer">Photographer</a>',
                "Credit": "Own work", "License": "cc-by-sa-4.0",
            }.items()
        }}]}


class HttpResponse(io.BytesIO):
    headers: dict[str, str] = {}


class FakeHttp:
    def __init__(self, pages=None, image=PNG, error=None):
        self.pages = pages if pages is not None else [page(1)]
        self.image = image
        self.error = error
        self.urls = []

    def open(self, request, timeout):
        self.urls.append(request.full_url)
        if self.error:
            raise self.error
        if urlparse(request.full_url).path == "/w/api.php":
            query = parse_qs(urlparse(request.full_url).query)
            assert query["gsrnamespace"] == ["6"]
            assert query["iiprop"] == ["url|extmetadata|mime|size"]
            assert "Qabas" in request.get_header("User-agent")
            return HttpResponse(json.dumps({"query": {"pages": self.pages}}).encode())
        return HttpResponse(self.image)


class WebFigureTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.workspace = Path(temporary.name)
        self.directory = self.workspace / "modules" / "surgery" / "Transcripts" / "Figures" / "Scars"
        self.http = FakeHttp()
        self.answers = [YES]
        for target, replacement in (("web_figures.build_opener", lambda *args: self.http),
                                    ("web_figures.time.sleep", lambda delay: None),
                                    ("web_figures.subprocess.run", self.model),
                                    ("agy_writer.disabled", lambda: False),
                                    ("agy_writer.binary_path", lambda: "fake-agy")):
            mocked = patch(target, replacement)
            mocked.start()
            self.addCleanup(mocked.stop)

    def model(self, command, **options):
        if command[0] != "fake-agy":
            return REAL_SUBPROCESS_RUN(command, **options)
        directory = Path(options["cwd"])
        self.assertEqual((directory / "candidate.png").read_bytes(), PNG)
        self.assertEqual(command[command.index("--model") + 1], agy_writer.DEFAULT_MODEL)
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        response = {"status": "SUCCESS", "response": json.dumps(answer)}
        return subprocess.CompletedProcess(command, 0, json.dumps(response), "")

    def resolve(self, text=GUIDE, evidence=None):
        return web.resolve_placeholders(text, self.workspace, self.directory,
                                        evidence or web.LectureEvidence(EVIDENCE))

    def test_mixed_licenses_and_no_then_yes_store_and_render_only_approved_image(self):
        self.http.pages = [page(1, "CC BY-NC 4.0", "https://creativecommons.org/licenses/by-nc/4.0/"),
                           page(2, "Unknown", ""), page(3), page(4)]
        self.answers = [NO, YES]
        rendered = self.resolve()
        self.assertNotIn("qabas-web-figure", rendered)
        expected = Path(__file__).parent / "expected" / "web-figure.md"
        self.assertEqual(rendered + "\n", expected.read_text(encoding="utf-8"))
        self.assertIn(web.LABEL, rendered)
        self.assertIn("المصدر: Scar-4.png — Photographer، CC BY-SA 4.0", rendered)
        manifest = json.loads((self.directory / web.MANIFEST_NAME).read_text())
        entry = manifest["figures"][0]
        self.assertEqual(entry["verification"], YES)
        self.assertEqual(entry["description"], REQUEST["description"])
        self.assertEqual(entry["credit"], "Own work")
        self.assertTrue(entry["retrieved_at"])
        self.assertEqual((self.directory / "web" / entry["file"]).read_bytes(), PNG)
        self.assertFalse(web.web_figure_errors(rendered, (self.directory,)))
        self.assertNotIn(self.http.pages[0]["imageinfo"][0]["url"], self.http.urls)
        self.http.error = URLError("offline")
        self.assertEqual(self.resolve(), rendered)

    def test_no_uncertain_malformed_or_failed_verification_never_render(self):
        for answer in (NO, {**YES, "confidence": 0.89}, {**YES, "confidence": True},
                       {**YES, "reason": "two\nlines"}, {**YES, "extra": "field"},
                       {**YES, "confidence": float("nan")}):
            with self.subTest(answer=answer):
                self.answers = [answer]
                self.assertNotIn(web.LABEL, self.resolve())
                self.assertFalse((self.directory / web.MANIFEST_NAME).exists())
        with patch("web_figures.subprocess.run", side_effect=subprocess.TimeoutExpired("agy", 60)):
            self.assertNotIn(web.LABEL, self.resolve())

    def test_http_requests_are_spaced_without_using_a_real_clock_or_network(self):
        clock = [0.0]
        timestamps = []
        http_open = self.http.open

        def observe(request, timeout):
            timestamps.append(clock[0])
            return http_open(request, timeout)

        def advance(seconds):
            clock[0] += seconds

        with patch("web_figures.time.monotonic", lambda: clock[0]), patch("web_figures.time.sleep", advance), \
             patch.object(self.http, "open", observe):
            self.assertIn(web.LABEL, self.resolve())
        self.assertEqual(len(timestamps), 2)
        self.assertGreaterEqual(timestamps[1] - timestamps[0], 1)

    def test_expired_step_and_unterminated_marker_leave_the_guide_without_network(self):
        with patch("web_figures.time.monotonic", side_effect=[0, 200, 200]):
            self.assertNotIn(web.LABEL, self.resolve())
        self.assertFalse(self.http.urls)
        unfinished = GUIDE.replace(" -->", "") + "\nKeep this doctor's paragraph."
        self.assertEqual(web.remove_placeholders(unfinished),
                         '## 📖 Chronological Guide\n' + EVIDENCE + "\nKeep this doctor's paragraph.")

    def test_special_lecture_names_render_encoded_paths_and_changed_image_bytes_refuse(self):
        self.directory = self.directory.with_name("Scars (clinical)")
        rendered = self.resolve()
        self.assertIn("Figures/Scars%20%28clinical%29/web/", rendered)
        self.assertFalse(web.web_figure_errors(rendered, (self.directory,)))
        entry = json.loads((self.directory / web.MANIFEST_NAME).read_text())["figures"][0]
        (self.directory / "web" / entry["file"]).write_bytes(PNG + b"changed image")
        self.assertTrue(web.web_figure_errors(rendered, (self.directory,)))

    def test_offline_bad_response_and_oversize_download_remove_placeholders(self):
        for failure in (URLError("offline"), TimeoutError("timeout"), ValueError("malformed API")):
            with self.subTest(failure=failure):
                self.http.error = failure
                self.assertNotIn("qabas-web-figure", self.resolve())
        self.http.error = None
        for image in (b"<html>error</html>", PNG + b"x" * web.MAX_BYTES):
            with self.subTest(size=len(image)):
                self.http.image = image
                self.assertNotIn(web.LABEL, self.resolve())
                self.assertFalse((self.directory / web.MANIFEST_NAME).exists())

    def test_corrupt_preferences_and_manifest_write_failure_omit_optional_images(self):
        preference_path = self.workspace / ".qabas-engine-settings.json"
        preference_path.write_text('{"web_figures":"false"}')
        self.assertNotIn(web.LABEL, self.resolve())
        self.assertFalse(self.http.urls)
        with self.assertRaises(ValueError):
            engine_settings.read_settings(self.workspace)
        for request in ({}, {"web_figures": "false"}):
            with self.subTest(request=request), self.assertRaises(mcp_server.ToolError):
                mcp_server._set_engine_settings(request, self.workspace)
        preference_path.unlink()
        with patch("atomic_io.os.replace", side_effect=OSError("read-only filesystem")):
            self.assertNotIn(web.LABEL, self.resolve())
        self.assertFalse((self.directory / web.MANIFEST_NAME).exists())

    def test_switch_disables_prompts_network_and_cached_placeholder_reuse(self):
        rendered = self.resolve()
        self.assertIn(web.LABEL, rendered)
        self.http.urls.clear()
        saved = json.loads(mcp_server._set_engine_settings({"web_figures": False}, self.workspace))
        self.assertEqual(saved, {"web_figures": False})
        self.assertEqual(json.loads(mcp_server._get_engine_settings({}, self.workspace)), saved)
        self.assertNotIn(web.LABEL, self.resolve())
        self.assertEqual(self.http.urls, [])
        prompt = agy_writer.guide_prompt(DraftingHandoffContext(web_figures=False), "Surgery", EVIDENCE,
                                         {"part": 1, "total": 1})
        self.assertNotIn("<!-- qabas-web-figure", prompt)
        engine_settings.set_settings(self.workspace, True)
        self.assertIn("<!-- qabas-web-figure", build_drafting_contract())
        self.assertEqual(self.resolve(), rendered)

    def test_grounding_guide_scope_duplicates_and_five_lecture_limit(self):
        for text, evidence in ((GUIDE, web.LectureEvidence("unrelated spoken words")),
                               (GUIDE.replace("Chronological Guide", "Written Questions"), web.LectureEvidence(EVIDENCE)),
                               (GUIDE.replace('"search": "keloid scar"', '"search": 7'), web.LectureEvidence(EVIDENCE))):
            with self.subTest(text=text):
                self.assertNotIn(web.LABEL, self.resolve(text, evidence))
        self.assertFalse(self.http.urls)
        duplicated = self.resolve(GUIDE + '\n' + PLACEHOLDER)
        self.assertEqual(duplicated.count(web.LABEL), 1)
        requests = [f'<!-- qabas-web-figure {json.dumps({**REQUEST, "description": f"Visual scar {i}"})} -->' for i in range(8)]
        rendered = self.resolve('## 📖 Chronological Guide\n' + '\n'.join(requests))
        self.assertEqual(rendered.count(web.LABEL), 4)
        self.assertEqual(len(json.loads((self.directory / web.MANIFEST_NAME).read_text())["figures"]), 5)

    def test_slide_images_reach_verifier_and_changed_slides_invalidate_cache(self):
        slide = self.workspace / "slide.png"
        slide.write_bytes(PNG)
        original_model = self.model

        def inspect(command, **options):
            self.assertEqual((Path(options["cwd"]) / "slide-0.png").read_bytes(), PNG)
            return original_model(command, **options)

        with patch("web_figures.subprocess.run", inspect):
            rendered = self.resolve(evidence=web.LectureEvidence(EVIDENCE, (slide,)))
        self.assertIn(web.LABEL, rendered)
        slide.write_bytes(PNG + b"updated")
        self.answers = [NO]
        self.assertNotIn(web.LABEL, self.resolve(evidence=web.LectureEvidence(EVIDENCE, (slide,))))

    def test_validator_rejects_missing_manifest_license_attribution_and_file(self):
        rendered = self.resolve()
        manifest_path = self.directory / web.MANIFEST_NAME
        original = manifest_path.read_text()
        self.assertFalse(web.web_figure_errors(rendered, (self.directory,)))
        for change in ("license", "verification", "author"):
            manifest = json.loads(original)
            manifest["figures"][0][change] = "unknown"
            manifest_path.write_text(json.dumps(manifest))
            self.assertTrue(web.web_figure_errors(rendered, (self.directory,)))
        manifest_path.write_text(original)
        extra_image = next(web.IMAGE_LINK.finditer(rendered))[0]
        for text in (rendered + extra_image, rendered.replace("> المصدر:", "> omitted:"),
                     rendered.replace("Figures/Scars/web/", "Figures/Scars/web/invented-")):
            self.assertTrue(web.web_figure_errors(text, (self.directory,)))
        entry = json.loads(original)["figures"][0]
        (self.directory / "web" / entry["file"]).unlink()
        self.assertTrue(web.web_figure_errors(rendered, (self.directory,)))
        manifest_path.unlink()
        self.assertTrue(any("web figures:" in error for error in validate_complete_transcript(
            rendered, figure_directories=(self.directory,))))

    def review_fixture(self):
        root = self.workspace / "modules" / "surgery"
        for folder in ("Lecture", "Questions", "Verbatim", "Transcripts"):
            (root / folder).mkdir(parents=True, exist_ok=True)
        (root / "module.json").write_text(json.dumps({"schema_version": 1, "module_id": "surgery",
            "display_name": "Surgery", "notebook": {"id": "fake"}, "output": {"emoji": "🧪"}}))
        (root / "Lecture" / "Scars.mp3").write_bytes(b"fake recording")
        narration = EVIDENCE + " " + "الدكتور بيشرح شكل الندبة بالتفصيل. " * 500
        (root / "Verbatim" / "Scars.verbatim.md").write_text(narration)
        manifest = generate_auto_manifest(root, "Scars", discover_remote=False)
        arguments = {"module": "surgery", "manifest_path": str(manifest)}
        context = mcp_server._resolve_draft_context(arguments, self.workspace)
        return arguments, context, narration

    def test_mcp_review_assembly_resolves_and_validates_the_saved_web_figure(self):
        arguments, context, narration = self.review_fixture()
        draft = SECTION_HEADINGS[0] + "\n" + narration + "\n" + PLACEHOLDER + "\n\n" + "\n\n".join(SECTION_HEADINGS[1:])
        mcp_server._apply_review({**arguments, "content": draft}, self.workspace)
        saved = context.path.read_text()
        self.assertIn(web.LABEL, saved)
        self.assertNotIn("qabas-web-figure", saved)
        self.assertFalse(validate_complete_transcript(saved, figure_directories=context.figure_directories))
        final = finalize_student_document(saved + "\n" + PLACEHOLDER, set(), transcript=context.path)
        self.assertNotIn("qabas-web-figure", final)
        self.assertIn(web.LABEL, final)
        engine_settings.set_settings(self.workspace, False)
        context.path.unlink()
        handoff = json.loads(mcp_server._read_draft(arguments, self.workspace))
        self.assertNotIn("<!-- qabas-web-figure", handoff["contract"])

    def test_slide_paths_must_be_listed_and_web_images_cannot_satisfy_slide_requirement(self):
        self.directory.mkdir(parents=True)
        slide = self.directory / "page-001.png"
        slide.write_bytes(PNG)
        (self.directory / "figures.json").write_text(json.dumps({"figures": [{"file": slide.name}]}))
        linked = "![Slide](<./Figures/Scars/page-001.png>)"
        self.assertFalse(web.figure_reference_errors(linked, (self.directory,)))
        self.assertTrue(web.figure_reference_errors(linked.replace("001", "999"), (self.directory,)))
        for markup in ('![Scar][image]\n[image]: Figures/Scars/web/unlisted.png',
                       '<img src="Figures/Scars/web/unlisted.png">'):
            with self.subTest(markup=markup):
                self.assertTrue(web.figure_reference_errors(markup, (self.directory,)))
        deck = self.workspace / "slides.pdf"
        deck.write_bytes(b"fake deck")
        rendered = self.resolve()
        findings = validate_complete_transcript(rendered, slides_path=deck, figure_directories=(self.directory,))
        self.assertTrue(any("0 link(s)" in error for error in findings))

    def test_desktop_entry_reads_and_sets_only_the_temporary_workspace(self):
        launcher = Path(__file__).parents[1] / "scripts" / "run_transcription.py"
        for arguments, enabled in ((["--get-engine-settings"], True), (["--set-web-figures", "off"], False),
                                   (["--get-engine-settings"], False), (["--set-web-figures", "on"], True)):
            with self.subTest(arguments=arguments):
                # The desktop entry is a real subprocess; only model invocations are faked.
                completed = subprocess.run([sys.executable, str(launcher), "--workspace", str(self.workspace), *arguments],
                                           capture_output=True, text=True, timeout=20)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertEqual(json.loads(completed.stdout), {"web_figures": enabled})

    def test_resolved_staged_boundaries_recover_missing_parts_exactly(self):
        arguments, context, narration = self.review_fixture()
        guide = SECTION_HEADINGS[0] + "\n" + narration + "\n" + PLACEHOLDER + "\n\n"
        questions = "\n\n".join(SECTION_HEADINGS[1:])
        for number, content in enumerate((guide, questions), 1):
            mcp_server._stage_draft_part({**arguments, "part": number, "parts": 2, "content": content}, self.workspace)
        mcp_server._apply_review({**arguments, "from_parts": True}, self.workspace)
        saved = context.path.read_text()
        self.assertIn(web.LABEL, saved)
        part_path = mcp_server._staged_part_path(context, 1)
        part_path.unlink()
        mcp_server._read_draft(arguments, self.workspace)
        recovered = part_path.read_text()
        self.assertEqual(recovered + questions, saved)
        self.assertIn(web.LABEL, recovered)
        mcp_server._apply_review({**arguments, "from_parts": True}, self.workspace)
        self.assertEqual(context.path.read_text(), saved)
        self.assertEqual(mcp_server._review_character_count(guide),
                         mcp_server._review_character_count(recovered))
        self.assertEqual(mcp_server._review_character_count(PLACEHOLDER), 0)

    def test_license_allowlist_and_structured_placeholder_reject_unknown_variants(self):
        for name, url, accepted in (
            ("CC0", "https://creativecommons.org/publicdomain/zero/1.0/", True),
            ("Public domain", "https://creativecommons.org/publicdomain/mark/1.0/", True),
            ("CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/", True),
            ("CC BY-SA 3.0", "https://creativecommons.org/licenses/by-sa/3.0/", True),
            ("CC BY-ND 4.0", "https://creativecommons.org/licenses/by-nd/4.0/", False),
            ("CC BY-NC-SA 4.0", "https://creativecommons.org/licenses/by-nc-sa/4.0/", False),
            ("CC BY 4.0", "https://evil.test/licenses/by/4.0/", False),
            ("CC BY-SA 4.0", "https://creativecommons.org/licenses/by/4.0/", False),
        ):
            with self.subTest(name=name, url=url):
                self.assertEqual(web.accepted_license(name, url), accepted)
        for content in ("not json", "[]", "{}", json.dumps({**REQUEST, "search": "a\nb"}),
                        json.dumps({**REQUEST, "evidence": ""})):
            with self.subTest(content=content):
                self.assertIsNone(web.parse_placeholder(content))
