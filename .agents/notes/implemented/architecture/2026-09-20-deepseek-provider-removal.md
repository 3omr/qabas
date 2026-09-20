# Agent Note: DeepSeek removed as the product's provider spine

Status: implemented

English | [中文](2026-09-20-deepseek-provider-removal.zh.md)

## Problem

This fork is a desktop app for medical-lecture transcription whose users are medical students subscribed to Claude or ChatGPT, not to DeepSeek. The composition made DeepSeek the spine regardless: `llm-deepseek` was the mounted adapter, `agent-default-model` composed `deepseek-official/deepseek-flash` so every new Session opened on it, web search ran through the DeepSeek API, and first run asked for a DeepSeek API key. A student who signed into their own subscription still met a first screen demanding a key they do not have, and a model picker offering a route that cannot work.

## Decision

DeepSeek is removed as the hardwired provider, not banned as a choice. pi-ai ships DeepSeek among its ~30 providers, so it remains selectable like any other; what is gone is its privileged position.

Removed: the `llm-deepseek`, `deepseek-llm-api-extensions`, `plugin-package-inventory-deepseek`, `session-log-deepseek` and `web-search-deepseek` packages; `agent-default-model`'s composed selection; and `web`'s DeepSeek search provider, with no substitute — `web-search-exa` and `web-search-perplexity` need keys the user does not have, and search is not part of this product's job.

`agent-default-model` is mounted with no composed selection. There is no honest static default left: the default is whatever route the user signed into, written to settings at sign-in. An Agent created with no session model and no stored selection must say so rather than name a route that does not exist.

`packages/bundle/base/cordis.patch.yml` therefore diverges from upstream. A merge from upstream must not reintroduce those mounts.

Signing in provisions the route. The credential store and the adapter are separate facts: `dsh-authorization` stores what a login returns, but `llm-pi-ai` registers no route until a profile appears under `llm-pi-ai.providers.<id>`, so before this change a successful sign-in produced a stored credential and not one new model in the picker. The Models page now writes the empty profile `providers: { <id>: {} }` when a flow reports `authorized`, and the empty profile is the whole point rather than a placeholder — `resolveRouteModels` reads an absent `models` list as "serve the installed catalog", so it means *this provider, its whole catalog, its own endpoint*. Deleting a credential deliberately does not delete the route: a user replacing an expired key would otherwise lose their configuration.

## Alternatives considered

**Keep `llm-deepseek` mounted but unconfigured.** The user would never see DeepSeek, and the 382 snapshot files that name it would not need a second look. But a mounted adapter no one can authenticate keeps appearing in the model picker and in `--dump-config`, and the first-run flow still had to special-case it. Leaving a dead route in the tree to avoid touching fixtures is the kind of debt that outlives the reason for it.

**Keep it as a test-only dependency.** Cheaper again, and briefly attractive when the snapshot corpus looked like it needed re-recording. It did not: replay mounts the adapter `disabled: true`, so the fixtures never needed the package at all. Once that was measured, the only thing the dependency bought was the ability to re-record — which needs a live provider this project does not have either way.

**Substitute another web-search provider.** `web-search-exa` and `web-search-perplexity` exist, but both need an API key the target user does not have, and web search is not part of what this product does. Shipping a search box that cannot search is worse than shipping none.

**Rewrite the recorded fixtures to name a different provider.** This would have made `grep deepseek` come back empty. It would also make every recording claim it came from a provider that did not produce it, which is a lie told to every future reader of those files.

## Consequences

Recorded session fixtures under `snapshots/**` still carry `deepseek-official`. That is history, not configuration: replay mounts the adapter `disabled: true` and reads the committed JSONL, so the recordings keep working and must not be rewritten to claim a provider they did not come from. The twelve live-recording compositions cannot re-record without an adapter; `snapshots/recording-provider-required.mjs` turns that into a clear failure instead of a confusing crash.

`web/deepseek-search-llm-request` is retired, not deleted. `session-format-v0-to-v1` still carries its disposition and payload validation, because sessions recorded before the removal are on disk and must keep migrating; the frozen released-v0 inventory lists it among the types nothing produces any more.

A clean partial EOF is now retried. The removed adapter classified it `STREAM_CLOSED` and refused to retry; pi-ai classifies the same event `TRANSPORT`, reasoning that a connection dropping mid-response is a transport truncation rather than a model-level error. Retrying is the better answer for a truncated response that is useless to its reader, and it stays bounded by the route's `retryPolicy`.
