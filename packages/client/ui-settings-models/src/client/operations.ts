/**
 * The Host reads and writes the Models cards perform, as callbacks built in the
 * plugin body. Cards receive these instead of a context: the outcomes name what
 * a card renders — a stored view, a stale revision, a refusal message — so the
 * failure codes and Remote namespaces stay in the apply world.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  AuthorizationEntryView, AuthorizationFrame,
  CredentialInfo, LlmDiscoveredModel, LlmModelDiscoveryRequest,
  SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'

/** What one namespace write answered. */
export type SettingsWriteOutcome =
  /** Committed; the view carries the stored user subtree and the new revision. */
  | { readonly kind: 'written'; readonly view: SettingsNamespaceView }
  /**
   * The stored revision moved after the card read it, so the draft is stale.
   * The message stays for callers that report the Host diagnostic as it is.
   */
  | { readonly kind: 'conflict'; readonly message: string }
  /** Any other refusal, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** What one endpoint interrogation answered. */
export type ModelDiscoveryOutcome =
  /** The candidates the provider disclosed, in its own order. */
  | { readonly kind: 'found'; readonly models: readonly LlmDiscoveredModel[] }
  /** The interrogation was refused, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** The sign-in flows a route offers, and the conversation that runs one. */
export interface AuthorizationOperations {
  /**
   * What can be signed into right now.
   * @returns one entry per registered flow; empty when no seam is mounted.
   */
  listFlows(): Promise<readonly AuthorizationEntryView[]>
  /**
   * Run one sign-in.
   *
   * A flow is a conversation: it reports what the human must do and then asks
   * for what they got back, so this streams frames rather than resolving a
   * value. The caller answers a `prompt` frame with {@link answer}.
   * @param key - the credential record, e.g. `llm-pi-ai/anthropic`.
   * @param method - which of the flow's methods; omitted takes its first.
   * @param signal - withdraws the attempt.
   * @returns the attempt's frames, in order, ending with `settled`.
   */
  runFlow(key: string, method: string | undefined, signal: AbortSignal): AsyncIterable<AuthorizationFrame>
  /**
   * Answer a question the running attempt asked.
   * @param key - the attempt's credential record.
   * @param id - the `prompt` frame's id.
   * @param value - the typed text, or the chosen option's id.
   */
  answer(key: string, id: string, value: string): Promise<void>
  /**
   * Withdraw the attempt running for a key.
   * @param key - the credential record whose sign-in should stop.
   */
  cancelFlow(key: string): Promise<void>
}

/** The Host operations the Models page and its cards invoke. */
export interface ModelsOperations extends AuthorizationOperations {
  /**
   * Read one credential reference's state.
   * @param ref - credential reference name.
   * @returns the state, or undefined when the reference is unknown or the read was refused.
   */
  describeCredential(ref: string): Promise<CredentialInfo | undefined>
  /**
   * Store one credential literal under its reference.
   * @param ref - credential reference name.
   * @param value - the literal to store.
   * @returns the refusal message, or undefined once stored.
   */
  storeCredential(ref: string, value: string): Promise<string | undefined>
  /**
   * Remove one credential reference (idempotent).
   * @param ref - credential reference name.
   * @returns the refusal message, or undefined once removed.
   */
  removeCredential(ref: string): Promise<string | undefined>
  /**
   * Apply path operations to one settings namespace.
   * @param ns - settings namespace identity.
   * @param ops - ordered path operations against the stored section, as the
   * wire takes them (the Remote signature owns the array).
   * @param expectedRevision - revision the draft was opened at, or undefined to write unfenced.
   * @returns the write outcome the card renders from.
   */
  writeSettings(
    ns: string,
    ops: SettingsPathOpView[],
    expectedRevision: number | undefined,
  ): Promise<SettingsWriteOutcome>
  /**
   * Ask a provider endpoint what models it serves.
   * @param settingsNs - namespace whose adapter family answers.
   * @param request - endpoint facts as the form currently shows them.
   * @returns the candidates, or the refusal.
   */
  discoverModels(settingsNs: string, request: LlmModelDiscoveryRequest): Promise<ModelDiscoveryOutcome>
  /**
   * Save a provider/model as the deployment default when no default exists.
   * @param provider - provider route to use for future Sessions.
   * @param model - provider-owned model id selected from discovery.
   * @returns the refusal message, or undefined after the conditional write settles.
   */
  saveDefaultModel(provider: string, model: string): Promise<string | undefined>
}

/**
 * Bind the page's Host operations to the plugin's own Remote namespaces.
 * @param ctx - the page plugin's context, which declares the credentials, LLM,
 * session, and settings Remote namespaces in its own `inject`.
 * @returns the callbacks the section and its cards are injected with.
 */
export function createModelsOperations(ctx: ClientContext): ModelsOperations {
  return {
    describeCredential: async (ref) => {
      const response = await ctx.remote.credentials.describe([ref])
      return response.ok ? response.value[ref] : undefined
    },
    storeCredential: async (ref, value) => {
      const response = await ctx.remote.credentials.set(ref, value)
      return response.ok ? undefined : response.error.message
    },
    removeCredential: async (ref) => {
      const response = await ctx.remote.credentials.unset(ref)
      return response.ok ? undefined : response.error.message
    },
    writeSettings: async (ns, ops, expectedRevision) => {
      const response = await ctx.remote.settings.mutate(ns, ops, expectedRevision)
      if (response.ok) return { kind: 'written', view: response.value }
      const { code, message } = response.error
      return code === 'settings/conflict' ? { kind: 'conflict', message } : { kind: 'refused', message }
    },
    listFlows: async () => {
      const response = await ctx.remote.authorization.list()
      // A composition with no seam is not an error the page should shout
      // about: it simply has nothing to offer, and the API-key field stands.
      if (response.ok) return response.value
      console.warn('ui-settings-models: listFlows failed', response.error.code, response.error.message)
      return []
    },
    runFlow: (key, method, signal) => ctx.remote.authorization.run(key, method, signal),
    answer: async (key, id, value) => { await ctx.remote.authorization.answer(key, id, value) },
    cancelFlow: async (key) => { await ctx.remote.authorization.cancel(key) },
    discoverModels: async (settingsNs, request) => {
      const response = await ctx.remote.llm.discoverModels(settingsNs, request)
      return response.ok
        ? { kind: 'found', models: response.value }
        : { kind: 'refused', message: response.error.message }
    },
    saveDefaultModel: async (provider, model) => {
      const response = await ctx.remote.session.saveDefaultModelIfUnset({ provider, model })
      return response.ok ? undefined : response.error.message
    },
  }
}
