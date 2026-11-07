// How the UI says when something happened and how long it has run, in one place so every time reads the same way.
// Relative labels ("4m ago", "in 3h") are English like the rest of the copy; dates and clock times use the browser's
// locale and time zone. <TimeAgo> and <Elapsed> (components/ui.tsx) keep them live and show the exact time on a tap.
// Pure, so it is unit tested.

const DAY = 24 * 3600_000

/** Further than this either way, a relative label gives way to the date ("Oct 12"). */
export const DATE_AFTER_MS = 7 * DAY

/** Tests pin these; the app leaves them out, so the browser's own locale and time zone apply. */
export type Zone = { locale?: string; timeZone?: string }

/** A time Date and Intl can show (they throw past ±100 million days). */
const valid = (ts: number) => Number.isFinite(ts) && Math.abs(ts) <= 8.64e15

const formats = new Map<string, Intl.DateTimeFormat>()

/** Formatters are slow to make and a long thread shows hundreds of times, so each is made once. */
function format(options: Intl.DateTimeFormatOptions, zone: Zone = {}) {
  const key = JSON.stringify([zone.locale, zone.timeZone, options])
  let f = formats.get(key)
  if (!f) formats.set(key, (f = new Intl.DateTimeFormat(zone.locale, { ...options, timeZone: zone.timeZone })))
  return f
}

const sameYear = (ts: number, now: number, zone?: Zone) => format({ year: "numeric" }, zone).format(ts) === format({ year: "numeric" }, zone).format(now)

/** "Oct 12", or "Oct 12, 2025" in another year. */
export function shortDate(ts: number, now = Date.now(), zone?: Zone): string {
  if (!valid(ts)) return ""
  return format({ month: "short", day: "numeric", ...(sameYear(ts, now, zone) ? {} : { year: "numeric" }) }, zone).format(ts)
}

/**
 * "just now", "4m ago", "3h ago", "2d ago"; ahead of now "in <1m", "in 4m", "in 3h", "in 2d"; more than a week either
 * way, the date ("Oct 12").
 */
export function timeAgo(ts: number, now = Date.now(), zone?: Zone): string {
  const diff = now - ts
  if (Math.abs(diff) >= DATE_AFTER_MS) return shortDate(ts, now, zone)
  const ahead = diff < 0
  const s = Math.round(Math.abs(diff) / 1000)
  if (s < 45) return ahead ? "in <1m" : "just now"
  const m = Math.round(s / 60)
  const h = Math.round(m / 60)
  const span = m < 60 ? `${m}m` : h < 24 ? `${h}h` : `${Math.round(h / 24)}d`
  return ahead ? `in ${span}` : `${span} ago`
}

/** The exact moment, for a tooltip or a tap: "Tue, Nov 3, 2:05:09 PM GMT+1", with the year when it isn't this one. */
export function absoluteTime(ts: number, now = Date.now(), zone?: Zone): string {
  if (!valid(ts)) return ""
  const year = sameYear(ts, now, zone) ? {} : { year: "numeric" as const }
  return format({ weekday: "short", month: "short", day: "numeric", ...year, hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" }, zone).format(ts)
}

/**
 * Make the formatters every time label uses (its date, and the exact time in its tooltip). The first ones took 20 ms on
 * a phone, inside the tap that opened the first chat with a time in it, so the app makes them while the browser is idle.
 */
export function warmTimeFormats(now = Date.now()) {
  absoluteTime(now, now)
  shortDate(now, now)
}

/** How long something has run: "<1m", "12m", "1h 5m", "2d 3h". */
export function elapsedLabel(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return "<1m"
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

/** The `<time dateTime>` value, or undefined for a missing time. */
export const isoTime = (ts: number) => (valid(ts) ? new Date(ts).toISOString() : undefined)
