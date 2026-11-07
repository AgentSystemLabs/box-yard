import { z } from "zod"
import type { DB } from "./db.js"
import type { CodexLogin, CredentialStore } from "./credentials.js"
import { credentialValue } from "./credentials.js"
import { codexAuthSecrets, isCodexAuth, isRefreshOf, parseCodexAuth } from "./codex.js"
import { tokenFingerprint, type SecretBox } from "./identity/secretBox.js"
import { BadRequestError, NotFoundError, newId } from "./store.js"
import { CLAUDE_CREDENTIAL_VARS } from "../shared/identities.js"
import { CREDENTIALS_LOGIN_PREFIX, LOGIN_HARNESSES, LOGIN_LABEL_MAX, isCredentialsLogin, loginName, type AgentLogin, type AgentLoginKind, type AgentLoginState, type LoginHarness, type TurnLogin } from "../shared/agentLogins.js"
import type { LoginLimitState } from "../shared/loginLimits.js"
import { loginFingerprint, type LoginRef } from "./loginLimits.js"

export type { LoginLimitState }

/** The login a turn runs on, with what it logs in with (server-side only: never in an API response or a log). */
export interface PickedLogin extends TurnLogin {
  harness: LoginHarness
  kind: AgentLoginKind
  /** sha256 of its value (a ChatGPT login: of its account), first 12 hex. */
  fingerprint: string
  /** A Claude login, or a Codex API key, as env vars. */
  env: Record<string, string>
  /** A Codex ChatGPT login: the auth.json to hand the turn. */
  auth: string | null
  /** "kept": its session's own login; "next": the next one round robin; "only": there's just one; "fallback": every login is limited or failing, so it's tried anyway. */
  why: "kept" | "next" | "only" | "fallback"
}

/** What a turn's failure says about its login. */
export type LoginFailure = { kind: "limit"; until: number } | { kind: "auth" }

/**
 * How long a Claude session keeps its login once it stops: while Claude's prompt cache for it is still warm (up to an
 * hour), a resume on the same account reads its context from the cache; on another account it pays for all of it again.
 */
export const CLAUDE_STICKY_MS = 60 * 60_000
/** How long a login whose limit didn't say when it resets sits out. */
export const LIMIT_FALLBACK_MS = 60 * 60_000
/** A rate limit (HTTP 429) without a usage limit: a short pause. */
export const RATE_LIMIT_MS = 5 * 60_000

const CRED_PREFIX = CREDENTIALS_LOGIN_PREFIX
/** Settings › Credentials' login's id: the one server/loginLimits.ts files its limit readings under (claudeLoginRef, codexLoginRef). */
const credentialsId = (harness: LoginHarness, value: string) => `${CRED_PREFIX}${harness}-${loginFingerprint(value).slice(0, 8)}`
const CURSOR_KV = (h: LoginHarness) => `login_rr:${h}`

interface LoginRow {
  id: string
  harness: LoginHarness
  label: string
  kind: AgentLoginKind
  ciphertext: string
  fingerprint: string
  last4: string
  position: number
  created_at: number
  removed_at: number | null
}

interface StatusRow {
  login_id: string
  state: AgentLoginState
  until: number | null
  reason: string | null
  label: string | null
  last4: string | null
  last_used_at: number | null
  check_json: string | null
}

/** One login of a rotation, with its value (when this server can read it). */
interface Member {
  id: string
  harness: LoginHarness
  label: string
  kind: AgentLoginKind
  last4: string
  fingerprint: string
  source: "credentials" | "added"
  value: string | null
  createdAt: number
}

/** POST /api/logins. */
export const loginInput = z
  .object({
    harness: z.enum(LOGIN_HARNESSES),
    label: z.string().trim().min(1, "Give it a name, like Work Max").max(LOGIN_LABEL_MAX),
    value: z.string().trim().min(1, "Paste the login").max(50_000),
  })
  .strict()

/** PATCH /api/logins/:id. */
export const loginPatch = z.object({ label: z.string().trim().min(1).max(LOGIN_LABEL_MAX) }).strict()

/**
 * Agent logins (docs/logins.md): the Claude and Codex subscription logins new work is spread across, round robin, so
 * no one subscription meets its limits first. Each harness's Settings › Credentials login leads its rotation; Cody adds
 * the rest here. Values are encrypted like identity secrets (SecretBox) and leave only as a turn's login (pick) or for
 * redact() (secretValues): list() carries a label, the last 4 characters and a fingerprint.
 */
export class AgentLogins {
  private readonly listeners = new Set<() => void>()
  private secretCache: string[] | null = null
  private limitSource: (loginId: string) => LoginLimitState | null = () => null

