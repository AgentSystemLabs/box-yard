import { describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { buildSpend, priceRun, runHarness, type SpendRow } from "../server/spendBreakdown.js"
import { buildUsageLedger } from "../server/usageLedger.js"
import { SPEND_RUN_LIMIT, spendTokens, type SpendBreakdown, type SpendTotals } from "../shared/spendBreakdown.js"
import { tmpDir } from "./helpers.js"

// The $ in a task's or a Captain's header: every run under the model and harness it ran on, priced as the Usage page
// prices it, adding up to the total; a task's subtasks apart from its own runs.

const T0 = Date.UTC(2026, 10, 1)
const memStore = () => new Store(openDb(tmpDir(), ":memory:"))
const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0)
const tok = (input: number, cacheWrite: number, cacheRead: number, output: number) => ({ input_tokens: input, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, output_tokens: output })

function row(r: Partial<SpendRow>): SpendRow {
  return {
    id: `cu_${Math.random().toString(36).slice(2)}`,
    source: "task",
    runKind: "turn",
    projectId: "prj_a",
    taskId: "tsk_1",
    sessionId: null,
    model: "claude-opus-5-5",
    loginId: null,
    startedAt: T0,
    costUsd: 1,
    reportedUsd: 1,
    prevReportedUsd: null,
    costEstimated: false,
    inputTokens: 100,
    cacheCreationInputTokens: 200,
    cacheReadInputTokens: 3000,
    outputTokens: 40,
    harness: "claude",
    turnId: null,
    durationMs: 1000,
    ...r,
  }
}

/** Every way a breakdown adds up: by model to the total, runs to the total, and each part's tokens likewise. */
function expectAddsUp(parts: SpendTotals[], total: SpendTotals) {
  expect(sum(parts.map((p) => p.costUsd))).toBeCloseTo(total.costUsd, 9)
  expect(sum(parts.map((p) => p.estimatedUsd))).toBeCloseTo(total.estimatedUsd, 9)
  for (const k of ["inputTokens", "cacheWriteTokens", "cacheReadTokens", "outputTokens", "runs", "unpricedRuns"] as const) expect(sum(parts.map((p) => p[k]))).toBe(total[k])
}

function expectConsistent(b: SpendBreakdown) {
  expectAddsUp(b.byModel, b.total)
  if (b.total.runs <= SPEND_RUN_LIMIT) expect(sum(b.runs.map((r) => r.costUsd))).toBeCloseTo(b.total.costUsd, 9)
  if (b.subtasks) {
    expectAddsUp(b.subtasks.byModel, b.subtasks.total)
    expectAddsUp(b.subtasks.tasks, b.subtasks.total)
  }
}

describe("priceRun", () => {
  it("tells reported, estimated and unknown costs apart, and skips rows that aren't runs", () => {
    const rates = new Map([["s", 0.001]])
    expect(priceRun(row({ costUsd: 0.4, reportedUsd: 1.4 }), rates)).toEqual({ cost: "reported", costUsd: 0.4, repriced: false })
    // A step of $0 in a session that reported a total is still a reported cost.
    expect(priceRun(row({ costUsd: 0, reportedUsd: 1.4 }), rates)).toEqual({ cost: "reported", costUsd: 0, repriced: false })
    expect(priceRun(row({ costUsd: 0.2, costEstimated: true }), rates)).toEqual({ cost: "estimated", costUsd: 0.2, repriced: false })
    // Codex and Cursor report tokens but no cost.
    expect(priceRun(row({ costUsd: 0, reportedUsd: 0 }), rates)).toEqual({ cost: "unknown", costUsd: 0, repriced: false })
    expect(priceRun(row({ costUsd: 0, reportedUsd: 0, inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 }), rates)).toBeNull()
    // A dip in the CLI's running total booked as the run's cost: its tokens at the session's rate instead.
    const dip = row({ sessionId: "s", costUsd: 3, reportedUsd: 3, prevReportedUsd: 4 })
    expect(priceRun(dip, rates)).toEqual({ cost: "estimated", costUsd: 3340 * 0.001, repriced: true })
  })

  it("names the harness as logged, else the task's, else the model's", () => {
    const taskCli = new Map([["tsk_1", "cursor" as const]])
    expect(runHarness({ harness: "opencode", source: "task", taskId: "tsk_1", model: "x" }, taskCli)).toBe("opencode")
    expect(runHarness({ harness: null, source: "task", taskId: "tsk_1", model: "claude-opus-5-5-high" }, taskCli)).toBe("cursor")
    expect(runHarness({ harness: null, source: "task", taskId: "tsk_gone", model: "gpt-6.1-sol" }, taskCli)).toBe("claude")
    expect(runHarness({ harness: null, source: "captain", taskId: null, model: "gpt-6.1-sol" }, taskCli)).toBe("codex")
    expect(runHarness({ harness: null, source: "captain", taskId: null, model: "codex" }, taskCli)).toBe("codex")
    expect(runHarness({ harness: null, source: "orchestrator", taskId: null, model: "claude-sonnet-5-5" }, taskCli)).toBe("claude")
  })
})

