import { describe, expect, it } from "vitest"
import { pct } from "../web/src/lib/usage"
import { axisMoney, labelledDays, localDayStarts, niceScale } from "../web/src/lib/usageChart"

describe("share helpers", () => {
  it("formats percentages", () => {
    expect(pct(1, 3)).toBe("33%")
    expect(pct(0.5, 10)).toBe("5.0%")
    expect(pct(0.0001, 10)).toBe("<0.1%")
    expect(pct(1, 0)).toBe("0%")
  })
})

describe("usage chart helpers", () => {
  const at = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h).getTime()

  it("starts each day at a local midnight, oldest first, ending today", () => {
    const days = localDayStarts(7, at(2026, 11, 5, 15))
    expect(days).toHaveLength(7)
    expect(days[0]).toBe(at(2026, 10, 30))
    expect(days.at(-1)).toBe(at(2026, 11, 5))
    for (const d of days) expect(new Date(d).getHours()).toBe(0)
  })

  it("ends the y-axis on a round number at or above the highest bar", () => {
    expect(niceScale(0)).toEqual({ top: 1, ticks: [0] })
    expect(niceScale(7.3)).toEqual({ top: 7.5, ticks: [0, 2.5, 5, 7.5] })
    expect(niceScale(9)).toEqual({ top: 10, ticks: [0, 5, 10] })
    const { top, ticks } = niceScale(123_456_789)
    expect(top).toBeGreaterThanOrEqual(123_456_789)
    expect(ticks.length).toBeGreaterThanOrEqual(3)
    expect(ticks.length).toBeLessThanOrEqual(5)
  })

  it("labels every day of a week, and about five days of longer ranges, always the last", () => {
    expect(labelledDays(7)).toEqual([0, 1, 2, 3, 4, 5, 6])
    for (const n of [30, 60, 90]) {
      const l = labelledDays(n)
      expect(l.at(-1)).toBe(n - 1)
      expect(l.length).toBeGreaterThanOrEqual(4)
      expect(l.length).toBeLessThanOrEqual(6)
    }
  })

  it("writes axis money short", () => {
    expect(axisMoney(0)).toBe("$0")
    expect(axisMoney(2.5)).toBe("$2.50")
    expect(axisMoney(40)).toBe("$40")
    expect(axisMoney(1200)).toBe("$1.2K")
  })
})
