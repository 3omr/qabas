/**
 * Why a background job stopped, in a sentence a student can act on. The raw
 * provider text (nested JSON from Google, an SDK message) stays available
 * behind a disclosure; the card leads with what happened and what to do.
 */

/** The reasons a job stopped that the tray names. */
export type JobFailureKind =
  | 'daily-quota' | 'rate-limit' | 'busy' | 'model-unavailable' | 'signature'
  | 'blocked' | 'cut-off' | 'auth' | 'network' | 'unknown'

/**
 * Classify a job's error text.
 * @param message - the error as the job recorded it.
 * @returns the kind the tray names.
 */
export function jobFailureKind(message: string): JobFailureKind {
  if (/PROHIBITED_CONTENT|\bSAFETY\b|blocked[_ -]?prompt|prompt[^\n]{0,40}blocked|promptFeedback[^\n]{0,80}blockReason/iu.test(message)) return 'blocked'
  if (/DAILY_QUOTA_EXHAUSTED|per[_ -]?day|perday|daily[^\n]{0,40}(?:quota|limit|reset)|exhausted[^\n]{0,80}\bmodels\b/iu.test(message)) return 'daily-quota'
  if (/\b(?:401|403)\b|api[_ ]key[_ ]invalid|unauthenticated|INVALID_CREDENTIAL/iu.test(message)) return 'auth'
  if (/thought_signature/iu.test(message)) return 'signature'
  if (/MODEL_UNAVAILABLE|no longer available|model[^\n]{0,40}(?:not found|not supported|retired)|\b404\b/iu.test(message)) return 'model-unavailable'
  if (/\b429\b|RESOURCE_EXHAUSTED|rate.?limit|per[_ -]?minute/iu.test(message)) return 'rate-limit'
  if (/TOOL_CALL_TRUNCATED|incomplete json|output limit/iu.test(message)) return 'cut-off'
  if (/network|fetch failed|ECONN|socket|terminated|timed? ?out/iu.test(message)) return 'network'
  if (/\b503\b|high demand|\bUNAVAILABLE\b|overloaded/iu.test(message)) return 'busy'
  return 'unknown'
}

// Keep this calculation aligned with ui-settings-transcriber-engine/src/client/quota.ts.
// Sharing it across these UI plugins requires an additional utility dependency.
const PACIFIC = 'America/Los_Angeles'

/**
 * Pacific's offset from UTC at an instant, in minutes (-420 or -480).
 * @param at - the instant.
 * @returns minutes to add to UTC to get Pacific wall time.
 */
function pacificOffset(at: Date): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC, timeZoneName: 'shortOffset' })
    .formatToParts(at)
    .find(part => part.type === 'timeZoneName')?.value ?? 'GMT-8'
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/u.exec(name)
  if (match === null) return -480
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0)
  return match[1] === '-' ? -minutes : minutes
}

/**
 * The next instant the daily quota resets: the coming midnight in Pacific time.
 * @param now - the current instant.
 * @returns the reset instant.
 */
export function nextQuotaReset(now: Date): Date {
  const offset = pacificOffset(now)
  const wall = new Date(now.getTime() + offset * 60_000)
  const midnightWall = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1)
  // The offset at midnight itself can differ on the two nights a year the
  // clocks change; measure it there.
  const guess = new Date(midnightWall - offset * 60_000)
  return new Date(midnightWall - pacificOffset(guess) * 60_000)
}
