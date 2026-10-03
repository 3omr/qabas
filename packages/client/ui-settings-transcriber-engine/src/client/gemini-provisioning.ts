/** Provision the native Google route and a first Gemini Flash default after saving a key. */
import type { ClientRemote, LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'

/** Host operations needed to provision a Google route without a client key. */
export interface GeminiProvisioningRemote {
  readonly settings: Pick<ClientRemote['settings'], 'describe' | 'mutate'>
  readonly llm: Pick<ClientRemote['llm'], 'discoverModels'>
  readonly session: Pick<ClientRemote['session'], 'saveDefaultModelIfUnset'>
}

/**
 * Choose the newest main Gemini Flash model, excluding preview and specialist variants.
 * @param models - the catalog supplied by Google route discovery.
 * @returns preferred Flash model, or undefined when the catalog has no eligible entry.
 */
export function preferredGeminiFlash(models: readonly LlmDiscoveredModel[]): LlmDiscoveredModel | undefined {
  const eligible = models.filter(model => /(?:^|\/)gemini[-_].*flash/iu.test(model.id)
    && !/preview|lite|live|image|computer-use|deep-research|customtools|embedding|tts|audio/iu.test(model.id))
  const version = (id: string): readonly number[] => /gemini[-_](\d+(?:\.\d+)?)/iu.exec(id)?.[1]?.split('.').map(Number) ?? [0, 0]
  return [...eligible].sort((left, right) => (version(right.id)[0] ?? 0) - (version(left.id)[0] ?? 0)
    || (version(right.id)[1] ?? 0) - (version(left.id)[1] ?? 0)
    || (right.maxTokens ?? 0) - (left.maxTokens ?? 0) || (right.contextWindow ?? 0) - (left.contextWindow ?? 0))[0]
}

/**
 * Materialize an absent native Google profile and conditionally save its discovered Flash model.
 * @param remote - Host settings, model discovery and conditional-default calls; contains no client key.
 * @returns refusal message, or undefined after provisioning succeeds.
 */
export async function provisionGemini(remote: GeminiProvisioningRemote): Promise<string | undefined> {
  const described = await remote.settings.describe()
  if (!described.ok) return described.error.message
  const namespace = described.value.namespaces.find(entry => entry.ns === 'llm-pi-ai')
  if (namespace === undefined) return 'The Google model settings namespace is not available.'
  const profile = namespace.value
  const providers = typeof profile === 'object' && profile !== null && !Array.isArray(profile) ? profile.providers : undefined
  const exists = typeof providers === 'object' && providers !== null && !Array.isArray(providers)
    && Object.hasOwn(providers, 'google')
  if (!exists) {
    const saved = await remote.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'google'], value: {} }], namespace.revision)
    if (!saved.ok) return saved.error.message
  }
  const discovered = await remote.llm.discoverModels('llm-pi-ai', { provider: 'google' })
  if (!discovered.ok) return discovered.error.message
  const model = preferredGeminiFlash(discovered.value)
  if (model === undefined) return 'The Google catalog contains no supported Gemini Flash model.'
  const saved = await remote.session.saveDefaultModelIfUnset({ provider: 'google', model: model.id })
  return saved.ok ? undefined : saved.error.message
}
