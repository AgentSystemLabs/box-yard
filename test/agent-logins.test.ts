import { afterEach, describe, expect, it } from "vitest"
import { AgentLogins, CLAUDE_STICKY_MS, classifyLoginFailure, resetTime, retryOnNextLogin, rotationLoginRef, type PickedLogin } from "../server/agentLogins.js"
import { chatClaudeLogin } from "../server/chatAgent.js"
import { limitState, recordLimits } from "../server/loginLimits.js"
import { CredentialStore } from "../server/credentials.js"
import { openDb, type DB } from "../server/db.js"
import { SecretBox } from "../server/identity/secretBox.js"
import { Store } from "../server/store.js"
import { tmpDir } from "./helpers.js"

// Several Claude and Codex logins, spread round robin (server/agentLogins.ts, docs/logins.md): add more than one OAuth
// token for Claude or Codex, and each new prompt takes the next one in turn.

const dbs: DB[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})

const codexAuth = (account: string, at = "2026-11-01T00:00:00Z", token = `refresh-${account}-original`) =>
  JSON.stringify({ tokens: { access_token: `access-${account}-secret`, refresh_token: token, account_id: account }, last_refresh: at })

function setup(o: { credentials?: Record<string, string>; now?: () => number } = {}) {
  const dir = tmpDir("agent-logins-")
  const db = openDb(dir)
  dbs.push(db)
  const store = new Store(db)
  const credentials = new CredentialStore(store, {})
  if (o.credentials) credentials.update(o.credentials)
  const checked: unknown[] = []
  const forgot: { id: string; harness: string }[] = []
  const logins = new AgentLogins({
    db,
    secrets: new SecretBox({ dataDir: dir }),
    credentials,
    check: {
      claude: async (env) => {
        checked.push(env)
        const token = Object.values(env)[0] ?? ""
        if (token.includes("revoked")) return { ok: false, text: "Claude said: Invalid API key · Please run /login" }
        if (token.includes("limited")) return { ok: false, text: "Claude said: Claude AI usage limit reached|1893456000" }
        return { ok: true, text: "OK" }
      },
      codex: async (login) => {
        checked.push(login)
        return { ok: true, text: "OK", refreshed: null }
      },
    },
    now: o.now,
    forget: (l) => forgot.push(l),
  })
  return { db, store, credentials, logins, checked, forgot }
}

