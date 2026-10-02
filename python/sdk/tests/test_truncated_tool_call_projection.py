"""Project the public SDK recording of a corrected long tool call."""

from __future__ import annotations

import json
from pathlib import Path

from deepseek_harness.api import final_response, finish_reason


def test_python_sdk_projects_recovered_turn_after_truncated_tool_error() -> None:
    root = Path(__file__).resolve().parents[3]
    wire = root / "snapshots/sdk/tool-call-truncated-current/notifications.expected.jsonl"
    events = [
        frame["params"]["event"]
        for line in wire.read_text(encoding="utf-8").splitlines()
        if (frame := json.loads(line))["method"] == "session.event"
    ]
    projection = {
        "finalResponse": final_response(events),
        "finishReason": finish_reason(events),
        "truncations": [event["data"] for event in events if event["type"] == "llm/tool-call-truncated"],
        "toolErrors": [
            {
                "code": event["data"]["error"]["code"],
                "toolCallId": event["data"]["message"]["content"][0]["toolCallId"],
                "isError": event["data"]["message"]["content"][0]["isError"],
                "text": event["data"]["message"]["content"][0]["content"][0]["text"],
            }
            for event in events
            if event["type"] == "tool/result"
        ],
    }
    expected = root / "scripts/snapshots/python-sdk-single-exe/tool-call-truncated/result.json"
    assert projection == json.loads(expected.read_text(encoding="utf-8"))
