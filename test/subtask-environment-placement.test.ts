import { afterEach, describe, expect, it, vi } from "vitest"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { TaskManager, NewTask } from "../server/tasks.js"
import type { TaskRow } from "../server/store.js"
import type { BoxProvider } from "../server/providers/types.js"
import type { WorkerEvent } from "../server/bus.js"
import { environmentRunner, type EnvironmentType } from "../server/taskEnvironment.js"
import type { BoxResize } from "../shared/boxSizes.js"
import type { Runner } from "../shared/runner.js"
import { testConfig } from "./helpers.js"

const yards: BoxYard[] = []
afterEach(() => { vi.restoreAllMocks(); for (const yard of yards.splice(0)) yard.stop() })
type Internals = {
  place(row: TaskRow): Promise<string | null>
  assign(taskId: string, boxId: string): string
  prepareWorkspace(row: TaskRow, boxId: string, dir: string): Promise<unknown>
  launch(id: string, boxId: string, turnId: string): Promise<void>
  schedulePass(): Promise<void>
  parentBox(row: TaskRow): string | null
  reattach(row: TaskRow): Promise<void>
  resizeByMigration(resize: BoxResize): Promise<void>
  writeTaskFile: (...args: unknown[]) => Promise<void>
}
function fixture(type: EnvironmentType) {
  let active = "upstash"
  const routes = new Map<string, string>()
  const io = { wake: vi.fn(async () => {}), exec: vi.fn(async () => { throw new Error("Unexpected execution in inert fixture") }), writeFile: vi.fn(async () => {}), uploadFile: vi.fn(async () => {}) }
  const provider = {
    get name() { return active },
    nodeBin: "node", claudeBin: "example-agent", root: () => "/example",
    ...io,
    of: (id: string) => ({ name: routes.get(id) ?? active, root: () => "/example", ...io }),
  } as unknown as BoxProvider
  const yard = createBoxYard(testConfig(), { provider, localRunner: { ...provider, name: "local" }, webDir: "/nonexistent" })
  yards.push(yard)
  vi.spyOn(yard.tasks, "schedule").mockImplementation(() => {})
  const tasks = yard.tasks as unknown as Internals & Omit<TaskManager, keyof Internals>
  const replies = vi.spyOn(tasks, "writeTaskFile").mockResolvedValue(undefined)
  const project = yard.store.createProject({ name: "example", runner: environmentRunner(type) })
  const root = yard.store.createTask({ projectId: project.id, title: "Parent", prompt: "Example" })
  const row = (id = root.id) => yard.store.getTaskRow(id)!
  const box = (id: string, family = type as string) => { routes.set(id, family); yard.store.upsertBox({ id, provider: family, status: "ready", created_at: 1, last_used_at: 1 }); return id }
  yard.store.updateTask(root.id, { status: "working", currentTurnId: "turn_example", boxId: box("example-parent") })
  const child = (runsOn?: Runner | null, parent = row()) => yard.tasks.createTask({ projectId: project.id, title: "Child", prompt: "Example", runsOn, subtask: { parentId: parent.id, rootId: parent.root_task_id ?? parent.id, depth: (parent.subtask_depth ?? 0) + 1, withParent: false } })
  return { yard, tasks, root, row, child, box, io, replies, project, active: (name: string) => { active = name } }
}

