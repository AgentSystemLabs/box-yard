#!/usr/bin/env node
// Server API latency bench: time the GET endpoints the web app calls against a running server (heavy mock yard).
//
//   npm run build
//   node scripts/perf/api-seed-yard.mjs /tmp/heavy 500     (optional: grow the heavy yard to 500 tasks first)
//   PORT=4001 BOXYARD_MOCK=1 BOXYARD_MOCK_HEAVY=1 BOXYARD_DATA_DIR=/tmp/heavy node dist/server/server/index.js &
//   node scripts/perf/api-bench.mjs http://localhost:4001 [runs=25] [path regex]
//
// Each endpoint is fetched sequentially `runs` times after two warm-ups, uncompressed, so the time is the server's
// work plus localhost transfer. Prints a table, slowest median first, then the same rows as JSON.

const base = process.argv[2] ?? "http://localhost:4001"
const runs = Number(process.argv[3] ?? 25)
const only = process.argv[4] ? new RegExp(process.argv[4]) : null

const HEAVY_PROJECT = "prj_heavy-yard"
const HEAVY_TASK = "task_heavy-thread"
const PATHS = [
  "/api/health",
  "/api/me",
  "/api/projects",
  "/api/tasks",
  `/api/tasks?projectId=${HEAVY_PROJECT}`,
  `/api/tasks/${HEAVY_TASK}`,
  `/api/tasks/${HEAVY_TASK}/messages`,
  `/api/tasks/${HEAVY_TASK}/queue`,
  "/api/chat",
  "/api/orchestrator",
  "/api/settings",
  "/api/agent-settings",
  "/api/notifications?limit=50",
  "/api/boxes",
  "/api/cloud",
  "/api/usage",
  "/api/schedules",
  `/api/projects/${HEAVY_PROJECT}/captain`,
  `/api/projects/${HEAVY_PROJECT}/captain/messages`,
  "/api/captains/recent",
  "/api/threads",
  "/api/identities",
  "/api/setup",
  "/api/run-targets",
  "/api/harness-targets",
  "/api/models",
  "/api/hooks",
  "/api/artifacts",
  "/api/turn-timings",
  "/api/box-history",
]

const rows = []
for (const path of PATHS) {
  if (only && !only.test(path)) continue
  const times = []
  let bytes = 0
  let status = 0
  for (let i = 0; i < runs + 2; i++) {
    const t0 = performance.now()
    const res = await fetch(base + path, { headers: { "accept-encoding": "identity" } })
    const body = await res.arrayBuffer()
    const ms = performance.now() - t0
    status = res.status
    bytes = body.byteLength
    if (i >= 2) times.push(ms)
  }
  times.sort((a, b) => a - b)
  const at = (q) => +times[Math.min(times.length - 1, Math.floor(times.length * q))].toFixed(2)
  rows.push({ path, status, kb: +(bytes / 1024).toFixed(1), median: at(0.5), p95: at(0.95) })
}
rows.sort((a, b) => b.median - a.median)
console.table(rows)
console.log(JSON.stringify(rows))
