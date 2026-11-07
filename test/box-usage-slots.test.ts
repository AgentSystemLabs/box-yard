import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { MIGRATIONS, migrate, openDb } from "../server/db.js"
import { Store, boxCost, normalizeBoxSize, sourceOf } from "../server/store.js"
import { SettingsStore } from "../server/settings.js"
import { buildUsagePeriod, type PeriodBoxInterval } from "../server/usagePeriod.js"
import { weakerSource, type BoxSize, type CostRates, type UsageSource } from "../shared/types.js"
import { tmpDir } from "./helpers.js"

// box_usage_slots rolls the 20-second meter intervals up into 15-minute slots, so the Usage page and the cloud limits
// read a row a box per quarter hour. These check that it reports exactly what summing every interval did.

const MIN = 60_000
const H = 60 * MIN
const D = 24 * H
const SLOT = 15 * MIN
const memStore = () => new Store(openDb(tmpDir(), ":memory:"))
const rates = () => new SettingsStore(memStore(), { orchestratorModel: "", workerModel: "", captainModel: "", captainEffort: "" }).get().costRates

type Interval = Parameters<Store["recordBoxUsageInterval"]>[0]
interface IntervalRow {
  box_id: string
  size: BoxSize
  keep_alive: number
  started_at: number
  ended_at: number
  active_ms: number
  uptime_ms: number
  disk_bytes: number | null
  source: UsageSource
  compute_usd: number | null
}

/** Three days of metering for a few boxes: mostly 20 s ticks, some long gaps, resizes, keep-alive, priced and unpriced. */
function intervals(t0: number): Interval[] {
  let seed = 7
  const rand = () => ((seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647)
  const out: Interval[] = []
  const sources: UsageSource[] = ["actual", "measured", "estimated"]
  for (const [i, boxId] of ["box-a", "box-b", "box-c", "gpu-d"].entries()) {
    let t = t0 + Math.floor(rand() * 90_000)
    let size: BoxSize = i === 1 ? "medium" : "small"
    let keepAlive = i === 2
    while (t < t0 + 3 * D) {
      const r = rand()
      // Ticks, a few minutes, an hour or a night's gap (the server was down).
      const len = r < 0.985 ? 15_000 + Math.floor(rand() * 10_000) : r < 0.995 ? Math.floor(rand() * 40 * MIN) + 1 : r < 0.999 ? H + Math.floor(rand() * 3 * H) : 9 * H
      if (rand() < 0.0005) size = size === "small" ? "large" : "small"
      if (i === 2 && rand() < 0.0005) keepAlive = !keepAlive
      const priced = i === 3 || rand() < 0.4
      out.push({
        boxId,
        provider: i === 3 ? "runpod" : "upstash",
        size,
        keepAlive,
        startedAt: t,
        endedAt: t + len,
        activeMs: rand() < 0.2 ? 0 : Math.floor(rand() * len * 2),
        uptimeMs: len,
        diskBytes: i === 3 ? null : rand() < 0.05 ? 0 : (1 + Math.floor(rand() * 8)) * 1024 ** 3,
        source: sources[Math.floor(rand() * 3)]!,
        computeUsd: priced ? rand() * 0.01 : null,
      })
      t += len + (rand() < 0.001 ? Math.floor(rand() * 2 * H) : 0)
    }
  }
  return out
}

/** What one interval's share of a range cost before the rollup (Store's intervalCost). */
const shareCost = (r: IntervalRow, rates: CostRates, share: number) =>
  boxCost(
    {
      activeMs: r.compute_usd === null ? r.active_ms * share : 0,
      computeUsd: r.compute_usd === null ? null : r.compute_usd * share,
      uptimeMs: r.uptime_ms * share,
      diskBytes: r.disk_bytes,
      size: r.size,
      keepAlive: Boolean(r.keep_alive),
    },
    rates,
  )

/** Store.boxSpendSince as it was: every interval that ends after `since`, its share by overlap. */
function spendSinceByIntervals(rows: IntervalRow[], since: number, rates: CostRates) {
  const totals = { activeMs: 0, uptimeMs: 0, diskBytes: 0, costUsd: 0, source: "actual" as UsageSource }
  const byBox = new Map<string, { costUsd: number; activeMs: number; source: UsageSource }>()
  for (const r of rows) {
    const overlap = Math.max(0, r.ended_at - Math.max(since, r.started_at))
    if (!overlap) continue
    const share = Math.min(1, overlap / Math.max(1, r.ended_at - r.started_at))
    const cost = shareCost(r, rates, share)
    totals.activeMs += r.active_ms * share
    totals.uptimeMs += r.uptime_ms * share
    totals.diskBytes = Math.max(totals.diskBytes, r.disk_bytes ?? 0)
    totals.costUsd += cost
    totals.source = weakerSource(totals.source, sourceOf(r.source))
    const box = byBox.get(r.box_id) ?? byBox.set(r.box_id, { costUsd: 0, activeMs: 0, source: "actual" }).get(r.box_id)!
    box.costUsd += cost
    box.activeMs += r.active_ms * share
    box.source = weakerSource(box.source, sourceOf(r.source))
  }
  return { totals, byBox }
}

/** Store.usagePeriod's boxes as they were: every overlapping interval, whole, in the order they end. */
function periodByIntervals(store: Store, rows: IntervalRow[], from: number, to: number, rates: CostRates) {
  const intervals = rows
    .filter((r) => r.ended_at > from && r.started_at < to)
    .sort((a, b) => a.ended_at - b.ended_at)
    .map(
      (r): PeriodBoxInterval => ({
        boxId: r.box_id,
        size: normalizeBoxSize(r.size),
        keepAlive: Boolean(r.keep_alive),
        startedAt: r.started_at,
        endedAt: r.ended_at,
        activeMs: r.active_ms,
        uptimeMs: r.uptime_ms,
        diskBytes: r.disk_bytes,
        costUsd: shareCost(r, rates, 1),
        source: sourceOf(r.source),
      }),
    )
  const liveBoxes = store.listBoxes().map((b) => ({ boxId: b.id, size: normalizeBoxSize(b.size), keepAlive: Boolean(b.keep_alive), diskBytes: b.disk_bytes }))
  return buildUsagePeriod({ from, to, claude: [], intervals, liveBoxes })
}

/** Equal up to float rounding (sums in another order). */
const close = (a: number, b: number, what: string) => expect(Math.abs(a - b), `${what}: ${a} vs ${b}`).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(b)))

