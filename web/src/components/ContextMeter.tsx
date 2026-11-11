import { cx } from "./ui"

export function formatTokens(n: number): string {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(2)}m`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

export function contextPct(tokens: number | null, window: number | null): number | null {
  return tokens !== null && window ? Math.min(100, Math.round((tokens / window) * 100)) : null
}

export function contextLabel(tokens: number | null, window: number | null): string {
  if (tokens === null) return "Context: not measured yet"
  return window ? `${formatTokens(tokens)} / ${formatTokens(window)} · ${contextPct(tokens, window)}%` : `${formatTokens(tokens)} tokens`
}

export const CONTEXT_HINT = "How much of this agent's context window is used."

/**
 * Said under a meter from 75%. The meter shows where auto-compact is off, and then nothing compacts before the CLI's own
 * last-resort compaction near the window's limit.
 */
export const CONTEXT_NEAR_FULL = "Nearly full. Auto-compact is off, so the CLI compacts only at the limit."

/** Context use only gets loud near the limit: amber from 75%, red from 90%. Below that it stays muted. */
export const CONTEXT_WARN_PCT = 75
export const CONTEXT_DANGER_PCT = 90

export function contextTone(pct: number | null): { bar: string; text: string } {
  if (pct !== null && pct >= CONTEXT_DANGER_PCT) return { bar: "bg-red-500", text: "text-red-300" }
  if (pct !== null && pct >= CONTEXT_WARN_PCT) return { bar: "bg-amber-400", text: "text-amber-300" }
  return { bar: "bg-zinc-500", text: "text-zinc-500" }
}

/**
 * A tiny bar and the percentage ("58%"). The full reading ("Context 576k / 1m · 58%") is the tooltip and
 * the accessible name. This is a passive reading.
 */
export function ContextMiniBar({ tokens, window, hint = CONTEXT_HINT, className }: { tokens: number | null; window: number | null; hint?: string; className?: string }) {
  const pct = contextPct(tokens, window)
  if (pct === null) return null
  const tone = contextTone(pct)
  const label = `Context ${contextLabel(tokens, window)}`
  return (
    <span title={`${label}. ${hint}`} className={cx("inline-flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap tabular-nums", tone.text, className)} data-testid="context-mini">
      <span aria-hidden className="block h-1.5 w-6 shrink-0 overflow-hidden rounded-full bg-zinc-800">
        <span className={cx("block h-full rounded-full", tone.bar)} style={{ width: `${Math.max(pct, 4)}%` }} />
      </span>
      {/* Room for "100%", so the width holds as the number grows. */}
      <span aria-hidden className="min-w-[4ch]">{pct}%</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}

/**
 * "Context 168k / 200k · 84%" over a bar, and the automatic compaction state. Sky while there's room, then the amber
 * and red of contextTone, on the words too, so a warning never looks like the calm state; from there a line says what
 * happens at the limit (`nearFull`).
 */
export function ContextMeter({
  tokens,
  window,
  compacting,
  queued,
  nearFull = CONTEXT_NEAR_FULL,
  className,
}: {
  tokens: number | null
  window: number | null
  compacting: boolean
  /** A compaction is waiting for the current turn to end. */
  queued: boolean
  /** What to say from 75%, while no compaction runs or waits. */
  nearFull?: string
  className?: string
}) {
  const pct = contextPct(tokens, window)
  const warn = pct !== null && pct >= CONTEXT_WARN_PCT
  const tone = contextTone(pct)
  const label = tokens === null ? contextLabel(tokens, window) : `Context ${contextLabel(tokens, window)}`
  const title = `${label}. ${CONTEXT_HINT}`
  return (
    <div className={cx("flex items-center gap-2 text-xs text-zinc-400", className)} data-testid="context-meter">
      <div className="min-w-0 flex-1" title={title}>
        <div className={cx("wrap-anywhere tabular-nums", warn && tone.text)}>{label}</div>
        {/* No bar without a reading: an unknown window is not an empty one. */}
        {pct !== null && (
          <div
            className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800"
            role="meter"
            aria-label="Context window used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-valuetext={label}
          >
            <div className={cx("h-full rounded-full", warn ? tone.bar : "bg-sky-500")} style={{ width: `${pct}%` }} />
          </div>
        )}
        {warn && !compacting && !queued && <p className="mt-1 text-zinc-400 wrap-anywhere" data-testid="context-near-full">{nearFull}</p>}
      </div>
      {(compacting || queued) && <span role="status" className="shrink-0 text-zinc-400">{compacting ? "Compacting…" : "Compact queued"}</span>}
    </div>
  )
}