  constructor(
    private readonly d: {
      db: DB
      secrets: SecretBox
      /** Settings › Credentials: each harness's first login. */
      credentials: Pick<CredentialStore, "claudeEnv" | "codexLogin" | "adoptCodexAuth" | "onChange">
      /** Test a login with the same CLI agents run (setup.ts claudeLoginCheck / codexLoginCheck). */
      check: {
        claude: (env: Record<string, string>) => Promise<{ ok: boolean; text: string }>
        codex: (login: CodexLogin) => Promise<{ ok: boolean; text: string; refreshed: string | null }>
      }
      /** Hides secrets in a CLI's error text before it's kept (stateReason, lastCheck). */
      redact?: (text: string) => string
      /** Deletes what a removed login left on disk: an added Codex login's refreshed auth.json. */
      forget?: (login: { id: string; harness: LoginHarness }) => void
      now?: () => number
    },
  ) {
    d.credentials.onChange(() => this.changed())
  }

  private now() {
    return this.d.now?.() ?? Date.now()
  }

  private redact(text: string) {
    return (this.d.redact ?? ((t) => t))(text).slice(0, 300)
  }

  // ---------- the rotation ----------

  /** Settings › Credentials' login for `harness` as a rotation member, or null when it has none. */
  private credentialsMember(harness: LoginHarness): Member | null {
    if (harness === "claude") {
      const env = this.d.credentials.claudeEnv()
      // Claude Code's own order: the strongest credential is the one it logs in with.
      const k = CLAUDE_CREDENTIAL_VARS.find((v) => env[v])
      if (!k) return null
      const value = env[k]!
      const fingerprint = tokenFingerprint(value)
      const kind: AgentLoginKind = k === "CLAUDE_CODE_OAUTH_TOKEN" ? "oauth_token" : "api_key"
      return { id: credentialsId(harness, value), harness, label: "Credentials", kind, last4: value.slice(-4), fingerprint, source: "credentials", value, createdAt: 0 }
    }
    let login: CodexLogin | null = null
    try {
      login = this.d.credentials.codexLogin()
    } catch {
      // A broken CODEX_AUTH_FILE: no Credentials login, and never another account's.
      return null
    }
    if (!login) return null
    const account = login.kind === "chatgpt" ? accountOf(login.auth) : null
    const value = login.kind === "chatgpt" ? login.auth : login.key
    const fingerprint = tokenFingerprint(account ?? value)
    return {
      id: credentialsId(harness, account ?? value),
      harness,
      label: "Credentials",
      kind: login.kind,
      last4: (account ?? value).slice(-4),
      fingerprint,
      source: "credentials",
      value,
      createdAt: 0,
    }
  }

  private rows(harness?: LoginHarness): LoginRow[] {
    const sql = `SELECT * FROM agent_logins WHERE removed_at IS NULL${harness ? " AND harness = ?" : ""} ORDER BY position, created_at`
    return (harness ? this.d.db.prepare(sql).all(harness) : this.d.db.prepare(sql).all()) as LoginRow[]
  }

  /** A rotation in order: Settings › Credentials' login, then the added ones (one per account). */
  private members(harness: LoginHarness): Member[] {
    const first = this.credentialsMember(harness)
    const added = this.rows(harness)
      .filter((r) => r.fingerprint !== first?.fingerprint)
      .map((r): Member => ({ id: r.id, harness, label: r.label, kind: r.kind, last4: r.last4, fingerprint: r.fingerprint, source: "added", value: this.d.secrets.open(r.ciphertext), createdAt: r.created_at }))
    return first ? [first, ...added] : added
  }

  private status(id: string): StatusRow | null {
    return (this.d.db.prepare("SELECT * FROM agent_login_status WHERE login_id = ?").get(id) as StatusRow | undefined) ?? null
  }

  /** Why the rotation skips `m` now, or null when it may take work. */
  private skipReason(m: Member, now = this.now()): string | null {
    if (!m.value) return "this server's secret key can't read it"
    const s = this.status(m.id)
    if (s?.state === "auth_failed") return s.reason ?? "it was signed out"
    if (s?.state === "limited" && (s.until ?? Infinity) > now) return s.reason ?? "it's at its usage limit"
    const limit = this.limitSource(m.id)
    if (limit?.atLimit && (limit.resetsAt == null || limit.resetsAt > now)) return "it's at its usage limit"
    return null
  }

  /** Whether `harness` has a login to run with: Settings › Credentials' or an added one. */
  has(harness: LoginHarness): boolean {
    return this.members(harness).some((m) => m.value)
  }

  /** Whether a login other than `except` may take work now: a retry has somewhere to go. */
  hasUsable(harness: LoginHarness, except: string): boolean {
    const now = this.now()
    return this.members(harness).some((m) => m.id !== except && this.skipReason(m, now) === null)
  }

