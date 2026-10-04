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

const offlineDiagnostic = new RegExp([
  String.raw`ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN`,
  String.raw`connection (?:refused|reset)|DNS (?:failure|failed)|name or service not known|temporary failure in name resolution`,
  String.raw`network (?:is )?(?:down|unreachable)|internet (?:is )?disconnected|\boffline\b|ConnectError`,
].join('|'), 'iu')

const dailyDiagnostic = new RegExp([
  String.raw`DAILY_QUOTA_EXHAUSTED|requestsperday`,
  String.raw`(?:quota|limit)[^\n]{0,60}(?:per[_ -]?day|perday)`,
  String.raw`(?:per[_ -]?day|perday|daily)[^\n]{0,60}(?:quota|limit|exhaust)`,
].join('|'), 'iu')

const spentDiagnostic = new RegExp([
  String.raw`quota[^\n]{0,40}(?:exhaust|used up|exceed)`,
  String.raw`(?:exhaust|used up|exceed)[^\n]{0,40}quota`,
  String.raw`usage limit (?:reached|exceeded)|credits[^\n]{0,30}exhaust`,
].join('|'), 'iu')

const signInDiagnostic = new RegExp([
  String.raw`signed out|sign[- ]?in (?:required|expired)|auth(?:entication)? (?:expired|unavailable|required)`,
  String.raw`unauthenticated|invalid[_ ]credentials|invalid[_ ]grant|login (?:required|expired)`,
  String.raw`not (?:logged|signed) in|(?:401|403)[^\n]{0,50}(?:auth|credential)|API[_ ]KEY[_ ]INVALID`,
].join('|'), 'iu')

const recordingDiagnostic = new RegExp([
  String.raw`(?:recording|audio(?: source)?)[^\n]{0,100}(?:missing|not found|does not exist)`,
  String.raw`no audio source[^\n]{0,100}matches`,
].join('|'), 'iu')

const resetInstant = new RegExp(
  String.raw`(?:reset|renew|refresh)[\s\S]{0,60}?` +
  String.raw`(\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d))`, 'iu',
)
const resetDuration = new RegExp(
  String.raw`(?:resets?|renews?|refresh(?:es)?|try again)\s+(?:in|after)\s+` +
  String.raw`((?:\d+(?:\.\d+)?\s*(?:days?|hours?|minutes?|seconds?|[dhms])\s*)+)`, 'iu',
)

/**
 * Normalize only student-owned lecture interruptions; timeouts and minute limits are repairable.
 * @param message - engine, transport or chat diagnostic.
 * @param now - current instant used for the Gemini API daily reset.
 * @returns a plain resumable reason, or undefined when automatic recovery must continue.
 */
export function lectureStopReason(message: string, now = new Date()): string | undefined {
  if (offlineDiagnostic.test(message)) {
    return 'the internet is disconnected'
  }
  const daily =
    dailyDiagnostic.test(message)
  const account = /agy|antigravity|Google account/iu.test(message)
  const spent =
    spentDiagnostic.test(message)
  const genericLimit = /\b429\b|RESOURCE_EXHAUSTED/iu.test(message)
  const accountLimit = /(?:account|model|plan) quota|quota (?:on|for) (?:this |the )?model|usage limit (?:reached|exceeded)/iu
    .test(message)
  if (daily || (account && spent && !/per[_ -]?minute|requestsperminute|\bRPM\b/iu.test(message)
    && (!genericLimit || accountLimit))) {
    const instant =
      resetInstant.exec(message)?.[1]
    const duration =
      resetDuration.exec(message)?.[1]
    const units: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 }
    const seconds = duration === undefined ? undefined : [...duration.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/giu)]
      .reduce((total, match) => total + Number(match[1]) * (units[match[2]?.[0]?.toLowerCase() ?? ''] ?? 0), 0)
    const reset = instant !== undefined ? new Date(instant)
      : seconds === undefined ? account ? undefined : nextQuotaReset(now)
        : new Date(now.getTime() + seconds * 1000)
    return reset === undefined || !Number.isFinite(reset.getTime())
      ? 'the quota is used up; the provider has not reported when it renews'
      : `the quota is used up, it renews at ${new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(reset)}`
  }
  if (signInDiagnostic.test(message)) {
    const provider = /nlm|NotebookLM/iu.test(message) ? 'NotebookLM' : account ? 'Antigravity' : 'Google'
    return `${provider} is signed out or its sign-in has expired; sign in again`
  }
  if (recordingDiagnostic.test(message)) {
    return 'the recording is missing; restore it and press Continue'
  }
  return undefined
}
