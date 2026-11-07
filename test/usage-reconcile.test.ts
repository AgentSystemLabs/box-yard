import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { MIGRATIONS, migrate, openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { SettingsStore } from "../server/settings.js"
import { buildUsagePeriod, type PeriodClaudeRow } from "../server/usagePeriod.js"
import { sessionUsageOf } from "../server/usage.js"
import type { UsagePeriodReport } from "../shared/types.js"
import { USAGE_CATEGORIES } from "../shared/types.js"
import { tmpDir } from "./helpers.js"

const H = 3_600_000
const D = 24 * H
const memStore = () => new Store(openDb(tmpDir(), ":memory:"))
const rates = () => new SettingsStore(memStore(), { orchestratorModel: "", workerModel: "", captainModel: "", captainEffort: "" }).get().costRates
const sum = (xs: { costUsd: number }[]) => xs.reduce((a, x) => a + x.costUsd, 0)

/** Every breakdown, the category split and the chart all add up to the period total. */
function expectReconciles(p: UsagePeriodReport) {
  for (const key of ["byProject", "byTask", "byModel", "byLogin", "bySource"] as const) expect(sum(p[key]), key).toBeCloseTo(p.totalCostUsd, 9)
  expect(USAGE_CATEGORIES.reduce((a, c) => a + p.categories[c].costUsd, 0)).toBeCloseTo(p.totalCostUsd, 9)
  expect(p.buckets.reduce((a, b) => a + USAGE_CATEGORIES.reduce((x, c) => x + b.costs[c], 0), 0)).toBeCloseTo(p.totalCostUsd, 9)
  expect(p.claude.costUsd + p.boxes.costUsd).toBeCloseTo(p.totalCostUsd, 9)
  expect(sum(p.boxList)).toBeCloseTo(p.boxes.costUsd, 9)
  for (const row of p.bySource) if (row.children?.length) expect(sum(row.children), `${row.key} children`).toBeCloseTo(row.costUsd, 9)
}

describe("per-run Claude cost", () => {
  it("charges each run the step in the session's running total, not the total", () => {
    const store = memStore()
    const t0 = Date.now()
    const run = (sessionId: string | null, reported: number, i: number, tokens = 1000) =>
      store.recordClaudeUsage({ source: "orchestrator", runKind: "turn", sessionId, startedAt: t0 + i, endedAt: t0 + i, usage: { input_tokens: tokens }, costUsd: reported })
    expect(run("s1", 1, 1)).toBe(1)
    expect(run("s1", 3, 2)).toBe(2)
    expect(run("s1", 3, 3, 0)).toBe(0) // a /context probe re-reports the same total
    expect(run("s1", 6, 4)).toBeCloseTo(3, 9)
    expect(run("s2", 0.5, 5)).toBe(0.5) // other sessions are independent
    expect(run("s1", 0.25, 6)).toBe(0.25) // total went down: its 1000 tokens at the recent rate, at most the report
    expect(run("s1", 1.25, 7)).toBe(1)
    expect(run(null, 2, 8)).toBe(2) // no session to compare with
    const rows = store.db.prepare("SELECT cost_usd AS c, reported_cost_usd AS r FROM claude_usage ORDER BY ended_at").all() as { c: number; r: number }[]
    expect(rows.map((r) => r.r)).toEqual([1, 3, 3, 6, 0.5, 0.25, 1.25, 2])
    expect(rows.reduce((a, r) => a + r.c, 0)).toBeCloseTo(1 + 2 + 0 + 3 + 0.5 + 0.25 + 1 + 2, 9)
  })

  it("charges a resumed session's first logged run its tokens, not the spend from before logging", () => {
    const store = memStore()
    const t0 = Date.now()
    const run = (sessionId: string, reported: number, tokens: number, resumed: boolean, i: number) =>
      store.recordClaudeUsage({ source: "task", runKind: "turn", sessionId, model: "m", startedAt: t0 + i, endedAt: t0 + i, usage: { input_tokens: tokens }, costUsd: reported, resumed })
    expect(run("fresh", 2, 1000, false, 1)).toBe(2) // a new session: its report is its cost, $0.002/token
    expect(run("old", 50, 500, true, 2)).toBeCloseTo(1, 9) // resumed, nothing logged before: 500 tokens at $0.002
    expect(run("old", 51.5, 100, true, 3)).toBeCloseTo(1.5, 9) // then exact steps again
    const flags = store.db.prepare("SELECT session_id AS s, cost_estimated AS e FROM claude_usage ORDER BY ended_at").all()
    expect(flags).toEqual([{ s: "fresh", e: 0 }, { s: "old", e: 1 }, { s: "old", e: 0 }])
    // With no rate to go on, the report stands.
    const empty = memStore()
    expect(empty.recordClaudeUsage({ source: "task", runKind: "turn", sessionId: "x", startedAt: t0, endedAt: t0, usage: { input_tokens: 10 }, costUsd: 7, resumed: true })).toBe(7)
  })

  it("a crash that reports $0 doesn't reset the baseline", () => {
    const store = memStore()
    const t0 = Date.now()
    const run = (reported: number, i: number) =>
      store.recordClaudeUsage({ source: "task", runKind: "turn", sessionId: "s", startedAt: t0 + i, endedAt: t0 + i, durationMs: 10, usage: { input_tokens: 10 }, costUsd: reported })
    run(2, 1)
    expect(run(0, 2)).toBe(0)
    expect(run(2.5, 3)).toBeCloseTo(0.5, 9)
  })
})

describe("per-run Claude tokens", () => {
  type Tokens = { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number }
  const tok = (input: number, write: number, read: number, output: number): Tokens => ({ input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output })
  const rowsOf = (store: Store) =>
    store.db
      .prepare("SELECT input_tokens AS i, cache_creation_input_tokens AS w, cache_read_input_tokens AS r, output_tokens AS o, total_tokens AS t, cost_usd AS c, cost_estimated AS e FROM claude_usage ORDER BY ended_at, rowid")
      .all() as { i: number; w: number; r: number; o: number; t: number; c: number; e: number }[]

  it("sums the CLI's modelUsage over models, and reads none from a Codex result's window-only entry", () => {
    const one = { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 20, webSearchRequests: 0, costUSD: 1, contextWindow: 200_000 }
    expect(sessionUsageOf({ opus: one, haiku: { ...one, inputTokens: 1 } })).toEqual(tok(11, 40, 200, 10))
    expect(sessionUsageOf({ codex: { contextWindow: 272_000 } })).toBeNull()
    expect(sessionUsageOf(undefined)).toBeNull()
  })

  it("counts a turn's compaction calls in its tokens, as its cost does, and charges each run its step", () => {
    const store = memStore()
    const t0 = Date.now()
    // The session's running totals ($1 per 1000 tokens), and what the main loop alone reported each run.
    const run = (i: number, main: Tokens, totals: Tokens, opts: { resumed?: boolean; session?: string } = {}) => {
      const usd = (totals.input_tokens + totals.cache_creation_input_tokens + totals.cache_read_input_tokens + totals.output_tokens) / 1000
      return store.recordClaudeUsage({ source: "task", runKind: "turn", sessionId: opts.session ?? "s", model: "m", startedAt: t0 + i, endedAt: t0 + i, usage: main, sessionUsage: totals, costUsd: usd, resumed: opts.resumed })
    }
    // Turn 1: 2000 main-loop tokens, and a compaction call (100 in, 200 written, 1500 read, 200 out) only the totals have.
    expect(run(1, tok(1000, 0, 0, 1000), tok(1100, 200, 1500, 1200))).toBeCloseTo(4, 9)
    // Turn 2 resumes: its step in every category.
    expect(run(2, tok(500, 100, 2000, 400), tok(1600, 300, 3500, 1600), { resumed: true })).toBeCloseTo(3, 9)
    // A /context probe re-reports the same totals: nothing.
    expect(run(3, tok(0, 0, 0, 0), tok(1600, 300, 3500, 1600), { resumed: true })).toBe(0)
    expect(rowsOf(store)).toEqual([
      { i: 1100, w: 200, r: 1500, o: 1200, t: 4000, c: 4, e: 0 },
      { i: 500, w: 100, r: 2000, o: 400, t: 3000, c: 3, e: 0 },
      { i: 0, w: 0, r: 0, o: 0, t: 0, c: 0, e: 0 },
    ])
  })

  // Runs of one session at $1 per 1000 tokens: `totals` are the CLI's running totals, `main` the main loop's usage.
  const sessionRuns = (store: Store) => {
    const t0 = Date.now()
    let i = 0
    return (session: string, main: Tokens, totals: Tokens | null, opts: { usd?: number; resumed?: boolean; runKind?: string } = {}) => {
      const usd = opts.usd ?? (totals ? (totals.input_tokens + totals.cache_creation_input_tokens + totals.cache_read_input_tokens + totals.output_tokens) / 1000 : 0)
      return store.recordClaudeUsage({ source: "orchestrator", runKind: opts.runKind ?? "turn", sessionId: session, model: "m", startedAt: t0 + ++i, endedAt: t0 + i, usage: main, sessionUsage: totals, costUsd: usd, resumed: opts.resumed ?? true })
    }
  }

  it("a dip from coming back to an older save charges the step from the report it still covers, not the whole total", () => {
    const store = memStore()
    const run = sessionRuns(store)
    expect(run("a", tok(100, 200, 1000, 700), tok(100, 200, 1000, 700), { resumed: false })).toBeCloseTo(2, 9)
    expect(run("a", tok(50, 100, 2000, 850), tok(150, 300, 3000, 1550))).toBeCloseTo(3, 9)
    // That process never saved its totals, so the next one continued from the first run's: $4 is below $5 but covers $2.
    expect(run("a", tok(20, 100, 1200, 380), tok(120, 300, 2500, 1080))).toBeCloseTo(2, 9)
    // Then steps from the new baseline.
    expect(run("a", tok(10, 0, 500, 490), tok(130, 300, 3000, 1570))).toBeCloseTo(1, 9)
    expect(rowsOf(store).slice(2)).toEqual([
      { i: 20, w: 100, r: 1500, o: 380, t: 2000, c: 2, e: 0 },
      { i: 10, w: 0, r: 500, o: 490, t: 1000, c: 1, e: 0 },
    ])
  })

  it("a drop to about zero is a restart: the totals are the run's own, in tokens and cost alike", () => {
    const store = memStore()
    const run = sessionRuns(store)
    expect(run("b", tok(5000, 20_000, 400_000, 75_000), tok(5000, 20_000, 400_000, 75_000), { resumed: false })).toBeCloseTo(500, 9)
    // A new box: the CLI's saved totals were gone, so it counted from zero. It covers no earlier report.
    expect(run("b", tok(300, 9000, 20_000, 500), tok(300, 9000, 30_000, 700))).toBeCloseTo(40, 9)
    expect(run("b", tok(100, 500, 20_000, 400), tok(400, 9500, 50_000, 1100))).toBeCloseTo(21, 9)
    expect(rowsOf(store).slice(1)).toEqual([
      { i: 300, w: 9000, r: 30_000, o: 700, t: 40_000, c: 40, e: 0 },
      { i: 100, w: 500, r: 20_000, o: 400, t: 21_000, c: 21, e: 0 },
    ])
  })

  it("a compaction-only run, whose main loop reported nothing, books the compaction's tokens and cost, after a restart too", () => {
    const store = memStore()
    const run = sessionRuns(store)
    const none = tok(0, 0, 0, 0)
    expect(run("c", tok(100, 0, 1000, 900), tok(100, 0, 1000, 900), { resumed: false })).toBeCloseTo(2, 9)
    expect(run("c", none, tok(140, 600, 3000, 2260), { runKind: "compact" })).toBeCloseTo(4, 9)
    expect(run("c", none, tok(40, 600, 2500, 1360), { runKind: "compact" })).toBeCloseTo(4.5, 9)
    expect(rowsOf(store).slice(1)).toEqual([
      { i: 40, w: 600, r: 2000, o: 1360, t: 4000, c: 4, e: 0 },
      { i: 40, w: 600, r: 2500, o: 1360, t: 4500, c: 4.5, e: 0 },
    ])
  })

  it("keeps the old rules where the totals can't tell: a resumed session's first run, and a drop after rows from before they were kept", () => {
    const store = memStore()
    const run = sessionRuns(store)
    // A fresh session sets the rate, $0.001 a token.
    expect(run("a", tok(1000, 0, 0, 0), tok(1000, 0, 0, 0), { resumed: false })).toBe(1)
    // A resumed session's first logged run: its main-loop tokens at the rate, not the $90 its transcript carried.
    expect(run("d", tok(50, 0, 0, 0), tok(90_000, 0, 0, 0))).toBeCloseTo(0.05, 9)
    // Its last row was logged before the totals were kept, so a dip ($4.80 after $5) books all of it, as before.
    expect(run("e", tok(10, 0, 0, 0), null, { usd: 5, resumed: false })).toBe(5)
    expect(run("e", tok(300, 0, 0, 0), tok(4800, 0, 0, 0))).toBeCloseTo(4.8, 9)
    // Then steps from that report on.
    expect(run("e", tok(200, 0, 0, 0), tok(5000, 0, 0, 0))).toBeCloseTo(0.2, 9)
    expect(rowsOf(store).map((r) => [r.t, r.e])).toEqual([[1000, 0], [50, 1], [10, 0], [4800, 0], [200, 0]])
  })

  it("the Coordinator and Captain lines, the projects and the period count compactions too, and still add up", () => {
    const store = memStore()
    const p = store.createProject({ name: "demo" })
    const now = Date.now()
    const runs: [Parameters<Store["recordClaudeUsage"]>[0]["source"], string | null][] = [["orchestrator", null], ["captain", p.id]]
    for (const [i, [source, projectId]] of runs.entries()) {
      // A turn whose compaction read 5000 cached tokens the main loop's usage doesn't show.
      store.recordClaudeUsage({ source, runKind: "turn", projectId, sessionId: `s${i}`, startedAt: now - 1000, endedAt: now - 1000, usage: tok(10, 0, 0, 10), sessionUsage: tok(20, 30, 5000, 50), costUsd: 1 })
    }
    const report = store.usageReport({ costRates: rates(), budget: { dailyUsd: 0, monthlyUsd: 0 } }, now, { from: now - H, to: now })
    for (const line of [report.orchestrator, report.captains]) {
      expect(line).toMatchObject({ costUsd: 1, inputTokens: 20, cacheCreationInputTokens: 30, cacheReadInputTokens: 5000, outputTokens: 50, totalTokens: 5100 })
    }
    expect(report.projects.find((x) => x.projectId === p.id)?.claude.totalTokens).toBe(5100)
    expect(report.period!.claude.totalTokens).toBe(10_200)
    expect(report.period!.categories.coordinator.tokens + report.period!.categories.captains.tokens).toBe(10_200)
    expectReconciles(report.period!)
  })
})

describe("usage migration", () => {
  it("turns logged running totals into per-run costs, keeps legacy Captain rows as Captain spend, and survives deletes", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    // Stop just before the usage reconcile migration, wherever later migrations put it.
    migrate(db, MIGRATIONS.findIndex((m) => m.includes("claude_usage_new")))
    const store = new Store(db)
    // An old-shaped project row: Store.createProject writes columns later migrations add.
    db.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('prj_demo01', 'demo', 1, 1)").run()
    const p = { id: "prj_demo01" }
    // Old-shaped task rows too: Store.createTask reads back columns later migrations add.
    const oldTask = (id: string, title: string) => {
      db.prepare("INSERT INTO tasks (id, project_id, title, prompt, status, session_id, created_at, updated_at, last_active_at) VALUES (?, ?, ?, ?, 'idle', ?, 1, 1, 1)").run(id, p.id, title, title, `${id}-s`)
      return { id }
    }
    const task = oldTask("tsk_reconcile1", "t")
    const older = oldTask("tsk_reconcile2", "older")
    // `older` had a turn before usage was logged, so its first logged turn resumed its session.
    db.prepare("INSERT INTO task_turns (id, task_id, turn_index, status, started_at) VALUES ('tt1', ?, 1, 'done', 10), ('tt2', ?, 2, 'done', 1005)").run(older.id, older.id)
    let n = 0
    const legacy = (source: string, session: string, reported: number, extra: { projectId?: string; taskId?: string } = {}) =>
      db
        .prepare(
          `INSERT INTO claude_usage (id, source, run_kind, task_id, project_id, session_id, started_at, ended_at, total_tokens, input_tokens, cost_usd)
           VALUES (?, ?, 'turn', ?, ?, ?, ?, ?, 100, 100, ?)`,
        )
        .run(`cu_${++n}`, source, extra.taskId ?? null, extra.projectId ?? null, session, 1000 + n, 1000 + n, reported)
    // The Coordinator's session was already $40 in when logging started.
    legacy("orchestrator", "coord", 40)
    legacy("orchestrator", "coord", 41.5)
    legacy("orchestrator", "coord", 41.5) // /context probe
    legacy("orchestrator", "coord", 43)
    legacy("orchestrator", "cap", 0.5, { projectId: p.id }) // Captain row from before source='captain'
    legacy("orchestrator", "cap", 0.75, { projectId: p.id })
    legacy("task", "task-s", 3, { projectId: p.id, taskId: task.id })
    legacy("task", "task-s", 5, { projectId: p.id, taskId: task.id })
    legacy("task", "older-s", 10, { projectId: p.id, taskId: older.id })
    migrate(db)

    const rows = db.prepare("SELECT source, cost_usd AS c, reported_cost_usd AS r, cost_estimated AS e FROM claude_usage ORDER BY ended_at").all() as { source: string; c: number; r: number; e: number }[]
    // Exact steps: 1.5 + 0 + 1.5 + 0.25 + 2 = $5.25 over 500 tokens, so $0.0105/token for the carried-over first runs.
    const est = 100 * (5.25 / 500)
    rows.forEach((r, i) => expect(r.c, `row ${i}`).toBeCloseTo([est, 1.5, 0, 1.5, 0.5, 0.25, 3, 2, est][i]!, 9))
    expect(rows.map((r) => r.e)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 1])
    expect(rows.map((r) => r.r)).toEqual([40, 41.5, 41.5, 43, 0.5, 0.75, 3, 5, 10])
    expect(rows.filter((r) => r.source === "captain")).toHaveLength(2)

    // New runs continue from the migrated running totals.
    expect(store.recordClaudeUsage({ source: "orchestrator", runKind: "turn", sessionId: "coord", startedAt: 2000, endedAt: 2000, usage: { input_tokens: 1 }, costUsd: 43.5 })).toBeCloseTo(0.5, 9)

    // Deleting the task and its project keeps the spend (it was ON DELETE CASCADE).
    const before = store.usagePeriod(0, 10_000, rates())
    store.deleteTask(task.id)
    store.deleteProject(p.id)
    const after = store.usagePeriod(0, 10_000, rates())
    expect(after.totalCostUsd).toBeCloseTo(before.totalCostUsd, 9)
    expect(after.categories.captains.costUsd).toBeCloseTo(0.75, 9)
    expect(after.categories.coordinator.costUsd).toBeCloseTo(est + 3.5, 9)
    expect(after.byProject.find((r) => r.key === "deleted")?.costUsd).toBeCloseTo(5.75 + est, 9)
    expectReconciles(after)
  })
})

