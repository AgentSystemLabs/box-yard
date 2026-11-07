import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { claudeLimitReadings, codexLimitReadings, limitStateOf, windowLabel, type LimitsReport, type LimitWindow } from "../shared/loginLimits.js"
import { usedLabel, windowText } from "../web/src/components/LoginLimits"
import { claudeLoginRef, codexLoginRef, limitState, limitsOf, limitsReport, recordLimits, type LoginRef } from "../server/loginLimits.js"
import { codexContextOf, CodexStream } from "../server/codex.js"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { testConfig, tmpDir } from "./helpers.js"

const T = Date.parse("2026-11-04T10:00:00Z")
const S = T / 1000
const H = 3_600_000

// Claude Code's stream-json `rate_limit_event` (sdk.d.ts SDKRateLimitEvent): resetsAt in unix seconds, utilization 0–1.
const CLAUDE_FIVE_HOUR = {
  type: "rate_limit_event",
  rate_limit_info: { status: "allowed", resetsAt: S + 2 * 3600, rateLimitType: "five_hour", utilization: 0.42, isUsingOverage: false },
  uuid: "5d1f6c2e-0000-4000-8000-000000000001",
  session_id: "s-1",
}
const CLAUDE_WEEKLY_WARNING = {
  type: "rate_limit_event",
  rate_limit_info: { status: "allowed_warning", resetsAt: S + 3 * 86_400, rateLimitType: "seven_day", utilization: 0.83, surpassedThreshold: 0.8 },
  uuid: "5d1f6c2e-0000-4000-8000-000000000002",
  session_id: "s-1",
}
const CLAUDE_REJECTED = {
  type: "rate_limit_event",
  rate_limit_info: { status: "rejected", resetsAt: S + 40 * 60, rateLimitType: "five_hour", overageStatus: "rejected", overageDisabledReason: "out_of_credits" },
  uuid: "5d1f6c2e-0000-4000-8000-000000000003",
  session_id: "s-1",
}
const CLAUDE_UNIFIED = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    rateLimitType: "five_hour",
    resetsAt: S + 3600,
    unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: S + 3600 }, seven_day: { utilization: 0.55, resetsAt: S + 5 * 86_400 }, made_up: { utilization: 1 } },
  },
  uuid: "5d1f6c2e-0000-4000-8000-000000000004",
  session_id: "s-1",
}

// A Codex rollout file's token_count with the plan's limits (codex-rs RateLimitSnapshot): used_percent 0–100,
// window_minutes, resets_at in unix seconds.
const CODEX_TOKEN_COUNT = {
  timestamp: "2026-11-04T09:58:00.000Z",
  type: "event_msg",
  payload: {
    type: "token_count",
    info: { last_token_usage: { input_tokens: 12_000, cached_input_tokens: 9000, output_tokens: 300 }, model_context_window: 272_000 },
    rate_limits: {
      limit_id: "codex",
      limit_name: null,
      primary: { used_percent: 23.5, window_minutes: 300, resets_at: S + 4 * 3600 },
      secondary: { used_percent: 61, window_minutes: 10_080, resets_at: S + 6 * 86_400 },
      credits: { has_credits: false, unlimited: false, balance: null },
      plan_type: "plus",
    },
  },
}

const ref = (over: Partial<LoginRef> = {}): LoginRef => ({ id: "lgn_cred-claude-aaaaaaaa", harness: "claude", kind: "oauth_token", source: "Settings › Credentials", scope: "settings", fingerprint: "aaaaaaaaaaaa", ...over })
const store = () => new Store(openDb(tmpDir("limits-")))

