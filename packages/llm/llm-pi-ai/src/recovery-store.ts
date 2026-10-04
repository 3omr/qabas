/** Durable provider/model exclusions in the host's routed state store. */

import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { RecoveryMemory } from './recovery-memory.ts'

/** Storage key containing the provider route and requested model id. */
export type RecoveryModelKey = Branded<'RecoveryModelKey'>

/** Daily reset dates belong to the recorded IANA zone; unavailable models have no expiry. */
const observationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), provider: z.string().min(1), model: z.string().min(1),
    timeZone: z.string().refine((value) => {
      try { new Intl.DateTimeFormat('en', { timeZone: value }); return true }
      catch (error) { if (!(error instanceof RangeError)) throw error; return false }
    }), resetDate: z.iso.date() }),
  z.object({ kind: z.literal('unavailable'), provider: z.string().min(1), model: z.string().min(1) }),
])

/** Validated durable model exclusion. */
export type RecoveryObservation = z.infer<typeof observationSchema>

/** Host state unit containing model exclusions, independent of Session logs. */
export const recoveryDomainSpec = defineDomain({
  name: 'llm_pi_ai_recovery', version: 1,
  tables: { models: domainTable<RecoveryModelKey, RecoveryObservation>(observationSchema) },
})

/**
 * Address one model observation in memory and on the medium.
 * @param provider - configured provider route.
 * @param model - requested model id.
 * @returns the serialized route/model pair.
 */
export function recoveryModelKey(provider: string, model: string): RecoveryModelKey {
  return brandString<RecoveryModelKey>(JSON.stringify([provider, model]))
}

/** Await durable observations before retrying; drain and close after recovery requests settle. */
export class RecoveryStore {
  private domain?: Promise<Domain<typeof recoveryDomainSpec>>
  private pending: Promise<void> = Promise.resolve()
  private readonly pendingQuotaClears = new Set<string>()

  constructor(private readonly memory: RecoveryMemory) {}

  /**
   * Hydrate exclusions once for a request or reset, deleting deferred quota clears first.
   * @param facility - current optional host state service; absence keeps process-only recovery.
   * @returns resolution after deferred deletions are durable and retained records enter memory.
   */
  async ready(facility: DomainFacility | undefined): Promise<void> {
    if (this.domain === undefined && facility !== undefined) {
      this.domain = facility.open(recoveryDomainSpec).then(async (domain) => {
        const table = domain.table('models')
        for (const [key, observation] of table.entries()) {
          if (observation.kind === 'daily' && this.pendingQuotaClears.has(observation.provider)) await table.delete(key)
          else this.memory.restore(observation)
        }
        this.pendingQuotaClears.clear()
        return domain
      })
    }
    await this.domain
  }

  /**
   * Persist an observed exclusion before a replacement request is admitted.
   * @param observation - daily quota or unavailable-model observation.
   * @returns resolution after host durability; without a host store only memory is updated.
   */
  remember(observation: RecoveryObservation): Promise<void> {
    const revision = this.memory.quotaRevision(observation.provider)
    return this.enqueue(async () => {
      const domain = await this.domain
      if (observation.kind === 'daily' && revision !== this.memory.quotaRevision(observation.provider)) return
      const merged = this.memory.restore(observation)
      await domain?.table('models').put(recoveryModelKey(observation.provider, observation.model), merged)
    })
  }

  /**
   * Delete a provider's durable daily exclusions and clear its memory after hydration.
   * Unavailable models remain excluded; rate pacing is owned by RequestPacer.
   * @param provider - route whose credential changed or passed an authenticated check.
   * @param facility - current host state service; absence defers durable deletion until hydration.
   * @returns completion after earlier writes and durable deletion when storage is available.
   */
  clearQuota(provider: string, facility: DomainFacility | undefined): Promise<void> {
    return this.enqueue(async () => {
      await this.ready(facility)
      const domain = await this.domain
      this.memory.clearQuota(provider)
      const table = domain?.table('models')
      if (table === undefined) this.pendingQuotaClears.add(provider)
      else {
        for (const [key, observation] of table.entries()) {
          if (observation.provider === provider && observation.kind === 'daily') await table.delete(key)
        }
      }
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.then(operation)
    // The caller receives failures; later resets must still be able to retry.
    this.pending = result.then(() => {}, () => {})
    return result
  }

  /**
   * Release the host domain after active recovery has drained.
   * @returns completion of domain close.
   */
  async close(): Promise<void> {
    await this.pending
    const domain = await this.domain
    await domain?.close()
  }
}
