import io
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS_DIR = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from console import configure_console_streams


class RecordingStream(io.StringIO):
    """A stream that remembers how it was reconfigured."""

    def __init__(self, fail_with: Exception | None = None) -> None:
        super().__init__()
        self.reconfigured: list[dict[str, object]] = []
        self._fail_with = fail_with

    def reconfigure(self, **kwargs: object) -> None:
        if self._fail_with is not None:
            raise self._fail_with
        self.reconfigured.append(kwargs)


class ConsoleStreamTests(unittest.TestCase):
    def test_both_streams_are_pinned_to_utf8_and_line_buffered(self) -> None:
        out, err = RecordingStream(), RecordingStream()
        with patch.object(sys, "stdout", out), patch.object(sys, "stderr", err):
            configure_console_streams()

        for stream in (out, err):
            self.assertEqual(
                stream.reconfigured,
                [{"encoding": "utf-8", "errors": "replace", "line_buffering": True}],
            )

    def test_stdin_is_pinned_to_strict_utf8(self) -> None:
        stdin = RecordingStream()
        with patch.object(sys, "stdin", stdin):
            configure_console_streams()

        self.assertEqual(stdin.reconfigured, [{"encoding": "utf-8", "errors": "strict"}])

    def test_a_cp1252_pipe_reads_an_arabic_request_after_configuration(self) -> None:
        # Windows opens a piped stdin with the ANSI code page; the MCP server
        # reads its JSON-RPC requests from that pipe.
        request = '{"display_name": "CVS تجربة تكست 20261015"}\n'
        stdin = io.TextIOWrapper(io.BytesIO(request.encode("utf-8")), encoding="cp1252")
        with patch.object(sys, "stdin", stdin), patch.object(sys, "stdout", io.StringIO()), patch.object(
            sys, "stderr", io.StringIO()
        ):
            configure_console_streams()
            self.assertEqual(sys.stdin.readline(), request)

    def test_a_stream_that_refuses_reconfiguration_does_not_take_the_run_down(
        self,
    ) -> None:
        # A redirected or already-detached stream raises here. Losing line
        # buffering is survivable; crashing before the run starts is not.
        stdin = RecordingStream(fail_with=ValueError("underlying buffer detached"))
        out = RecordingStream(fail_with=ValueError("underlying buffer detached"))
        err = RecordingStream(fail_with=OSError("not a tty"))
        with patch.object(sys, "stdin", stdin), patch.object(sys, "stdout", out), patch.object(sys, "stderr", err):
            configure_console_streams()

    def test_a_stream_without_reconfigure_is_skipped(self) -> None:
        # io.StringIO has no reconfigure at all, which is what a test harness
        # or a captured pipe often supplies.
        with patch.object(sys, "stdin", io.StringIO()), patch.object(sys, "stdout", io.StringIO()), patch.object(
            sys, "stderr", io.StringIO()
        ):
            configure_console_streams()

    def test_arabic_and_emoji_survive_the_configured_encoding(self) -> None:
        # The regression this module exists for: cp1252 can encode neither the
        # Arabic the tool prints nor the emoji in every transcript filename.
        sample = "التفريغ الأكاديمي لمحاضرة Glaucoma 👁️"
        with self.assertRaises(UnicodeEncodeError):
            sample.encode("cp1252")
        self.assertEqual(sample.encode("utf-8").decode("utf-8"), sample)


if __name__ == "__main__":
    unittest.main()