  /** Whether `harness` has more than Settings › Credentials' login: then turns rotate. */
  rotates(harness: LoginHarness): boolean {
    return this.members(harness).filter((m) => m.value).length > 1
  }

  /**
   * The login a turn of `holder` (a task, the Coordinator, a Captain) runs on, or null when `harness` has none. A
   * resumed session keeps its own login while it can: a Claude session that comes back while its prompt cache is warm
   * (CLAUDE_STICKY_MS), a Codex session always (its saved turns may only open on the account that wrote them). Anything
   * else takes the next login round robin, skipping ones that are signed out, failing or at their limit, and `avoid`
   * (a retry's failed login). When every login is skipped, the next one is tried anyway ("fallback").
   */
  pick(o: { harness: LoginHarness; holder: string; resume: boolean; avoid?: string[] }): PickedLogin | null {
    const members = this.members(o.harness).filter((m) => m.value)
    if (!members.length) return null
    const now = this.now()
    const avoid = new Set(o.avoid ?? [])
    const usable = (m: Member) => !avoid.has(m.id) && this.skipReason(m, now) === null
    let chosen: Member | null = null
    let why: PickedLogin["why"] = "next"
    const held = this.holdOf(o.holder, o.harness)
    if (o.resume && held) {
      const own = members.find((m) => m.id === held.loginId)
      if (own && usable(own) && (o.harness === "codex" || now - held.usedAt < CLAUDE_STICKY_MS)) {
        chosen = own
        why = "kept"
      }
    }
    if (!chosen && members.length === 1) {
      chosen = members[0]!
      why = "only"
    }
    if (!chosen) {
      const last = this.d.db.prepare("SELECT value FROM kv WHERE key = ?").get(CURSOR_KV(o.harness)) as { value: string } | undefined
      const start = Math.max(0, members.findIndex((m) => m.id === last?.value) + 1)
      const order = [...members.slice(start), ...members.slice(0, start)]
      chosen = order.find(usable) ?? null
      if (!chosen) {
        why = "fallback"
        chosen = order.find((m) => !avoid.has(m.id)) ?? order[0]!
      }
      this.setKv(CURSOR_KV(o.harness), chosen.id)
    }
    this.use(o.holder, o.harness, chosen, now)
    return this.picked(chosen, why)
  }

  /**
   * The login a check (Docker's key check, the model list) or a one-off run with no session would use, without moving
   * the rotation: the first one that may take work, else the first.
   */
  representative(harness: LoginHarness): PickedLogin | null {
    const members = this.members(harness).filter((m) => m.value)
    const m = members.find((x) => this.skipReason(x) === null) ?? members[0]
    return m ? this.picked(m, members.length === 1 ? "only" : "next") : null
  }

  /**
   * The login `holder`'s chat runs on now, for a side thread that forks it: the one it holds while it may take work,
   * else the first that may. It doesn't move the rotation.
   */
  heldBy(holder: string, harness: LoginHarness): PickedLogin | null {
    const held = this.holdOf(holder, harness)
    const own = held ? this.members(harness).find((m) => m.id === held.loginId && m.value) : undefined
    return own && this.skipReason(own) === null ? this.picked(own, "kept") : this.representative(harness)
  }

  private picked(m: Member, why: PickedLogin["why"]): PickedLogin {
    const value = m.value!
    const env: Record<string, string> =
      m.harness === "claude" ? { [m.kind === "oauth_token" ? "CLAUDE_CODE_OAUTH_TOKEN" : (this.credentialsVar() ?? "ANTHROPIC_API_KEY")]: value } : m.kind === "api_key" ? { CODEX_API_KEY: value } : {}
    return { id: m.id, harness: m.harness, label: m.label, last4: m.last4, kind: m.kind, fingerprint: m.fingerprint, env, auth: m.harness === "codex" && m.kind === "chatgpt" ? value : null, why }
  }

  /** Which var Settings › Credentials' Claude login is (it may be ANTHROPIC_AUTH_TOKEN-shaped in a later build). */
  private credentialsVar(): string | null {
    const env = this.d.credentials.claudeEnv()
    return CLAUDE_CREDENTIAL_VARS.find((v) => env[v]) ?? null
  }

  private holdOf(holder: string, harness: LoginHarness): { loginId: string; usedAt: number } | null {
    const r = this.d.db.prepare("SELECT login_id, used_at FROM agent_login_holds WHERE holder = ? AND harness = ?").get(holder, harness) as { login_id: string; used_at: number } | undefined
    return r ? { loginId: r.login_id, usedAt: r.used_at } : null
  }

  private use(holder: string, harness: LoginHarness, m: Member, now: number) {
    this.d.db
      .prepare("INSERT INTO agent_login_holds (holder, harness, login_id, used_at) VALUES (?, ?, ?, ?) ON CONFLICT(holder, harness) DO UPDATE SET login_id = excluded.login_id, used_at = excluded.used_at")
      .run(holder, harness, m.id, now)
    // Its name as it ran, so its turns keep naming it after Settings › Credentials changes.
    this.upsertStatus(m.id, { last_used_at: now, label: m.label, last4: m.last4 })
  }

