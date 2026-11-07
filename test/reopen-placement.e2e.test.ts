import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Config } from "../server/config.js"
import { LocalProvider } from "../server/providers/local.js"
import type { Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// A task Cody closes and then reopens doesn't wait for the box it ran on. Closing archives its workspace and frees
// its box slot, even when the reopen comes while that archive is still being written, so its next message takes a
// free slot on another of its project's boxes or a new box and restores from the archive. One whose workspace is
// still on its busy box moves off it when its archive holds all its work: a whole archive does, without a push.

interface Running {
  yard: BoxYard
  server: Server
  boxes: string
}
const running: Running[] = []

async function start(overrides: Partial<Config> = {}): Promise<Running> {
  const port = await freePort()
  const boxes = tmpDir("boxes-")
  const yard = createBoxYard(testConfig({ port, maxBoxes: 2, ...overrides }), { webDir: "/nonexistent", provider: new LocalProvider(boxes, FAKE_CLAUDE) })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, boxes }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    for (const t of r.yard.store.listTaskRows()) if (t.current_turn_id) await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    await new Promise((res) => setTimeout(res, 200))
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

const HANG = "keep going [hang]"
const getTask = (r: Running, id: string) => r.yard.store.getTask(id)!
const newTask = (r: Running, projectId: string, title: string, prompt = "draw fifty icons") => r.yard.tasks.createTask({ projectId, title, prompt })
const status = (r: Running, id: string, want: (t: Task) => boolean, what: string) =>
  waitFor(() => {
    const t = getTask(r, id)
    return want(t) ? t : null
  }, what)
const working = (r: Running, id: string) => status(r, id, (t) => t.status === "working", `task ${id} to work`)
/** Its turn finished and rested (idle), its archive written. */
const settled = (r: Running, id: string) => status(r, id, (t) => t.status === "idle" && Boolean(t.lastArchivedAt) && t.pendingCount === 0, `task ${id} to finish and archive`)
/** Its next turn ran and it rests again, on a box. */
const ranAgain = (r: Running, id: string) => status(r, id, (t) => t.status === "idle" && t.pendingCount === 0 && Boolean(t.boxId) && t.turnCount === 2, `task ${id} to run its next turn`)
const events = (r: Running, id: string) =>
  r.yard.store
    .listTaskMessages(id, 200)
    .filter((m) => m.role === "event")
    .map((m) => m.content)
const folderOn = (r: Running, boxId: string, taskId: string) => fs.existsSync(path.join(r.boxes, boxId, "tasks", taskId))

/** Close and reopen in one tick: the reopen lands while the close's archive is still being written. */
function closeAndReopen(r: Running, id: string) {
  void r.yard.tasks.closeTask(id)
  r.yard.tasks.reopenTask(id)
}

/** Its box with both slots taken by agents that keep running. */
async function fill(r: Running, projectId: string, boxId: string) {
  for (const n of [1, 2]) expect((await working(r, newTask(r, projectId, `runner ${n}`, HANG).id)).boxId).toBe(boxId)
  expect(r.yard.store.slotsInUse(boxId)).toBe(2)
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" }).toString().trim()

/** A bare origin with one commit on main, served over file:// like GitHub. */
function origin() {
  const root = tmpDir("box-yard-origin-")
  const bare = path.join(root, "origin.git")
  const seed = path.join(root, "seed")
  git(root, "init", "-q", "--bare", "-b", "main", bare)
  git(root, "init", "-q", "-b", "main", seed)
  fs.writeFileSync(path.join(seed, "README.md"), "hello\n")
  git(seed, "add", ".")
  git(seed, "commit", "-qm", "init")
  git(seed, "push", "-q", bare, "main")
  return `file://${bare}`
}

describe("a reopened task's placement", () => {
  it("frees its box when the reopen beats the close's archive, so its next message takes the project's free box", async () => {
    const r = await start()
    const p = r.yard.store.createProject({ name: "alpha" })
    const t = await settled(r, newTask(r, p.id, "icons").id)
    const busy = t.boxId!
    await fill(r, p.id, busy)
    // A second box of the project, free again: a third agent made it and was stopped.
    const third = newTask(r, p.id, "runner 3", HANG)
    const free = (await working(r, third.id)).boxId!
    expect(free).not.toBe(busy)
    await r.yard.tasks.stopTask(third.id)
    await waitFor(() => r.yard.store.slotsInUse(free) === 0, "the second box to be free")

    closeAndReopen(r, t.id)
    expect(getTask(r, t.id)).toMatchObject({ status: "idle", boxId: busy })
    // Closing said its slot was freed: once the archive is written, it is, though the task is open again.
    await status(r, t.id, (x) => x.boxId === null, "its folder to leave its busy box")
    expect(getTask(r, t.id).status).toBe("idle")
    expect(folderOn(r, busy, t.id)).toBe(false)
    expect(events(r, t.id)).toContain(`Its folder left box ${busy} now that closing archived it; the next message restores it from the archive.`)

    r.yard.tasks.sendInput(t.id, "ten more, please", "cody")
    expect((await ranAgain(r, t.id)).boxId).toBe(free)
    expect(events(r, t.id)).toContain(`Workspace restored on box ${free}.`)
    expect(r.yard.store.slotsInUse(busy)).toBe(2)
  }, 60_000)

  it("restores it on a new box when the project's boxes are all busy and the pool has room", async () => {
    const r = await start()
    const p = r.yard.store.createProject({ name: "alpha" })
    const t = await settled(r, newTask(r, p.id, "icons").id)
    const busy = t.boxId!
    await fill(r, p.id, busy)
    expect(r.yard.store.listBoxes()).toHaveLength(1)

    closeAndReopen(r, t.id)
    await status(r, t.id, (x) => x.boxId === null, "its folder to leave its busy box")
    r.yard.tasks.sendInput(t.id, "ten more, please", "cody")
    const ran = await ranAgain(r, t.id)
    expect(ran.boxId).not.toBe(busy)
    expect(r.yard.store.listBoxes().map((b) => b.id).sort()).toEqual([busy, ran.boxId].sort())
    expect(events(r, t.id)).toContain(`Workspace restored on box ${ran.boxId}.`)
    expect(events(r, t.id).some((e) => e.startsWith("Waiting for a free slot on"))).toBe(false)
  }, 60_000)

  it("moves one whose workspace is still on its busy box to a new box when its whole archive holds its work, with no push", async () => {
    const r = await start()
    const p = r.yard.store.createProject({ name: "alpha" })
    // A repo whose turn-end push is off (or failing): its archive keeps the whole workspace, .git and all.
    r.yard.store.db.prepare("UPDATE projects SET repo = ?, push_at_turn_end = 0 WHERE id = ?").run(origin(), p.id)
    const t = await settled(r, newTask(r, p.id, "icons").id)
    expect(r.yard.store.getTaskRow(t.id)!.archive_kind).toBe("whole")
    expect(t.pushState).toBeNull()
    const busy = t.boxId!
    await fill(r, p.id, busy)

    // A message right after the reopen: it wants a turn, so the close leaves its folder for placement to settle.
    closeAndReopen(r, t.id)
    r.yard.tasks.sendInput(t.id, "ten more, please", "cody")
    const ran = await ranAgain(r, t.id)
    expect(ran.boxId).not.toBe(busy)
    expect(events(r, t.id).some((e) => e.startsWith(`Moved from busy box ${busy} to ${ran.boxId}`))).toBe(true)
    expect(folderOn(r, busy, t.id)).toBe(false)
  }, 90_000)
})
