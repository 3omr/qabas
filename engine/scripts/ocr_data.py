"""Select the language data and renderer configs shipped with the desktop engine."""

import os
import sys
from pathlib import Path


def configure_ocr_data() -> None:
    """Use complete bundled OCR data; reject partial data before selecting it."""
    bundled = getattr(sys, "_MEIPASS", None)
    root = Path(bundled) if bundled is not None else Path(__file__).resolve().parents[1] / ".build"
    data = root / "tessdata"
    if bundled is None and not data.is_dir():
        return
    required = [f"{language}.traineddata" for language in ("eng", "ara", "osd")]
    required.extend(f"configs/{renderer}" for renderer in ("pdf", "txt", "tsv", "hocr"))
    missing = [name for name in required if not (data / name).is_file()]
    if missing:
        raise RuntimeError(f"OCR data directory is incomplete: {', '.join(missing)}")
    os.environ["TESSDATA_PREFIX"] = str(data)
