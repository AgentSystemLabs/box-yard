/** Calendar days in the reader's timezone, rather than 24-hour windows (which fail across DST). */
export function dayKey(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

export function dayLabel(at: number, now = Date.now()): string {
  if (dayKey(at) === dayKey(now)) return "Today"
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (dayKey(at) === dayKey(+yesterday)) return "Yesterday"
  return new Date(at).toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    ...(new Date(at).getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}),
  })
}
