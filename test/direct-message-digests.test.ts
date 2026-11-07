import { afterEach, describe, expect, it, vi } from "vitest"
import { openDb } from "../server/db.js"
import { DirectMessageDigests } from "../server/directMessageDigests.js"
import { Hub } from "../server/hub.js"
import { Orchestrator } from "../server/orchestrator.js"
import { SettingsStore } from "../server/settings.js"
import { Store } from "../server/store.js"
import { testConfig } from "./helpers.js"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.restoreAllMocks()
})

function setup() {
  const config = testConfig({ orchestratorAutoWake: true })
  const db = openDb(config.dataDir)
  const store = new Store(db)
  cleanups.push(() => db.close())
  const project = store.createProject({ name: "Cody's project" })
  const task = store.createTask({ projectId: project.id, title: "Cody's task", prompt: "Build it" })
  const sealed = new Set<string>()
  const statusOnly = (id: string) => sealed.has(id)
  const digests = new DirectMessageDigests(store, statusOnly, () => "Sam")
  return { config, db, store, project, task, sealed, statusOnly, digests }
}

describe("human direct-message digests", () => {
  it("persists one bounded latest snippet and count per target, independently of task read receipts", () => {
    const r = setup()
    for (let i = 0; i < 300; i++) r.digests.record({ taskId: r.task.id }, `message ${i}`)
    r.digests.record({ taskId: r.task.id }, "Cody said " + "🙂".repeat(300) + "EXCLUDED-TAIL")
    r.digests.record({ projectId: r.project.id }, "Use Cody's style")
    r.store.markNoticesSeen([r.task.id])
    expect(r.db.prepare("SELECT snippet, message_count FROM coordinator_direct_messages").all()).toEqual([
      { snippet: "Cody said " + "🙂".repeat(189) + "…", message_count: 301 },
      { snippet: "Use Cody's style", message_count: 1 },
    ])
    // A reconstructed queue (as after restart) reads the same pending FYIs, once only.
    const resumed = new DirectMessageDigests(new Store(r.db), r.statusOnly, () => "Sam")
    const updates = resumed.take()
    expect(updates).toHaveLength(2)
    expect(updates[0]).toContain(`Sam told "Cody's task" (${r.task.id}) (301 messages; latest): Cody said `)
    expect(updates[1]).toContain("Sam told the Cody's project Captain: Use Cody's style")
    expect(updates.join("\n")).not.toContain("EXCLUDED-TAIL")
    expect(resumed.take()).toEqual([])
  })

  it("checks privacy at delivery for both task and Captain targets", () => {
    const r = setup()
    r.digests.record({ taskId: r.task.id }, "TASK-SECRET")
    r.digests.record({ projectId: r.project.id }, "CAPTAIN-SECRET")
    r.sealed.add(r.project.id)
    const updates = r.digests.take()
    expect(updates[0]).toContain(`Sam messaged "Cody's task" (${r.task.id})`)
    expect(updates[1]).toContain("Sam messaged the Cody's project Captain")
    expect(updates.join("\n")).not.toContain("SECRET")
  })

  it("never queues sealed content, including when an open target was already queued or privacy is later loosened", () => {
    const r = setup()
    r.digests.record({ taskId: r.task.id }, "OLDER-OPEN-CONTENT")
    r.sealed.add(r.project.id)
    r.digests.record({ taskId: r.task.id }, "SEALED-TASK-CONTENT")
    r.digests.record({ projectId: r.project.id }, "SEALED-CAPTAIN-CONTENT")
    expect(r.db.prepare("SELECT snippet FROM coordinator_direct_messages").all()).toEqual([{ snippet: null }, { snippet: null }])
    r.sealed.clear()
    expect(r.digests.take().join("\n")).not.toContain("CONTENT")
  })

  it("drops deleted targets instead of delivering their content", () => {
    const r = setup()
    r.digests.record({ taskId: r.task.id }, "deleted task")
    r.digests.record({ projectId: r.project.id }, "deleted project")
    r.db.prepare("DELETE FROM tasks WHERE id = ?").run(r.task.id)
    r.db.prepare("DELETE FROM projects WHERE id = ?").run(r.project.id)
    expect(r.digests.take()).toEqual([])
  })
})

