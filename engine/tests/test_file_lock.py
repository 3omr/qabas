import errno
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager
from multiprocessing import Process, Queue
from pathlib import Path
from unittest.mock import patch

SCRIPTS_DIR = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from cancellation import OperationCancelled, request_scope
from file_lock import AlreadyLocked, ModuleBusy, exclusive_file_lock

LONG_HOLD_SECONDS = 15


@contextmanager
def held_lock(path, seconds=None):
    code = """import sys, time
from file_lock import exclusive_file_lock
with exclusive_file_lock(sys.argv[1], module="toxo", operation="exam index is being built"):
    print("held", flush=True)
    sys.stdin.readline()
    if sys.argv[2] != "None":
        time.sleep(float(sys.argv[2]))
"""
    process = subprocess.Popen([sys.executable, "-u", "-c", code, str(path), str(seconds)],
                               cwd=SCRIPTS_DIR, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True)
    try:
        assert process.stdout.readline().strip() == "held"
        yield process
    finally:
        try:
            process.communicate(input="\n", timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()


def _try_lock_in_child(lock_path: str, result: Queue) -> None:
    try:
        with exclusive_file_lock(lock_path, blocking=False):
            result.put("acquired")
    except AlreadyLocked:
        result.put("already_locked")


class TestFileLock(unittest.TestCase):
    def test_lock_creates_parent_directories(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            lock_path = Path(tmpdir) / "locks" / "nested" / "a.lock"
            with exclusive_file_lock(lock_path) as handle:
                handle.write("payload")
            self.assertTrue(lock_path.is_file())

    def test_lock_is_released_after_the_block(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            lock_path = Path(tmpdir) / "a.lock"
            with exclusive_file_lock(lock_path):
                pass
            with exclusive_file_lock(lock_path, blocking=False):
                pass  # reacquiring must not raise

    def test_non_blocking_lock_rejects_a_second_holder(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            lock_path = Path(tmpdir) / "a.lock"
            with exclusive_file_lock(lock_path):
                result: Queue = Queue()
                child = Process(
                    target=_try_lock_in_child, args=(str(lock_path), result)
                )
                child.start()
                child.join(timeout=30)
                self.assertEqual(result.get(timeout=5), "already_locked")

    def test_w1_blocking_child_waits_beyond_windows_crt_retry_limit(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "long.lock"
            with held_lock(path, LONG_HOLD_SECONDS) as holder:
                code = "from file_lock import exclusive_file_lock; import sys; print('waiting', flush=True);\nwith exclusive_file_lock(sys.argv[1]): print('acquired')"
                with subprocess.Popen([sys.executable, "-u", "-c", code, str(path)], cwd=SCRIPTS_DIR,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as contender:
                    try:
                        self.assertEqual(contender.stdout.readline().strip(), "waiting")
                        started = time.monotonic()
                        holder.stdin.write("\n")
                        holder.stdin.flush()
                        stdout, stderr = contender.communicate(timeout=30)
                        self.assertEqual(contender.returncode, 0, stderr)
                        self.assertEqual(stdout.strip(), "acquired")
                        self.assertGreater(time.monotonic() - started, 10)
                    finally:
                        if contender.poll() is None:
                            contender.kill()
                        contender.communicate()

    def test_timeout_names_the_operation_holding_the_module(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "busy.lock"
            with held_lock(path):
                for options in ({"timeout": .1}, {"blocking": False}):
                    with self.subTest(options=options), self.assertRaisesRegex(ModuleBusy, "Module toxo is busy: exam index is being built"):
                        with exclusive_file_lock(path, **options):
                            self.fail("Held lock was acquired")

    def test_cancellation_interrupts_a_lock_wait(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "cancel.lock"
            event = threading.Event()
            with held_lock(path), request_scope(event):
                timer = threading.Timer(.1, event.set)
                timer.start()
                started = time.monotonic()
                try:
                    with self.assertRaises(OperationCancelled), exclusive_file_lock(path):
                        self.fail("Held lock was acquired")
                    self.assertLess(time.monotonic() - started, 2)
                finally:
                    timer.join()

    def test_system_lock_errors_are_not_reported_as_busy(self):
        import file_lock
        primitive = "file_lock.fcntl.flock" if file_lock._HAVE_FCNTL else "file_lock.msvcrt.locking"
        with tempfile.TemporaryDirectory() as tmpdir:
            failure = OSError(errno.EBADF, "bad descriptor")
            with patch(primitive, side_effect=failure), self.assertRaises(OSError) as caught:
                with exclusive_file_lock(Path(tmpdir) / "bad.lock"):
                    self.fail("Invalid descriptor acquired")
            self.assertIs(caught.exception, failure)

    def test_already_locked_is_a_blocking_io_error(self) -> None:
        # Existing call sites catch BlockingIOError; keep that contract.
        self.assertTrue(issubclass(AlreadyLocked, BlockingIOError))


if __name__ == "__main__":
    unittest.main()