describe("subtask environment enforcement at server entry and dispatch", () => {
  it.each(["docker", "upstash"] as const)("rejects forged worker overrides from %s atomically, ignoring worker environment claims", async (type) => {
    const f = fixture(type)
    const allowed = type === "docker" ? "docker" : "box"
    for (const runner of ["local", "ssh", "gpu", type === "docker" ? "box" : "docker"]) {
      await f.tasks.apply(f.root.id, { t: "spawn_subtasks", id: "sub_0123456789ab", turnId: "turn_example", environment_type: "local", root_task_id: "forged", tasks: [{ title: "Allowed", prompt: "Example", runsOn: allowed }, { title: "Override", prompt: "Example", runsOn: runner }] } as WorkerEvent)
      expect(f.yard.store.subtaskRows(f.root.id)).toHaveLength(0)
      expect(f.replies).toHaveBeenLastCalledWith(f.root.id, "subtasks-reply-sub_0123456789ab.json", expect.objectContaining({ status: "rejected", text: expect.stringMatching(/environment restriction/) }))
    }
    expect(f.io.exec).not.toHaveBeenCalled()
    for (const runsOn of ["same", allowed, null]) {
      await f.tasks.apply(f.root.id, { t: "spawn_subtasks", id: "sub_0123456789ab", tasks: [{ title: "Allowed", prompt: "Example", runsOn }] } as WorkerEvent)
      expect(f.replies).toHaveBeenLastCalledWith(f.root.id, "subtasks-reply-sub_0123456789ab.json", expect.objectContaining({ status: "ok" }))
    }
    const children = f.yard.store.subtaskRows(f.root.id)
    expect(children).toHaveLength(3)
    expect(children.every(c => c.environment_type === type && c.runs_on === allowed)).toBe(true)
    expect(await f.tasks.place(children[0]!)).toBe("example-parent")
    // An independent instance of the same physical type is also permitted.
    expect(f.tasks.assign(children[1]!.id, f.box("example-other"))).toBe("example-other")
    const grandchild = f.child(undefined, f.row(children[1]!.id))
    expect(f.row(grandchild.id).environment_type).toBe(type)
    expect(() => f.child("local", f.row(children[1]!.id))).toThrow(/environment restriction/)
  })

  it.each(["docker", "upstash"] as const)("blocks manager changes and preserves %s inheritance through lost boxes, defaults, retry and restore", async (type) => {
    const f = fixture(type)
    const child = f.child(null)
    const allowed = type === "docker" ? "docker" : "box"
    for (const runner of ["local", "ssh", "gpu", type === "docker" ? "box" : "docker"] as Runner[]) expect(() => f.tasks.setRunsOn(child.id, runner)).toThrow(/environment restriction/)
    f.tasks.setRunsOn(child.id, allowed)
    f.yard.store.updateProject(f.project.id, { runner: "local" })
    f.yard.store.updateTask(f.root.id, { boxId: "this-computer", runsOn: "local" })
    f.yard.store.updateTask(child.id, { boxId: null, runsOn: null, status: "failed", archivePath: "/example/missing.tgz" })
    // Legacy/null choices pin to the lineage rather than the changed project. No real runner can start.
    const ownSlot = vi.spyOn(f.tasks as unknown as { ownSlot(): Promise<null> }, "ownSlot").mockResolvedValue(null)
    if (type === "upstash") vi.spyOn(f.tasks as unknown as { pickBox(): Promise<null> }, "pickBox").mockResolvedValue(null)
    f.tasks.retryTask(child.id)
    await f.tasks.place(f.row(child.id))
    expect(f.row(child.id).runs_on).toBe(allowed)
    const target = f.box("example-restored")
    expect(f.tasks.assign(child.id, target)).toBe(target)
    expect(f.row(child.id).environment_type).toBe(type)
    const outside = f.box("example-outside", "local")
    expect(() => f.tasks.assign(child.id, outside)).toThrow(/physical target conflicts/)
    await expect(f.tasks.prepareWorkspace(f.row(child.id), outside, "/example/task")).rejects.toThrow(/physical target conflicts/)
    expect(f.io.uploadFile).not.toHaveBeenCalled()
    expect(f.io.exec).not.toHaveBeenCalled()
    ownSlot.mockRestore()
  })

  it("rechecks physical placement after scheduler awaits, blocking stale and unsafe-move fallback targets", async () => {
    const f = fixture("upstash")
    const child = f.child("box")
    const outside = f.box("example-fallback", "local")
    const launch = vi.spyOn(f.tasks, "launch").mockResolvedValue(undefined)
    vi.spyOn(f.tasks, "place").mockResolvedValue(outside)
    await f.tasks.schedulePass()
    expect(launch).not.toHaveBeenCalled()
    expect(f.row(child.id).wait_reason).toMatch(/physical target conflicts/)
    expect(f.row(child.id).current_turn_id).toBeNull()
  })

  it("uses physical pool routing and refuses AutoProvider fallback after the original Upstash box disappears", async () => {
    const f = fixture("upstash")
    const child = f.child("box")
    f.yard.store.updateTask(f.root.id, { boxId: null })
    f.yard.store.removeBox("example-parent")
    f.active("local")
    f.box("example-local-pool", "local")
    expect(await f.tasks.place(f.row(child.id))).toBeNull()
    expect(f.row(child.id).wait_reason).toMatch(/No fallback is allowed/)
    expect(f.row(child.id).box_id).toBeNull()
    expect(f.io.exec).not.toHaveBeenCalled()
  })

  it("guards launch before wake, restore, credentials or execution even if internal placement is bypassed", async () => {
    const f = fixture("docker")
    const child = f.child("docker")
    // Launch's error handler is stubbed after the boundary error; no provider calls are allowed in the fixture.
    const finish = vi.spyOn(f.yard.store, "finishTaskTurn").mockImplementation(() => {})
    const health = vi.fn(async () => "running")
    const provider = (f.tasks as unknown as { provider: BoxProvider }).provider
    vi.spyOn(provider, "health").mockImplementation(health as never)
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    await f.tasks.launch(child.id, "this-computer", "turn_rejected")
    expect(f.row(child.id).status).toBe("failed")
    expect(f.row(child.id).error).toMatch(/physical target conflicts/)
    expect(f.io.wake).not.toHaveBeenCalled()
    expect(f.io.exec).not.toHaveBeenCalled()
    expect(f.io.writeFile).not.toHaveBeenCalled()
    finish.mockRestore()
    log.mockRestore()
  })

  it("refuses a resize migration before archiving or releasing descendants to a different physical provider", async () => {
    const f = fixture("upstash")
    const child = f.child("box")
    f.tasks.assign(child.id, "example-parent")
    f.box("example-resize", "local")
    const seams = f.tasks as unknown as {
      createFor(): Promise<{ id: string; from: null; cold: null }>
      afterCreateFor(): void
      refreshBoxUsage(): Promise<void>
      dropBox(): Promise<string>
      archiveFresh(): Promise<void>
    }
    vi.spyOn(seams, "createFor").mockResolvedValue({ id: "example-resize", from: null, cold: null })
    vi.spyOn(seams, "afterCreateFor").mockImplementation(() => {})
    vi.spyOn(seams, "refreshBoxUsage").mockResolvedValue(undefined)
    const cleanup = vi.spyOn(seams, "dropBox").mockResolvedValue("Removed inert target")
    const archive = vi.spyOn(seams, "archiveFresh").mockResolvedValue(undefined)
    const resize: BoxResize = {
      id: "rsz_example", boxId: "example-parent", newBoxId: null, from: "small", to: "medium", mode: "migration", status: "running",
      steps: ["create", "archive", "move", "delete"].map(key => ({ key, label: key, status: "pending", detail: null })) as BoxResize["steps"],
      movedTasks: [], by: { kind: "cody" }, reason: null, error: null, startedAt: 1, finishedAt: null,
    }
    await expect(f.tasks.resizeByMigration(resize)).rejects.toThrow(/physical target conflicts/)
    expect(archive).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalled()
    expect(f.row(child.id).box_id).toBe("example-parent")
  })

  it("requests a stop instead of reattaching an incompatible legacy running descendant", async () => {
    const f = fixture("docker")
    const child = f.child("docker")
    f.yard.store.updateTask(child.id, { boxId: "this-computer", currentTurnId: "turn_legacy", status: "working" })
    const seams = f.tasks as unknown as { killTurn(row: TaskRow): Promise<string>; holdOpen(): void }
    const kill = vi.spyOn(seams, "killTurn").mockResolvedValue("stopped")
    const hold = vi.spyOn(seams, "holdOpen").mockImplementation(() => {})
    await f.tasks.reattach(f.row(child.id))
    expect(kill).toHaveBeenCalledOnce()
    expect(hold).not.toHaveBeenCalled()
    expect(f.row(child.id).wait_reason).toMatch(/physical target conflicts/)
    // Do not pretend an unreachable process was stopped; polling still owns settlement.
    expect(f.row(child.id).current_turn_id).toBe("turn_legacy")
  })

  it.each(["local", "ssh", "runpod", "vast", "daytona"] as const)("pins %s descendants and rejects other physical types", (type) => {
    const f = fixture(type)
    const child = f.child(null)
    expect(f.row(child.id).runs_on).toBe(environmentRunner(type))
    if (["runpod", "vast", "daytona"].includes(type)) {
      expect(f.row(child.id).gpu_provider).toBe(type)
      const other = type === "runpod" ? "vast" : "runpod"
      expect(() => f.tasks.setRunsOn(child.id, "gpu", null, { provider: other, type: null })).toThrow(/environment restriction/)
      f.yard.store.updateProject(f.project.id, { gpuProvider: other })
      f.tasks.setRunsOn(child.id, "gpu")
      expect(f.row(child.id).gpu_provider).toBe(type)
    }
    expect(() => f.tasks.assign(child.id, f.box("example-wrong", "docker"))).toThrow(/physical target conflicts/)
    expect(f.tasks.assign(child.id, f.box("example-same"))).toBe("example-same")
  })

  it("keeps intentional top-level choices and rejects malformed manager-supplied lineage", () => {
    const f = fixture("docker")
    const root = f.tasks.createTask({ projectId: f.project.id, title: "Top level", prompt: "Example", runsOn: "local" })
    f.tasks.setRunsOn(root.id, "ssh")
    expect(f.row(root.id).runs_on).toBe("ssh")
    const input: NewTask = { projectId: f.project.id, title: "Forged", prompt: "Example", runsOn: "docker", subtask: { parentId: f.root.id, rootId: "task_forged", depth: 0, withParent: false } }
    expect(() => f.tasks.createTasks([input])).toThrow(/inconsistent parent lineage/)
    expect(f.yard.store.subtaskRows(f.root.id)).toHaveLength(0)
  })
})
