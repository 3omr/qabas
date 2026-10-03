import io
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import events


class RecordingStream(io.StringIO):
    """A stream that remembers how it was reconfigured."""

    def __init__(self) -> None:
        super().__init__()
        self.reconfigured: list[dict[str, object]] = []

    def reconfigure(self, **kwargs: object) -> None:
        self.reconfigured.append(kwargs)


class EventEmitterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.stream = RecordingStream()
        events.enable(stream=self.stream)
        self.addCleanup(events.disable)

    def _lines(self) -> list[dict[str, object]]:
        return [json.loads(line) for line in self.stream.getvalue().splitlines()]

    def test_every_line_is_one_complete_json_object(self) -> None:
        events.emit_init(run_id="r1", phases=["guide", "imp"])
        events.emit_phase("guide", "running")
        events.emit_result("SUCCESS", exit_code=0)
        self.assertEqual([line["event"] for line in self._lines()],
                         ["init", "phase", "result"])

    def test_event_name_is_the_first_key(self) -> None:
        # A reader should be able to dispatch without parsing the whole object.
        events.emit_phase("guide", "running")
        first_line = self.stream.getvalue().splitlines()[0]
        self.assertTrue(first_line.startswith('{"event":'))

    def test_arabic_survives_instead_of_becoming_escapes(self) -> None:
        events.emit_phase("guide", "running", label="شرح المحاضرة")
        self.assertIn("شرح المحاضرة", self.stream.getvalue())

    def test_embedded_newlines_cannot_split_a_record(self) -> None:
        # Validation errors carry multi-line NotebookLM text. If that text were
        # written raw it would look like several truncated events to the reader.
        events.emit_phase("mcqs", "failed", errors=["first\nsecond\r\nthird"])
        self.assertEqual(len(self.stream.getvalue().splitlines()), 1)
        self.assertEqual(self._lines()[0]["errors"], ["first\nsecond\r\nthird"])

    def test_unix_line_endings_are_requested(self) -> None:
        # Windows text mode would otherwise leave a stray \r on every line.
        self.assertIn({"newline": "\n"}, self.stream.reconfigured)

    def test_concurrent_phases_cannot_interleave(self) -> None:
        # The five phases genuinely run in threads, so a half-written line here
        # would hand the UI malformed JSON.
        with tempfile.TemporaryDirectory() as temporary_directory:
            events.attach_file(Path(temporary_directory))

            def work(name: str) -> None:
                for _ in range(25):
                    events.emit_phase(name, "running", label="شرح" * 40)

            threads = [threading.Thread(target=work, args=(f"p{i}",)) for i in range(8)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            file_path = Path(temporary_directory) / "events.ndjson"
            file_lines = file_path.read_text(encoding="utf-8").splitlines()
            events.close_file()

        stream_lines = self.stream.getvalue().splitlines()
        self.assertEqual(len(stream_lines), 8 * 25)
        self.assertEqual(len(file_lines), 8 * 25)
        for line in [*stream_lines, *file_lines]:
            json.loads(line)

    def test_non_serializable_values_do_not_take_the_run_down(self) -> None:
        events.emit_phase("guide", "running", run_dir=Path("/tmp/run"))
        self.assertEqual(self._lines()[0]["run_dir"], "/tmp/run")

    def test_file_mirror_starts_with_init_and_every_line_is_json(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            events.attach_file(Path(temporary_directory))
            events.emit_init(run_id="r1", title="Corrosives", phases=["guide"])
            events.emit_phase("guide", "running")
            events.emit_result("SUCCESS", exit_code=0)
            file_path = Path(temporary_directory) / "events.ndjson"
            events.close_file()

            records = [
                json.loads(line)
                for line in file_path.read_text(encoding="utf-8").splitlines()
            ]

        self.assertEqual(records[0]["event"], "init")
        self.assertEqual([record["event"] for record in records],
                         ["init", "phase", "result"])

    def test_resumed_file_mirror_appends_to_the_first_attempt(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            run_dir = Path(temporary_directory)
            events.attach_file(run_dir)
            events.emit_init(run_id="r1", title="Corrosives", phases=["guide"])
            events.emit_phase("guide", "failed")
            events.close_file()

            events.attach_file(run_dir)
            events.emit_init(run_id="r1", title="Corrosives", phases=["guide"])
            events.emit_phase("guide", "reused")
            events.close_file()
            records = [
                json.loads(line)
                for line in (run_dir / "events.ndjson")
                .read_text(encoding="utf-8")
                .splitlines()
            ]

        self.assertEqual([record["event"] for record in records],
                         ["init", "phase", "init", "phase"])
        self.assertEqual(records[1]["state"], "failed")
        self.assertEqual(records[3]["state"], "reused")

    def test_file_sink_failure_is_removed_without_reaching_emit_caller(self) -> None:
        class FailingFile:
            def write(self, _line: str) -> int:
                raise RuntimeError("disk full")

            def flush(self) -> None:
                raise RuntimeError("disk full")

            def close(self) -> None:
                return None

        with tempfile.TemporaryDirectory() as temporary_directory:
            warning = io.StringIO()
            with patch.object(Path, "open", return_value=FailingFile()), redirect_stderr(warning):
                events.attach_file(Path(temporary_directory))
                events.emit_phase("guide", "running")

            events.attach_file(Path(temporary_directory))
            events.emit_phase("guide", "recovered")
            events.close_file()
            records = [
                json.loads(line)
                for line in (Path(temporary_directory) / "events.ndjson")
                .read_text(encoding="utf-8")
                .splitlines()
            ]

            self.assertIn("File mirror disabled", warning.getvalue())
        self.assertEqual(records[0]["state"], "recovered")


class FileMirrorWithoutJsonEventsTests(unittest.TestCase):
    def setUp(self) -> None:
        events.disable()
        self.addCleanup(events.disable)

    def test_file_mirror_does_not_redirect_human_stdout(self) -> None:
        human_output = io.StringIO()
        with tempfile.TemporaryDirectory() as temporary_directory:
            with redirect_stdout(human_output):
                events.attach_file(Path(temporary_directory))
                print("شرح المحاضرة")
                events.emit_init(run_id="r1", title="Corrosives", phases=[])
                events.close_file()
            records = [
                json.loads(line)
                for line in (Path(temporary_directory) / "events.ndjson")
                .read_text(encoding="utf-8")
                .splitlines()
            ]

        self.assertEqual(human_output.getvalue(), "شرح المحاضرة\n")
        self.assertEqual(records[0]["event"], "init")


class WindowsEventFileTests(unittest.TestCase):
    def test_crlf_event_lines_parse_after_reader_strips_carriage_return(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            file_path = Path(temporary_directory) / "events.ndjson"
            file_path.write_bytes(
                b'{"event":"init"}\r\n{"event":"phase","state":"running"}\r\n'
            )
            with file_path.open(encoding="utf-8", newline="") as stream:
                records = [json.loads(line.rstrip("\r\n")) for line in stream]

        self.assertEqual([record["event"] for record in records], ["init", "phase"])


class EmitterDisabledTests(unittest.TestCase):
    def test_emitting_while_disabled_is_a_no_op(self) -> None:
        events.disable()
        events.emit_phase("guide", "running")  # must not raise
        self.assertFalse(events.is_enabled())

    def test_enable_is_idempotent(self) -> None:
        first = RecordingStream()
        second = RecordingStream()
        events.enable(stream=first)
        self.addCleanup(events.disable)
        events.enable(stream=second)
        events.emit_phase("guide", "running")
        self.assertEqual(second.getvalue(), "")
        self.assertNotEqual(first.getvalue(), "")


class PhaseTimerTests(unittest.TestCase):
    def test_elapsed_is_none_for_a_phase_that_never_started(self) -> None:
        self.assertIsNone(events.PhaseTimer().elapsed("guide"))

    def test_elapsed_is_a_number_once_started(self) -> None:
        timer = events.PhaseTimer()
        timer.start("guide")
        self.assertGreaterEqual(timer.elapsed("guide"), 0.0)


class LauncherStreamSeparationTests(unittest.TestCase):
    """The contract the desktop UI depends on, exercised through the real CLI."""

    LAUNCHER = SCRIPTS_DIR / "run_transcription.py"

    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.workspace = Path(directory.name)
        root = self.workspace / "modules" / "test"
        for folder in ("Lecture", "Questions", "Transcripts"):
            (root / folder).mkdir(parents=True)
        (root / "module.json").write_text(json.dumps({
            "schema_version": 1, "module_id": "test", "display_name": "Test Module",
            "notebook": {"id": "fixture-notebook", "title": "Test", "profile": None},
            "output": {"emoji": "🧪", "language": "Egyptian Arabic"},
        }), encoding="utf-8")

    def _run(self, *extra: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(self.LAUNCHER), "--workspace", str(self.workspace),
             "--list-modules", "--no-update-check", *extra],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=120,
        )

    def test_without_the_flag_the_human_log_still_owns_stdout(self) -> None:
        # The existing CLI contract must not shift for anyone already using it.
        result = self._run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Configured modules:", result.stdout)

    def test_with_the_flag_stdout_carries_no_prose(self) -> None:
        result = self._run("--json-events")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("Configured modules:", result.stdout)
        for line in result.stdout.splitlines():
            if line.strip():
                json.loads(line)

    def test_with_the_flag_the_human_log_moves_to_stderr(self) -> None:
        result = self._run("--json-events")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Configured modules:", result.stderr)


if __name__ == "__main__":
    unittest.main()
