/** Choose and persist a first-run default from one provider's discovered catalog. */

import type { LlmModelDiscoveryRequest, LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelDiscoveryOutcome, ModelsOperations } from './operations.ts'

/**
 * Select the provider's preferred model for transcription.
 *
 * Writing a lecture's transcript is one long answer, part after part, and a
 * model that stops short is the failure the engine refuses most. So the model
 * that discloses the largest output limit wins, then the largest context;
 * when the catalog discloses neither, pi-ai's own order stands and the first
 * entry with a model id is the least surprising default. An empty catalog has
 * no safe selection.
 * @param models - provider catalog entries in the order returned by discovery.
 * @returns the preferred entry, or undefined when discovery found no model id.
 */
export function preferredDiscoveredModel(
  models: readonly LlmDiscoveredModel[],
): LlmDiscoveredModel | undefined {
  let best: LlmDiscoveredModel | undefined
  for (const model of models) {
    if (model.id.trim().length === 0) continue
    if (best === undefined || capacityRank(model, best) > 0) best = model
  }
  return best
}

/** Positive when `left` can write longer answers than `right`. */
function capacityRank(left: LlmDiscoveredModel, right: LlmDiscoveredModel): number {
  return (left.maxTokens ?? 0) - (right.maxTokens ?? 0)
    || (left.contextWindow ?? 0) - (right.contextWindow ?? 0)
}

/**
 * Discover a provider's catalog and save its preferred model as the default.
 * A failed discovery leaves the default untouched; the provider still works,
 * and the student can pick a model from the composer.
 * @param operations - discovery and default-model persistence.
 * @param provider - provider id the default belongs to.
 * @param target - settings namespace and discovery request.
 * @returns the model saved, or undefined when nothing was discovered.
 */
export async function saveDefaultFromDiscovery(
  operations: Pick<ModelsOperations, 'discoverModels' | 'saveDefaultModel'>,
  provider: string,
  target: { settingsNs: string; request: LlmModelDiscoveryRequest },
): Promise<LlmDiscoveredModel | undefined> {
  let outcome: ModelDiscoveryOutcome
  try {
    outcome = await operations.discoverModels(target.settingsNs, target.request)
  } catch (error: unknown) {
    console.warn('ui-settings-models: default model discovery failed', error)
    return undefined
  }
  if (outcome.kind !== 'found') return undefined
  const preferred = preferredDiscoveredModel(outcome.models)
  if (preferred === undefined) return undefined
  const failure = await operations.saveDefaultModel(provider, preferred.id)
  if (failure !== undefined) throw new Error(failure)
  return preferred
}
