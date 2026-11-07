import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { ORCHESTRATOR_PROMPT, captainPrompt } from "../server/prompts.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import { ConflictError } from "../server/store.js"
import type { Task, TaskStatus } from "../shared/types.js"
import { testConfig } from "./helpers.js"

// Reopen (TaskManager.reopenTask): Undo for Mark done at any time later. Cody's Reopen and the toast's Undo
// (POST /api/tasks/:id/reopen) and a Captain's or the Coordinator's reopen_task put a done task back in the status
// Mark done closed it from, start no turn, and keep a merge it already had from closing it again. Nothing here
// starts a worker turn: the yard isn't started, and the tasks are seeded at rest.

const yards: BoxYard[] = []
const clients: { close(): Promise<void> }[] = []

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const y of yards.splice(0)) y.stop()
})

function yard() {
  const config = testConfig()
  const y = createBoxYard(config, { webDir: "/nonexistent" })
  yards.push(y)
  const a = y.store.createProject({ name: "alpha" })
  const b = y.store.createProject({ name: "beta" })
  return { y, a, b, dataDir: config.dataDir }
}

const PR = "https://github.com/acme/box-yard/pull/354"

/** A task resting in `status`, as a finished turn leaves it. */
function resting(y: BoxYard, projectId: string, status: TaskStatus, over: Parameters<BoxYard["store"]["updateTask"]>[1] = {}, title = `A ${status} task`): Task {
  const t = y.store.createTask({ projectId, title, prompt: title })
  y.store.updateTask(t.id, { status, turnCount: 2, ...over })
  return y.store.getTask(t.id)!
}

const row = (y: BoxYard, id: string) => y.store.getTaskRow(id)!
const events = (y: BoxYard, id: string) =>
  y.store
    .listTaskMessages(id, 200)
    .filter((m) => m.role === "event")
    .map((m) => m.content)

