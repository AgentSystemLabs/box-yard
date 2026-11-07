import { afterEach, describe, expect, it, vi } from "vitest"
import path from "node:path"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { LocalProvider } from "../server/providers/local.js"
import { LOCAL_BOX_ID } from "../shared/runner.js"
import { testConfig } from "./helpers.js"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { buildMcpServer } from "../server/mcp.js"

const yards: BoxYard[] = []
afterEach(() => { for (const y of yards.splice(0)) { y.stop(); y.store.db.close() } })
function fixture(password = "", mock = true, redis = false) {
  const config = testConfig({ mock, password, ...(redis ? { redisUrl: "https://example.invalid", redisToken: "fixture-server-only" } : {}) })
  const provider = new LocalProvider(path.join(config.dataDir, "boxes"))
  const yard = createBoxYard(config, { provider, webDir: "/nonexistent" })
  yards.push(yard)
  // No scheduler, external requests, subprocess agents or live runners are used.
  vi.spyOn(yard.tasks as never, "schedule").mockImplementation(() => {})
  vi.spyOn(yard.tasks as never, "publishDirectory").mockImplementation(() => {})
  const transport = (yard.tasks as unknown as { provider: LocalProvider }).provider
  vi.spyOn(transport, "writeFile").mockResolvedValue()
  const project = yard.store.createProject({ name: "example", runner: "docker" })
  const task = yard.tasks.createTask({ projectId: project.id, title: "Parent", prompt: "Example", runsOn: "docker" })
  yard.store.updateTask(task.id, { boxId: "docker-example" })
  return { yard, provider: transport, project, task, config }
}