describe("adding and listing logins", () => {
  it("never returns a value: a label, the last 4 characters and a fingerprint", () => {
    const { logins } = setup({ credentials: { claudeOauthToken: "sk-ant-oat01-credentials-AAAA" } })
    const added = logins.add({ harness: "claude", label: "Work Max", value: "sk-ant-oat01-work-secret-WXYZ" })
    expect(added).toMatchObject({ harness: "claude", label: "Work Max", kind: "oauth_token", last4: "WXYZ", source: "added", readable: true, state: "ok" })
    const list = logins.list("claude")
    expect(list.map((l) => [l.label, l.source, l.last4])).toEqual([
      ["Credentials", "credentials", "AAAA"],
      ["Work Max", "added", "WXYZ"],
    ])
    expect(JSON.stringify(list)).not.toContain("work-secret")
    expect(JSON.stringify(list)).not.toContain("credentials-AAAA")
    expect(logins.secretValues()).toContain("sk-ant-oat01-work-secret-WXYZ")
  })

  it("keeps the value encrypted at rest", () => {
    const { db, logins } = setup()
    logins.add({ harness: "claude", label: "Work", value: "sk-ant-oat01-plain-secret-1234" })
    const row = db.prepare("SELECT ciphertext FROM agent_logins").get() as { ciphertext: string }
    expect(row.ciphertext).toMatch(/^v1:/)
    expect(row.ciphertext).not.toContain("plain-secret")
  })

  it("refuses an API key, a login it already has, and the Credentials login", () => {
    const { logins } = setup({ credentials: { claudeOauthToken: "sk-ant-oat01-credentials-AAAA" } })
    expect(() => logins.add({ harness: "claude", label: "Key", value: "sk-ant-api03-billed-per-call" })).toThrow(/API key/)
    logins.add({ harness: "claude", label: "Work", value: "sk-ant-oat01-work-1234" })
    expect(() => logins.add({ harness: "claude", label: "Again", value: "sk-ant-oat01-work-1234" })).toThrow(/Work login already/)
    expect(() => logins.add({ harness: "claude", label: "Same", value: "sk-ant-oat01-credentials-AAAA" })).toThrow(/Settings › Credentials/)
    expect(() => logins.add({ harness: "codex", label: "Key", value: JSON.stringify({ OPENAI_API_KEY: "sk-proj-abcdefgh" }) })).toThrow(/no ChatGPT login/)
  })

  it("names a Codex login by its ChatGPT account, so a refresh is the same login", () => {
    const { logins } = setup()
    const a = logins.add({ harness: "codex", label: "Team", value: codexAuth("acct-team-9f3e") })
    expect(a).toMatchObject({ kind: "chatgpt", last4: "9f3e" })
    expect(() => logins.add({ harness: "codex", label: "Again", value: codexAuth("acct-team-9f3e", "2026-11-02T00:00:00Z") })).toThrow(/already/)
    expect(logins.adoptCodexAuth(a.id, codexAuth("acct-team-9f3e", "2026-11-03T00:00:00Z", "refresh-rotated"))).toBe(true)
    expect(logins.pick({ harness: "codex", holder: "t1", resume: false })!.auth).toContain("refresh-rotated")
    // An older copy, or another account's, never replaces it.
    expect(logins.adoptCodexAuth(a.id, codexAuth("acct-team-9f3e", "2026-10-01T00:00:00Z"))).toBe(false)
    expect(logins.adoptCodexAuth(a.id, codexAuth("acct-other", "2026-12-01T00:00:00Z"))).toBe(false)
    // Its tokens are redacted on their own.
    expect(logins.secretValues()).toEqual(expect.arrayContaining(["access-acct-team-9f3e-secret", "refresh-rotated"]))
  })

  it("renames, and removes a login's value but keeps its name for old turns", () => {
    const { db, logins } = setup()
    const a = logins.add({ harness: "claude", label: "Work", value: "sk-ant-oat01-work-1234" })
    expect(logins.update(a.id, { label: "Work Max" }).label).toBe("Work Max")
    logins.remove(a.id)
    expect(logins.list("claude")).toEqual([])
    expect((db.prepare("SELECT ciphertext FROM agent_logins WHERE id = ?").get(a.id) as { ciphertext: string }).ciphertext).toBe("")
    expect(logins.secretValues()).toEqual([])
    expect(logins.nameOf(a.id)).toEqual({ id: a.id, label: "Work Max", last4: "1234" })
    // The same account can come back as a new login.
    expect(logins.add({ harness: "claude", label: "Back", value: "sk-ant-oat01-work-1234" }).id).not.toBe(a.id)
    expect(() => logins.remove(logins.list("claude")[0]!.id.replace(/^lgn_/, "lgn_x"))).toThrow(/No login/)
  })

  it("forgets what a removed Codex login left on disk", () => {
    const { logins, forgot } = setup()
    const a = logins.add({ harness: "codex", label: "Team", value: codexAuth("acct-team-9f3e") })
    logins.remove(a.id)
    expect(forgot).toEqual([{ id: a.id, harness: "codex" }])
    // A chat still running on it can't put its refreshed copy back.
    expect(logins.adoptCodexAuth(a.id, codexAuth("acct-team-9f3e", "2026-11-03T00:00:00Z", "refresh-rotated"))).toBe(false)
    expect(logins.secretValues()).toEqual([])
  })

  it("can't rename or remove Settings › Credentials' login here", () => {
    const { logins } = setup({ credentials: { claudeOauthToken: "sk-ant-oat01-credentials-AAAA" } })
    const id = logins.list("claude")[0]!.id
    expect(id).toMatch(/^lgn_cred-claude-[0-9a-f]{8}$/)
    expect(() => logins.remove(id)).toThrow(/Settings › Credentials/)
    expect(() => logins.update(id, { label: "x" })).toThrow(/Settings › Credentials/)
  })
})

