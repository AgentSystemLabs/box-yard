import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { testConfig } from "./helpers.js"

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function setup() {
  const yard = createBoxYard(testConfig(), { webDir: "/nonexistent" })
  yard.tasks.stop()
  cleanups.push(() => yard.stop())
  const alpha = yard.store.createProject({ name: "alpha", runner: "box" })
  const beta = yard.store.createProject({ name: "beta", runner: "box" })
  return { yard, alpha, beta }
}

async function clientFor(yard: BoxYard, caller: McpCaller) {
  const server = buildMcpServer({ store: yard.store, tasks: yard.tasks, hub: yard.hub, artifacts: null as never, publicUrl: () => "", scheduler: yard.scheduler }, caller)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: "schedule-test", version: "0" })
  await client.connect(b)
  cleanups.push(async () => { await client.close(); await server.close() })
  return async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean }
    const text = result.content.map((c) => c.text).join("\n")
    return { error: Boolean(result.isError), text, json: () => JSON.parse(text) }
  }
}

describe("per-schedule runner through MCP and REST", () => {
  it("requires a human-selected host project for Captain host schedules, preserving scope and identity restrictions", async () => {
    const { yard, alpha, beta } = setup()
    const use = await clientFor(yard, { kind: "captain", projectId: alpha.id })
    const input = { name: "Nightly slow tests", cron: "0 2 * * *", timezone: "America/Chicago", prompt: "test:slow", runs_on: "local" }
    expect((await use("create_schedule", input)).text).toMatch(/containment/)
    expect(yard.store.listSchedules()).toHaveLength(0)
    yard.store.updateProject(alpha.id, { runner: "local" })
    const created = await use("create_schedule", input)
    expect(created.error, created.text).toBe(false)
    expect(created.json()).toMatchObject({ project: "alpha", runs_on: "local", timezone: "America/Chicago" })
    const id = created.json().id
    expect(yard.store.getSchedule(id)?.runsOn).toBe("local")
    const run = yard.scheduler.runNow(id)
    expect(yard.store.taskRunner(yard.store.getTaskRow(run.id)!)).toBe("local")
    expect((await use("list_schedules", {})).json()[0].runs_on).toBe("local")
    expect((await use("update_schedule", { schedule: id, prompt: "changed" })).json().runs_on).toBe("local")
    expect((await use("update_schedule", { schedule: id, runs_on: null })).json().runs_on).toBeNull()
    expect(yard.store.projectRunner(alpha.id)).toBe("local")

    const other = await yard.scheduler.create({ projectId: beta.id, name: "Other", cron: "@daily", prompt: "keep" })
    expect((await use("create_schedule", { ...input, project: "beta" })).text).toMatch(/^Out of scope/)
    expect((await use("update_schedule", { schedule: other.id, runs_on: "local" })).text).toMatch(/^Out of scope/)
    expect(yard.store.getSchedule(other.id)?.runsOn).toBeNull()
    expect((await use("create_schedule", { ...input, target: "orchestrator" })).text).toMatch(/^Out of scope/)

    const restricted = yard.identities.create({ name: "Boxes only", runners: ["box"] })
    yard.identities.assign(alpha.id, restricted.id)
    await yard.scheduler.update(id, { runsOn: "local" })
    expect(() => yard.scheduler.runNow(id)).toThrow(/Boxes only/)
    expect(yard.store.listTasks({ projectId: alpha.id })).toHaveLength(1)
  })

  it("validates the REST field and rejects overrides on Coordinator schedules", async () => {
    const { yard, alpha } = setup()
    const server = await new Promise<Server>((resolve) => {
      const listening = yard.app.listen(0, "127.0.0.1", () => resolve(listening))
    })
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
    const address = server.address() as { port: number }
    const call = (method: string, route: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}/api/schedules${route}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    const input = { projectId: alpha.id, name: "Nightly", cron: "0 2 * * *", timezone: "America/Chicago", prompt: "test:slow", runsOn: "local" }
    const created = await call("POST", "", input)
    expect(created.status).toBe(201)
    const schedule = await created.json()
    expect(schedule.runsOn).toBe("local")
    expect((await (await call("PATCH", `/${schedule.id}`, { runsOn: null })).json()).runsOn).toBeNull()
    expect((await call("POST", "", { ...input, runsOn: "typo" })).status).toBe(400)
    expect((await call("POST", "", { ...input, projectId: undefined, target: "orchestrator" })).status).toBe(400)
    const use = await clientFor(yard, { kind: "coordinator" })
    const rejected = await use("create_schedule", { name: "Digest", cron: "@daily", prompt: "x", runs_on: "local" })
    expect(rejected.error).toBe(true)
    expect(rejected.text).toMatch(/Only project schedules/)
  })
})
