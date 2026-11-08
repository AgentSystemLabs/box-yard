import { afterEach, describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { openDb, migrate, MIGRATIONS } from "../server/db.js"
import { Store } from "../server/store.js"
import { TaskEnvironment } from "../server/taskEnvironment.js"
import type { BoxProvider } from "../server/providers/types.js"
import { tmpDir } from "./helpers.js"

const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.db.close() })
function fixture() {
  const store = new Store(openDb(tmpDir(), ":memory:"))
  stores.push(store)
  const project = store.createProject({ name: "example" })
  let active = "upstash"
  const routes = new Map<string, string>()
  // Inert dispatch registry: no APIs, processes, credentials or network.
  const provider = { get name() { return active }, of: (id: string) => ({ name: routes.get(id) ?? active }) } as BoxProvider
  const policy = new TaskEnvironment(store, provider)
  const root = store.createTask({ projectId: project.id, title: "Parent", prompt: "Example" })
  const row = (id = root.id) => store.getTaskRow(id)!
  const place = (id: string, type: string) => { routes.set(id, type); store.upsertBox({ id, provider: type, status: "ready", created_at: 1, last_used_at: 1 }); return id }
  const child = (parent = row()) => store.createTask({ projectId: project.id, title: "Child", prompt: "Example", subtask: { parentId: parent.id, rootId: parent.root_task_id ?? parent.id, depth: (parent.subtask_depth ?? 0) + 1, withParent: true } })
  return { store, project, policy, root, row, place, child, routes, active: (type: string) => { active = type } }
}

