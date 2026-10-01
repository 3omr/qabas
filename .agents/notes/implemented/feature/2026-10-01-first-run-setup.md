# Agent Note: First-run setup is one themed flow

Status: implemented

English | [中文](2026-10-01-first-run-setup.zh.md)

## Problem

A new student met two modals in a row over a blurred app: a testing notice, then a provider picker listing 39 providers by their configuration ids (`openai-codex`, `xiaomi-token-plan-sgp`) and talking about API keys. Nothing else the app needs — the transcription tools, NotebookLM, the study workspace — was part of starting.

## Decision

Every first-run step draws in one full-screen frame, `SetupStage` in [ui-primitives](../../../../packages/client/ui-primitives/README.md): the paper palette with an ember glow, a progress row, and focus on the step's title. Each step reads its position from the `settings.onboarding` ledger (entries sorted by order), so steps from four packages read as one sequence without knowing each other:

1. Welcome — the testing notice, redrawn as the welcome (its acknowledgement logic unchanged), with the product mark through a `settings.onboarding.mark` slot the brand fills.
2. AI account — ChatGPT, Claude and Gemini as three large cards, the full catalog behind "more options" with product names instead of provider ids. After sign-in the step names the default model it chose: the one with the largest output limit, then the largest context, because a transcript is one long answer.
3. Transcription tools — a checklist over the same doctor report the readiness page reads: NotebookLM first, then the required tools with their install buttons in place, the optional tools folded away. The settings page's list-and-detail layout did not fit a setup sheet.
4. Library — what the workspace holds, and into the library.

## Alternatives considered

**Configure the steps from the deployment patch.** Rejected: browser plugins receive no row config (`__DSH_BOOT__` carries ids and URLs only); positions come from the ledger instead.

**One setup package importing the other packages' components.** Rejected: feature plugins may not import each other's values; each package registers its own step and UI crosses through slots.

**Keep the sequence active only while the session is blank.** Rejected: signing in saves the default model, which can make the current session non-blank, and the coordinator dropped the remaining steps right after the account step. A sequence that has started now runs to its last step.

## Consequences

The first screen is the product's, in its colours and language. A deployment that registers fewer steps still draws correct progress.
