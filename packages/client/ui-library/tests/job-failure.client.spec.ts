/** Real provider and transport failures have distinct meanings; daily quota wins over unavailable. */
import { describe, expect, it } from 'vitest'
import { jobFailureKind, nextQuotaReset } from '../src/client/job-failure.ts'
import { nextQuotaReset as accountsQuotaReset } from '../../ui-settings-transcriber-engine/src/client/quota.ts'

const exhausted = 'No eligible model available for provider "google". Exhausted or unavailable models: gemini-flash-latest, gemini-3.8-flash, gemini-3.7-flash, gemini-3.6-flash, gemini-3.5-flash, gemini-2.5-flash, gemini-2.5-pro. Wait until the provider\'s daily reset.'

describe('provider failure classification', () => {
  it.each([
    [exhausted, 'daily-quota'],
    ['No eligible model: Exhausted models: gemini-3.8-flash. Service unavailable.', 'daily-quota'],
    ['DAILY_QUOTA_EXHAUSTED: Gemini unavailable until the daily reset', 'daily-quota'],
    ['429 RESOURCE_EXHAUSTED: GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'daily-quota'],
    ['403 PERMISSION_DENIED: API key not valid. API_KEY_INVALID', 'auth'],
    ['401 UNAUTHENTICATED: key unavailable', 'auth'],
    ['400 INVALID_ARGUMENT: Function call is missing a thought_signature in functionCall parts', 'signature'],
    ['404 NOT_FOUND: models/gemini-old is not found or unavailable for generateContent', 'model-unavailable'],
    ['MODEL_UNAVAILABLE: models/gemini-old has been retired', 'model-unavailable'],
    ['429 RESOURCE_EXHAUSTED: GenerateRequestsPerMinutePerProjectPerModel-FreeTier; unavailable until retry', 'rate-limit'],
    ['TOOL_CALL_TRUNCATED: tool input was an incomplete JSON segment at the output limit', 'cut-off'],
    ['TypeError: fetch failed: ECONNRESET; upstream temporarily unavailable', 'network'],
    ['Connection timed out while waiting for an unavailable endpoint', 'network'],
    ['503 UNAVAILABLE: The model is currently experiencing high demand. Please try again later.', 'busy'],
    ['Provider overloaded, retry later', 'busy'],
    ['The module could not be found in the selected workspace', 'unknown'],
  ] as const)('%s → %s', (message, kind) => {
    expect(jobFailureKind(message)).toBe(kind)
  })
})

describe('daily reset at midnight America/Los_Angeles', () => {
  it.each([
    ['2026-10-03T06:00:00Z', '2026-10-03T07:00:00.000Z'],
    ['2026-10-03T07:00:00Z', '2026-10-04T07:00:00.000Z'],
    ['2026-03-08T07:30:00Z', '2026-03-08T08:00:00.000Z'],
    ['2026-03-08T12:00:00Z', '2026-03-09T07:00:00.000Z'],
    ['2026-11-01T06:30:00Z', '2026-11-01T07:00:00.000Z'],
    ['2026-11-01T12:00:00Z', '2026-11-02T08:00:00.000Z'],
    ['2026-12-31T23:00:00Z', '2027-01-01T08:00:00.000Z'],
  ])('%s resets at %s', (now, expected) => {
    expect(nextQuotaReset(new Date(now)).toISOString()).toBe(expected)
    expect(accountsQuotaReset(new Date(now)).toISOString()).toBe(expected)
  })
})
