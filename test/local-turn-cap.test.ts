import { afterEach, describe, expect, it, vi } from "vitest"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { WorkerEvent } from "../server/bus.js"
import type { Config } from "../server/config.js"
import type { BoxProvider } from "../server/providers/types.js"
import type { LocalMemory } from "../server/tasks.js"
import { LOCAL_BOX_ID } from "../shared/runner.js"
import type { TaskPriority } from "../shared/types.js"
import { testConfig } from "./helpers.js"

// One cap for every turn on this computer (Settings › Local agents): top-level tasks, sub-tasks at any depth (runs_on
// "same" too), resumed turns and hook turns all take a slot through schedulePass, in queue order. A turn waiting for
// its sub-tasks in wait_for_subtasks gives its slot to them meanwhile (parkForSubtasks), and new turns here wait while
// memory is short (localMemoryWait). Through TaskManager with an inert provider: launch only records the start.

const GB = 1024 ** 3
const yards: BoxYard[] = []
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const yard of yards.splice(0)) yard.stop()
})

type Internals = {
  schedulePass(): Promise<void>
  launch(id: string, boxId: string, turnId: string): Promise<void>
  writeTaskFile: (...args: unknown[]) => Promise<void>
  localMemory: (() => Promise<LocalMemory | null>) | null
}

function fixture(over: Partial<Config> = {}) {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(1_800_000_000_000)
  const io = { wake: vi.fn(async () => {}), exec: vi.fn(async () => { throw new Error("Unexpected execution in inert fixture") }), writeFile: vi.fn(async () => {}), uploadFile: vi.fn(async () => {}) }
  const provider = { name: "upstash", nodeBin: "node", claudeBin: "example-agent", root: () => "/example", ...io, of: () => ({ name: "upstash", root: () => "/example", ...io }) } as unknown as BoxProvider
  const yard = createBoxYard(testConfig({ localAgents: 3, ...over }), { provider, localRunner: { ...provider, name: "local" }, webDir: "/nonexistent" })
  yards.push(yard)
  const tasks = yard.tasks as unknown as Internals
  const schedule = vi.spyOn(yard.tasks, "schedule").mockImplementation(() => {})
  const launched: string[] = []
  vi.spyOn(tasks, "launch").mockImplementation(async (id) => void launched.push(id))
  const files = vi.spyOn(tasks, "writeTaskFile").mockResolvedValue(undefined)
  const project = yard.store.createProject({ name: "example-local", runner: "local" })
  const tick = (ms = 1000) => vi.setSystemTime(Date.now() + ms)
  const task = (title: string, opts: { parent?: string; priority?: TaskPriority } = {}) => {
    tick()
    const parent = opts.parent ? yard.store.getTaskRow(opts.parent)! : null
    const subtask = parent ? { parentId: parent.id, rootId: parent.root_task_id ?? parent.id, depth: (parent.subtask_depth ?? 0) + 1, withParent: true } : null
    return yard.tasks.createTask({ projectId: project.id, title, prompt: "Example", subtask, priority: opts.priority })
  }
  /** A turn here that already runs, as launch leaves it (its turn recorded, so it has a start time). */
  const running = (title: string, opts: { parent?: string } = {}) => {
    const t = task(title, opts)
    const turnId = `turn_${t.id}`
    yard.store.updateTask(t.id, { status: "working", currentTurnId: turnId, boxId: LOCAL_BOX_ID })
    yard.store.startTaskTurn({ id: turnId, taskId: t.id, turnIndex: 0, model: null, effort: null, routingRule: null, routingReason: null, boxId: LOCAL_BOX_ID })
    return t
  }
  const row = (id: string) => yard.store.getTaskRow(id)!
  /** Its turn ends, as the runner's turn_end would leave it: idle, with the input that started it taken. */
  const end = (id: string) => {
    yard.store.clearInputs(id)
    yard.store.updateTask(id, { status: "idle", currentTurnId: null })
  }
  const pass = async () => {
    tick()
    await tasks.schedulePass()
  }
  const event = (id: string, ev: Record<string, unknown>) => yard.tasks.apply(id, { turnId: row(id).current_turn_id, ...ev } as WorkerEvent)
  const grants = (id: string) => files.mock.calls.filter((c) => c[0] === id && /^slot-/.test(String(c[1]))).map((c) => c[1])
  const log = (id: string) => yard.store.listTaskMessages(id, 100).filter((m) => m.role === "event").map((m) => m.content)
  const inUse = () => yard.store.slotsInUse(LOCAL_BOX_ID)
  return { yard, tasks, schedule, launched, files, project, task, running, row, end, pass, event, grants, log, inUse, tick }
}