describe("reopenTask", () => {
  it("puts a task back in the status Mark done closed it from, its PR state kept, and starts no turn", async () => {
    const { y, a } = yard()
    const cases: [TaskStatus, Parameters<BoxYard["store"]["updateTask"]>[1]][] = [
      ["idle", {}],
      ["pr_ready", { prUrl: PR, prState: "open" }],
      ["failed", { error: "npm test exited 1" }],
      ["needs_input", { question: "Which colour?" }],
    ]
    for (const [status, over] of cases) {
      const t = resting(y, a.id, status, over)
      const done = await y.tasks.closeTask(t.id)
      expect(done.status).toBe("done")
      expect(done.question).toBeNull()
      const back = y.tasks.reopenTask(t.id)
      expect(back.status, status).toBe(status)
      expect(back.prState).toBe(t.prState)
      expect(back.prUrl).toBe(t.prUrl)
      expect(back.error).toBe(t.error)
      expect(back.question).toBe(t.question)
      // No turn: nothing queued, no turn id, the same turn count.
      expect(row(y, t.id).current_turn_id).toBeNull()
      expect(back.turnCount).toBe(2)
      expect(y.store.listQueuedInputs(t.id)).toEqual([])
      expect(row(y, t.id).done_from_json).toBeNull()
      expect(events(y, t.id).at(-1)).toMatch(/^Reopened by Cody: back to .*\. No turn started\.$/)
    }
  })

  it("rests a task whose turn or wait the close ended, and one done some other way: PR ready with an open PR, else idle", async () => {
    const { y, a } = yard()
    const waiting = resting(y, a.id, "waiting", { prUrl: PR, prState: "open" })
    await y.tasks.closeTask(waiting.id)
    expect(y.tasks.reopenTask(waiting.id).status).toBe("pr_ready")

    // Done by its PR's merge (no Mark done, so nothing stored): back to idle, the PR still merged.
    const merged = resting(y, a.id, "done", { prUrl: PR, prState: "merged", prMergedAt: Date.now() })
    const back = y.tasks.reopenTask(merged.id)
    expect(back.status).toBe("idle")
    expect(back.prState).toBe("merged")

    // A PR that merged while it was done: what it was waiting for has landed, so it rests idle.
    const ready = resting(y, a.id, "pr_ready", { prUrl: PR, prState: "open" })
    await y.tasks.closeTask(ready.id)
    y.store.updateTask(ready.id, { prState: "merged", prMergedAt: Date.now() })
    expect(y.tasks.reopenTask(ready.id).status).toBe("idle")
  })

  it("refuses a task that isn't done", () => {
    const { y, a } = yard()
    const t = resting(y, a.id, "idle")
    expect(() => y.tasks.reopenTask(t.id)).toThrow(ConflictError)
    expect(() => y.tasks.reopenTask(t.id)).toThrow(/isn't done \(it's idle\)/)
  })

  it("forgets what Mark done closed it from once something else picks it up", async () => {
    const { y, a } = yard()
    const t = resting(y, a.id, "failed", { error: "boom" })
    await y.tasks.closeTask(t.id)
    expect(JSON.parse(row(y, t.id).done_from_json!)).toEqual({ status: "failed", question: null, parent: null })
    // A message picks it up (out of done), and later its PR's merge closes it: that close stored nothing.
    y.store.updateTask(t.id, { status: "queued" })
    expect(row(y, t.id).done_from_json).toBeNull()
    y.store.updateTask(t.id, { status: "done" })
    expect(y.tasks.reopenTask(t.id).status).toBe("idle")
  })

  it("keeps a reopened task open against the merge it already had, but not against a new PR's", async () => {
    const { y, a } = yard()
    const t = resting(y, a.id, "pr_ready", { prUrl: PR, prState: "open" })
    await y.tasks.closeTask(t.id)
    y.store.updateTask(t.id, { prState: "merged", prMergedAt: Date.now() })
    const back = y.tasks.reopenTask(t.id)
    expect(back.status).toBe("idle")
    expect(row(y, t.id).reopened_merged_pr).toBe(PR)
    expect(events(y, t.id).at(-1)).toContain("Its PR #354 has merged already, and that merge won't move it to done again.")
    // Done when its PR merges' catch-up (start, every settings save) leaves it alone, and a turn's end would too.
    expect(y.tasks.autoDoneOnMerge(row(y, t.id))).toBe(false)
    expect(y.tasks.doneMergedResting()).toBe(0)
    expect(row(y, t.id).status).toBe("idle")
    // The agent opens another PR and that one merges: Done when its PR merges counts again.
    const next = "https://github.com/acme/box-yard/pull/355"
    y.store.updateTask(t.id, { prUrl: next, prState: "merged", prMergedAt: Date.now() })
    expect(y.tasks.autoDoneOnMerge(row(y, t.id))).toBe(true)
    expect(y.tasks.doneMergedResting()).toBe(1)
    expect(row(y, t.id).status).toBe("done")
  })

  it("says an archived workspace stays archived until the next message", async () => {
    const { y, a } = yard()
    const t = resting(y, a.id, "idle", { archivePath: "/tmp/nowhere.tgz", lastArchivedAt: Date.now() })
    await y.tasks.closeTask(t.id)
    const back = y.tasks.reopenTask(t.id)
    expect(back.boxId).toBeNull()
    expect(events(y, t.id).at(-1)).toContain("Its workspace stays archived; the next message restores it.")
  })

  it("reopens the sub-tasks that closed with it, not ones closed on their own", async () => {
    const { y, a } = yard()
    const parent = resting(y, a.id, "idle", {}, "Parent")
    const kid = (title: string, status: TaskStatus) => {
      const k = y.store.createTask({ projectId: a.id, title, prompt: title, subtask: { parentId: parent.id, rootId: parent.id, depth: 1, withParent: true } })
      y.store.updateTask(k.id, { status })
      return k
    }
    const withIt = kid("Closes with its parent", "pr_ready")
    y.store.updateTask(withIt.id, { prUrl: PR, prState: "open" })
    const before = kid("Closed on its own", "idle")
    await y.tasks.closeTask(before.id)
    await y.tasks.closeTask(parent.id)
    expect(row(y, withIt.id).status).toBe("done")

    y.tasks.reopenTask(parent.id)
    expect(row(y, parent.id).status).toBe("idle")
    expect(row(y, withIt.id).status).toBe("pr_ready")
    expect(events(y, withIt.id).at(-1)).toMatch(/^Reopened with its parent task, Parent: back to PR ready/)
    expect(row(y, before.id).status).toBe("done")
  })
})

