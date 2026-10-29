"""Shared retry policy for exam extraction and review; account stops are terminal."""

from __future__ import annotations

import math
import re
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import agy_writer
import cancellation
from cancellation import wait as wait_backoff
from pipeline_errors import provider_interruption


class CapacityError(agy_writer.AgyWriterError):
    """A batch must split rather than retry unchanged."""


@dataclass(frozen=True)
class RetrySettings:
    """Transient retry budget and ordered model candidates for one batch."""

    limit: int = 2
    backoff: tuple[float, ...] = (15, 45)
    models: tuple[str, ...] = ("gemini-3.8-flash-low", "gemini-3.8-flash-high")


def retry_settings(config: dict[str, Any]) -> RetrySettings:
    """Validate JSON settings before any exam requests launch."""
    limit = config.get("exam_index_retry_limit", 2)
    backoff = config.get("exam_index_retry_backoff_seconds", [15, 45])
    models = config.get("exam_index_models", list(RetrySettings().models))
    if type(limit) is not int or not 0 <= limit <= 100:
        raise ValueError("exam_index_retry_limit must be an integer from 0 to 100")
    if (not isinstance(backoff, list) or not backoff or any(
        type(delay) not in (int, float) or not math.isfinite(delay) or not 0 <= delay <= 3600 for delay in backoff
    )):
        raise ValueError("exam_index_retry_backoff_seconds must be a nonempty list of seconds from 0 to 3600")
    if not isinstance(models, list) or not models or any(not isinstance(model, str) or not model.strip() for model in models):
        raise ValueError("exam_index_models must be a nonempty list of model names")
    return RetrySettings(limit, tuple(backoff), tuple(model.strip() for model in models))


def batch_question_limit(config: dict[str, Any]) -> int:
    """Bound extraction and review output by expected question count."""
    return _positive_budget(config, "exam_index_batch_questions", 20)


def request_timeout_seconds(config: dict[str, Any]) -> int:
    """Resolve the index-only deadline for extraction, repair and review requests."""
    return _positive_budget(config, "exam_index_request_timeout_seconds", 240)


def _positive_budget(config: dict[str, Any], key: str, default: int) -> int:
    value = config.get(key, default)
    if type(value) is not int or value < 1:
        raise ValueError(f"{key} must be an integer of at least 1")
    return value


DEFAULT_RETRY = RetrySettings()


class RequestFailure(agy_writer.AgyWriterError):
    """A request exhausted recovery, with its original classification and launch count."""

    def __init__(self, error: Exception, attempts: int):
        super().__init__(str(error))
        self.category = failure_class(error)
        self.attempts = attempts


def unknown_model(message: str) -> bool:
    """Recognize CLI model-selection failures without treating them as sign-in errors."""
    return bool(re.search(r"invalid model selection|unknown.model|model.{0,120}(?:not recognized|not found|unavailable|invalid)|invalid.model", message, re.I))


def request_timeout(error: Exception) -> bool:
    """Recognize subprocess and CLI timeout diagnostics after exception wrapping."""
    return isinstance(error, subprocess.TimeoutExpired) or bool(re.search(r"timed?\s*out|timeout", str(error), re.I))


def failure_class(error: Exception) -> str:
    """Classify account, source, capacity, and other CLI/output failures."""
    if isinstance(error, RequestFailure):
        return error.category
    stopped = provider_interruption(str(error))
    if stopped and stopped.kind in {"auth", "quota"}:
        return stopped.kind
    if (isinstance(error, ConnectionError) or stopped and stopped.kind == "network"
        or re.search(r"empty (?:response|output)|Expecting value: line 1 column 1", str(error), re.I)):
        return "transient"
    if isinstance(error, CapacityError) or request_timeout(error) or re.search(
        r"truncat|invalid (?:proposal )?json|(?:output|token).{0,40}limit|(?:max|maximum)[_ \-]*(?:output[_ \-]*)?tokens", str(error), re.I
    ):
        return "capacity"
    return "source" if isinstance(error, OSError) else "transient"


def request_with_retry(request: Callable[[str], dict[str, Any]], settings: RetrySettings) -> dict[str, Any]:
    """Retry one batch; cancellation interrupts sleep and quota/auth never retry.

    Saved payloads identify their producing model and actual CLI attempt count.
    Raised exceptions carry the attempts made by this invocation.
    """
    model_index = retries = attempts = 0
    while True:
        cancellation.check_cancelled()
        stopped = provider_interruption()
        if stopped and stopped.kind in {"auth", "quota"}:
            raise RequestFailure(agy_writer.AgyWriterError(stopped.raw_diagnostic), attempts)
        attempts += 1
        try:
            payload = request(settings.models[model_index])
        except (agy_writer.AgyWriterError, ValueError, subprocess.TimeoutExpired) as error:
            attempts += getattr(error, "attempts", 0)
            if failure_class(error) != "transient":
                raise RequestFailure(error, attempts) from error
            if unknown_model(str(error)) and model_index + 1 < len(settings.models):
                model_index += 1
                continue
            if retries >= settings.limit:
                raise RequestFailure(error, attempts) from error
            wait_backoff(settings.backoff[min(retries, len(settings.backoff) - 1)])
            retries += 1
        else:
            return {**payload, "model": settings.models[model_index], "attempts": attempts + payload.get("attempts", 0)}
