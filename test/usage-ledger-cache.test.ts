// The Usage modal's ledger keeps each past day (server/usageLedgerCache.ts). After every kind of write it must still
// read exactly what one pass over the whole range reads (Store.usageLedgerUncached), building again only the days
// the write touched.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { openDb, type DB } from "../server/db.js"
import { Store } from "../server/store.js"
import { SettingsStore } from "../server/settings.js"
import type { CostRates } from "../shared/types.js"
import type { UsageLedger } from "../shared/usageLedger.js"
import { tmpDir } from "./helpers.js"

const M = 60_000
const H = 3_600_000
const D = 24 * H
const T0 = Date.UTC(2026, 10, 1)
const DAYS = Array.from({ length: 5 }, (_, i) => T0 + i * D)
const TO = T0 + 4 * D + 12 * H
const NOW = T0 + 30 * D

let store: Store
let db: DB
let rates: CostRates
let built: ReturnType<typeof vi.fn>
let task1: string
let task2: string
let projectB: string

/** The ledger as the modal reads it, and which days (0-4) it had to build. */
function read(r = rates, livePods = new Set<string>()) {
  built.mockClear()
  const ledger = store.usageLedger(T0, TO, DAYS, r, livePods, NOW)
  return { ledger, built: built.mock.calls.map((c) => ((c[0] as number) - T0) / D) }
}

/** Same rows and names as the one-pass read, to the float's last digits (only the order of the sums differs). */
function expectSame(ledger: UsageLedger, r = rates, livePods = new Set<string>()) {
  const want = store.usageLedgerUncached(T0, TO, DAYS, r, livePods)
  const rows = (l: UsageLedger) =>
    new Map([
      ...l.llm.map((x) => [["llm", x.day, x.role, x.projectId, x.taskId, x.model, x.loginId].join("|"), x as object] as const),
      ...l.compute.map((x) => [["compute", x.day, x.provider, x.boxId, x.projectId, x.taskId].join("|"), x as object] as const),
    ])
  const got = rows(ledger)
  const exp = rows(want)
  expect([...got.keys()].sort()).toEqual([...exp.keys()].sort())
  for (const [key, row] of exp) {
    for (const [field, value] of Object.entries(row)) {
      const mine = (got.get(key) as Record<string, unknown>)[field]
      if (typeof value === "number") expect(mine, `${key} ${field}`).toBeCloseTo(value, 9)
      else expect(mine, `${key} ${field}`).toEqual(value)
    }
  }
  expect(ledger.repriced.runs).toBe(want.repriced.runs)
  expect(ledger.repriced.bookedUsd).toBeCloseTo(want.repriced.bookedUsd, 9)
  expect(ledger.repriced.chargedUsd).toBeCloseTo(want.repriced.chargedUsd, 9)
  expect({ ...ledger, llm: [], compute: [], repriced: null }).toEqual({ ...want, llm: [], compute: [], repriced: null })
}

const run = (input: { at: number; sessionId?: string; reported?: number; tokens?: number; taskId?: string | null; projectId?: string | null; source?: "task" | "orchestrator" }) =>
  store.recordClaudeUsage({
    source: input.source ?? "task",
    runKind: "turn",
    taskId: input.taskId ?? null,
    projectId: input.projectId ?? null,
    sessionId: input.sessionId ?? null,
    model: "claude-opus-5-5",
    startedAt: input.at,
    endedAt: input.at + M,
    usage: { input_tokens: input.tokens ?? 1000 },
    costUsd: input.reported ?? 0.5,
    loginId: "lgn_1",
  })

const turn = (id: string, taskId: string, startedAt: number, finishedAt: number | null, boxId: string | null) => {
  store.startTaskTurn({ id, taskId, turnIndex: 1, model: null, effort: null, routingRule: null, routingReason: null, boxId })
  db.prepare("UPDATE task_turns SET started_at = ?, finished_at = ? WHERE id = ?").run(startedAt, finishedAt, id)
}

const interval = (boxId: string, startedAt: number, endedAt: number) =>
  store.recordBoxUsageInterval({ boxId, provider: "upstash", size: "small", keepAlive: false, startedAt, endedAt, activeMs: (endedAt - startedAt) / 2, uptimeMs: endedAt - startedAt, source: "measured" })

