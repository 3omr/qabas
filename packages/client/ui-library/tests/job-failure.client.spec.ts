/** Real provider and transport failures have distinct meanings; daily quota wins over unavailable. */
import { describe, expect, it } from 'vitest'
import { jobFailureKind, nextQuotaReset, lectureStopReason } from '../src/client/job-failure.ts'
import { nextQuotaReset as accountsQuotaReset } from '../../ui-settings-transcriber-engine/src/client/quota.ts'

const exhausted = 'No eligible model available for provider "google". Exhausted or unavailable models: gemini-flash-latest, gemini-3.8-flash, gemini-3.7-flash, gemini-3.6-flash, gemini-3.5-flash, gemini-2.5-flash, gemini-2.5-pro. Wait until the provider\'s daily reset.'

describe('provider failure classification', () => {
  it.each([
    ['PI_AI_ERROR: Provider stopped with: PROHIBITED_CONTENT', 'blocked'],
    ['Provider stopped with: SAFETY', 'blocked'],
    ['Prompt was blocked: OTHER', 'blocked'],
    ['blocked-prompt finish', 'blocked'],
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

describe('student-owned lecture interruptions', () => {
  it.each([
    ['ECONNRESET', 'internet is disconnected'], ['ENOTFOUND api.google.com', 'internet is disconnected'],
    ['DNS failure', 'internet is disconnected'], ['agy not logged in', 'Antigravity is signed out'],
    ['NotebookLM sign-in expired', 'NotebookLM is signed out'], ['recording Orbit.mp3 not found', 'recording is missing'],
    ['429 daily quota exceeded', 'quota is used up, it renews at'],
    ['agy quota exhausted; resets in 2h 30m', 'quota is used up, it renews at'],
    ['agy quota exhausted', 'provider has not reported'],
  ])('%s has a resumable plain reason', (message, expected) => {
    expect(lectureStopReason(message, new Date('2026-10-04T06:00:00Z'))).toContain(expected)
  })
  it.each(['429 RESOURCE_EXHAUSTED per minute', '503 overloaded', 'timeout', 'TOOL_CALL_TRUNCATED', '403 SAFETY'])('%s remains internal recovery', (message) => {
    expect(lectureStopReason(message)).toBeUndefined()
  })
})


it('retries an unspecified 429 even when the agy wrapper names the writer', () => {
  expect(lectureStopReason('agy exited 1: HTTP 429 RESOURCE_EXHAUSTED quota exceeded')).toBeUndefined()
  expect(lectureStopReason('agy exited 1: HTTP 429 model quota exhausted')).toContain('the quota is used up')
})
