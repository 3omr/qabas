"""Prepare private speech audio copies while retaining recording originals."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import cancellation
from atomic_io import _atomic_write_json
from source_preparation import PreparationError, _artifact_lock, _sha256


def _integer(config: dict[str, Any], key: str, default: int, minimum: int, maximum: int) -> int:
    value = config.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise PreparationError(f"{key} must be an integer from {minimum} to {maximum}")
    return value


def _encode(command: list[str], timeout: int) -> None:
    try:
        completed = cancellation.run(command, timeout=timeout, capture_output=True, text=True,
                                     encoding="utf-8", errors="replace", check=False)
    except FileNotFoundError as error:
        raise PreparationError("FFmpeg was not found for recording compression") from error
    except subprocess.TimeoutExpired as error:
        raise PreparationError("Recording compression timed out") from error
    if completed.returncode != 0:
        raise PreparationError("Recording compression failed: " + (completed.stderr or completed.stdout).strip()[:400])


def compress_recording(path: Path, module_root: Path, config: dict[str, Any]) -> Path:
    """Return a smaller cached AAC copy, or the original when it is already smaller.

    The cache includes original bytes and encoder settings. Only complete output
    from an unchanged original is published; cancellation removes staged output.
    """
    bitrate = _integer(config, "recording_upload_bitrate_kbps", 48, 16, 128)
    rate = _integer(config, "recording_upload_sample_rate", 24000, 16000, 48000)
    if rate not in {16000, 22050, 24000, 32000, 44100, 48000}:
        raise PreparationError("recording_upload_sample_rate must be a supported AAC sample rate")
    timeout = _integer(config, "recording_compression_timeout_seconds", 600, 1, 3600)
    executable = shutil.which("ffmpeg")
    if executable is None:
        raise PreparationError("FFmpeg is required to compress recordings; install it from Qabas Tools.")
    cancellation.check_cancelled()
    original_hash = _sha256(path)
    key = hashlib.sha256(f"aac-mono-v1:{original_hash}:{bitrate}:{rate}".encode()).hexdigest()
    cache = module_root / ".transcriber-cache"
    destination = cache / "recordings" / key / (path.stem + ".m4a")
    with _artifact_lock(cache, destination):
        metadata = destination.with_suffix(".json")
        try:
            cached = json.loads(metadata.read_text(encoding="utf-8"))
            valid = (destination.is_file() and cached["source_sha256"] == original_hash
                     and cached["prepared_sha256"] == _sha256(destination))
        except (OSError, ValueError, KeyError, TypeError):
            # Compressed copies are regenerable; absent or corrupt cache metadata cannot authorize reuse.
            valid = False
        if not valid:
            destination.parent.mkdir(parents=True, exist_ok=True)
            with TemporaryDirectory(prefix="encoding-", dir=destination.parent) as temporary:
                staged = Path(temporary) / "recording.m4a"
                _encode([executable, "-nostdin", "-v", "error", "-y", "-i", str(path),
                           "-map", "0:a:0", "-vn", "-c:a", "aac", "-ac", "1", "-ar", str(rate),
                           "-b:a", f"{bitrate}k", "-movflags", "+faststart", str(staged)], timeout)
                cancellation.check_cancelled()
                if not staged.is_file() or staged.stat().st_size == 0:
                    raise PreparationError("Recording compression produced no audio")
                if _sha256(path) != original_hash:
                    raise PreparationError("Recording changed during compression; retry its current file")
                prepared_hash = _sha256(staged)
                os.replace(staged, destination)
                _atomic_write_json(metadata, {"source_sha256": original_hash, "prepared_sha256": prepared_hash})
        return destination if destination.stat().st_size < path.stat().st_size else path