beforeEach(() => {
  db = openDb(tmpDir(), ":memory:")
  store = new Store(db)
  rates = new SettingsStore(store, { orchestratorModel: "", workerModel: "", captainModel: "", captainEffort: "" }).get().costRates
  const a = store.createProject({ name: "Alpha" })
  const b = store.createProject({ name: "Beta" })
  projectB = b.id
  task1 = store.createTask({ projectId: a.id, title: "One", prompt: "x" }).id
  task2 = store.createTask({ projectId: b.id, title: "Two", prompt: "x" }).id

  // A box metered every 10 minutes for the whole range, and a 3-hour stretch over the first midnight on another.
  for (let t = T0; t < TO; t += 10 * M) interval("pure-lobster", t, t + 10 * M)
  interval("calm-otter", T0 + D - 2 * H, T0 + D + H)
  // Turns on it: one inside day 0, one over the second midnight, and task 1's current turn, from day 3 on, on no recorded box.
  turn("turn_1", task1, T0 + H, T0 + 5 * H, "pure-lobster")
  turn("turn_2", task2, T0 + D + 20 * H, T0 + 2 * D + 3 * H, "pure-lobster")
  turn("turn_3", task1, T0 + 3 * D + 6 * H, null, null)
  db.prepare("UPDATE tasks SET current_turn_id = 'turn_3' WHERE id = ?").run(task1)

  // A Coordinator session over days 0-3 whose day-2 run is booked from a dip in its running total; task runs too.
  run({ at: T0 + 2 * H, sessionId: "s1", reported: 10, tokens: 100_000, source: "orchestrator" })
  run({ at: T0 + D + 2 * H, sessionId: "s1", reported: 12, tokens: 20_000, source: "orchestrator" })
  run({ at: T0 + 2 * D + 2 * H, sessionId: "s1", reported: 11.5, tokens: 1000, source: "orchestrator" })
  run({ at: T0 + 3 * D + 2 * H, sessionId: "s1", reported: 13, tokens: 30_000, source: "orchestrator" })
  for (let d = 0; d < 5; d++) run({ at: T0 + d * D + 7 * H, taskId: task1, projectId: a.id })
  run({ at: T0 + D + 21 * H, taskId: task2, projectId: b.id })

  built = vi.spyOn(store as unknown as { ledgerDay: (...args: unknown[]) => unknown }, "ledgerDay") as unknown as ReturnType<typeof vi.fn>
  // Fill the cache: every day built once, then only the open last day.
  expect(read().built).toEqual([0, 1, 2, 3, 4])
})

