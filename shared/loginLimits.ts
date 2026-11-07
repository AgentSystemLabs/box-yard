// Subscription limits per login (docs/limits.md): how much of a Claude subscription's 5-hour and weekly windows, and
// of a Codex (ChatGPT) plan's, a login has used, and when each window resets. Nothing here is fetched: Claude Code
// reports a subscription's limits in its stream-json output (`rate_limit_event`) and Codex in its session's rollout
// file (`rate_limits` on each `token_count`), so each run that uses a login leaves a reading, kept with its time.

export type LimitHarness = "claude" | "codex"

/** allowed_warning is Claude Code's "close to the limit"; rejected: the window's limit is reached. */
export type LimitStatus = "allowed" | "warning" | "rejected"

/** One window of a login's limits, as a run last reported it. */
export interface LimitReading {
  /** Claude: five_hour, seven_day, seven_day_opus, seven_day_sonnet…; Codex: primary, secondary (`<limit>:primary`). */
  window: string
  /** The window's length, when known. */
  minutes: number | null
  /** 0–100 (it can pass 100 when usage runs past a cap). Null: the run named the window without a figure. */
  usedPct: number | null
  /** Epoch ms. */
  resetsAt: number | null
  status: LimitStatus | null
}

export interface LimitWindow extends LimitReading {
  label: string
  /** When this window's figures were reported (epoch ms). */
  asOf: number
}

/** What a login picker needs (server/agentLogins.ts `setLimitSource`): whether to skip the login, and until when. */
export interface LoginLimitState {
  /** A window still in effect has reached its limit. */
  atLimit: boolean
  /** The highest window still in effect, 0–100; null when no window's reading is current. */
  usedPct: number | null
  /** Epoch ms: when the binding window resets (at the limit: when the last full window does). */
  resetsAt: number | null
  /** The newest reading, epoch ms. */
  asOf: number
}

/** How a login logs in: an OAuth token (`claude setup-token`), an API key, a ChatGPT login, or a computer's own login. */
export type LimitLoginKind = "oauth_token" | "api_key" | "auth_token" | "chatgpt" | "local"

/** One login's limits, for the web app (GET /api/limits). */
export interface LoginLimits {
  /** The login's id (server/agentLogins.ts): `lgn_cred-claude-<fp8>`, `lgn_cred-codex-<fp8>`, `lgn_local-claude`… */
  loginId: string
  harness: LimitHarness
  kind: LimitLoginKind
  /** Where it's configured, e.g. "Settings › Credentials", "Acme identity", "demo's env vars", "This computer". */
  source: string
  /** The same as a key: `settings`, `identity:<id>`, `project:<id>`, `local` or `local:<machine>`. */
  scope: string
  /** The first 12 hex of the credential's sha256, like an identity's token fingerprints (null for a computer's own login). */
  fingerprint: string | null
  /** Codex's plan ("plus", "pro"…), when it reports one. */
  plan: string | null
  asOf: number
  windows: LimitWindow[]
  state: LoginLimitState
}

export interface LimitsReport {
  logins: LoginLimits[]
  /** The server's clock, so "resets in" doesn't drift with the browser's. */
  now: number
}

// ------------------------------------------------------------------ reading the CLIs' reports

