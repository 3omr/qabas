# Agent Note: Human delegation as an optional Bundle

Status: implemented

## Problem

Provider configuration proves neither task invocation nor successful execution. A nondeveloper needs an explicit task entry point without a second agent scheduler or implicit account access.

## Decision

The [delegation Bundle](../../../../packages/desktop/delegation-launcher/README.md) registers a human command over the existing subagent and owner-scoped Jobs services. The command owns JSON and task-byte validation; Jobs owns admission, cancellation and cleanup. The Bundle bounds panel reads and configures the job controller's completion-notice limit. Command input and outcome use the existing session event types. The editor lists only loaded providers and requires task-specific review before submitting.

The browser consumes the existing Commands Remote outcome directly. SessionFace.command deliberately returns only a matched bit, while blank sessions hide conversation content until a model turn begins. Displaying the command's actual result inside the plugin avoids a misleading acknowledgement without changing upstream blank-session semantics. A connection change invalidates review; uncertain writes are never replayed.

The panel consumes live task states from the Session control stream and exposes explicit terminal reads and confirmed cancellation through its own Remote. The executor requires exact session ownership and subagent kind. Closing the panel discards output but does not cancel work; cancellation acknowledgement is distinct from provider cleanup. These controls keep blank-session delegation usable without a second job registry.

The [local-agent opt-in decision](2026-09-06-desktop-local-agent-opt-ins.md) remains the independent owner of provider configuration, native diagnostics and model tool grants. This Bundle invokes human-authorized work through loaded providers without modifying those preferences. The reviewed desktop catalog distributes its exact artifact; installation alone neither configures providers nor starts work. Its installed use action closes Settings before opening the shared delegation panel.

## Alternatives considered

**Launch product CLIs directly from the editor.** Rejected because that duplicates provider authentication, process ownership and result normalization.

**Use a successful transport response as task success.** Rejected because command admission can fail, execution is asynchronous and a lost response can follow a successful enqueue.

**Change the upstream empty-session rule for this plugin.** Rejected because the plugin can display command outcomes and task controls through existing services without altering conversation rendering.

## Consequences

The editor adds no polling or startup agent probe. Pending work outlives plugin removal and remains owned by Jobs until provider cleanup finishes. Provider infrastructure diagnostics become generic job errors; returned task text is not treated as trusted instructions. Provider context inheritance and potential parent-model wakeups are disclosed before authorization.

Focused tests exercise command logging, duplicate clicks, stale reads, session ownership, UTF-8 limits, cancellation, delayed cleanup, provider removal and reversible UI registration. Provider names are sorted without altering registration order. The packaged-runtime browser smoke installs the reviewed artifact offline, opens its installed action, reads and cancels real jobs, and removes the Bundle without changing the source combination or settings. It controls the external provider and native queue response, and explicitly composes the real browse directory picker for its isolated PATH. Native candidate selection and failed-startup recovery have separate Rust evidence. Real-account inference, model-visible parent completion replay and full native-window acceptance remain gaps; no public marketplace completion is claimed.