function seeded() {
  const store = memStore()
  const t0 = Date.UTC(2026, 9, 20, 6, 3, 17, 250)
  store.upsertBox({ id: "box-a", provider: "upstash", status: "ready", created_at: t0, last_used_at: t0, size: "small", disk_bytes: 5 * 1024 ** 3 })
  store.upsertBox({ id: "box-c", provider: "upstash", status: "ready", created_at: t0, last_used_at: t0, size: "small", keep_alive: 1 })
  for (const iv of intervals(t0)) store.recordBoxUsageInterval(iv)
  const rows = store.db.prepare("SELECT * FROM box_usage_intervals ORDER BY ended_at, rowid").all() as IntervalRow[]
  return { store, rows, t0 }
}

describe("box_usage_slots", () => {
  it("sums spend since any moment exactly as every interval does", () => {
    const { store, rows, t0 } = seeded()
    expect(rows.length).toBeGreaterThan(5000)
    const r = rates()
    const slotStart = Math.ceil(t0 / SLOT) * SLOT
    for (const since of [0, t0 - 1, t0 + 1234, slotStart + D, slotStart + D + 7 * MIN + 123, t0 + 2 * D + 5 * H + 1, t0 + 3 * D - 10 * MIN, t0 + 4 * D]) {
      const want = spendSinceByIntervals(rows, since, r)
      const got = store.boxSpendSince(since, r)
      close(got.totals.costUsd, want.totals.costUsd, `cost since ${since}`)
      close(got.totals.activeMs, want.totals.activeMs, `active since ${since}`)
      close(got.totals.uptimeMs, want.totals.uptimeMs, `uptime since ${since}`)
      expect(got.totals.diskBytes).toBe(want.totals.diskBytes)
      expect(got.totals.source).toBe(want.totals.source)
      expect([...got.byBox.keys()].sort()).toEqual([...want.byBox.keys()].sort())
      for (const [id, box] of want.byBox) {
        close(got.byBox.get(id)!.costUsd, box.costUsd, `${id} since ${since}`)
        close(got.byBox.get(id)!.activeMs, box.activeMs, `${id} active since ${since}`)
        expect(got.byBox.get(id)!.source).toBe(box.source)
      }
    }
  })

  it("gives the Usage page's periods the same buckets and boxes, on a slot edge or off one", () => {
    const { store, rows, t0 } = seeded()
    const r = rates()
    const midnight = Date.UTC(2026, 9, 21) - 5.75 * H // a local midnight at UTC+05:45
    for (const [from, to] of [
      [midnight, midnight + D],
      [midnight, t0 + 2 * D + 3 * H + 17_123], // "today" to now
      [midnight - D, t0 + 3 * D + H],
      [t0 - D, t0 + 10 * D],
      [midnight + 20 * MIN, midnight + 2 * D], // off a slot edge: buckets between slot edges
      [midnight + 3 * MIN, midnight + 9 * MIN], // inside one slot
    ] as const) {
      const want = periodByIntervals(store, rows, from, to, r)
      const got = store.usagePeriod(from, to, r)
      const what = `[${from}, ${to})`
      close(got.boxes.costUsd, want.boxes.costUsd, `${what} cost`)
      close(got.boxes.activeMs, want.boxes.activeMs, `${what} active`)
      close(got.boxes.uptimeMs, want.boxes.uptimeMs, `${what} uptime`)
      expect(got.boxes.diskBytes, what).toBe(want.boxes.diskBytes)
      expect(got.boxes.source, what).toBe(want.boxes.source)
      expect(got.buckets.map((b) => b.start)).toEqual(want.buckets.map((b) => b.start))
      got.buckets.forEach((b, i) => close(b.costs.boxes, want.buckets[i]!.costs.boxes, `${what} bucket ${i}`))
      expect(got.boxList.map((b) => b.boxId)).toEqual(want.boxList.map((b) => b.boxId))
      got.boxList.forEach((b, i) => {
        const w = want.boxList[i]!
        expect({ size: b.size, keepAlive: b.keepAlive, live: b.live, diskBytes: b.diskBytes, source: b.source }, `${what} ${b.boxId}`).toEqual({
          size: w.size,
          keepAlive: w.keepAlive,
          live: w.live,
          diskBytes: w.diskBytes,
          source: w.source,
        })
        close(b.costUsd, w.costUsd, `${what} ${b.boxId} cost`)
        close(b.activeMs, w.activeMs, `${what} ${b.boxId} active`)
        close(b.uptimeMs, w.uptimeMs, `${what} ${b.boxId} uptime`)
      })
    }
  })

  it("a change of Settings' rates reprices the slots' unpriced CPU, storage and keep-alive", () => {
    const { store, rows, t0 } = seeded()
    const r = rates()
    r.boxActiveCpuHourlyUsd.small *= 3
    r.boxKeepAliveMonthlyUsd.small *= 2
    r.boxStorageGbMonthUsd *= 5
    close(store.boxSpendSince(t0 + D, r).totals.costUsd, spendSinceByIntervals(rows, t0 + D, r).totals.costUsd, "repriced")
  })

  it("the migration backfills the slots the live rollup writes", () => {
    const { store, rows } = seeded()
    const slots = () => "SELECT * FROM box_usage_slots ORDER BY slot, box_id, size, keep_alive"
    const live = store.db.prepare(slots()).all() as Record<string, number | string | null>[]

    // The same intervals in a database from before the rollup, then its migration.
    const db = new Database(":memory:")
    migrate(db, MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE box_usage_slots")))
    const ins = db.prepare(
      `INSERT INTO box_usage_intervals (id, box_id, provider, size, keep_alive, started_at, ended_at, active_ms, uptime_ms, disk_bytes, source, compute_usd)
       VALUES (?, ?, 'upstash', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    db.transaction(() => rows.forEach((r, i) => ins.run(`bu_${i}`, r.box_id, r.size, r.keep_alive, r.started_at, r.ended_at, r.active_ms, r.uptime_ms, r.disk_bytes, r.source, r.compute_usd)))()
    migrate(db)
    const backfilled = db.prepare(slots()).all() as Record<string, number | string | null>[]

    expect(backfilled.length).toBe(live.length)
    backfilled.forEach((row, i) => {
      for (const [k, v] of Object.entries(row)) {
        const want = live[i]![k]
        if (typeof v === "number" && typeof want === "number" && !Number.isInteger(want)) close(v, want, `slot ${i} ${k}`)
        else expect(v, `slot ${i} ${k}`).toBe(want)
      }
    })
  })
})
