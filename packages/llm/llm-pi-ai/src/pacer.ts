/** Process-local request reservations shared across pi-ai adapters and sessions. */

import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { QuotaFacts } from './quota.ts'

const WINDOW_MS = 60_000

interface RequestWindow {
  provider: string
  starts: number[]
  budget?: number
  resumeAt: number
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.min(delayMs, MAX_TIMER_DELAY_MS))
    function onAbort(): void {
      clearTimeout(timer)
      reject(new Error('LLM request pacing cancelled', { cause: signal?.reason }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Sliding-minute reservations with even spacing after a provider reveals its RPM budget. */
export class RequestPacer {
  private readonly windows = new Map<string, RequestWindow>()

  /**
   * Forget rate budgets, reservations and cooldowns for a replaced credential.
   * @param provider - provider route whose credential is reset.
   */
  clearQuota(provider: string): void {
    for (const window of this.windows.values()) {
      if (window.provider !== provider) continue
      window.starts = []
      delete window.budget
      window.resumeAt = 0
    }
  }

  private window(provider: string, model: string): RequestWindow {
    const key = JSON.stringify([provider, model])
    let window = this.windows.get(key)
    if (window === undefined) {
      window = { provider, starts: [], resumeAt: 0 }
      this.windows.set(key, window)
    }
    return window
  }

  /**
   * Retain a revealed request budget and provider cooldown for this process.
   * @param provider - registered provider route.
   * @param model - requested model, keeping aliases isolated.
   * @param facts - quota facts from the failed request.
   */
  learn(provider: string, model: string, facts: QuotaFacts): void {
    if (facts.daily || !facts.minute) return
    const window = this.window(provider, model)
    if (facts.requestsPerMinute !== undefined) {
      window.budget = Math.min(window.budget ?? facts.requestsPerMinute, facts.requestsPerMinute)
    }
    window.resumeAt = Math.max(window.resumeAt, Date.now() + (facts.retryAfterMs ?? 0))
  }

  /**
   * Wait for and atomically reserve a request start; unknown budgets never throttle.
   * Concurrent waiters recompute after waking, so they cannot claim the same slot.
   * Aborted waits never reserve; failed dispatched requests still consume their slot.
   * @param provider - registered provider route.
   * @param model - requested model.
   * @param signal - cancellation for this request.
   * @returns resolves immediately before dispatch, or rejects on cancellation.
   */
  async acquire(provider: string, model: string, signal?: AbortSignal): Promise<void> {
    const window = this.window(provider, model)
    while (true) {
      signal?.throwIfAborted()
      const now = Date.now()
      window.starts = window.starts.filter(start => start > now - WINDOW_MS)
      const last = window.starts.at(-1)
      let readyAt = window.resumeAt
      if (window.budget !== undefined) {
        if (last !== undefined) readyAt = Math.max(readyAt, last + WINDOW_MS / window.budget)
        const oldest = window.starts[window.starts.length - window.budget]
        if (oldest !== undefined) readyAt = Math.max(readyAt, oldest + WINDOW_MS)
      }
      if (readyAt <= now) {
        window.starts.push(now)
        return
      }
      await wait(Math.ceil(readyAt - now), signal)
    }
  }
}

/** Process-lifetime quota knowledge, including across adapter replacement. */
export const requestPacer = new RequestPacer()
