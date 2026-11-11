// How a schedule reads on its card: the cron in plain words with its time zone ("Every day at 2:00 AM Chicago"),
// and when it runs next ("Tomorrow 2:00 AM · in 7h"). Times are read in the schedule's own zone, like its cron.
import { describeCron, nextRun, parseCron } from "../../../shared/cron"
import type { Schedule } from "../../../shared/types"

const formats = new Map<string, Intl.DateTimeFormat>()
function format(locale: string | undefined, options: Intl.DateTimeFormatOptions) {
  const key = `${locale ?? ""}|${JSON.stringify(options)}`
  let f = formats.get(key)
  if (!f) formats.set(key, (f = new Intl.DateTimeFormat(locale, options)))
  return f
}

/** Some ICU versions put a narrow no-break space before AM/PM; plain spaces wrap and copy better. */
const plainSpaces = (text: string) => text.replace(/[  ]/g, " ")

/** "Chicago" for America/Chicago, "Buenos Aires" for America/Argentina/Buenos_Aires, "UTC" for Etc/UTC. */
export function zoneLabel(tz: string): string {
  if (/^(Etc\/)?(UTC|UCT|GMT|Zulu|Universal)$/i.test(tz)) return "UTC"
  return (tz.split("/").pop() || tz).replace(/_/g, " ")
}

/** A time of day in the reader's clock: "2:00 AM" in en-US, "02:00" where 24-hour time is the norm. */
export function clockTime(hour: number, minute: number, locale?: string): string {
  return plainSpaces(format(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(Date.UTC(2000, 0, 1, hour, minute)))
}

/** "Chicago time" for America/Chicago, plain "UTC" for UTC: the zone as it reads after "Cron 0 2 * * * in". */
export function zoneTime(tz: string): string {
  const label = zoneLabel(tz)
  return label === "UTC" ? label : `${label} time`
}

/**
 * The cron in plain words with its zone: "Every day at 2:00 AM Chicago". The zone only shows when the words name a
 * time of day ("Every 15 minutes" is the same everywhere). A shape describeCron can't read stays a cron, with its zone.
 */
export function scheduleWhen(cron: string, tz: string, locale?: string): string {
  let source: string
  try {
    source = parseCron(cron).source
  } catch (err) {
    return (err as Error).message
  }
  let clock = false
  const words = describeCron(cron, {
    time: (hour, minute) => {
      clock = true
      return clockTime(hour, minute, locale)
    },
  })
  if (clock) return `${words} ${zoneLabel(tz)}`
  if (words === source) return `${source} (${zoneLabel(tz)} time)`
  // "Every 6 hours at :00" is just "Every 6 hours".
  return words.replace(/^(Every \d+ hours) at :00$/, "$1")
}

/** Days since the epoch of `ts`'s calendar date in `tz`, so two times can be compared by day. */
function dayNumber(ts: number, tz: string): number {
  const parts = format("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(ts)
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000
}

/** "Today 2:00 AM", "Tomorrow 9:00 AM", "Yesterday 9:00 AM", "Tue 9:00 AM" (this week), else "Nov 12, 9:00 AM": `ts` read in `tz`. */
export function runDayTime(ts: number, tz: string, now: number, locale?: string): string {
  const time = plainSpaces(format(locale, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(ts))
  const days = dayNumber(ts, tz) - dayNumber(now, tz)
  if (days === 0) return `Today ${time}`
  if (days === 1) return `Tomorrow ${time}`
  if (days === -1) return `Yesterday ${time}`
  if (days > 1 && days < 7) return `${format(locale, { timeZone: tz, weekday: "short" }).format(ts)} ${time}`
  return `${format(locale, { timeZone: tz, month: "short", day: "numeric" }).format(ts)}, ${time}`
}

/** "in 7h": how long until `ts`, as short as the card's other times. */
export function untilText(ts: number, now: number): string {
  const s = Math.round((ts - now) / 1000)
  if (s < 60) return s < 0 ? "due now" : "in under a minute"
  const m = Math.round(s / 60)
  if (m < 60) return `in ${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `in ${h}h`
  return `in ${Math.round(h / 24)}d`
}

/** The reader's own zone shows the same wall clock as `tz` at `ts` (so "2:00 AM" needs no zone after it). */
export function sameClock(ts: number, tz: string, readerTz = Intl.DateTimeFormat().resolvedOptions().timeZone): boolean {
  const options: Intl.DateTimeFormatOptions = { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }
  return format("en-US", { ...options, timeZone: tz }).format(ts) === format("en-US", { ...options, timeZone: readerTz }).format(ts)
}

/**
 * When an enabled schedule runs next: the server's plan, or (just created or resumed, before the server answers)
 * the cron's own next time. Null when paused, or when no date ever matches (Feb 30).
 */
export function plannedRun(s: Pick<Schedule, "enabled" | "nextRunAt" | "cron" | "timezone">, now: number): number | null {
  if (!s.enabled) return null
  if (s.nextRunAt !== null) return s.nextRunAt
  try {
    return nextRun(s.cron, now, s.timezone)
  } catch {
    return null
  }
}

/** "Tomorrow 2:00 AM · in 7h", with the zone when the reader's clock differs ("Tomorrow 2:00 AM Chicago · in 7h"). */
export function nextRunText(ts: number, tz: string, now: number, opts: { locale?: string; readerTz?: string } = {}): string {
  const at = runDayTime(ts, tz, now, opts.locale)
  return `${sameClock(ts, tz, opts.readerTz) ? at : `${at} ${zoneLabel(tz)}`} · ${untilText(ts, now)}`
}
