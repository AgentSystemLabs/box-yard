/** Context-usage helpers shared by the orchestrator and the task runner path. */

export interface RawUsage {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens?: number
}

/**
 * Tokens in the context right now, from one assistant message's usage: the
 * prompt side of that API call (fresh + cache reads + cache writes) plus what
 * it just wrote, which will be part of the next prompt. The `result` message's
 * own `usage` sums every call in the turn, so it must not be used for this.
 */
export function contextTokens(u: RawUsage | null | undefined): number | null {
  if (!u) return null
  const n = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0)
  return n > 0 ? n : null
}

/** Window size from a `result` message's modelUsage, if the CLI reported one. */
export function contextWindowOf(modelUsage: Record<string, { contextWindow?: number }> | undefined | null): number | null {
  let best: number | null = null
  for (const v of Object.values(modelUsage ?? {})) if (typeof v?.contextWindow === "number" && v.contextWindow > (best ?? 0)) best = v.contextWindow
  return best
}

const UNIT: Record<string, number> = { "": 1, k: 1e3, m: 1e6 }
const parseAmount = (s: string) => {
  const m = /^([\d.]+)\s*([km]?)$/i.exec(s.trim())
  return m ? Math.round(Number(m[1]) * UNIT[m[2]!.toLowerCase()]!) : null
}

/** Parse `**Tokens:** 16.1k / 1m (2%)` from the output of `claude -p "/context"`. */
export function parseContextReport(text: string): { tokens: number; window: number } | null {
  const m = /Tokens:?\**\s*([\d.]+\s*[km]?)\s*\/\s*([\d.]+\s*[km]?)/i.exec(text)
  if (!m) return null
  const tokens = parseAmount(m[1]!)
  const window = parseAmount(m[2]!)
  return tokens !== null && window ? { tokens, window } : null
}

export function formatTokens(n: number): string {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(2)}m`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

/** Token counts in the four categories Box Yard keeps. */
export interface TokenUsage {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
}

/**
 * The session's running token totals from a CLI `result` message's modelUsage, summed over its models, or null when it
 * reported none. They count every call its total_cost_usd does (the main loop, compactions, subagents, sidechains);
 * the result's `usage` counts only the main loop's. Like total_cost_usd they're session running totals, so a run's
 * own tokens are the step from the session's previous report (Store.recordClaudeUsage), never the totals.
 */
export function sessionUsageOf(modelUsage: unknown): TokenUsage | null {
  if (!modelUsage || typeof modelUsage !== "object") return null
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0)
  const out: TokenUsage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }
  for (const m of Object.values(modelUsage as Record<string, Record<string, unknown> | null>)) {
    if (!m || typeof m !== "object") continue
    out.input_tokens += n(m.inputTokens)
    out.cache_creation_input_tokens += n(m.cacheCreationInputTokens)
    out.cache_read_input_tokens += n(m.cacheReadInputTokens)
    out.output_tokens += n(m.outputTokens)
  }
  return Object.values(out).some((v) => v > 0) ? out : null
}

/** Token counts from a CLI `result` message, or null when it reported none. */
export function resultUsageObject(u: unknown) {
  const x = u as Record<string, unknown> | null | undefined
  if (!x) return null
  const out = {
    input_tokens: typeof x.input_tokens === "number" ? x.input_tokens : 0,
    cache_creation_input_tokens: typeof x.cache_creation_input_tokens === "number" ? x.cache_creation_input_tokens : 0,
    cache_read_input_tokens: typeof x.cache_read_input_tokens === "number" ? x.cache_read_input_tokens : 0,
    output_tokens: typeof x.output_tokens === "number" ? x.output_tokens : 0,
  }
  return Object.values(out).some((n) => n > 0) ? out : null
}
