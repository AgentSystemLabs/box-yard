import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import fs from "node:fs"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { LocalProvider, LocalRunnerProvider } from "../server/providers/local.js"
import { LOCAL_BOX_ID } from "../shared/runner.js"
import type { Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// A tree of sub-tasks on this computer end to end (real runner turns, fake-claude): a task starts 4 sub-tasks that start
// 4 each (20 in all, 2 levels), every one runs_on "same", under Settings › Local agents 3. Never more than 3 turns hold
// a slot at once, and the whole tree finishes: with wait_for_subtasks (its waiting parents give their slots to their
// sub-tasks) and without (they end their turns and their sub-tasks' reports start the next).

const TREE = "spawn subtasks: A > A1, A2, A3, A4 | B > B1, B2, B3, B4 | C > C1, C2, C3, C4 | D > D1, D2, D3, D4"
const CAP = 3

interface Running {
  yard: BoxYard
  server: Server
}
const running: Running[] = []
const scratch: string[] = []

async function start(): Promise<Running> {
  const port = await freePort()
  const boxes = tmpDir("boxes-")
  scratch.push(boxes)
  const config = testConfig({ port, localAgents: CAP })
  scratch.push(config.dataDir, config.localDir)
  const yard = createBoxYard(config, { webDir: "/nonexistent", provider: new LocalProvider(boxes, FAKE_CLAUDE), localRunner: new LocalRunnerProvider(config.localDir, FAKE_CLAUDE) })
  // Captains would wake on task notices and start turns of their own.
  yard.captains.tuning.wakeDebounceMs = yard.captains.tuning.wakeQuietMs = 10 * 60_000
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    for (const t of r.yard.store.listTaskRows()) if (t.current_turn_id) await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/**
 * Watches the turns holding a slot on this computer: after every slot taken (a new turn, or a parked one's back) and
 * every few milliseconds besides. `peak` is the most at once, `parked` the most turns waiting on sub-tasks at once.
 */
function watch(r: Running) {
  const seen = { peak: 0, parked: 0, starts: 0 }
  const look = () => {
    seen.peak = Math.max(seen.peak, r.yard.store.slotsInUse(LOCAL_BOX_ID))
    seen.parked = Math.max(seen.parked, r.yard.store.parkedTurns(LOCAL_BOX_ID))
  }
  const store = r.yard.store
  const claimTurnSlot = store.claimTurnSlot.bind(store)
  store.claimTurnSlot = (...args) => {
    const ok = claimTurnSlot(...args)
    if (ok && args[1] === LOCAL_BOX_ID) seen.starts++
    look()
    return ok
  }
  const claimParkedSlot = store.claimParkedSlot.bind(store)
  store.claimParkedSlot = (...args) => {
    const ok = claimParkedSlot(...args)
    look()
    return ok
  }
  const timer = setInterval(look, 10)
  return { seen, stop: () => clearInterval(timer) }
}

const tree = (r: Running, rootId: string): Task[] => {
  const all = r.yard.store.listTasks()
  const under = (id: string): Task[] => all.filter((t) => t.parentTaskId === id).flatMap((t) => [t, ...under(t.id)])
  return under(rootId)
}

/** The task and every sub-task under it rest, with nothing left queued. */
const finished = (r: Running, rootId: string, subtasks: number, timeoutMs: number) =>
  waitFor(
    () => {
      const all = [r.yard.store.getTask(rootId)!, ...tree(r, rootId)]
      return all.length === subtasks + 1 && all.every((t) => t.status === "idle" && !t.currentTurnId && !t.pendingCount) ? all : null
    },
    `the task and its ${subtasks} sub-tasks to finish`,
    timeoutMs,
  ).catch((err: Error) => {
    const all = [r.yard.store.getTask(rootId)!, ...tree(r, rootId)]
    const where = all.map((t) => `${t.title}: ${t.status}${t.currentTurnId ? " (turn)" : ""}${t.waitReason ? ` — ${t.waitReason}` : ""}`)
    throw new Error(`${err.message}\n${where.join("\n")}`)
  })

describe("one turn cap on this computer, end to end", () => {
  it("runs a tree of 20 sub-tasks over 2 levels, waiting in wait_for_subtasks, never more than 3 at once", async () => {
    const r = await start()
    const project = r.yard.store.createProject({ name: "example-tree", runner: "local" })
    const w = watch(r)
    const parent = r.yard.tasks.createTask({ projectId: project.id, title: "Compare omelettes", prompt: `${TREE}\n[wait]` })
    const all = await finished(r, parent.id, 20, 170_000)
    w.stop()
    expect(w.seen.peak).toBeLessThanOrEqual(CAP)
    expect(w.seen.peak).toBe(CAP)
    // Parents waiting on their sub-tasks gave up their slots: 4 of them (and the top task) at once at some point.
    expect(w.seen.parked).toBeGreaterThanOrEqual(2)
    expect(r.yard.store.parkedTurns(LOCAL_BOX_ID)).toBe(0)
    // Each answered in the turn it waited in.
    expect(all.filter((t) => t.turnCount !== 1)).toEqual([])
    expect(all.every((t) => t.boxId === LOCAL_BOX_ID)).toBe(true)
    expect(r.yard.store.getTask(parent.id)!.summary ?? "").toMatch(/Combined answer from 4 sub-tasks/)
    expect(w.seen.starts).toBe(21)
  }, 180_000)

  it("runs the same tree when parents end their turns and resume on their sub-tasks' reports", async () => {
    const r = await start()
    const project = r.yard.store.createProject({ name: "example-tree", runner: "local" })
    const w = watch(r)
    const parent = r.yard.tasks.createTask({ projectId: project.id, title: "Compare omelettes", prompt: TREE })
    const all = await finished(r, parent.id, 20, 170_000)
    w.stop()
    expect(w.seen.peak).toBe(CAP)
    expect(w.seen.parked).toBe(0)
    // The top task and its 4 sub-tasks each came back for a second turn on their reports.
    expect(all.filter((t) => t.turnCount === 2).map((t) => t.title).sort()).toEqual(["A", "B", "C", "Compare omelettes", "D"])
    expect(r.yard.store.getTask(parent.id)!.summary ?? "").toMatch(/Combined answer from 4 sub-tasks/)
    expect(w.seen.starts).toBe(26)
  }, 180_000)
})
