---
description: "Qabas chat assistant: current Qabas controls, saved data, recovery and limitations."
---

# Qabas chat assistant

## Summary

The conversation panel accepts study questions and transcription requests in Egyptian Arabic. It has no module or lecture scope: the model finds the module and lecture from the message text, and it does not have complete parity with every library button.

## Table of Contents

- [Entry point and actions](#entry-point-and-actions)
- [Saved results and providers](#saved-results-and-providers)
- [Failures and limitations](#failures-and-limitations)
- [Dev Note](#dev-note)

## Entry point and actions

Open the conversation panel with «اسأل المساعد» or a new conversation and enter a message. «اسأل المساعد» starts an unscoped conversation from any library page ([chat actions](../../packages/client/ui-library/src/client/chat-actions.ts)); the shipped Web composition mounts the generic Harness composer, not a Qabas module selector ([composition](../../packages/bundle/web-app/cordis.patch.yml)).

The [transcriber preset](../../packages/preset/agent-presets/presets/transcriber/agent.cordis.yml) instructs the assistant to list modules and lectures, audit sources, retrieve questions and run a lecture through review and finalization. Module creation and source synchronization require confirmation for the exact action. A transcription request covers review and finalization of that lecture. The preset describes a constrained tool procedure; availability of an engine management tool is not proof that the model reliably uses every library operation.

## Saved results and providers

Chat messages and tool activity use Harness Sessions rather than a Markdown chat file under the module. The shipped Web composition stores session logs under `<home>/qabas/Qabas Library/.qabas/sessions/` ([composition](../../packages/bundle/web-app/cordis.patch.yml)), and the [persistence catalog](../persistence-catalog.md) lists their event types; generated study artifacts use the module locations in [Transcription](transcription.md) and [Exams](exams.md).

The Omar chat route uses Antigravity. With an eligible terminal failure, configured fallback and a saved Gemini key, the provider can switch to Google for that turn and show a fallback notice. The next turn starts with the original route. [Adapter](../../packages/llm/llm-agy/src/adapter.ts) and [recovery](../../packages/llm/llm-agy/src/recovery.ts) own this behavior. A chat fallback does not provide a replacement for agy exam extraction or external-image verification.

## Failures and limitations

Provider sign-in, quota and network errors can interrupt chat. Accounts and tools provides service checks and Gemini-key controls. A retry is not proof that a previous library mutation failed before writing; check the resulting library state before repeating a consequential request.

General and module-scoped chat with enforced action parity remains proposed work ([#58](https://github.com/3omr/qabas/issues/58)). The composer still exposes a permission selector and each assistant turn exposes token/cache usage, although the shipped composition disables the composer's statistics pills; indexing can coincide with slow chat responses, but source inspection alone cannot attribute elapsed time to local contention rather than the provider ([#58](https://github.com/3omr/qabas/issues/58), [#62](https://github.com/3omr/qabas/issues/62)). Work copy mixes «عومر» and Antigravity ([#57](https://github.com/3omr/qabas/issues/57)). Task history and placement can also differ between chat and library ([#54](https://github.com/3omr/qabas/issues/54)).

## Dev Note

None.
