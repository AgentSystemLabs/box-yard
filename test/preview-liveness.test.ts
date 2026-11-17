import { afterEach, describe, expect, it, vi } from "vitest"
import net from "node:net"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { BoxProvider } from "../server/providers/types.js"
import { LOCAL_BOX_ID } from "../shared/runner.js"
import type { PreviewLink, Task } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

// A preview's server stopped (the agent killed it, or it crashed): its chip leaves the task's header, live, and comes
// back if the port answers again (server/previewWatch.ts). These run TaskManager against real ports on this computer,
// the local runner's box: a turn's end looks, and so does an open task page (POST /api/tasks/:id/previews/check).

const yards: BoxYard[] = []
const servers: net.Server[] = []
const http: Server[] = []
afterEach(async () => {
  for (const s of http.splice(0)) s.close()
  for (const y of yards.splice(0)) y.stop()
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
})

function yard() {
  const y = createBoxYard(testConfig(), { webDir: "/nonexistent" })
  yards.push(y)
  const project = y.store.createProject({ name: "site" })
  const broadcast = vi.spyOn(y.hub, "broadcast")
  // The task updates the UI hears, oldest first.
  const broadcasts = () => broadcast.mock.calls.flatMap(([e]) => (e.type === "task" ? [e.task as Task] : []))
  return { y, project, broadcasts }
}

function serve(port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer((c) => c.destroy())
    s.once("error", reject)
    s.listen(port, "127.0.0.1", () => {
      servers.push(s)
      resolve((s.address() as net.AddressInfo).port)
    })
  })
}

async function close(port: number) {
  const i = servers.findIndex((s) => (s.address() as net.AddressInfo | null)?.port === port)
  const [s] = servers.splice(i, 1)
  await new Promise((r) => s!.close(r))
}

const preview = (port: number): PreviewLink => ({ port, url: `http://localhost:${port}`, label: "Landing page" })
const events = (y: BoxYard, id: string) =>
  y.store
    .listTaskMessages(id, 200)
    .filter((m) => m.role === "event")
    .map((m) => m.content)
const previewsOf = (y: BoxYard, id: string) => y.store.getTask(id)!.previews