describe("period report reconciliation", () => {
  /** A seeded yard: Coordinator, new and legacy Captain rows, ad-hoc tasks, schedule runs, probes, boxes, a deleted task. */
  function seeded() {
    const store = memStore()
    const now = Date.UTC(2026, 9, 23, 12)
    const from = now - 7 * D
    const a = store.createProject({ name: "alpha" })
    const b = store.createProject({ name: "beta" })
    const sch = store.createSchedule({ projectId: a.id, name: "PR Merger", cron: "0 * * * *", timezone: "UTC", prompt: "merge", nextRunAt: null })
    const t1 = store.createTask({ projectId: a.id, title: "Feature", prompt: "x", model: "claude-opus-5-5" })
    const t2 = store.createTask({ projectId: b.id, title: "Bug", prompt: "y", model: "claude-sonnet-5-5" })
    const gone = store.createTask({ projectId: b.id, title: "Deleted later", prompt: "z" })
    const truth = { coordinator: 0, captains: 0, agents: 0, schedules: 0 }
    let i = 0
    /** One session; `costs` are the true per-run costs. The CLI reports their running total. */
    const session = (cat: keyof typeof truth, opts: Partial<Parameters<Store["recordClaudeUsage"]>[0]> & { source: "task" | "orchestrator" | "captain" }, costs: number[], at: number) => {
      const id = `ses${++i}`
      let total = 0
      costs.forEach((c, k) => {
        total += c
        if (at + k * H >= from && at + k * H < now) truth[cat] += c
        store.recordClaudeUsage({ runKind: "turn", sessionId: id, model: "claude-opus-5-5", startedAt: at + k * H, endedAt: at + k * H + 60_000, usage: c ? { input_tokens: 1000, output_tokens: 100 } : null, durationMs: 60_000, costUsd: total, ...opts })
      })
    }
    // Coordinator: one session started before the period, with a /context probe (cost step 0) between turns.
    session("coordinator", { source: "orchestrator" }, [0.4, 0.6, 0, 0.8, 0, 1.1], from - 2 * H)
    session("captains", { source: "captain", projectId: a.id }, [0.2, 0.3], from + D)
    session("captains", { source: "orchestrator", projectId: b.id }, [0.15, 0.25], from + 2 * D) // legacy Captain rows
    session("agents", { source: "task", taskId: t1.id, projectId: a.id }, [2, 1.5, 3], from + 3 * D)
    session("agents", { source: "task", taskId: t2.id, projectId: b.id, model: "claude-sonnet-5-5" }, [0.9], from + 4 * D)
    session("agents", { source: "task", taskId: gone.id, projectId: b.id }, [1.2, 0.3], from + 5 * D)
    for (let k = 0; k < 5; k++) {
      const run = store.createTask({ projectId: a.id, title: `PR Merger run ${k}`, prompt: "merge", scheduleId: sch.id })
      session("schedules", { source: "task", taskId: run.id, projectId: a.id }, [0.25], from + k * D + 6 * H)
    }
    store.deleteTask(gone.id)
    // Boxes: one interval straddles the period start, so only its in-period half counts.
    store.upsertBox({ id: "box-a", provider: "local", status: "ready", created_at: from - D, last_used_at: now, size: "small", keep_alive: 0 })
    store.recordBoxUsageInterval({ boxId: "box-a", provider: "local", size: "small", keepAlive: false, startedAt: from - H, endedAt: from + H, activeMs: 2 * H, uptimeMs: 2 * H, source: "estimated" })
    store.recordBoxUsageInterval({ boxId: "box-a", provider: "local", size: "small", keepAlive: false, startedAt: from + 2 * D, endedAt: from + 2 * D + 3 * H, activeMs: 3 * H, uptimeMs: 3 * H, source: "estimated" })
    store.recordBoxUsageInterval({ boxId: "box-gone", provider: "local", size: "medium", keepAlive: true, startedAt: from + D, endedAt: from + D + 2 * H, activeMs: H, uptimeMs: 2 * H, diskBytes: 2 * 1024 ** 3, source: "estimated" })
    return { store, from, now, truth, a, b, sch, t1 }
  }

  it("every breakdown sums to the period total, with no double counting", () => {
    const { store, from, now, truth, a, b, sch, t1 } = seeded()
    const r = rates()
    const p = store.usagePeriod(from, now, r)
    expectReconciles(p)

    // Claude spend is the true per-run costs, not the sum of running totals.
    expect(p.categories.coordinator.costUsd).toBeCloseTo(truth.coordinator, 9)
    expect(p.categories.captains.costUsd).toBeCloseTo(truth.captains, 9)
    expect(p.categories.agents.costUsd).toBeCloseTo(truth.agents, 9)
    expect(p.categories.schedules.costUsd).toBeCloseTo(truth.schedules, 9)
    expect(p.claude.costUsd).toBeCloseTo(truth.coordinator + truth.captains + truth.agents + truth.schedules, 9)

    // The Coordinator's first run started before the period; its probes aren't turns.
    expect(p.categories.coordinator.turns).toBe(2)
    // Box cost: half of the straddling interval (1h active) + 3h, plus the deleted medium box.
    const smallHour = r.boxActiveCpuHourlyUsd.small
    expect(p.boxList.find((x) => x.boxId === "box-a")!.costUsd).toBeCloseTo(4 * smallHour, 9)
    expect(p.boxList.find((x) => x.boxId === "box-gone")!.live).toBe(false)

    // Projects include their tasks, schedule runs and Captain; the Coordinator is its own row.
    const proj = (id: string) => p.byProject.find((x) => x.key === id)!
    expect(proj(a.id).costUsd).toBeCloseTo(0.5 + 6.5 + 1.25, 9)
    expect(proj(b.id).costUsd).toBeCloseTo(0.4 + 0.9 + 1.5, 9)
    expect(proj("coordinator").other).toBe(true)
    expect(p.byProject.at(-1)!.key).toBe("boxes")

    // Tasks link to their task; the deleted task's spend stays on a "Deleted tasks" row.
    expect(p.byTask.find((x) => x.key === t1.id)).toMatchObject({ href: `/tasks/${t1.id}`, turns: 3, label: "Feature" })
    expect(p.byTask.find((x) => x.key === "deleted")!.costUsd).toBeCloseTo(1.5, 9)

    // Schedule runs group under their schedule.
    const schedules = p.bySource.find((x) => x.key === "schedules")!
    expect(schedules.children).toEqual([expect.objectContaining({ key: `schedule:${sch.id}`, label: "PR Merger", runs: 5, turns: 5, href: `/schedules#${sch.id}` })])
    expect(p.byModel.find((x) => x.key === "claude-sonnet-5-5")!.costUsd).toBeCloseTo(0.9, 9)
  })

  it("splits runs by the login they used, naming removed and Credentials logins too", () => {
    const store = memStore()
    const db = (store as unknown as { db: Database.Database }).db
    const t0 = Date.now() - H
    db.prepare("INSERT INTO agent_logins (id, harness, label, kind, ciphertext, fingerprint, last4, created_at, updated_at, removed_at) VALUES (?, 'claude', ?, 'oauth_token', '', ?, ?, 0, 0, ?)").run("lgn_a", "Work Max", "lgn_a", "a1b2", null)
    db.prepare("INSERT INTO agent_logins (id, harness, label, kind, ciphertext, fingerprint, last4, created_at, updated_at, removed_at) VALUES (?, 'claude', ?, 'oauth_token', '', ?, ?, 0, 0, ?)").run("lgn_b", "Old Pro", "lgn_b", "c3d4", 1)
    db.prepare("INSERT INTO agent_login_status (login_id, state, label, last4, updated_at) VALUES (?, 'ok', 'Credentials', 'e5f6', 0)").run("lgn_cred-claude-abc")
    const run = (i: number, cost: number, loginId: string | null) =>
      store.recordClaudeUsage({ source: "orchestrator", runKind: "turn", sessionId: `s${i}`, startedAt: t0 + i, endedAt: t0 + i, usage: { input_tokens: 10 }, costUsd: cost, loginId })
    run(1, 1, "lgn_a")
    run(2, 2, "lgn_a")
    run(3, 0.5, "lgn_b")
    run(4, 0.25, "lgn_cred-claude-abc")
    run(5, 4, null)
    const p = store.usagePeriod(t0, Date.now() + 1, rates())
    expectReconciles(p)
    const login = (key: string) => p.byLogin.find((x) => x.key === key)
    expect(login("lgn_a")).toMatchObject({ label: "Work Max (…a1b2)", turns: 2, costUsd: 3 })
    expect(login("lgn_b")).toMatchObject({ label: "Old Pro (…c3d4)", costUsd: 0.5 })
    expect(login("lgn_cred-claude-abc")).toMatchObject({ label: "Credentials (…e5f6)", costUsd: 0.25 })
    expect(login("usual")).toMatchObject({ other: true, costUsd: 4 })
  })

  it("reconciles for any sub-range, and the ranges add up", () => {
    const { store, from, now } = seeded()
    const r = rates()
    const mid = from + 3.5 * D
    const left = store.usagePeriod(from, mid, r)
    const right = store.usagePeriod(mid, now, r)
    const whole = store.usagePeriod(from, now, r)
    for (const p of [left, right, whole]) expectReconciles(p)
    expect(left.totalCostUsd + right.totalCostUsd).toBeCloseTo(whole.totalCostUsd, 9)
  })

  it("the old all-time fields use per-run costs too", () => {
    const { store, now, truth } = seeded()
    const report = store.usageReport({ costRates: rates(), budget: { dailyUsd: 0, monthlyUsd: 0 } }, now)
    expect(report.period).toBeUndefined()
    // All-time includes the Coordinator's two runs from before the 7-day period.
    expect(report.orchestrator.costUsd).toBeCloseTo(truth.coordinator + 1, 9)
  })
})

