# Agent Note: Corrective recovery for truncated tool calls

Status: implemented

English | [中文](2026-10-02-truncated-tool-call-recovery.zh.md)

## Problem

A long Arabic stage_draft_part call can reach Gemini’s output limit or end inside an unfinished Google SDK JSON segment. A generic PI_AI_ERROR terminates the lecture job without telling the model to produce smaller parts. Repeating the same request consumes scarce daily quota without changing the oversized output.

## Decision

The pi-ai adapter classifies output-limit tool calls and parser EOF diagnostics as TOOL_CALL_TRUNCATED. Exposed call diagnostics retain the tool name and streamed raw argument size. The agent-loop commits the partial assistant message, failed call, corrective tool result, and llm/tool-call-truncated notification without executing the partial arguments. The next step derives changed history from those records. The second consecutive truncation of one tool in a turn ends the turn with a clear error; a normal step for that tool resets its count. Multiple calls to the same tool in one response count once. A recovered truncation requires another step even when an earlier text-only response reached the output ceiling.

Google’s SDK buffers complete JSON segments before pi-ai exposes function calls. A discarded segment therefore has no available tool identity or argument size. This case commits an assistant/attempt and a corrective user instruction, with null tool and size in the notification and a separate two-response bound. The loop does not fabricate a call id or partial arguments. Explicit cancellation and other provider errors keep their existing handling.

The notification is required-on-read session vocabulary. The model-visible correction belongs to ordinary assistant/tool-result or user-message events, so replay and resume reconstruct it. English, Chinese, and Egyptian Arabic Chat dictionaries own the independent conversation line. Raw character counts use UTF-16 code units, consistent with JavaScript string length; they are not byte or token estimates.

## Alternatives considered

**Blind request retry.** Rejected because unchanged model input invites the same oversized tool call and spends the free quota again. Corrective feedback must reach the next request.

**Execute a parser-repaired partial object.** Rejected because syntactically repaired JSON can silently omit lecture content. Truncated responses never dispatch tools.

**Require a tool result when the SDK exposed no call.** Rejected because the harness has no authoritative call id, name, or argument bytes. A durable corrective instruction can recover the job without inventing provider data.

## Consequences

Recovery adds at most one corrective request after a consecutive truncation and preserves append-only request prefixes. Partial exposed arguments remain in durable history until compaction; SDK-buffered bytes are unavailable and contribute no claimed size. The raw provider finish stays in the assistant stream, while the turn can finish normally after correction.

The [terminal-stream-failures decision](../architecture/2026-07-29-terminal-llm-stream-failures.md) remains active for adapter normalization and ordinary failed attempts; truncated output is the explicit corrective-history exception. [Daily-quota fallback](2026-10-02-daily-quota-model-fallback.md) remains active for route switching and never owns this output repair. Neither decision is fully superseded.

## Verification

Adapter tests cover long Arabic mid-JSON deltas, length stops, bare stream EOF, buffered Google SDK failures, and normal errors. A real Loader composition covers corrected tool execution, the second-failure bound, successful-tool reset, independent tool counters, and unavailable call metadata. Chat projection snapshots pin the localized independent line. Recorded-session fixtures exercise the durable correction through public headless and SDK profiles; the Python SDK projection consumes the same SDK wire recording. The captured sessions and wire goldens preserve the failed-call result and a completed second step. Automated subprocess replay requires a host that permits piped child processes; provider HTTP tests require loopback sockets.
