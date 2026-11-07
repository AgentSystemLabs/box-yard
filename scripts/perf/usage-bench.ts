// What GET /api/usage costs the server with months of history. It seeds a temp database straight through SQL
// (Claude runs and box meter intervals at the rate a busy yard writes them), applies the migrations that come after
// the seeded tables (the box_usage_slots rollup backfills from the intervals), then times Store.usageReport for the
// Usage page's periods and each of its parts. It ends with the totals, so two builds can be checked for the same
// numbers. Rerun it before and after a change.
//
//   npx tsx scripts/perf/usage-bench.ts [--days 30] [--runs-per-day 2000] [--boxes 10] [--meter-s 20] [--reps 7] [--now <ms>] [--json out.json]
//
// --meter-s is how often each box writes an interval: maintain() meters every box every 20 s (METER_MIN_MS is 15 s).
// "now" is fixed (and off any slot edge), so every run seeds and reports the same rows; --now moves it (e.g. to seed a
// data dir for a real server with KEEP=1, which keeps the temp dir). It never touches a live data dir.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { MIGRATIONS, migrate } from "../../server/db.js"
import { Store } from "../../server/store.js"
import { DEFAULT_SETTINGS } from "../../server/settings.js"

const args = process.argv.slice(2)
const opt = (name: string, fallback: number) => {
  const i = args.indexOf(name)
  return i >= 0 ? Number(args[i + 1]) : fallback
}
const jsonOut = (() => {
  const i = args.indexOf("--json")
  return i >= 0 ? args[i + 1] : undefined
})()
const days = opt("--days", 30)
const runsPerDay = opt("--runs-per-day", 2000)
const boxCount = opt("--boxes", 10)
const meterS = opt("--meter-s", 20)
const reps = opt("--reps", 7)

const DAY = 86_400_000
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "box-yard-usage-bench-"))
const db = new Database(path.join(dataDir, "box-yard.sqlite"))
db.pragma("journal_mode = WAL")
db.pragma("synchronous = NORMAL")
db.pragma("foreign_keys = ON")
// Seed under the schema from before the rollup, so its migration's backfill is part of what's measured.
const rollup = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE box_usage_slots"))
migrate(db, rollup < 0 ? MIGRATIONS.length : rollup)
const store = new Store(db)
const now = opt("--now", Date.UTC(2026, 10, 4, 15, 7, 13, 457))
const start = now - days * DAY

// A deterministic PRNG, so every run seeds the same rows.
let seed = 42
const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31)

