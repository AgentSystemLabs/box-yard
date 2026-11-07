// The one way the UI says when (lib/time.ts): relative labels that also count forward and turn into a date past a
// week, and the exact time in the reader's own locale and time zone.
import { describe, expect, it, vi } from "vitest"
import { absoluteTime, elapsedLabel, isoTime, shortDate, timeAgo, warmTimeFormats } from "../web/src/lib/time.js"

const now = Date.UTC(2026, 10, 3, 13, 5, 9) // Tue, Nov 3, 2026, 1:05:09 PM UTC
const utc = { locale: "en-US", timeZone: "UTC" }
const min = 60_000
const hour = 60 * min
const day = 24 * hour

describe("timeAgo", () => {
  it("says how long ago in minutes, hours and days", () => {
    expect(timeAgo(now, now)).toBe("just now")
    expect(timeAgo(now - 44_000, now)).toBe("just now")
    expect(timeAgo(now - 45_000, now)).toBe("1m ago")
    expect(timeAgo(now - 12 * min, now)).toBe("12m ago")
    expect(timeAgo(now - 59 * min, now)).toBe("59m ago")
    expect(timeAgo(now - 60 * min, now)).toBe("1h ago")
    expect(timeAgo(now - 23 * hour, now)).toBe("23h ago")
    expect(timeAgo(now - 2 * day, now)).toBe("2d ago")
    expect(timeAgo(now - 6 * day, now)).toBe("6d ago")
  })

  it("counts forward for a time still to come, instead of saying it just happened", () => {
    expect(timeAgo(now + 10_000, now)).toBe("in <1m")
    expect(timeAgo(now + 5 * min, now)).toBe("in 5m")
    expect(timeAgo(now + 3 * hour, now)).toBe("in 3h")
    expect(timeAgo(now + 2 * day, now)).toBe("in 2d")
  })

  it("gives the date once it is a week or more away either way, with the year only when it isn't this one", () => {
    expect(timeAgo(now - 7 * day, now, utc)).toBe("Oct 27")
    expect(timeAgo(now - 45 * day, now, utc)).toBe("Sep 19")
    expect(timeAgo(now + 20 * day, now, utc)).toBe("Nov 23")
    expect(timeAgo(Date.UTC(2025, 9, 12, 9), now, utc)).toBe("Oct 12, 2025")
    expect(shortDate(Date.UTC(2025, 9, 12, 9), now, { locale: "de-DE", timeZone: "Europe/Berlin" })).toBe("12. Okt. 2025")
  })
})

describe("absoluteTime", () => {
  it("is the exact moment with its time zone, in the reader's locale", () => {
    expect(absoluteTime(now, now, utc)).toBe("Tue, Nov 3, 1:05:09 PM UTC")
    expect(absoluteTime(now, now, { locale: "en-US", timeZone: "Europe/Berlin" })).toBe("Tue, Nov 3, 2:05:09 PM GMT+1")
    expect(absoluteTime(now, now, { locale: "de-DE", timeZone: "Europe/Berlin" })).toBe("Di., 3. Nov., 14:05:09 MEZ")
  })

  it("adds the year when it isn't this year, in the reader's time zone", () => {
    expect(absoluteTime(Date.UTC(2025, 9, 12, 9, 30), now, utc)).toBe("Sun, Oct 12, 2025, 9:30:00 AM UTC")
    // 11 PM on Dec 31 in UTC is already next year in Tokyo.
    const eve = Date.UTC(2026, 11, 31, 23)
    expect(absoluteTime(eve, now, utc)).toBe("Thu, Dec 31, 11:00:00 PM UTC")
    expect(absoluteTime(eve, now, { locale: "en-US", timeZone: "Asia/Tokyo" })).toBe("Fri, Jan 1, 2027, 8:00:00 AM GMT+9")
  })

  it("is empty for a time Date can't show, rather than throwing", () => {
    expect(absoluteTime(Number.NaN, now)).toBe("")
    expect(absoluteTime(1e20, now)).toBe("")
    expect(isoTime(Number.NaN)).toBeUndefined()
    expect(isoTime(now)).toBe("2026-11-03T13:05:09.000Z")
  })
})

describe("warmTimeFormats", () => {
  it("makes the formatters a time label uses, so the first label shown makes none", () => {
    // In the browser's own locale and time zone, as the app shows them; mid-year, so a week back is this year too.
    const today = Date.UTC(2026, 5, 15, 12)
    warmTimeFormats(today)
    const made = vi.spyOn(Intl, "DateTimeFormat")
    try {
      expect(absoluteTime(today - hour, today)).not.toBe("")
      expect(timeAgo(today - 8 * day, today)).not.toBe("")
      expect(made).not.toHaveBeenCalled()
    } finally {
      made.mockRestore()
    }
  })
})

describe("elapsedLabel", () => {
  it("is how long something has run, never negative", () => {
    expect(elapsedLabel(-5)).toBe("<1m")
    expect(elapsedLabel(12 * min)).toBe("12m")
    expect(elapsedLabel(65 * min)).toBe("1h 5m")
    expect(elapsedLabel(2 * day + 3 * hour)).toBe("2d 3h")
  })
})
