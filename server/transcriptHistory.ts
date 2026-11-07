import type { Router } from "express"
import type { DB } from "./db.js"
import { BadRequestError, json, type Store } from "./store.js"
import { HISTORY_PAGE_SIZE, type HistoryDay, type HistoryPage, type TranscriptMessage } from "../shared/transcriptHistory.js"

export type HistoryScope = { kind: "chat" } | { kind: "captain" | "task"; id: string }
type Row = { id: string; rid: number; created_at: number; role: string; content: string; meta_json: string | null }
const position = (r: Row) => `h:${Buffer.from(JSON.stringify({ id: r.id, at: r.created_at, rid: r.rid })).toString("base64url")}`

function readPosition(value: string | undefined): { id: string; at: number; rid: number } | undefined {
  if (!value?.startsWith("h:")) return undefined
  try {
    const p = JSON.parse(Buffer.from(value.slice(2), "base64url").toString())
    if (typeof p.id === "string" && p.id.length <= 128 && Number.isSafeInteger(p.at) && Number.isSafeInteger(p.rid) && p.rid > 0) return p
  } catch { /* Invalid cursor below. */ }
  throw new BadRequestError("Invalid history cursor")
}

/** Read-only browser history. Scope is part of every lookup, including the cursor lookup. Existing (scope,
 * created_at) indexes include rowid as their final key, matching the live logs' order for equal timestamps. */
export class TranscriptHistory {
  constructor(private db: DB) {}

  private source(scope: HistoryScope) {
    const table = scope.kind === "chat" ? "chat_messages" : scope.kind === "captain" ? "captain_messages" : "task_messages"
    const where = scope.kind === "chat" ? "1" : scope.kind === "captain" ? "project_id = ?" : "task_id = ?"
    return { table, where, args: scope.kind === "chat" ? [] : [scope.id] }
  }

  page(scope: HistoryScope, query: { before?: string; after?: string; around?: string } = {}): HistoryPage {
    const { table, where, args } = this.source(scope)
    const modes = Object.entries(query).filter(([, value]) => value !== undefined)
    if (modes.length > 1) throw new BadRequestError("Choose one history cursor")
    const mode = modes[0]?.[0]
    const value = modes[0]?.[1]
    const cursor = mode === "around" ? undefined : readPosition(value)
    const id = cursor?.id ?? value
    const current = id === undefined ? undefined : this.db.prepare(`SELECT rowid AS rid, created_at FROM ${table} WHERE ${where} AND id = ?`).get(...args, id) as Row | undefined
    if (id !== undefined && (!current || (cursor && cursor.rid !== current.rid))) throw new BadRequestError("History message not found in this conversation")
    // A queued message can be delivered between pages. Keep the cursor's original position while still
    // validating its id and rowid inside this conversation; resolving its new timestamp would skip a gap.
    const anchor = cursor ? { created_at: cursor.at, rid: cursor.rid } : current
    const select = (op: string, direction: "ASC" | "DESC", limit: number): Row[] => this.db.prepare(
      `SELECT *, rowid AS rid FROM ${table} WHERE ${where} ${anchor ? `AND (created_at, rowid) ${op} (?, ?)` : ""}
       ORDER BY created_at ${direction}, rowid ${direction} LIMIT ?`,
    ).all(...args, ...(anchor ? [anchor.created_at, anchor.rid] : []), limit) as Row[]
    const rows = mode === "around"
      ? [...select("<", "DESC", 20).reverse(), ...select(">=", "ASC", HISTORY_PAGE_SIZE - 20)]
      : mode === "after" ? select(">", "ASC", HISTORY_PAGE_SIZE) : select("<", "DESC", HISTORY_PAGE_SIZE).reverse()
    const exists = (row: Row | undefined, op: string) => row && this.db.prepare(
      `SELECT 1 FROM ${table} WHERE ${where} AND (created_at, rowid) ${op} (?, ?) LIMIT 1`,
    ).get(...args, row.created_at, row.rid)
    return {
      messages: rows.map((r) => ({ id: r.id, role: r.role, content: r.content, meta: json(r.meta_json, null),
        createdAt: r.created_at, ...(scope.kind === "task" ? { taskId: scope.id } : scope.kind === "captain" ? { projectId: scope.id } : {}),
      }) as TranscriptMessage),
      before: exists(rows[0], "<") ? position(rows[0]!) : null,
      after: exists(rows.at(-1), ">") ? position(rows.at(-1)!) : null,
      positions: Object.fromEntries(rows.map((r) => [r.id, position(r)])),
    }
  }

  /** Seek the first visible row of each local day through the timestamp index. Midnight is found in the
   * reader's IANA timezone (including DST), without scanning or transferring every message in a busy day. */
  days(scope: HistoryScope, timeZone: string): HistoryDay[] {
    let format: Intl.DateTimeFormat
    try { format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }) }
    catch { throw new BadRequestError("Invalid history timezone") }
    const { table, where, args } = this.source(scope)
    const select = `SELECT id, created_at FROM ${table} WHERE ${where} AND role <> 'tool'`
    const first = this.db.prepare(`${select} ORDER BY created_at, rowid LIMIT 1`)
    const next = this.db.prepare(`${select} AND created_at >= ? ORDER BY created_at, rowid LIMIT 1`)
    type DayRow = Pick<Row, "id" | "created_at">
    let row = first.get(...args) as DayRow | undefined
    const days: HistoryDay[] = []
    while (row) {
      days.push({ at: row.created_at, messageId: row.id })
      const key = format.format(row.created_at)
      let lo = row.created_at
      let hi = lo + 36 * 3600_000
      while (format.format(hi) === key) hi += 36 * 3600_000
      // No 24-hour assumption: even a skipped/repeated midnight must start the next retained date correctly.
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2)
        if (format.format(mid) === key) lo = mid
        else hi = mid
      }
      row = next.get(...args, hi) as DayRow | undefined
    }
    return days
  }
}

/** Owner browser API only. Agent history remains behind search_history's scope and status-only checks. */
export function transcriptHistoryRoutes(api: Router, store: Store) {
  const history = new TranscriptHistory(store.db)
  for (const kind of ["chat", "captain", "task"] as const) {
    const path = kind === "chat" ? "/chat/history" : kind === "captain" ? "/projects/:id/captain/history" : "/tasks/:id/history"
    api.get(path, (req, res) => {
      const id = (req.params as Record<string, string>).id!
      const scope: HistoryScope = kind === "chat" ? { kind } : { kind, id }
      if (kind === "captain" && !store.getProject(id)) throw new BadRequestError("No such project")
      if (kind === "task" && !store.getTask(id)) throw new BadRequestError("No such task")
      const value = (key: string) => {
        const v = req.query[key]
        if (v !== undefined && (typeof v !== "string" || !v || v.length > 256)) throw new BadRequestError("Invalid history query")
        return v as string | undefined
      }
      if (value("days") === "1") return void res.json(history.days(scope, value("tz") ?? "UTC"))
      res.json(history.page(scope, { before: value("before"), after: value("after"), around: value("around") }))
    })
  }
}
