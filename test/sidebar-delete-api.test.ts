import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createBoxYard, type BoxYard } from "../server/app"
import { freePort, testConfig } from "./helpers"

const yards: BoxYard[] = []
const closes: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of closes.splice(0)) await close()
  for (const y of yards.splice(0)) y.stop()
})
async function setup() {
  const c = testConfig()
  const y = createBoxYard(c, { webDir: "/nonexistent" })
  yards.push(y)
  y.tasks.stop() // All rows are isolated fixtures. No runner/turn is launched.
  const p = y.store.createProject({ name: "example-project" })
  const parent = y.store.createTask({ projectId: p.id, title: "Example parent", prompt: "Example" })
  const child = y.store.createTask({ projectId: p.id, title: "Example child", prompt: "Example", subtask: { parentId: parent.id, rootId: parent.id, depth: 1, withParent: false } })
  for (const t of [parent, child]) y.store.updateTask(t.id, { status: "idle" })
  const port = await freePort()
  const server = await new Promise<ReturnType<typeof y.app.listen>>((resolve) => {
    const listening = y.app.listen(port, "127.0.0.1", () => resolve(listening))
  })
  closes.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const del = (url: string) => fetch(`http://127.0.0.1:${port}/api/${url}`, { method: "DELETE" })
  return { c, y, p, parent, child, del }
}
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { resolve, promise }
}