describe("reading the CLIs' limits", () => {
  it("reads Claude Code's rate_limit_event per window, as a percent and epoch ms", () => {
    expect(claudeLimitReadings(CLAUDE_FIVE_HOUR.rate_limit_info)).toEqual([{ window: "five_hour", minutes: 300, usedPct: 42, resetsAt: T + 2 * H, status: "allowed" }])
    expect(claudeLimitReadings(CLAUDE_WEEKLY_WARNING.rate_limit_info)).toEqual([{ window: "seven_day", minutes: 10_080, usedPct: 83, resetsAt: T + 72 * H, status: "warning" }])
    // A refusal says when, not how much.
    expect(claudeLimitReadings(CLAUDE_REJECTED.rate_limit_info)).toEqual([{ window: "five_hour", minutes: 300, usedPct: null, resetsAt: T + 40 * 60_000, status: "rejected" }])
  })

  it("takes every window the CLI sends, and the one the event is about wins", () => {
    const r = claudeLimitReadings(CLAUDE_UNIFIED.rate_limit_info)
    expect(r.map((w) => [w.window, w.usedPct, w.status])).toEqual([
      ["five_hour", 10, "allowed"],
      ["seven_day", 55, null],
    ])
  })

  it("keeps a refusal that names no window, and ignores what isn't a reading", () => {
    expect(claudeLimitReadings({ status: "rejected", resetsAt: S + 60 })).toEqual([{ window: "limit", minutes: null, usedPct: null, resetsAt: T + 60_000, status: "rejected" }])
    expect(claudeLimitReadings({ status: "allowed" })).toEqual([])
    expect(claudeLimitReadings({ status: "allowed", rateLimitType: "overage", utilization: 0.2 })).toEqual([])
    expect(claudeLimitReadings(null)).toEqual([])
    expect(claudeLimitReadings("five_hour")).toEqual([])
  })

  it("reads Codex's primary and secondary windows and the plan from a rollout token_count", () => {
    expect(codexLimitReadings(CODEX_TOKEN_COUNT.payload.rate_limits, T)).toEqual({
      plan: "plus",
      readings: [
        { window: "primary", minutes: 300, usedPct: 23.5, resetsAt: T + 4 * H, status: null },
        { window: "secondary", minutes: 10_080, usedPct: 61, resetsAt: T + 144 * H, status: null },
      ],
    })
  })

  it("counts an older Codex's resets_in_seconds from the reading's time, and keeps a second limit's windows apart", () => {
    const old = codexLimitReadings({ primary: { used_percent: 100, window_minutes: 300, resets_in_seconds: 900 } }, T)
    expect(old.readings).toEqual([{ window: "primary", minutes: 300, usedPct: 100, resetsAt: T + 900_000, status: "rejected" }])
    const other = codexLimitReadings({ limit_id: "gpt-6-pro", primary: { used_percent: 5, window_minutes: 300, resets_at: S + 60 } }, T)
    expect(other.readings[0]!.window).toBe("gpt-6-pro:primary")
    expect(windowLabel("codex", "gpt-6-pro:primary", 300)).toBe("5-hour · gpt-6-pro")
    expect(codexLimitReadings({ primary: null, secondary: {} }, T).readings).toEqual([])
  })

  it("names windows the way the plans do", () => {
    expect(windowLabel("claude", "five_hour", 300)).toBe("5-hour")
    expect(windowLabel("claude", "seven_day", 10_080)).toBe("Weekly")
    expect(windowLabel("claude", "seven_day_opus", 10_080)).toBe("Weekly · Opus")
    expect(windowLabel("codex", "primary", 300)).toBe("5-hour")
    expect(windowLabel("codex", "secondary", 10_080)).toBe("Weekly")
    expect(windowLabel("codex", "secondary", null)).toBe("Long window")
  })

  it("tells a chat's message from a runner's event", () => {
    expect(limitsOf(CLAUDE_FIVE_HOUR)?.readings[0]?.window).toBe("five_hour")
    expect(limitsOf({ t: "limits", harness: "claude", info: CLAUDE_FIVE_HOUR.rate_limit_info })?.readings).toHaveLength(1)
    expect(limitsOf({ t: "limits", harness: "codex", rateLimits: CODEX_TOKEN_COUNT.payload.rate_limits, at: T })?.plan).toBe("plus")
    expect(limitsOf({ type: "rate_limit_event", codex_rate_limits: CODEX_TOKEN_COUNT.payload.rate_limits, at: T })?.readings).toHaveLength(2)
    expect(limitsOf({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } })).toBeNull()
  })
})

