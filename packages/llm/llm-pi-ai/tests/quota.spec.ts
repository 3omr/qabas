import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { quotaFacts, retryAfterMs } from '../src/quota.ts'
import { RequestPacer } from '../src/pacer.ts'
import { mapStopReason } from '../src/stream.ts'

function quotaBody(period = 'Minute', quotaValue = '5'): string {
  return JSON.stringify({ error: {
    code: 429,
    message: 'You exceeded your current quota. Please retry in 19.87s.',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{
        quotaId: `GenerateRequestsPer${period}PerProjectPerModel-FreeTier`, quotaValue,
      }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '19s' },
    ],
  } })
}

afterEach(() => { vi.useRealTimers() })

describe('provider quota instructions', () => {
  it.each([
    ['{"retryDelay":"19s"}', 19_000],
    ['Please retry in 19.87s', 19_870],
    [quotaBody(), 19_870],
    ['429 Retry-After: 25', 25_000],
    ['{"retryDelay":"invalid"}', undefined],
  ])('honors the longest available wait in %s', (message, expected) => {
    expect(quotaFacts(message).retryAfterMs).toBe(expected)
  })

  it.each([
    ['Minute', 'RATE_LIMIT'],
    ['Day', 'DAILY_QUOTA_EXHAUSTED'],
  ])('classifies the %s quota before generic exceeded-quota wording', (period, code) => {
    const reason = mapStopReason({
      stopReason: 'error', errorMessage: quotaBody(period), model: 'gemini-3-flash',
    } as AssistantMessage)
    expect(reason).toMatchObject({ kind: 'error', failure: { code, providerRetryAfterMs: 19_870 } })
    if (period === 'Day' && reason.kind === 'error') expect(reason.failure.message).toContain('gemini-3-flash')
  })

  it('keeps mixed daily and minute violations terminal and ignores token budgets', () => {
    expect(quotaFacts(quotaBody('Day') + ' PerMinute')).toMatchObject({ daily: true, minute: true })
    expect(quotaFacts(quotaBody().replace('GenerateRequests', 'GenerateContentInputTokens')).requestsPerMinute).toBeUndefined()
    expect(quotaFacts(quotaBody('Minute', '0')).requestsPerMinute).toBeUndefined()
  })

  it('parses Retry-After HTTP dates and rejects expired or invalid values', () => {
    const now = Date.parse('2026-10-02T00:00:00Z')
    expect(retryAfterMs('Fri, 02 Oct 2026 00:00:25 GMT', now)).toBe(25_000)
    expect(retryAfterMs('Thu, 01 Oct 2026 00:00:00 GMT', now)).toBeUndefined()
    expect(retryAfterMs('not a date', now)).toBeUndefined()
  })
})

describe('learned request pacing', () => {
  it('admits unknown budgets and holds retries until the pre-learning window clears', async () => {
    vi.useFakeTimers()
    const pacer = new RequestPacer()
    for (let index = 0; index < 6; index++) await pacer.acquire('google', 'flash')
    pacer.learn('google', 'flash', quotaFacts(quotaBody()))
    const admitted = vi.fn()
    const pending = pacer.acquire('google', 'flash').then(admitted)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(admitted).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(admitted).toHaveBeenCalledOnce()
  })

  it('spaces concurrent reservations and isolates provider and model budgets', async () => {
    vi.useFakeTimers()
    const pacer = new RequestPacer()
    pacer.learn('google', 'flash', { daily: false, minute: true, requestsPerMinute: 5 })
    await pacer.acquire('google', 'flash')
    pacer.learn('google', 'pro', { daily: false, minute: true, requestsPerMinute: 2 })
    await pacer.acquire('google', 'pro')
    await pacer.acquire('other', 'flash')
    const proAdmitted = vi.fn()
    const proPending = pacer.acquire('google', 'pro').then(proAdmitted)
    const starts: number[] = []
    const now = Date.now()
    const pending = [1, 2].map(() => pacer.acquire('google', 'flash').then(() => { starts.push(Date.now() - now) }))
    await vi.advanceTimersByTimeAsync(11_999)
    expect(starts).toEqual([])
    await vi.advanceTimersByTimeAsync(12_001)
    await Promise.all(pending)
    expect(starts).toEqual([12_000, 24_000])
    expect(proAdmitted).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(6000)
    await proPending
    expect(proAdmitted).toHaveBeenCalledOnce()
  })

  it('cancels waiting requests without consuming a reservation and ignores daily budgets', async () => {
    vi.useFakeTimers()
    const pacer = new RequestPacer()
    pacer.learn('google', 'daily', { daily: true, minute: true, requestsPerMinute: 1 })
    await pacer.acquire('google', 'daily')
    await pacer.acquire('google', 'daily')
    pacer.learn('google', 'flash', { daily: false, minute: true, requestsPerMinute: 1 })
    await pacer.acquire('google', 'flash')
    const controller = new AbortController()
    const cancelled = expect(pacer.acquire('google', 'flash', controller.signal)).rejects.toThrow()
    controller.abort()
    await cancelled
    const pending = pacer.acquire('google', 'flash')
    await vi.advanceTimersByTimeAsync(60_000)
    await pending
  })
})
