import { afterEach, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import type { Project, SettingsInfo } from "../shared/types.js"
import { freePort, testConfig } from "./helpers.js"

// A Captain's icon over HTTP and MCP (docs/captain-icons.md): Settings' captainIcon, a project's captainIcon (PATCH)
// and the Coordinator's update_project captain_icon. Each takes only an id from the catalogue; a Captain can't change it.

let yard: BoxYard | null = null
let server: Server | null = null
let dataDir = ""
let base = ""
const clients: { close(): Promise<void> }[] = []

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  yard?.stop()
  if (server) await new Promise((res) => server!.close(() => res(null)))
  yard = null
  server = null
})

async function start() {
  const port = await freePort()
  const config = testConfig({ port })
  dataDir = config.dataDir
  yard = createBoxYard(config, { webDir: "/nonexistent" })
  server = await new Promise<Server>((resolve) => {
    const s = yard!.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  base = `http://127.0.0.1:${port}`
}

async function send(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, data: (await res.json()) as Record<string, unknown> }
}
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { status, data } = await send(method, path, body)
  if (status >= 400) throw new Error(`${method} ${path} -> ${status}: ${JSON.stringify(data)}`)
  return data as T
}

type ToolRes = { content: { text: string }[]; isError?: boolean }
async function mcpAs(caller: McpCaller) {
  const y = yard!
  const deps = { store: y.store, tasks: y.tasks, hub: y.hub, artifacts: null as never, publicUrl: () => "", scheduler: y.scheduler, captains: y.captains, settings: y.settings, notes: y.notes, uploads: new Uploads(uploadsDir(dataDir), 1024 * 1024) }
  const mcp = buildMcpServer(deps, caller)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await mcp.connect(a)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(b)
  clients.push({ close: async () => (await client.close(), await mcp.close()) })
  return async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolRes
}

describe("Captain icon routes", () => {
  it("saves Settings' icon by id, and refuses anything else", async () => {
    await start()
    expect((await call<SettingsInfo>("GET", "/api/agent-settings")).settings.captainIcon).toBe("captain-cap")
    expect((await call<SettingsInfo>("PUT", "/api/agent-settings", { captainIcon: "anchor" })).settings.captainIcon).toBe("anchor")
    const bad = await send("PUT", "/api/agent-settings", { captainIcon: '<svg xmlns="http://www.w3.org/2000/svg"/>' })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.data)).toContain("isn't one of the Captain icons")
    expect((await call<SettingsInfo>("GET", "/api/agent-settings")).settings.captainIcon).toBe("anchor")
  })

  it("saves a project's pick with PATCH, null for Use default, and refuses anything else", async () => {
    await start()
    const p = await call<Project>("POST", "/api/projects", { name: "demo" })
    expect(p.captainIcon).toBeNull()
    expect((await call<Project>("PATCH", `/api/projects/${p.id}`, { captainIcon: "crown" })).captainIcon).toBe("crown")
    expect((await call<Project[]>("GET", "/api/projects")).find((x) => x.id === p.id)!.captainIcon).toBe("crown")
    // Another change leaves it be.
    expect((await call<Project>("PATCH", `/api/projects/${p.id}`, { description: "x" })).captainIcon).toBe("crown")

    for (const captainIcon of ["not-an-icon", "<svg/>", 3]) {
      const bad = await send("PATCH", `/api/projects/${p.id}`, { captainIcon })
      expect(bad.status, String(captainIcon)).toBe(400)
    }
    expect(yard!.store.getProject(p.id)!.captainIcon).toBe("crown")
    expect((await call<Project>("PATCH", `/api/projects/${p.id}`, { captainIcon: null })).captainIcon).toBeNull()
  })

  it("lets the Coordinator set it with update_project, and not a Captain", async () => {
    await start()
    const p = yard!.store.createProject({ name: "demo" })
    const coordinator = await mcpAs({ kind: "coordinator" })
    expect((await coordinator("update_project", { project: "demo", captain_icon: "helm" })).isError).not.toBe(true)
    expect(yard!.store.getProject(p.id)!.captainIcon).toBe("helm")
    const bad = await coordinator("update_project", { project: "demo", captain_icon: "<svg/>" })
    expect(bad.isError).toBe(true)
    expect(bad.content[0]!.text).toContain("isn't one of the Captain icons")
    expect(yard!.store.getProject(p.id)!.captainIcon).toBe("helm")
    expect((await coordinator("update_project", { project: "demo", captain_icon: null })).isError).not.toBe(true)
    expect(yard!.store.getProject(p.id)!.captainIcon).toBeNull()

    // A Captain's update_project is its box settings only: captain_icon isn't one of its fields.
    const captain = await mcpAs({ kind: "captain", projectId: p.id })
    await captain("update_project", { captain_icon: "crown" })
    expect(yard!.store.getProject(p.id)!.captainIcon).toBeNull()
  })
})