describe("one turn cap on this computer", () => {
  it("gives a local parent's runs_on \"same\" sub-tasks a Local agents slot each, not an unlimited shared one", async () => {
    const f = fixture()
    const parent = f.running("Parent")
    const kids = ["A", "B", "C", "D"].map((t) => f.task(t, { parent: parent.id }))
    await f.pass()
    // The parent holds 1 of 3 slots: only the first 2 of its sub-tasks start.
    expect(f.launched).toEqual([kids[0]!.id, kids[1]!.id])
    expect(f.inUse()).toBe(3)
    for (const k of kids.slice(2)) {
      expect(f.row(k.id).status).toBe("queued")
      expect(f.row(k.id).wait_reason).toMatch(/: this computer runs 3 tasks at a time \(Settings › Tasks running at once on this computer\)$/)
    }
    // A sub-task's sub-task the same.
    f.end(kids[0]!.id)
    const grandkid = f.task("A1", { parent: kids[1]!.id })
    await f.pass()
    expect(f.launched.slice(2)).toEqual([kids[2]!.id])
    expect(f.row(grandkid.id).status).toBe("queued")
    expect(f.inUse()).toBe(3)
  })

  it("queues new tasks, sub-tasks, resumed turns and hook turns in one line: high priority first, then first in, first out", async () => {
    const f = fixture({ localAgents: 1 })
    const parent = f.running("Parent")
    f.end(parent.id)
    const top = f.task("Top-level")
    const kid = f.task("Sub-task", { parent: parent.id })
    f.tick()
    const resumed = f.running("Resumed")
    f.end(resumed.id)
    f.yard.tasks.send(resumed.id, "One more thing", "captain:example")
    f.tick()
    const hooked = f.running("Hooked")
    f.end(hooked.id)
    f.yard.tasks.send(hooked.id, "A hook's prompt", "hook:example")
    const urgent = f.task("Urgent", { priority: "high" })
    const order: string[] = []
    for (let i = 0; i < 5; i++) {
      await f.pass()
      expect(f.inUse()).toBe(1)
      const started = f.launched.at(-1)!
      order.push(f.row(started).title)
      f.end(started)
    }
    expect(order).toEqual(["Urgent", "Top-level", "Sub-task", "Resumed", "Hooked"])
    expect([top, kid, resumed, hooked, urgent].every((t) => f.launched.includes(t.id))).toBe(true)
  })

  it("parks a parent waiting on its sub-tasks so they take its slot, then gives it one back before newer turns", async () => {
    const f = fixture()
    const parent = f.running("Parent")
    const kids = ["A", "B", "C", "D"].map((t) => f.task(t, { parent: parent.id }))
    await f.pass()
    expect(f.launched).toHaveLength(2)
    // wait_for_subtasks started waiting: the parent's slot goes to its third sub-task.
    f.event(parent.id, { t: "subtask_wait", id: "park_0123456789ab" })
    expect(f.schedule).toHaveBeenCalled()
    expect(f.inUse()).toBe(2)
    expect(f.yard.tasks.poolLimits()).toMatchObject({ localAgents: 3, localAgentsRunning: 2, localAgentsWaitingOnSubtasks: 1 })
    await f.pass()
    expect(f.launched).toEqual(kids.slice(0, 3).map((k) => k.id))
    expect(f.inUse()).toBe(3)

    // Its wait is over (the runner asks for a slot back): every slot is taken, so it waits, and its log says so once.
    await f.event(parent.id, { t: "subtask_wait_end", id: "park_0123456789ab" })
    await f.pass()
    await f.pass()
    expect(f.grants(parent.id)).toEqual([])
    expect(f.log(parent.id).filter((l) => /to go on after its sub-tasks\.$/.test(l))).toHaveLength(1)
    expect(f.inUse()).toBe(3)

    // A sub-task ends: the parent's turn started before the last sub-task queued, so it gets the slot first.
    f.end(kids[0]!.id)
    await f.pass()
    expect(f.grants(parent.id)).toEqual(["slot-park_0123456789ab.json"])
    expect(f.row(parent.id).parked_turn_id).toBeNull()
    expect(f.row(kids[3]!.id).status).toBe("queued")
    expect(f.inUse()).toBe(3)
    expect(f.yard.tasks.poolLimits()).toMatchObject({ localAgentsRunning: 3, localAgentsWaitingOnSubtasks: 0 })
  })

  it("lets a high-priority task go ahead of a parent asking for its slot back", async () => {
    const f = fixture({ localAgents: 1 })
    const parent = f.running("Parent")
    const kid = f.task("Kid", { parent: parent.id })
    f.event(parent.id, { t: "subtask_wait", id: "park_0123456789ab" })
    await f.pass()
    expect(f.launched).toEqual([kid.id])
    f.end(kid.id)
    await f.event(parent.id, { t: "subtask_wait_end", id: "park_0123456789ab" })
    const urgent = f.task("Urgent", { priority: "high" })
    await f.pass()
    expect(f.launched).toEqual([kid.id, urgent.id])
    expect(f.grants(parent.id)).toEqual([])
    f.end(urgent.id)
    await f.pass()
    expect(f.grants(parent.id)).toEqual(["slot-park_0123456789ab.json"])
  })

  it("ignores a wait from a turn that isn't running, and lets a wait that holds no parked slot go on at once", async () => {
    const f = fixture()
    const parent = f.running("Parent")
    f.event(parent.id, { t: "subtask_wait", id: "park_0123456789ab", turnId: "turn_old" })
    f.event(parent.id, { t: "subtask_wait", id: "../escape" })
    expect(f.row(parent.id).parked_turn_id).toBeNull()
    expect(f.inUse()).toBe(1)
    // Not parked (a lost event, or a server restart in between): its slot is still its own, so it goes on.
    await f.event(parent.id, { t: "subtask_wait_end", id: "park_0123456789ab" })
    expect(f.grants(parent.id)).toEqual(["slot-park_0123456789ab.json"])
    // A parked turn that ends (stopped, failed) holds nothing, and no stale park counts once its next turn runs.
    f.event(parent.id, { t: "subtask_wait", id: "park_ba9876543210" })
    expect(f.yard.store.parkedTurns(LOCAL_BOX_ID)).toBe(1)
    f.end(parent.id)
    expect(f.yard.store.parkedTurns(LOCAL_BOX_ID)).toBe(0)
    f.yard.tasks.send(parent.id, "Again", "cody")
    await f.pass()
    expect(f.inUse()).toBe(1)
    expect(f.yard.store.parkedTurns(LOCAL_BOX_ID)).toBe(0)
  })

  it("keeps a parked turn's slot within the projects' own limits when it takes it back", async () => {
    const f = fixture()
    f.yard.store.updateProject(f.project.id, { agentsPerBox: 1 })
    const parent = f.running("Parent")
    f.event(parent.id, { t: "subtask_wait", id: "park_0123456789ab" })
    const kid = f.task("Kid", { parent: parent.id })
    await f.pass()
    expect(f.launched).toEqual([kid.id])
    await f.event(parent.id, { t: "subtask_wait_end", id: "park_0123456789ab" })
    await f.pass()
    expect(f.grants(parent.id)).toEqual([])
    f.end(kid.id)
    await f.pass()
    expect(f.grants(parent.id)).toEqual(["slot-park_0123456789ab.json"])
  })
})

