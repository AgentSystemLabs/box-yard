import { afterEach, describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { taskCompactionHistory } from "../server/taskCompactionHistory.js"
import { workerSystemPrompt } from "../server/prompts.js"
import { tmpDir } from "./helpers.js"

const stores: Store[] = []
afterEach(() => { for (const s of stores.splice(0)) s.db.close() })
function fixture() {
  const store = new Store(openDb(tmpDir(), ":memory:")); stores.push(store)
  const project = store.createProject({ name: "example" })
  const own = store.createTask({ projectId: project.id, title: "Own", prompt: "Own" })
  const other = store.createTask({ projectId: project.id, title: "Other", prompt: "Other" })
  const save = (taskId: string, summary: string) => store.addTaskCompaction({ taskId, sessionId: "s", at: Date.parse("2026-10-20T10:00:00Z"), statusBefore: null, statusAfter: null, tokensBefore: null, tokensAfter: null, summary, archivePath: null, archiveAvailable: false })
  return { store, project, own, other, save }
}

describe("task history uses the task event identity", () => {
  it("lists all retained own recaps in stable bounded pages, then reads summary and full", () => {
    const { store, own, other, save } = fixture()
    for (let i = 0; i < 25; i++) save(own.id, `Work on dated navigation ${i}.`)
    const privateRecap = save(other.id, "PRIVATE other task work.")
    const page = taskCompactionHistory(store, own.id, { tool: "compaction_history", args: { limit: 20 } })
    expect(page).toMatchObject({ total: 25, matched: 25 })
    if (!("entries" in page)) throw new Error("Expected page")
    const older = taskCompactionHistory(store, own.id, { tool: "compaction_history", args: { before: page.nextBefore } })
    expect(older).toMatchObject({ entries: expect.any(Array), nextBefore: null })
    if (!("entries" in older)) throw new Error("Expected page")
    expect(new Set([...page.entries, ...older.entries].map(e => e.id)).size).toBe(25)
    const id = page.entries[0]!.id
    expect(taskCompactionHistory(store, own.id, { tool: "read_compaction", args: { compaction: id } })).toMatchObject({ extractive: true, summary: expect.stringContaining("dated navigation") })
    expect(taskCompactionHistory(store, own.id, { tool: "read_compaction", args: { compaction: id, level: "full" } })).toMatchObject({ markdown: expect.stringContaining("dated navigation"), nextOffset: null })
    expect(JSON.stringify(page)).not.toContain("PRIVATE")
    expect(() => taskCompactionHistory(store, own.id, { tool: "read_compaction", args: { compaction: privateRecap.id, level: "full" } })).toThrow(/No saved compaction/)
  })

  it("rejects attempts to choose another collection, paths, unbounded output and invalid dates", () => {
    const { store, own, other, save } = fixture(); save(own.id, "Own work")
    for (const args of [{ task: other.id }, { project: "other" }, { limit: 1000 }, { since: "yesterday" }]) {
      expect(() => taskCompactionHistory(store, own.id, { tool: "compaction_history", args })).toThrow()
    }
    for (const args of [{ compaction: "../private" }, { compaction: "unknown", task: other.id }, { compaction: "unknown", offset: -1 }, { compaction: "unknown", limit: 999999 }]) {
      expect(() => taskCompactionHistory(store, own.id, { tool: "read_compaction", args })).toThrow()
    }
  })

  it("does not rename owner mentions in saved index content", () => {
    const { project, own } = fixture()
    const prompt = workerSystemPrompt({ project, task: own, branch: null, port: 4480, ownerName: "Sam", compactionHistory: "Saved topic: Cody requested date navigation." })
    expect(prompt).toContain("ask Sam (the human)")
    expect(prompt).toContain("Saved topic: Cody requested date navigation.")
  })
})
