// How a schedule reads on its card (web/src/lib/scheduleText.ts): plain-words cron with its zone, and the next run.
import { describe, expect, it } from "vitest"
import { clockTime, nextRunText, plannedRun, runDayTime, sameClock, scheduleWhen, untilText, zoneLabel } from "../web/src/lib/scheduleText.js"

const CHICAGO = "America/Chicago"
// Tuesday Nov 3 2026, 6:30 PM in Chicago (CST, UTC-6).
const now = Date.parse("2026-11-04T00:30:00Z")
const MIN = 60_000
const HOUR = 60 * MIN

describe("scheduleWhen", () => {
  it("reads the cron in plain words with the zone's city", () => {
    expect(scheduleWhen("0 2 * * *", CHICAGO, "en-US")).toBe("Every day at 2:00 AM Chicago")
    expect(scheduleWhen("0 9 * * 1-5", CHICAGO, "en-US")).toBe("Weekdays at 9:00 AM Chicago")
    expect(scheduleWhen("30 17 * * 5", "Europe/London", "en-US")).toBe("Every Friday at 5:30 PM London")
    expect(scheduleWhen("0 9,17 * * *", "Asia/Kolkata", "en-US")).toBe("Every day at 9:00 AM and 5:00 PM Kolkata")
  })
  it("follows the reader's clock", () => {
    expect(scheduleWhen("0 14 * * *", CHICAGO, "en-GB")).toBe("Every day at 14:00 Chicago")
  })
  it("leaves the zone off when no time of day is named", () => {
    expect(scheduleWhen("*/15 * * * *", CHICAGO, "en-US")).toBe("Every 15 minutes")
    expect(scheduleWhen("@hourly", CHICAGO, "en-US")).toBe("Every hour")
  })
  it("keeps a cron it can't put in words, with its zone", () => {
    expect(scheduleWhen("*/10 9-17 * * 1-5", CHICAGO, "en-US")).toBe("*/10 9-17 * * 1-5 (Chicago time)")
  })
  it("says what's wrong with a bad cron", () => {
    expect(scheduleWhen("61 * * * *", CHICAGO)).toMatch(/out of range/)
  })
})

describe("zoneLabel and clockTime", () => {
  it("names a zone by its city", () => {
    expect(zoneLabel("America/Chicago")).toBe("Chicago")
    expect(zoneLabel("America/Argentina/Buenos_Aires")).toBe("Buenos Aires")
    expect(zoneLabel("UTC")).toBe("UTC")
    expect(zoneLabel("Etc/UTC")).toBe("UTC")
  })
  it("reads a time of day with plain spaces", () => {
    expect(clockTime(0, 5, "en-US")).toBe("12:05 AM")
    expect(clockTime(13, 0, "en-US")).toBe("1:00 PM")
    expect(clockTime(13, 0, "de-DE")).toBe("13:00")
  })
})

describe("next run", () => {
  it("says today, tomorrow, a weekday this week, or the date", () => {
    expect(runDayTime(now + 30 * MIN, CHICAGO, now, "en-US")).toBe("Today 7:00 PM")
    expect(runDayTime(now + 7.5 * HOUR, CHICAGO, now, "en-US")).toBe("Tomorrow 2:00 AM")
    expect(runDayTime(now + 3 * 24 * HOUR, CHICAGO, now, "en-US")).toBe("Fri 6:30 PM")
    expect(runDayTime(now + 9 * 24 * HOUR, CHICAGO, now, "en-US")).toBe("Nov 12, 6:30 PM")
  })
  it("counts days in the schedule's zone, not UTC", () => {
    // 2:00 AM Wednesday in Chicago is already Wednesday in UTC; 11:00 PM Tuesday in Chicago is Wednesday in UTC.
    expect(runDayTime(now + 4.5 * HOUR, CHICAGO, now, "en-US")).toBe("Today 11:00 PM")
  })
  it("says how long until it", () => {
    expect(untilText(now + 20_000, now)).toBe("in under a minute")
    expect(untilText(now - 5 * MIN, now)).toBe("due now")
    expect(untilText(now + 24 * MIN, now)).toBe("in 24m")
    expect(untilText(now + 7.4 * HOUR, now)).toBe("in 7h")
    expect(untilText(now + 3 * 24 * HOUR, now)).toBe("in 3d")
  })
  it("adds the zone only when the reader's clock differs", () => {
    const at = now + 7.5 * HOUR
    expect(nextRunText(at, CHICAGO, now, { locale: "en-US", readerTz: CHICAGO })).toBe("Tomorrow 2:00 AM · in 8h")
    expect(nextRunText(at, CHICAGO, now, { locale: "en-US", readerTz: "Europe/Berlin" })).toBe("Tomorrow 2:00 AM Chicago · in 8h")
    expect(sameClock(at, CHICAGO, "US/Central")).toBe(true)
  })
  it("plans from the cron until the server has (just created or resumed), and not at all when paused", () => {
    const s = { enabled: true, nextRunAt: null, cron: "0 2 * * *", timezone: CHICAGO }
    expect(plannedRun(s, now)).toBe(Date.parse("2026-11-04T08:00:00Z"))
    expect(plannedRun({ ...s, nextRunAt: 123 }, now)).toBe(123)
    expect(plannedRun({ ...s, enabled: false, nextRunAt: 123 }, now)).toBeNull()
    expect(plannedRun({ ...s, cron: "0 0 30 2 *" }, now)).toBeNull()
  })
})
