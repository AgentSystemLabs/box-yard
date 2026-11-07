import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { LocalProvider } from "../server/providers/local.js"
import { FAKE_CLAUDE, testConfig, tmpDir, waitFor } from "./helpers.js"
import type { WorkerEvent } from "../server/bus.js"

const cleanups: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); vi.restoreAllMocks() })
async function fixture() {
  const provider = new LocalProvider(tmpDir(), FAKE_CLAUDE)
  const yard = createBoxYard(testConfig(), { provider, webDir: "/nonexistent" })
  cleanups.push(() => yard.stop())
  const box = await provider.create()
  yard.store.upsertBox({ id: box, provider: "local", status: "ready", created_at: 1, last_used_at: 1 })
  const project = yard.store.createProject({ name: "example" })
  const task = yard.store.createTask({ projectId: project.id, title: "Example", prompt: "Example" })
  yard.store.updateTask(task.id, { status: "working", boxId: box, currentTurnId: "turn_example" })
  const dir = path.join(provider.root(box), "tasks", task.id)
  fs.mkdirSync(path.join(dir, "work"), { recursive: true })
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ taskId: task.id, projectId: project.id }))
  fs.writeFileSync(path.join(dir, "turn.json"), JSON.stringify({ turnId: "turn_example" }))
  const c = yard.store.addTaskCompaction({ taskId: task.id, sessionId: "s", at: 1, statusBefore: null, statusAfter: null, tokensBefore: null, tokensAfter: null, summary: "Saved dated task recap.", archivePath: null, archiveAvailable: false })
  return { yard, provider, dir, task, c }
}

describe("task compaction history runner channel", () => {
  it("round-trips real stdio calls through events and server replies without a worker-server socket", async () => {
    const { yard, dir, task, c } = await fixture()
    const client = new Client({ name: "history-test", version: "0" })
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("runner/box-runner.mjs"), "mcp", dir], stderr: "pipe" })
    await client.connect(transport)
    cleanups.push(() => client.close())
    expect((await client.listTools()).tools.map(t => t.name)).toContain("compaction_history")
    let seen = 0
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const pending = client.callTool({ name, arguments: args })
      const event = await waitFor(() => {
        const events = fs.existsSync(path.join(dir, "events.jsonl")) ? fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s) as WorkerEvent) : []
        return events.filter(e => e.t === "compaction_history")[seen] ?? null
      }, "history request")
      seen++
      expect(event.turnId).toBe("turn_example")
      await yard.tasks.apply(task.id, event)
      const result = await pending as { content: { text: string }[]; isError?: boolean }
      expect(fs.readdirSync(dir).filter(f => f.startsWith("history-reply-"))).toEqual([])
      return result
    }
    const listed = await call("compaction_history")
    expect(JSON.parse(listed.content[0]!.text)).toMatchObject({ total: 1, entries: [{ id: c.id, title: "Saved dated task recap." }] })
    expect(JSON.parse((await call("read_compaction", { compaction: c.id })).content[0]!.text)).toMatchObject({ extractive: true })
    expect(JSON.parse((await call("read_compaction", { compaction: c.id, level: "full" })).content[0]!.text)).toMatchObject({ markdown: "Saved dated task recap." })
    expect((await call("compaction_history", { task: "another-task" })).isError).toBe(true)
  })

  it("ignores stale turns and unsafe response ids before reading or writing history", async () => {
    const { yard, provider, task } = await fixture()
    const write = vi.spyOn(provider, "writeFile")
    const query = vi.spyOn(yard.store.db, "prepare")
    for (const [id, turnId] of [["../outside", "turn_example"], ["hist_" + "a".repeat(24), "old-turn"], ["hist_" + "a".repeat(24), null]]) {
      await yard.tasks.apply(task.id, { seq: 1, ts: 1, t: "compaction_history", id, turnId, request: { tool: "compaction_history", args: {} } })
    }
    expect(write).not.toHaveBeenCalled()
    expect(query.mock.calls.some(([sql]) => sql.includes("compaction_index"))).toBe(false)
  })
})