  /** A chat's run on `login` ended (`ok`: it worked): its session keeps the login a while, and a working one is back in the rotation. */
  ran(login: Pick<PickedLogin, "id" | "harness">, holder: string, ok: boolean) {
    this.touch(holder, login.harness)
    if (ok) this.reportSuccess(login.id)
  }

  /** A turn of `holder` ended: its session stays on its login until CLAUDE_STICKY_MS from now. */
  touch(holder: string, harness: LoginHarness) {
    this.d.db.prepare("UPDATE agent_login_holds SET used_at = ? WHERE holder = ? AND harness = ?").run(this.now(), holder, harness)
  }

  /** `holder` is gone (a deleted task): forget its login. */
  release(holder: string) {
    this.d.db.prepare("DELETE FROM agent_login_holds WHERE holder = ?").run(holder)
  }

  // ---------- what turns report ----------

  /**
   * A turn on `id` failed with `text`: when that's its usage limit or a refused login, the rotation skips it (until the
   * limit resets; until a Test or a turn on it works) and the answer says which, so the turn can retry on another.
   */
  reportFailure(id: string, harness: LoginHarness, text: string): LoginFailure | null {
    const failure = classifyLoginFailure(harness, text, this.now())
    if (!failure) return null
    const reason = this.redact(firstLine(text))
    if (failure.kind === "limit") this.upsertStatus(id, { state: "limited", until: failure.until, reason })
    else this.upsertStatus(id, { state: "auth_failed", until: null, reason })
    this.changed()
    return failure
  }

  /** A turn on `id` worked: it's back in the rotation if it was out. */
  reportSuccess(id: string) {
    const s = this.status(id)
    if (!s || s.state === "ok") return
    this.upsertStatus(id, { state: "ok", until: null, reason: null })
    this.changed()
  }

  /** The usage-limit tracker read `id` at its limit until `resetsAt` (null: until it reads otherwise). */
  markLimited(id: string, resetsAt: number | null, reason = "it's at its usage limit") {
    this.upsertStatus(id, { state: "limited", until: resetsAt ?? this.now() + LIMIT_FALLBACK_MS, reason })
    this.changed()
  }

  /** Where the picker reads logins' usage limits (the usage-limit tracker); without one it goes by turns' errors alone. */
  setLimitSource(fn: (loginId: string) => LoginLimitState | null) {
    this.limitSource = fn
  }

  private upsertStatus(id: string, patch: Partial<Omit<StatusRow, "login_id">>) {
    const cur: StatusRow = this.status(id) ?? { login_id: id, state: "ok", until: null, reason: null, label: null, last4: null, last_used_at: null, check_json: null }
    const next = { ...cur, ...patch }
    this.d.db
      .prepare(
        `INSERT INTO agent_login_status (login_id, state, until, reason, label, last4, last_used_at, check_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(login_id) DO UPDATE SET state = excluded.state, until = excluded.until, reason = excluded.reason, label = excluded.label, last4 = excluded.last4,
           last_used_at = excluded.last_used_at, check_json = excluded.check_json, updated_at = excluded.updated_at`,
      )
      .run(id, next.state, next.until, next.reason, next.label, next.last4, next.last_used_at, next.check_json, this.now())
  }

  /**
   * Keep `text` (an auth.json a Codex run refreshed) as login `id`'s when it's that account's, refreshed later: Codex
   * rotates the refresh token, so the one saved is spent. Settings › Credentials' own goes back there.
   */
  adoptCodexAuth(id: string, text: string): boolean {
    if (id.startsWith(`${CRED_PREFIX}codex-`)) return this.d.credentials.adoptCodexAuth(text)
    const row = this.d.db.prepare("SELECT * FROM agent_logins WHERE id = ? AND harness = 'codex' AND removed_at IS NULL").get(id) as LoginRow | undefined
    const current = row ? this.d.secrets.open(row.ciphertext) : null
    const next = parseCodexAuth(text.trim())
    if (!row || !current || !isCodexAuth(next) || !isRefreshOf(current, next.text)) return false
    this.d.db.prepare("UPDATE agent_logins SET ciphertext = ?, updated_at = ? WHERE id = ?").run(this.d.secrets.seal(next.text), this.now(), id)
    this.secretCache = null
    return true
  }