describe("server-owned task containment", () => {
  it("persists the ceiling across server reconstruction and a changed project default", () => {
    const { yard, task, project, config } = fixture()
    yard.store.updateProject(project.id, { runner: "local" })
    yard.store.updateTask(task.id, { boxId: null, runsOn: null })
    yard.stop(); yard.store.db.close(); yards.splice(yards.indexOf(yard), 1)
    const reopened = createBoxYard(config, { provider: new LocalProvider(path.join(config.dataDir, "boxes")), webDir: "/nonexistent" })
    yards.push(reopened)
    expect(() => reopened.tasks.setRunsOn(task.id, "local")).toThrow(/containment/)
  })

  it("omits shared Redis authority and consumes task-local events even when Redis is configured", () => {
    const { yard, task, project } = fixture("", true, true)
    const internals = yard.tasks as unknown as { reader: { mode: string }; taskJson(...args: unknown[]): { redis: unknown; env: Record<string, string> } }
    const config = internals.taskJson(yard.store.getTaskRow(task.id), project, "docker-example", null, { author: null, source: "none" })
    expect(config.redis).toBeNull()
    expect(JSON.stringify(config.env)).not.toContain("fixture-server-only")
    expect(internals.reader.mode).toBe("file")
  })

  it("rejects worker local/SSH delegation atomically through real event dispatch", async () => {
    const { yard, task, provider } = fixture()
    for (const agentCli of ["claude", "codex", "cursor"] as const) for (const runsOn of ["local", "ssh"]) {
      yard.store.updateTask(task.id, { agentCli })
      await yard.tasks.apply(task.id, { t: "spawn_subtasks", seq: 1, ts: 1, turnId: null, id: "sub_0123456789ab", tasks: [{ title: "Child", prompt: "Example", runsOn }] })
      expect(yard.store.subtaskRows(task.id)).toEqual([])
      expect(provider.writeFile).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.stringContaining("rejected"))
    }
  })

  it("pins same/default descendants and refuses model changes after project defaults change", async () => {
    const { yard, task, project } = fixture()
    await yard.tasks.apply(task.id, { t: "spawn_subtasks", seq: 1, ts: 1, turnId: null, id: "sub_0123456789ab", tasks: [{ title: "Child", prompt: "Example" }] })
    const child = yard.store.subtaskRows(task.id)[0]!
    expect(child.runs_on).toBe("docker")
    yard.store.updateProject(project.id, { runner: "local" })
    expect(yard.store.taskRunner(child)).toBe("docker")
    expect(() => yard.tasks.setRunsOn(child.id, "local")).toThrow(/containment/)
    expect(() => yard.tasks.setRunsOn(task.id, "ssh")).toThrow(/containment/)
    expect(() => yard.tasks.createTask({ projectId: project.id, title: "Grandchild", prompt: "Example", runsOn: "local", subtask: { parentId: child.id, rootId: task.id, depth: 2, withParent: false } })).toThrow(/containment/)
  })

  it("checks actual placement before waking a provider, even with forged stored runner metadata", async () => {
    const { yard, task, provider } = fixture()
    const wake = vi.spyOn(provider, "wake").mockResolvedValue()
    const internals = yard.tasks as unknown as { assign(id: string, box: string): string; launch(id: string, box: string, turn: string): Promise<void> }
    expect(() => internals.assign(task.id, LOCAL_BOX_ID)).toThrow(/containment/)
    await internals.launch(task.id, LOCAL_BOX_ID, "turn_example")
    expect(wake).not.toHaveBeenCalled()
    yard.store.updateTask(task.id, { runsOn: "local" })
    await internals.launch(task.id, "docker-example", "turn_example")
    expect(wake).not.toHaveBeenCalled()
  })

  it("rejects an unsandboxed folder provider even when its box id claims an isolated runner", () => {
    const { yard, task } = fixture("", false)
    const internals = yard.tasks as unknown as { assign(id: string, box: string): string }
    expect(() => internals.assign(task.id, "example-unclassified-box")).toThrow(/containment/)
  })

  it("keeps descendants restricted after a human elevation and narrows again on isolation", () => {
    const { yard, task } = fixture()
    const child = yard.tasks.createTask({ projectId: task.projectId, title: "Child", prompt: "Example", runsOn: "docker", subtask: { parentId: task.id, rootId: task.id, depth: 1, withParent: false } })
    yard.tasks.elevateRunner(task.id, "local")
    yard.tasks.setRunsOn(task.id, "local")
    expect(() => yard.tasks.setRunsOn(child.id, "local")).toThrow(/containment/)
    yard.tasks.setRunsOn(task.id, "docker")
    expect(() => yard.tasks.setRunsOn(task.id, "local")).toThrow(/containment/)
  })

  it("exposes elevation only to authenticated humans, with explicit confirmation and no active turn", async () => {
    for (const password of ["", "example-fixture-password"]) {
      const { yard, task } = fixture(password)
      vi.spyOn(yard.tasks, "requireRunner").mockResolvedValue()
      const server = await new Promise<Server>(resolve => { const s = yard.app.listen(0, "127.0.0.1", () => resolve(s)) })
      try {
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
        const call = (body: unknown, authenticated = false) => fetch(`${base}/api/tasks/${task.id}/runner-elevation`, {
          method: "POST", headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${password}` } : {}) }, body: JSON.stringify(body),
        })
        expect((await call({ runner: "local", confirm: true })).status).toBe(password ? 401 : 403)
        if (!password) continue
        expect((await call({ runner: "local" }, true)).status).toBe(400)
        expect((await call({ runner: "local", confirm: true }, true)).status).toBe(200)
        expect(() => yard.tasks.setRunsOn(task.id, "local")).not.toThrow()
        yard.store.updateTask(task.id, { currentTurnId: "turn_example" })
        expect((await call({ runner: "ssh", confirm: true }, true)).status).toBe(400)
        yard.store.updateTask(task.id, { currentTurnId: null })
        // The existing authenticated browser composer remains an explicit human runner selection.
        const message = await fetch(`${base}/api/tasks/${task.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${password}` }, body: JSON.stringify({ content: "Example", runsOn: "ssh" }) })
        expect(message.status).toBe(200)
        expect(yard.store.getTaskRow(task.id)?.runs_on).toBe("ssh")
      } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
    }
  })

  it("rejects MCP create/batch/schedule host overrides atomically, while honoring a trusted human pick", async () => {
    const { yard, project } = fixture()
    vi.spyOn(yard.tasks, "requireRunner").mockResolvedValue()
    const use = async (trusted: boolean) => {
      const server = buildMcpServer({ store: yard.store, tasks: yard.tasks, hub: yard.hub, artifacts: null as never, publicUrl: () => "", scheduler: yard.scheduler,
        authenticatedHumanPicks: trusted, turnPicks: () => ({ runsOn: { value: "local", label: "This computer", token: "local" }, agent: null }),
      }, { kind: "captain", projectId: project.id })
      const [a, b] = InMemoryTransport.createLinkedPair()
      await server.connect(a)
      const client = new Client({ name: "containment-fixture", version: "0" }); await client.connect(b)
      return { client, server }
    }
    for (const trusted of [false, true]) {
      const { client, server } = await use(trusted)
      try {
        const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args })
        const before = yard.store.listTaskRows().length
        const one = await call("create_task", { project: project.id, title: "Child", prompt: "Example", runs_on: "local" })
        expect(Boolean(one.isError), JSON.stringify(one)).toBe(!trusted)
        const batch = await call("create_tasks", { project: project.id, tasks: [{ title: "One", prompt: "Example" }, { title: "Two", prompt: "Example", runs_on: "ssh" }] })
        expect(Boolean(batch.isError), JSON.stringify(batch)).toBe(!trusted) // the trusted whole-message pick replaces both arguments
        expect(yard.store.listTaskRows()).toHaveLength(before + (trusted ? 3 : 0))
        expect((await call("create_schedule", { name: "Example", prompt: "Example", cron: "@daily", runs_on: "local" })).isError).toBe(true)
      } finally { await client.close(); await server.close() }
    }
  })
})