describe("a login's state", () => {
  const w = (o: Partial<{ usedPct: number | null; resetsAt: number | null; status: "allowed" | "warning" | "rejected" | null; asOf: number }>) => ({ usedPct: null, resetsAt: null, status: null, asOf: T, ...o })

  it("is at its limit until the last full window resets", () => {
    expect(limitStateOf([w({ usedPct: 100, resetsAt: T + H }), w({ status: "rejected", resetsAt: T + 5 * H }), w({ usedPct: 40, resetsAt: T + 50 * H })], T)).toEqual({ atLimit: true, usedPct: 100, resetsAt: T + 5 * H, asOf: T })
  })

  it("leaves out windows that have reset since their reading", () => {
    const s = limitStateOf([w({ usedPct: 100, resetsAt: T - 1 }), w({ usedPct: 30, resetsAt: T + H, asOf: T - H })], T)
    expect(s).toEqual({ atLimit: false, usedPct: 30, resetsAt: T + H, asOf: T })
    // No reset time: a reading counts for six hours.
    expect(limitStateOf([w({ usedPct: 90, asOf: T - 7 * H })], T)).toEqual({ atLimit: false, usedPct: null, resetsAt: null, asOf: T - 7 * H })
    expect(limitStateOf([], T)).toBeNull()
  })
})