describe("buildUsagePeriod", () => {
  const row = (over: Partial<PeriodClaudeRow>): PeriodClaudeRow => ({
    source: "task",
    projectId: "p",
    projectName: "P",
    taskId: "t",
    taskTitle: "T",
    scheduleId: null,
    scheduleName: null,
    model: "m",
    startedAt: 0,
    durationMs: 0,
    costUsd: 1,
    inputTokens: 10,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    totalTokens: 10,
    ...over,
  })

  it("buckets by hour for a day and by day beyond that, splitting box intervals across buckets", () => {
    const day = buildUsagePeriod({ from: 0, to: D, claude: [row({ startedAt: 90 * 60_000 })], intervals: [], liveBoxes: [] })
    expect(day.bucketMs).toBe(H)
    expect(day.buckets).toHaveLength(24)
    expect(day.buckets[1]!.costs.agents).toBe(1)

    const week = buildUsagePeriod({
      from: 0,
      to: 7 * D,
      claude: [row({ startedAt: -1 }), row({ startedAt: 7 * D })], // both outside [from, to)
      intervals: [{ boxId: "b", size: "small", keepAlive: false, startedAt: D - H, endedAt: D + H, activeMs: 2 * H, uptimeMs: 2 * H, diskBytes: null, costUsd: 2, source: "estimated" }],
      liveBoxes: [],
    })
    expect(week.bucketMs).toBe(D)
    expect(week.claude.costUsd).toBe(0)
    expect(week.buckets[0]!.costs.boxes).toBeCloseTo(1, 9)
    expect(week.buckets[1]!.costs.boxes).toBeCloseTo(1, 9)
    expectReconciles(week)
  })

  it("labels categories by source: Coordinator, Captains (new and legacy), agents, schedule runs", () => {
    const p = buildUsagePeriod({
      from: 0,
      to: D,
      claude: [
        row({ source: "orchestrator", projectId: null, taskId: null }),
        row({ source: "orchestrator", taskId: null, costUsd: 2 }),
        row({ source: "captain", taskId: null, costUsd: 4 }),
        row({ costUsd: 8 }),
        row({ scheduleId: "s", scheduleName: "S", costUsd: 16 }),
      ],
      intervals: [],
      liveBoxes: [],
    })
    expect(p.categories.coordinator.costUsd).toBe(1)
    expect(p.categories.captains.costUsd).toBe(6)
    expect(p.categories.agents.costUsd).toBe(8)
    expect(p.categories.schedules.costUsd).toBe(16)
    expectReconciles(p)
  })
})
