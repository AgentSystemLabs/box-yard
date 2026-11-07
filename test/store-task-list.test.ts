import { describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { tmpDir } from "./helpers.js"

/** A yard with a bit of everything a task card reads besides its row: spend, queued messages, activity, runners. */
function yard(tasksPerProject: number) {
  const db = openDb(tmpDir())
  const store = new Store(db)
  const boxes = store.createProject({ name: "boxes", repo: "a/b" })
  const local = store.createProject({ name: "local", repo: "a/c", runner: "local" })
  let n = 0
  for (const p of [boxes, local]) {
    for (let i = 0; i < tasksPerProject; i++) {
      const t = store.createTask({ projectId: p.id, title: `Task ${n++}`, prompt: "Do it" })
      if (i % 2) store.updateTask(t.id, { status: "idle", summary: "Finished" })
      else store.addTaskMessage(t.id, "tool", `Bash ${JSON.stringify({ command: `npm test ${i}` })}`)
      if (i % 3 === 0) {
        for (const k of [1, 2]) {
          store.recordClaudeUsage({
            source: "task",
            runKind: "turn",
            taskId: t.id,
            projectId: p.id,
            sessionId: `${t.id}-s`,
            startedAt: k,
            endedAt: k + 1,
            usage: { input_tokens: 10 * k, output_tokens: 5 },
            costUsd: 0.25 * k,
          })
        }
      }
      if (i % 4 === 0) {
        store.queueInput(t.id, "cody", "first")
        const second = store.queueInput(t.id, "cody", "second")
        store.cancelInput(t.id, second)
      }
      if (i % 5 === 0) {
        store.queueInput(t.id, "cody", "claimed")
        store.claimInputs(t.id, `turn-${t.id}`)
      }
    }
  }
  // Spend that isn't a task's (the Coordinator's) counts for none of them.
  store.recordClaudeUsage({ source: "orchestrator", runKind: "turn", startedAt: 1, endedAt: 2, usage: { input_tokens: 99 }, costUsd: 9 })
  return { db, store, projects: [boxes, local] }
}

/** How many statements `fn` prepares. */
function prepares(store: Store, fn: () => void): string[] {
  const sql: string[] = []
  const prepare = store.db.prepare.bind(store.db)
  store.db.prepare = ((s: string) => (sql.push(s), prepare(s))) as typeof store.db.prepare
  try {
    fn()
  } finally {
    store.db.prepare = prepare
  }
  return sql
}

describe("task list", () => {
  it("shows every task as getTask does", () => {
    const { store, projects } = yard(12)
    const all = store.listTasks()
    expect(all).toHaveLength(24)
    expect(all).toEqual(all.map((t) => store.getTask(t.id)))
    for (const p of projects) expect(store.listTasks({ projectId: p.id })).toEqual(all.filter((t) => t.projectId === p.id))

    // What the per-task lookups found, so the comparison above isn't between two empty answers.
    const [first] = all
    expect(first!.claudeCostUsd).toBe(0.5)
    expect(first!.claudeTokens).toBe(40)
    expect(first!.pendingCount).toBe(2)
    expect(first!.queueRev).toMatch(/^2\./)
    expect(first!.activity).toBe("Bash: npm test 0")
    expect(all.find((t) => t.summary)!.activity).toBeNull()
    expect(all.filter((t) => t.projectId === projects[1]!.id).every((t) => t.placement.projectRunner === "local")).toBe(true)
  })

  it("prepares the same few statements however many tasks there are", () => {
    const small = yard(5)
    const big = yard(40)
    const a = prepares(small.store, () => small.store.listTasks())
    const b = prepares(big.store, () => big.store.listTasks())
    expect(b.length).toBe(a.length)
    expect(b.length).toBeLessThan(10)
  })

  it("reads a task's spend from the index alone, in the list and for one task", () => {
    const { db, store } = yard(2)
    const [task] = store.listTasks()
    for (const run of [() => store.listTasks(), () => store.getTask(task!.id)]) {
      const spend = prepares(store, run).find((s) => /FROM claude_usage/.test(s))!
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${spend}`).all("[]") as { detail: string }[]).map((r) => r.detail).join("\n")
      expect(plan).toMatch(/USING COVERING INDEX claude_usage_task_spend/)
    }
    // A task's runs, newest first (a PR's last model), still come in index order.
    const latest = (db.prepare("EXPLAIN QUERY PLAN SELECT model FROM claude_usage WHERE task_id = ? ORDER BY started_at DESC LIMIT 1").all("x") as { detail: string }[])
      .map((r) => r.detail)
      .join("\n")
    expect(latest).toMatch(/USING INDEX claude_usage_task_spend/)
    expect(latest).not.toMatch(/TEMP B-TREE/)
  })
})
