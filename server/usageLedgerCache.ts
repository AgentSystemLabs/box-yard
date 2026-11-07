// Each past day's part of the Usage modal's ledger (Store.usageLedger), so opening it, switching its range or a live
// refresh builds only today and the days a write has touched since. A day's part depends only on rows that start,
// run or end in it, and every write to them leaves a row in usage_changes (triggers, see its migration): a box
// interval or a turn drops the days its span overlaps; a Claude run drops its own day, the days of the later runs in
// its session (their step from the previous report may change), and every day that repriced a dip booking at its
// session's $/token. Names (tasks, projects, boxes, logins) and GPU pods aren't kept here: they're read per request.
import type { DB } from "./db.js"
import type { UsageComputeRow, UsageLedger, UsageLlmRow } from "../shared/usageLedger.js"

/** One day of the ledger: its rows (day 0), and what it read that a request names or that invalidates it. */
export interface LedgerDay {
  from: number
  to: number
  llm: UsageLlmRow[]
  /** Metered box time only: GPU pods' lives come from the box history, per request. */
  compute: UsageComputeRow[]
  repriced: UsageLedger["repriced"]
  taskIds: string[]
  boxIds: string[]
  loginIds: string[]
  /** Sessions with a dip booking repriced here: a change to any of their runs changes that day. */
  dipSessions: Set<string>
}

/** Days kept: 120 is the longest range the API takes; rates changed in Settings make another set. */
const MAX_DAYS = 400

interface Change {
  id: number
  kind: "run" | "span"
  a: number
  b: number | null
  ref: string | null
}

export class UsageLedgerCache {
  private days = new Map<string, LedgerDay>()
  private seen: number

  constructor(private db: DB) {
    // Changes from before this cache describe days it never built.
    this.seen = (db.prepare("SELECT MAX(id) AS id FROM usage_changes").get() as { id: number | null }).id ?? 0
    this.trim()
  }

  private key = (from: number, to: number, rates: string) => `${from}:${to}:${rates}`

  get(from: number, to: number, rates: string): LedgerDay | undefined {
    const k = this.key(from, to, rates)
    const day = this.days.get(k)
    if (day) {
      // Most recently used last, so eviction takes the coldest.
      this.days.delete(k)
      this.days.set(k, day)
    }
    return day
  }

  set(rates: string, day: LedgerDay) {
    this.days.set(this.key(day.from, day.to, rates), day)
    if (this.days.size > MAX_DAYS) this.days.delete(this.days.keys().next().value!)
  }

  get size() {
    return this.days.size
  }

  /** Drop the days the writes since the last sync touched. Call before reading any day. */
  sync() {
    const changes = this.db.prepare("SELECT id, kind, a, b, ref FROM usage_changes WHERE id > ? ORDER BY id").all(this.seen) as Change[]
    if (!changes.length) return
    this.seen = changes.at(-1)!.id
    if (this.days.size) {
      const sessions = new Map<string, number>()
      for (const c of changes) {
        if (c.kind === "span") this.drop(c.a, c.b ?? Infinity)
        else {
          this.drop(c.a, c.a + 1)
          if (c.ref) sessions.set(c.ref, Math.min(sessions.get(c.ref) ?? Infinity, c.b ?? c.a))
        }
      }
      const later = this.db.prepare("SELECT started_at AS at FROM claude_usage WHERE session_id = ? AND ended_at >= ?")
      for (const [session, endedAt] of sessions) {
        for (const [k, day] of this.days) if (day.dipSessions.has(session)) this.days.delete(k)
        for (const { at } of later.all(session, endedAt) as { at: number }[]) this.drop(at, at + 1)
      }
    }
    this.trim()
  }

  /** Forget the changes already read, so the log stays short (maintain() calls this every 20 s). */
  trim() {
    this.db.prepare("DELETE FROM usage_changes WHERE id <= ?").run(this.seen)
  }

  /** Drop every day that overlaps [from, to). */
  private drop(from: number, to: number) {
    for (const [k, day] of this.days) if (day.from < to && day.to > from) this.days.delete(k)
  }
}

const caches = new WeakMap<DB, UsageLedgerCache>()

/** The one cache for a database, whichever Store asks: the change log it reads and trims is shared too. */
export function usageLedgerCache(db: DB): UsageLedgerCache {
  let cache = caches.get(db)
  if (!cache) caches.set(db, (cache = new UsageLedgerCache(db)))
  return cache
}
