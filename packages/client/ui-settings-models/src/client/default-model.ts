/** Choose and persist a first-run default from one provider's discovered catalog. */

import type { LlmModelDiscoveryRequest, LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelDiscoveryOutcome, ModelsOperations } from './operations.ts'

/**
 * Select the provider's preferred first model.
 *
 * pi-ai returns catalog entries in adapter-preferred order, so the first entry
 * with a model id is the least surprising default for a newly provisioned
 * whole-catalog route. An empty catalog has no safe selection.
 * @param models - provider catalog entries in the order returned by discovery.
 * @returns the preferred entry, or undefined when discovery found no model id.
 */
export function preferredDiscoveredModel(
  models: readonly LlmDiscoveredModel[],
): LlmDiscoveredModel | undefined {
  return models.find(model => model.id.trim().length > 0)
}

/**
 * Discover and save a first-run default for a newly provisioned provider.
 * Discovery refusals and transport failures leave the route usable without
 * inventing a model id; the caller's existing no-default error remains honest.
 * @param operations - Host operations for discovery and default persistence.
 * @param provider - provider route receiving the default.
 * @param target - endpoint facts to send to discovery.
 * @returns fulfillment after discovery and the conditional default write settle.
 */
export async function saveDefaultFromDiscovery(
  operations: Pick<ModelsOperations, 'discoverModels' | 'saveDefaultModel'>,
  provider: string,
  target: { settingsNs: string; request: LlmModelDiscoveryRequest },
): Promise<void> {
  let outcome: ModelDiscoveryOutcome
  try {
    outcome = await operations.discoverModels(target.settingsNs, target.request)
  } catch (error: unknown) {
    console.warn('ui-settings-models: default model discovery failed', error)
    return
  }
  if (outcome.kind !== 'found') return
  const preferred = preferredDiscoveredModel(outcome.models)
  if (preferred === undefined) return
  const failure = await operations.saveDefaultModel(provider, preferred.id)
  if (failure !== undefined) throw new Error(failure)
}