describe("reopen_task (MCP)", () => {
  type ToolRes = { content: { text: string }[]; isError?: boolean }
  async function mcpAs(y: BoxYard, dataDir: string, caller: McpCaller) {
    const deps = { store: y.store, tasks: y.tasks, hub: y.hub, artifacts: null as never, publicUrl: () => "", scheduler: y.scheduler, captains: y.captains, settings: y.settings, notes: y.notes, uploads: new Uploads(uploadsDir(dataDir), 1024 * 1024) }
    const mcp = buildMcpServer(deps, caller)
    const [s, c] = InMemoryTransport.createLinkedPair()
    await mcp.connect(s)
    const client = new Client({ name: "test", version: "0" })
    await client.connect(c)
    clients.push({ close: async () => (await client.close(), await mcp.close()) })
    return {
      names: async () => (await client.listTools()).tools.map((t) => t.name),
      tool: async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolRes,
    }
  }

  it("lets a Captain reopen its own project's done tasks, never another project's", async () => {
    const { y, a, b, dataDir } = yard()
    const mine = resting(y, a.id, "pr_ready", { prUrl: PR, prState: "open" }, "Mine")
    const theirs = resting(y, b.id, "idle", {}, "Theirs")
    await y.tasks.closeTask(mine.id)
    await y.tasks.closeTask(theirs.id)
    const captain = await mcpAs(y, dataDir, { kind: "captain", projectId: a.id })
    expect(await captain.names()).toContain("reopen_task")

    const denied = await captain.tool("reopen_task", { task: theirs.id })
    expect(denied.isError).toBe(true)
    expect(denied.content[0]!.text).toMatch(/^Out of scope: .*You are the Captain for project "alpha"/)
    expect(row(y, theirs.id).status).toBe("done")

    const res = await captain.tool("reopen_task", { task: mine.id, reason: "Cody wants the empty state reworked" })
    expect(res.isError).toBeFalsy()
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ id: mine.id, status: "pr_ready" })
    expect(row(y, mine.id).status).toBe("pr_ready")
    expect(y.store.listQueuedInputs(mine.id)).toEqual([])
    expect(events(y, mine.id).at(-1)).toBe("Reopened by its project's Captain (Cody wants the empty state reworked): back to PR ready, waiting for review. No turn started.")
  })

  it("lets the Coordinator reopen any project's task, and send a follow-up in the same step", async () => {
    const { y, b, dataDir } = yard()
    const t = resting(y, b.id, "idle", {}, "Theirs")
    await y.tasks.closeTask(t.id)
    const coordinator = await mcpAs(y, dataDir, { kind: "coordinator" })
    const res = await coordinator.tool("reopen_task", { task: t.id, message: "Also handle the empty list." })
    expect(res.isError).toBeFalsy()
    const out = JSON.parse(res.content[0]!.text) as { reopened: string; delivery: string }
    expect(out.reopened).toBe("back to idle")
    expect(out.delivery).toMatch(/^starting|^resuming/)
    expect(events(y, t.id)).toContain("Reopened by the Coordinator: back to idle. No turn started.")
    // The follow-up is queued as send_to_task queues it, and the task is out of done.
    expect(y.store.listQueuedInputs(t.id).map((i) => i.content)).toEqual(["Also handle the empty list."])
    expect(row(y, t.id).status).not.toBe("done")
  })

  it("refuses a task that isn't done, and never marks one done", async () => {
    const { y, a, dataDir } = yard()
    const t = resting(y, a.id, "idle")
    const captain = await mcpAs(y, dataDir, { kind: "captain", projectId: a.id })
    const res = await captain.tool("reopen_task", { task: t.id, message: "hi" })
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toBe("A idle task isn't done (it's idle), so there's nothing to reopen. Use send_to_task to message it.")
    expect(y.store.listQueuedInputs(t.id)).toEqual([])
    expect(row(y, t.id).status).toBe("idle")
    // close_task still refuses.
    expect((await captain.tool("close_task", { task: t.id })).isError).toBe(true)
  })

  it("is only for Captains and the Coordinator: task agents don't get it, and their prompts name it", () => {
    const runner = fs.readFileSync(path.join(import.meta.dirname, "../runner/box-runner.mjs"), "utf8")
    expect(runner).not.toContain("reopen_task")
    expect(runner).toContain('name: "finish"')
    const { y, a } = yard()
    const project = y.store.getProject(a.id)!
    expect(captainPrompt(project)).toContain("prefer reopen_task with message over a new task")
    expect(ORCHESTRATOR_PROMPT).toContain("reopen_task brings a done task back to Cody's lists")
  })
})
