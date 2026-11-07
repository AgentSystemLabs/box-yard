import type { Router } from "express"
import type { DB } from "./db.js"
import { BadRequestError, json, type Store } from "./store.js"
import { HISTORY_PAGE_SIZE, type HistoryDay, type HistoryPage, type TranscriptMessage } from "../shared/transcriptHistory.js"

export type HistoryScope = { kind: "chat" } | { kind: "captain" | "task"; id: string }
type Row = { id: string; rid: number; created_at: number; role: string; content: string; meta_json: string | null }

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
    const id = modes[0]?.[1]
    const anchor = id === undefined ? undefined : this.db.prepare(`SELECT rowid AS rid, created_at FROM ${table} WHERE ${where} AND id = ?`).get(...args, id) as Row | undefined
    if (id !== undefined && !anchor) throw new BadRequestError("History message not found in this conversation")
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
      before: exists(rows[0], "<") ? rows[0]!.id : null,
      after: exists(rows.at(-1), ">") ? rows.at(-1)!.id : null,
    }
  }

  /** Only timestamps and ids cross this scan; no transcript bodies are read or returned. The reader's IANA
   * timezone handles midnight and DST independently of the server's timezone. */
  days(scope: HistoryScope, timeZone: string): HistoryDay[] {
    let format: Intl.DateTimeFormat
    try { format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }) }
    catch { throw new BadRequestError("Invalid history timezone") }
    const { table, where, args } = this.source(scope)
    const days: HistoryDay[] = []
    let previous = ""
    for (const r of this.db.prepare(`SELECT id, created_at FROM ${table} WHERE ${where} AND role <> 'tool' ORDER BY created_at, rowid`).iterate(...args) as Iterable<Pick<Row, "id" | "created_at">>) {
      const key = format.format(r.created_at)
      if (key !== previous) { days.push({ at: r.created_at, messageId: r.id }); previous = key }
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
        if (v !== undefined && (typeof v !== "string" || !v || v.length > 128)) throw new BadRequestError("Invalid history query")
        return v as string | undefined
      }
      if (value("days") === "1") return void res.json(history.days(scope, value("tz") ?? "UTC"))
      res.json(history.page(scope, { before: value("before"), after: value("after"), around: value("around") }))
    })
  }
}