describe("picking the next login", () => {
  it("goes round robin over the Credentials login and the added ones, one per new session", () => {
    const { logins } = setup({ credentials: { claudeOauthToken: "sk-ant-oat01-credentials-AAAA" } })
    logins.add({ harness: "claude", label: "Two", value: "sk-ant-oat01-two-BBBB" })
    logins.add({ harness: "claude", label: "Three", value: "sk-ant-oat01-three-CCCC" })
    const picks = ["t1", "t2", "t3", "t4"].map((holder) => logins.pick({ harness: "claude", holder, resume: false })!)
    expect(picks.map((p) => p.label)).toEqual(["Credentials", "Two", "Three", "Credentials"])
    expect(picks[1]!.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-two-BBBB" })
    expect(picks.map((p) => p.why)).toEqual(["next", "next", "next", "next"])
  })

  it("has nothing to pick without a login, and the one there is with one", () => {
    const { logins } = setup()
    expect(logins.pick({ harness: "claude", holder: "t1", resume: false })).toBeNull()
    expect(logins.has("claude")).toBe(false)
    logins.add({ harness: "claude", label: "Only", value: "sk-ant-oat01-only-1234" })
    expect(logins.pick({ harness: "claude", holder: "t1", resume: false })).toMatchObject({ label: "Only", why: "only" })
    expect(logins.rotates("claude")).toBe(false)
  })

  it("keeps a resumed Claude session on its login while its cache is warm, then rotates", () => {
    let now = 1_000_000
    const { logins } = setup({ now: () => now })
    logins.add({ harness: "claude", label: "A", value: "sk-ant-oat01-a-1111" })
    logins.add({ harness: "claude", label: "B", value: "sk-ant-oat01-b-2222" })
    expect(logins.pick({ harness: "claude", holder: "t1", resume: false })!.label).toBe("A")
    expect(logins.pick({ harness: "claude", holder: "t2", resume: false })!.label).toBe("B")
    now += 10 * 60_000
    expect(logins.pick({ harness: "claude", holder: "t1", resume: true })).toMatchObject({ label: "A", why: "kept" })
    // A new session never keeps one: it's the next round robin.
    expect(logins.pick({ harness: "claude", holder: "t1", resume: false })!.label).toBe("A")
    now += CLAUDE_STICKY_MS + 1
    expect(logins.pick({ harness: "claude", holder: "t1", resume: true })).toMatchObject({ label: "B", why: "next" })
  })

  it("keeps a Codex session on the login that started it, however long it waited", () => {
    let now = 1_000_000
    const { logins } = setup({ now: () => now })
    logins.add({ harness: "codex", label: "A", value: codexAuth("acct-a") })
    logins.add({ harness: "codex", label: "B", value: codexAuth("acct-b") })
    expect(logins.pick({ harness: "codex", holder: "t1", resume: false })!.label).toBe("A")
    now += 7 * 86_400_000
    expect(logins.pick({ harness: "codex", holder: "t1", resume: true })).toMatchObject({ label: "A", why: "kept" })
  })

  it("skips a login that's signed out or at its limit, until it's back", () => {
    let now = 1_000_000
    const { logins } = setup({ now: () => now })
    const a = logins.add({ harness: "claude", label: "A", value: "sk-ant-oat01-a-1111" })
    const b = logins.add({ harness: "claude", label: "B", value: "sk-ant-oat01-b-2222" })
    const c = logins.add({ harness: "claude", label: "C", value: "sk-ant-oat01-c-3333" })
    expect(logins.reportFailure(a.id, "claude", "API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"}}")).toEqual({ kind: "auth" })
    expect(logins.reportFailure(b.id, "claude", `Claude AI usage limit reached|${Math.floor((now + 3_600_000) / 1000)}`)).toEqual({ kind: "limit", until: now + 3_600_000 })
    expect(logins.list("claude").map((l) => l.state)).toEqual(["auth_failed", "limited", "ok"])
    expect(logins.list("claude")[1]!.limitedUntil).toBe(now + 3_600_000)
    for (const holder of ["t1", "t2", "t3"]) expect(logins.pick({ harness: "claude", holder, resume: false })!.id).toBe(c.id)
    // B's limit resets; A stays out until it works again.
    now += 3_600_001
    expect(logins.pick({ harness: "claude", holder: "t4", resume: false })!.id).toBe(b.id)
    expect(logins.pick({ harness: "claude", holder: "t5", resume: false })!.id).toBe(c.id)
    logins.reportSuccess(a.id)
    expect(logins.pick({ harness: "claude", holder: "t6", resume: false })!.id).toBe(a.id)
  })

  it("moves a resumed session off a login that's out, and tries one anyway when every login is out", () => {
    const { logins } = setup()
    const a = logins.add({ harness: "claude", label: "A", value: "sk-ant-oat01-a-1111" })
    const b = logins.add({ harness: "claude", label: "B", value: "sk-ant-oat01-b-2222" })
    expect(logins.pick({ harness: "claude", holder: "t1", resume: false })!.id).toBe(a.id)
    logins.reportFailure(a.id, "claude", "You've hit your limit · resets 3pm (UTC)")
    expect(logins.pick({ harness: "claude", holder: "t1", resume: true })).toMatchObject({ id: b.id, why: "next" })
    logins.reportFailure(b.id, "claude", "Claude AI usage limit reached")
    expect(logins.pick({ harness: "claude", holder: "t2", resume: false })).toMatchObject({ why: "fallback" })
  })

  it("leaves out a retry's failed login", () => {
    const { logins } = setup()
    const a = logins.add({ harness: "claude", label: "A", value: "sk-ant-oat01-a-1111" })
    const b = logins.add({ harness: "claude", label: "B", value: "sk-ant-oat01-b-2222" })
    expect(logins.pick({ harness: "claude", holder: "t1", resume: false })!.id).toBe(a.id)
    expect(logins.pick({ harness: "claude", holder: "t1", resume: true, avoid: [a.id] })!.id).toBe(b.id)
    expect(logins.pick({ harness: "claude", holder: "t2", resume: false, avoid: [a.id, b.id] })!.why).toBe("fallback")
  })

  it("reads the usage-limit tracker when one is set", () => {
    let now = 1_000_000
    const { logins } = setup({ now: () => now })
    const a = logins.add({ harness: "claude", label: "A", value: "sk-ant-oat01-a-1111" })
    const b = logins.add({ harness: "claude", label: "B", value: "sk-ant-oat01-b-2222" })
    const resetsAt = now + 60_000
    logins.setLimitSource((id) => (id === a.id ? { atLimit: true, usedPct: 100, resetsAt, asOf: now } : { atLimit: false, usedPct: 40, resetsAt: null, asOf: now }))
    expect(logins.pick({ harness: "claude", holder: "t1", resume: false })!.id).toBe(b.id)
    expect(logins.pick({ harness: "claude", holder: "t2", resume: false })!.id).toBe(b.id)
    expect(logins.list("claude")[0]).toMatchObject({ state: "limited", limitedUntil: resetsAt })
    now += 60_001
    expect(logins.pick({ harness: "claude", holder: "t3", resume: false })!.id).toBe(a.id)
  })

  it("skips a login its limit readings say is full, filed under the ids the limits use", () => {
    let now = 1_000_000
    const { logins, store, credentials } = setup({ credentials: { claudeOauthToken: "sk-ant-oat01-credentials-AAAA" }, now: () => now })
    const a = logins.add({ harness: "claude", label: "A", value: "sk-ant-oat01-a-1111" })
    const b = logins.add({ harness: "claude", label: "B", value: "sk-ant-oat01-b-2222" })
    logins.setLimitSource((id) => limitState(store, id, now))
    const full = (resetsAt: number) => ({ plan: null, readings: [{ window: "five_hour", minutes: 300, usedPct: 100, resetsAt, status: "rejected" as const }] })
    // Settings › Credentials' login as a chat's run names it, and A as a run on it names it.
    const settingsRef = chatClaudeLogin(credentials.claudeEnv(), null)
    expect(logins.list("claude")[0]!.id).toBe(settingsRef.id)
    const aRef = logins.refOf(a.id)!
    expect(aRef).toEqual({ id: a.id, harness: "claude", kind: "oauth_token", source: "A (…1111)", scope: `login:${a.id}`, fingerprint: expect.stringMatching(/^[0-9a-f]{12}$/) })
    recordLimits(store, null, settingsRef, full(now + 60_000), now)
    recordLimits(store, null, aRef, full(now + 120_000), now)
    expect(logins.pick({ harness: "claude", holder: "t1", resume: false })!.id).toBe(b.id)
    expect(logins.pick({ harness: "claude", holder: "t2", resume: false })!.id).toBe(b.id)
    expect(logins.list("claude").map((l) => l.state)).toEqual(["limited", "limited", "ok"])
    now += 60_001
    expect(logins.pick({ harness: "claude", holder: "t3", resume: false })!.id).toBe(settingsRef.id)
    // Settings › Credentials' login is named the usual way; a removed login keeps its name but not its fingerprint.
    expect(rotationLoginRef(logins.pick({ harness: "claude", holder: "t3", resume: true }))).toBeNull()
    logins.remove(b.id)
    expect(logins.refOf(b.id)).toMatchObject({ id: b.id, source: "B (…2222)", fingerprint: null })
  })

  it("doesn't move the rotation for a representative login", () => {
    const { logins } = setup()
    logins.add({ harness: "claude", label: "A", value: "sk-ant-oat01-a-1111" })
    logins.add({ harness: "claude", label: "B", value: "sk-ant-oat01-b-2222" })
    expect(logins.representative("claude")!.label).toBe("A")
    expect(logins.representative("claude")!.label).toBe("A")
    expect(logins.pick({ harness: "claude", holder: "t1", resume: false })!.label).toBe("A")
  })

  it("gives a side thread its chat's login without moving the rotation", () => {
    const { logins } = setup()
    const a = logins.add({ harness: "claude", label: "A", value: "sk-ant-oat01-a-1111" })
    const b = logins.add({ harness: "claude", label: "B", value: "sk-ant-oat01-b-2222" })
    logins.pick({ harness: "claude", holder: "coordinator", resume: false })
    expect(logins.pick({ harness: "claude", holder: "coordinator", resume: false })!.id).toBe(b.id)
    expect(logins.heldBy("coordinator", "claude")).toMatchObject({ id: b.id, why: "kept" })
    expect(logins.heldBy("coordinator", "claude")!.id).toBe(b.id)
    // A chat with no login yet, or whose login is out: the first that may take work.
    expect(logins.heldBy("captain:prj_x", "claude")!.id).toBe(a.id)
    logins.reportFailure(b.id, "claude", "Invalid API key · Please run /login")
    expect(logins.heldBy("coordinator", "claude")!.id).toBe(a.id)
    expect(logins.pick({ harness: "claude", holder: "t1", resume: false })!.id).toBe(a.id)
  })
})

describe("running a chat again on the next login", () => {
  const failed = (login: PickedLogin, error: string) => ({ ok: false, error, login })

  it("runs once more when its login hit its limit or was refused, and the login sits out", async () => {
    const { logins } = setup()
    logins.add({ harness: "claude", label: "A", value: "sk-ant-oat01-a-1111" })
    const b = logins.add({ harness: "claude", label: "B", value: "sk-ant-oat01-b-2222" })
    const first = logins.pick({ harness: "claude", holder: "coordinator", resume: false })!
    let again = 0
    const resets = Math.floor(Date.now() / 1000) + 7200
    const result = await retryOnNextLogin(logins, failed(first, `Claude AI usage limit reached|${resets}`), async () => {
      again++
      return { ok: true, error: "", login: logins.pick({ harness: "claude", holder: "coordinator", resume: true }) }
    })
    expect(again).toBe(1)
    expect(result).toMatchObject({ ok: true, login: { id: b.id } })
    expect(logins.list("claude").find((l) => l.id === first.id)).toMatchObject({ state: "limited", limitedUntil: resets * 1000 })
  })

  it("doesn't for any other failure, or with nowhere else to go", async () => {
    const { logins } = setup()
    const a = logins.add({ harness: "claude", label: "A", value: "sk-ant-oat01-a-1111" })
    const only = logins.pick({ harness: "claude", holder: "coordinator", resume: false })!
    const never = async () => {
      throw new Error("ran again")
    }
    expect(await retryOnNextLogin(logins, failed(only, "Error: tool crashed"), never)).toMatchObject({ ok: false })
    expect(await retryOnNextLogin(logins, failed(only, "Invalid API key · Please run /login"), never)).toMatchObject({ ok: false })
    expect(logins.list("claude").find((l) => l.id === a.id)!.state).toBe("auth_failed")
    expect(await retryOnNextLogin(null, failed(only, "Invalid API key"), never)).toMatchObject({ ok: false })
    expect(await retryOnNextLogin(logins, { ok: false, error: "Invalid API key · Please run /login", login: null }, never)).toMatchObject({ ok: false })
  })
})

describe("testing a login", () => {
  it("runs the CLI with that login alone and puts a passing one back in the rotation", async () => {
    const { logins, checked } = setup()
    const a = logins.add({ harness: "claude", label: "A", value: "sk-ant-oat01-a-1111" })
    logins.reportFailure(a.id, "claude", "OAuth token has expired")
    expect(logins.list("claude")[0]!.state).toBe("auth_failed")
    const r = await logins.test(a.id)
    expect(r.ok).toBe(true)
    expect(checked).toEqual([{ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-a-1111" }])
    expect(r.login).toMatchObject({ state: "ok", lastCheck: { ok: true } })
  })

  it("marks a refused login signed out, with the CLI's words", async () => {
    const { logins } = setup()
    const a = logins.add({ harness: "claude", label: "A", value: "sk-ant-oat01-revoked-1111" })
    const r = await logins.test(a.id)
    expect(r.ok).toBe(false)
    expect(r.login).toMatchObject({ state: "auth_failed", stateReason: expect.stringContaining("Please run /login") })
  })

  it("tests a value before it's added", async () => {
    const { logins } = setup()
    expect(await logins.testValue({ harness: "claude", value: "sk-ant-oat01-limited-0000" })).toMatchObject({ ok: false, text: expect.stringContaining("usage limit") })
    await expect(logins.testValue({ harness: "codex", value: "not json" })).rejects.toThrow(/isn't JSON/)
  })
})

describe("reading a CLI's error", () => {
  const now = Date.parse("2026-11-04T12:00:00Z")
  it("knows Claude's and Codex's usage limits and when they reset", () => {
    expect(classifyLoginFailure("claude", `Claude AI usage limit reached|${Math.floor(now / 1000) + 7200}`, now)).toEqual({ kind: "limit", until: now + 7_200_000 })
    expect(classifyLoginFailure("claude", "5-hour limit reached ∙ resets 3pm (UTC)", now)).toEqual({ kind: "limit", until: Date.parse("2026-11-04T15:00:00Z") })
    // 7am in New York: 9am is later today; 6am is tomorrow.
    expect(classifyLoginFailure("claude", "You've hit your limit · resets 9am (America/New_York)", now)).toEqual({ kind: "limit", until: Date.parse("2026-11-04T14:00:00Z") })
    expect(classifyLoginFailure("claude", "You've hit your limit · resets 6am (America/New_York)", now)).toEqual({ kind: "limit", until: Date.parse("2026-11-05T11:00:00Z") })
    expect(classifyLoginFailure("codex", "You've hit your usage limit. Upgrade to Pro or try again in 2 days 3 hours 4 minutes.", now)).toEqual({ kind: "limit", until: now + (2 * 24 * 60 + 3 * 60 + 4) * 60_000 })
    expect(classifyLoginFailure("codex", '{"type":"usage_limit_reached","resets_in_seconds":600}', now)).toEqual({ kind: "limit", until: now + 600_000 })
    // No reset time: an hour out.
    expect(classifyLoginFailure("claude", "Claude AI usage limit reached", now)).toEqual({ kind: "limit", until: now + 3_600_000 })
  })

  it("knows a refused login", () => {
    for (const t of ["Invalid API key · Please run /login", 'API Error: 401 {"error":{"type":"authentication_error"}}', "OAuth token has expired", "refresh_token_reused", "Your access token could not be refreshed"])
      expect(classifyLoginFailure(t.startsWith("refresh") || t.startsWith("Your") ? "codex" : "claude", t, now), t).toEqual({ kind: "auth" })
  })

  it("leaves other failures alone", () => {
    for (const t of ["claude exited with code 1", "git push: 401 from the remote? no", "Error: ENOENT", "the tests failed with 429 cases"]) expect(classifyLoginFailure("claude", t, now), t).toBeNull()
  })

  it("never reads a reset time more than a week out or in the past", () => {
    expect(resetTime(`limit reached|${Math.floor(now / 1000) - 60}`, now)).toBeNull()
    expect(resetTime("try again in 30 days", now)).toBeNull()
    expect(resetTime("resets Mon 9:30am (UTC)", now)).toBe(Date.parse("2026-11-09T09:30:00Z"))
  })
})
