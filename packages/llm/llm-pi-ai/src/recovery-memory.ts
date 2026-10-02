/** Process-lifetime quota observations and successful reasoning corrections. */

import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
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
  private readonly exhausted = new Map<string, string>()
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
   */
  exhaust(provider: string, model: string, timeZone: string, now = Date.now()): void {
    this.exhausted.set(this.key(provider, model), this.day(timeZone, now))
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
    const key = this.key(provider, model)
    const day = this.exhausted.get(key)
    if (day === undefined) return false
    if (day === this.day(timeZone, now)) return true
    this.exhausted.delete(key)
    return false
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

/** Shared process-lifetime observations; no persisted quota claims survive a restart. */
export const recoveryMemory = new RecoveryMemory()
