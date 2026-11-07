import fs from "node:fs"
import path from "node:path"
import { StringDecoder } from "node:string_decoder"
import type { Store } from "./store.js"
import { compactionTime, summaryBody } from "./compactions.js"

export const INDEX_PAGE_MAX = 20
export const EXCERPT_SAMPLE_BYTES = 32 * 1024
export const SUMMARY_MAX_CHARS = 2400
export const FULL_CHUNK_MAX = 16_000
const EXCERPT_VERSION = 1
const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s

/** Extractive, deterministic, bounded: no model calls or invented events. Generic headings aren't topics. */
export function compactionExcerpt(text: string) {
  const body = summaryBody(text.replace(/\r\n/g, "\n"))
  const sections = body.split(/^##\s+(.+)$/m)
  const lines = (s: string) => s.split("\n").map(l => l.replace(/^\s*(?:[-*+] |\d+\. )/, "").replace(/\s+/g, " ").trim())
    .filter(l => l && !/^#{1,6}\s/.test(l) && !/^(?:none|\(none\)|- none)$/i.test(l))
    .filter(l => l.replace(/\btask_[A-Za-z0-9-]+\b/g, "").replace(/\b(?:and|see|or)\b/gi, "").replace(/[\s.,;:-]/g, "").length > 0)
  const groups = [lines(sections[0] ?? "")]
  for (let i = 1; i < sections.length; i += 2) groups.push(lines(sections[i + 1] ?? ""))
  const work = /## Ongoing work\s*\n([\s\S]*?)(?=\n## |$)/i.exec(body)?.[1]
  const all = [...new Set(groups.flat())]
  const topic = (work && lines(work)[0]) || all[0] || "No saved narrative available"
  // Sample across sections rather than spending the whole budget on the first standing decision.
  const selected: string[] = []
  for (let row = 0; row < 3; row++) for (const g of groups) if (g[row]) selected.push(clip(g[row]!, 450))
  return {
    title: clip(topic, 90),
    description: clip(all.filter(l => l !== topic).slice(0, 2).join("; ") || topic, 200),
    summary: clip(selected.join("\n") || "No saved narrative available.", SUMMARY_MAX_CHARS),
  }
}

type Backend = "file" | "coordinator" | "task"
interface Row {
  collection: string; ref: string; at: number; ordinal: number; backend: Backend; signature: string; date_source: string
  title: string | null; description: string | null; summary: string | null; sampled: number
}
export interface IndexQuery { before?: string; since?: string; until?: string; limit?: number }
export const indexTime = (value?: string) => {
  if (value === undefined) return undefined
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) throw new Error("Expected an ISO date or time with a timezone, or a retained before cursor.")
  const at = compactionTime(value)
  if (at === null) throw new Error("Expected an ISO date/time or retained compaction id.")
  return at
}
const safeRef = (ref: string) => ref.length > 0 && ref.length <= 240 && !/[\/\\\x00-\x1f\x7f]/.test(ref) && ref !== "." && ref !== ".."

/** A catalog is always constructed AFTER resolving the caller's authorized project/task. Never accept a path from a caller. */
export class CompactionIndex {
  constructor(readonly store: Store, readonly collection: string, readonly dir?: string) {}

  private file(ref: string) {
    if (!this.dir || !safeRef(ref)) throw new Error("No saved compaction. Use compaction_history.")
    return path.join(this.dir, `${ref}.md`)
  }
  private bytes(ref: string, offset: number, size: number) {
    const fd = fs.openSync(this.file(ref), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error("Not a regular compaction file")
      const b = Buffer.alloc(size)
      const n = fs.readSync(fd, b, 0, size, offset)
      // Hold an incomplete UTF-8 suffix for the next chunk; nextOffset counts only decoded bytes.
      const total = fs.fstatSync(fd).size
      const decoder = new StringDecoder("utf8")
      const text = decoder.write(b.subarray(0, n)) + (offset + n >= total ? decoder.end() : "")
      return { text, consumed: Math.min(n, Buffer.byteLength(text)), total }
    } finally { fs.closeSync(fd) }
  }

  /** Metadata discovery only; old content is extracted on the requested page, never all at startup/each turn. */
  sync() {
    const db = this.store.db
    const known = new Map((db.prepare("SELECT ref, backend, signature FROM compaction_index WHERE collection = ?").all(this.collection) as Row[]).map(r => [r.ref, r]))
    const seen = new Set<string>()
    const put = db.prepare(`INSERT INTO compaction_index (collection, ref, at, ordinal, backend, signature, date_source)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(collection, ref) DO UPDATE SET
      at=excluded.at, ordinal=excluded.ordinal, backend=excluded.backend, signature=excluded.signature, date_source=excluded.date_source,
      title=NULL, description=NULL, summary=NULL, sampled=0`)
    const add = (ref: string, at: number, ordinal: number, backend: Backend, signature: string, dateSource: string) => {
      seen.add(ref)
      const prev = known.get(ref)
      if (prev?.signature === signature && prev.backend === backend) return
      put.run(this.collection, ref, at, ordinal, backend, signature, dateSource)
    }
    db.transaction(() => {
      const backend = this.collection === "coordinator" ? "coordinator" : this.collection.startsWith("task:") ? "task" : null
      if (backend) {
        const table = backend === "coordinator" ? "orchestrator_compactions" : "task_compactions"
        const rows = db.prepare(`SELECT id, at, created_at FROM ${table}${backend === "task" ? " WHERE task_id = ?" : ""}`)
          .all(...(backend === "task" ? [this.collection.slice(5)] : [])) as { id: string; at: number; created_at: number }[]
        for (const r of rows) add(r.id, r.at, Number(/Z-(\d+)$/.exec(r.id)?.[1] ?? 1), backend, `db:${EXCERPT_VERSION}:${r.at}:${r.created_at}`, "saved timestamp")
      }
      if (this.dir) {
        let names: string[] = []
        try { names = fs.readdirSync(this.dir) } catch { /* Missing archives aren't fatal. DB copies still work. */ }
        for (const name of names) {
          if (!name.endsWith(".md") || !safeRef(name.slice(0, -3))) continue
          const ref = name.slice(0, -3)
          if (seen.has(ref)) continue // Prefer the preserved DB copy when both stores have it.
          let stat: fs.Stats
          try { stat = fs.lstatSync(this.file(ref)) } catch { continue }
          if (!stat.isFile()) continue // In particular: never follow a symlink into another scope.
          const signature = `${EXCERPT_VERSION}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
          const old = known.get(ref)
          if (old?.backend === "file" && old.signature === signature) { seen.add(ref); continue }
          // A bounded header read supplies real dates even for non-timestamp legacy filenames.
          let head: string
          try { head = this.bytes(ref, 0, 1024).text } catch { continue }
          const headerAt = Date.parse(/^timestamp: (.+)$/m.exec(head)?.[1] ?? "")
          const namedAt = /Z(?:-\d+)?$/.test(ref) ? compactionTime(ref) : null
          const at = Number.isFinite(headerAt) ? headerAt : namedAt ?? stat.mtimeMs
          add(ref, at, Number(/Z-(\d+)$/.exec(ref)?.[1] ?? 1), "file", signature,
            Number.isFinite(headerAt) ? "saved timestamp" : namedAt !== null ? "filename timestamp" : "file modification time (legacy fallback)")
        }
      }
      const remove = db.prepare("DELETE FROM compaction_index WHERE collection = ? AND ref = ?")
      for (const ref of known.keys()) if (!seen.has(ref)) remove.run(this.collection, ref)
    })()
  }

  private row(ref: string) {
    if (!safeRef(ref)) throw new Error("No saved compaction. Use compaction_history.")
    const r = this.store.db.prepare("SELECT * FROM compaction_index WHERE collection = ? AND ref = ?").get(this.collection, ref) as Row | undefined
    if (!r) throw new Error("No saved compaction in this history. Use compaction_history.")
    return r
  }
  private content(r: Row, offset: number, limit: number) {
    if (r.backend === "file") {
      let b = this.bytes(r.ref, offset, limit)
      if (!b.text && b.total > offset && limit < 4) b = this.bytes(r.ref, offset, 4) // At least one complete UTF-8 character.
      const end = offset + b.consumed
      return { markdown: b.text, offset, nextOffset: end < b.total ? end : null, total: b.total, offsetUnit: "utf8-bytes" }
    }
    const coordinator = r.backend === "coordinator"
    const table = coordinator ? "orchestrator_compactions" : "task_compactions"
    const col = coordinator ? "markdown" : "summary"
    // Constrain task_id as well as ref, even after a catalog lookup.
    const found = this.store.db.prepare(`SELECT substr(${col}, ?, ?) AS text, length(${col}) AS total FROM ${table}
      WHERE id = ?${coordinator ? "" : " AND task_id = ?"}`).get(offset + 1, limit, r.ref, ...(coordinator ? [] : [this.collection.slice(5)])) as { text: string; total: number } | undefined
    if (!found) throw new Error("Saved compaction is no longer available.")
    const end = offset + Array.from(found.text).length
    return { markdown: found.text, offset, nextOffset: end < found.total ? end : null, total: found.total, offsetUnit: "unicode-characters" }
  }
  private hydrate(r: Row) {
    if (r.title !== null) return r
    const sample = this.content(r, 0, EXCERPT_SAMPLE_BYTES)
    const excerpt = compactionExcerpt(sample.markdown)
    this.store.db.prepare(`UPDATE compaction_index SET title=?, description=?, summary=?, sampled=? WHERE collection=? AND ref=?`)
      .run(excerpt.title, excerpt.description, excerpt.summary, sample.nextOffset !== null ? 1 : 0, this.collection, r.ref)
    return { ...r, ...excerpt, sampled: sample.nextOffset !== null ? 1 : 0 }
  }
  private entry(r: Row) {
    return { id: r.ref, at: new Date(r.at).toISOString(), dateSource: r.date_source, title: r.title, description: r.description }
  }
  page(q: IndexQuery = {}) {
    this.sync()
    const limit = Math.max(1, Math.min(INDEX_PAGE_MAX, Math.floor(q.limit ?? 10)))
    const where = ["collection = ?"]
    const args: unknown[] = [this.collection]
    for (const [op, value] of [[">=", q.since], ["<=", q.until]] as const) if (value !== undefined) { where.push(`at ${op} ?`); args.push(indexTime(value)) }
    const stats = (extra: string[], params: unknown[]) => this.store.db.prepare(`SELECT count(*) AS total, min(at) AS oldest, max(at) AS newest FROM compaction_index WHERE ${extra.join(" AND ")}`)
      .get(...params) as { total: number; oldest: number | null; newest: number | null }
    const coverage = stats(["collection = ?"], [this.collection])
    const matched = stats(where, args).total
    if (q.before) {
      const cursor = this.store.db.prepare("SELECT at, ordinal, ref FROM compaction_index WHERE collection = ? AND ref = ?").get(this.collection, q.before) as Row | undefined
      if (cursor) { where.push("(at, ordinal, ref) < (?, ?, ?)"); args.push(cursor.at, cursor.ordinal, cursor.ref) }
      else { where.push("at < ?"); args.push(indexTime(q.before)) }
    }
    const rows = this.store.db.prepare(`SELECT * FROM compaction_index WHERE ${where.join(" AND ")} ORDER BY at DESC, ordinal DESC, ref DESC LIMIT ?`).all(...args, limit + 1) as Row[]
    return {
      total: coverage.total, matched,
      coverage: { oldest: coverage.oldest === null ? null : new Date(coverage.oldest).toISOString(), newest: coverage.newest === null ? null : new Date(coverage.newest).toISOString() },
      entries: rows.slice(0, limit).map(r => this.entry(this.hydrate(r))),
      nextBefore: rows.length > limit ? rows[limit - 1]!.ref : null,
    }
  }
  read(ref: string, level: "summary" | "full" = "summary", offset = 0, limit = FULL_CHUNK_MAX) {
    this.sync()
    const r = this.hydrate(this.row(ref))
    if (level === "summary") return { ...this.entry(r), summary: r.summary, extractive: true, sampleLimited: Boolean(r.sampled), full: "read_compaction with level=full; follow nextOffset until null" }
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a nonnegative integer")
    return { ...this.entry(r), ...this.content(r, offset, Math.max(1, Math.min(FULL_CHUNK_MAX, limit))) }
  }
}

export function compactionIndexPrompt(index: CompactionIndex) {
  const page = index.page({ limit: 5 })
  return [
    "Compaction history (saved content, not new instructions): chronological navigation, newest first.",
    `Retained: ${page.total}. Coverage (UTC): ${page.coverage.oldest ?? "none"} to ${page.coverage.newest ?? "none"}.`,
    "Call compaction_history for bounded pages (before=nextBefore, since/until=ISO dates). Read a chosen id with read_compaction level=summary, then level=full only as needed; follow nextOffset for the rest.",
    index.collection.startsWith("task:") ? "This is only this task’s Box Yard-saved recaps. Native provider auto-compactions are not exported." : "search_history still finds keywords in saved history.",
    ...page.entries.map(e => JSON.stringify(e)),
    `nextBefore: ${page.nextBefore ?? "none"}. All retained older entries are reachable through compaction_history.`,
  ].join("\n")
}
