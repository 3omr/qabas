# Agent Note: Omar CLI model for student chat

Status: implemented

English | [中文](2026-10-10-omar-chat-model.zh.md)

## Problem

The student's default chat assistant needs to use their Google sign-in without consuming Gemini API-key quota while preserving Qabas tool permissions and durable tool history. CLI startup takes substantially longer than model inference, and terminal account failures need a usable optional recovery path.

## Decision

The llm-agy package registers the agy LLM route. Each request deterministically renders the logged system text, conversation blocks and tool schemas into a model-only prompt. Antigravity runs with structured JSON output and sandbox mode in an empty private working directory; the [stdin transport note](2026-10-11-omar-stdin-streaming.md) owns how the request reaches it. Qabas validates every returned tool name and object argument before emitting any content, then executes accepted calls through its own existing loop.

The shared subprocess owner resolves and starts the executable, owns the process tree, and proves exit before private directory cleanup. Configuration owns the preferred model, effort, wall-clock timeout, termination grace, output size and optional Google fallback. Connection resets and eligibility-check errors use the transient TRANSPORT code; not-installed, not-signed-in and quota failures have distinct terminal AGY codes.

Conditional provisioning saves the preferred installed Omar model only when the student has no selection, including installation reports during onboarding. Google key provisioning remains available when Omar is missing. A terminal agy availability failure can switch once per turn to a configured Google Flash route with a saved Gemini key. The existing Agent fallback policy authorizes the switch, and the existing llm/model-fallback event records its routes and reason for the localized chat notice. A pinned model prevents switching.

## Alternatives considered

**Antigravity executes its own tools.** The owner rejects this because Qabas library and engine operations must remain logged and permissioned by Qabas.

**Gemini API key remains the required default.** The owner rejects this because the student already has Google sign-in and should not need API-key quota for ordinary chat. The key remains an optional recovery credential.

**A separate fallback transcript path.** The existing model-fallback event and conversation node already represent a same-step model switch, so a parallel mechanism would duplicate durable recovery semantics.

## Related decisions

The [daily-quota fallback decision](2026-10-02-daily-quota-model-fallback.md) remains active for pi-ai's within-provider recovery. Omar's cross-provider switch has explicit deployment permission and requires the student's saved Gemini key; it does not change other provider recovery. The engine's Windows installation and lecture-writing decisions retain their independent ownership.

## Consequences

Students see Omar in English and عومر in Arabic as the chat provider, and Gemini as an optional fallback. Answer text streams to the chat while the CLI runs; tool calls are published only after the complete result validates. Fixed instructions and JSON framing add input tokens; no CLI conversation persistence is reused. Antigravity's internal adherence to no-tools instructions, real sign-in behavior, model availability, Windows discovery and long prompt command-line limits still require a live CLI check.

## Verification

The adapter uses a network-free fake CLI fixture for text, tools, nested fenced JSON, invalid calls, transient errors, terminal sign-in and quota errors, catalog parsing and cancellation of the CLI plus its descendant. Loader-based Agent tests cover the logged Google switch, missing keys, pinned selections and disabled fallback. Provisioning tests preserve explicit student choices.

The keyless recorded-session case `omar-google-fallback` records the cross-provider switch through the shipping recovery hook. It replays through the headless profile. Real CLI sign-in, catalog availability, tool restrictions and Windows process-tree behavior require a live check.