describe("a task's previews follow their servers", () => {
  it("a turn's end drops the preview of a server the agent stopped, live, and it comes back when the port answers again", async () => {
    const { y, project, broadcasts } = yard()
    const port = await serve()
    const t = y.store.createTask({ projectId: project.id, title: "Landing page", prompt: "Stop the preview" })
    y.store.updateTask(t.id, { status: "working", currentTurnId: "turn_stop1", boxId: LOCAL_BOX_ID, previews: [preview(port)] })
    // The agent stops its dev server, then the turn ends.
    await close(port)
    await y.tasks.apply(t.id, { seq: 1, ts: Date.now(), turnId: "turn_stop1", t: "turn_end", ok: true, exitCode: 0 })
    // The first closed look keeps it (a server restarting); the second, PREVIEW_CONFIRM_MS later, drops it.
    await waitFor(() => !y.store.getTaskRow(t.id)!.current_turn_id, "turn ended")
    // (Taken now rather than after its wait; it runs once the turn's end look is done.)
    await y.tasks.previewWatch.check(t.id, "confirm")
    await waitFor(() => !previewsOf(y, t.id).length, "the preview dropped")
    expect(events(y, t.id)).toContain(`Preview on port ${port} is down: nothing answers there, so its link is hidden until something does.`)
    expect(broadcasts().at(-1)?.previews).toEqual([])

    await serve(port)
    await y.tasks.previewWatch.check(t.id, "turn_end")
    expect(previewsOf(y, t.id)).toEqual([preview(port)])
    expect(events(y, t.id)).toContain(`Preview on port ${port} is back: http://localhost:${port}`)
    expect(broadcasts().at(-1)?.previews).toEqual([preview(port)])
  })

  it("keeps a preview whose server still answers, and asks the runner nothing for a task without one", async () => {
    const { y, project } = yard()
    const port = await serve()
    const live = y.store.createTask({ projectId: project.id, title: "Live", prompt: "x" })
    y.store.updateTask(live.id, { status: "idle", boxId: LOCAL_BOX_ID, previews: [preview(port)] })
    const plain = y.store.createTask({ projectId: project.id, title: "Plain", prompt: "x" })
    y.store.updateTask(plain.id, { status: "idle", boxId: LOCAL_BOX_ID })
    const exec = vi.spyOn((y.tasks as unknown as { provider: BoxProvider }).provider, "exec")
    await y.tasks.previewWatch.check(live.id, "turn_end")
    await y.tasks.previewWatch.check(live.id, "confirm")
    expect(previewsOf(y, live.id)).toEqual([preview(port)])
    await y.tasks.previewWatch.check(plain.id, "turn_end")
    await y.tasks.previewWatch.check(plain.id, "viewer")
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it("looks at a running turn's previews on the maintenance tick, and at no other task", async () => {
    const { y, project } = yard()
    const seed = (title: string, patch: Parameters<BoxYard["store"]["updateTask"]>[1]) => {
      const t = y.store.createTask({ projectId: project.id, title, prompt: "x" })
      y.store.updateTask(t.id, { boxId: LOCAL_BOX_ID, ...patch })
      return t.id
    }
    const working = seed("Working", { status: "working", currentTurnId: "turn_w1", previews: [preview(4870)] })
    seed("Working, no preview", { status: "working", currentTurnId: "turn_w2" })
    seed("Resting", { status: "idle", previews: [preview(4871)] })
    const check = vi.spyOn(y.tasks.previewWatch, "check").mockResolvedValue()
    await y.tasks.maintain()
    expect(check.mock.calls).toEqual([[working, "working"]])
  })

  it("never asks a box that's being deleted, even at a turn's end", async () => {
    const { y, project } = yard()
    y.store.upsertBox({ id: "box-going1", provider: "upstash", status: "deleting", created_at: Date.now(), last_used_at: Date.now(), size: "small", keep_alive: 1, usage_source: "estimated" })
    const t = y.store.createTask({ projectId: project.id, title: "Going", prompt: "x" })
    y.store.updateTask(t.id, { status: "idle", boxId: "box-going1", previews: [preview(4870)] })
    const exec = vi.spyOn((y.tasks as unknown as { provider: BoxProvider }).provider, "exec")
    await y.tasks.previewWatch.check(t.id, "turn_end")
    await y.tasks.previewWatch.check(t.id, "confirm")
    expect(exec).not.toHaveBeenCalled()
    expect(previewsOf(y, t.id)).toEqual([preview(4870)])
  })

  it("an open page asks through the API; a box that may be asleep isn't looked at", async () => {
    const { y, project } = yard()
    const port = await freePort()
    const local = y.store.createTask({ projectId: project.id, title: "Local", prompt: "x" })
    y.store.updateTask(local.id, { status: "idle", boxId: LOCAL_BOX_ID, previews: [preview(port)] })
    // An Upstash box with no turn running may be paused: a look would wake it.
    y.store.upsertBox({ id: "box-sleepy1", provider: "upstash", status: "ready", created_at: Date.now(), last_used_at: Date.now(), size: "small", keep_alive: 0, usage_source: "estimated" })
    const sleepy = y.store.createTask({ projectId: project.id, title: "Sleepy", prompt: "x" })
    y.store.updateTask(sleepy.id, { status: "idle", boxId: "box-sleepy1", previews: [preview(4870)] })
    const exec = vi.spyOn((y.tasks as unknown as { provider: BoxProvider }).provider, "exec")

    const apiPort = await freePort()
    const base = await new Promise<string>((resolve) => {
      const s = y.app.listen(apiPort, "127.0.0.1", () => resolve(`http://127.0.0.1:${apiPort}`))
      http.push(s)
    })
    const ask = (id: string) => fetch(`${base}/api/tasks/${id}/previews/check`, { method: "POST" })
    expect((await ask(sleepy.id)).status).toBe(202)
    expect((await ask(local.id)).status).toBe(202)
    expect((await ask("task_missing1")).status).toBe(404)
    await waitFor(() => exec.mock.results.length === 1 && exec.mock.settledResults[0]?.type === "fulfilled", "the local look")
    expect(exec.mock.calls.map(([boxId]) => boxId)).toEqual([LOCAL_BOX_ID])
    // A second ask within the minute is the same look: nothing more runs.
    expect((await ask(local.id)).status).toBe(202)
    await new Promise((r) => setTimeout(r, 50))
    expect(exec).toHaveBeenCalledTimes(1)
  })
})
