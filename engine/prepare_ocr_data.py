"""Download pinned, checksum-verified Tesseract OCR assets for the frozen build."""

import hashlib
import json
import urllib.request
from pathlib import Path


def prepare(root: Path) -> Path:
    """Populate the build cache; reject any downloaded asset with an unexpected hash."""
    manifest = json.loads((root / "tessdata.manifest.json").read_text(encoding="utf-8"))
    destination = root / ".build" / "tessdata"
    destination.mkdir(parents=True, exist_ok=True)
    for asset in manifest["files"]:
        target = destination / asset["name"]
        if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == asset["sha256"]:
            continue
        with urllib.request.urlopen(asset["url"], timeout=60) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != asset["sha256"]:
            raise ValueError(f"OCR asset checksum mismatch: {asset['name']}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return destination


if __name__ == "__main__":
    prepare(Path(__file__).resolve().parent)
