// Small pure helpers for the Usage modal's charts (components/UsageModal.tsx).

// The server warms the same days (Store.warmUsageLedger).
export { localDayStarts } from "../../../shared/usageLedger"

/** A y-axis that ends on a round number above `max`, with three or four steps of 1, 2, 2.5 or 5 × 10ⁿ. */
export function niceScale(max: number): { top: number; ticks: number[] } {
  if (!(max > 0)) return { top: 1, ticks: [0] }
  const raw = max / 3
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!
  const top = Math.ceil(max / step - 1e-9) * step
  const ticks: number[] = []
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(Number(t.toPrecision(12)))
  return { top, ticks }
}

/** Which days get an x-axis label: every day for a week, else about five spread across, the last one always. */
export function labelledDays(n: number): number[] {
  if (n <= 7) return Array.from({ length: n }, (_, i) => i)
  const step = Math.ceil(n / 5)
  const out: number[] = []
  for (let i = n - 1; i >= 0; i -= step) out.unshift(i)
  return out
}

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })
/** "72.4M", "1.2K", "830". */
export const compact = (n: number) => COMPACT.format(Math.round(n))

// Made once: toLocaleDateString makes a formatter every call.
const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short" })
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" })
const LONG_DAY = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" })

/** "Nov 3"; "Mon" too for a week's chart. */
export const dayLabel = (t: number, weekday = false) => (weekday ? WEEKDAY : DAY).format(t)

/** "Mon, Nov 3". */
export const longDayLabel = (t: number) => LONG_DAY.format(t)

/** Axis money: "$0", "$2.50", "$40", "$1.2K". */
export function axisMoney(n: number) {
  if (n === 0) return "$0"
  if (n >= 1000) return `$${COMPACT.format(n)}`
  if (n < 10 && !Number.isInteger(n)) return `$${n.toFixed(2)}`
  return `$${Math.round(n)}`
}