describe("Coordinator next-turn delivery", () => {
  function coordinator() {
    const r = setup()
    const hub = new Hub()
    const settings = new SettingsStore(r.store, r.config)
    settings.update({ ownerName: "Sam" })
    const coordinator = new Orchestrator(r.config, r.store, hub, { url: "http://boxyard.invalid/mcp", token: "test" }, settings)
    coordinator.statusOnly = r.statusOnly
    coordinator.tuning.wakeDebounceMs = 1
    const prompts: string[] = []
    // Exercise the real drain/turn/update plumbing; only replace the model subprocess.
    const run = vi.spyOn(coordinator as unknown as { runPrompt(prompt: string): Promise<{ ok: boolean; error: string }> }, "runPrompt")
      .mockImplementation(async (prompt) => {
        prompts.push(prompt)
        return { ok: true, error: "" }
      })
    cleanups.push(() => { coordinator.stop(); hub.close() })
    return { ...r, coordinator, hub, prompts, run }
  }

  it("stays quiet even with a pending wake timer, then joins the next human turn once", async () => {
    const r = coordinator()
    r.coordinator.nudge()
    r.coordinator.directMessages.record({ taskId: r.task.id }, "Please change the button")
    r.coordinator.resumeScheduled()
    expect(r.store.unseenNoticeTasks()).toEqual([])
    expect(r.store.oldestUnseenNoticeAt()).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(r.coordinator.busy).toBe(false)
    expect(r.prompts).toEqual([])

    r.coordinator.send("Where are things?")
    await vi.waitFor(() => expect(r.coordinator.busy).toBe(false))
    expect(r.prompts).toHaveLength(1)
    expect(r.prompts[0]).toContain("[Box Yard updates since your last turn]\n- Sam told")
    expect(r.prompts[0]).toContain("Please change the button")
    r.coordinator.send("Thanks")
    await vi.waitFor(() => expect(r.coordinator.busy).toBe(false))
    expect(r.prompts[1]).not.toContain("Please change the button")
  })

  it("never adds a turn when a message arrives busy or in the idle broadcast race", async () => {
    const r = coordinator()
    let release!: () => void
    r.run.mockImplementationOnce(async (prompt) => {
      r.prompts.push(prompt)
      await new Promise<void>((resolve) => { release = resolve })
      return { ok: true, error: "" }
    })
    r.coordinator.send("Start a turn")
    await vi.waitFor(() => expect(r.prompts).toHaveLength(1))
    r.coordinator.directMessages.record({ taskId: r.task.id }, "while busy")
    const broadcast = vi.spyOn(r.hub, "broadcast").mockImplementation((event) => {
      if (event.type === "chat.busy" && !event.busy) {
        r.coordinator.directMessages.record({ projectId: r.project.id }, "at idle")
        broadcast.mockRestore()
      }
    })
    r.sealed.add(r.project.id)
    release()
    await vi.waitFor(() => expect(r.coordinator.busy).toBe(false))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(r.prompts).toHaveLength(1)
    r.coordinator.send("Next natural turn")
    await vi.waitFor(() => expect(r.coordinator.busy).toBe(false))
    expect(r.prompts).toHaveLength(2)
    expect(r.prompts[1]).toContain(`Sam messaged "Cody's task" (${r.task.id})`)
    expect(r.prompts[1]).toContain("Sam messaged the Cody's project Captain")
    expect(r.prompts[1]).not.toMatch(/while busy|at idle/)
  })

  it("delivers with an unrelated automatic update without requiring a human Coordinator message", async () => {
    const r = coordinator()
    r.coordinator.directMessages.record({ taskId: r.task.id }, "Human FYI")
    r.store.addChat("notice", "Unrelated task finished")
    r.coordinator.nudge()
    await vi.waitFor(() => expect(r.prompts).toHaveLength(1))
    await vi.waitFor(() => expect(r.coordinator.busy).toBe(false))
    expect(r.prompts[0]).toContain("Unrelated task finished")
    expect(r.prompts[0]).toContain("Human FYI")
  })

  it("joins the next scheduled turn as well", async () => {
    const r = coordinator()
    r.coordinator.directMessages.record({ projectId: r.project.id }, "Scheduled-turn FYI")
    const schedule = r.store.createSchedule({ target: "orchestrator", projectId: null, name: "Check in", cron: "@daily", timezone: "UTC", prompt: "Status", nextRunAt: null })
    const run = r.store.createScheduleRun({ scheduleId: schedule.id, prompt: "Status", reason: "manual", dueAt: Date.now() })
    r.coordinator.enqueueScheduled(run.id)
    await vi.waitFor(() => expect(r.coordinator.busy).toBe(false))
    expect(r.prompts).toHaveLength(1)
    expect(r.prompts[0]).toContain("Scheduled-turn FYI")
    expect(r.store.getScheduleRun(run.id)?.status).toBe("done")
  })
})
