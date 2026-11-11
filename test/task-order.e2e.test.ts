import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Task, UiEvent } from "../shared/types.js"
import { freePort, testConfig, tmpDir } from "./helpers.js"

// The sidebar's task order is saved on the server: PUT /api/projects/:id/tasks/order places a project's tasks, or one
// task's sub-tasks, and every task whose place changed goes out on the event stream. It survives a restart.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  events: UiEvent[]
}
const running: Running[] = []

async function start(dataDir = tmpDir()): Promise<Running> {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port, dataDir }), { webDir: "/nonexistent" })
  yard.tasks.stop() // All rows are isolated fixtures. No runner/turn is launched.
  const events: UiEvent[] = []
  const broadcast = yard.hub.broadcast.bind(yard.hub)
  yard.hub.broadcast = (ev: UiEvent) => (events.push(ev), broadcast(ev))
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  const r = { yard, server, base: `http://127.0.0.1:${port}`, events }
  running.push(r)
  return r
}

async function stop(r: Running) {
  running.splice(running.indexOf(r), 1)
  r.yard.stop()
  await new Promise((res) => r.server.close(() => res(null)))
}

afterEach(async () => {
  for (const r of [...running]) await stop(r)
})

async function send(r: Running, method: string, path: string, body?: unknown) {
  const res = await fetch(r.base + path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, data: (await res.json()) as any }
}
const order = (r: Running, projectId: string, body: unknown) => send(r, "PUT", `/api/projects/${projectId}/tasks/order`, body)
const places = async (r: Running) => Object.fromEntries(((await send(r, "GET", "/api/tasks")).data as Task[]).map((t) => [t.title, t.sortOrder]))
const moved = (r: Running) => r.events.flatMap((e) => (e.type === "task" ? [[e.task.title, e.task.sortOrder]] : []))

function seed(r: Running) {
  const { store } = r.yard
  const project = store.createProject({ name: "example-project" })
  const other = store.createProject({ name: "example-other" })
  const task = (title: string, projectId = project.id) => store.createTask({ projectId, title, prompt: "Example" })
  const [a, b, c] = [task("a"), task("b"), task("c")]
  const sub = (title: string) => store.createTask({ projectId: project.id, title, prompt: "Example", subtask: { parentId: a.id, rootId: a.id, depth: 1, withParent: true } })
  const [x, y] = [sub("x"), sub("y")]
  const theirs = task("theirs", other.id)
  r.events.length = 0
  return { project, other, a, b, c, x, y, theirs }
}

describe("task order API", () => {
  it("places a project's tasks, serves the places and sends each moved task to open clients", async () => {
    const r = await start()
    const { project, a, b, c } = seed(r)
    expect(await places(r)).toMatchObject({ a: null, b: null, c: null })

    const res = await order(r, project.id, { ids: [c.id, a.id, b.id] })
    expect(res.status).toBe(200)
    expect(res.data).toEqual({ changed: [c.id, a.id, b.id] })
    expect(await places(r)).toMatchObject({ c: 0, a: 1, b: 2, x: null, y: null })
    expect(moved(r)).toEqual([["c", 0], ["a", 1], ["b", 2]])

    // One step down: only the two rows that swapped go out.
    r.events.length = 0
    expect((await order(r, project.id, { ids: [a.id, c.id, b.id] })).data).toEqual({ changed: [a.id, c.id] })
    expect(moved(r)).toEqual([["a", 0], ["c", 1]])
  })

  it("places one task's sub-tasks, and clears the places with auto", async () => {
    const r = await start()
    const { project, a, x, y } = seed(r)
    expect((await order(r, project.id, { parentTaskId: a.id, ids: [y.id, x.id] })).status).toBe(200)
    expect(await places(r)).toMatchObject({ y: 0, x: 1, a: null })
    expect(moved(r)).toEqual([["y", 0], ["x", 1]])

    expect((await order(r, project.id, { parentTaskId: a.id, ids: [x.id, y.id], auto: true })).data).toEqual({ changed: [x.id, y.id] })
    expect(await places(r)).toMatchObject({ x: null, y: null })
  })

  it("refuses to move a task to another project or parent, and bad bodies, and changes nothing", async () => {
    const r = await start()
    const { project, other, a, b, x, theirs } = seed(r)

    const cross = await order(r, project.id, { ids: [a.id, theirs.id] })
    expect(cross.status).toBe(400)
    expect(cross.data.error).toMatch(/another project/)
    expect((await order(r, other.id, { ids: [a.id] })).status).toBe(400)

    const reparent = await order(r, project.id, { parentTaskId: a.id, ids: [x.id, b.id] })
    expect(reparent.status).toBe(400)
    expect(reparent.data.error).toMatch(/not a sub-task/)

    expect((await order(r, project.id, { ids: [a.id, "task_nothere"] })).status).toBe(400)
    expect((await order(r, project.id, { ids: [a.id, a.id] })).status).toBe(400)
    expect((await order(r, project.id, { ids: "nope" })).status).toBe(400)
    expect((await order(r, project.id, {})).status).toBe(400)
    expect((await order(r, project.id, { ids: [a.id], projectId: other.id })).status).toBe(400)
    expect((await order(r, "prj_nothere", { ids: [] })).status).toBe(404)
    expect((await order(r, project.id, { parentTaskId: theirs.id, ids: [] })).status).toBe(404)

    expect(await places(r)).toEqual({ a: null, b: null, c: null, x: null, y: null, theirs: null })
    expect(moved(r)).toEqual([])
  })

  it("survives a restart", async () => {
    const dataDir = tmpDir()
    const r = await start(dataDir)
    const { project, a, b, c } = seed(r)
    await order(r, project.id, { ids: [b.id, c.id, a.id] })
    await stop(r)

    const r2 = await start(dataDir)
    expect(await places(r2)).toMatchObject({ b: 0, c: 1, a: 2 })
  })
})
