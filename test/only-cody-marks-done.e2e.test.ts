import { afterEach, describe, expect, it, vi } from "vitest"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import type { Project, Task, TaskMessage } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

// Only the owner marks a task done. Real worker turns (fake-claude): an agent's finish, a sub-task's report and a parent's
// cancel_subtasks leave tasks resting for review, the Captain's and the Coordinator's close_task refuses, and Cody's
// Mark done (POST /api/tasks/:id/close) is what moves a task, and its sub-tasks, to done. Reopen
// (POST /api/tasks/:id/reopen) undoes it without a turn.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  dataDir: string
  closing: Promise<void>[]
}
const running: Running[] = []
const clients: { close(): Promise<void> }[] = []

async function start(): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port })
  const yard = createBoxYard(config, { webDir: "/nonexistent" })
  // Mark done returns before its stop/archive/eviction completes. Keep the database open until that work ends.
  const closing: Promise<void>[] = []
  const manager = yard.tasks as unknown as { evictWhenSettled(id: string): Promise<void> }
  const evict = manager.evictWhenSettled.bind(manager)
  vi.spyOn(manager, "evictWhenSettled").mockImplementation((id) => {
    const job = evict(id)
    closing.push(job)
    return job
  })
  // Captains would wake on task notices and start turns of their own.
  yard.captains.tuning.wakeDebounceMs = yard.captains.tuning.wakeQuietMs = 10 * 60_000
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, dataDir: config.dataDir, closing }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const r of running.splice(0)) {
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "worker turns to settle before teardown")
    await Promise.all(r.closing)
    await waitFor(() => !r.yard.orchestrator.busy, "Coordinator to settle before teardown")
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
  vi.restoreAllMocks()
})

