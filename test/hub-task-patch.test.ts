import { afterEach, describe, expect, it } from "vitest"
import type { Response } from "express"
import { Hub } from "../server/hub.js"
import { applyTaskPatch, type TaskPatchEvent } from "../shared/taskPatch.js"
import type { Task, UiEvent } from "../shared/types.js"

/** A stream as a browser tab sees it: every event the hub wrote, parsed. */
function tab(hub: Hub, patches: boolean) {
  const events: (UiEvent | TaskPatchEvent)[] = []
  let onClose = () => {}
  const res = {
    writeHead() {},
    write(chunk: string) {
      for (const frame of chunk.split("\n\n")) if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)))
      return true
    },
    on(name: string, cb: () => void) {
      if (name === "close") onClose = cb
    },
    end() {},
  } as unknown as Response
  hub.attach(res, { patches })
  return {
    events,
    /** The tab goes away (the socket closed). */
    close: () => onClose(),
    /** The events since the last take. */
    take: () => events.splice(0),
  }
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: "task_patch01",
    projectId: "prj_patch01",
    title: "Speed up the stream",
    prompt: "A long brief. ".repeat(200),
    status: "working",
    boxId: "box-1",
    summary: null,
    previews: [],
    contextTokens: 1000,
    contextWindow: 200_000,
    placement: { boxId: "box-1", lastBoxId: null, next: { runner: "box", reason: "project" } },
    turnCount: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as unknown as Task
}

let hub: Hub
afterEach(() => hub?.close())

describe("task updates on /api/stream", () => {
  it("sends a patch client the task whole once, then only the fields that changed", () => {
    hub = new Hub()
    const t = tab(hub, true)
    hub.broadcast({ type: "task", task: task() })
    expect(t.take()).toEqual([{ type: "task", task: task() }])

    hub.broadcast({ type: "task", task: task({ contextTokens: 2000, updatedAt: 2 }) })
    expect(t.take()).toEqual([{ type: "task.patch", id: "task_patch01", patch: { contextTokens: 2000, updatedAt: 2 } }])

    hub.broadcast({ type: "task", task: task({ contextTokens: 2000, updatedAt: 2, placement: { boxId: "box-2" } as Task["placement"] }) })
    expect(t.take()).toEqual([{ type: "task.patch", id: "task_patch01", patch: { placement: { boxId: "box-2" } } }])
  })

  it("sends nothing when the task didn't change, and keeps whole tasks for streams without patches", () => {
    hub = new Hub()
    const patched = tab(hub, true)
    const legacy = tab(hub, false)
    hub.broadcast({ type: "task", task: task() })
    hub.broadcast({ type: "task", task: task() })
    hub.broadcast({ type: "task", task: task({ status: "idle" }) })
    expect(patched.take().map((e) => e.type)).toEqual(["task", "task.patch"])
    expect(legacy.take()).toEqual([
      { type: "task", task: task() },
      { type: "task", task: task() },
      { type: "task", task: task({ status: "idle" }) },
    ])
  })

  it("names the fields a task no longer has, so a rebuilt copy drops them", () => {
    hub = new Hub()
    const t = tab(hub, true)
    hub.broadcast({ type: "task", task: task({ activity: "Bash npm test" }) })
    hub.broadcast({ type: "task", task: task({ activity: undefined, summary: "Done." }) })
    const [first, patch] = t.take() as [UiEvent & { type: "task" }, TaskPatchEvent]
    expect(patch).toEqual({ type: "task.patch", id: "task_patch01", patch: { summary: "Done." }, unset: ["activity"] })
    const rebuilt = applyTaskPatch(first.task, patch)
    expect("activity" in rebuilt).toBe(false)
    expect(rebuilt).toEqual(JSON.parse(JSON.stringify(task({ activity: undefined, summary: "Done." }))))
  })

  it("sends a task whole to a stream that connects later, and again after the task is deleted", () => {
    hub = new Hub()
    const early = tab(hub, true)
    hub.broadcast({ type: "task", task: task() })
    const late = tab(hub, true)
    hub.broadcast({ type: "task", task: task({ updatedAt: 2 }) })
    expect(early.take().map((e) => e.type)).toEqual(["task", "task.patch"])
    expect(late.take()).toEqual([{ type: "task", task: task({ updatedAt: 2 }) }])

    hub.broadcast({ type: "task.deleted", taskId: "task_patch01" })
    hub.broadcast({ type: "task", task: task({ updatedAt: 3 }) })
    expect(early.take()).toEqual([
      { type: "task.deleted", taskId: "task_patch01" },
      { type: "task", task: task({ updatedAt: 3 }) },
    ])
  })

  it("goes back to whole tasks once it stops tracking one (more than a thousand updated since)", () => {
    hub = new Hub()
    const t = tab(hub, true)
    hub.broadcast({ type: "task", task: task() })
    for (let i = 0; i < 1000; i++) hub.broadcast({ type: "task", task: task({ id: `task_other${i}` }) })
    t.take()
    hub.broadcast({ type: "task", task: task({ updatedAt: 2 }) })
    expect(t.take()).toEqual([{ type: "task", task: task({ updatedAt: 2 }) }])
  })

  it("rebuilds exactly what a whole-task stream carries, after every one of a long run of random updates", () => {
    hub = new Hub()
    const patched = tab(hub, true)
    const legacy = tab(hub, false)
    let seed = 7
    const rand = (n: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) % n
    const ids = ["task_rand001", "task_rand002", "task_rand003"]
    const state = new Map(ids.map((id) => [id, task({ id })]))
    const rebuilt = new Map<string, Task>()
    let patchedBytes = 0
    let legacyBytes = 0
    for (let i = 0; i < 400; i++) {
      const id = ids[rand(ids.length)]!
      const t = { ...state.get(id)! }
      const roll = rand(6)
      if (roll === 0) t.contextTokens = rand(200_000)
      else if (roll === 1) t.status = (["working", "idle", "done", "needs_input"] as const)[rand(4)]!
      else if (roll === 2) t.previews = rand(2) ? [] : [{ port: 4000 + rand(10), url: "https://x", label: "web" } as Task["previews"][number]]
      else if (roll === 3) t.activity = rand(2) ? `Bash step ${i}` : undefined
      else if (roll === 4) t.summary = rand(3) ? null : `Summary ${i}`
      if (rand(2)) t.updatedAt = i
      state.set(id, t)
      hub.broadcast({ type: "task", task: t })
      if (rand(50) === 0) hub.broadcast({ type: "chat.busy", busy: true })
      for (const ev of patched.take()) {
        patchedBytes += JSON.stringify(ev).length
        if (ev.type === "task") rebuilt.set(ev.task.id, ev.task)
        else if (ev.type === "task.patch") rebuilt.set(ev.id, applyTaskPatch(rebuilt.get(ev.id)!, ev))
      }
      for (const ev of legacy.take()) {
        legacyBytes += JSON.stringify(ev).length
        if (ev.type === "task") expect(rebuilt.get(ev.task.id)).toStrictEqual(ev.task)
      }
    }
    // Every update that changed something got through, in far fewer bytes.
    expect(patchedBytes).toBeLessThan(legacyBytes / 5)
  })

  it("stops writing to a stream once its tab closes", () => {
    hub = new Hub()
    const t = tab(hub, true)
    t.close()
    hub.broadcast({ type: "task", task: task() })
    hub.broadcast({ type: "chat.busy", busy: true })
    expect(t.events).toEqual([])
  })
})
