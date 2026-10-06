"""Select the Arabic/English OCR models shipped with the desktop engine."""

import os
import sys
from pathlib import Path


def configure_ocr_data() -> None:
    """Use bundled models when present, including after Scoop sets its own directory."""
    root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1] / ".build"))
    data = root / "tessdata"
    if all((data / f"{language}.traineddata").is_file() for language in ("eng", "ara", "osd")):
        os.environ["TESSDATA_PREFIX"] = str(data)
