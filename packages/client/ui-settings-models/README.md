---
description: "Models settings and provider-onboarding plugin for the dsh web client: pi-ai provider routes, credentials, model lists, and first-run sign-in."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-models

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-settings-models` is the Models settings page of the dsh web client: users choose a pi-ai provider, sign in or save an API key, edit its model catalog, and hand-declare custom routes. The page joins the provider directory, the settings document, authorization flows, and credential descriptions into one shared snapshot, so route status stays consistent across the page. First-run users see the versioned internal-testing notice and a provider chooser that reuses each pi-ai sign-in flow.

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

Open the Models page from the Settings navigation to see configured pi-ai routes in the provider catalog. Select a row to open its Authentication or Models tab. The catalog keeps provider diagnostics visible and presents add controls only when the owning settings namespace is available.

A provider with a stored catalog error remains visible with its diagnostic and edit/delete actions. Add actions are offered only for registered settings namespaces, so an unavailable namespace cannot leave a button that opens no editor. A rejected save leaves the editor open and displays the Host diagnostic.

### API keys

The primary field on an editor card is a single **API key** input — the page never asks for an environment-variable name. Built-in pi-ai providers use the environment-variable names documented by pi-ai, such as `GEMINI_API_KEY`, `HF_TOKEN`, `COPILOT_GITHUB_TOKEN`, and `OPENROUTER_API_KEY`; a hand-declared route uses the `<ROUTE>_API_KEY` fallback. The key is stored write-only through `credentials.set`, while a new built-in route is provisioned as an empty profile so pi-ai keeps its catalog and native endpoint defaults. A row is ready only when its route and credential are both available, and a stored sign-in also counts as ready. Deleting a route keeps its credential so the user can replace or reuse it explicitly. A successful Apply emits a local accessible status message without echoing secret material.

### Editing a provider

The collapsed 自定义设置 fold carries the curated pi-ai extras: `baseURL`, the model catalog, and the **display name** and **API protocol** of a route the adapter does not ship. Profile `headers` remain deployment configuration in `settings.yaml` or Cordis config and have no Models-page editor. The Provider ID stays fixed: it is the settings key, the name every other namespace and every logged session references, and the stem of a credential reference the page cannot read back to move. Reasoning effort is deliberately not among the editable fields: it is a per-model capability, so a provider-scoped control could only be set to a value some models reject. Existing fields outside the curated set survive edits.

### Adding and deleting providers

The add flow offers installed pi-ai providers from the dormant directory before any route exists. **Add a custom provider** declares a route pi-ai does not ship; the create card asks for a unique **Provider ID**, an endpoint, a protocol, and at least one uniquely identified model, because nothing can default those. The endpoint must be a parseable HTTP or HTTPS URL; localhost, IPv4 and IPv6 literals, and custom ports remain valid. **Fetch available models** asks the `llm/discoverModels` Remote about the endpoint the form shows; the reply opens a searchable picker rather than being written, and nothing is written until **Add selected**. Each selected candidate copies its available id, display name, context window, and output-token cap into the editable row. A route is deletable only when the user layer alone carries it, and deletion unsets the route without deleting its credential.

### First-run dialogs

The provider chooser lists active pi-ai providers from the configurable directory. Anthropic, OpenAI Codex, GitHub Copilot, and OpenRouter lead the list, followed by other OAuth providers and then API-key providers. Each row states whether it uses a subscription sign-in, an API key, or both.

After the versioned notice step completes, the provider chooser projects readiness from the same joined snapshot. Selecting a provider runs its existing `SignIn` conversation. An authorized flow writes exactly one `providers.<id> = {}` profile when the route is absent; cancelled and failed flows write no route. Saving an API key for a provider without a route uses the same empty-profile provisioning. Configure later leaves the route set unchanged.

### Extension slots

The section declares two seats for plugins distributed outside this repository, typed in [`src/client/slot-contract.ts`](src/client/slot-contract.ts) and exported from `./client`. `settings.models.provider-card` (keyed) renders inside each configured catalog detail and carries the provider directory entry, route state, and confirmed credential state. `settings.models.footer` (list) renders after the catalog and add controls. A registrant activates through `ctx.slots.inject` with a type-only import of this package's `/client` entry; without registrants both seats render nothing.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The page never holds a full settings section: it holds only the REDACTED descriptor, so every edit lands as `settings.mutate` path ops against the stored section — a set per changed field, an unset per cleared one, and a single unset for a deleted provider row.

### Validation

A typed API key is judged on its own field: after trimming, it must be non-empty and every character must be printable ASCII (`[\x21-\x7E]`), which is exactly what an HTTP header value can carry — the twin of `normalizeApiKey` in `@deepseek-ai/dsh-llm`, mirrored here because the source-plane split forbids importing it. A value matching a pasted `NAME=value` environment line or wrapped in matching quotes is refused as the same format failure. Empty ids, duplicate ids, empty explicit names, and unreadable, non-positive, or fractional capacities fail before any write. The pi-ai `models` array is edited as one user-layer override: the editor shows inherited catalog rows until the first model edit materializes the complete array, while reset unsets that override.

### Concurrency and credentials

Each settings write carries the card's current `revision`, so a concurrent write from another tab or an external `settings.yaml` edit is refused as `settings/conflict`. After settings commit, the card adopts the returned redacted user subtree and revision before storing the credential, so a failed credential stage retries only that stage. Removing a route only unsets its profile; it does not remove the credential, because replacing an expired key must not discard route configuration. Once loaded, the page subscribes to forwarded `settings/document-updated`, `credentials/reference-updated`, and `llm/adapters-updated` owner events, plus local `connection/reset`, so external edits converge without polling.

### Onboarding coordinator

The notice step owns its exact copy in `src/client/locales.ts` and its acknowledgement version in `src/onboarding-copy.ts`; on loopback it compares and writes `ui-onboarding.welcomeNoticeVersion` through the existing settings API, and only an explicit Continue records the current version. A non-loopback browser cannot use that Host-only namespace, so acknowledgement is process-local and the notice returns after reload. The provider step uses `OnboardingModal` and the existing `SignIn` component. Its success callback writes the empty pi-ai route through `schema-operations.ts`; cancellation and failure stop before that write.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the settings base, the seams this page joins, and the design rationale.

- [ui-settings](../ui-settings/README.md) — the domain base whose scope and schema services this page builds on.
- [settings](../../settings/README.md) — the durable user-settings seam and its file provider.
- [credentials](../../credentials/README.md) — the credential-reference seam this page writes keys through.
- [llm](../../llm/README.md) — the adapter registry whose providers this page configures.
- [Web config plane](../../../.agents/notes/archived/architecture/2026-07-30-web-config-plane.md) — the hand-written editor's design rationale.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the editor's field coverage and the page's reach; they are current package constraints, not a settings roadmap.

- **Only the API key and curated fold fields are editable on the card** — the hand-written editor traded schema-generic field coverage for the catalog layout. Retry policy, timeouts, and other advanced fields remain in `settings.yaml`; existing model fields the editor does not show are preserved.
- **Credential deletion is separate from route deletion** — deleting a route keeps its credential. The page can replace a credential through the authentication editor, while explicit credential cleanup remains owned by the credential surface.
- **Only pi-ai routes can be hand-declared** — the custom-provider card writes into `llm-pi-ai`, the namespace whose profiles describe a whole provider.
- **Interrogation covers OpenAI-compatible and Anthropic Messages endpoints** — OpenAI protocols accept a standard `data` array or an enriched `models` map, while Anthropic uses its native model-listing route; every other protocol reports that it cannot be asked and its models are entered by hand.
- **Undeclared live routes render nowhere** — a route registered without a configurable-provider declaration has no settings address; it stays visible in pickers but not on this page's rows.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. A nav-entry-only section plugin rendering a fixed empty content column — it emits no cordis events and owns no cross-plugin mutable relation.