  /**
   * A Codex chat on this server (codexChatLaunch) logged in with `login`: its file or key, and the copy Codex refreshed
   * back to it.
   */
  codexCredentials(login: PickedLogin): Pick<CredentialStore, "codexLogin" | "adoptCodexAuth"> {
    return {
      codexLogin: () => (login.auth ? { kind: "chatgpt", auth: login.auth } : login.env.CODEX_API_KEY ? { kind: "api_key", key: login.env.CODEX_API_KEY } : null),
      adoptCodexAuth: (text) => this.adoptCodexAuth(login.id, text),
    }
  }

  // ---------- Settings ----------

  /** Every login, Settings › Credentials' first, as the browser sees them: never a value. */
  list(harness?: LoginHarness): AgentLogin[] {
    const harnesses = harness ? [harness] : LOGIN_HARNESSES
    const out: AgentLogin[] = []
    for (const h of harnesses) {
      const first = this.credentialsMember(h)
      if (first) out.push(this.view(first))
      for (const r of this.rows(h)) out.push(this.view({ id: r.id, harness: h, label: r.label, kind: r.kind, last4: r.last4, fingerprint: r.fingerprint, source: "added", value: this.d.secrets.open(r.ciphertext), createdAt: r.created_at }))
    }
    return out
  }

  private view(m: Member): AgentLogin {
    const s = this.status(m.id)
    const now = this.now()
    const limited = s?.state === "limited" && (s.until ?? Infinity) > now
    const tracked = this.limitSource(m.id)
    const trackedLimit = tracked?.atLimit && (tracked.resetsAt == null || tracked.resetsAt > now)
    const state: AgentLoginState = s?.state === "auth_failed" ? "auth_failed" : limited || trackedLimit ? "limited" : "ok"
    return {
      id: m.id,
      harness: m.harness,
      label: m.label,
      kind: m.kind,
      last4: m.last4,
      fingerprint: m.fingerprint,
      source: m.source,
      readable: m.value !== null,
      state,
      limitedUntil: state !== "limited" ? null : limited ? (s!.until ?? null) : (tracked?.resetsAt ?? null),
      stateReason: state === "ok" ? null : s?.state !== "ok" && s?.reason ? s.reason : "it's at its usage limit",
      lastUsedAt: s?.last_used_at ?? null,
      lastCheck: parseCheck(s?.check_json ?? null),
      createdAt: m.createdAt,
    }
  }

  /** An added login as its limit readings are filed (rotationLoginRef), removed ones too; null for any other id. */
  refOf(id: string): LoginRef | null {
    const r = this.d.db.prepare("SELECT id, harness, label, kind, last4, fingerprint FROM agent_logins WHERE id = ?").get(id) as Omit<LoginRow, "ciphertext" | "position" | "created_at"> | undefined
    // A removed login gave its fingerprint up for its id.
    return r ? rotationLoginRef({ ...r, fingerprint: r.fingerprint === r.id ? null : r.fingerprint }) : null
  }

  /** A turn's login, as turn timings and usage name it: removed ones too, so old turns keep their name. */
  nameOf(id: string): TurnLogin | null {
    const r = this.d.db.prepare("SELECT id, label, last4 FROM agent_logins WHERE id = ?").get(id) as TurnLogin | undefined
    if (r) return { id: r.id, label: r.label, last4: r.last4 }
    const s = this.status(id)
    return s?.label ? { id, label: s.label, last4: s.last4 ?? "" } : null
  }

  /** A login that's in a rotation now (Settings › Credentials' or an added one), with its value; undefined when there's none. */
  private member(id: string): Member | undefined {
    for (const h of LOGIN_HARNESSES) {
      const first = this.credentialsMember(h)
      if (first?.id === id) return first
    }
    const r = this.d.db.prepare("SELECT * FROM agent_logins WHERE id = ? AND removed_at IS NULL").get(id) as LoginRow | undefined
    return r ? { id: r.id, harness: r.harness, label: r.label, kind: r.kind, last4: r.last4, fingerprint: r.fingerprint, source: "added", value: this.d.secrets.open(r.ciphertext), createdAt: r.created_at } : undefined
  }

