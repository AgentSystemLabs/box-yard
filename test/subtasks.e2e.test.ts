import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer } from "../server/mcp.js"
import type { Project, Task, TaskMessage } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

// Sub-tasks end to end (server/subtasks.ts): real worker turns (fake-claude) start sub-tasks with spawn_subtasks, the
// sub-tasks run as tasks of their own and report back, and the parent answers from the reports.

interface Running {
  yard: BoxYard
  server: Server
  base: string
}
const running: Running[] = []

async function start(): Promise<Running> {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port }), { webDir: "/nonexistent" })
  // Captains would wake on task notices and start turns of their own.
  yard.captains.tuning.wakeDebounceMs = yard.captains.tuning.wakeQuietMs = 10 * 60_000
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}` }
  running.push(r)
  return r
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
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

const kids = (r: Running, id: string) => r.yard.store.listTasks().filter((t) => t.parentTaskId === id)
const transcript = (r: Running, id: string): TaskMessage[] => r.yard.store.listTaskMessages(id, 500)
const reports = (r: Running, id: string) => transcript(r, id).filter((m) => m.role === "agent" && m.meta?.subtaskReport)
const resting = (r: Running, id: string, statuses: string[], what: string, timeoutMs = 60_000) =>
  waitFor(() => {
    const row = r.yard.store.getTaskRow(id)
    return row && !row.current_turn_id && statuses.includes(row.status) ? r.yard.store.getTask(id) : null
  }, what, timeoutMs)

/** What fake-claude got on each turn of a task's session: its --model and --effort. */
const launches = (r: Running, id: string) => {
  const session = r.yard.store.getTaskRow(id)!.session_id!
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".fake-claude"), "fake-sessions", `${session}.json`)
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { turns: { model: string | null; effort: string | null }[] }).turns.map((t) => [t.model, t.effort])
}
const turnJson = (r: Running, id: string) => {
  const row = r.yard.store.getTaskRow(id)!
  return JSON.parse(fs.readFileSync(path.join(r.yard.tasks.taskDir(row.box_id!, id), "turn.json"), "utf8")) as { model: string | null; effort: string | null; resume: boolean }
}

describe("sub-tasks", () => {
  it("runs one parent and its sub-tasks (one of them nested), and the parent answers from their reports", async () => {
    const r = await start()
    const project = await call<Project>(r, "POST", "/api/projects", { name: "kitchen" })
    const apply = r.yard.tasks.apply.bind(r.yard.tasks)
    vi.spyOn(r.yard.tasks, "apply").mockImplementation(async (id, event) => {
      const parentId = r.yard.store.getTaskRow(id)?.parent_task_id
      // This case asserts that a waiting parent wakes once for the final report. Fast fake children can
      // otherwise report before its initial turn ends, exercising a different (queued-input) scenario.
      if (event.t === "turn_end" && parentId && r.yard.store.getTaskRow(parentId)?.turn_count === 1) {
        await waitFor(() => r.yard.store.getTaskRow(parentId)?.status === "waiting", "the parent to wait before child reports")
      }
      return apply(id, event)
    })
    const parent = await call<Task>(r, "POST", "/api/tasks", {
      projectId: project.id,
      title: "Research the best way to cook an omelette",
      prompt: "research the best way to cook an omlette use 4 sub agents to do it",
    })

    // Every agent in the tree calls finish: each rests idle, ready for Cody's review (only Cody marks a task done).
    const done = await resting(r, parent.id, ["idle"], "the parent to finish from its sub-tasks' reports", 90_000)
    const children = kids(r, parent.id)
    expect(children.map((k) => k.title)).toEqual(["Classic technique", "Ingredients and ratios", "Pans and heat", "Chef and expert methods"])
    expect(children.every((k) => k.status === "idle" && k.subtaskDepth === 1 && k.rootTaskId === parent.id && k.withParent)).toBe(true)
    // The first one split its part in two, one level further down.
    const nested = kids(r, children[0]!.id)
    expect(nested.map((k) => [k.title, k.subtaskDepth, k.rootTaskId, k.status])).toEqual([
      ["French rolled method", 2, parent.id, "idle"],
      ["American folded method", 2, parent.id, "idle"],
    ])
    // A sub-task with runs_on "same" runs where its parent runs.
    const box = r.yard.store.getTaskRow(parent.id)!.box_id
    expect([...children, ...nested].every((k) => r.yard.store.getTaskRow(k.id)!.box_id === box)).toBe(true)

    // The parent's transcript links the sub-tasks it started and shows each report as a line from it.
    const started = transcript(r, parent.id).find((m) => m.meta?.kind === "subtasks" && Array.isArray(m.meta.subtasks))
    expect((started?.meta?.subtasks as { id: string }[]).map((s) => s.id)).toEqual(children.map((k) => k.id))
    expect(reports(r, parent.id).map((m) => m.meta?.from).sort()).toEqual(children.map((k) => k.id).sort())
    expect(reports(r, children[0]!.id).map((m) => m.meta?.from).sort()).toEqual(nested.map((k) => k.id).sort())

    // It rested waiting while they ran, and their reports woke it once, together: one turn of Cody's, one of theirs.
    expect(r.yard.store.listTaskTurns(parent.id).map((t) => t.trigger)).toEqual(["cody", "agent"])
    expect(transcript(r, parent.id).some((m) => m.role === "event" && /^Waiting for 4 sub-tasks to report/.test(m.content))).toBe(true)
    expect(done.status).toBe("idle")
    expect(r.yard.store.hasInputs(parent.id)).toBe(false)
    // Its answer is what Cody asked for, so it notifies like any finished task.
    const notices = r.yard.store.db
      .prepare("SELECT content FROM chat_messages WHERE role = 'notice' AND json_extract(meta_json, '$.taskId') = ?")
      .all(parent.id) as { content: string }[]
    expect(notices.some((n) => n.content.startsWith("💬 **Research the best way to cook an omelette** finished its turn: Combined answer from 4 sub-tasks"))).toBe(true)
    // Its sub-tasks' updates went to it as reports, not to Cody's chats as well.
    const kidNotices = r.yard.store.db
      .prepare(`SELECT content FROM chat_messages WHERE role = 'notice' AND json_extract(meta_json, '$.taskId') IN (${[...children, ...nested].map(() => "?").join(",")})`)
      .all(...[...children, ...nested].map((k) => k.id)) as { content: string }[]
    expect(kidNotices.filter((n) => /is done|finished its turn/.test(n.content))).toEqual([])
  }, 120_000)

  it("waits for the reports mid-turn with wait_for_subtasks, so they don't start another turn", async () => {
    const r = await start()
    const project = await call<Project>(r, "POST", "/api/projects", { name: "kitchen" })
    const parent = await call<Task>(r, "POST", "/api/tasks", { projectId: project.id, title: "Compare pans", prompt: "spawn subtasks: Cast iron | Nonstick [wait]" })
    const done = await resting(r, parent.id, ["idle"], "the parent to finish in its first turn")
    expect(done.turnCount).toBe(1)
    expect(kids(r, parent.id).map((k) => k.status)).toEqual(["idle", "idle"])
    // wait_for_subtasks took the reports off the queue, so nothing is left to start a second turn.
    await new Promise((res) => setTimeout(res, 1500))
    expect(r.yard.store.getTaskRow(parent.id)!.turn_count).toBe(1)
    expect(r.yard.store.hasInputs(parent.id)).toBe(false)
    expect(r.yard.store.getTask(parent.id)!.summary ?? "").toMatch(/Combined answer from 2 sub-tasks/)
  }, 90_000)

  it("launches a sub-task on the model and effort it asked for, on its first and resumed turns", async () => {
    const r = await start()
    const project = await call<Project>(r, "POST", "/api/projects", { name: "kitchen" })
    const parent = await call<Task>(r, "POST", "/api/tasks", {
      projectId: project.id,
      title: "Review the recipe",
      prompt: "spawn subtasks: Sonnet review {model=claude-sonnet-5-5} {effort=high} | Same review\n[wait]",
      model: "claude-opus-5-5",
      effort: "low",
    })
    await resting(r, parent.id, ["idle"], "the parent to finish from its sub-tasks' reports")
    const [pinned, same] = kids(r, parent.id)
    expect([pinned!.title, same!.title]).toEqual(["Sonnet review", "Same review"])
    // Its own pins, saved like create_task's; the one that asked for nothing keeps its parent's, as before.
    expect(pinned).toMatchObject({ agentCli: "claude", model: "claude-sonnet-5-5", effort: "high" })
    expect(same).toMatchObject({ agentCli: "claude", model: "claude-opus-5-5", effort: "low" })
    expect(launches(r, pinned!.id)).toEqual([["claude-sonnet-5-5", "high"]])
    expect(launches(r, same!.id)).toEqual([["claude-opus-5-5", "low"]])

    // A later turn of the sub-task resumes its session on the same pins.
    await call(r, "POST", `/api/tasks/${pinned!.id}/messages`, { content: "Check the salt as well." })
    await waitFor(() => r.yard.store.getTaskRow(pinned!.id)?.turn_count === 2 || null, "the sub-task's second turn to start")
    await resting(r, pinned!.id, ["idle"], "the sub-task's second turn to end")
    expect(launches(r, pinned!.id)).toEqual([
      ["claude-sonnet-5-5", "high"],
      ["claude-sonnet-5-5", "high"],
    ])
    expect(turnJson(r, pinned!.id)).toMatchObject({ model: "claude-sonnet-5-5", effort: "high", resume: true })
    expect(r.yard.store.listTaskTurns(pinned!.id).map((t) => [t.model, t.effort])).toEqual([
      ["claude-sonnet-5-5", "high"],
      ["claude-sonnet-5-5", "high"],
    ])

    // get_task shows them to the Captain.
    const mcp = buildMcpServer({ store: r.yard.store, tasks: r.yard.tasks, hub: r.yard.hub, artifacts: null as never, uploads: null as never, publicUrl: () => "", settings: r.yard.settings, identities: r.yard.identities }, { kind: "captain", projectId: project.id })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await mcp.connect(a)
    const client = new Client({ name: "subtask-pins-test", version: "0" })
    await client.connect(b)
    try {
      const got = await client.callTool({ name: "get_task", arguments: { task: pinned!.id } })
      expect(JSON.parse((got.content as { text: string }[])[0]!.text)).toMatchObject({ agent: "claude", model: "claude-sonnet-5-5", effort: "high" })
    } finally {
      await client.close()
    }
    // Its new report woke the parent once more: let that turn end before the server stops.
    await waitFor(() => r.yard.store.getTaskRow(parent.id)?.turn_count === 2 || null, "the parent to take the new report")
    await resting(r, parent.id, ["idle"], "the parent to answer the new report")
  }, 120_000)

  it("refuses a sub-task pinned to a model its harness can't run, starting none", async () => {
    const r = await start()
    const project = await call<Project>(r, "POST", "/api/projects", { name: "kitchen" })
    const parent = await call<Task>(r, "POST", "/api/tasks", { projectId: project.id, title: "Mixed review", prompt: "spawn subtasks: Fine | Wrong harness {model=gpt-6.1-sol}" })
    await resting(r, parent.id, ["idle"], "the refused spawn's turn to end")
    expect(kids(r, parent.id)).toHaveLength(0)
    expect(transcript(r, parent.id).find((m) => m.meta?.refused)?.content).toBe(
      'Sub-tasks not started: Sub-task 2 ("Wrong harness"): Model gpt-6.1-sol cannot run on Claude Code. Choose a compatible model or use its defaults. It runs on Claude Code like you unless it asks for another agent: pass agent "codex" with that model.',
    )
  }, 60_000)

  it("refuses sub-tasks over Settings' depth and fan-out caps", async () => {
    const r = await start()
    r.yard.settings.update({ subtaskMaxDepth: 1, subtaskMaxChildren: 2 })
    const project = await call<Project>(r, "POST", "/api/projects", { name: "kitchen" })

    const wide = await call<Task>(r, "POST", "/api/tasks", { projectId: project.id, title: "Too many", prompt: "spawn subtasks: A | B | C" })
    await resting(r, wide.id, ["idle"], "the refused spawn's turn to end")
    expect(kids(r, wide.id)).toHaveLength(0)
    expect(transcript(r, wide.id).some((m) => m.meta?.refused && /starts at most 2 sub-tasks/.test(m.content))).toBe(true)

    const deep = await call<Task>(r, "POST", "/api/tasks", { projectId: project.id, title: "Too deep", prompt: "spawn subtasks: Outer > Inner | Other" })
    await resting(r, deep.id, ["idle"], "the parent to finish from its two reports", 90_000)
    const [outer, other] = kids(r, deep.id)
    expect([outer!.title, other!.title]).toEqual(["Outer", "Other"])
    // Outer is at depth 1, the cap: its own spawn is refused, and it reports that instead.
    expect(kids(r, outer!.id)).toHaveLength(0)
    expect(transcript(r, outer!.id).some((m) => m.meta?.refused && /nest at most 1 deep/.test(m.content))).toBe(true)
    expect(reports(r, deep.id).find((m) => m.meta?.from === outer!.id)?.content).toMatch(/^Not started: Sub-tasks nest at most 1 deep/)
  }, 120_000)

  it("stops and closes a parent's whole tree with it", async () => {
    const r = await start()
    const project = await call<Project>(r, "POST", "/api/projects", { name: "kitchen" })
    const parent = await call<Task>(r, "POST", "/api/tasks", {
      projectId: project.id,
      title: "Long research",
      prompt: "spawn subtasks: Middle > Deep {hang} | Side {hang}",
    })
    // The parent and Middle rest waiting on theirs; Deep and Side hang mid-turn.
    const tree = await waitFor(() => {
      const [middle, side] = kids(r, parent.id)
      const deep = middle && kids(r, middle.id)[0]
      const row = (t: Task | undefined) => (t ? r.yard.store.getTaskRow(t.id) : null)
      return row(deep)?.status === "working" && row(side)?.status === "working" && row(middle)?.status === "waiting" && r.yard.store.getTaskRow(parent.id)?.status === "waiting"
        ? { middle: middle!, side: side!, deep: deep! }
        : null
    }, "the tree to be under way", 60_000)

    await call(r, "POST", `/api/tasks/${parent.id}/stop`)
    for (const k of [tree.deep, tree.side, tree.middle]) await resting(r, k.id, ["idle", "failed"], `${k.title} to stop with the parent`)
    expect(r.yard.store.getTaskRow(parent.id)!.status).toBe("idle")
    expect(transcript(r, tree.middle.id).some((m) => m.content === "Stopped with its parent task, Long research.")).toBe(true)
    expect(transcript(r, tree.deep.id).some((m) => m.content === "Stopped with its parent task, Middle.")).toBe(true)
    // Stopped turns don't report, so nothing wakes the parent.
    await new Promise((res) => setTimeout(res, 1000))
    expect(reports(r, parent.id)).toHaveLength(0)
    expect(r.yard.store.getTaskRow(parent.id)!.turn_count).toBe(1)

    await call(r, "POST", `/api/tasks/${parent.id}/close`)
    await waitFor(() => [parent, tree.middle, tree.side, tree.deep].every((t) => r.yard.store.getTaskRow(t.id)?.status === "done"), "the whole tree to close")
    expect(transcript(r, tree.deep.id).some((m) => m.content === "Closed with its parent task, Middle.")).toBe(true)
  }, 120_000)

  it("Mark done on a parent whose sub-tasks are mid-turn stops them through Stop's path, and the whole tree stays done", async () => {
    const r = await start()
    const project = await call<Project>(r, "POST", "/api/projects", { name: "kitchen" })
    const parent = await call<Task>(r, "POST", "/api/tasks", {
      projectId: project.id,
      title: "Long research",
      prompt: "spawn subtasks: Middle > Deep {hang} | Side {hang}",
    })
    const tree = await waitFor(() => {
      const [middle, side] = kids(r, parent.id)
      const deep = middle && kids(r, middle.id)[0]
      const row = (t: Task | undefined) => (t ? r.yard.store.getTaskRow(t.id) : null)
      return row(deep)?.status === "working" && row(side)?.status === "working" && row(middle)?.status === "waiting" && r.yard.store.getTaskRow(parent.id)?.status === "waiting"
        ? { middle: middle!, side: side!, deep: deep! }
        : null
    }, "the tree to be under way", 60_000)
    const all = [parent, tree.middle, tree.side, tree.deep]

    // No Stop first: Mark done itself stops the turns under it, at any depth.
    const closed = await call<Task>(r, "POST", `/api/tasks/${parent.id}/close`)
    expect(closed.status).toBe("done")
    expect(all.map((t) => r.yard.store.getTaskRow(t.id)!.status)).toEqual(["done", "done", "done", "done"])
    // The killed turns end, and their end keeps them done (finishTurn).
    await waitFor(() => all.every((t) => !r.yard.store.getTaskRow(t.id)!.current_turn_id) || null, "the stopped turns to end", 60_000)
    await new Promise((res) => setTimeout(res, 1000))
    expect(all.map((t) => r.yard.store.getTaskRow(t.id)!.status)).toEqual(["done", "done", "done", "done"])
    for (const k of [tree.side, tree.deep]) {
      const events = transcript(r, k.id).map((m) => m.content)
      expect(events).toContain(`Stopped with its parent task, ${k.id === tree.deep.id ? "Middle" : "Long research"}.`)
      expect(events).toContain(`Closed with its parent task, ${k.id === tree.deep.id ? "Middle" : "Long research"}.`)
    }
    // Stopped turns don't report, so nothing wakes the done parent.
    expect(reports(r, parent.id)).toHaveLength(0)
    expect(r.yard.store.getTaskRow(parent.id)!.turn_count).toBe(1)
  }, 120_000)
})