describe("login ids", () => {
  const sha = (v: string) => createHash("sha256").update(v).digest("hex")

  it("names a Claude login by its strongest credential's fingerprint, never its value", () => {
    const r = claudeLoginRef({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-secret", ANTHROPIC_API_KEY: "sk-ant-api03-key" }, "demo's env vars", "project:p1")
    expect(r).toEqual({ id: `lgn_cred-claude-${sha("sk-ant-api03-key").slice(0, 8)}`, harness: "claude", kind: "api_key", source: "demo's env vars", scope: "project:p1", fingerprint: sha("sk-ant-api03-key").slice(0, 12) })
    expect(JSON.stringify(r)).not.toContain("secret")
    expect(claudeLoginRef({ CLAUDE_CODE_OAUTH_TOKEN: " sk-ant-oat01-x \n" }, "s", "settings").id).toBe(`lgn_cred-claude-${sha("sk-ant-oat01-x").slice(0, 8)}`)
  })

  it("uses the computer's own login when no credential is handed over", () => {
    expect(claudeLoginRef({ CLAUDE_CODE_OAUTH_TOKEN: " " }, "This computer", "local")).toMatchObject({ id: "lgn_local-claude", kind: "local", scope: "local", fingerprint: null })
    expect(claudeLoginRef({}, "SSH machine gpu-1", "local:gpu-1")).toMatchObject({ id: "lgn_local-claude-gpu-1", scope: "local:gpu-1" })
    expect(claudeLoginRef({}, "This computer", "settings")).toMatchObject({ id: "lgn_local-claude", scope: "local" })
  })

  it("names a ChatGPT login by its account, so a refresh keeps the id", () => {
    const auth = (token: string) => JSON.stringify({ tokens: { id_token: "i", access_token: token, refresh_token: `r-${token}`, account_id: "acct-77" }, last_refresh: "2026-11-01T00:00:00Z" })
    const a = codexLoginRef({ kind: "chatgpt", auth: auth("one") }, "Settings › Credentials", "settings")
    expect(a).toEqual({ id: `lgn_cred-codex-${sha("acct-77").slice(0, 8)}`, harness: "codex", kind: "chatgpt", source: "Settings › Credentials", scope: "settings", fingerprint: sha("acct-77").slice(0, 12) })
    expect(codexLoginRef({ kind: "chatgpt", auth: auth("two") }, "Settings › Credentials", "settings").id).toBe(a.id)
    expect(codexLoginRef({ kind: "api_key", key: "sk-proj-1" }, "s", "settings")).toMatchObject({ kind: "api_key", id: `lgn_cred-codex-${sha("sk-proj-1").slice(0, 8)}` })
    expect(codexLoginRef(null, "This computer", "local").id).toBe("lgn_local-codex")
  })
})

describe("keeping readings", () => {
  it("keeps each login's windows apart and tells the web app only when what it shows changes", () => {
    const s = store()
    const sent: unknown[] = []
    const hub = { broadcast: (e: unknown) => void sent.push(e) }
    const other = ref({ id: "lgn_cred-claude-bbbbbbbb", fingerprint: "bbbbbbbbbbbb", source: "Acme identity", scope: "identity:idn_1" })
    expect(recordLimits(s, hub, ref(), limitsOf(CLAUDE_FIVE_HOUR), T)).toBe(true)
    expect(recordLimits(s, hub, ref(), limitsOf(CLAUDE_WEEKLY_WARNING), T + 1)).toBe(true)
    expect(recordLimits(s, hub, other, limitsOf(CLAUDE_REJECTED), T + 2)).toBe(true)
    // The same figures again, a minute on: nothing new to show.
    expect(recordLimits(s, hub, ref(), limitsOf(CLAUDE_FIVE_HOUR), T + 60_000)).toBe(false)
    expect(sent).toEqual([{ type: "limits" }, { type: "limits" }, { type: "limits" }])
    expect(s.loginLimitRows(ref().id).map((r) => r.limit_window).sort()).toEqual(["five_hour", "seven_day"])
    expect(s.loginLimitRows(ref().id).find((r) => r.limit_window === "five_hour")!.as_of).toBe(T + 60_000)
  })

  it("keeps a window's figure when a later event names it without one, and ignores older readings", () => {
    const s = store()
    recordLimits(s, null, ref(), limitsOf(CLAUDE_FIVE_HOUR), T)
    const sameWindow = { ...CLAUDE_FIVE_HOUR, rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: S + 2 * 3600 } }
    recordLimits(s, null, ref(), limitsOf(sameWindow), T + 1000)
    expect(s.loginLimitRows(ref().id)[0]).toMatchObject({ used_pct: 42, status: "warning", as_of: T + 1000 })
    // A new window (another reset time) doesn't inherit the old one's figure.
    recordLimits(s, null, ref(), limitsOf({ ...sameWindow, rate_limit_info: { ...sameWindow.rate_limit_info, resetsAt: S + 7 * 3600 } }), T + 2000)
    expect(s.loginLimitRows(ref().id)[0]).toMatchObject({ used_pct: null, resets_at: T + 7 * H })
    // A reading older than the one kept loses.
    recordLimits(s, null, ref(), limitsOf({ ...CLAUDE_FIVE_HOUR, rate_limit_info: { ...CLAUDE_FIVE_HOUR.rate_limit_info, utilization: 0.99 } }), T)
    expect(s.loginLimitRows(ref().id)[0]!.as_of).toBe(T + 2000)
  })

  it("answers the login picker and GET /api/limits", () => {
    const s = store()
    recordLimits(s, null, ref(), limitsOf(CLAUDE_FIVE_HOUR), T - 1000)
    recordLimits(s, null, ref(), limitsOf(CLAUDE_WEEKLY_WARNING), T)
    const codex = ref({ id: "lgn_cred-codex-cccccccc", harness: "codex", kind: "chatgpt", fingerprint: "cccccccccccc" })
    recordLimits(s, null, codex, limitsOf({ t: "limits", harness: "codex", rateLimits: CODEX_TOKEN_COUNT.payload.rate_limits }), T)
    expect(limitState(s, ref().id, T)).toEqual({ atLimit: false, usedPct: 83, resetsAt: T + 72 * H, asOf: T })
    expect(limitState(s, "lgn_nobody", T)).toBeNull()
    const report: LimitsReport = limitsReport(s, T + 5)
    expect(report).toEqual({
      now: T + 5,
      logins: [
        {
          loginId: "lgn_cred-claude-aaaaaaaa",
          harness: "claude",
          kind: "oauth_token",
          source: "Settings › Credentials",
          scope: "settings",
          fingerprint: "aaaaaaaaaaaa",
          plan: null,
          asOf: T,
          windows: [
            { window: "five_hour", label: "5-hour", minutes: 300, usedPct: 42, resetsAt: T + 2 * H, status: "allowed", asOf: T - 1000 },
            { window: "seven_day", label: "Weekly", minutes: 10_080, usedPct: 83, resetsAt: T + 72 * H, status: "warning", asOf: T },
          ],
          state: { atLimit: false, usedPct: 83, resetsAt: T + 72 * H, asOf: T },
        },
        {
          loginId: "lgn_cred-codex-cccccccc",
          harness: "codex",
          kind: "chatgpt",
          source: "Settings › Credentials",
          scope: "settings",
          fingerprint: "cccccccccccc",
          plan: "plus",
          asOf: T,
          windows: [
            { window: "primary", label: "5-hour", minutes: 300, usedPct: 23.5, resetsAt: T + 4 * H, status: null, asOf: T },
            { window: "secondary", label: "Weekly", minutes: 10_080, usedPct: 61, resetsAt: T + 144 * H, status: null, asOf: T },
          ],
          state: { atLimit: false, usedPct: 61, resetsAt: T + 144 * H, asOf: T },
        },
      ],
    })
  })
})

describe("Codex's limits from its rollout file", () => {
  it("reads the last rate_limits with its time, even from a token_count before the turn's usage", () => {
    const dir = tmpDir("codex-limits")
    const file = path.join(dir, "rollout-2026-11-04T09-00-00-t-1.jsonl")
    const limitsOnly = { ...CODEX_TOKEN_COUNT, payload: { type: "token_count", info: null, rate_limits: CODEX_TOKEN_COUNT.payload.rate_limits } }
    const usageOnly = { timestamp: "2026-11-04T09:59:00.000Z", type: "event_msg", payload: { ...CODEX_TOKEN_COUNT.payload, rate_limits: null } }
    const lines = [{ type: "turn_context", payload: { model: "gpt-6.1-sol" } }, limitsOnly, usageOnly]
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
    expect(codexContextOf(file)).toEqual({ tokens: 12_300, window: 272_000, model: "gpt-6.1-sol", rateLimits: CODEX_TOKEN_COUNT.payload.rate_limits, rateLimitsAt: Date.parse("2026-11-04T09:58:00.000Z") })
  })

  it("hands a chat the plan's limits in a rate_limit_event at the end of the turn", () => {
    const rateLimits = CODEX_TOKEN_COUNT.payload.rate_limits
    const stream = new CodexStream({ model: null, context: () => ({ tokens: 100, window: 1000, model: "gpt-6.1-sol", rateLimits, rateLimitsAt: T }) })
    const out = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } }),
    ].flatMap((l) => stream.push(l))
    const ev = out.find((m) => m.type === "rate_limit_event")
    expect(ev).toEqual({ type: "rate_limit_event", session_id: "t-1", codex_rate_limits: rateLimits, at: T })
    expect(out.indexOf(ev)).toBeLessThan(out.findIndex((m) => m.type === "result"))
    expect(limitsOf(ev)?.readings).toHaveLength(2)
  })
})

