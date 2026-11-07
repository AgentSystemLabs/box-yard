import { afterEach, describe, expect, it, vi } from "vitest"
import path from "node:path"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { LocalProvider } from "../server/providers/local.js"
import { LOCAL_BOX_ID } from "../shared/runner.js"
import { testConfig } from "./helpers.js"

const yards: BoxYard[] = []
afterEach(() => { for (const y of yards.splice(0)) { y.stop(); y.store.db.close() } })
function fixture() {
  const config = testConfig({ mock: true })
  const provider = new LocalProvider(path.join(config.dataDir, "boxes"))
  const yard = createBoxYard(config, { provider, webDir: "/nonexistent" })
  yards.push(yard)
  // No scheduler, external requests, subprocess agents or live runners are used.
  vi.spyOn(yard.tasks as never, "schedule").mockImplementation(() => {})
  vi.spyOn(yard.tasks as never, "publishDirectory").mockImplementation(() => {})
  const transport = (yard.tasks as unknown as { provider: LocalProvider }).provider
  vi.spyOn(transport, "writeFile").mockResolvedValue()
  const project = yard.store.createProject({ name: "example", runsOn: "docker" })
  const task = yard.tasks.createTask({ projectId: project.id, title: "Parent", prompt: "Example", runsOn: "docker" })
  yard.store.updateTask(task.id, { boxId: "docker-example" })
  return { yard, provider: transport, project, task }
}

describe("server-owned task containment", () => {
  it("rejects worker local/SSH delegation atomically through real event dispatch", async () => {
    const { yard, task, provider } = fixture()
    for (const runsOn of ["local", "ssh"]) {
      await yard.tasks.apply(task.id, { t: "spawn_subtasks", seq: 1, ts: 1, turnId: null, id: "sub_0123456789ab", tasks: [{ title: "Child", prompt: "Example", runsOn }] })
      expect(yard.store.subtaskRows(task.id)).toEqual([])
      expect(provider.writeFile).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.stringContaining("rejected"))
    }
  })

  it("pins same/default descendants and refuses model changes after project defaults change", async () => {
    const { yard, task, project } = fixture()
    await yard.tasks.apply(task.id, { t: "spawn_subtasks", seq: 1, ts: 1, turnId: null, id: "sub_0123456789ab", tasks: [{ title: "Child", prompt: "Example" }] })
    const child = yard.store.subtaskRows(task.id)[0]!
    expect(child.runs_on).toBe("docker")
    yard.store.updateProject(project.id, { runsOn: "local" })
    expect(yard.store.taskRunner(child)).toBe("docker")
    expect(() => yard.tasks.setRunsOn(child.id, "local")).toThrow(/containment/)
    expect(() => yard.tasks.setRunsOn(task.id, "ssh")).toThrow(/containment/)
    expect(() => yard.tasks.createTask({ projectId: project.id, title: "Grandchild", prompt: "Example", runsOn: "local", subtask: { parentId: child.id, rootId: task.id, depth: 2, withParent: false } })).toThrow(/containment/)
  })

  it("checks actual placement before waking a provider, even with forged stored runner metadata", async () => {
    const { yard, task, provider } = fixture()
    const wake = vi.spyOn(provider, "wake").mockResolvedValue()
    const internals = yard.tasks as unknown as { assign(id: string, box: string): string; launch(id: string, box: string, turn: string): Promise<void> }
    expect(() => internals.assign(task.id, LOCAL_BOX_ID)).toThrow(/containment/)
    await internals.launch(task.id, LOCAL_BOX_ID, "turn_example")
    expect(wake).not.toHaveBeenCalled()
  })

  it("keeps descendants restricted after a human elevation and narrows again on isolation", () => {
    const { yard, task } = fixture()
    const child = yard.tasks.createTask({ projectId: task.projectId, title: "Child", prompt: "Example", runsOn: "docker", subtask: { parentId: task.id, rootId: task.id, depth: 1, withParent: false } })
    yard.tasks.elevateRunner(task.id, "local")
    yard.tasks.setRunsOn(task.id, "local")
    expect(() => yard.tasks.setRunsOn(child.id, "local")).toThrow(/containment/)
    yard.tasks.setRunsOn(task.id, "docker")
    expect(() => yard.tasks.setRunsOn(task.id, "local")).toThrow(/containment/)
  })
})
