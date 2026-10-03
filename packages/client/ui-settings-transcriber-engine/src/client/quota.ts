/**
 * When a free Gemini key's daily quota comes back.
 *
 * Google resets the per-day limits at midnight Pacific time. A student in
 * Cairo reads "midnight Pacific" as nothing at all; the same instant in their
 * own clock (10 in the morning for most of the year) is something they can
 * plan around, so the page states that instead.
 */

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

/**
 * The reset as a time of day on the student's own clock.
 * @param now - the current instant.
 * @param locale - the page's language.
 * @param timeZone - the student's zone; the browser's when omitted.
 * @returns e.g. "10:00 AM" or "١٠:٠٠ ص".
 */
export function quotaResetTime(now: Date, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    ...timeZone === undefined ? {} : { timeZone },
  }).format(nextQuotaReset(now))
}
