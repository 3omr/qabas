# Agent Note: ACP sessions follow the saved default model

Status: implemented

English | [中文](2026-10-05-acp-saved-default-model.zh.md)

## Problem

The ACP application bundle configured `deepseek-official` as its provider and model. Removing DeepSeek as the product's provider spine deleted that configuration without a replacement, so every ACP session started without a model and its first turn failed while assembling the persona prefix's `{{model}}` variable.

## Decision

When the ACP plugin has no complete provider and model pair, a new or resumed session awaits the Loader and then uses `agentDefaultModel.currentSelection()`, the route the user saved after signing in. Waiting for the Loader matches the headless application: ACP requests can arrive while the settings document is still mounting. A complete deployment pair still wins, and without a saved default the partial fields stay available to request listeners.

## Alternatives considered

**Compose a fixed provider in the ACP bundle again.** Rejected: the product has no honest static default, which is why the base bundle composes none.

**Read the default once when the plugin applies.** Rejected: settings mount after ACP starts, and a sign-in during the process must apply to the next session.

## Consequences

The built-bin e2e tests sign into a pi-ai `deepseek` catalog route pointed at the mock server instead of the removed adapter, and the headless keyless smoke no longer expects a `web_search` tool, since the product composes no search provider.
