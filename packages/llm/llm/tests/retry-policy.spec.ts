import { describe, expect, it } from 'vitest'
import {
  resolveRetryPolicy,
  RetryPolicySchema,
} from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

describe('provider retry policy', () => {
  it('resolves immutable normal defaults', () => {
    const policy = resolveRetryPolicy(undefined, 'provider.retryPolicy')

    expect(policy).toEqual({
      mode: 'normal',
      maxRetries: 5,
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'OVERLOADED', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    })
    expect(Object.isFrozen(policy)).toBe(true)
    if (policy.mode !== 'normal') throw new Error('expected normal policy')
    expect(Object.isFrozen(policy.retryableCodes)).toBe(true)
  })

  it('resolves and detaches a configured normal policy', () => {
    const retryableCodes = ['BUSY']
    const config: RetryPolicyConfig = {
      mode: 'normal',
      maxRetries: 4,
      retryableCodes,
      backoff: {
        initialDelayMs: 25,
        maxDelayMs: 100,
        jitterRatio: 0,
      },
    }

    const policy = resolveRetryPolicy(config, 'provider.retryPolicy')
    retryableCodes.push('LATE')

    expect(policy).toEqual({
      mode: 'normal',
      maxRetries: 4,
      retryableCodes: ['BUSY'],
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0,
    })
  })

  it('resolves always mode with default backoff', () => {
    expect(resolveRetryPolicy({ mode: 'always' }, 'provider.retryPolicy')).toEqual({
      mode: 'always',
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    })
    expect(RetryPolicySchema).toBeDefined()
  })

  it('inherits, validates, and detaches code-specific settings through the config schema', () => {
    const override = { maxRetries: 8, backoff: { maxDelayMs: 60_000 } }
    const config = RetryPolicySchema({
      mode: 'normal',
      backoff: { initialDelayMs: 3000, jitterRatio: 0 },
      codeOverrides: { OVERLOADED: override },
    })
    const policy = resolveRetryPolicy(config, 'provider.retryPolicy')
    override.backoff.maxDelayMs = 1
    expect(policy).toMatchObject({
      mode: 'normal',
      codeOverrides: { OVERLOADED: { maxRetries: 8, initialDelayMs: 3000, maxDelayMs: 60_000, jitterRatio: 0 } },
    })
    if (policy.mode !== 'normal') throw new Error('expected normal policy')
    expect(Object.isFrozen(policy.codeOverrides)).toBe(true)
    expect(Object.isFrozen(policy.codeOverrides?.OVERLOADED)).toBe(true)
    expect(resolveRetryPolicy({ mode: 'normal', maxRetries: 2, codeOverrides: { SERVER: {} } }, 'provider.retryPolicy'))
      .toMatchObject({ codeOverrides: { SERVER: { maxRetries: 2, initialDelayMs: 500, maxDelayMs: 10_000 } } })
  })

  it('ignores normal-only fields retained after switching to always mode', () => {
    const layered = {
      mode: 'always',
      maxRetries: 5,
      retryableCodes: ['SERVER'],
    } as unknown as RetryPolicyConfig

    expect(resolveRetryPolicy(layered, 'provider.retryPolicy')).toEqual({
      mode: 'always',
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    })
  })

  it.each([
    [{ mode: 'normal', maxRetries: -1 }, /maxRetries/],
    [{ mode: 'normal', maxRetries: 1.5 }, /maxRetries/],
    [{ mode: 'normal', maxRetries: Number.MAX_SAFE_INTEGER + 1 }, /maxRetries/],
    [{ mode: 'always', backoff: { initialDelayMs: 0 } }, /initialDelayMs/],
    [{ mode: 'normal', backoff: { maxDelayMs: Number.POSITIVE_INFINITY } }, /maxDelayMs/],
    [{ mode: 'normal', backoff: { initialDelayMs: MAX_TIMER_DELAY_MS + 1 } }, /initialDelayMs/],
    [{ mode: 'always', backoff: { maxDelayMs: MAX_TIMER_DELAY_MS + 1 } }, /maxDelayMs/],
    [{ mode: 'normal', backoff: { initialDelayMs: 20, maxDelayMs: 10 } }, /less than or equal/],
    [{ mode: 'always', backoff: { jitterRatio: 1.1 } }, /jitterRatio/],
    [{ mode: 'normal', unlimitedCodes: ['AUTH'] }, /unlimitedCodes/],
    [{ mode: 'normal', unlimitedCodes: ['RATE_LIMIT', 'RATE_LIMIT'] }, /unlimitedCodes/],
    [{ mode: 'normal', retryableCodes: [] }, /must not be empty/],
    [{ mode: 'normal', retryableCodes: ['SERVER', 'SERVER'] }, /duplicates/],
    [{ mode: 'normal', retryableCodes: [''] }, /non-empty strings/],
    [{ mode: 'normal', retryableCodes: [429] }, /non-empty strings/],
    [{ mode: 'normal', maxRetires: 1 }, /unknown key "maxRetires"/],
    [{ mode: 'normal', codeOverrides: { AUTH: {} } }, /finite member/],
    [{ mode: 'normal', unlimitedCodes: ['RATE_LIMIT'], codeOverrides: { RATE_LIMIT: {} } }, /finite member/],
    [{ mode: 'normal', codeOverrides: { SERVER: { maxRetries: -1 } } }, /maxRetries/],
    [{ mode: 'normal', codeOverrides: { SERVER: { maxRetires: 1 } } }, /unknown key/],
    [{ mode: 'normal', codeOverrides: { SERVER: { backoff: { maxDelayMs: 100 } } } }, /less than or equal/],
    [{ mode: 'normal', codeOverrides: { SERVER: { backoff: { initialDelay: 1 } } } }, /unknown key/],
    [{ mode: 'always', backoff: { initialDelay: 1 } }, /unknown key "initialDelay"/],
    [{ mode: 'sometimes' }, /mode must be "normal" or "always"/],
  ] as const)('rejects invalid policy %#', (config, message) => {
    expect(() => {
      resolveRetryPolicy(config as unknown as RetryPolicyConfig, 'provider.retryPolicy')
    }).toThrow(message)
  })
})
