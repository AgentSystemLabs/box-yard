#!/usr/bin/env node
// Per-call cost of the Store reads the server makes on every request and live update, on the heavy mock yard
// plus --extra-tasks finished tasks. Synchronous SQLite work blocks the event loop, so this is time no request,
// SSE write or turn poll can run.
//
//   npm run build
//   node scripts/perf/store-bench.mjs [--dist dist] [--extra-tasks 400] [--runs 5]
//
// Compare builds with --dist pointing at another checkout's dist folder. Prints the median ms per call as JSON.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const dist = path.resolve(opt("dist", "dist"))
const extraTasks = Number(opt("extra-tasks", "400"))
const runs = Number(opt("runs", "5"))
const mod = (f) => import(pathToFileURL(path.join(dist, "server/server", f)).href)
const [{ openDb }, { Store }, { seedHeavy, HEAVY_TASK_ID }] = await Promise.all([mod("db.js"), mod("store.js"), mod("mockHeavy.js")])

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-yard-store-bench-"))
try {
  const db = openDb(dir)
  const store = new Store(db)
  seedHeavy(db, store)
  const projects = store.listProjects()
  const now = Date.now()
  db.transaction(() => {
    for (let i = 0; i < extraTasks; i++) {
      const p = projects[i % projects.length]
      const t = store.createTask({ id: `task_hist-${String(i).padStart(4, "0")}`, projectId: p.id, title: `Finished task ${i}`, prompt: "Earlier work" })
      store.updateTask(t.id, { status: i % 4 ? "done" : "idle", summary: `Did thing ${i}.`, turnCount: 1 + (i % 9) })
      store.recordClaudeUsage({ source: "task", runKind: "turn", taskId: t.id, projectId: p.id, startedAt: now - 3_600_000, endedAt: now - 3_000_000, usage: { input_tokens: 1000, output_tokens: 500 }, costUsd: 0.05 })
    }
  })()

  const cases = {
    "listTasks()": [() => store.listTasks(), 50],
    "getTask(id)": [() => store.getTask("task_heavy-003"), 5000],
    "getTaskRow(id)": [() => store.getTaskRow("task_heavy-003"), 20000],
    "listProjects()": [() => store.listProjects(), 2000],
    "listTaskMessages(1000)": [() => store.listTaskMessages(HEAVY_TASK_ID, 1000), 50],
  }
  const result = {}
  for (const [name, [fn, n]] of Object.entries(cases)) {
    for (let i = 0; i < Math.min(n, 50); i++) fn()
    const per = []
    for (let r = 0; r < runs; r++) {
      const t0 = performance.now()
      for (let i = 0; i < n; i++) fn()
      per.push((performance.now() - t0) / n)
    }
    per.sort((a, b) => a - b)
    result[name] = Math.round(per[Math.floor(per.length / 2)] * 1000) / 1000
  }
  console.log(JSON.stringify({ msPerCall: result, tasks: store.listTaskRows().length, dist, node: process.version, cpus: os.cpus().length }))
  db.close()
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
