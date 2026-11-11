import { afterEach, describe, expect, it, vi } from "vitest"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { closeFromOwnerChat } from "../server/ownerClose.js"
import type { TaskRow } from "../server/store.js"
import type { Task, TaskStatus } from "../shared/types.js"
import { testConfig } from "./helpers.js"

// Mark done (TaskManager.closeTask) on a task closes its whole tree: every sub-task at any depth, a running one
// stopped first through the same stop path as Stop (its turn's end keeps it done), each with the close its parent got.
// One done already is left as it was, though the open ones under it still close. Closing again changes nothing.
// Nothing here starts a worker turn or a server: the yard isn't started, the tasks are seeded, and a turn's kill is a
// stub. POST /api/tasks/:id/close on a tree mid-turn is in test/subtasks.e2e.test.ts.

const yards: BoxYard[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const y of yards.splice(0)) y.stop()
})

function yard() {
  const y = createBoxYard(testConfig(), { webDir: "/nonexistent" })
  yards.push(y)
  const p = y.store.createProject({ name: "kitchen" })
  /** A task resting (or running) in `status`, under `parent` when given. */
  const task = (title: string, status: TaskStatus, parent?: Task, over: Parameters<BoxYard["store"]["updateTask"]>[1] = {}) => {
    const depth = parent ? (y.store.getTaskRow(parent.id)!.subtask_depth ?? 0) + 1 : 0
    const t = y.store.createTask({
      projectId: p.id,
      title,
      prompt: title,
      ...(parent ? { subtask: { parentId: parent.id, rootId: parent.rootTaskId ?? parent.id, depth, withParent: true } } : {}),
    })
    y.store.updateTask(t.id, { status, turnCount: 1, ...over })
    return y.store.getTask(t.id)!
  }
  return { y, p, task }
}

const row = (y: BoxYard, id: string) => y.store.getTaskRow(id)!
const events = (y: BoxYard, id: string) =>
  y.store
    .listTaskMessages(id, 200)
    .filter((m) => m.role === "event")
    .map((m) => m.content)
const doneFrom = (y: BoxYard, id: string) => y.store.doneFromOf(row(y, id))

/** A turn's kill on its box, stubbed: the turn's end (which the runner writes once killed) is up to the test. */
function stubKill(y: BoxYard) {
  return vi.spyOn(y.tasks as unknown as { killTurn: (r: TaskRow) => Promise<string> }, "killTurn").mockResolvedValue("signalled")
}

