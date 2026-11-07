#!/usr/bin/env node
// Measure /api/stream traffic while a mock yard is busy: bytes and events per second, by event type.
//
//   npm run build
//   PORT=4000 BOXYARD_MOCK=1 BOXYARD_MOCK_HEAVY=1 BOXYARD_DATA_DIR=/tmp/<dir> node dist/server/server/index.js
//   node scripts/perf/sse-volume.mjs http://localhost:4000 [--tasks 8] [--chat 1]
//   node scripts/perf/sse-volume.mjs http://localhost:4000 --pulse 300
//
// It opens the stream as the web app does (?patches=1), starts `--tasks` fake-claude tasks (a slow turn that
// publishes an artifact) and `--chat` Coordinator messages, waits until the yard is quiet again, and prints JSON:
// totals plus a per-type table. `--pulse N` instead replays N task updates (POST /api/dev/pulse, BOXYARD_MOCK_HEAVY=1), like the
// usage updates a busy yard sends after every assistant message. `--verify` also opens a second stream without
// patches and checks that every task rebuilt from the first (whole, then patches) ends up as the second last sent it.
const base = (process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "http://localhost:4000").replace(/\/$/, "")
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? Number(process.argv[i + 1]) : dflt
}
const TASKS = arg("tasks", 8)
const CHATS = arg("chat", 1)
const QUIET_MS = arg("quiet", 3000)
const MAX_MS = arg("max", 120_000)
const PULSE = arg("pulse", 0)
const VERIFY = process.argv.includes("--verify")

const api = async (path, body) => {
  const res = await fetch(`${base}/api${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

// Each task as the stream last sent it, rebuilt like web/src/lib/stream.ts does (shared/taskPatch.ts); with --verify,
// also as a stream without patches last sent it.
const streamed = new Map()
const whole = new Map()
const byType = new Map()
let events = 0
let bytes = 0
let first = 0
let last = 0
const ac = new AbortController()

async function legacy() {
  const res = await fetch(`${base}/api/stream`, { signal: ac.signal })
  const decoder = new TextDecoder()
  let buf = ""
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true })
      let at
      while ((at = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, at)
        buf = buf.slice(at + 2)
        if (!frame.startsWith("data: ")) continue
        const ev = JSON.parse(frame.slice(6))
        if (ev.type === "task") whole.set(ev.task.id, ev.task)
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") throw err
  }
}

async function record() {
  const res = await fetch(`${base}/api/stream?patches=1`, { signal: ac.signal })
  const decoder = new TextDecoder()
  let buf = ""
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true })
      let at
      while ((at = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, at + 2)
        buf = buf.slice(at + 2)
        if (!frame.startsWith("data: ")) continue
        const size = Buffer.byteLength(frame)
        let type = "?"
        try {
          const ev = JSON.parse(frame.slice(6))
          type = ev.type
          if (ev.type === "task") streamed.set(ev.task.id, ev.task)
          else if (ev.type === "task.patch") {
            const task = { ...streamed.get(ev.id), ...ev.patch }
            for (const key of ev.unset ?? []) delete task[key]
            streamed.set(ev.id, task)
          }
        } catch {}
        const now = Date.now()
        if (!first) first = now
        last = now
        events++
        bytes += size
        const row = byType.get(type) ?? { events: 0, bytes: 0, max: 0 }
        row.events++
        row.bytes += size
        row.max = Math.max(row.max, size)
        byType.set(type, row)
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") throw err
  }
}

const recording = Promise.all([record(), VERIFY ? legacy() : null])
await new Promise((r) => setTimeout(r, 300))

const started = Date.now()
const created = []
if (PULSE) await api("/dev/pulse", { kind: "task", count: PULSE, intervalMs: 10 })
else await startWork()

async function startWork() {
  const projects = await api("/projects")
  const local = projects.filter((p) => !p.repo)
  if (!local.length) throw new Error("needs a project without a repo (the heavy mock seed has two)")
  // A realistic task prompt: real ones carry the brief, its context and the way to work (a few KB).
  const brief = "Find and fix one performance problem in your area, measure first, keep the diff small. ".repeat(40)
  for (let i = 0; i < TASKS; i++) {
    const p = local[i % local.length]
    created.push(await api("/tasks", { projectId: p.id, title: `SSE volume ${started}-${i}`, prompt: `[slow:4] [artifact] ${brief}`, runsOn: "local" }))
  }
  for (let i = 0; i < CHATS; i++) await api("/chat", { content: `status [slow] ${i}` })
}

// Wait until nothing has been sent for QUIET_MS (and every task we started left working/starting/queued).
const deadline = started + MAX_MS
for (;;) {
  await new Promise((r) => setTimeout(r, 500))
  const now = Date.now()
  if (now > deadline) break
  if (now - last < QUIET_MS) continue
  const tasks = await api("/tasks")
  const mine = tasks.filter((t) => created.some((c) => c.id === t.id))
  if (mine.every((t) => !["queued", "starting", "working"].includes(t.status))) break
}
ac.abort()
await recording.catch(() => {})

const seconds = Math.max(0.001, (last - first) / 1000)
const types = [...byType.entries()]
  .sort((a, b) => b[1].bytes - a[1].bytes)
  .map(([type, r]) => ({ type, events: r.events, bytes: r.bytes, avg: Math.round(r.bytes / r.events), max: r.max, share: `${((100 * r.bytes) / bytes).toFixed(1)}%` }))
let verified
if (VERIFY) {
  const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v)
  const ids = new Set([...streamed.keys(), ...whole.keys()])
  const wrong = [...ids].filter((id) => JSON.stringify(sorted(streamed.get(id))) !== JSON.stringify(sorted(whole.get(id))))
  verified = { tasks: ids.size, mismatched: wrong }
  if (wrong.length) process.exitCode = 1
}
console.log(JSON.stringify({ base, ...(PULSE ? { pulse: PULSE } : { tasks: TASKS, chats: CHATS }), ...(verified ? { verified } : {}), seconds: +seconds.toFixed(1), events, bytes, eventsPerSec: +(events / seconds).toFixed(1), bytesPerSec: Math.round(bytes / seconds), types }, null, 2))