const CLAUDE_WINDOWS: Record<string, number> = {
  five_hour: 300,
  seven_day: 7 * 1440,
  seven_day_opus: 7 * 1440,
  seven_day_sonnet: 7 * 1440,
  seven_day_overage_included: 7 * 1440,
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
/** Unix seconds → epoch ms. */
const secs = (v: unknown): number | null => {
  const n = num(v)
  return n !== null && n > 0 ? Math.round(n * 1000) : null
}
/** A 0–1 fraction as a percent, to a tenth (0.55 is 55, not 55.00000000000001). */
const percent = (u: number) => Math.max(0, Math.round(u * 1000) / 10)
const statusOf = (v: unknown): LimitStatus | null => (v === "allowed" ? "allowed" : v === "allowed_warning" ? "warning" : v === "rejected" ? "rejected" : null)

/**
 * The windows in a Claude Code `rate_limit_event`'s `rate_limit_info`: the window it's about (`rateLimitType`, with
 * `status`, `utilization` as a 0–1 fraction and `resetsAt` in unix seconds), and, when the CLI sends them, every
 * window's figures (`unifiedWindows`, from the API's anthropic-ratelimit-unified-* headers).
 */
export function claudeLimitReadings(info: unknown): LimitReading[] {
  const i = obj(info)
  if (!i) return []
  const out = new Map<string, LimitReading>()
  for (const [window, raw] of Object.entries(obj(i.unifiedWindows) ?? {})) {
    const w = obj(raw)
    if (!w || !(window in CLAUDE_WINDOWS)) continue
    const u = num(w.utilization)
    out.set(window, { window, minutes: CLAUDE_WINDOWS[window]!, usedPct: u === null ? null : percent(u), resetsAt: secs(w.resetsAt), status: null })
  }
  const status = statusOf(i.status)
  const type = typeof i.rateLimitType === "string" ? i.rateLimitType : null
  // A refusal that doesn't say which window still means the login can't run until it resets.
  const window = type && type in CLAUDE_WINDOWS ? type : !type && status === "rejected" ? "limit" : null
  if (window) {
    const prev = out.get(window)
    const u = num(i.utilization)
    out.set(window, {
      window,
      minutes: CLAUDE_WINDOWS[window] ?? null,
      usedPct: u !== null ? percent(u) : (prev?.usedPct ?? null),
      resetsAt: secs(i.resetsAt) ?? prev?.resetsAt ?? null,
      status,
    })
  }
  return [...out.values()]
}

/**
 * The windows in Codex's `rate_limits` (a rollout file's `token_count` event): `primary` (the short window, 5 hours on
 * ChatGPT plans) and `secondary` (weekly), each `{ used_percent, window_minutes, resets_at }` (unix seconds; older
 * Codex versions sent `resets_in_seconds`, counted from `at`). A second limit (`limit_id` other than "codex") keeps its
 * windows apart.
 */
export function codexLimitReadings(rateLimits: unknown, at: number): { plan: string | null; readings: LimitReading[] } {
  const r = obj(rateLimits)
  if (!r) return { plan: null, readings: [] }
  const id = typeof r.limit_id === "string" && r.limit_id.trim() && r.limit_id !== "codex" ? r.limit_id.trim() : null
  const readings: LimitReading[] = []
  for (const role of ["primary", "secondary"] as const) {
    const w = obj(r[role])
    if (!w) continue
    const usedPct = num(w.used_percent)
    const inSecs = num(w.resets_in_seconds)
    const resetsAt = secs(w.resets_at) ?? (inSecs !== null ? at + Math.round(inSecs * 1000) : null)
    if (usedPct === null && resetsAt === null) continue
    const minutes = num(w.window_minutes)
    readings.push({ window: id ? `${id}:${role}` : role, minutes: minutes && minutes > 0 ? minutes : null, usedPct: usedPct === null ? null : Math.max(0, usedPct), resetsAt, status: usedPct !== null && usedPct >= 100 ? "rejected" : null })
  }
  return { plan: typeof r.plan_type === "string" && r.plan_type.trim() ? r.plan_type.trim() : null, readings }
}

// ------------------------------------------------------------------ what a login's readings add up to

/** A reading with no reset time stops counting after this long. */
export const NO_RESET_STALE_MS = 6 * 60 * 60_000
/** Used this much (or a "close to the limit" from Claude Code): the meter turns amber. */
export const WARN_PCT = 80

/** The window is still the one the reading was about (it hasn't reset since). */
export function isCurrent(w: Pick<LimitWindow, "resetsAt" | "asOf">, now: number): boolean {
  return w.resetsAt !== null ? w.resetsAt > now : now - w.asOf < NO_RESET_STALE_MS
}

export function isFull(w: Pick<LimitWindow, "status" | "usedPct">): boolean {
  return w.status === "rejected" || (w.usedPct ?? 0) >= 100
}

/** The state of a login from its windows' last readings: windows that have reset since don't count. */
export function limitStateOf(windows: Pick<LimitWindow, "usedPct" | "resetsAt" | "status" | "asOf">[], now: number): LoginLimitState | null {
  if (!windows.length) return null
  const asOf = Math.max(...windows.map((w) => w.asOf))
  const live = windows.filter((w) => isCurrent(w, now))
  const full = live.filter(isFull)
  const known = live.filter((w) => w.usedPct !== null)
  const top = known.reduce<(typeof known)[number] | null>((a, w) => (a === null || w.usedPct! > a.usedPct! ? w : a), null)
  const resets = (ws: typeof live) => ws.reduce<number | null>((a, w) => (w.resetsAt !== null && (a === null || w.resetsAt > a) ? w.resetsAt : a), null)
  return {
    atLimit: full.length > 0,
    usedPct: full.length && !known.length ? 100 : top ? top.usedPct : null,
    resetsAt: full.length ? resets(full) : (top?.resetsAt ?? null),
    asOf,
  }
}

const CLAUDE_LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
  seven_day_overage_included: "Weekly · with extra usage",
  limit: "Usage limit",
}

/** "5-hour", "Weekly", "3-day", "90-minute". */
export function windowLength(minutes: number): string {
  if (minutes === 7 * 1440) return "Weekly"
  if (minutes === 1440) return "Daily"
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`
  if (minutes % 60 === 0) return `${minutes / 60}-hour`
  return `${minutes}-minute`
}

/** A window's name: "5-hour", "Weekly · Opus"; Codex's by its length, and its second limit's by that limit's id. */
export function windowLabel(harness: LimitHarness, window: string, minutes: number | null): string {
  if (harness === "claude") return CLAUDE_LABELS[window] ?? window.replace(/_/g, " ")
  const [limit, role] = window.includes(":") ? [window.slice(0, window.lastIndexOf(":")), window.slice(window.lastIndexOf(":") + 1)] : [null, window]
  const base = minutes ? windowLength(minutes) : role === "primary" ? "Short window" : "Long window"
  return limit ? `${base} · ${limit}` : base
}

/** Shortest windows first, so 5-hour comes before weekly. */
export function byWindowLength(a: Pick<LimitWindow, "minutes" | "window">, b: Pick<LimitWindow, "minutes" | "window">): number {
  return (a.minutes ?? Infinity) - (b.minutes ?? Infinity) || a.window.localeCompare(b.window)
}
