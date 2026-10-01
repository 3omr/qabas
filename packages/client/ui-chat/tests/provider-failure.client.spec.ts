/** Qabas production regressions: flattened Gemini JSON must produce actionable summaries. */
import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { dictionaries } from '../../locale-ar/src/client/locales.ts'
import { providerFailureKind, providerFailureMessage } from '../src/client/chat/provider-failure.ts'

const t = makeTranslate(dictionaries.chat ?? {}, dictionaries.common ?? {})
const minute = JSON.stringify({ error: {
  code: 429, status: 'RESOURCE_EXHAUSTED',
  message: 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20',
  details: [
    { violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
    { retryDelay: '19s' },
  ],
} })

describe('provider failure summaries', () => {
  it.each(['RATE_LIMIT', 'QUOTA', 'PI_AI_ERROR', undefined])('recognizes minute quota despite adapter code %s', (code) => {
    const failure = { message: minute, code }
    expect(providerFailureKind(failure)).toBe('google-minute')
    expect(providerFailureMessage({ ...failure, retryScheduled: true }, t)).toBe('جوجل طلبت نستنى شوية (الحد المجاني في الدقيقة). هيكمّل لوحده.')
    expect(providerFailureMessage(failure, t)).toBe('اتخطينا الحد المجاني دلوقتي، جرّب كمان دقيقة.')
  })

  it.each([
    [{ code: 'RATE_LIMIT', message: JSON.stringify({ error: { message: minute } }) }, 'google-minute'],
    [{ code: 'RATE_LIMIT', message: minute.replace('PerMinute', 'PerDay') }, 'daily-quota'],
    [{ code: 'PI_AI_ERROR', message: '404 models/gemini-2.5-flash is no longer available to new users' }, 'model-unavailable'],
    [{ message: 'models/gemini-2.5-flash is not found for API version v1beta' }, 'model-unavailable'],
    [{ message: '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}' }, 'auth'],
    [{ message: 'API_KEY_INVALID' }, 'auth'],
    [{ code: 'AUTH', message: '' }, 'auth'],
    [{ code: 'MISSING_CREDENTIAL', message: '' }, 'missing-key'],
    [{ code: 'MODEL_UNAVAILABLE', message: 'unrecognized format' }, 'model-unavailable'],
    [{ code: 'QUOTA', message: 'insufficient credits' }, 'quota'],
    [{ code: 'RATE_LIMIT', message: 'Too many requests' }, 'rate-limit'],
    [{ message: '429 Too many requests' }, 'rate-limit'],
    [{ message: '404 File not found' }, 'unknown'],
    [{ message: '{"broken":' }, 'unknown'],
  ])('classifies %j without assuming one provider envelope', (failure, category) => {
    expect(providerFailureKind(failure)).toBe(category)
  })

  it('uses daily and unavailable guidance without an automatic retry promise', () => {
    expect(providerFailureMessage({ message: minute.replace('PerMinute', 'PerDay'), retryScheduled: true }, t))
      .toBe('الحصة المجانية لليوم خلصت للموديل ده. جرّب موديل تاني أو استنى لبكرة.')
    expect(providerFailureMessage({ message: 'models/gemini-2.5-flash is no longer available to new users' }, t))
      .toBe('الموديل ده مش متاح، اختار موديل تاني من تحت.')
  })
})