  /** Add a login. Claude: a `claude setup-token` OAuth token; Codex: a ChatGPT login's ~/.codex/auth.json. */
  add(input: unknown): AgentLogin {
    const p = parse(loginInput, input)
    const now = this.now()
    let value: string
    let kind: AgentLoginKind
    let fingerprint: string
    let last4: string
    if (p.harness === "claude") {
      const v = credentialValue.safeParse(p.value)
      if (!v.success) throw new BadRequestError(v.error.issues.map((i) => i.message).join("; "))
      value = v.data
      if (/^sk-ant-api/i.test(value)) throw new BadRequestError("That's an API key, which is billed per call. Add a subscription login here: run `claude setup-token` and paste the token it prints. An API key goes in Settings › Credentials.")
      kind = "oauth_token"
      fingerprint = tokenFingerprint(value)
      last4 = value.slice(-4)
    } else {
      const auth = parseCodexAuth(p.value)
      if (!isCodexAuth(auth)) throw new BadRequestError(auth.error)
      if (!auth.account) throw new BadRequestError("That auth.json has no ChatGPT login in it. Run `codex login` with the ChatGPT account, then paste ~/.codex/auth.json. An API key goes in Settings › Credentials.")
      value = auth.text
      kind = "chatgpt"
      fingerprint = tokenFingerprint(auth.account)
      last4 = auth.account.slice(-4)
    }
    if (this.credentialsMember(p.harness)?.fingerprint === fingerprint) throw new BadRequestError("That's the login in Settings › Credentials already.")
    const dup = this.d.db.prepare("SELECT label FROM agent_logins WHERE harness = ? AND fingerprint = ? AND removed_at IS NULL").get(p.harness, fingerprint) as { label: string } | undefined
    if (dup) throw new BadRequestError(`That's the ${dup.label} login already.`)
    const id = newId("lgn")
    const position = ((this.d.db.prepare("SELECT MAX(position) AS p FROM agent_logins").get() as { p: number | null }).p ?? 0) + 1
    // A removed login of the same account gives its fingerprint up: one live row per account.
    this.d.db.prepare("UPDATE agent_logins SET fingerprint = id WHERE harness = ? AND fingerprint = ? AND removed_at IS NOT NULL").run(p.harness, fingerprint)
    this.d.db
      .prepare("INSERT INTO agent_logins (id, harness, label, kind, ciphertext, fingerprint, last4, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, p.harness, p.label, kind, this.d.secrets.seal(value), fingerprint, last4, position, now, now)
    this.changed()
    return this.list(p.harness).find((l) => l.id === id)!
  }

  update(id: string, patch: unknown): AgentLogin {
    const p = parse(loginPatch, patch)
    const r = this.requireAdded(id)
    this.d.db.prepare("UPDATE agent_logins SET label = ?, updated_at = ? WHERE id = ?").run(p.label, this.now(), id)
    this.changed()
    return this.list(r.harness).find((l) => l.id === id)!
  }

  /** Forget a login's value. Its label stays, so turns that ran on it still name it. */
  remove(id: string) {
    const r = this.requireAdded(id)
    const now = this.now()
    this.d.db.prepare("UPDATE agent_logins SET ciphertext = '', fingerprint = id, removed_at = ?, updated_at = ? WHERE id = ?").run(now, now, id)
    this.d.db.prepare("DELETE FROM agent_login_holds WHERE login_id = ?").run(id)
    this.d.forget?.({ id, harness: r.harness })
    this.changed()
  }

  private requireAdded(id: string): LoginRow {
    if (id.startsWith(CRED_PREFIX)) throw new BadRequestError("That's Settings › Credentials' login: change it there.")
    const r = this.d.db.prepare("SELECT * FROM agent_logins WHERE id = ? AND removed_at IS NULL").get(id) as LoginRow | undefined
    if (!r) throw new NotFoundError(`No login ${id}`)
    return r
  }

  /** Run one tiny prompt on login `id` with the CLI agents use. A pass puts it back in the rotation. */
  async test(id: string): Promise<{ ok: boolean; text: string; login: AgentLogin }> {
    const m = this.member(id)
    if (!m) throw new NotFoundError(`No login ${id}`)
    if (!m.value) throw new BadRequestError("This server's secret key can't read that login. Remove it and add it again.")
    const r = await this.run(m)
    const at = this.now()
    const text = this.redact(r.text)
    const failure = r.ok ? null : classifyLoginFailure(m.harness, r.text, at)
    const patch: Partial<StatusRow> = { check_json: JSON.stringify({ at, ok: r.ok, text }) }
    if (r.ok) Object.assign(patch, { state: "ok", until: null, reason: null })
    else if (failure?.kind === "limit") Object.assign(patch, { state: "limited", until: failure.until, reason: this.redact(firstLine(r.text)) })
    else if (failure?.kind === "auth") Object.assign(patch, { state: "auth_failed", until: null, reason: this.redact(firstLine(r.text)) })
    this.upsertStatus(id, patch)
    this.changed()
    return { ok: r.ok, text, login: this.list(m.harness).find((l) => l.id === id)! }
  }

  /** Test a value before it's added (Settings' Test on a draft). */
  async testValue(input: { harness: LoginHarness; value: string }): Promise<{ ok: boolean; text: string }> {
    const harness = parse(z.enum(LOGIN_HARNESSES), input?.harness)
    const value = String(input?.value ?? "").trim()
    if (!value) throw new BadRequestError("Paste the login first.")
    const m: Member = { id: "", harness, label: "", kind: harness === "claude" ? "oauth_token" : "chatgpt", last4: "", fingerprint: "", source: "added", value, createdAt: 0 }
    if (harness === "codex") {
      const auth = parseCodexAuth(value)
      if (!isCodexAuth(auth)) throw new BadRequestError(auth.error)
      m.value = auth.text
    }
    const r = await this.run(m)
    // It isn't saved yet, so redact() doesn't know it.
    const own = harness === "codex" ? codexAuthSecrets(m.value!) : [m.value!]
    return { ok: r.ok, text: own.reduce((t, v) => (v.length >= 8 ? t.split(v).join("[redacted]") : t), this.redact(r.text)) }
  }

  private async run(m: Member): Promise<{ ok: boolean; text: string }> {
    if (m.harness === "claude") {
      const r = await this.d.check.claude(this.picked(m, "only").env)
      return { ok: r.ok, text: r.ok ? "Works: Claude answered using this login." : r.text }
    }
    const login: CodexLogin = m.kind === "chatgpt" ? { kind: "chatgpt", auth: m.value! } : { kind: "api_key", key: m.value! }
    const r = await this.d.check.codex(login)
    // The check may have refreshed the ChatGPT tokens: keep the new ones, the old refresh token is spent.
    if (r.refreshed && m.id) this.adoptCodexAuth(m.id, r.refreshed)
    return { ok: r.ok, text: r.ok ? "Works: Codex answered using this ChatGPT login." : r.text }
  }

  /** Every added login's value, for redact(); cached until one changes. */
  secretValues(): string[] {
    if (this.secretCache) return this.secretCache
    const rows = this.d.db.prepare("SELECT harness, ciphertext FROM agent_logins WHERE ciphertext != ''").all() as { harness: LoginHarness; ciphertext: string }[]
    this.secretCache = rows.flatMap((r) => {
      const v = this.d.secrets.open(r.ciphertext)
      if (!v) return []
      // A login file's tokens show up on their own (an error that quotes one), never the file as a whole.
      return r.harness === "codex" ? codexAuthSecrets(v) : [v]
    })
    return this.secretCache
  }

  /** Called when a login is added, renamed, removed, tested or skipped, and when Settings › Credentials changes. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed() {
    this.secretCache = null
    for (const fn of this.listeners) fn()
  }

  private setKv(key: string, value: string) {
    this.d.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value)
  }
}

/**
 * How a run on an added login names it for its limit readings and Settings' limits (server/loginLimits.ts): by its own
 * id, so Settings shows each added login's windows on its own row. Null for none, or for Settings › Credentials'
 * login, which the caller names the usual way (its id is the one loginLimits gives it).
 */
export function rotationLoginRef(login: (Pick<PickedLogin, "id" | "harness" | "kind" | "label" | "last4"> & { fingerprint: string | null }) | null): LoginRef | null {
  if (!login || isCredentialsLogin(login.id)) return null
  return { id: login.id, harness: login.harness, kind: login.kind, source: loginName(login), scope: `login:${login.id}`, fingerprint: login.fingerprint }
}

/**
 * A chat run on this server (the Coordinator, a Captain) that failed on its login's usage limit or a refused login:
 * the login sits out, and `again` runs it once more on the next one when there's one to go to.
 */
export async function retryOnNextLogin<R extends { ok: boolean; error: string; login?: PickedLogin | null }>(logins: AgentLogins | null, result: R, again: () => Promise<R>): Promise<R> {
  const login = result.login
  if (result.ok || !login || !logins) return result
  const failure = logins.reportFailure(login.id, login.harness, result.error)
  if (!failure || !logins.hasUsable(login.harness, login.id)) return result
  console.log(`[box-yard] the ${login.harness} login "${login.label}" ${failure.kind === "limit" ? "hit its usage limit" : "was refused"}; running again on the next login`)
  return again()
}

const accountOf = (auth: string): string | null => {
  const a = parseCodexAuth(auth)
  return isCodexAuth(a) ? a.account : null
}

const firstLine = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean) ?? text

function parseCheck(s: string | null): AgentLogin["lastCheck"] {
  if (!s) return null
  try {
    const v = JSON.parse(s)
    return typeof v?.at === "number" ? { at: v.at, ok: Boolean(v.ok), text: String(v.text ?? "") } : null
  } catch {
    return null
  }
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input)
  if (!r.success) throw new BadRequestError(r.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; "))
  return r.data
}

// ---------- reading a CLI's error ----------

// Only the CLIs' own words: a turn's error can quote anything its tools printed, and a misread login sits out.
const CLAUDE_LIMIT = /usage limit reached|(?:5-hour|weekly|session|opus|sonnet)[\w -]* limit reached|you(?:'|’)ve hit your (?:usage )?limit|limit will reset|out of extra usage|credit balance is too low/i
const CODEX_LIMIT = /usage[_ ]limit[_ ]reached|you(?:'|’)ve hit your usage limit|usage limit has been reached|insufficient_quota/i
const RATE_LIMIT = /API Error:?\s*429|\b429 Too Many Requests|rate_limit_error|rate limit exceeded/i
const AUTH =
  /API Error:?\s*401|\b401 Unauthorized|authentication_error|invalid (?:api key|bearer token|x-api-key)|oauth token (?:has )?(?:expired|been revoked|revoked)|please run \/login|refresh_token_reused|refresh token (?:was already used|has expired|is invalid)|access token could not be refreshed|invalid_grant|provided authentication token is expired|log out and sign in again/i

/**
 * What a failed turn's error says about its login: its usage limit (and when it's expected back), or a login that's
 * refused (signed out, revoked, expired). Null for anything else: those turns fail as they always have.
 */
export function classifyLoginFailure(harness: LoginHarness, text: string, now = Date.now()): LoginFailure | null {
  if (!text) return null
  if ((harness === "claude" ? CLAUDE_LIMIT : CODEX_LIMIT).test(text)) return { kind: "limit", until: resetTime(text, now) ?? now + LIMIT_FALLBACK_MS }
  if (AUTH.test(text)) return { kind: "auth" }
  if (RATE_LIMIT.test(text)) return { kind: "limit", until: resetTime(text, now) ?? now + RATE_LIMIT_MS }
  return null
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
const MAX_AHEAD = 8 * 86_400_000

/**
 * When a limit message says the limit resets, as epoch ms, or null when it doesn't say (or says something past a
 * week out, which is a misreading). Reads "…limit reached|1767225600", "resets_in_seconds": 3600, "try again in 2
 * days 3 hours 4 minutes", "resets 3pm (America/New_York)", "resets Mon 9:30am" and "try again at 3:05 PM".
 */
export function resetTime(text: string, now = Date.now()): number | null {
  const ok = (t: number | null) => (t !== null && Number.isFinite(t) && t > now && t - now <= MAX_AHEAD ? t : null)
  const epoch = /limit reached\|(\d{10,13})/i.exec(text)?.[1] ?? /"?resets?_at"?\s*[:=]\s*(\d{10,13})/i.exec(text)?.[1]
  if (epoch) return ok(epoch.length === 13 ? Number(epoch) : Number(epoch) * 1000)
  const secs = /"?resets?_in_seconds"?\s*[:=]\s*(\d+)/i.exec(text)?.[1]
  if (secs) return ok(now + Number(secs) * 1000)
  const inMatch = /(?:try again|resets?|available again) in ((?:\s*,?\s*(?:and\s+)?\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b)+)/i.exec(text)
  if (inMatch) {
    let ms = 0
    for (const [, n, unit] of inMatch[1]!.matchAll(/(\d+)\s*([a-z]+)/gi)) {
      const u = unit!.toLowerCase()
      ms += Number(n) * (u.startsWith("d") ? 86_400_000 : u.startsWith("h") ? 3_600_000 : u.startsWith("m") ? 60_000 : 1000)
    }
    return ok(now + ms)
  }
  const at = /(?:resets?|reset at|try again at|available again at)\s+(?:at\s+)?(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*,?\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\))?/i.exec(text)
  if (at && (at[3] || at[4])) {
    const [, day, h, m, ampm, zone] = at
    let hour = Number(h)
    if (ampm) hour = (hour % 12) + (/^p/i.test(ampm) ? 12 : 0)
    if (hour > 23) return null
    return ok(nextWallTime({ weekday: day ? WEEKDAYS.indexOf(day.slice(0, 3).toLowerCase()) : null, hour, minute: Number(m ?? 0) }, zone ?? null, now))
  }
  return null
}

/** The next moment after `now` that's `hour:minute` (on `weekday`, when given) in time zone `zone` (null: this server's). */
function nextWallTime(w: { weekday: number | null; hour: number; minute: number }, zone: string | null, now: number): number | null {
  let fmt: Intl.DateTimeFormat
  try {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: zone ?? undefined, year: "numeric", month: "numeric", day: "numeric", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" })
  } catch {
    return null
  }
  const parts = (t: number) => Object.fromEntries(fmt.formatToParts(new Date(t)).map((p) => [p.type, p.value])) as Record<string, string>
  // The zone's offset at `t`: its wall clock read as UTC, minus `t`.
  const offset = (t: number) => {
    const p = parts(t)
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute)) - Math.floor(t / 60_000) * 60_000
  }
  const today = parts(now)
  for (let i = 0; i <= 7; i++) {
    const wall = Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day) + i, w.hour, w.minute)
    let t = wall - offset(wall)
    t = wall - offset(t)
    if (t <= now) continue
    if (w.weekday !== null && WEEKDAYS.indexOf(parts(t).weekday!.slice(0, 3).toLowerCase()) !== w.weekday) continue
    return t
  }
  return null
}