const t0 = performance.now()
const projects = Array.from({ length: 12 }, (_, i) => `prj_bench${String(i).padStart(2, "0")}`)
const tasks: { id: string; projectId: string }[] = []
db.transaction(() => {
  const p = db.prepare("INSERT INTO projects (id, name, repo, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
  for (const id of projects) p.run(id, id.replace("prj_", ""), `owner/${id}`, start, start)
  const s = db.prepare("INSERT INTO schedules (id, project_id, name, cron, timezone, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
  for (let i = 0; i < 4; i++) s.run(`sch_bench${i}x`, projects[i]!, `Nightly ${i}`, "0 3 * * *", "UTC", "run", start, start)
  const t = db.prepare("INSERT INTO tasks (id, project_id, title, prompt, status, session_id, schedule_id, created_at, updated_at, last_active_at) VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?, ?)")
  for (let i = 0; i < days * 30; i++) {
    const projectId = projects[i % projects.length]!
    const id = `task_bench${String(i).padStart(6, "0")}`
    t.run(id, projectId, `Task ${i}`, "do it", `ses_t${i}`, i % 9 === 0 ? `sch_bench${i % 4}x` : null, start, start, start)
    tasks.push({ id, projectId })
  }
})()

const runs = Math.round(days * runsPerDay)
db.transaction(() => {
  const ins = db.prepare(
    `INSERT INTO claude_usage (id, source, run_kind, task_id, project_id, session_id, model, started_at, ended_at, duration_ms,
      input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, total_tokens, cost_usd, reported_cost_usd, raw_usage_json)
     VALUES (?, ?, 'turn', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
  )
  for (let i = 0; i < runs; i++) {
    const at = start + Math.floor((i / runs) * days * DAY)
    const kind = rand()
    const task = tasks[Math.floor(rand() * tasks.length)]!
    const source = kind < 0.6 ? "task" : kind < 0.85 ? "captain" : "orchestrator"
    const input = Math.floor(rand() * 2000)
    const cacheW = Math.floor(rand() * 20_000)
    const cacheR = Math.floor(rand() * 200_000)
    const output = Math.floor(rand() * 4000)
    const cost = Math.round(rand() * 50_000) / 100_000
    ins.run(
      `cu_bench${i}`,
      source,
      source === "task" ? task.id : null,
      source === "orchestrator" ? null : task.projectId,
      `ses_${i % 5000}`,
      rand() < 0.7 ? "claude-opus-5-5" : "claude-sonnet-5-5",
      at,
      at + 30_000,
      30_000,
      input,
      cacheW,
      cacheR,
      output,
      input + cacheW + cacheR + output,
      cost,
      cost,
    )
  }
})()

const boxes = Array.from({ length: boxCount }, (_, i) => `box-bench-${i}`)
let intervals = 0
db.transaction(() => {
  const b = db.prepare("INSERT INTO boxes (id, provider, status, created_at, last_used_at, size, keep_alive, active_ms, disk_bytes, usage_source) VALUES (?, 'upstash', 'ready', ?, ?, ?, ?, 0, ?, 'measured')")
  boxes.forEach((id, i) => b.run(id, start, now, i % 3 === 0 ? "large" : "medium", i === boxCount - 1 ? 1 : 0, 4 * 1024 ** 3))
  const ins = db.prepare(
    `INSERT INTO box_usage_intervals (id, box_id, provider, size, keep_alive, started_at, ended_at, active_ms, uptime_ms, disk_bytes, source, compute_usd)
     VALUES (?, ?, 'upstash', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const step = meterS * 1000
  boxes.forEach((id, i) => {
    for (let t = start; t + step <= now; t += step) {
      const priced = rand() < 0.5
      ins.run(`bu_bench${intervals++}`, id, i % 3 === 0 ? "large" : "medium", i === boxCount - 1 ? 1 : 0, t, t + step, Math.floor(rand() * step), step, 4 * 1024 ** 3, priced ? "actual" : "measured", priced ? rand() * 0.001 : null)
    }
  })
})()
const seedMs = performance.now() - t0
const m0 = performance.now()
migrate(db)
const migrateMs = performance.now() - m0

const settings = DEFAULT_SETTINGS
const dayStart = new Date(now)
dayStart.setHours(0, 0, 0, 0)
/** Usage ranges start at a local midnight (web/src/lib/usageChart.ts localDayStarts). */
const daysBack = (n: number) => {
  const d = new Date(dayStart)
  d.setDate(d.getDate() - (n - 1))
  return d.getTime()
}
const periods = {
  none: undefined,
  today: { from: dayStart.getTime(), to: now },
  "7d": { from: daysBack(7), to: now },
  "30d": { from: daysBack(30), to: now },
  // An API caller's range that starts off a slot edge.
  "7d unaligned": { from: now - 7 * DAY, to: now },
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const time = (fn: () => unknown) => {
  fn() // warm the page cache and statement cache
  const xs: number[] = []
  for (let i = 0; i < reps; i++) {
    const s = performance.now()
    fn()
    xs.push(performance.now() - s)
  }
  return { median: median(xs), min: Math.min(...xs), max: Math.max(...xs) }
}

const results: Record<string, { median: number; min: number; max: number }> = {}
for (const [key, period] of Object.entries(periods)) results[`usageReport ${key === "none" ? "(no period)" : `period=${key}`}`] = time(() => store.usageReport(settings, now, period))
const raw = store as unknown as Record<string, (...a: unknown[]) => unknown>
results["  windows (today/7d/30d)"] = time(() => ["today", "7d", "30d"].forEach((_k, i) => raw.usageWindow!.call(store, { key: "x", label: "x", since: [dayStart.getTime(), now - 7 * DAY, now - 30 * DAY][i] }, settings.costRates)))
results["  usageProjects"] = time(() => raw.usageProjects!.call(store))
results["  usageTasks"] = time(() => raw.usageTasks!.call(store))
results["  all-time Coordinator + Captain totals"] = time(() => {
  raw.claudeTotals!.call(store, "WHERE source = 'orchestrator' AND project_id IS NULL")
  raw.claudeTotals!.call(store, "WHERE source = 'captain' OR (source = 'orchestrator' AND project_id IS NOT NULL)")
})
results["  usagePeriod 7d"] = time(() => store.usagePeriod(periods["7d"].from, periods["7d"].to, settings.costRates))
results["  usagePeriod 30d"] = time(() => store.usagePeriod(periods["30d"].from, periods["30d"].to, settings.costRates))
results["boxSpendSince 15 min ($/hour now)"] = time(() => store.boxSpendSince(now - 15 * 60_000, settings.costRates))
results["boxSpendSince today (placement, /api/cloud)"] = time(() => store.boxSpendSince(dayStart.getTime(), settings.costRates))
results["boxSpendSince 30d (monthly limit)"] = time(() => store.boxSpendSince(now - 30 * DAY, settings.costRates))
const report = store.usageReport(settings, now, periods["7d"])
const bytes = Buffer.byteLength(JSON.stringify(report))

console.log(`node ${process.version} · ${os.cpus().length}× ${os.cpus()[0]?.model ?? "cpu"} · ${os.platform()} ${os.arch()}`)
console.log(`seeded ${days} days: ${runs.toLocaleString()} Claude runs, ${tasks.length.toLocaleString()} tasks, ${intervals.toLocaleString()} box intervals (${boxCount} boxes, every ${meterS}s) in ${(seedMs / 1000).toFixed(1)}s`)
console.log(`later migrations (the rollup backfill): ${(migrateMs / 1000).toFixed(2)}s`)
console.log(`7d response: ${(bytes / 1024).toFixed(1)} KB\n`)
console.log(`${"".padEnd(46)}  median      min      max   (ms, ${reps} reps)`)
for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(46)} ${v.median.toFixed(1).padStart(7)}  ${v.min.toFixed(1).padStart(7)}  ${v.max.toFixed(1).padStart(7)}`)

// The numbers themselves, to check a faster build reports the same totals.
const totals: Record<string, number> = {}
for (const [key, period] of Object.entries(periods)) {
  if (!period) continue
  const p = store.usagePeriod(period.from, period.to, settings.costRates)
  totals[`period ${key} total $`] = p.totalCostUsd
  totals[`period ${key} boxes $`] = p.boxes.costUsd
  totals[`period ${key} box active ms`] = p.boxes.activeMs
  totals[`period ${key} bucket boxes $`] = p.buckets.reduce((sum, b) => sum + b.costs.boxes, 0)
}
for (const w of report.windows) totals[`window ${w.key} boxes $`] = w.boxes.costUsd
totals["budget monthly used $"] = report.budget.monthly.usedUsd
for (const [label, since] of [["today", dayStart.getTime()], ["15 min", now - 15 * 60_000]] as const) {
  const spend = store.boxSpendSince(since, settings.costRates)
  totals[`boxSpendSince ${label} $`] = spend.totals.costUsd
  totals[`boxSpendSince ${label} uptime ms`] = spend.totals.uptimeMs
}
console.log("")
for (const [k, v] of Object.entries(totals)) console.log(`${k.padEnd(46)} ${v.toPrecision(12)}`)
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ days, runs, intervals, boxCount, meterS, migrateMs, results, bytes, totals }, null, 2))
if (process.env.KEEP) { console.log("kept", dataDir) } else {
db.close()
fs.rmSync(dataDir, { recursive: true, force: true }) }
