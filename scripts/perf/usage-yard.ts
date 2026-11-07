// Seeds a mock data dir with months of usage, for timing the Usage modal against a real server
// (scripts/perf/usage-modal.mjs): projects, schedules and thousands of done tasks; their turns, each on a box; a
// claude_usage row per turn plus Captain and Coordinator runs, with sessions' running totals (and a few dips, so the
// repricing path runs); logins; Upstash boxes metered every 20 s while up, with their box history; and two RunPod
// pods. Deterministic: the same flags seed the same rows. It never touches a data dir that already has a database.
//
//   npx tsx scripts/perf/usage-yard.ts --dir /tmp/usage-yard [--days 90] [--tasks 4000] [--turns-per-task 6]
//     [--captain-per-day 600] [--coordinator-per-day 300] [--boxes 8] [--uptime 0.7] [--meter-s 20] [--now <ms>]
//   PORT=4011 BOXYARD_MOCK=1 BOXYARD_MOCK_HEAVY=1 BOXYARD_DATA_DIR=/tmp/usage-yard node dist/server/server/index.js
//
// The newest 59 tasks are named task_heavy-001…059, so BOXYARD_MOCK_HEAVY's POST /api/dev/pulse {kind:"task"} sends
// live task updates for them (the heavy fixture itself only seeds an empty data dir, so it stays out).
import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { MIGRATIONS, migrate } from "../../server/db.js"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const opt = (name: string, fallback: number) => (flag(name) === undefined ? fallback : Number(flag(name)))
const dir = flag("--dir")
if (!dir) throw new Error("--dir <data dir> is required")
const file = path.join(dir, "box-yard.sqlite")
if (fs.existsSync(file)) throw new Error(`${file} already exists: seed a fresh dir`)
const days = opt("--days", 90)
const taskCount = opt("--tasks", 4000)
const turnsPerTask = opt("--turns-per-task", 6)
const captainPerDay = opt("--captain-per-day", 600)
const coordinatorPerDay = opt("--coordinator-per-day", 300)
const boxCount = opt("--boxes", 8)
const uptime = opt("--uptime", 0.7)
const meterMs = opt("--meter-s", 20) * 1000
const now = opt("--now", Date.now())

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const start = now - days * DAY

fs.mkdirSync(dir, { recursive: true })
const db = new Database(file)
db.pragma("journal_mode = WAL")
db.pragma("synchronous = OFF")
db.pragma("foreign_keys = ON")
migrate(db)

// A deterministic PRNG, so every run seeds the same rows.
let seed = 42
const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31)
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!
const between = (a: number, b: number) => a + Math.floor(rand() * (b - a))

