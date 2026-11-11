// The schedule form's helpers: the plain-word "Repeats" builder and its cron, the time zone picker's list, and the
// preview sentence. Only the form uses them, so they load with it (Schedules.tsx), not with the first screen.
import { isValidTimeZone, parseCron } from "../../../shared/cron"
import { scheduleWhen, zoneLabel, zoneTime } from "./scheduleText"

/**
 * The form's preview sentence: "Runs weekdays at 9:00 AM UTC". A cron the words can't read says so plainly
 * instead of repeating the expression the reader just typed.
 */
export function runsText(cron: string, tz: string, locale?: string): string {
  const source = parseCron(cron).source
  const words = scheduleWhen(cron, tz, locale)
  if (words.startsWith(source)) return `Runs on a custom timing, ${zoneTime(tz)}`
  return `Runs ${words.charAt(0).toLowerCase()}${words.slice(1)}`
}

/** How a schedule repeats in the form's plain-word builder. "custom" is a typed cron. */
export type RepeatKind = "15min" | "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom"

export const REPEAT_KINDS: { kind: RepeatKind; label: string }[] = [
  { kind: "15min", label: "Every 15 minutes" },
  { kind: "hourly", label: "Every hour" },
  { kind: "daily", label: "Every day" },
  { kind: "weekdays", label: "Weekdays" },
  { kind: "weekly", label: "Every week" },
  { kind: "monthly", label: "Every month" },
  { kind: "custom", label: "Custom (cron)" },
]

/** Sunday first, like cron's 0-6. The form shows them Monday first. */
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
export const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

/**
 * The builder's fields. Every part is kept while the kind changes, so going from "Every week" to "Every day" and
 * back doesn't lose the chosen days. `cron` is the typed expression, used only by "custom".
 */
export interface WhenParts {
  kind: RepeatKind
  hour: number
  minute: number
  /** 0-6, Sunday is 0. "Every week" runs on these. */
  weekdays: number[]
  /** 1-31. "Every month" runs on this day. */
  day: number
  cron: string
}

export const DEFAULT_WHEN: WhenParts = { kind: "weekdays", hour: 9, minute: 0, weekdays: [1], day: 1, cron: "0 9 * * 1-5" }

/** Whether this kind asks for a time of day. */
export const hasTime = (kind: RepeatKind) => kind === "daily" || kind === "weekdays" || kind === "weekly" || kind === "monthly"

/** The cron for the builder's fields. "custom" returns the typed text as is (it may be invalid). */
export function cronFromParts(p: WhenParts): string {
  const at = `${p.minute} ${p.hour}`
  switch (p.kind) {
    case "15min":
      return "*/15 * * * *"
    case "hourly":
      return "0 * * * *"
    case "daily":
      return `${at} * * *`
    case "weekdays":
      return `${at} * * 1-5`
    case "weekly":
      return `${at} * * ${[...new Set(p.weekdays)].sort((a, b) => a - b).join(",") || "1"}`
    case "monthly":
      return `${at} ${Math.min(31, Math.max(1, Math.round(p.day) || 1))} * *`
    case "custom":
      return p.cron
  }
}

const sameSet = (a: Set<number>, b: Set<number>) => a.size === b.size && [...a].every((n) => b.has(n))

/**
 * The builder's fields for a saved cron. A shape the builder can't make (two times a day, a month list, an invalid
 * expression) opens as "custom" with the text untouched, so editing a schedule never rewrites its timing by accident.
 */