describe("immutable physical task environments", () => {
  it.each(["docker", "upstash"])("keeps %s children and grandchildren in type across instances and restarts", (type) => {
    const f = fixture()
    const first = f.place("first", type)
    f.store.updateTask(f.root.id, { boxId: first })
    f.policy.launching(f.row(), first)
    expect(f.policy.forChild(f.row())).toBe(type)
    const child = f.child()
    expect(f.policy.inherited(f.row(child.id))).toBe(type)
    const second = f.place("second", type)
    f.policy.placement(f.row(child.id), second)
    f.store.updateTask(child.id, { boxId: second })
    const grandchild = f.child(f.row(child.id))
    // Parent's requested runner/default and current box no longer establish the original family.
    f.store.updateTask(f.root.id, { boxId: f.place("elsewhere", "local"), runsOn: "local" })
    f.store.updateProject(f.project.id, { runner: "ssh" })
    const restoredPolicy = new TaskEnvironment(f.store, { name: type, of: (id: string) => ({ name: f.routes.get(id) }) } as BoxProvider)
    expect(restoredPolicy.inherited(f.row(grandchild.id))).toBe(type)
    restoredPolicy.placement(f.row(grandchild.id), second)
    for (const other of ["local", "ssh", "docker", "upstash", "runpod", "vast", "daytona"].filter(t => t !== type)) {
      expect(() => restoredPolicy.placement(f.row(grandchild.id), f.place(`other-${other}`, other))).toThrow(/physical target conflicts/)
    }
    expect(() => restoredPolicy.forChild(f.row())).toThrow(/original .* environment/)
    expect(() => f.store.db.prepare("UPDATE tasks SET environment_type = 'local' WHERE id = ?").run(child.id)).toThrow(/immutable/)
  })

  it("splits GPU clouds and keeps SSH as one type, independent of machine identity", () => {
    const f = fixture()
    f.policy.runner("ssh", "ssh", "runpod")
    for (const type of ["runpod", "vast", "daytona"] as const) {
      f.policy.runner(type, "gpu", type)
      expect(() => f.policy.runner(type, "gpu", type === "runpod" ? "vast" : "runpod")).toThrow(/forbidden/)
    }
    f.active("local")
    f.policy.runner("upstash", "box", "runpod") // Actual placement still cannot use AutoProvider's local fallback.
  })

  it("rejects unavailable, unknown, cyclic, forged and cross-project lineage", () => {
    const f = fixture()
    expect(() => f.policy.forChild(f.row())).toThrow(/no authoritative physical placement/)
    f.store.updateTask(f.root.id, { boxId: f.place("first", "docker") })
    const child = f.child()
    f.policy.inherited(f.row(child.id))
    f.store.db.prepare("UPDATE tasks SET root_task_id = 'task_missing' WHERE id = ?").run(child.id)
    expect(() => f.policy.inherited(f.row(child.id))).toThrow(/inconsistent root/)
    f.store.db.prepare("UPDATE tasks SET parent_task_id = ? WHERE id = ?").run(child.id, f.root.id)
    expect(() => f.policy.inherited(f.row(child.id))).toThrow(/cyclic/)
    f.store.db.prepare("UPDATE tasks SET parent_task_id = 'task_missing' WHERE id = ?").run(child.id)
    expect(() => f.policy.inherited(f.row(child.id))).toThrow(/missing or cross-project/)
    const other = f.store.createProject({ name: "another-example" })
    const outsider = f.store.createTask({ projectId: other.id, title: "Other", prompt: "Example" })
    f.store.db.prepare("UPDATE tasks SET parent_task_id = ? WHERE id = ?").run(outsider.id, child.id)
    expect(() => f.policy.inherited(f.row(child.id))).toThrow(/cross-project/)
    f.routes.set("unknown", "unknown")
    expect(() => f.policy.physical("unknown")).toThrow(/authoritative physical provider/)
    f.routes.set("first", "local")
    expect(() => f.policy.physical("first")).toThrow(/authoritative physical provider/)
  })

  it("does not treat a descendant with lost parent links as a top-level exemption", () => {
    const f = fixture()
    f.store.db.prepare("UPDATE tasks SET with_parent = 1 WHERE id = ?").run(f.root.id)
    expect(() => f.policy.inherited(f.row())).toThrow(/incomplete parent lineage/)
    f.store.db.prepare("UPDATE tasks SET with_parent = 0, source = 'agent:task_example' WHERE id = ?").run(f.root.id)
    expect(() => f.policy.inherited(f.row())).toThrow(/incomplete parent lineage/)
    const unavailable = new TaskEnvironment(f.store, { name: "upstash", of: () => { throw new Error("provider unavailable") } } as unknown as BoxProvider)
    expect(() => unavailable.physical("example-target")).toThrow(/cannot resolve an authoritative physical provider/)
  })

  it("migrates existing rows without inventing origins, then pins a verifiable legacy lineage", () => {
    const db = new Database(":memory:")
    migrate(db, MIGRATIONS.findIndex(m => m.includes("ALTER TABLE tasks ADD COLUMN environment_type")))
    const store = new Store(db)
    stores.push(store)
    const project = store.createProject({ name: "example" })
    const root = store.createTask({ projectId: project.id, title: "Legacy", prompt: "Example" })
    store.upsertBox({ id: "legacy-upstash", provider: "upstash", status: "ready", created_at: 1, last_used_at: 1 })
    store.startTaskTurn({ id: "turn_legacy", taskId: root.id, turnIndex: 1, model: null, effort: null, routingRule: null, routingReason: null, boxId: "legacy-upstash" })
    store.updateTask(root.id, { sessionStarted: true, boxId: "legacy-upstash" })
    const child = store.createTask({ projectId: project.id, title: "Legacy child", prompt: "Example", subtask: { parentId: root.id, rootId: root.id, depth: 1, withParent: true } })
    migrate(db)
    expect(store.getTaskRow(root.id)?.environment_type).toBeNull()
    const policy = new TaskEnvironment(store, { name: "upstash" } as BoxProvider)
    expect(policy.inherited(store.getTaskRow(child.id)!)).toBe("upstash")
    expect(store.getTaskRow(root.id)?.environment_type).toBe("upstash")
    expect(store.getTaskRow(child.id)?.environment_type).toBe("upstash")
  })

  it("resolves legacy original turns, but never guesses from mutable runner metadata", () => {
    const f = fixture()
    const box = f.place("original", "upstash")
    f.store.startTaskTurn({ id: "turn_first", taskId: f.root.id, turnIndex: 1, model: null, effort: null, routingRule: null, routingReason: null, boxId: box })
    f.store.updateTask(f.root.id, { boxId: f.place("current", "local"), runsOn: "local", sessionStarted: true })
    expect(f.policy.inherited(f.row(f.child().id))).toBe("upstash")
    const unknown = f.store.createTask({ projectId: f.project.id, title: "Old", prompt: "Example", runsOn: "docker" })
    f.store.updateTask(unknown.id, { sessionStarted: true, boxId: box })
    expect(() => f.policy.forChild(f.row(unknown.id))).toThrow(/turn history is unavailable/)
    // Continuing a top-level legacy task is allowed, but does not fabricate an origin.
    f.policy.launching(f.row(unknown.id), box)
    expect(f.row(unknown.id).environment_type).toBeNull()
    f.store.startTaskTurn({ id: "turn_old", taskId: unknown.id, turnIndex: 1, model: null, effort: null, routingRule: null, routingReason: null })
    expect(() => f.policy.forChild(f.row(unknown.id))).toThrow(/original turn has no authoritative placement/)
  })
})
