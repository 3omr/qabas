"""Cancellation reaches live engine work without ending the reusable MCP server."""

import io
import json
import os
import queue
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

import cancellation
import mcp_server


class QueueInput:
    def __init__(self):
        self.lines = queue.Queue()

    def send(self, message):
        self.lines.put(json.dumps(message) + "\n")

    def close(self):
        self.lines.put(None)

    def __iter__(self):
        while (line := self.lines.get()) is not None:
            yield line


class CancellationTests(unittest.TestCase):
    def test_backoff_observes_request_cancellation(self):
        class CancelDuringWait(threading.Event):
            def wait(self, timeout=None):
                self.set()
                return True

        event = CancelDuringWait()
        with cancellation.request_scope(event):
            with self.assertRaises(cancellation.OperationCancelled):
                cancellation.wait(30)
        # The cancellation event belongs only to that request.
        cancellation.check_cancelled()

    def test_nested_effort_deadline_cannot_extend_outer_budget(self):
        with patch("cancellation.monotonic", return_value=100):
            with cancellation.deadline_scope(10):
                with cancellation.deadline_scope(100):
                    with patch("cancellation.monotonic", return_value=111):
                        with self.assertRaises(cancellation.OperationDeadlineExceeded):
                            cancellation.check_cancelled()
                cancellation.check_cancelled()
            with patch("cancellation.monotonic", return_value=111):
                cancellation.check_cancelled()

    @unittest.skipIf(os.name == "nt", "POSIX process groups and /proc process state")
    def test_cancel_kills_a_descendant_that_ignores_termination(self):
        import tempfile

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = root / "tree.py"
            ready = root / "child-pid"
            script.write_text("import os, pathlib, signal, subprocess, sys, time\n"
                              "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                              "if len(sys.argv) == 2:\n"
                              " subprocess.Popen([sys.executable, __file__, sys.argv[1], 'child'])\n"
                              "else:\n"
                              " pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\n"
                              "while True: time.sleep(1)\n")
            event = threading.Event()
            stopped = threading.Event()

            def run():
                try:
                    with cancellation.request_scope(event):
                        cancellation.run([sys.executable, str(script), str(ready)],
                                         capture_output=True, text=True, timeout=30, check=False)
                except cancellation.OperationCancelled:
                    stopped.set()

            worker = threading.Thread(target=run)
            worker.start()
            try:
                deadline = time.monotonic() + 10
                while not ready.exists() and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue(ready.exists())
                child = int(ready.read_text())
                event.set()
                self.assertTrue(stopped.wait(5))
                stat = Path(f"/proc/{child}/stat")
                try:
                    state = stat.read_text().split(") ", 1)[1].split()[0]
                except (FileNotFoundError, ProcessLookupError):
                    # Linux may reap the killed descendant while procfs is read.
                    pass
                else:
                    self.assertEqual(state, "Z")
            finally:
                event.set()
                worker.join(10)
            self.assertFalse(worker.is_alive())

    def test_finite_desktop_batch_drains_tools_after_stdin_half_close(self):
        import tempfile

        with tempfile.TemporaryDirectory() as root:
            output = io.StringIO()
            requests = [{"jsonrpc": "2.0", "id": 1, "method": "initialize"},
                        {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "get_engine_settings"}}]
            server = mcp_server.Server(workspace=Path(root), stdout=output)
            server.serve(iter(json.dumps(message) + "\n" for message in requests))
            replies = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual([reply["id"] for reply in replies], [1, 2])
            self.assertFalse(replies[1]["result"]["isError"])

    def test_cancel_notification_interrupts_work_and_server_stays_usable(self):
        import tempfile

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binary = root / "fake-agy.py"
            binary.write_text("import pathlib, sys, time\n"
                              "pathlib.Path(sys.argv[1]).write_text('started')\n"
                              "time.sleep(5)\n"
                              "print('{\"status\":\"SUCCESS\",\"response\":\"done\"}')\n")
            ready = root / "ready"
            completed = root / "completed"

            def work(_arguments, _workspace):
                mcp_server._run([sys.executable, str(binary), str(ready)], root, 30)
                completed.write_text("must not happen after cancellation")
                return "finished"

            tool = mcp_server.Tool("cancel-fixture", "Synthetic work", {}, work, ())
            stream, output = QueueInput(), io.StringIO()
            server = mcp_server.Server(workspace=root, stdout=output)
            with patch.dict(mcp_server.TOOLS_BY_NAME, {tool.name: tool}):
                thread = threading.Thread(target=server.serve, args=(stream,))
                thread.start()
                try:
                    stream.send({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool.name}})
                    deadline = time.monotonic() + 10
                    while not ready.exists() and time.monotonic() < deadline:
                        time.sleep(.01)
                    self.assertTrue(ready.exists())
                    stream.send({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 1}})
                    stream.send({"jsonrpc": "2.0", "id": 2, "method": "ping"})
                    # A following tool result proves the cancelled worker settled.
                    stream.send({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "get_engine_settings"}})
                    deadline = time.monotonic() + 3
                    while '"id": 3' not in output.getvalue() and time.monotonic() < deadline:
                        time.sleep(.01)
                    self.assertIn('"id": 3', output.getvalue())
                    self.assertFalse(completed.exists())
                    self.assertNotIn('"id": 1', output.getvalue())
                finally:
                    stream.close()
                    thread.join(12)
                self.assertFalse(thread.is_alive())
