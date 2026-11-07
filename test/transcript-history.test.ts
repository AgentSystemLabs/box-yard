import { afterEach, describe, expect, it } from "vitest"
import { openDb, type DB } from "../server/db.js"
import { Store } from "../server/store.js"
import { TranscriptHistory, type HistoryScope } from "../server/transcriptHistory.js"
import { tmpDir } from "./helpers.js"

let db: DB
const setup = () => {
  db = openDb(tmpDir(), ":memory:")
  return { store: new Store(db), history: new TranscriptHistory(db) }
}
afterEach(() => db?.close())

// Explicit ids preserve a deliberately nonlexical insertion order at equal timestamps.
const seed = (table: string, scopeColumn?: string, scopeId?: string, count = 1250) => {
  const insert = db.prepare(`INSERT INTO ${table} (id, ${scopeColumn ? `${scopeColumn},` : ""} role, content, created_at) VALUES (?, ${scopeColumn ? "?," : ""} 'assistant', 'Example reply', ?)`)
  db.transaction(() => {
    for (let i = 0; i < count; i++) insert.run(`m-${count - i}`, ...(scopeColumn ? [scopeId] : []), Date.UTC(2026, 0, 1) + Math.floor(i / 3) * 86_400_000)
  })()
}

describe("retained transcript cursors", () => {
  for (const kind of ["chat", "captain", "task"] as const) it(`pages all ${kind} history without gaps or duplicates at equal timestamps`, () => {
    const { store, history } = setup()
    const project = store.createProject({ name: "Example", repo: "acme/example" })
    const task = store.createTask({ title: "Example task", prompt: "Example", projectId: project.id })
    const scope: HistoryScope = kind === "chat" ? { kind } : { kind, id: kind === "task" ? task.id : project.id }
    seed(kind === "chat" ? "chat_messages" : `${kind}_messages`, kind === "chat" ? undefined : `${kind === "task" ? "task" : "project"}_id`, kind === "chat" ? undefined : scope.id)
    let page = history.page(scope)
    const seen = [...page.messages]
    while (page.before) {
      page = history.page(scope, { before: page.before })
      seen.unshift(...page.messages)
    }
    expect(seen).toHaveLength(1250)
    expect(new Set(seen.map((m) => m.id)).size).toBe(1250)
    expect(seen.map((m) => m.id)).toEqual(Array.from({ length: 1250 }, (_, i) => `m-${1250 - i}`))
    const next = history.page(scope, { after: seen[0]!.id })
    expect(next.messages.map((m) => m.id)).toEqual(seen.slice(1, 101).map((m) => m.id))
    const oldest = history.days(scope, "UTC")[0]!
    expect(oldest.messageId).toBe("m-1250")
    const target = history.page(scope, { around: oldest.messageId })
    expect(target.messages[0]?.id).toBe(oldest.messageId)
    expect(target.before).toBeNull()
    expect(history.page(scope, { after: seen.at(-1)!.id }).messages).toEqual([])
  })

  it("rejects cursors from another project or task and conflicting cursors", () => {
    const { store, history } = setup()
    const a = store.createProject({ name: "Example A" })
    const b = store.createProject({ name: "Example B" })
    const ta = store.createTask({ title: "Example A", prompt: "Example", projectId: a.id })
    const tb = store.createTask({ title: "Example B", prompt: "Example", projectId: b.id })
    const captain = store.addCaptainMessage(b.id, "assistant", "Example scoped reply")
    const task = store.addTaskMessage(tb.id, "assistant", "Example task reply")
    for (const cursor of ["before", "after", "around"]) {
      expect(() => history.page({ kind: "captain", id: a.id }, { [cursor]: captain.id })).toThrow("not found in this conversation")
      expect(() => history.page({ kind: "task", id: ta.id }, { [cursor]: task.id })).toThrow("not found in this conversation")
    }
    expect(history.days({ kind: "captain", id: a.id }, "UTC")).toEqual([])
    expect(() => history.page({ kind: "chat" }, { before: "a", after: "b" })).toThrow("one history cursor")
  })

  it("groups lightweight days in the reader's timezone across DST and skips invisible tools", () => {
    const { history } = setup()
    const insert = db.prepare("INSERT INTO chat_messages (id, role, content, created_at) VALUES (?, ?, ?, ?)")
    for (const [id, at, role] of [
      ["tool", "2026-03-06T12:00:00Z", "tool"],
      ["before", "2026-03-08T04:59:59Z", "assistant"],
      ["midnight", "2026-03-08T05:00:00Z", "user"],
      ["dst", "2026-03-08T07:00:00Z", "assistant"],
      ["next", "2026-03-09T04:00:00Z", "assistant"],
    ]) insert.run(id, role, "Example body never in the date index", Date.parse(at!))
    expect(history.days({ kind: "chat" }, "America/New_York").map((d) => d.messageId)).toEqual(["before", "midnight", "next"])
    expect(JSON.stringify(history.days({ kind: "chat" }, "Asia/Kathmandu"))).not.toContain("Example body")
    expect(() => history.days({ kind: "chat" }, "invalid")).toThrow("timezone")
  })
})
