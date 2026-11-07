// Subscription limits per login (docs/limits.md, shared/loginLimits.ts). Each run that uses a login leaves a reading:
// Claude Code's `rate_limit_event` messages, and Codex's `rate_limits` from its rollout file at the end of a turn. A
// task's come through its runner's `limits` events (runner/box-runner.mjs); the Coordinator's, Captains' and side
// threads' straight from their stream. Readings are kept per login id and window, never with a credential's value.
import { createHash } from "node:crypto"
import { CLAUDE_CREDENTIAL_VARS } from "../shared/identities.js"
import {
  byWindowLength,
  claudeLimitReadings,
  codexLimitReadings,
  limitStateOf,
  windowLabel,
  type LimitHarness,
  type LimitLoginKind,
  type LimitReading,
  type LimitsReport,
  type LoginLimits,
  type LoginLimitState,
} from "../shared/loginLimits.js"
import { parseCodexAuth, isCodexAuth } from "./codex.js"
import type { LoginLimitRow, Store } from "./store.js"
import type { Hub } from "./hub.js"

/** The login a run used: its id and how to describe it. Never its value. */
export interface LoginRef {
  id: string
  harness: LimitHarness
  kind: LimitLoginKind
  /** Where it's configured: "Settings › Credentials", "Acme identity", "demo's env vars", "This computer". */
  source: string
  /** The same as a key: `settings`, `identity:<id>`, `project:<id>`, `local`, or `local:<machine>` for another computer's. */
  scope: string
  /** sha256, first 12 hex, like an identity's token fingerprints (tokenFingerprint); its first 8 are in the id. */
  fingerprint: string | null
}

/** A credential's fingerprint: sha256, first 12 hex. Tells two credentials apart; can't be turned back into one. */
export const loginFingerprint = (value: string) => createHash("sha256").update(value.trim()).digest("hex").slice(0, 12)

/** A computer's own login: `lgn_local-<harness>`, with the machine for another computer's (`local:<machine>`). */
function localLogin(harness: LimitHarness, source: string, scope: string): LoginRef {
  const where = scope.startsWith("local:") ? scope.slice("local:".length) : null
  return { id: where ? `lgn_local-${harness}-${where}` : `lgn_local-${harness}`, harness, kind: "local", source, scope: where ? scope : "local", fingerprint: null }
}

const CLAUDE_KINDS: Record<(typeof CLAUDE_CREDENTIAL_VARS)[number], LimitLoginKind> = {
  ANTHROPIC_AUTH_TOKEN: "auth_token",
  ANTHROPIC_API_KEY: "api_key",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth_token",
}

/**
 * The login a `claude` process with `env` uses: its strongest credential (Claude Code's own order), named by
 * `lgn_cred-claude-<fp8>` like Settings › Credentials' login in server/agentLogins.ts, or with none the computer's own
 * login (`lgn_local-claude`; `scope` names another computer).
 */
export function claudeLoginRef(env: Record<string, string | undefined>, source: string, scope: string): LoginRef {
  const k = CLAUDE_CREDENTIAL_VARS.find((v) => env[v]?.trim())
  if (!k) return localLogin("claude", source, scope)
  const fingerprint = loginFingerprint(env[k]!)
  return { id: `lgn_cred-claude-${fingerprint.slice(0, 8)}`, harness: "claude", kind: CLAUDE_KINDS[k], source, scope, fingerprint }
}

/**
 * The login a `codex` process uses: a ChatGPT login by its account (its tokens change on every refresh, the account
 * doesn't), an API key by its value, or the computer's own `codex login`.
 */
export function codexLoginRef(login: { kind: "chatgpt"; auth: string } | { kind: "api_key"; key: string } | null, source: string, scope: string): LoginRef {
  const value = !login ? null : login.kind === "api_key" ? login.key.trim() || null : codexAccount(login.auth)
  if (!login || !value) return localLogin("codex", source, scope)
  const fingerprint = loginFingerprint(value)
  return { id: `lgn_cred-codex-${fingerprint.slice(0, 8)}`, harness: "codex", kind: login.kind, source, scope, fingerprint }
}

/** A ChatGPT login file's account id, or null when it names none. */
function codexAccount(authJson: string): string | null {
  const auth = parseCodexAuth(authJson)
  return isCodexAuth(auth) ? auth.account : null
}

