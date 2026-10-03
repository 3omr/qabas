"""Suite-wide isolation from the machine the tests run on."""

import pytest


@pytest.fixture(autouse=True)
def _no_host_antigravity(monkeypatch: pytest.MonkeyPatch) -> None:
    """A developer's installed agy CLI must not change what begin_lecture returns.

    Tests that exercise the writer remove this switch and put a fake agy on PATH.
    """
    monkeypatch.setenv("TRANSCRIBER_AGY", "off")
