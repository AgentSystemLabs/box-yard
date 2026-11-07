// One formatter per precision: toLocaleString makes a new one every call, which the Usage modal's thousands of figures felt.
const MONEY = new Map<number, Intl.NumberFormat>()

export function money(n: number | null | undefined, digits = 2) {
  const v = Number(n ?? 0)
  if (v > 0 && v < 0.01) return "<$0.01"
  let format = MONEY.get(digits)
  if (!format) MONEY.set(digits, (format = new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })))
  return `$${format.format(v)}`
}

export function hours(ms: number | null | undefined) {
  return `${((ms ?? 0) / 3_600_000).toFixed(2)}h`
}

export function bytes(n: number | null | undefined) {
  if (!n) return "unknown"
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

/** Percent of the total, one decimal under 10%. */
export function pct(part: number, total: number) {
  if (!(total > 0) || !(part > 0)) return "0%"
  const p = (part / total) * 100
  if (p > 0 && p < 0.1) return "<0.1%"
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`
}
