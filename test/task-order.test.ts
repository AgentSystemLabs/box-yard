import { describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import path from "node:path"
import { MIGRATIONS, migrate, openDb } from "../server/db.js"
import { BadRequestError, NotFoundError, Store } from "../server/store.js"
import { tmpDir } from "./helpers.js"

// The owner's order for the sidebar's task lists (Store.orderTasks): a project's tasks, or one task's sub-tasks. It
// only ever writes a task's place among its siblings, so a move can't change a task's project or parent.

function setup() {
  const store = new Store(openDb(tmpDir(), ":memory:"))
  const project = store.createProject({ name: "alpha" })
  const other = store.createProject({ name: "beta" })
  const task = (title: string, projectId = project.id) => store.createTask({ projectId, title, prompt: "x" })
  const sub = (title: string, parent: { id: string }, projectId = project.id) =>
    store.createTask({ projectId, title, prompt: "x", subtask: { parentId: parent.id, rootId: parent.id, depth: 1, withParent: true } })
  const places = (...ids: string[]) => ids.map((id) => store.getTask(id)!.sortOrder)
  return { store, project, other, task, sub, places }
}

describe("task order", () => {
  it("a new task has no place: the automatic order", () => {
    const { store, task } = setup()
    const a = task("a")
    expect(a.sortOrder).toBeNull()
    expect(store.listTasks().map((t) => t.sortOrder)).toEqual([null])
  })

  it("places a project's tasks in the order given and returns the ones that moved", () => {
    const { store, project, task, places } = setup()
    const [a, b, c] = [task("a"), task("b"), task("c")]
    const changed = store.orderTasks(project.id, { ids: [c.id, a.id, b.id] })
    expect(changed.map((t) => [t.id, t.sortOrder])).toEqual([[c.id, 0], [a.id, 1], [b.id, 2]])
    expect(places(a.id, b.id, c.id)).toEqual([1, 2, 0])

    // Swapping two reports just those two: the others' places didn't change.
    expect(store.orderTasks(project.id, { ids: [c.id, b.id, a.id] }).map((t) => t.id)).toEqual([b.id, a.id])
    expect(store.orderTasks(project.id, { ids: [c.id, b.id, a.id] })).toEqual([])
  })

  it("a sibling left out keeps the place it has", () => {
    const { store, project, task, places } = setup()
    const [a, b, c] = [task("a"), task("b"), task("c")]
    store.orderTasks(project.id, { ids: [a.id, b.id, c.id] })
    store.orderTasks(project.id, { ids: [b.id, a.id] })
    expect(places(a.id, b.id, c.id)).toEqual([1, 0, 2])
  })

  it("orders one task's sub-tasks, and only those", () => {
    const { store, project, task, sub, places } = setup()
    const parent = task("parent")
    const [x, y] = [sub("x", parent), sub("y", parent)]
    const stranger = sub("stranger", task("another parent"))
    expect(store.orderTasks(project.id, { parentTaskId: parent.id, ids: [y.id, x.id] }).map((t) => t.id)).toEqual([y.id, x.id])
    expect(places(x.id, y.id)).toEqual([1, 0])

    expect(() => store.orderTasks(project.id, { parentTaskId: parent.id, ids: [x.id, stranger.id] })).toThrow(/not a sub-task/)
    expect(() => store.orderTasks(project.id, { parentTaskId: parent.id, ids: [parent.id] })).toThrow(BadRequestError)
    // The refused call changed nothing, not even the task listed before the stranger.
    expect(places(x.id, y.id, stranger.id)).toEqual([1, 0, null])
  })

  it("never moves a task: project, parent and last update stay as they were", () => {
    const { store, project, task, sub } = setup()
    const parent = task("parent")
    const [x, y] = [sub("x", parent), sub("y", parent)]
    const before = store.getTask(x.id)!
    store.orderTasks(project.id, { parentTaskId: parent.id, ids: [y.id, x.id] })
    const after = store.getTask(x.id)!
    expect(after).toEqual({ ...before, sortOrder: 1 })
    expect([after.projectId, after.parentTaskId, after.updatedAt]).toEqual([project.id, parent.id, before.updatedAt])
  })

  it("refuses another project's task, an unknown one and a repeat, and changes nothing", () => {
    const { store, project, other, task, places } = setup()
    const [a, b] = [task("a"), task("b")]
    const theirs = task("theirs", other.id)
    expect(() => store.orderTasks(project.id, { ids: [a.id, theirs.id] })).toThrow(/another project/)
    expect(() => store.orderTasks(project.id, { ids: [a.id, "task_nothere"] })).toThrow(/Unknown task: task_nothere/)
    expect(() => store.orderTasks(project.id, { ids: [b.id, a.id, b.id] })).toThrow(/listed twice/)
    expect(() => store.orderTasks("prj_nothere", { ids: [a.id] })).toThrow(NotFoundError)
    // A parent in another project is as good as missing.
    expect(() => store.orderTasks(other.id, { parentTaskId: a.id, ids: [] })).toThrow(NotFoundError)
    expect(places(a.id, b.id, theirs.id)).toEqual([null, null, null])
  })

  it("auto clears the places, back to the automatic order", () => {
    const { store, project, task, places } = setup()
    const [a, b, c] = [task("a"), task("b"), task("c")]
    store.orderTasks(project.id, { ids: [c.id, b.id, a.id] })
    expect(store.orderTasks(project.id, { ids: [a.id, b.id], auto: true }).map((t) => t.id)).toEqual([a.id, b.id])
    expect(places(a.id, b.id, c.id)).toEqual([null, null, 0])
    expect(store.orderTasks(project.id, { ids: [a.id, b.id], auto: true })).toEqual([])
  })

  it("the migration leaves older tasks in the automatic order", () => {
    const dataDir = tmpDir()
    const db = new Database(path.join(dataDir, "box-yard.sqlite"))
    migrate(db, MIGRATIONS.findIndex((m) => m.includes("tasks ADD COLUMN sort_order")))
    db.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES ('prj_old', 'old', 1, 1)").run()
    db.prepare("INSERT INTO tasks (id, project_id, title, prompt, status, session_id, created_at, updated_at, last_active_at) VALUES ('task_old', 'prj_old', 'old', 'x', 'idle', 's', 1, 1, 1)").run()
    db.close()

    const store = new Store(openDb(dataDir))
    expect(store.getTask("task_old")!.sortOrder).toBeNull()
    expect(store.orderTasks("prj_old", { ids: ["task_old"] }).map((t) => t.sortOrder)).toEqual([0])
  })
})