describe("buildSpend", () => {
  it("groups runs by the model and harness each ran on, and the groups add up to the total", () => {
    const b = buildSpend({
      scope: "task",
      tasks: [{ id: "tsk_1", title: "Feature", agentCli: "codex" }],
      sessionRates: new Map(),
      turnIndex: new Map([["turn_1", 1], ["turn_2", 2]]),
      rows: [
        row({ startedAt: T0, costUsd: 1.5, model: "claude-opus-5-5", turnId: "turn_1" }),
        row({ startedAt: T0 + 1, costUsd: 0.5, model: "claude-sonnet-5-5", turnId: "turn_2" }),
        row({ startedAt: T0 + 2, costUsd: 0.25, model: "claude-opus-5-5", runKind: "compact", inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 }),
        row({ startedAt: T0 + 3, costUsd: 0.1, costEstimated: true, model: "claude-opus-5-5" }),
        // Continued on Codex: tokens, no cost. An older row without a harness takes the task's.
        row({ startedAt: T0 + 4, costUsd: 0, reportedUsd: 0, model: "gpt-6.1-sol", harness: null, outputTokens: 900 }),
        // Not a run: nothing to show and nothing to add.
        row({ startedAt: T0 + 5, costUsd: 0, reportedUsd: 0, inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 }),
      ],
    })
    expectConsistent(b)
    expect(b.total.costUsd).toBeCloseTo(2.35, 9)
    expect(b.total.estimatedUsd).toBeCloseTo(0.1, 9)
    expect(b.total.unpricedRuns).toBe(1)
    expect(b.total.runs).toBe(5)
    expect(b.byModel.map((m) => [m.model, m.harness, +m.costUsd.toFixed(2), m.runs])).toEqual([
      ["claude-opus-5-5", "claude", 1.85, 3],
      ["claude-sonnet-5-5", "claude", 0.5, 1],
      ["gpt-6.1-sol", "codex", 0, 1],
    ])
    // Newest first, each with its turn number, kind and how its cost is known.
    expect(b.runs.map((r) => [r.kind, r.turn, r.cost])).toEqual([
      ["turn", null, "unknown"],
      ["turn", null, "estimated"],
      ["compact", null, "reported"],
      ["turn", 2, "reported"],
      ["turn", 1, "reported"],
    ])
    expect(b.subtasks).toBeNull()
  })

  it("charges the same runs what the Usage page's ledger does, dips repriced", () => {
    const rows = [
      row({ sessionId: "s", startedAt: T0, costUsd: 4, reportedUsd: 4 }),
      row({ sessionId: "s", startedAt: T0 + 1, costUsd: 3, reportedUsd: 3, prevReportedUsd: 4 }),
      row({ sessionId: "s", startedAt: T0 + 2, costUsd: 0.5, reportedUsd: 3.5, prevReportedUsd: 3 }),
    ]
    const sessionRates = new Map([["s", 4.5 / (2 * 3340)]])
    const b = buildSpend({ scope: "task", tasks: [{ id: "tsk_1", title: "Feature", agentCli: null }], rows, sessionRates })
    const ledger = buildUsageLedger({ from: T0, to: T0 + 1000, days: [T0], claude: rows, sessionRates, intervals: [], pods: [], turns: [], names: { projects: {}, tasks: {}, boxes: {}, logins: {} }, rates: { upstashCpuHourUsd: { small: 0, medium: 0, large: 0 }, daytona: { vcpuHour: 0, memoryGibHour: 0 } } })
    expect(b.total.costUsd).toBeCloseTo(sum(ledger.llm.map((l) => l.costUsd)), 9)
    expect(b.total.estimatedUsd).toBeCloseTo(sum(ledger.llm.map((l) => l.estimatedUsd)), 9)
    expect(b.repriced).toEqual({ runs: 1, bookedUsd: 3, chargedUsd: expect.closeTo(3340 * sessionRates.get("s")!, 9) })
    expectConsistent(b)
  })

  it("keeps subtasks' runs apart from the task's own, every level of them", () => {
    const b = buildSpend({
      scope: "task",
      tasks: [
        { id: "tsk_1", title: "Parent", agentCli: null },
        { id: "tsk_2", title: "Child", agentCli: "codex" },
        { id: "tsk_3", title: "Grandchild", agentCli: null },
        { id: "tsk_4", title: "Idle child", agentCli: null },
      ],
      sessionRates: new Map(),
      rows: [
        row({ taskId: "tsk_1", costUsd: 2 }),
        row({ taskId: "tsk_2", costUsd: 0, reportedUsd: 0, model: "gpt-6.1-sol", harness: "codex" }),
        row({ taskId: "tsk_3", costUsd: 0.75, model: "claude-sonnet-5-5" }),
        row({ taskId: "tsk_3", costUsd: 0.25, model: "claude-sonnet-5-5" }),
      ],
    })
    expectConsistent(b)
    expect(b.total.costUsd).toBe(2)
    expect(b.total.runs).toBe(1)
    expect(b.runs).toHaveLength(1)
    expect(b.subtasks!.total.costUsd).toBe(1)
    expect(b.subtasks!.total.unpricedRuns).toBe(1)
    expect(b.subtasks!.tasks.map((t) => [t.title, t.costUsd, t.runs])).toEqual([
      ["Grandchild", 1, 2],
      ["Child", 0, 1],
      ["Idle child", 0, 0],
    ])
    expect(b.subtasks!.byModel.map((m) => [m.model, m.harness])).toEqual([
      ["claude-sonnet-5-5", "claude"],
      ["gpt-6.1-sol", "codex"],
    ])
  })

  it("lists the newest runs only, while the totals count them all", () => {
    const rows = Array.from({ length: SPEND_RUN_LIMIT + 5 }, (_, i) => row({ startedAt: T0 + i, costUsd: 0.01 }))
    const b = buildSpend({ scope: "captain", rows, sessionRates: new Map() })
    expect(b.runs).toHaveLength(SPEND_RUN_LIMIT)
    expect(b.runs[0]!.startedAt).toBe(T0 + SPEND_RUN_LIMIT + 4)
    expect(b.total.runs).toBe(SPEND_RUN_LIMIT + 5)
    expect(b.total.costUsd).toBeCloseTo((SPEND_RUN_LIMIT + 5) * 0.01, 9)
    expectAddsUp(b.byModel, b.total)
  })
})

