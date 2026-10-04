"""Quota, offline and student-owned failures remain distinct from retryable errors."""
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
from pipeline_errors import interruption, quota_reset, retry_delay


@pytest.mark.parametrize("message,kind", [
    ("connection refused", "network"), ("ECONNRESET", "network"),
    ("ENOTFOUND api.google.com", "network"), ("temporary failure in name resolution", "network"),
    ("network is down", "network"), ("offline", "network"),
    ("429 RESOURCE_EXHAUSTED quota requestsPerDay free tier", "quota"),
    ("Gemini API DAILY_QUOTA_EXHAUSTED", "quota"),
    ("agy account quota exhausted, resets in 5 hours", "quota"),
    ("agy quota exceeded", "quota"),
    ("NotebookLM sign-in expired", "auth"), ("agy not logged in", "auth"),
    ("invalid_grant", "auth"), ("recording Corrosives.mp3 not found", "missing-recording"),
    ("429 RESOURCE_EXHAUSTED quota exceeded per minute", None),
    ("RESOURCE_EXHAUSTED", None), ("429 Too many requests", None),
    ("HTTP 503 overloaded", None), ("timeout waiting for response", None),
    ("agy returned invalid JSON: truncated", None), ("HTTP 403 SAFETY", None),
    ("permission auto-denial", None), ("figure not found", None),
])
def test_interruption_classification(message, kind):
    found = interruption(message, datetime(2026, 10, 4, 6, tzinfo=timezone.utc))
    assert (found.kind if found else None) == kind


@pytest.mark.parametrize("at,expected", [
    ("2026-10-04T06:00:00+00:00", "2026-10-04T07:00:00+00:00"),
    ("2026-03-08T12:00:00+00:00", "2026-03-09T07:00:00+00:00"),
    ("2026-11-01T12:00:00+00:00", "2026-11-02T08:00:00+00:00"),
])
def test_gemini_daily_reset_observes_pacific_daylight_savings(at, expected):
    reset = quota_reset("429 daily limit exceeded", datetime.fromisoformat(at), account=False)
    assert reset.astimezone(timezone.utc).isoformat() == expected


def test_account_reset_uses_reported_time_and_never_invents_midnight():
    now = datetime(2026, 10, 4, 6, tzinfo=timezone.utc)
    assert quota_reset("agy quota exhausted", now, account=True) is None
    assert quota_reset("agy quota exhausted; resets in 2h 30m", now, account=True).isoformat() == "2026-10-04T08:30:00+00:00"
    assert quota_reset("resets at 2026-10-04T10:15:00Z", now, account=True).isoformat() == "2026-10-04T10:15:00+00:00"
    assert retry_delay("429 retryDelay: 12s", 0, 2) == 12
    assert retry_delay("503", 10, 2) == 60


def test_unspecified_429_wrapped_by_agy_remains_retryable():
    assert interruption("agy exited 1: HTTP 429 RESOURCE_EXHAUSTED quota exceeded") is None
    assert interruption("agy exited 1: HTTP 429 model quota exhausted").kind == "quota"