describe("the runner", () => {
  /** The runner's translate(), run from its source (runner/box-runner.mjs is one file copied to boxes). */
  const translate = (() => {
    const src = fs.readFileSync(path.join(import.meta.dirname, "../runner/box-runner.mjs"), "utf8")
    const start = src.indexOf("function translate(msg) {")
    const end = src.indexOf("\n}\n", start) + 2
    expect(start).toBeGreaterThan(0)
    return new Function(`const clip = (v) => v\n${src.slice(start, end)}\nreturn translate`)() as (msg: unknown) => unknown[]
  })()

  it("passes Claude Code's limits to the server as a limits event", () => {
    expect(translate(CLAUDE_WEEKLY_WARNING)).toEqual([{ t: "limits", harness: "claude", info: CLAUDE_WEEKLY_WARNING.rate_limit_info }])
    expect(translate({ type: "rate_limit_event" })).toEqual([])
  })
})

describe("a task turn's limits", () => {
  const yards: BoxYard[] = []
  afterEach(() => yards.splice(0).forEach((y) => y.stop()))

  it("are kept for the login the turn ran on, with where it's set", async () => {
    const yard = createBoxYard(testConfig(), { webDir: "/nonexistent" })
    yards.push(yard)
    const own = yard.store.createProject({ name: "demo", env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-demo" } })
    const plain = yard.store.createProject({ name: "plain" })
    const a = yard.store.createTask({ projectId: own.id, title: "A", prompt: "go" })
    const b = yard.store.createTask({ projectId: plain.id, title: "B", prompt: "go" })
    await yard.tasks.apply(a.id, { seq: 0, ts: T, turnId: null, t: "limits", harness: "claude", info: CLAUDE_FIVE_HOUR.rate_limit_info })
    await yard.tasks.apply(b.id, { seq: 0, ts: T, turnId: null, t: "limits", harness: "codex", rateLimits: CODEX_TOKEN_COUNT.payload.rate_limits, at: T })
    const logins = limitsReport(yard.store, T).logins
    const fp = createHash("sha256").update("sk-ant-oat01-demo").digest("hex")
    expect(logins.map((l) => [l.loginId, l.source, l.scope, l.windows.length])).toEqual([
      [`lgn_cred-claude-${fp.slice(0, 8)}`, "demo's env vars", `project:${own.id}`, 1],
      ["lgn_local-codex", "This computer", "local", 2],
    ])
  })

  it("are kept for an added login the rotation handed the turn, under its own name", async () => {
    const yard = createBoxYard(testConfig({ claudeOauthToken: "sk-ant-oat01-settings" }), { webDir: "/nonexistent" })
    yards.push(yard)
    const added = yard.logins.add({ harness: "claude", label: "Work Max", value: "sk-ant-oat01-work-a1b2" })
    const project = yard.store.createProject({ name: "plain" })
    const task = yard.store.createTask({ projectId: project.id, title: "A", prompt: "go" })
    yard.store.startTaskTurn({ id: "turn_1", taskId: task.id, turnIndex: 0, model: null, effort: null, routingRule: null, routingReason: null, loginId: added.id })
    yard.store.updateTask(task.id, { currentTurnId: "turn_1" })
    await yard.tasks.apply(task.id, { seq: 0, ts: T, turnId: "turn_1", t: "limits", harness: "claude", info: CLAUDE_FIVE_HOUR.rate_limit_info })
    expect(limitsReport(yard.store, T).logins.map((l) => [l.loginId, l.source, l.scope])).toEqual([[added.id, "Work Max (…a1b2)", `login:${added.id}`]])
    // Removing the login takes its limits with it.
    yard.logins.remove(added.id)
    expect(limitsReport(yard.store, T).logins).toEqual([])
  })
})

describe("the meters' words", () => {
  const w = (o: Partial<LimitWindow>): LimitWindow => ({ window: "five_hour", label: "5-hour", minutes: 300, usedPct: 42, resetsAt: T + 2 * H, status: "allowed", asOf: T, ...o })

  it("say how much is used and when it resets, in the reader's zone", () => {
    expect(windowText(w({}), T, "UTC")).toEqual({ used: "42% used", reset: "Resets Today 12:00 PM (in 2h)" })
    expect(windowText(w({ usedPct: null, status: "rejected", resetsAt: T + 30 * 60_000 }), T, "UTC")).toEqual({ used: "at the limit", reset: "Resets Today 10:30 AM (in 30m)" })
    expect(windowText(w({ resetsAt: null }), T, "UTC").reset).toBe("Reset time not reported")
  })

  it("say when a window has reset since its reading", () => {
    expect(windowText(w({ resetsAt: T - H, asOf: T - 3 * H }), T, "UTC")).toEqual({ used: "reset since", reset: "Reset Today 9:00 AM. No run since to read it again" })
  })

  it("does not claim usage or a reset without a reading", () => {
    expect(windowText(w({ usedPct: null, resetsAt: null }), T, "UTC")).toEqual({ used: "Usage not reported", reset: "Reset time not reported" })
    expect(windowText(w({ resetsAt: null, asOf: T - 7 * H }), T, "UTC")).toEqual({ used: "reading expired", reset: "Last read 7h ago. No reset time was reported" })
  })

  it("never round a little use down to nothing", () => {
    expect([usedLabel(0), usedLabel(0.4), usedLabel(64.6), usedLabel(99.6), usedLabel(null)]).toEqual(["0%", "<1%", "64.6%", "99.6%", "—"])
  })
})
