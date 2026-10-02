/** Shared model exclusions and successful reasoning corrections. */

import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { recoveryModelKey, type RecoveryModelKey, type RecoveryObservation } from './recovery-store.ts'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'

const SPECIAL = /preview|lite|live|image|computer-use|deep-research|customtools|embedding|tts|audio|banana|gemma/iu

/**
 * Mirror the Client's main-writing-model eligibility and stable version ordering.
 * @param models - catalog entries from one configured provider.
 * @returns eligible models ordered by descending numeric version, preserving catalog ties.
 */
export function fallbackModels(models: readonly LlmModelInfo[]): LlmModelInfo[] {
  const version = (id: string): number => Number(/(?:^|[-_])(\d+(?:\.\d+)?)(?=[-_]|$)/u.exec(id)?.[1] ?? 0)
  return models.filter(model => !SPECIAL.test(model.id) && !SPECIAL.test(model.name))
    .toSorted((left, right) => version(right.id) - version(left.id))
}

/** Quota and reasoning facts shared across sessions and adapter remounts. */
export class RecoveryMemory {
  private readonly observations = new Map<RecoveryModelKey, RecoveryObservation>()
  private readonly thinking = new Map<string, { from: string; to: ModelThinkingLevel }>()

  private key(provider: string, model: string): string { return JSON.stringify([provider, model]) }

  private day(timeZone: string, now: number): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  }

  /**
   * Remember a rejection for the provider's current quota day.
   * @param provider - registered provider route.
   * @param model - rejected model id.
   * @param timeZone - provider's daily-reset IANA time zone.
   * @param now - rejection timestamp; defaults to the system clock.
   * @returns the observation to publish durably.
   */
  exhaust(provider: string, model: string, timeZone: string, now = Date.now()): RecoveryObservation {
    const resetDate = new Date(Date.parse(`${this.day(timeZone, now)}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
    const observation: RecoveryObservation = { kind: 'daily', provider, model, timeZone, resetDate }
    this.restore(observation)
    return observation
  }

  /**
   * Check an observation and expire it after local midnight, including DST changes.
   * @param provider - registered provider route.
   * @param model - candidate model id.
   * @param timeZone - provider's daily-reset IANA time zone.
   * @param now - request timestamp; defaults to the system clock.
   * @returns whether the model is exhausted for this quota day.
   */
  isExhausted(provider: string, model: string, timeZone: string, now = Date.now()): boolean {
    const key = recoveryModelKey(provider, model)
    const observation = this.observations.get(key)
    if (observation?.kind !== 'daily') return false
    if (observation.timeZone === timeZone && this.day(timeZone, now) < observation.resetDate) return true
    this.observations.delete(key)
    return false
  }

  /**
   * Merge a durable or newly observed exclusion; permanent unavailability wins over quotas.
   * @param observation - validated record from host storage or a provider rejection.
   * @returns the merged exclusion; unavailable records and later reset dates take precedence.
   */
  restore(observation: RecoveryObservation): RecoveryObservation {
    const key = recoveryModelKey(observation.provider, observation.model)
    const previous = this.observations.get(key)
    if (previous?.kind === 'unavailable') return previous
    if (previous?.kind === 'daily' && observation.kind === 'daily'
      && previous.timeZone === observation.timeZone && previous.resetDate > observation.resetDate) return previous
    this.observations.set(key, observation)
    return observation
  }

  /**
   * Read an exclusion for durable publication.
   * @param provider - configured provider route.
   * @param model - requested model id.
   * @returns the current quota or unavailable observation, otherwise undefined.
   */
  observation(provider: string, model: string): RecoveryObservation | undefined {
    return this.observations.get(recoveryModelKey(provider, model))
  }

  /**
   * Check permanent unavailability or the current provider quota day.
   * @param provider - configured provider route.
   * @param model - candidate model id.
   * @param timeZone - provider quota reset zone.
   * @returns whether requests must skip this model.
   */
  isExcluded(provider: string, model: string, timeZone: string): boolean {
    return this.observation(provider, model)?.kind === 'unavailable' || this.isExhausted(provider, model, timeZone)
  }

  /**
   * Read a successful provider reasoning correction.
   * @param provider - registered provider route.
   * @param model - model id.
   * @returns learned level, otherwise undefined.
   */
  thinkingLevel(provider: string, model: string): ModelThinkingLevel | undefined {
    return this.thinking.get(this.key(provider, model))?.to
  }

  /**
   * Replace a previously rejected explicit effort without changing other choices.
   * @param provider - registered provider route.
   * @param model - model id.
   * @param effort - caller's current effort.
   * @returns learned replacement only for the rejected value.
   */
  correctedThinking(provider: string, model: string, effort: string | undefined): ModelThinkingLevel | undefined {
    const learned = this.thinking.get(this.key(provider, model))
    return learned?.from === effort ? learned?.to : undefined
  }

  /**
   * Remember a correction only after a successful assistant response.
   * @param provider - registered provider route.
   * @param model - model id.
   * @param from - rejected level.
   * @param level - successfully used reasoning level.
   */
  learnThinking(provider: string, model: string, from: string, level: ModelThinkingLevel): void {
    this.thinking.set(this.key(provider, model), { from, to: level })
  }
}

/** Process-wide observations, hydrated from host storage when available. */
export const recoveryMemory = new RecoveryMemory()
