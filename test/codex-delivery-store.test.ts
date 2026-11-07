import { afterEach, describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { tmpDir } from "./helpers.js"

const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) if (store.db.open) store.db.close() })
const open = (dir: string) => { const store = new Store(openDb(dir)); stores.push(store); return store }
function fixture() {
  const dir = tmpDir(), store = open(dir)
  const p = store.createProject({ name: "example-project" })
  const task = store.createTask({ projectId: p.id, title: "Example", prompt: "Work" })
  const id = store.queueInput(task.id, "cody", "follow up", [], { message: { source: "cody" } })
  store.claimSteer(task.id, "steer:turn-1")
  return { dir, store, task, id }
}

describe("durable Codex delivery claims", () => {
  it("keeps accepted inputs locked across restart and deduplicates acknowledgment/terminal replay", () => {
    const f = fixture()
    expect(f.store.codexDelivery(f.task.id, "turn-1", [f.id], "submitted")).toEqual([])
    expect(f.store.codexDelivery(f.task.id, "turn-1", [f.id], "accepted")).toHaveLength(1)
    f.store.db.close()
    const store = open(f.dir)
    store.releaseInputs()
    expect(store.claimInputs(f.task.id, "turn-2")).toEqual([])
    expect(store.cancelInput(f.task.id, f.id).ok).toBe(false)
    expect(store.editInput(f.task.id, f.id, "edit").ok).toBe(false)
    store.codexDelivery(f.task.id, "turn-1", [f.id], "submitted")
    expect(store.listQueuedInputs(f.task.id)[0]?.codexDelivery).toBe("accepted")
    expect(store.codexDelivery(f.task.id, "turn-1", [f.id], "accepted")).toEqual([])
    expect(store.codexDelivery(f.task.id, "turn-1", [f.id], "settled")).toEqual([])
    expect(store.codexDelivery(f.task.id, "turn-1", [f.id], "settled")).toEqual([])
    expect(store.listTaskMessages(f.task.id)).toMatchObject([{ content: "follow up", meta: { steerAccepted: true } }])
    expect(store.hasInputs(f.task.id)).toBe(false)
  })

  it("recovers a lost acknowledgment from the terminal record exactly once", () => {
    const { store, task, id } = fixture()
    expect(store.codexDelivery(task.id, "turn-1", [id], "settled")).toHaveLength(1)
    expect(store.codexDelivery(task.id, "turn-1", [id], "accepted")).toEqual([])
    expect(store.listTaskMessages(task.id)).toHaveLength(1)
  })

  it("only requeues a definite rejection belonging to this task and turn", () => {
    const { store, task, id } = fixture()
    store.codexDelivery("task_other", "turn-1", [id], "rejected")
    store.codexDelivery(task.id, "turn-old", [id], "rejected")
    expect(store.listQueuedInputs(task.id)[0]?.status).toBe("delivering")
    store.codexDelivery(task.id, "turn-1", [id], "rejected")
    expect(store.claimInputs(task.id, "turn-2").map((i) => i.id)).toEqual([id])
    expect(store.deliverInputs("turn-2")).toHaveLength(1)
  })

  it("holds ambiguous delivery through claim release, allows removing the hold, and forbids Undo/replay", () => {
    const { store, task, id } = fixture()
    store.codexDelivery(task.id, "turn-1", [id], "uncertain")
    store.releaseInputs()
    store.releaseSteer("steer:turn-1")
    expect(store.claimInputs(task.id, "turn-2")).toEqual([])
    expect(store.hasUncertainCodexInput(task.id)).toBe(true)
    expect(store.cancelInput(task.id, id).ok).toBe(true)
    expect(store.restoreInput(task.id, id).ok).toBe(false)
    expect(store.hasInputs(task.id)).toBe(false)
    expect(store.listTaskMessages(task.id)).toMatchObject([{ content: "follow up", meta: { deliveryUncertain: true } }])
  })

  it("does not duplicate accepted transcript lines when a task closes", () => {
    const { store, task, id } = fixture()
    store.codexDelivery(task.id, "turn-1", [id], "accepted")
    store.codexDelivery(task.id, "turn-1", [id], "uncertain")
    expect(store.dropInputs(task.id)).toEqual([])
    expect(store.listTaskMessages(task.id)).toHaveLength(1)
  })
})