/** A run's report of its limits: a task runner's `limits` event, or a chat's `rate_limit_event` stream message. */
export function limitsOf(m: any, at = Date.now()): { plan: string | null; readings: LimitReading[] } | null {
  if (!m || typeof m !== "object") return null
  // CodexStream's (server/codex.ts) and the runner's Codex event carry the rollout file's rate_limits.
  const codex = m.codex_rate_limits ?? (m.harness === "codex" ? m.rateLimits : undefined)
  if (codex !== undefined) {
    const when = typeof m.at === "number" && m.at > 0 ? m.at : at
    const r = codexLimitReadings(codex, when)
    return r.readings.length ? r : null
  }
  const info = m.rate_limit_info ?? m.info
  const readings = claudeLimitReadings(info)
  return readings.length ? { plan: null, readings } : null
}

/**
 * Keep a run's readings for `login` and tell the web app when they change what it shows. Returns whether they did.
 * A reading of another harness's limits than the login's (a mix-up) is dropped.
 */
export function recordLimits(store: Pick<Store, "loginLimitRows" | "saveLoginLimit">, hub: Pick<Hub, "broadcast"> | null, login: LoginRef, report: { plan: string | null; readings: LimitReading[] } | null, at = Date.now()): boolean {
  if (!report?.readings.length) return false
  const before = new Map(store.loginLimitRows(login.id).map((r) => [r.limit_window, r]))
  let changed = false
  for (const w of report.readings) {
    const prev = before.get(w.window)
    const row: LoginLimitRow = {
      login_id: login.id,
      limit_window: w.window,
      harness: login.harness,
      kind: login.kind,
      source: login.source,
      scope: login.scope,
      fingerprint: login.fingerprint,
      plan: report.plan,
      minutes: w.minutes,
      used_pct: w.usedPct,
      resets_at: w.resetsAt,
      status: w.status,
      as_of: at,
    }
    if (prev && prev.as_of > at) continue
    store.saveLoginLimit(row)
    // What the page shows: a whole percent, the reset minute, the state and where the login is from.
    const shown = (r: Pick<LoginLimitRow, "used_pct" | "resets_at" | "status" | "source">) => `${r.used_pct === null ? "" : Math.round(r.used_pct)}|${r.resets_at === null ? "" : Math.round(r.resets_at / 60_000)}|${r.status ?? ""}|${r.source}`
    if (!prev || shown(prev) !== shown({ ...row, used_pct: row.used_pct ?? (prev.resets_at === row.resets_at ? prev.used_pct : null) })) changed = true
  }
  if (changed) hub?.broadcast({ type: "limits" })
  return changed
}

/** What a login picker needs to know about `loginId` (server/agentLogins.ts `setLimitSource`); null: no reading yet. */
export function limitState(store: Pick<Store, "loginLimitRows">, loginId: string, now = Date.now()): LoginLimitState | null {
  return limitStateOf(store.loginLimitRows(loginId).map(windowOf), now)
}

const windowOf = (r: LoginLimitRow) => ({
  window: r.limit_window,
  minutes: r.minutes,
  usedPct: r.used_pct,
  resetsAt: r.resets_at,
  status: r.status,
  asOf: r.as_of,
  label: windowLabel(r.harness, r.limit_window, r.minutes),
})

/** Every login's limits for GET /api/limits: Claude's first, then Codex's, each newest reading first. */
export function limitsReport(store: Pick<Store, "loginLimitRows">, now = Date.now()): LimitsReport {
  const byLogin = new Map<string, LoginLimitRow[]>()
  for (const r of store.loginLimitRows()) byLogin.set(r.login_id, [...(byLogin.get(r.login_id) ?? []), r])
  const logins: LoginLimits[] = []
  for (const [loginId, rows] of byLogin) {
    // The newest row says how the login is described now.
    const latest = rows.reduce((a, r) => (r.as_of > a.as_of ? r : a))
    const windows = rows.map(windowOf).sort(byWindowLength)
    logins.push({
      loginId,
      harness: latest.harness,
      kind: latest.kind,
      source: latest.source,
      scope: latest.scope,
      fingerprint: latest.fingerprint,
      plan: rows.find((r) => r.plan)?.plan ?? null,
      asOf: latest.as_of,
      windows,
      state: limitStateOf(windows, now)!,
    })
  }
  logins.sort((a, b) => (a.harness === b.harness ? b.asOf - a.asOf : a.harness === "claude" ? -1 : 1))
  return { logins, now }
}