describe("Store.usageLedger's kept days", () => {
  it("serve the past days and build only the open one", () => {
    const { ledger, built } = read()
    expect(built).toEqual([4])
    expectSame(ledger)
    expect(ledger.repriced.runs).toBe(1)
  })

  it("a run in a past day rebuilds that day", () => {
    run({ at: T0 + D + 9 * H, taskId: task1 })
    const { ledger, built } = read()
    expect(built).toEqual([1, 4])
    expectSame(ledger)
  })

  it("a run in a dip booking's session reprices the dip's day", () => {
    run({ at: T0 + 3 * D + 5 * H, sessionId: "s1", reported: 14, tokens: 50_000, source: "orchestrator" })
    const { ledger, built } = read()
    expect(built).toEqual([2, 3, 4])
    expectSame(ledger)
  })

  it("removing a session's earlier report rebuilds the days of its later runs", () => {
    // Without the $12 report the $11.50 one is no longer a dip, so day 2 changes though nothing of its own did.
    db.prepare("DELETE FROM claude_usage WHERE session_id = 's1' AND reported_cost_usd = 12").run()
    const { ledger, built } = read()
    expect(built).toEqual([1, 2, 3, 4])
    expectSame(ledger)
    expect(ledger.repriced.runs).toBe(0)
  })

  it("box time metered late rebuilds the days it overlaps", () => {
    interval("far-heron", T0 + 2 * D - H, T0 + 2 * D + H)
    const { ledger, built } = read()
    expect(built).toEqual([1, 2, 4])
    expectSame(ledger)
    expect(ledger.boxes["far-heron"]).toBeDefined()
  })

  it("finishing a turn that ran past midnight rebuilds every day it ran in", () => {
    db.prepare("UPDATE task_turns SET finished_at = ? WHERE id = 'turn_3'").run(T0 + 4 * D + 2 * H)
    db.prepare("UPDATE tasks SET current_turn_id = NULL WHERE id = ?").run(task1)
    const { ledger, built } = read()
    expect(built).toEqual([3, 4])
    expectSame(ledger)
  })

  it("a turn that stops being its task's current one no longer runs", () => {
    db.prepare("UPDATE task_turns SET box_id = 'pure-lobster' WHERE id = 'turn_3'").run()
    const before = read()
    expect(before.built).toEqual([3, 4])
    db.prepare("UPDATE tasks SET current_turn_id = NULL WHERE id = ?").run(task1)
    const { ledger, built } = read()
    expect(built).toEqual([3, 4])
    expectSame(ledger)
    expect(before.ledger.compute.some((r) => r.day === 3 && r.taskId === task1)).toBe(true)
    expect(ledger.compute.some((r) => r.day === 3 && r.taskId === task1)).toBe(false)
  })

  it("a probe naming the box of a turn that recorded none rebuilds its days", () => {
    const insert = db.prepare(
      "INSERT INTO turn_peaks (turn_id, project_id, task_id, box_id, box_size, at) VALUES ('turn_3', (SELECT project_id FROM tasks WHERE id = ?), ?, 'pure-lobster', 'small', ?)",
    )
    insert.run(task1, task1, T0 + 3 * D + 7 * H)
    const { ledger, built } = read()
    expect(built).toEqual([3, 4])
    expectSame(ledger)
    db.prepare("DELETE FROM turn_peaks WHERE turn_id = 'turn_3'").run()
    expect(read().built).toEqual([3, 4])
  })

  it("moving a task to another project rebuilds the days of its turns", () => {
    db.prepare("UPDATE tasks SET project_id = ? WHERE id = ?").run(projectB, task1)
    const { ledger, built } = read()
    expect(built).toEqual([0, 1, 2, 3, 4])
    expectSame(ledger)
  })

  it("deleting a task or a project reads what's left", () => {
    store.deleteTask(task2)
    let next = read()
    expect(next.built).toEqual([1, 2, 4])
    expectSame(next.ledger)
    store.deleteProject(projectB)
    next = read()
    expectSame(next.ledger)
  })

  it("renames show at once: names aren't kept", () => {
    db.prepare("UPDATE tasks SET title = 'Renamed' WHERE id = ?").run(task1)
    const { ledger, built } = read()
    expect(built).toEqual([4])
    expect(ledger.tasks[task1]!.title).toBe("Renamed")
  })

  it("other rates keep their own days", () => {
    const dearer = { ...rates, boxActiveCpuHourlyUsd: { ...rates.boxActiveCpuHourlyUsd, small: rates.boxActiveCpuHourlyUsd.small * 3 } }
    const { ledger, built } = read(dearer)
    expect(built).toEqual([0, 1, 2, 3, 4])
    expectSame(ledger, dearer)
    expect(read().built).toEqual([4])
  })

  it("GPU pods come from the box history every time", () => {
    const pod = "runpod-" + projectB
    db.prepare("INSERT INTO box_events (at, box_id, type, actor, detail, projects_json, task_ids_json) VALUES (?, ?, 'created', 'scheduler', ?, '[]', '[]')").run(T0 + D + 5 * H, pod, "A5000 at $0.27/hr")
    let next = read()
    expect(next.built).toEqual([4])
    expectSame(next.ledger)
    const live = new Set([pod])
    next = read(rates, live)
    expectSame(next.ledger, rates, live)
    expect(next.ledger.compute.filter((r) => r.provider === "runpod").length).toBeGreaterThan(1)
  })

  it("a write that maintain() reads first still rebuilds its day, and the log stays empty", () => {
    run({ at: T0 + 2 * D + 9 * H, taskId: task1 })
    store.syncUsageLedger()
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_changes").get()).toEqual({ n: 0 })
    const { ledger, built } = read()
    expect(built).toEqual([2, 4])
    expectSame(ledger)
  })

  it("warming keeps one past day a call, so the next request builds only the open day", () => {
    // Rates with no kept days yet, as after a restart.
    const cold = { ...rates, boxActiveCpuHourlyUsd: { ...rates.boxActiveCpuHourlyUsd, small: rates.boxActiveCpuHourlyUsd.small * 3 } }
    built.mockClear()
    const warmed = Array.from({ length: 6 }, () => store.warmUsageLedger(DAYS, cold, NOW))
    expect(warmed).toEqual([true, true, true, true, false, false])
    expect(built.mock.calls.map((c) => ((c[0] as number) - T0) / D)).toEqual([0, 1, 2, 3])
    const { ledger, built: after } = read(cold)
    expect(after).toEqual([4])
    expectSame(ledger, cold)
  })

  it("warming skips a day that isn't over, and reads writes first", () => {
    const cold = { ...rates, boxActiveCpuHourlyUsd: { ...rates.boxActiveCpuHourlyUsd, small: rates.boxActiveCpuHourlyUsd.small * 3 } }
    built.mockClear()
    while (store.warmUsageLedger(DAYS, cold, T0 + 2 * D + H));
    expect(built.mock.calls.map((c) => ((c[0] as number) - T0) / D)).toEqual([0, 1])
    run({ at: T0 + 9 * H, taskId: task1 })
    expect(store.warmUsageLedger(DAYS, cold, NOW)).toBe(true)
    const { ledger, built: after } = read(cold)
    expect(after).toEqual([2, 3, 4])
    expectSame(ledger, cold)
  })

  it("a second Store on the same database shares the kept days and what invalidates them", () => {
    const other = new Store(db)
    run({ at: T0 + D + 9 * H, taskId: task1 })
    other.syncUsageLedger()
    const { ledger, built } = read()
    expect(built).toEqual([1, 4])
    expectSame(ledger)
  })
})
