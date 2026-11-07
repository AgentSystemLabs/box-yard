// The task list's SQLite cost on a long-lived yard: Store.listTasks (GET /api/tasks, the Coordinator's yard view and
// named-task lookups, the scheduler's run history) and getTask (every live task update), on a seeded data dir with
// thousands of tasks, their transcripts, queued messages and usage rows. Rerun it before and after a change.
//
//   npx tsx scripts/perf/task-list-bench.ts [--tasks 3000] [--runs 15] [--keep]
//
// It seeds its own temp data dir (removed afterwards unless --keep) and never touches a live one.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { openDb } from "../../server/db.js"
import { Store } from "../../server/store.js"

const args = process.argv.slice(2)
const opt = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? Number(args[i + 1]) : fallback
}
const TASKS = opt("tasks", 3000)
const RUNS = opt("runs", 15)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-list-bench-"))
const db = openDb(dir)
const store = new Store(db)

// Deterministic data, so runs compare.
let seed = 42
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 2 ** 32)
const WORDS = "agent task branch worker preview schedule queue merge review compact context session archive deploy test build".split(" ")
const words = (n: number) => Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(" ")

const STATUSES = ["done", "done", "done", "idle", "idle", "pr_ready", "failed", "needs_input"]

const t0 = performance.now()
const projects = Array.from({ length: 25 }, (_, i) => store.createProject({ name: `bench-${i}`, repo: `bench/r${i}` }).id)
const addTask = db.prepare(
  `INSERT INTO tasks (id, project_id, title, prompt, status, session_id, summary, turn_count, created_at, updated_at, last_active_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
)
const addMessage = db.prepare("INSERT INTO task_messages (id, task_id, role, content, meta_json, created_at) VALUES (?, ?, ?, ?, NULL, ?)")
const addInput = db.prepare("INSERT INTO task_inputs (id, task_id, source, content, status, created_at, updated_at) VALUES (?, ?, 'cody', ?, ?, ?, ?)")
const addUsage = db.prepare(
  `INSERT INTO claude_usage (id, source, run_kind, task_id, project_id, session_id, started_at, ended_at, duration_ms,
    input_tokens, output_tokens, total_tokens, cost_usd, reported_cost_usd, raw_usage_json)
   VALUES (?, 'task', 'turn', ?, ?, ?, ?, ?, 60000, 2000, 3000, 5000, ?, ?, ?)`,
)
const rawUsage = JSON.stringify({ input_tokens: 2000, output_tokens: 3000, server_tool_use: { web_search_requests: 0 }, note: words(40) })
let messages = 0
db.transaction(() => {
  const start = Date.now() - 120 * 86_400_000
  for (let i = 0; i < TASKS; i++) {
    const id = `task_bench${String(i).padStart(6, "0")}`
    const projectId = projects[i % projects.length]!
    const at = start + i * 60_000
    const turns = 1 + Math.floor(rand() * 30)
    // A task gets its summary at its first turn's end; the few without one show their latest activity instead.
    addTask.run(id, projectId, words(6), words(60), STATUSES[Math.floor(rand() * STATUSES.length)], `ses-${i}`, rand() < 0.97 ? words(30) : null, turns, at, at, at)
    const n = rand() < 0.05 ? 2000 : 20 + Math.floor(rand() * 200)
    for (let k = 0; k < n; k++, messages++) {
      const r = rand()
      addMessage.run(`tm_${i}_${k}`, id, r < 0.6 ? "tool" : r < 0.9 ? "assistant" : "event", r < 0.6 ? `Bash {"command":"${words(6)}"}` : words(r < 0.9 ? 150 : 8), at + k * 1000)
    }
    if (rand() < 0.03) for (const status of ["queued", "queued", "cancelled"]) addInput.run(`in_${i}_${status}_${rand()}`, id, words(20), status, at, at)
    for (let k = 0; k < turns; k++) addUsage.run(`cu_${i}_${k}`, id, projectId, `ses-${i}`, at + k * 120_000, at + k * 120_000 + 60_000, 0.4, 0.4 * (k + 1), rawUsage)
  }
})()
db.pragma("wal_checkpoint(TRUNCATE)")
console.log(`seeded ${TASKS} tasks, ${messages} task messages in ${((performance.now() - t0) / 1000).toFixed(1)} s (${dir})`)

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!
const results: Record<string, number> = {}
function time(name: string, fn: () => unknown) {
  fn()
  const ms: number[] = []
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now()
    fn()
    ms.push(performance.now() - t)
  }
  results[name] = Number(median(ms).toFixed(2))
}
const ids = store.listTaskRows().slice(0, 100).map((r) => r.id)
time("listTasks()", () => store.listTasks())
time("listTasks({ projectId })", () => store.listTasks({ projectId: projects[0] }))
time("listTasks({ status: busy or waiting })", () => store.listTasks({ status: ["queued", "starting", "working", "needs_input", "waiting"] }))
time("getTask x 100", () => ids.forEach((id) => store.getTask(id)))

console.log(`median of ${RUNS} runs, ms (${os.arch()} ${os.cpus()[0]?.model ?? ""}, ${os.cpus().length} CPUs, node ${process.version})`)
for (const [name, ms] of Object.entries(results)) console.log(`${String(ms).padStart(9)}  ${name}`)
db.close()
if (!args.includes("--keep")) fs.rmSync(dir, { recursive: true, force: true })