describe("Store.taskSpend and Store.captainSpend", () => {
  it("charges each turn its own step of the CLI's running totals, under the model that turn used, adding up to the task's cost", () => {
    const store = memStore()
    const p = store.createProject({ name: "demo" })
    const task = store.createTask({ projectId: p.id, title: "Feature", prompt: "x", model: "claude-sonnet-5-5" })
    const child = store.createTask({ projectId: p.id, title: "Child", prompt: "y", agentCli: "codex", subtask: { parentId: task.id, rootId: task.id, depth: 1, withParent: true } })
    const other = store.createTask({ projectId: p.id, title: "Unrelated", prompt: "z" })
    store.startTaskTurn({ id: "turn_a", taskId: task.id, turnIndex: 1, model: "claude-opus-5-5", effort: null, routingRule: null, routingReason: null })
    store.startTaskTurn({ id: "turn_b", taskId: task.id, turnIndex: 2, model: "claude-sonnet-5-5", effort: null, routingRule: null, routingReason: null })
    // Two turns of one session: the CLI reports the session's running totals, $1.20 then $1.50.
    store.recordClaudeUsage({ source: "task", runKind: "turn", taskId: task.id, projectId: p.id, turnId: "turn_a", sessionId: "sess", model: "claude-opus-5-5", startedAt: T0, endedAt: T0 + 10, sessionUsage: tok(10, 100, 1000, 50), costUsd: 1.2, harness: "claude" })
    store.recordClaudeUsage({ source: "task", runKind: "turn", taskId: task.id, projectId: p.id, turnId: "turn_b", sessionId: "sess", model: "claude-sonnet-5-5", startedAt: T0 + 20, endedAt: T0 + 30, sessionUsage: tok(15, 150, 3000, 80), costUsd: 1.5, harness: "claude" })
    store.recordClaudeUsage({ source: "task", runKind: "turn", taskId: child.id, projectId: p.id, sessionId: "child", model: "gpt-6.1-sol", startedAt: T0 + 40, endedAt: T0 + 50, usage: tok(500, 0, 2000, 70), costUsd: null, harness: "codex" })
    store.recordClaudeUsage({ source: "task", runKind: "turn", taskId: other.id, projectId: p.id, sessionId: "other", startedAt: T0, endedAt: T0 + 1, usage: tok(1, 0, 0, 1), costUsd: 9 })

    const b = store.taskSpend(task.id)!
    expectConsistent(b)
    expect(b.total.costUsd).toBeCloseTo(1.5, 9)
    expect(b.total.costUsd).toBeCloseTo(store.getTask(task.id)!.claudeCostUsd, 9)
    expect(spendTokens(b.total)).toBe(store.getTask(task.id)!.claudeTokens)
    expect(b.byModel.map((m) => [m.model, +m.costUsd.toFixed(2), m.inputTokens, m.cacheWriteTokens, m.cacheReadTokens, m.outputTokens])).toEqual([
      ["claude-opus-5-5", 1.2, 10, 100, 1000, 50],
      ["claude-sonnet-5-5", 0.3, 5, 50, 2000, 30],
    ])
    expect(b.runs.map((r) => [r.turn, r.model, r.harness])).toEqual([
      [2, "claude-sonnet-5-5", "claude"],
      [1, "claude-opus-5-5", "claude"],
    ])
    expect(b.subtasks!.tasks).toEqual([expect.objectContaining({ taskId: child.id, title: "Child", costUsd: 0, unpricedRuns: 1, outputTokens: 70 })])
    expect(b.subtasks!.byModel[0]).toMatchObject({ model: "gpt-6.1-sol", harness: "codex" })

    // A subtask's own breakdown has no subtasks; an unknown task has none at all.
    expect(store.taskSpend(child.id)!.subtasks).toBeNull()
    expect(store.taskSpend("task_missing")).toBeNull()
  })

  it("is the project's Captain's spend only: its chat, compactions and side threads, older Captain rows included", () => {
    const store = memStore()
    const a = store.createProject({ name: "alpha" })
    const b = store.createProject({ name: "beta" })
    const t = store.createTask({ projectId: a.id, title: "Task", prompt: "x" })
    store.recordClaudeUsage({ source: "captain", runKind: "turn", projectId: a.id, sessionId: "cap", model: "claude-opus-5-5", startedAt: T0, endedAt: T0 + 1, usage: tok(10, 0, 0, 10), costUsd: 0.4, harness: "claude" })
    // The same session's running total, so the compaction's own share is $0.60.
    store.recordClaudeUsage({ source: "captain", runKind: "compact", projectId: a.id, sessionId: "cap", model: "claude-opus-5-5", startedAt: T0 + 2, endedAt: T0 + 3, costUsd: 1, harness: "claude" })
    store.recordClaudeUsage({ source: "captain", runKind: "thread", projectId: a.id, sessionId: "thr", model: "codex", startedAt: T0 + 4, endedAt: T0 + 5, usage: tok(300, 0, 100, 20), harness: "codex" })
    // Logged before "captain" existed: an orchestrator row with a project id, and no harness.
    store.recordClaudeUsage({ source: "orchestrator", runKind: "turn", projectId: a.id, sessionId: "old", model: "claude-sonnet-5-5", startedAt: T0 - 10, endedAt: T0 - 9, usage: tok(5, 0, 0, 5), costUsd: 0.05 })
    // Not this Captain's: another project's Captain, the Coordinator, and a task.
    store.recordClaudeUsage({ source: "captain", runKind: "turn", projectId: b.id, sessionId: "capb", startedAt: T0, endedAt: T0 + 1, usage: tok(1, 0, 0, 1), costUsd: 7 })
    store.recordClaudeUsage({ source: "orchestrator", runKind: "turn", sessionId: "coord", startedAt: T0, endedAt: T0 + 1, usage: tok(1, 0, 0, 1), costUsd: 8 })
    store.recordClaudeUsage({ source: "task", runKind: "turn", taskId: t.id, projectId: a.id, sessionId: "task", startedAt: T0, endedAt: T0 + 1, usage: tok(1, 0, 0, 1), costUsd: 9 })

    const spend = store.captainSpend(a.id)
    expectConsistent(spend)
    expect(spend.scope).toBe("captain")
    expect(spend.subtasks).toBeNull()
    expect(spend.total.costUsd).toBeCloseTo(1.05, 9)
    expect(spend.total.runs).toBe(4)
    expect(spend.total.unpricedRuns).toBe(1)
    expect(spend.runs.map((r) => [r.kind, r.model, r.harness, r.cost])).toEqual([
      ["thread", "codex", "codex", "unknown"],
      ["compact", "claude-opus-5-5", "claude", "reported"],
      ["turn", "claude-opus-5-5", "claude", "reported"],
      ["turn", "claude-sonnet-5-5", "claude", "reported"],
    ])
    expect(store.captainSpend(b.id).total.costUsd).toBe(7)
  })
})
