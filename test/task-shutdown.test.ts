import { afterEach, describe, expect, it, vi } from "vitest"
import { createBoxYard } from "../server/app.js"
import { EventReader } from "../server/bus.js"
import { LocalProvider } from "../server/providers/local.js"
import type { TaskRow } from "../server/store.js"
import { FAKE_CLAUDE, testConfig, tmpDir, waitFor } from "./helpers.js"

afterEach(() => vi.restoreAllMocks())

function gate() {
  let release!: () => void
  return { waiting: new Promise<void>((resolve) => { release = resolve }), release: () => release() }
}

describe("shutdown while placing tasks", () => {
  it.each([
    { memory: false, fails: false }, { memory: false, fails: true },
    { memory: true, fails: false }, { memory: true, fails: true },
  ])("cancels a pending probe ($memory memory, $fails failure) before using SQLite or launching", async ({ memory, fails }) => {
    const provider = new LocalProvider(tmpDir("shutdown-boxes-"), FAKE_CLAUDE)
    const yard = createBoxYard(testConfig({ memoryMaxUsedPercent: memory ? 80 : 0 }), { provider, webDir: "/nonexistent" })
    const boxId = await provider.create()
    const now = Date.now()
    yard.store.upsertBox({ id: boxId, provider: "local", status: "ready", created_at: now, last_used_at: now })
    const project = yard.store.createProject({ name: "shutdown" })
    const task = yard.store.createTask({ projectId: project.id, title: "waiting", prompt: "hello" })
    if (memory) {
      yard.store.updateTask(task.id, { boxId })
      const resident = yard.store.createTask({ projectId: project.id, title: "resident", prompt: "hello" })
      yard.store.updateTask(resident.id, { boxId, status: "working", currentTurnId: "resident-turn" })
    }
    const probe = gate()
    let reached = false
    vi.spyOn(provider, "exec").mockImplementation(async () => {
      reached = true
      await probe.waiting
      if (fails) throw new Error("box unavailable")
      return { exitCode: 0, stdout: "fakefs 10000000 1 9999999 1% /work\n", stderr: "" }
    })
    const launch = vi.spyOn(provider, "writeFile")
    const error = vi.spyOn(console, "error")
    yard.tasks.schedule()
    try {
      await waitFor(() => reached, "placement to reach its disk probe")
      yard.stop()
      const prepare = vi.spyOn(yard.store.db, "prepare")
      probe.release()
      await waitFor(() => !(yard.tasks as unknown as { scheduling: boolean }).scheduling, "placement to settle")
      expect(prepare).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
      expect(launch).not.toHaveBeenCalled()
    } finally {
      probe.release()
      if (yard.store.db.open) yard.stop()
    }
  })
})

describe("shutdown while reading task events", () => {
  it.each(["poll", "last events"])("leaves %s for recovery without accessing the closed store", async (mode) => {
    const provider = new LocalProvider(tmpDir("shutdown-events-"), FAKE_CLAUDE)
    const yard = createBoxYard(testConfig(), { provider, webDir: "/nonexistent" })
    const boxId = await provider.create()
    const project = yard.store.createProject({ name: "shutdown" })
    const task = yard.store.createTask({ projectId: project.id, title: "running", prompt: "hello" })
    yard.store.updateTask(task.id, { boxId, status: "working", currentTurnId: "pending-turn" })
    const row = yard.store.getTaskRow(task.id)!
    const read = gate()
    let reached = false
    vi.spyOn(EventReader.prototype, "readFile").mockImplementation(async () => {
      reached = true
      await read.waiting
      return { events: [{ seq: 1, ts: 1, turnId: row.current_turn_id, t: "assistant", text: "saved output" }], cursor: { seq: 1, offset: 100, rid: null, ino: "1" } }
    })
    const warning = vi.spyOn(console, "warn")
    const pending = mode === "poll" ? yard.tasks.pollTask(row) : (yard.tasks as unknown as { turnGone(row: TaskRow, reason: string): Promise<void> }).turnGone(row, "gone")
    try {
      await waitFor(() => reached, "the pending event read")
      yard.stop()
      const prepare = vi.spyOn(yard.store.db, "prepare")
      read.release()
      await pending
      expect(prepare).not.toHaveBeenCalled()
      expect(warning).not.toHaveBeenCalled()
    } finally {
      read.release()
      await pending
      if (yard.store.db.open) yard.stop()
    }
  })
})