export function partsFromCron(cron: string): WhenParts {
  const custom: WhenParts = { ...DEFAULT_WHEN, kind: "custom", cron: cron.trim() }
  let c: ReturnType<typeof parseCron>
  try {
    c = parseCron(cron)
  } catch {
    return custom
  }
  // With both day fields set, cron runs when either matches: not a shape the builder has.
  if (c.months.size !== 12 || (c.daysRestricted && c.weekdaysRestricted)) return custom
  const everyDay = c.days.size === 31
  const everyWeekday = c.weekdays.size === 7
  const base = { ...custom, cron: c.source }
  let parts: WhenParts | null = null
  if (c.hours.size === 24 && everyDay && everyWeekday) {
    if (sameSet(c.minutes, new Set([0, 15, 30, 45]))) parts = { ...base, kind: "15min" }
    else if (sameSet(c.minutes, new Set([0]))) parts = { ...base, kind: "hourly" }
  } else if (c.minutes.size === 1 && c.hours.size === 1) {
    const at = { ...base, hour: [...c.hours][0]!, minute: [...c.minutes][0]! }
    const weekdays = [...c.weekdays].sort((a, b) => a - b)
    if (everyDay && everyWeekday) parts = { ...at, kind: "daily" }
    else if (everyDay && weekdays.join() === "1,2,3,4,5") parts = { ...at, kind: "weekdays" }
    else if (everyDay) parts = { ...at, kind: "weekly", weekdays }
    else if (everyWeekday && c.days.size === 1) parts = { ...at, kind: "monthly", day: [...c.days][0]! }
  }
  if (!parts) return custom
  // Belt and braces: the builder's cron must run at exactly the same times as the saved one.
  const again = parseCron(cronFromParts(parts))
  const same =
    sameSet(again.minutes, c.minutes) && sameSet(again.hours, c.hours) && sameSet(again.days, c.days) && sameSet(again.months, c.months) && sameSet(again.weekdays, c.weekdays)
  return same ? parts : custom
}

/** "09:05" for an `<input type="time">`, and back. An emptied input keeps the time it had. */
export const timeValue = (p: Pick<WhenParts, "hour" | "minute">) => `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`
export function timeParts(value: string): Pick<WhenParts, "hour" | "minute"> | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(value)
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  return hour < 24 && minute < 60 ? { hour, minute } : null
}

/** Zones the form offers before "Other…": one or two per offset people actually schedule in. */
const COMMON_ZONES = [
  "UTC",
  "Pacific/Honolulu",
  "America/Anchorage",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Denver",
  "America/Chicago",
  "America/Mexico_City",
  "America/New_York",
  "America/Toronto",
  "America/Bogota",
  "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Lisbon",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "Europe/Rome",
  "Europe/Stockholm",
  "Europe/Warsaw",
  "Europe/Athens",
  "Europe/Istanbul",
  "Europe/Moscow",
  "Africa/Lagos",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Africa/Nairobi",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Bangkok",
  "Asia/Jakarta",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Manila",
  "Asia/Seoul",
  "Asia/Tokyo",
  "Australia/Perth",
  "Australia/Sydney",
  "Pacific/Auckland",
]

/** "GMT-5" for a zone right now, or "" where the browser can't say. */
function zoneOffset(tz: string, now: number): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(now)
    return parts.find((p) => p.type === "timeZoneName")?.value ?? ""
  } catch {
    return ""
  }
}

/** "New York (GMT-5)": a zone as the form's picker shows it. */
export function zoneOption(tz: string, now: number): { value: string; label: string } {
  const label = zoneLabel(tz)
  const offset = label === "UTC" ? "" : zoneOffset(tz, now)
  return { value: tz, label: offset ? `${label} (${offset})` : label }
}

/**
 * The picker's zones: `first` (the schedule's own zone, the default, the reader's) on top, then the common ones.
 * Invalid and repeated names drop out.
 */
export function zoneOptions(first: (string | null | undefined)[], now: number): { value: string; label: string }[] {
  const seen = new Set<string>()
  const out: { value: string; label: string }[] = []
  for (const tz of [...first, ...COMMON_ZONES]) {
    if (!tz || seen.has(tz) || !isValidTimeZone(tz)) continue
    seen.add(tz)
    out.push(zoneOption(tz, now))
  }
  return out
}
