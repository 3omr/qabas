---
description: "Configure Antigravity CLI as the Qabas chat model with Google sign-in and optional Gemini-key recovery."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-agy

English | [中文](README.zh.md)

## Summary

Answer Qabas chat using the student’s Antigravity Google sign-in without an API key. Qabas executes every requested library or engine tool through its own logged, permissioned pipeline. Configure the CLI model, effort and wall-clock deadline. A saved Gemini key can recover one unavailable Omar turn, while explicit model pins prevent switching.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Web bundle mounts this provider beside pi-ai; Desktop uses the same composition. Settings conditionally saves the configured preferred agy model for an unset default, including after installation during onboarding. Saving a Gemini key provisions Google and retains an existing student selection.

```yaml
- name: '@deepseek-ai/dsh-llm-agy'
  config:
    defaultModel: gemini-3.8-flash-low
    effort: low
    timeoutMs: 180000
    googleFallback: true
```

`executable` defaults to `agy` and accepts a bare PATH command or an absolute path. Resolution uses the shared subprocess executable resolver also used by Desktop installation and authentication. `graceMs` defaults to 3000; `maxOutputBytes` defaults to 4194304. `agy models` supplies tab-separated model ids and labels; the configured default is placed first, and provisioning fails explicitly when that model is absent. Model resolution materializes the configured effort into the logged request header.

Every request uses a private temporary root with an empty working subdirectory and a response-schema file outside it. The shared `ctx.subprocess` owner starts the CLI, terminates its process tree on cancellation or timeout, and waits for exit before removing the temporary root.

`AGY_NOT_INSTALLED`, `AGY_NOT_SIGNED_IN` and `AGY_QUOTA` are terminal student-action reasons. Connection resets and eligibility-check failures use `TRANSPORT`; the shared retry executor retries them. Invalid responses or tool calls fail before publishing content. Exactly one finish chunk terminates each request.

With `googleFallback: true`, an eligible terminal failure and saved `GEMINI_API_KEY` select a configured Google Flash model once per turn. The Agent fallback hook and options must allow switching. The existing `llm/model-fallback` event records both routes and the agy reason; Chat renders the localized Omar-to-Gemini notice. The next turn starts from the student’s original selection.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The adapter is the Service Provider of the existing LLM capability seam. The CLI returns structured text and requested Qabas calls rather than executing those calls. Full-response validation checks offered tool names and JSON object arguments, and unwraps a schema JSON response fenced inside `structured_output.text`. Usage precedes the terminal finish.

No invariant companion is published: the adapter translates one request into one response and owns no independent registry observations that can diverge. The shared LLM registry and subprocess provider own those relationships.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [LLM service](../llm/README.md) — provider-neutral requests and chunks.
- [Subprocess owner](../../subprocess/subprocess/README.md) — process-tree lifecycle.
- [pi-ai adapter](../llm-pi-ai/README.md) — Google route and durable fallback records.

-----

<a id="model-experience"></a>
## Model Experience

### Model-only request

#### What the model sees

The CLI reads `prompt.md` from its private working directory, since chat prompts exceed argv limits; the file holds fixed `tool_calls` model-only instructions followed by JSON containing the logged system text, ordered conversation blocks and tool definitions. [The renderer](src/prompt.ts) and its package-local snapshot pin the exact fixed instructions. The prompt is deterministic from the request reconstructed from the session log; no unlogged workspace contents or timestamps are added.

#### Token effect

JSON framing and fixed instructions add input tokens to the logged request content. The CLI’s usage counters provide input and output accounting when present.

#### KV Cache effect

Each call starts a new CLI process with the full deterministic conversation prefix. No conversation id or adapter-private replay state is reused; cache reuse is owned by Antigravity.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Responses are buffered until the CLI exits; token-by-token display is unavailable.
- The no-tools instruction and `--sandbox` implement the decided CLI mode; enforcement inside Antigravity depends on its CLI behavior.
- Request images use the shared text-only projection. Live Google sign-in, real model eligibility and Windows CLI installation require a live check.

<a id="dev-note"></a>
### Dev Note

None.
