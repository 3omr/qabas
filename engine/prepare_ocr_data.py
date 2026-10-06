"""Download pinned, checksum-verified Tesseract models for the frozen build."""

import hashlib
import json
import urllib.request
from pathlib import Path


def prepare(root: Path) -> Path:
    """Populate the build cache; reject any downloaded model with an unexpected hash."""
    manifest = json.loads((root / "tessdata.manifest.json").read_text(encoding="utf-8"))
    destination = root / ".build" / "tessdata"
    destination.mkdir(parents=True, exist_ok=True)
    for model in manifest["files"]:
        target = destination / model["name"]
        if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == model["sha256"]:
            continue
        with urllib.request.urlopen(model["url"], timeout=60) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != model["sha256"]:
            raise ValueError(f"OCR model checksum mismatch: {model['name']}")
        target.write_bytes(data)
    return destination


if __name__ == "__main__":
    prepare(Path(__file__).resolve().parent)