const t0 = performance.now()
const projects = Array.from({ length: 12 }, (_, i) => ({ id: `prj_usage${String(i).padStart(2, "0")}`, name: ["box-yard", "keep-the-castle", "nebula", "recipes", "weather", "garden", "site", "research", "docs", "infra", "mobile", "billing"][i]! }))
const logins = ["lgn_usage-main", "lgn_usage-second", "lgn_usage-third"]
const models = ["claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "gpt-5.5-codex"]
const boxes = Array.from({ length: boxCount }, (_, i) => ({ id: `box-usage-${i}`, name: `yard-${["amber", "birch", "cedar", "dune", "elm", "fern", "grove", "heath", "iris", "jade"][i % 10]}-${i}`, size: i % 3 === 0 ? "large" : "medium" }))
const pods = [
  { id: `runpod-${projects[2]!.id}`, usd: 0.44, from: start + 20 * DAY, to: start + 23 * DAY },
  { id: `runpod-${projects[2]!.id}-2`, usd: 0.79, from: now - 4 * DAY, to: now - 2 * DAY },
]

// Each box's up stretches: a few hours to a day up, then down for a while, about `uptime` of the time.
const upStretches = boxes.map(() => {
  const out: { from: number; to: number }[] = []
  for (let t = start + between(0, 6) * HOUR; t < now; ) {
    const up = between(3, 30) * HOUR
    out.push({ from: t, to: Math.min(now - between(1, 5) * meterMs, t + up) })
    t += up + Math.round((up * (1 - uptime)) / uptime) * (0.5 + rand())
  }
  return out
})

let turnCount = 0
let runCount = 0
let intervalCount = 0
db.transaction(() => {
  const p = db.prepare("INSERT INTO projects (id, name, repo, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
  for (const x of projects) p.run(x.id, x.name, `owner/${x.name}`, start, start)
  const s = db.prepare("INSERT INTO schedules (id, project_id, name, cron, timezone, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
  for (let i = 0; i < 4; i++) s.run(`sch_usage${i}x`, projects[i]!.id, `Nightly ${i}`, "0 3 * * *", "UTC", "run", start, start)
  const l = db.prepare("INSERT INTO agent_logins (id, harness, label, kind, ciphertext, fingerprint, last4, position, created_at, updated_at) VALUES (?, 'claude', ?, 'oauth', '', ?, ?, ?, ?, ?)")
  logins.forEach((id, i) => l.run(id, ["Main", "Second", "Third"][i], `fp${i}`, `00${i}${i}`, i, start, start))

  const task = db.prepare(
    `INSERT INTO tasks (id, project_id, title, prompt, status, session_id, schedule_id, created_at, updated_at, last_active_at)
     VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?, ?)`,
  )
  const touch = db.prepare("UPDATE tasks SET updated_at = ?, last_active_at = ? WHERE id = ?")
  const turn = db.prepare("INSERT INTO task_turns (id, task_id, turn_index, model, status, started_at, finished_at, cost_usd, login_id, box_id) VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?, ?)")
  const usage = db.prepare(
    `INSERT INTO claude_usage (id, source, run_kind, task_id, project_id, turn_id, session_id, model, started_at, ended_at, duration_ms,
      input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, total_tokens, cost_usd, reported_cost_usd, cost_estimated, login_id, raw_usage_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
  )
  // One CLI run. `session` carries the running total the CLI reports; a run's cost is the step from the last report.
  const run = (r: { source: string; kind: string; taskId: string | null; projectId: string | null; turnId: string | null; session: { id: string; total: number }; model: string; at: number; ms: number; login: string | null }) => {
    const input = between(200, 3000)
    const cacheW = between(1000, 40_000)
    const cacheR = between(10_000, 400_000)
    const output = between(200, 8000)
    const step = Math.round((input * 5 + cacheW * 6.25 + cacheR * 0.5 + output * 25) / 10) / 100_000
    let reported = r.session.total + step
    let cost = step
    // About one run in 300 reports a small dip in the running total, which the booking took as the whole total.
    if (r.session.total > 0 && rand() < 1 / 300) {
      reported = r.session.total * (0.6 + rand() * 0.35)
      cost = reported
    }
    r.session.total = reported
    usage.run(`cu_usage${runCount++}`, r.source, r.kind, r.taskId, r.projectId, r.turnId, r.session.id, r.model, r.at, r.at + r.ms, r.ms, input, cacheW, cacheR, output, input + cacheW + cacheR + output, cost, reported, rand() < 0.01 ? 1 : 0, r.login)
  }

  // Tasks start evenly over the range; their turns follow each other with gaps, each on a box that was up then.
  for (let i = 0; i < taskCount; i++) {
    const project = projects[i % projects.length]!
    const created = start + Math.floor((i / taskCount) * (days * DAY - 2 * HOUR))
    const id = i >= taskCount - 59 ? `task_heavy-${String(taskCount - i).padStart(3, "0")}` : `task_usage${String(i).padStart(6, "0")}`
    const session = { id: `ses_task${i}`, total: 0 }
    const model = pick(models)
    const login = rand() < 0.2 ? null : pick(logins)
    const title = `Task ${i}: ${pick(["fix", "add", "speed up", "rework", "test", "document"])} the ${pick(["sidebar", "usage modal", "composer", "box meter", "scheduler", "captain", "palette", "archive", "preview"])}`
    task.run(id, project.id, title, "do it", session.id, i % 9 === 0 ? `sch_usage${i % 4}x` : null, created, created, created)
    let at = created
    const turns = Math.max(1, Math.round(turnsPerTask * (0.3 + rand() * 1.4)))
    for (let k = 0; k < turns && at < now - MIN; k++) {
      const ms = Math.min(now - MIN - at, between(2, 40) * MIN)
      const box = rand() < 0.9 ? boxes.findIndex((_, b) => upStretches[b]!.some((u) => u.from <= at && u.to >= at + ms)) : -1
      const turnId = `turn_usage${turnCount++}`
      turn.run(turnId, id, k, model, at, at + ms, null, login, box >= 0 ? boxes[box]!.id : null)
      run({ source: "task", kind: "turn", taskId: id, projectId: project.id, turnId, session, model, at, ms, login })
      touch.run(at + ms, at + ms, id)
      at += ms + between(1, 240) * MIN
    }
  }

  // Captains and the Coordinator: steady through the day, each project's Captain one long session a week.
  const captains = projects.map(() => ({ id: "", total: 0 }))
  const coordinator = { id: "", total: 0 }
  for (let d = 0; d < days; d++) {
    for (let k = 0; k < captainPerDay; k++) {
      const at = start + d * DAY + Math.floor((k / captainPerDay) * DAY)
      if (at >= now - MIN) break
      const pi = k % projects.length
      const session = captains[pi]!
      const week = `ses_cap${pi}-${Math.floor(d / 7)}`
      if (session.id !== week) Object.assign(session, { id: week, total: 0 })
      run({ source: "captain", kind: "turn", taskId: null, projectId: projects[pi]!.id, turnId: null, session, model: "claude-opus-5-5", at, ms: between(5, 60) * 1000, login: pick(logins) })
    }
    for (let k = 0; k < coordinatorPerDay; k++) {
      const at = start + d * DAY + Math.floor((k / coordinatorPerDay) * DAY)
      if (at >= now - MIN) break
      const week = `ses_coord-${Math.floor(d / 7)}`
      if (coordinator.id !== week) Object.assign(coordinator, { id: week, total: 0 })
      run({ source: "orchestrator", kind: k % 25 === 0 ? "thread" : "turn", taskId: null, projectId: null, turnId: null, session: coordinator, model: "claude-opus-5-5", at, ms: between(5, 90) * 1000, login: null })
    }
  }

  // Boxes: an interval per meter tick while up, about half priced by Upstash itself; a created and a deleted event per stretch.
  const iv = db.prepare(
    `INSERT INTO box_usage_intervals (id, box_id, provider, size, keep_alive, started_at, ended_at, active_ms, uptime_ms, disk_bytes, source, compute_usd)
     VALUES (?, ?, 'upstash', ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const ev = db.prepare("INSERT INTO box_events (at, box_id, box_name, type, actor, reason, size, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
  boxes.forEach((b, i) => {
    for (const u of upStretches[i]!) {
      ev.run(u.from, b.id, b.name, "created", "scheduler", "a task needed a box", b.size, null)
      for (let t = u.from; t + meterMs <= u.to; t += meterMs) {
        const priced = rand() < 0.5
        iv.run(`bu_usage${intervalCount++}`, b.id, b.size, t, t + meterMs, Math.floor(rand() * meterMs * 2), meterMs, 4 * 1024 ** 3, priced ? "actual" : "measured", priced ? rand() * 0.0004 : null)
      }
      ev.run(u.to, b.id, b.name, "deleted", "janitor", "idle", b.size, null)
    }
  })
  for (const p of pods) {
    ev.run(p.from, p.id, null, "created", "scheduler", "GPU project", null, `RTX A5000 at $${p.usd}/hr`)
    ev.run(p.to, p.id, null, "deleted", "janitor", "idle", null, null)
  }
})()
const seedMs = performance.now() - t0

// The box_usage_slots rollup, the way its migration backfills it from the intervals.
const s0 = performance.now()
const rollup = MIGRATIONS.find((m) => m.includes("CREATE TABLE box_usage_slots"))!
db.exec("DELETE FROM box_usage_slots")
db.exec(rollup.slice(rollup.indexOf("WITH RECURSIVE")))
const rollupMs = performance.now() - s0
db.pragma("wal_checkpoint(TRUNCATE)")
db.close()

console.log(
  `seeded ${dir}: ${days} days to ${new Date(now).toISOString()}, ${taskCount.toLocaleString()} tasks, ${turnCount.toLocaleString()} turns, ` +
    `${runCount.toLocaleString()} Claude runs, ${intervalCount.toLocaleString()} box intervals (${boxCount} boxes) in ${(seedMs / 1000).toFixed(1)}s, ` +
    `rollup ${(rollupMs / 1000).toFixed(1)}s, ${(fs.statSync(file).size / 1024 ** 2).toFixed(0)} MB`,
)
