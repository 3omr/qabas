# Agent Note: Compact stdin and provisional streaming for Omar

Status: implemented

English | [中文](2026-10-11-omar-stdin-streaming.zh.md)

## Problem

The student chat provider starts the signed-in Antigravity CLI once per Qabas model step. The reported agy 1.3.3 measurements with gemini-3.8-flash-low and low effort are 10 seconds / 35.2K input tokens for a plain question, and 164 seconds / 100K input tokens across two steps for a question requiring two library calls, with 0% cache hits.

## Decision

Each step uses a fresh process with `--input-format stream-json --output-format stream-json`. A single `event:user` message on stdin carries the deterministic compact rendering of the logged request. Closing stdin ends the CLI after that turn. The empty private working directory contains no prompt file; the response schema is outside it. `--disable-slash-commands` prevents prompt expansion. Tool definitions retain every JSON Schema field and each tool's description once. No hidden continuation state, schema cache, timestamp or conversation id contributes to later requests.

The NDJSON decoder publishes only the schema answer's `text` field through the existing LLM stream, which already reaches Chat through Assistant stream events. CLI commentary, fenced/nested JSON and tool argument JSON are withheld. The terminal result validates every tool name and JSON object argument before publishing executable calls. A streamed prefix differing from the result fails. Errors after provisional text produce a failed Assistant attempt through the existing loop settlement; they never publish tool blocks. Internal CLI tool events fail the request, except agy's own `finish` tool, which closes every schema answer. The decoder parses each agent_response turn separately because agy restates the answer in a second turn. This detects tool use but does not replace Antigravity's own permission enforcement.

The shared subprocess owner retains cancellation, timeout, process-tree termination and exit observation. Generator closure also cancels its operation and awaits cleanup. The complete NDJSON byte count, including metadata, is bounded by the existing validated `maxOutputBytes`; `timeoutMs`, `graceMs`, executable, model, effort and fallback fields retain their configuration ownership. No new tunable is hardcoded in the provider. A maintained partial-JSON parser supplies incremental string escape handling rather than an owned JSON parser.

## Measurements

The measured corpus is the first logged request of the committed `omar-google-fallback` Session, with its owned system-prompt and tool-schema sidecars expanded. Private student library data is excluded. The indented baseline contains 71,560 UTF-8 bytes; the compact rendering contains 53,657 bytes: 17,903 bytes / 25.018% less. The recorded-input snapshot pins the compact bytes and SHA-256, and compares all conversation content and complete tool definitions. These byte figures are not token figures.

Host runs on the orchestrator machine (agy 1.3.3, gemini-3.8-flash-low, low effort) with the opt-in script on a one-sentence request: the prompt.md path reached init after 4.9 s, first answer text after 9.4 s and exit after 16.3 s, including a view_file step; the stdin path reached init after 3.6 s, first answer text after 6.5 s and exit after 11.4 s with no file step. In the product chat, a question that needed one library tool call completed in 27 s with 51.2K tokens, against 164 s and 100K tokens for the comparable two-step turn before this change.

The diagnostic reports timestamped init and step events, raw first text and decoded first answer separately, per-step tool/model durations and first/last event times, terminal usage, parse/decode time and total process time. Tool duration alone measures tool execution; the preceding model wait must be read from the event timeline. CLI startup-to-init includes CLI authentication/setup and cannot isolate internal server phases. Run separately for each logged Qabas step to sum an ordinary turn. Actual browser paint is not measured by this diagnostic.

## Alternatives considered

**Stream output with prompt.md.** Included as diagnostic file mode. It can expose text earlier but retains the request to read a file and the possible extra model round trip. The host run above measured the extra view_file step and about 5 s more to exit.

**Small argv prompt.** Included as diagnostic argv mode for small-prompt controls. Full logged requests exceed Windows command-line limits and eventually Linux per-argument limits, so argv cannot carry the general chat request.

**`--conversation <id>` or a persistent stdin process.** Not adopted. [Official CLI documentation](https://www.antigravity.google/docs/cli/headless/) demonstrates reuse and cumulative counters, but a saved id alone does not serialize the CLI's private prior trajectory, tool results, checkpoint text or injected context into the Qabas Session. Logging only the sent user messages would not reconstruct those model-visible histories. Supporting continuation requires durable trajectory ownership and replay evidence, plus cancellation and recovery rules for that state. The script accepts the flag only for an explicit host comparison and reports the resulting id; the provider never sends it.

**Publishing raw text_delta.** Rejected because schema mode deltas can contain raw response JSON or CLI commentary; those are not student answer text. Early schema-text decoding remains provisional until final validation.

## Superseded records

This partially supersedes the transport and buffering paragraphs of `.agents/notes/implemented/feature/2026-10-10-omar-chat-model.md`. Its provisioning, Google fallback, explicit pins and tool-execution ownership remain active.

## Consequences

Stdin removes argv size limits and the requested file read by construction. Streaming makes decoded answer text available before process exit in the fake-CLI handshake, and the host measurements above show the reduction. Complete history and tool descriptions are still sent once per fresh step; no cross-step token cache is claimed. The existing Gemini fallback hook is retained. No Client runtime import or loop change is introduced.

## Verification

Fake-CLI tests cover compact rendering, a prompt larger than 256 KiB on stdin, text before exit, the recorded agy event order including the finish tool, cancellation after text with parent and child exit, malformed, missing and duplicate results, multibyte byte limits, authentication and quota failures, unknown calls, differing streamed prefixes, and the Google fallback. The keyless `omar-google-fallback` snapshot replays through the headless profile. `QABAS_AGY_LIVE=1 node --import tsx/esm packages/llm/llm-agy/tests/live.mjs stdin <request.json>` repeats the host measurement; without the variable the script exits without launching agy.
