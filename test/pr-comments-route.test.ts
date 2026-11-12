// The full server's side of the new PR comment count (server/prComments.ts): the route every PR link's click posts to,
// and the Settings save that reschedules the background round.
import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { freePort, testConfig, tmpDir } from "./helpers.js"

describe("POST /api/pr-views", () => {
  let yard: BoxYard | undefined
  let server: Server | undefined
  afterEach(async () => {
    yard?.stop()
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    yard = server = undefined
  })

  it("records the view, zeroes the PR's tasks and tells the stream", async () => {
    const port = await freePort()
    yard = createBoxYard(testConfig({ port }), { webDir: "/nonexistent", machines: { keys: { home: tmpDir() } } })
    server = await new Promise<Server>((resolve) => {
      const s = yard!.app.listen(port, "127.0.0.1", () => resolve(s))
    })
    const project = yard.store.createProject({ name: "Site" })
    const t = yard.store.createTask({ projectId: project.id, title: "Retry", prompt: "p" })
    yard.store.updateTask(t.id, { status: "pr_ready", prUrl: "https://github.com/acme/site/pull/4", prState: "open", prNewComments: 5 }, { quiet: true })
    const sent: unknown[] = []
    const broadcast = yard.hub.broadcast.bind(yard.hub)
    yard.hub.broadcast = (event) => {
      sent.push(event)
      broadcast(event)
    }
    const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/pr-views`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

    const before = Date.now()
    const res = await post({ url: "https://github.com/acme/site/pull/4#issuecomment-1" })
    expect(res.status).toBe(200)
    const { viewedAt } = (await res.json()) as { viewedAt: number }
    expect(viewedAt).toBeGreaterThanOrEqual(before)
    expect(yard.store.prViewedAt("acme/site#4")).toBe(viewedAt)
    expect(yard.store.getTask(t.id)!.prNewComments).toBe(0)
    expect(sent).toContainEqual(expect.objectContaining({ type: "task", task: expect.objectContaining({ id: t.id, prNewComments: 0 }) }))

    expect(await (await post({ url: "https://example.com/not-a-pr" })).json()).toEqual({ viewedAt: null })
    expect((await post({})).status).toBe(400)
  })
})

describe("saving Settings › New PR comments", () => {
  let yard: BoxYard | undefined
  let server: Server | undefined
  afterEach(async () => {
    yard?.stop()
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    yard = server = undefined
  })

  it("Off forgets every count at once and tells the stream; a value that isn't offered is refused", async () => {
    const port = await freePort()
    yard = createBoxYard(testConfig({ port }), { webDir: "/nonexistent", machines: { keys: { home: tmpDir() } } })
    server = await new Promise<Server>((resolve) => {
      const s = yard!.app.listen(port, "127.0.0.1", () => resolve(s))
    })
    const project = yard.store.createProject({ name: "Site" })
    const t = yard.store.createTask({ projectId: project.id, title: "Retry", prompt: "p" })
    yard.store.updateTask(t.id, { status: "pr_ready", prUrl: "https://github.com/acme/site/pull/4", prState: "open", prNewComments: 5 }, { quiet: true })
    const sent: unknown[] = []
    const broadcast = yard.hub.broadcast.bind(yard.hub)
    yard.hub.broadcast = (event) => {
      sent.push(event)
      broadcast(event)
    }
    const save = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/agent-settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

    expect((await save({ prCommentMinutes: 7 })).status).toBe(400)
    expect(yard.store.getTask(t.id)!.prNewComments).toBe(5)

    expect((await save({ prCommentMinutes: 0 })).status).toBe(200)
    expect(yard.settings.get().prCommentMinutes).toBe(0)
    expect(yard.store.getTask(t.id)!.prNewComments).toBeNull()
    expect(sent).toContainEqual(expect.objectContaining({ type: "task", task: expect.objectContaining({ id: t.id, prNewComments: null }) }))
  })
})
