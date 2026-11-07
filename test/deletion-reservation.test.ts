import { afterEach, describe, expect, it } from "vitest"
import { openDb } from "../server/db"
import { Store } from "../server/store"
import { tmpDir } from "./helpers"

const stores: Store[] = []
afterEach(() => { for (const s of stores.splice(0)) s.db.close() })
function setup() {
  const s = new Store(openDb(tmpDir()))
  stores.push(s)
  const p = s.createProject({ name: "example-project" })
  const root = s.createTask({ projectId: p.id, title: "Example parent", prompt: "Example" })
  const child = s.createTask({ projectId: p.id, title: "Example child", prompt: "Example", subtask: { parentId: root.id, rootId: root.id, depth: 1, withParent: false } })
  const other = s.createTask({ projectId: p.id, title: "Unrelated task", prompt: "Example" })
  for (const t of [root, child, other]) s.updateTask(t.id, { status: "idle" })
  return { s, p, root, child, other }
}

describe("conditional deletion admission", () => {
  it.each(["queued", "starting", "working"] as const)("refuses a %s descendant before reserving or changing any row", (status) => {
    const { s, p, root, child } = setup()
    s.updateTask(child.id, { status })
    const before = s.listTaskRows()
    expect(() => s.reserveRestingDeletion({ taskId: root.id })).toThrow(/Stop queued or running/)
    expect(() => s.reserveRestingDeletion({ projectId: p.id })).toThrow(/Stop queued or running/)
    expect(s.listTaskRows()).toEqual(before)
    expect(s.taskDeletionPending(root.id)).toBe(false)
    expect(s.projectDeletionPending(p.id)).toBe(false)
  })

  it.each(["turn", "input", "compacting", "compactPending"])("also refuses hidden/done descendants with %s work", (kind) => {
    const { s, root, child } = setup()
    s.updateTask(child.id, { status: "done", ...(kind === "turn" ? { currentTurnId: "turn_example" } : {}), ...(kind === "compacting" ? { compacting: true } : {}), ...(kind === "compactPending" ? { compactPending: true } : {}) })
    if (kind === "input") s.queueInput(child.id, "system", "Example queued work")
    expect(() => s.reserveRestingDeletion({ taskId: root.id })).toThrow(/Stop queued or running/)
    expect(s.getTask(root.id)).not.toBeNull()
    expect(s.getTask(child.id)).not.toBeNull()
  })

  it("blocks inputs, undo, compaction, child creation and actual turn claims for the reserved subtree", () => {
    const { s, p, root, child, other } = setup()
    const input = s.queueInput(child.id, "cody", "Example cancelled input")
    s.cancelInput(child.id, input)
    const release = s.reserveRestingDeletion({ taskId: root.id })
    for (const id of [root.id, child.id]) {
      expect(() => s.queueInput(id, "system", "Late automatic reply")).toThrow(/being deleted/)
      expect(() => s.updateTask(id, { compactPending: true })).toThrow(/being deleted/)
      expect(() => s.updateTask(id, { currentTurnId: "turn_late", status: "starting" })).toThrow(/being deleted/)
      expect(s.claimTurnSlot(id, "example-box", Infinity, { currentTurnId: "turn_late", status: "starting" })).toBe(false)
    }
    expect(() => s.restoreInput(child.id, input)).toThrow(/being deleted/)
    expect(() => s.createTask({ projectId: p.id, title: "Late child", prompt: "Example", subtask: { parentId: child.id, rootId: root.id, depth: 2, withParent: false } })).toThrow(/being deleted/)
    expect(() => s.reserveRestingDeletion({ taskId: child.id })).toThrow(/already in progress/)
    expect(() => s.reserveRestingDeletion({ projectId: p.id })).toThrow(/already in progress/)
    expect(() => s.queueInput(other.id, "cody", "Unrelated work")).not.toThrow()
    release()
    expect(s.restoreInput(child.id, input).ok).toBe(true)
    expect(() => s.queueInput(root.id, "cody", "Retry after a failed deletion")).not.toThrow()
  })

  it("reserves a whole project against new work without changing task completion state", () => {
    const { s, p, root } = setup()
    const other = s.createProject({ name: "other-example" })
    const before = s.listTaskRows()
    const release = s.reserveRestingDeletion({ projectId: p.id })
    expect(() => s.createTask({ projectId: p.id, title: "Late task", prompt: "Example" })).toThrow(/being deleted/)
    expect(() => s.createTask({ projectId: other.id, title: "Unrelated task", prompt: "Example" })).not.toThrow()
    expect(s.listTaskRows({ projectId: p.id })).toEqual(before)
    expect(s.getTask(root.id)?.status).toBe("idle")
    release()
    const again = s.reserveRestingDeletion({ projectId: p.id })
    release() // An old release must not clear a newer reservation.
    expect(s.projectDeletionPending(p.id)).toBe(true)
    again()
    expect(s.projectDeletionPending(p.id)).toBe(false)
  })
})