describe("memory guard on this computer", () => {
  it("holds a new local turn while memory is short, says why, and starts it once memory frees", async () => {
    const f = fixture({ memoryMinFreeMb: 3 * 1024 })
    let used = 15.5 * GB
    f.tasks.localMemory = async () => ({ totalBytes: 16 * GB, usedBytes: used })
    // Alone, a turn starts whatever the memory: no turn here would free any by waiting.
    const first = f.task("First")
    await f.pass()
    expect(f.launched).toEqual([first.id])

    // 4 GB free, but the turn that just started hasn't grown yet: it counts at an agent's usual size.
    used = 12 * GB
    const second = f.task("Second")
    await f.pass()
    expect(f.launched).toEqual([first.id])
    expect(f.row(second.id).status).toBe("queued")
    const reason = "Waiting for memory on this computer: only 2.5 GB of 16 GB memory free, counting a task that just started at about 1.5 GB each (Settings › Memory and load)"
    expect(f.row(second.id).wait_reason).toBe(reason)
    expect(f.log(second.id)).toContain(`${reason}.`)

    // A minute on it counts as measured: 4 GB is free.
    f.tick(60_000)
    await f.pass()
    expect(f.launched).toEqual([first.id, second.id])

    // Over Memory used % too.
    f.tick(60_000)
    f.yard.settings.update({ memoryMaxUsedPercent: 70, memoryMinFreeMb: 0 })
    const third = f.task("Third")
    await f.pass()
    expect(f.row(third.id).wait_reason).toBe("Waiting for memory on this computer: 12 GB of 16 GB memory in use (75%), over 70% (Settings › Memory and load)")
    used = 10 * GB
    await f.pass()
    expect(f.launched).toEqual([first.id, second.id, third.id])
  })

  it("never holds a sub-task back for memory when the only turns here are parked waiting for it", async () => {
    const f = fixture({ memoryMinFreeMb: 3 * 1024 })
    f.tasks.localMemory = async () => ({ totalBytes: 16 * GB, usedBytes: 15.5 * GB })
    const parent = f.running("Parent")
    const kid = f.task("Kid", { parent: parent.id })
    await f.pass()
    expect(f.row(kid.id).wait_reason).toMatch(/^Waiting for memory on this computer: /)
    f.event(parent.id, { t: "subtask_wait", id: "park_0123456789ab" })
    await f.pass()
    expect(f.launched).toEqual([kid.id])
  })

  it("looks again on its own while a turn waits for memory, and is off when its settings are", async () => {
    const f = fixture({ memoryMinFreeMb: 3 * 1024 })
    const read = vi.fn(async () => ({ totalBytes: 16 * GB, usedBytes: 15.5 * GB }))
    f.tasks.localMemory = read
    f.running("Running")
    const waiting = f.task("Waiting")
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
    await f.pass()
    expect(f.row(waiting.id).wait_reason).toMatch(/^Waiting for memory/)
    f.schedule.mockClear()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(f.schedule).toHaveBeenCalledTimes(1)
    vi.useFakeTimers({ toFake: ["Date"] })

    f.yard.settings.update({ memoryMinFreeMb: 0, memoryMaxUsedPercent: 0 })
    read.mockClear()
    await f.pass()
    expect(read).not.toHaveBeenCalled()
    expect(f.launched).toEqual([waiting.id])
  })
})

