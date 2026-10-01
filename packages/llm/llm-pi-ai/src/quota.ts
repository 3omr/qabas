/** Provider quota periods, request budgets, and minimum retry waits from flattened pi-ai errors. */

/** Quota facts that survive pi-ai's error-message serialization. */
export interface QuotaFacts {
  daily: boolean
  minute: boolean
  requestsPerMinute?: number
  retryAfterMs?: number
}

function recordsIn(body: unknown): Record<string, unknown>[] {
  if (typeof body !== 'object' || body === null) return []
  if (Array.isArray(body)) return body.flatMap(recordsIn)
  const record = body as Record<string, unknown>
  return [record, ...Object.values(record).flatMap(recordsIn)]
}

function jsonBody(message: string): unknown {
  const start = message.indexOf('{')
  const end = message.lastIndexOf('}')
  if (start < 0 || end < start) return undefined
  try {
    return JSON.parse(message.slice(start, end + 1)) as unknown
  } catch (error) {
    // Provider diagnostics need not contain valid JSON; only syntax errors are ignored.
    if (!(error instanceof SyntaxError)) throw error
    return undefined
  }
}

/**
 * Parse HTTP Retry-After delta seconds or an HTTP date.
 * @param header - response header value when pi-ai exposes it.
 * @param now - response receipt time in milliseconds since the epoch.
 * @returns a positive finite delay, or undefined for absent, expired, or invalid headers.
 */
export function retryAfterMs(header: string | undefined, now = Date.now()): number | undefined {
  if (header === undefined) return undefined
  const seconds = /^\s*\d+(?:\.\d+)?\s*$/.test(header) ? Number(header) : undefined
  const delay = seconds === undefined ? Date.parse(header) - now : seconds * 1000
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

/**
 * Read Google's quota violations and RetryInfo plus human-readable retry instructions.
 * Daily violations take precedence when both daily and minute quotas are present.
 * Only request-count quotas supply RPM; token-count quotas never become request budgets.
 * @param message - pi-ai diagnostic including the provider JSON body, when available.
 * @returns quota periods, the lowest positive request budget, and the longest minimum wait.
 */
export function quotaFacts(message: string): QuotaFacts {
  const records = recordsIn(jsonBody(message))
  const quotaIds = records.flatMap(record => typeof record.quotaId === 'string' ? [record.quotaId] : [])
  const daily = quotaIds.some(id => /per[\s_-]*day/i.test(id))
    || /per[\s_-]*day|daily.{0,30}(?:quota|limit)|(?:quota|limit).{0,30}daily/i.test(message)
  const minute = quotaIds.some(id => /per[\s_-]*minute/i.test(id)) || /per[\s_-]*minute/i.test(message)
  const budgets = records.flatMap((record) => {
    if (typeof record.quotaId !== 'string' || !/requests.*per[\s_-]*minute/i.test(record.quotaId)) return []
    const budget = Number(record.quotaValue)
    return Number.isSafeInteger(budget) && budget > 0 ? [budget] : []
  })
  const delays = [...message.matchAll(/(?:"retryDelay"\s*:\s*"|please\s+retry\s+in\s+)(\d+(?:\.\d+)?)s/gi)]
    .map(match => Number(match[1]) * 1000)
  const header = /retry-after["']?\s*:\s*["']?([^"'\r\n}]+)/i.exec(message)?.[1]
  const headerDelay = retryAfterMs(header)
  if (headerDelay !== undefined) delays.push(headerDelay)
  const delay = Math.max(0, ...delays.filter(Number.isFinite))
  return {
    daily,
    minute,
    ...budgets.length === 0 ? {} : { requestsPerMinute: Math.min(...budgets) },
    ...delay > 0 ? { retryAfterMs: delay } : {},
  }
}
