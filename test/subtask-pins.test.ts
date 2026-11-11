import { afterEach, describe, expect, it, vi } from "vitest"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { WorkerEvent } from "../server/bus.js"
import type { BoxProvider } from "../server/providers/types.js"
import { testConfig } from "./helpers.js"

// spawn_subtasks' per-sub-task agent, model and effort (server/subtasks.ts subtaskPins), through TaskManager with an
// inert provider: what each sub-task row keeps, the runner checks a new harness gets, and the reply to the runner.

const yards: BoxYard[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const yard of yards.splice(0)) yard.stop()
})

function fixture() {
  const io = { wake: vi.fn(async () => {}), exec: vi.fn(async () => { throw new Error("Unexpected execution in inert fixture") }), writeFile: vi.fn(async () => {}), uploadFile: vi.fn(async () => {}) }
  const provider = { name: "upstash", nodeBin: "node", claudeBin: "example-agent", root: () => "/example", ...io, of: () => ({ name: "upstash", root: () => "/example", ...io }) } as unknown as BoxProvider
  const yard = createBoxYard(testConfig(), { provider, localRunner: { ...provider, name: "local" }, webDir: "/nonexistent" })
  yards.push(yard)
  vi.spyOn(yard.tasks, "schedule").mockImplementation(() => {})
  const replies = vi.spyOn(yard.tasks as unknown as { writeTaskFile: (...args: unknown[]) => Promise<void> }, "writeTaskFile").mockResolvedValue(undefined)
  const project = yard.store.createProject({ name: "example", runner: "box" })
  const parent = yard.store.createTask({ projectId: project.id, title: "Parent", prompt: "Example", model: "claude-opus-5-5", effort: "max" })
  yard.store.upsertBox({ id: "example-parent", provider: "upstash", status: "ready", created_at: 1, last_used_at: 1 })
  yard.store.updateTask(parent.id, { status: "working", currentTurnId: "turn_example", boxId: "example-parent" })
  const spawn = (tasks: Record<string, unknown>[]) => yard.tasks.apply(parent.id, { t: "spawn_subtasks", id: "sub_0123456789ab", tasks } as WorkerEvent)
  const reply = () => replies.mock.calls.filter((c) => c[1] === "subtasks-reply-sub_0123456789ab.json").at(-1)?.[2] as { status: string; text?: string; tasks?: { title: string; runsWith?: string }[] }
  return { yard, parent, spawn, reply }
}

describe("spawn_subtasks pins", () => {
  it("keeps each sub-task's own agent, model and effort, and its parent's for what it leaves out", async () => {
    const f = fixture()
    const check = vi.spyOn(f.yard.tasks, "requireRunner")
    await f.spawn([
      { title: "Codex review", prompt: "Review it.", agent: "codex", effort: "ultra" },
      { title: "Sonnet review", prompt: "Review it.", model: "claude-sonnet-5-5", effort: "high" },
      { title: "Same review", prompt: "Review it." },
    ])
    const rows = f.yard.store.subtaskRows(f.parent.id).map((r) => f.yard.store.getTask(r.id)!)
    expect(rows.map((t) => [t.title, t.agentCli, t.model, t.effort])).toEqual([
      ["Codex review", "codex", null, "ultra"],
      ["Sonnet review", "claude", "claude-sonnet-5-5", "high"],
      ["Same review", "claude", "claude-opus-5-5", "max"],
    ])
    // Only the new harness is checked against the parent's runner: the parent's own already runs there.
    expect(check.mock.calls.map((c) => [c[0], c[3]?.agentCli])).toEqual([["box", "codex"]])
    expect(f.reply()).toMatchObject({
      status: "ok",
      tasks: [
        { title: "Codex review", runsWith: "Codex · ultra effort" },
        { title: "Sonnet review", runsWith: "Claude Code · claude-sonnet-5-5 · high effort" },
        { title: "Same review" },
      ],
    })
    expect(f.reply().tasks![2]).not.toHaveProperty("runsWith")
  })

  it("refuses the whole call when the runner can't run a sub-task's harness", async () => {
    const f = fixture()
    vi.spyOn(f.yard.tasks, "requireRunner").mockImplementation(async (_runner, _project, _env, agent) => {
      if (agent?.agentCli === "cursor") throw new Error("Can't run it on an Upstash box: Cursor's CLI there has no login of its own")
    })
    await f.spawn([
      { title: "Fine", prompt: "Review it." },
      { title: "Cursor review", prompt: "Review it.", agent: "cursor", model: "composer-2.5" },
    ])
    expect(f.yard.store.subtaskRows(f.parent.id)).toHaveLength(0)
    expect(f.reply()).toEqual({ status: "rejected", text: "Can't run it on an Upstash box: Cursor's CLI there has no login of its own" })
  })

  it("refuses a pin its harness can't take before checking any runner", async () => {
    const f = fixture()
    const check = vi.spyOn(f.yard.tasks, "requireRunner")
    await f.spawn([{ title: "Cursor review", prompt: "Review it.", agent: "cursor", effort: "high" }])
    expect(f.yard.store.subtaskRows(f.parent.id)).toHaveLength(0)
    expect(f.reply()).toEqual({ status: "rejected", text: `Sub-task 1 ("Cursor review"): Cursor's effort is part of its model id; omit effort.` })
    expect(check).not.toHaveBeenCalled()
  })
})
