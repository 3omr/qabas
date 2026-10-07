"""Compressed upload copies preserve original audio and publish only complete output."""

import hashlib
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import time
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

import cancellation
import recording_preparation
from source_preparation import PreparationError


@pytest.fixture
def recording(tmp_path):
    path = tmp_path / "Lecture" / "تسجيل عربي English.wav"
    path.parent.mkdir()
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(2)
        audio.setsampwidth(2)
        audio.setframerate(48000)
        frames = b"".join(struct.pack("<hh", *([int(10000 * math.sin(i * 2 * math.pi * 440 / 48000))] * 2)) for i in range(480000))
        audio.writeframes(frames)
    return path


def test_real_ffmpeg_compression_preserves_original_duration_and_reuses_cache(recording, tmp_path, monkeypatch):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("Real recording compression requires FFmpeg and FFprobe")
    original = recording.read_bytes()
    compressed = recording_preparation.compress_recording(recording, tmp_path, {})
    assert compressed != recording and compressed.stat().st_size < len(original) / 5
    assert recording.read_bytes() == original
    probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_name,channels", "-of", "json", str(compressed)]))
    assert abs(float(probe["format"]["duration"]) - 10) < .12
    assert probe["streams"][0]["codec_name"] == "aac"
    assert probe["streams"][0]["channels"] == 1
    def unexpected_encoding(*_args):
        raise AssertionError("Unchanged audio must reuse its compressed copy")
    monkeypatch.setattr(recording_preparation, "_encode", unexpected_encoding)
    assert recording_preparation.compress_recording(recording, tmp_path, {}) == compressed
    assert hashlib.sha256(recording.read_bytes()).digest() == hashlib.sha256(original).digest()


def test_cancelled_encoding_removes_partial_copy_and_preserves_original(recording, tmp_path, monkeypatch):
    original = recording.read_bytes()
    monkeypatch.setattr(recording_preparation.shutil, "which", lambda _: "ffmpeg")
    def cancel(command, *_args):
        Path(command[-1]).write_bytes(b"partial encoding")
        raise cancellation.OperationCancelled()
    monkeypatch.setattr(recording_preparation, "_encode", cancel)
    with pytest.raises(cancellation.OperationCancelled):
        recording_preparation.compress_recording(recording, tmp_path, {})
    assert recording.read_bytes() == original
    assert not list((tmp_path / ".transcriber-cache" / "recordings").rglob("*.m4a"))


@pytest.mark.parametrize("config", [{"recording_upload_bitrate_kbps": 0}, {"recording_upload_sample_rate": True}, {"recording_compression_timeout_seconds": "600"}])
def test_invalid_encoder_settings_fail_before_encoding(recording, tmp_path, config):
    with pytest.raises(PreparationError, match="must be an integer"):
        recording_preparation.compress_recording(recording, tmp_path, config)


def test_missing_encoder_names_the_app_tool(recording, tmp_path, monkeypatch):
    monkeypatch.setattr(recording_preparation.shutil, "which", lambda _: None)
    with pytest.raises(PreparationError, match="Qabas Tools"):
        recording_preparation.compress_recording(recording, tmp_path, {})


@pytest.mark.skipif(os.name == "nt", reason="Real FFmpeg cancellation uses a POSIX exec shim")
def test_cancel_stops_live_ffmpeg_and_reaps_it(recording, tmp_path, monkeypatch):
    executable = shutil.which("ffmpeg")
    if executable is None:
        pytest.skip("Live encoder cancellation requires FFmpeg")
    progress = tmp_path / "encoder-progress.txt"
    pid_file = tmp_path / "encoder-pid.txt"
    shim = tmp_path / "ffmpeg-shim"
    shim.write_text(f"#!{sys.executable}\nimport os,sys\nfrom pathlib import Path\nPath({str(pid_file)!r}).write_text(str(os.getpid()))\nos.execv({executable!r}, [{executable!r}, '-stream_loop', '-1', '-re', '-progress', {str(progress)!r}, *sys.argv[1:]])\n")
    shim.chmod(0o700)
    monkeypatch.setattr(recording_preparation.shutil, "which", lambda _: str(shim))
    event = Event()
    original = recording.read_bytes()
    def encode():
        with cancellation.request_scope(event):
            recording_preparation.compress_recording(recording, tmp_path, {})
    with ThreadPoolExecutor(max_workers=1) as pool:
        result = pool.submit(encode)
        try:
            until = time.monotonic() + 15
            while time.monotonic() < until:
                if progress.is_file() and "out_time_ms=" in progress.read_text():
                    break
                if result.done():
                    result.result()
                    pytest.fail("Encoder exited before cancellation")
                time.sleep(.01)
            assert progress.is_file() and "out_time_ms=" in progress.read_text()
        finally:
            event.set()
        with pytest.raises(cancellation.OperationCancelled):
            result.result(timeout=5)
    pid = int(pid_file.read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
    assert recording.read_bytes() == original
    assert not list((tmp_path / ".transcriber-cache" / "recordings").rglob("*.m4a"))