describe("sidebar conditional DELETE API", () => {
  it("requires explicit consent to discard a failed task's retained inputs, then deletes its tree", async () => {
    const { y, parent, child, del } = await setup()
    for (const t of [parent, child]) y.store.updateTask(t.id, { status: "failed" })
    for (let i = 0; i < 5; i++) y.store.queueInput(parent.id, "cody", "Example unsent message")
    y.store.queueInput(child.id, "cody", "Example child message")
    const remove = vi.spyOn(y.tasks, "deleteTask")
    expect((await del(`tasks/${parent.id}?ifResting=1`)).status).toBe(409)
    expect((await del(`tasks/${parent.id}?ifResting=1&discardQueued=5`)).status).toBe(409)
    expect(remove).not.toHaveBeenCalled()
    expect(y.store.peekInputs(parent.id)).toHaveLength(5)
    expect((await del(`tasks/${parent.id}?ifResting=1&discardQueued=6`)).status).toBe(200)
    expect(y.store.listTasks()).toEqual([])
    expect(y.store.peekInputs(parent.id)).toEqual([])
    expect(y.store.peekInputs(child.id)).toEqual([])
  })

  it.each(["current turn", "working descendant", "compaction", "delivery", "new input"])("keeps %s safe despite consent to discard failed inputs", async (blocker) => {
    const { y, parent, child, del } = await setup()
    y.store.updateTask(parent.id, { status: "failed" })
    const input = y.store.queueInput(parent.id, "cody", "Example unsent message")
    if (blocker === "current turn") y.store.updateTask(parent.id, { currentTurnId: "turn_example" })
    if (blocker === "working descendant") y.store.updateTask(child.id, { status: "working" })
    if (blocker === "compaction") y.store.updateTask(parent.id, { compactPending: true })
    if (blocker === "delivery") y.store.db.prepare("UPDATE task_inputs SET status = 'delivering', claim = 'codex-uncertain:example' WHERE id = ?").run(input)
    if (blocker === "new input") y.store.queueInput(parent.id, "cody", "Example late message")
    const remove = vi.spyOn(y.tasks, "deleteTask")
    const response = await del(`tasks/${parent.id}?ifResting=1&discardQueued=1`)
    expect(response.status).toBe(409)
    const message = await response.text()
    expect(message).toMatch(/Stop|Review/)
    if (blocker === "delivery") expect(message).toContain("being delivered or held")
    expect(remove).not.toHaveBeenCalled()
    expect(y.store.listTasks()).toHaveLength(2)
    expect(y.store.listQueuedInputs(parent.id).length).toBeGreaterThan(0)
  })

  it.each(["queued", "starting", "working"] as const)("rejects a stale sidebar confirmation after a descendant becomes %s, preserving rows and archive", async (status) => {
    const { c, y, p, parent, child, del } = await setup()
    const archive = path.join(c.dataDir, "example-archive.tgz")
    fs.writeFileSync(archive, "Example isolated archive")
    y.store.updateTask(child.id, { status, archivePath: archive })
    const remove = vi.spyOn(y.tasks, "deleteTask")
    for (const scope of [`tasks/${parent.id}`, `projects/${p.id}`]) {
      const response = await del(`${scope}?ifResting=1`)
      expect(response.status).toBe(409)
      expect(await response.text()).toContain("Stop queued or running")
    }
    expect(remove).not.toHaveBeenCalled()
    expect(y.store.listTasks()).toHaveLength(2)
    expect(fs.readFileSync(archive, "utf8")).toBe("Example isolated archive")
  })

  it("holds the subtree against inputs and scheduler admission while existing cleanup awaits", async () => {
    const { y, parent, child, del } = await setup()
    const entered = deferred(), cleanup = deferred()
    const original = y.tasks.deleteTask.bind(y.tasks)
    vi.spyOn(y.tasks, "deleteTask").mockImplementation(async (id) => {
      if (id === parent.id) { entered.resolve(); await cleanup.promise }
      return original(id)
    })
    const request = del(`tasks/${parent.id}?ifResting=1`)
    await entered.promise
    try {
      expect(() => y.tasks.sendInput(child.id, "Example late input")).toThrow(/being deleted/)
      expect(y.store.claimTurnSlot(child.id, "example-box", Infinity, { status: "starting", currentTurnId: "turn_example" })).toBe(false)
      expect((await del(`tasks/${child.id}?ifResting=1`)).status).toBe(409)
      expect(y.store.listTasks()).toHaveLength(2)
    } finally { cleanup.resolve() }
    expect((await request).status).toBe(200)
    expect(y.store.listTasks()).toEqual([])
    expect(y.store.taskDeletionPending(parent.id)).toBe(false)
  })

  it("reserves the project against Captain turns and new tasks, and releases on error", async () => {
    const { y, p, parent, del } = await setup()
    const captain = y.captains.get(p.id)
    const entered = deferred(), cleanup = deferred()
    vi.spyOn(y.tasks, "deleteTask").mockImplementation(async () => {
      entered.resolve()
      await cleanup.promise
      throw new Error("Example cleanup refusal")
    })
    const request = del(`projects/${p.id}?ifResting=1`)
    await entered.promise
    try {
      expect(() => y.captains.get(p.id)).toThrow(/being deleted/)
      expect(() => captain.send("Example late Captain message")).toThrow(/being deleted/)
      expect(() => captain.requestCompact()).toThrow(/being deleted/)
      expect(() => y.store.createTask({ projectId: p.id, title: "Late task", prompt: "Example" })).toThrow(/being deleted/)
      expect(() => y.tasks.sendInput(parent.id, "Late task message")).toThrow(/being deleted/)
      await (captain as unknown as { drain(): Promise<void> }).drain()
      expect(captain.active).toBe(false)
    } finally { cleanup.resolve() }
    expect((await request).status).toBe(500)
    expect(y.store.projectDeletionPending(p.id)).toBe(false)
    expect(y.captains.get(p.id)).toBe(captain)
    expect(() => y.store.queueInput(parent.id, "cody", "Retry after failed deletion")).not.toThrow()
  })

  it("refuses running or queued Captain work before any task is deleted", async () => {
    const { y, p, del } = await setup()
    const captain = y.captains.get(p.id)
    vi.spyOn(captain, "active", "get").mockReturnValue(true)
    const remove = vi.spyOn(y.tasks, "deleteTask")
    const response = await del(`projects/${p.id}?ifResting=1`)
    expect(response.status).toBe(409)
    expect(await response.text()).toContain("Captain")
    expect(remove).not.toHaveBeenCalled()
    expect(y.store.listTasks()).toHaveLength(2)
  })

  it("deletes a resting project's nested tree once, even when the parent appears first", async () => {
    const { y, p, parent, del } = await setup()
    y.store.db.prepare("UPDATE tasks SET created_at = created_at + 1000 WHERE id = ?").run(parent.id)
    expect((await del(`projects/${p.id}?ifResting=1`)).status).toBe(200)
    expect(y.store.getProject(p.id)).toBeNull()
    expect(y.store.listTasks()).toEqual([])
  })

  it("retains the existing intentional-delete semantics without the conditional flag", async () => {
    const { y, child, del } = await setup()
    y.store.updateTask(child.id, { status: "working", currentTurnId: "turn_example" })
    expect((await del(`tasks/${child.id}?ifResting=1`)).status).toBe(409)
    expect((await del(`tasks/${child.id}`)).status).toBe(200)
    expect(y.store.getTask(child.id)).toBeNull()
  })

  it("rejects invalid safety flags rather than falling back to intentional deletion", async () => {
    const { y, p, parent, del } = await setup()
    expect((await del(`tasks/${parent.id}?ifResting=0`)).status).toBe(400)
    expect((await del(`projects/${p.id}?ifResting=false`)).status).toBe(400)
    for (const value of ["0", "-1", "1.5", "false", "9007199254740992"]) expect((await del(`tasks/${parent.id}?ifResting=1&discardQueued=${value}`)).status).toBe(400)
    expect((await del(`tasks/${parent.id}?discardQueued=1`)).status).toBe(400)
    expect(y.store.listTasks()).toHaveLength(2)
  })
})