async function call<T>(r: Running, method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

type ToolRes = { content: { text: string }[]; isError?: boolean }

/** An in-process MCP client as the Coordinator or as one project's Captain. */
async function mcpAs(r: Running, caller: McpCaller) {
  const y = r.yard
  const deps = { store: y.store, tasks: y.tasks, hub: y.hub, artifacts: null as never, publicUrl: () => "", scheduler: y.scheduler, captains: y.captains, settings: y.settings, notes: y.notes, uploads: new Uploads(uploadsDir(r.dataDir), 1024 * 1024) }
  const mcp = buildMcpServer(deps, caller)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await mcp.connect(a)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(b)
  clients.push({ close: async () => (await client.close(), await mcp.close()) })
  return async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolRes
}

const kids = (r: Running, id: string) => r.yard.store.listTasks().filter((t) => t.parentTaskId === id)
const transcript = (r: Running, id: string): TaskMessage[] => r.yard.store.listTaskMessages(id, 500)
const status = (r: Running, id: string) => r.yard.store.getTaskRow(id)!.status
const notices = (r: Running, id: string) =>
  (r.yard.store.db.prepare("SELECT content FROM chat_messages WHERE role = 'notice' AND json_extract(meta_json, '$.taskId') = ?").all(id) as { content: string }[]).map((n) => n.content)
/** No turn running, and resting in one of `statuses`. */
const resting = (r: Running, id: string, statuses: string[], what: string, timeoutMs = 60_000) =>
  waitFor(() => {
    const row = r.yard.store.getTaskRow(id)
    return row && !row.current_turn_id && statuses.includes(row.status) ? r.yard.store.getTask(id) : null
  }, what, timeoutMs)
const pause = (ms: number) => new Promise((res) => setTimeout(res, ms))

async function project(r: Running): Promise<Project> {
  return call<Project>(r, "POST", "/api/projects", { name: "kitchen" })
}

describe("only Cody marks a task done", () => {
  it("an agent's finish rests its task for review; Cody's Mark done is what makes it done", async () => {
    const r = await start()
    const p = await project(r)
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Write the demo", prompt: "write the demo file" })

    // The mock agent calls finish (no marker): its turn ends idle with finish's summary, and it stays idle.
    const rested = await resting(r, t.id, ["idle", "pr_ready", "done"], "the agent to finish")
    expect(rested.status).toBe("idle")
    expect(rested.summary).toBe("The mock agent wrote box-yard-demo.md.")
    expect(notices(r, t.id).some((n) => n.startsWith("💬 **Write the demo** finished its turn: "))).toBe(true)
    expect(notices(r, t.id).some((n) => n.startsWith("✅"))).toBe(false)
    await pause(500)
    expect(status(r, t.id)).toBe("idle")

    const closed = await call<Task>(r, "POST", `/api/tasks/${t.id}/close`)
    expect(closed.status).toBe("done")
    expect(status(r, t.id)).toBe("done")
  }, 90_000)

  it("Cody's Reopen (POST /reopen) puts a closed task back as it was without a turn; the next message resumes it", async () => {
    const r = await start()
    const p = await project(r)
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Write the menu", prompt: "write the demo file" })
    await resting(r, t.id, ["idle", "pr_ready", "done"], "the agent to finish")
    expect(status(r, t.id)).toBe("idle")

    await call<Task>(r, "POST", `/api/tasks/${t.id}/close`)
    // The close settles (archive, box slot) before the reopen, as when Cody reopens it later.
    await pause(1000)
    const back = await call<Task>(r, "POST", `/api/tasks/${t.id}/reopen`)
    expect(back.status).toBe("idle")
    expect(back.turnCount).toBe(1)
    expect(transcript(r, t.id).at(-1)!.content).toMatch(/^Reopened by the owner: back to idle\. No turn started\./)
    await pause(1000)
    expect(status(r, t.id)).toBe("idle")
    expect(r.yard.store.getTaskRow(t.id)!.turn_count).toBe(1)

    // A second reopen finds nothing to undo: 409.
    const again = await fetch(`${r.base}/api/tasks/${t.id}/reopen`, { method: "POST" })
    expect(again.status).toBe(409)

    await call<Task>(r, "POST", `/api/tasks/${t.id}/messages`, { content: "also add a footer" })
    await waitFor(() => (r.yard.store.getTaskRow(t.id)!.turn_count === 2 ? true : null), "the message to start a turn")
    expect((await resting(r, t.id, ["idle", "pr_ready", "done"], "the follow-up turn to end")).status).toBe("idle")
  }, 90_000)

  it("a sub-task's report never makes it, or its parent, done; Mark done on the parent closes the whole tree", async () => {
    const r = await start()
    const p = await project(r)
    const parent = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Compare pans", prompt: "spawn subtasks: Cast iron | Nonstick [wait]" })

    // The sub-tasks report and call finish; the parent answers from their reports and calls finish too.
    await resting(r, parent.id, ["idle", "pr_ready", "done"], "the parent to finish from its sub-tasks' reports", 90_000)
    const tree = [parent.id, ...kids(r, parent.id).map((k) => k.id)]
    expect(tree).toHaveLength(3)
    await waitFor(() => tree.every((id) => !r.yard.store.getTaskRow(id)!.current_turn_id) || null, "every turn in the tree to end")
    expect(tree.map((id) => status(r, id))).toEqual(["idle", "idle", "idle"])
    expect(r.yard.store.getTask(parent.id)!.summary ?? "").toMatch(/Combined answer from 2 sub-tasks/)
    await pause(500)
    expect(tree.map((id) => status(r, id))).toEqual(["idle", "idle", "idle"])

    await call(r, "POST", `/api/tasks/${parent.id}/close`)
    await waitFor(() => tree.every((id) => status(r, id) === "done") || null, "Mark done on the parent to close the tree")
    // Reopen on the parent brings the tree back, as it was.
    await call(r, "POST", `/api/tasks/${parent.id}/reopen`)
    expect(tree.map((id) => status(r, id))).toEqual(["idle", "idle", "idle"])
  }, 120_000)

  it("cancel_subtasks stops the sub-tasks and leaves them resting for review, never done", async () => {
    const r = await start()
    const p = await project(r)
    const parent = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Long research", prompt: "spawn subtasks: Slow one {hang} | Other {hang}\n[cancel]" })

    await resting(r, parent.id, ["idle", "pr_ready", "done", "waiting"], "the parent to cancel its sub-tasks and finish", 60_000)
    expect(status(r, parent.id)).toBe("idle")
    const both = kids(r, parent.id)
    expect(both.map((k) => k.title)).toEqual(["Slow one", "Other"])
    for (const k of both) await resting(r, k.id, ["idle", "pr_ready", "failed", "done"], `${k.title} to stop`)
    expect(both.map((k) => status(r, k.id))).toEqual(["idle", "idle"])
    for (const k of both) expect(transcript(r, k.id).some((m) => m.content === "Cancelled by its parent task, Long research: it rests for the owner's review.")).toBe(true)
    expect(transcript(r, parent.id).some((m) => m.role === "event" && m.content === "Cancelled 2 sub-tasks.")).toBe(true)
    // A stopped turn doesn't report: nothing wakes the parent again.
    await pause(1000)
    expect(transcript(r, parent.id).filter((m) => m.role === "agent" && m.meta?.subtaskReport)).toEqual([])
    expect(r.yard.store.getTaskRow(parent.id)!.turn_count).toBe(1)
    expect([parent.id, ...both.map((k) => k.id)].map((id) => status(r, id))).toEqual(["idle", "idle", "idle"])
  }, 90_000)

  it("close_task refuses for the Coordinator and a Captain, and stop_task still stops a running agent", async () => {
    const r = await start()
    const p = await project(r)
    const t = r.yard.store.createTask({ projectId: p.id, title: "Ready for review", prompt: "x" })
    r.yard.store.updateTask(t.id, { status: "idle" })

    for (const caller of [{ kind: "coordinator" }, { kind: "captain", projectId: p.id }] as McpCaller[]) {
      const tool = await mcpAs(r, caller)
      const res = await tool("close_task", { task: t.id })
      expect(res.isError, caller.kind).toBe(true)
      expect(res.content[0]!.text).toMatch(/^Only the owner marks a task done/)
      expect(res.content[0]!.text).toMatch(/stop_task/)
      expect(status(r, t.id)).toBe("idle")
    }

    const hanging = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Hangs", prompt: "work forever [hang]" })
    await waitFor(() => status(r, hanging.id) === "working" || null, "the agent to start working", 30_000)
    const tool = await mcpAs(r, { kind: "captain", projectId: p.id })
    expect((await tool("stop_task", { task: hanging.id })).isError).toBeFalsy()
    expect((await resting(r, hanging.id, ["idle", "failed", "done"], "the stopped agent to rest")).status).toBe("idle")
  }, 90_000)
})
