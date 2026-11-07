#!/usr/bin/env node
// Event-loop lag and CPU of the Node server under load, on the heavy mock yard.
//
//   npm run build
//   node scripts/perf/server-eld.mjs [--dist dist] [--port 4011] [--runs 3] [--seconds 30] [--tasks 20] [--clients 4]
//     [--extra-tasks 400]
//
// Each run starts its own mock server (BOXYARD_MOCK=1 BOXYARD_MOCK_HEAVY=1, a temp data dir, --port) with
// scripts/perf/eld-preload.mjs, which watches its event loop, and never touches a live one. The load:
//   --tasks        mock agents, a third with quick turns and the rest with 10–40 s ones, polled like real turns
//   --clients      browser-like clients, each holding /api/stream open and repeating the app's start-up requests every 5 s
//   SSE traffic    5 task messages every 250 ms (POST /api/dev/pulse)
//   --extra-tasks  finished tasks added before the start, like a long-lived yard's history
// It measures --seconds after a 3 s warm-up and prints each run and the medians as JSON. Compare builds with
// --dist pointing at another checkout's dist folder.
import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const dist = path.resolve(opt("dist", "dist"))
const port = Number(opt("port", "4011"))
const runs = Number(opt("runs", "3"))
const seconds = Number(opt("seconds", "30"))
const nTasks = Number(opt("tasks", "20"))
const nClients = Number(opt("clients", "4"))
const extraTasks = Number(opt("extra-tasks", "400"))
const preload = path.join(path.dirname(fileURLToPath(import.meta.url)), "eld-preload.mjs")
const base = `http://127.0.0.1:${port}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The heavy fixture plus `extraTasks` finished tasks with a turn of usage each, written before the server starts. */
async function seed(dataDir) {
  const mod = (f) => import(pathToFileURL(path.join(dist, "server/server", f)).href)
  const [{ openDb }, { Store }, { seedHeavy }] = await Promise.all([mod("db.js"), mod("store.js"), mod("mockHeavy.js")])
  const db = openDb(dataDir)
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
  db.close()
}

async function startServer(dataDir, eldOut) {
  const env = { ...process.env, PORT: String(port), HOST: "127.0.0.1", BOXYARD_MOCK: "1", BOXYARD_MOCK_HEAVY: "1", BOXYARD_DATA_DIR: dataDir, ELD_OUT: eldOut }
  delete env.BOXYARD_PASSWORD
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, path.join(dist, "server/server/index.js")], { env, stdio: ["ignore", "pipe", "pipe"] })
  let log = ""
  child.stdout.on("data", (d) => (log += d))
  child.stderr.on("data", (d) => (log += d))
  for (let i = 0; i < 300 && !/running on/.test(log); i++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${log}`)
    await sleep(100)
  }
  if (!/running on/.test(log)) throw new Error(`server didn't start: ${log}`)
  return child
}

async function timed(url, init) {
  const t0 = performance.now()
  const res = await fetch(base + url, init)
  await res.arrayBuffer()
  return performance.now() - t0
}
const post = (url, body) => timed(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

const START_UP = [
  "/api/health",
  "/api/orchestrator",
  "/api/settings",
  "/api/projects",
  "/api/tasks",
  "/api/chat",
  "/api/notifications",
  "/api/captains/recent",
  "/api/boxes",
  "/api/threads",
  "/api/tasks/task_heavy-thread",
  "/api/tasks/task_heavy-thread/messages",
]

const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] * 10) / 10 : null
}

async function run(n) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "box-yard-eld-"))
  const eldOut = path.join(dataDir, "eld.jsonl")
  await seed(dataDir)
  const server = await startServer(dataDir, eldOut)
  const streams = []
  const latencies = []
  let stop = false
  try {
    for (let i = 0; i < nTasks; i++) {
      const prompt = i % 3 === 0 ? "Quick job" : `Slow job [slow:${10 + (i % 4) * 10}]`
      await post("/api/tasks", { id: `task_bench-${n}-${i}`, projectId: i % 2 ? "prj_heavy-research" : "prj_heavy-recipes", title: `Bench ${i}`, prompt })
    }
    for (let c = 0; c < nClients; c++) streams.push(http.get(`${base}/api/stream`, (res) => res.resume()))
    const clients = Array.from({ length: nClients }, async (_, c) => {
      await sleep((c * 5000) / nClients)
      while (!stop) {
        latencies.push(...(await Promise.all(START_UP.map((u) => timed(u).catch(() => null)))).filter((x) => x !== null))
        await sleep(5000)
      }
    })
    const pulse = (async () => {
      while (!stop) {
        await post("/api/dev/pulse", { kind: "task.message", count: 5 }).catch(() => {})
        await sleep(250)
      }
    })()
    await sleep(3000)
    latencies.length = 0
    server.kill("SIGUSR2")
    await sleep(seconds * 1000)
    server.kill("SIGUSR2")
    const requests = latencies.slice()
    stop = true
    await Promise.all([...clients, pulse])
    await sleep(200)
    const eld = JSON.parse(fs.readFileSync(eldOut, "utf8").trim().split("\n").at(-1))
    return { ...eld, cpuPct: Math.round((eld.cpuMs / eld.wallMs) * 1000) / 10, requests: requests.length, reqP50: q(requests, 0.5), reqP95: q(requests, 0.95), reqMax: q(requests, 1) }
  } finally {
    stop = true
    for (const s of streams) s.destroy()
    server.kill("SIGTERM")
    for (let i = 0; i < 150 && server.exitCode === null && server.signalCode === null; i++) await sleep(100)
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL")
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

const results = []
for (let i = 0; i < runs; i++) {
  const r = await run(i)
  console.log(JSON.stringify({ run: i + 1, ...r }))
  results.push(r)
}
const median = Object.fromEntries(Object.keys(results[0]).map((k) => [k, q(results.map((r) => r[k]), 0.5)]))
console.log(JSON.stringify({ median, dist, tasks: nTasks, clients: nClients, extraTasks, seconds, node: process.version, cpus: os.cpus().length }))