describe("Store: parked turns", () => {
  it("counts a parked turn in no slot, and takes it back only while a slot is free", async () => {
    const f = fixture({ localAgents: 2 })
    const a = f.running("A")
    const b = f.running("B")
    expect(f.yard.store.parkTurn(a.id, "turn_other", "park_0123456789ab")).toBe(false)
    expect(f.yard.store.parkTurn(a.id, `turn_${a.id}`, "park_0123456789ab")).toBe(true)
    expect(f.yard.store.slotsInUse(LOCAL_BOX_ID)).toBe(1)
    expect(f.yard.store.boxAgents(LOCAL_BOX_ID).map((x) => x.taskId)).toEqual([b.id])
    expect(f.yard.store.parkedTurns(LOCAL_BOX_ID)).toBe(1)
    // Not asking yet: nothing to take.
    expect(f.yard.store.claimParkedSlot(a.id, LOCAL_BOX_ID, 2)).toBe(false)
    expect(f.yard.store.wantSlotBack(a.id, "park_other")).toBe(false)
    expect(f.yard.store.wantSlotBack(a.id, "park_0123456789ab")).toBe(true)
    expect(f.yard.store.slotBackWanted().map((r) => r.id)).toEqual([a.id])
    f.running("C")
    expect(f.yard.store.claimParkedSlot(a.id, LOCAL_BOX_ID, 2)).toBe(false)
    expect(f.yard.store.parkedTurns(LOCAL_BOX_ID)).toBe(1)
    f.end(b.id)
    expect(f.yard.store.claimParkedSlot(a.id, LOCAL_BOX_ID, 2)).toBe(true)
    expect(f.yard.store.slotsInUse(LOCAL_BOX_ID)).toBe(2)
    expect(f.yard.store.slotBackWanted()).toEqual([])
    expect(f.yard.store.claimParkedSlot(a.id, LOCAL_BOX_ID, 2)).toBe(false)
  })
})
