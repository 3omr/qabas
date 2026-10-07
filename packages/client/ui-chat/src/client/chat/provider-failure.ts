/** Human summaries of provider codes and flattened JSON diagnostics; raw text stays in disclosures. */
import type { ChatViewSlotProps } from '../contract/slots.ts'

/** Presentation category independent of provider JSON nesting or message encoding. */
export type ProviderFailureKind = 'missing-key' | 'auth' | 'daily-quota' | 'quota' | 'model-unavailable' | 'google-minute' | 'rate-limit' | 'overloaded' | 'timeout' | 'unknown'

/**
 * Classify stable Harness codes and provider text without depending on one SDK error envelope.
 * @param failure - Client-projected failure fields.
 * @returns Actionable presentation category, or unknown for an unrecognized diagnostic.
 */
export function providerFailureKind(failure: { readonly message: string; readonly code?: unknown }): ProviderFailureKind {
  const { message, code } = failure
  if (code === 'MISSING_CREDENTIAL') return 'missing-key'
  if (code === 'AUTH' || code === 'INVALID_CREDENTIAL'
    || /api[_ ]key[_ ]invalid|api key.*(?:invalid|not valid)|unauthenticated|\b(?:401|403)\b/i.test(message)) return 'auth'
  if (/(?:requests?|tokens?|quota|limit)perday|daily[^\n]{0,40}(?:quota|limit)|(?:quota|limit|requests?)[^\n]{0,80}per[_ -]?day/i.test(message)) return 'daily-quota'
  if (code === 'OVERLOADED' || /\b503\b|high demand|overloaded/iu.test(message)) return 'overloaded'
  if (code === 'TIMEOUT') return 'timeout'
  if (code === 'MODEL_NOT_FOUND' || code === 'MODEL_UNAVAILABLE'
    || (/\bmodels?\b/i.test(message) && /no longer available|not (?:found|available|supported)|unavailable|retired|decommissioned/i.test(message))) return 'model-unavailable'
  if (/gemini|google|generativelanguage/i.test(message)
    && /free[_ -]?tier|free.*(?:limit|quota)/i.test(message)
    && /per[_ -]?minute|perminute|\brpm\b/i.test(message)) return 'google-minute'
  if (code === 'QUOTA' || code === 'QUOTA_EXCEEDED') return 'quota'
  if (code === 'RATE_LIMIT' || /\b429\b|rate.?limit|RESOURCE_EXHAUSTED/i.test(message)) return 'rate-limit'
  return 'unknown'
}

function assertNever(kind: never): never {
  throw new Error(`Unknown provider failure category: ${String(kind)}`)
}

/**
 * Localize guidance; automatic continuation is promised only for a scheduled retry node.
 * @param failure - Client-projected failure and whether its retry is currently scheduled.
 * @param t - Active Chat translator.
 * @returns One human summary, with diagnostics available separately.
 */
export function providerFailureMessage(
  failure: { readonly message: string; readonly code?: unknown; readonly retryScheduled?: boolean },
  t: ChatViewSlotProps['t'],
): string {
  const kind = providerFailureKind(failure)
  switch (kind) {
    case 'missing-key': return t('message.failure.missingCredential')
    case 'auth': return t('message.failure.auth')
    case 'quota': return t('message.failure.quota')
    case 'daily-quota': return t('message.failure.dailyQuota')
    case 'overloaded': return t(failure.retryScheduled === true ? 'message.failure.overloadedRetry' : 'message.failure.overloaded')
    case 'timeout': return t(failure.retryScheduled === true ? 'message.failure.timeoutRetry' : 'message.failure.timeout')
    case 'model-unavailable': return t('message.failure.modelUnavailable')
    case 'google-minute': return t(failure.retryScheduled === true ? 'message.failure.googleMinuteRetry' : 'message.failure.googleMinute')
    case 'rate-limit': return t(failure.retryScheduled === true ? 'message.failure.rateLimitRetry' : 'message.failure.rateLimit')
    case 'unknown': return t('message.failure.unknown')
    default: return assertNever(kind)
  }
}