describe("Mark done closes the whole tree", () => {
  it("closes sub-tasks at any depth, each with its own parent, as their parent was closed", async () => {
    const { y, task } = yard()
    const root = task("Plan the menu", "idle")
    const a = task("Starters", "pr_ready", root, { prUrl: "https://github.com/acme/menu/pull/7", prState: "open" })
    const a1 = task("Soups", "idle", a)
    const a1x = task("Stock", "needs_input", a1, { question: "Chicken or veg?" })
    const b = task("Desserts", "failed", root, { error: "npm test exited 1" })

    const closed = await y.tasks.closeTask(root.id)
    expect(closed.status).toBe("done")
    for (const t of [root, a, a1, a1x, b]) expect(row(y, t.id).status, t.title).toBe("done")
    expect(row(y, a1x.id).question).toBeNull()
    // Reopen puts each back as it was, through its own parent.
    expect(doneFrom(y, root.id)).toMatchObject({ status: "idle", parent: null })
    expect(doneFrom(y, a.id)).toMatchObject({ status: "pr_ready", parent: root.id })
    expect(doneFrom(y, a1.id)).toMatchObject({ status: "idle", parent: a.id })
    expect(doneFrom(y, a1x.id)).toMatchObject({ status: "needs_input", question: "Chicken or veg?", parent: a1.id })
    expect(doneFrom(y, b.id)).toMatchObject({ status: "failed", parent: root.id })
    expect(events(y, a1x.id)).toContain("Closed with its parent task, Soups.")
    expect(events(y, b.id)).toContain("Closed with its parent task, Plan the menu.")

    y.tasks.reopenTask(root.id)
    expect([root, a, a1, a1x, b].map((t) => row(y, t.id).status)).toEqual(["idle", "pr_ready", "idle", "needs_input", "failed"])
  })

  it("stops a running, queued or starting sub-task first, through Stop's own path, and it stays done", async () => {
    const { y, task } = yard()
    const kill = stubKill(y)
    const root = task("Compare pans", "waiting")
    const working = task("Cast iron", "working", root, { currentTurnId: "turn_castiron1", boxId: "box_test01" })
    const queued = task("Nonstick", "queued", working)
    const starting = task("Carbon steel", "starting", root)
    y.store.queueInput(queued.id, "agent:task_other1", "A report for it")

    await y.tasks.closeTask(root.id)
    for (const t of [root, working, queued, starting]) expect(row(y, t.id).status, t.title).toBe("done")
    // The working one's turn is killed on its box (its end, when the runner writes it, keeps it done: finishTurn).
    expect(kill).toHaveBeenCalledOnce()
    expect(kill.mock.calls[0]![0].id).toBe(working.id)
    expect(events(y, working.id)).toContain("Stopped with its parent task, Compare pans.")
    expect(events(y, working.id)).toContain("Closed with its parent task, Compare pans.")
    // Nothing is left queued to start a turn nobody wants.
    expect(y.store.listQueuedInputs(queued.id)).toEqual([])
    y.store.updateTask(working.id, { currentTurnId: null })
  })

  it("leaves a sub-task done already as it was, but closes the open ones under it", async () => {
    const { y, task } = yard()
    const root = task("Plan the menu", "idle")
    const mains = task("Mains", "idle", root)
    const roast = task("Roast", "idle", mains)
    const sides = task("Sides", "idle", root)
    await y.tasks.closeTask(sides.id)
    await y.tasks.closeTask(mains.id)
    // Cody reopened Roast on its own and messaged it: it runs while Mains stays done.
    y.tasks.reopenTask(roast.id)
    const kill = stubKill(y)
    y.store.updateTask(roast.id, { status: "working", currentTurnId: "turn_roast01", boxId: "box_test01" })
    const before = [mains, sides].map((t) => ({ row: row(y, t.id), events: events(y, t.id) }))

    await y.tasks.closeTask(root.id)
    expect(row(y, root.id).status).toBe("done")
    // Mains and Sides: untouched (same row, same transcript), so Reopen on the root leaves them done.
    expect([mains, sides].map((t) => ({ row: row(y, t.id), events: events(y, t.id) }))).toEqual(before)
    // Roast, under Mains, is stopped and closed, with Mains as the parent Reopen brings it back through.
    expect(row(y, roast.id).status).toBe("done")
    expect(kill).toHaveBeenCalledOnce()
    expect(doneFrom(y, roast.id)).toMatchObject({ status: "working", parent: mains.id })
    expect(events(y, roast.id)).toContain("Closed with Plan the menu, a task above it (its parent task, Mains, was done already).")
    y.store.updateTask(roast.id, { currentTurnId: null })

    y.tasks.reopenTask(root.id)
    expect([root, mains, sides, roast].map((t) => row(y, t.id).status)).toEqual(["idle", "done", "done", "done"])
  })

  it("changes nothing when it's closed again", async () => {
    const { y, task } = yard()
    const root = task("Plan the menu", "pr_ready", undefined, { prUrl: "https://github.com/acme/menu/pull/8", prState: "open" })
    const kid = task("Starters", "idle", root)
    const grandkid = task("Soups", "failed", kid, { error: "boom" })
    await y.tasks.closeTask(root.id)
    const snapshot = () => [root, kid, grandkid].map((t) => ({ row: row(y, t.id), events: events(y, t.id) }))
    const once = snapshot()

    const again = await y.tasks.closeTask(root.id)
    expect(again.status).toBe("done")
    await y.tasks.closeTask(kid.id)
    expect(snapshot()).toEqual(once)
    // Reopen still knows what each was.
    y.tasks.reopenTask(root.id)
    expect([root, kid, grandkid].map((t) => row(y, t.id).status)).toEqual(["pr_ready", "idle", "failed"])
  })

  it("takes each sub-task as it is when its turn comes: one that finished or went away meanwhile is fine", async () => {
    const { y, task } = yard()
    const kill = stubKill(y)
    const root = task("Plan the menu", "idle")
    const first = task("Starters", "idle", root)
    const finishes = task("Mains", "working", root, { currentTurnId: "turn_mains01", boxId: "box_test01" })
    const goes = task("Sides", "idle", root)
    const real = y.tasks.closeTask.bind(y.tasks)
    vi.spyOn(y.tasks, "closeTask").mockImplementation(async (id, by) => {
      if (id === first.id) {
        // While Starters closes, Mains's turn ends on its own and Sides is deleted.
        y.store.updateTask(finishes.id, { status: "idle", currentTurnId: null })
        y.store.deleteTask(goes.id)
      }
      return real(id, by)
    })
    const warn = vi.spyOn(console, "warn")

    await y.tasks.closeTask(root.id)
    expect([root, first, finishes].map((t) => row(y, t.id).status)).toEqual(["done", "done", "done"])
    expect(doneFrom(y, finishes.id)).toMatchObject({ status: "idle", parent: root.id })
    // Its turn had ended, so there was nothing to stop.
    expect(kill).not.toHaveBeenCalled()
    expect(y.store.getTaskRow(goes.id)).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it("is what the owner's chat close does", async () => {
    const { y, p, task } = yard()
    const viaChat = task("Plan the drinks", "pr_ready")
    const chatKid = task("Wine", "idle", viaChat)
    const chatGrandkid = task("Reds", "idle", chatKid)
    await closeFromOwnerChat({ store: y.store, tasks: y.tasks, hub: y.hub, authenticatedOwner: true }, { kind: "captain", projectId: p.id }, `close ${viaChat.id}`)
    expect([viaChat, chatKid, chatGrandkid].map((t) => row(y, t.id).status)).toEqual(["done", "done", "done"])
  })
})
