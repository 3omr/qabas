/** One authenticated Gemini catalog request, returning only credential-safe status. */
import type { GeminiKeyCheck } from './types.ts'

/**
 * Check a resolved key against Gemini's authenticated model catalog without generation.
 * @param key - current stored credential; it is sent only in Google's API-key header.
 * @param signal - bounded request lifetime, including response body consumption.
 * @param request - HTTP transport, replaceable by a fake fetch in tests.
 * @returns status without provider bodies, key values, URLs containing secrets or exception messages.
 */
export async function checkGeminiKey(key: string, signal: AbortSignal, request: typeof fetch): Promise<GeminiKeyCheck> {
  if (!/^[\x21-\x7e]+$/u.test(key)) return { status: 'invalid-key' }
  try {
    const response = await request('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
      method: 'GET', headers: { 'x-goog-api-key': key }, redirect: 'error', signal,
    })
    if (response.ok) {
      await response.body?.cancel()
      return { status: 'works' }
    }
    if (response.status === 429) {
      const body = await response.text()
      const limit = /DAILY_QUOTA_EXHAUSTED|per[_ -]?day|daily.{0,40}(?:quota|limit|reset)/iu.test(body)
        ? 'daily' : /per[_ -]?minute|perminute/iu.test(body) ? 'per-minute' : 'unknown'
      return { status: 'quota', limit }
    }
    await response.body?.cancel()
    return { status: response.status === 400 || response.status === 401 || response.status === 403 ? 'invalid-key' : 'network' }
  } catch {
    // Transport failures and aborted body reads never return exception text, which may contain the key.
    return { status: 'network' }
  }
}
