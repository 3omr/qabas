/**
 * Why a background job stopped, in a sentence a student can act on. The raw
 * provider text (nested JSON from Google, an SDK message) stays available
 * behind a disclosure; the card leads with what happened and what to do.
 */

/** The reasons a job stopped that the tray names. */
export type JobFailureKind =
  | 'daily-quota' | 'rate-limit' | 'busy' | 'model-unavailable' | 'signature'
  | 'cut-off' | 'auth' | 'network' | 'unknown'

/**
 * Classify a job's error text.
 * @param message - the error as the job recorded it.
 * @returns the kind the tray names.
 */
export function jobFailureKind(message: string): JobFailureKind {
  if (/DAILY_QUOTA_EXHAUSTED|per[_ -]?day|perday|daily[^\n]{0,40}(?:quota|limit)/iu.test(message)) return 'daily-quota'
  if (/\b(?:401|403)\b|api[_ ]key[_ ]invalid|unauthenticated|INVALID_CREDENTIAL/iu.test(message)) return 'auth'
  if (/thought_signature/iu.test(message)) return 'signature'
  if (/no longer available|model[^\n]{0,40}(?:not found|not supported|retired)|\b404\b/iu.test(message)) return 'model-unavailable'
  if (/\b503\b|high demand|UNAVAILABLE|overloaded/iu.test(message)) return 'busy'
  if (/\b429\b|RESOURCE_EXHAUSTED|rate.?limit|per[_ -]?minute/iu.test(message)) return 'rate-limit'
  if (/TOOL_CALL_TRUNCATED|incomplete json|output limit/iu.test(message)) return 'cut-off'
  if (/network|fetch failed|ECONN|socket|terminated|timed? ?out/iu.test(message)) return 'network'
  return 'unknown'
}
