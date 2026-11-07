#!/usr/bin/env node
// Grow a heavy mock yard to a long-lived yard's size, for scripts/perf/api-bench.mjs.
//
//   npm run build
//   node scripts/perf/api-seed-yard.mjs /tmp/heavy [tasks=500]
//
// Run it on a stopped server's data dir (an empty one gets the BOXYARD_MOCK_HEAVY seed first). Every added task
// has a 40-message transcript and 12 usage rows; a quarter have no summary yet (their card line comes from the
// transcript) and a fifth sit on one of six boxes. Nothing is queued, so the mock scheduler leaves them alone.
import fs from "node:fs"
import path from "node:path"

const dir = process.argv[2]
const total = Number(process.argv[3] ?? 500)
if (!dir) throw new Error("usage: node scripts/perf/api-seed-yard.mjs <data dir> [tasks]")
const dist = (file) => new URL(`../../dist/server/server/${file}`, import.meta.url).href
const { openDb } = await import(dist("db.js"))
const { Store } = await import(dist("store.js"))
const { seedHeavy } = await import(dist("mockHeavy.js"))

const db = openDb(dir)
const store = new Store(db)
seedHeavy(db, store)
const projects = store.listProjects()
const now = Date.now()
const statuses = ["done", "done", "done", "idle", "pr_ready", "failed", "needs_input", "waiting", "idle", "done"]
const boxes = Array.from({ length: 6 }, (_, b) => `box_yard${b}`)
const message = db.prepare("INSERT INTO task_messages (id, task_id, role, content, meta_json, created_at) VALUES (?, ?, ?, ?, NULL, ?)")
const usage = db.prepare(
  `INSERT INTO claude_usage (id, source, run_kind, task_id, project_id, session_id, model, started_at, ended_at, duration_ms,
     input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, total_tokens, cost_usd, reported_cost_usd)
   VALUES (?, 'task', 'turn', ?, ?, ?, 'claude-opus-5-5', ?, ?, 60000, 100, 2000, 50000, 1500, 53600, 0.4, 0.4)`,
)
db.transaction(() => {
  for (const id of boxes) {
    db.prepare("INSERT OR IGNORE INTO boxes (id, provider, status, created_at, last_used_at, size) VALUES (?, 'mock', 'running', ?, ?, 'medium')").run(id, now, now)
    // The mock provider keeps a box only while its folder exists.
    fs.mkdirSync(path.join(dir, "local-boxes", id), { recursive: true })
  }
  for (let i = store.listTaskRows().length; i < total; i++) {
    const project = projects[i % projects.length]
    const id = `task_yard-${String(i).padStart(4, "0")}`
    store.createTask({ id, projectId: project.id, title: `Yard task ${i}: tidy the ${["sidebar", "composer", "inbox", "scheduler"][i % 4]}`, prompt: "Make it better. ".repeat(20) })
    const status = statuses[i % statuses.length]
    store.updateTask(id, {
      status,
      turnCount: 1 + (i % 30),
      summary: i % 4 === 0 ? null : "Did the thing and opened a PR. ".repeat(6),
      prUrl: status === "pr_ready" || status === "done" ? `https://github.com/acme/box-yard/pull/${300 + i}` : null,
      branch: `yard-${i}`,
      boxId: i % 5 === 0 ? boxes[i % boxes.length] : null,
      contextTokens: 50_000,
      contextWindow: 200_000,
    })
    const start = now - 30 * 24 * 3600_000 + i * 3600_000
    for (let m = 0; m < 40; m++) message.run(`tm_yard${i}_${m}`, id, m % 3 ? "tool" : "assistant", m % 3 ? "Bash npm run typecheck" : "Working on it now.", start + m * 1000)
    for (let u = 0; u < 12; u++) usage.run(`cu_yard${i}_${u}`, id, project.id, `sess_${i}`, start + u * 60_000, start + (u + 1) * 60_000)
  }
})()
const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
console.log(JSON.stringify({ tasks: count("tasks"), task_messages: count("task_messages"), claude_usage: count("claude_usage"), boxes: count("boxes") }))
db.close()
