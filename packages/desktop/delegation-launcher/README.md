---
description: "Submit explicitly reviewed tasks to loaded subagent providers through an optional desktop Bundle."
kind: "package-bundle"
---

# @deepseek-ai/dsh-delegation-launcher

## Summary

Choose a loaded agent provider and delegate a task from the desktop sidebar. Review the target session, workspace and account-use warning before submitting. This optional Bundle uses the existing Harness command and background-job services; it does not install providers, authenticate accounts or change model-facing tool grants.

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

Open Settings → Plugins → Marketplace and review Delegate Tasks. Installation prepares a candidate combination; finish active work before fully quitting and reopening the app to activate it. Under Installed, Delegate a task opens this Bundle's panel. Review removal prepares another combination for the next full app launch. The catalog carries an exact local artifact, not an arbitrary npm package or automatic provider setup.

In a running profile containing this Bundle, open a session and select Delegate task from the sidebar. Choose a loaded provider, enter a task, read the workspace and access warning, then check the authorization box and submit. Some providers inherit parent conversation context. Provider execution and automatic parent-model completion handling may consume account quota. The command result appears inside the panel; successful admission is not the agent's final answer.

Changing the target session, connection, provider or task requires another review. Provider refresh lists names in sorted order and performs no executable, authentication or model probe. An uncertain submission is not retried automatically: inspect the existing task before submitting again. The panel retains its draft while closed, but not after a reload.

The panel shows live subagent task states, including in a blank conversation. Select Read result after a task finishes to collect its bounded plain-text output. Cancel task requires confirmation; Stopping means provider cleanup is still pending. Closing the panel clears displayed results, not the tasks. Reopen it and read the result again when needed.

The Host validates these deployment limits before running the command:

| Config | Default | Meaning |
|---|---|---|
| `maxTaskBytes` | `16384` | Maximum UTF-8 bytes in the trimmed task |
| `outputLimitBytes` | `32768` | Panel result and background-job completion-notice byte limit |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[The patch](cordis.patch.yml) mounts [the Host service](src/index.ts). Its Remote lists loaded providers and controls session-owned subagent jobs. The browser submits `/delegate-task` through the existing Commands Remote and displays its returned outcome even when the conversation remains in the blank-session view. Commands records the input and outcome in the session log. A missing provider or unavailable job controller refuses admission before provider execution.

The job retains its exact owning agent through provider startup, result and disposal. Removing this Bundle removes its command and UI contributions but does not abandon an admitted job. Existing job cancellation and owner teardown remain responsible for cleanup. Start, result and cleanup diagnostics are replaced with generic errors before entering job notices; successful provider text remains untrusted task output.

[The browser entry](src/client/index.ts) contributes sidebar and optional marketplace actions through Slots. Both share one visibility store. The editor fences confirmation and receipts by session and connection, prevents duplicate submission and ignores late updates after unmount. It does not own provider preferences, credentials or a second task scheduler.

Task state uses the existing Session control stream without polling. Explicit result collection marks the job reported under Jobs semantics; it does not undo an earlier parent-model wakeup. Read and cancel refuse foreign, unowned and non-subagent jobs. Results are truncated at a complete UTF-8 character and rendered as text; cancellation acknowledges a request, not completed cleanup. The panel never retries an uncertain write automatically.

No invariant companion is published: Commands and Jobs own the durable and lifecycle relationships, and this consumer keeps no independent persistent mirror.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Desktop packages](../README.md) — optional desktop integrations.
- [Subagent subsystem](../../../docs/subsystems/subagent.md) — provider execution and access semantics.
- [Delegation decision](../../../.agents/notes/implemented/feature/2026-09-07-delegation-launcher.md) — ownership and verification limits.

<a id="model-experience"></a>
## Model Experience

### Delegated task input

#### What the model sees

The selected provider receives the user's trimmed task as one text block. The provider owns child context inheritance and model request assembly. This package adds no fixed system prompt or model tool.

#### Token effect

Task text and provider-selected context contribute to child requests. Installation and provider listing make no model request.

#### KV Cache effect

Each delegated run uses the provider's request context. Different task text changes that run's input; parent request prefixes are not rewritten by this Bundle.

### Background-job completion

#### What the model sees

The existing job controller may deliver successful provider output or a bounded failure notice to the parent. This package supplies the label `Delegation: {provider}` and generic failures `Delegation failed; check provider configuration.` or `Delegation could not complete; check provider configuration.`. The controller owns notice formatting and session logging.

#### Token effect

Unclaimed completion notices can add parent context and wake an idle parent model. Job output is bounded by `outputLimitBytes`; explicit collection and cancellation follow Jobs reporting semantics.

#### KV Cache effect

Completion handling adds later context without rewriting an existing prefix. Provider caching and eviction remain outside this package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The packaged-runtime browser smoke verifies offline marketplace installation, task invocation, result collection, cancellation and removal. It uses a controlled external provider and simulated native queue acknowledgements; native selection and failed-startup recovery have a separate Rust test. Full native-window acceptance remains pending.
- The panel reads terminal text on demand, not streaming output or non-text results. The shared task list can include unowned jobs, but this Bundle refuses to read or cancel them.
- Tests use a controlled external provider without account access. Real-model inference, parent completion replay and native desktop interaction remain unverified for this Bundle.
- Jobs are process-local. Reloading the panel does not cancel them, while runtime termination cannot resume them. Installed plugins are trusted code, not sandboxed extensions.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
