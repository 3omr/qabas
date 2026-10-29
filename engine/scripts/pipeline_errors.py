"""Separate student-owned interruptions from errors the lecture runner repairs."""

from __future__ import annotations

import re
from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from functools import wraps
from threading import Lock
from typing import ParamSpec, TypeVar
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class Interruption:
    """A resumable interruption; quota reset timestamps come from the provider."""

    kind: str
    reason: str
    reset_at: str | None = None
    raw_diagnostic: str = ""


def quota_reset(message: str, now: datetime, *, account: bool) -> datetime | None:
    """Prefer reported instants/durations; only Gemini API has a fixed daily reset."""
    instant = re.search(r"(?:reset|renew|refresh)[\s\S]{0,60}?(\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d))", message, re.I)
    if instant:
        try:
            return datetime.fromisoformat(instant[1].replace("Z", "+00:00"))
        except ValueError:
            pass  # A malformed reported timestamp is not a usable reset instant.
    duration = re.search(r"(?:resets?|renews?|refresh(?:es)?|try again)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:days?|hours?|minutes?|seconds?|[dhms])\s*)+)", message, re.I)
    if duration:
        units = {"d": 86400, "h": 3600, "m": 60, "s": 1}
        seconds = sum(float(value) * units[unit[0].lower()] for value, unit in re.findall(r"(\d+(?:\.\d+)?)\s*([a-z]+)", duration[1], re.I))
        return now + timedelta(seconds=seconds)
    if account:
        return None
    pacific = now.astimezone(ZoneInfo("America/Los_Angeles"))
    return datetime.combine(pacific.date() + timedelta(days=1), time(), pacific.tzinfo)


def interruption(message: str, now: datetime | None = None) -> Interruption | None:
    """Classify concrete offline, exhausted account/day, auth and absent audio errors.

    Timeouts, 5xx, generic RESOURCE_EXHAUSTED/429 and minute limits remain repairable.
    Permission auto-denial and policy/safety refusals are not sign-in failures.
    """
    at = now or datetime.now(timezone.utc)
    if re.search(r"ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|connection (?:refused|reset)|DNS (?:failure|failed)|name or service not known|temporary failure in name resolution|network (?:is )?(?:down|unreachable)|internet (?:is )?disconnected|\boffline\b|ConnectError", message, re.I):
        return Interruption("network", "the internet is disconnected")
    daily = re.search(r"DAILY_QUOTA_EXHAUSTED|(?:quota|limit)[^\n]{0,60}(?:per[_ -]?day|perday)|(?:per[_ -]?day|perday|daily)[^\n]{0,60}(?:quota|limit|exhaust)|requestsperday", message, re.I)
    minute = re.search(r"per[_ -]?minute|requestsperminute|\bRPM\b", message, re.I)
    account = bool(re.search(r"agy|antigravity|Google account", message, re.I))
    spent = re.search(r"quota[^\n]{0,40}(?:exhaust|used up|exceed|reached)|(?:exhaust|used up|exceed|reached)[^\n]{0,40}quota|usage limit (?:reached|exceeded)|credits[^\n]{0,30}exhaust", message, re.I)
    generic_limit = re.search(r"\b429\b|RESOURCE_EXHAUSTED", message, re.I)
    account_limit = re.search(r"(?:account|individual|model|plan)[ -]quota|quota (?:on|for) (?:this |the )?model|usage limit (?:reached|exceeded)", message, re.I)
    account = account or bool(account_limit)
    if daily or (account and spent and not minute and (not generic_limit or account_limit)):
        reset = quota_reset(message, at, account=account)
        reason = ("the quota is used up, it renews at " + reset.astimezone().strftime("%Y-%m-%d %H:%M %Z")
                  if reset else "the quota is used up; the provider has not reported when it renews")
        return Interruption("quota", reason, reset.astimezone(timezone.utc).isoformat() if reset else None, message)
    if re.search(r"signed out|sign[- ]?in (?:required|expired)|auth(?:entication)? (?:expired|unavailable|required)|unauthenticated|invalid[_ ]credentials|invalid[_ ]grant|login (?:required|expired)|not (?:logged|signed) in|(?:401|403)[^\n]{0,50}(?:auth|credential)|API[_ ]KEY[_ ]INVALID", message, re.I):
        provider = "NotebookLM" if re.search(r"nlm|NotebookLM", message, re.I) else "Antigravity" if account else "Google"
        return Interruption("auth", f"{provider} is signed out or its sign-in has expired; sign in again", raw_diagnostic=message)
    if re.search(r"(?:recording|audio(?: source)?)[^\n]{0,100}(?:missing|not found|does not exist)|no audio source[^\n]{0,100}matches", message, re.I):
        return Interruption("missing-recording", "the recording is missing; restore it and press Continue")
    return None


def retry_delay(message: str, attempt: int, base: float) -> float:
    """Honor bounded retry hints; exponential backoff is capped at one minute."""
    hint = re.search(r"(?:retry.?after|retryDelay)[\"\s:=]+(\d+(?:\.\d+)?)s?", message, re.I)
    return min(60.0, max(base * 2 ** min(attempt, 5), float(hint[1]) if hint else 0))


class _ProviderRun:
    """First terminal account failure shared by copied worker contexts."""

    def __init__(self) -> None:
        self.lock = Lock()
        self.stopped: Interruption | None = None


_provider_run: ContextVar[_ProviderRun | None] = ContextVar("provider_run", default=None)
_P = ParamSpec("_P")
_R = TypeVar("_R")


def provider_run(function: Callable[_P, _R]) -> Callable[_P, _R]:
    """Share account interruption state across nested runs and copied worker contexts."""
    @wraps(function)
    def run(*args: _P.args, **kwargs: _P.kwargs) -> _R:
        if _provider_run.get() is not None:
            return function(*args, **kwargs)
        token = _provider_run.set(_ProviderRun())
        try:
            return function(*args, **kwargs)
        finally:
            _provider_run.reset(token)
    return run


def provider_interruption(message: str = "") -> Interruption | None:
    """Record the first quota/auth diagnostic; read it before launching more agy work."""
    run = _provider_run.get()
    found = interruption(message) if message else None
    if run is None:
        return found
    with run.lock:
        if run.stopped is None and found is not None and found.kind in {"quota", "auth"}:
            run.stopped = found
        return run.stopped or found
