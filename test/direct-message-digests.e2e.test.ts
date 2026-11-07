import { afterEach, describe, expect, it, vi } from "vitest"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { freePort, testConfig } from "./helpers.js"

const running: { yard: BoxYard; server: Server }[] = []
const clients: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const r of running.splice(0)) {
    await vi.waitFor(() => expect(r.yard.orchestrator.busy).toBe(false))
    r.yard.stop()
    await new Promise<void>((resolve) => r.server.close(() => resolve()))
  }
  vi.restoreAllMocks()
})

async function start() {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port, orchestratorAutoWake: true }), { webDir: "/nonexistent" })
  // Real HTTP/MCP/queue paths, with recipients held idle and only the Coordinator's model subprocess replaced.
  yard.tasks.stop()
  const project = yard.store.createProject({ name: "demo" })
  yard.captains.get(project.id).stop()
  const task = yard.store.createTask({ projectId: project.id, title: "Ship it", prompt: "Build it" })
  const prompts: string[] = []
  vi.spyOn(yard.orchestrator as unknown as { runPrompt(prompt: string): Promise<{ ok: boolean; error: string }> }, "runPrompt")
    .mockImplementation(async (prompt) => {
      prompts.push(prompt)
      return { ok: true, error: "" }
    })
  yard.orchestrator.tuning.wakeDebounceMs = 1
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  running.push({ yard, server })
  async function post(path: string, body: object) {
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })
    const data = await response.json()
    expect(response.ok, JSON.stringify(data)).toBe(true)
    return data
  }
  async function tool(caller: McpCaller) {
    const mcp = buildMcpServer({
      store: yard.store, tasks: yard.tasks, hub: yard.hub, publicUrl: () => "", captains: yard.captains,
      scheduler: yard.scheduler, settings: yard.settings, identities: yard.identities,
      artifacts: null as never, uploads: null as never,
    }, caller)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await mcp.connect(a)
    const client = new Client({ name: "test", version: "0" })
    await client.connect(b)
    clients.push({ close: async () => { await client.close(); await mcp.close() } })
    return async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args })
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    }
  }
  return { yard, project, task, prompts, post, tool }
}

describe("human direct-message entry points", () => {
  it("collects task composer, task card, Captain chat and forwarded human messages for the next Coordinator turn", async () => {
    const r = await start()
    const taskPath = `/tasks/${r.task.id}`
    await r.post(`${taskPath}/messages`, { content: "From the task composer" })
    const latest = "Cody says " + "x".repeat(300) + "EXCLUDED-TAIL"
    await r.post(`${taskPath}/messages`, { content: latest, inChat: true })
    await r.post(`/projects/${r.project.id}/captain/messages`, { id: "cap_human001", content: "From the Captain chat" })
    await r.post(`${taskPath}/captain`, { content: "Split this task, Cody says" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(r.yard.orchestrator.busy).toBe(false)
    expect(r.prompts).toEqual([])
    expect(r.yard.tasks.listQueue(r.task.id).map((m) => m.text)).toEqual(["From the task composer", latest])
    expect(r.yard.captains.messages(r.project.id).map((m) => m.content)).toEqual(["From the Captain chat", "Split this task, Cody says"])

    await r.post("/chat", { id: "chat_natural001", content: "Status please" })
    await vi.waitFor(() => expect(r.yard.orchestrator.busy).toBe(false))
    expect(r.prompts).toHaveLength(1)
    expect(r.prompts[0]).toContain(`Cody told "Ship it" (${r.task.id}) (2 messages; latest): Cody says `)
    expect(r.prompts[0]).toContain("Cody told the demo Captain (2 messages; latest): Split this task, Cody says")
    expect(r.prompts[0]).not.toContain("EXCLUDED-TAIL")
    expect(r.prompts[0]).not.toContain("From the Captain chat")
    expect(r.prompts[0]).not.toContain("From the task composer")
  })

  it("excludes Coordinator, Captain, hook, agent, retry and other internal sends regardless of their default source", async () => {
    const r = await start()
    const coordinator = await r.tool({ kind: "coordinator" })
    const captain = await r.tool({ kind: "captain", projectId: r.project.id })
    await coordinator("send_to_task", { task: r.task.id, message: "Coordinator message" })
    await captain("send_to_task", { task: r.task.id, message: "Captain message" })
    await coordinator("send_to_captain", { project: r.project.id, message: "Coordinator to Captain" })
    r.yard.tasks.sendInput(r.task.id, "Agent message", `agent:${r.task.id}`)
    r.yard.tasks.sendInput(r.task.id, "Hook message", "hook:hook_fixture")
    r.yard.tasks.sendInput(r.task.id, "Internal default-source send")
    r.yard.tasks.retryTask(r.task.id)
    r.yard.captains.fromAgent(r.project.id, { taskId: r.task.id, taskTitle: r.task.title, message: "Agent to Captain", agentMessageId: "agent_fixture", waitSeconds: 0 })
    r.yard.captains.send(r.project.id, "Hook to Captain", { source: "hook" })
    expect(r.yard.db.prepare("SELECT * FROM coordinator_direct_messages").all()).toEqual([])

    await r.post("/chat", { id: "chat_natural002", content: "Hello" })
    await vi.waitFor(() => expect(r.yard.orchestrator.busy).toBe(false))
    expect(r.prompts).toHaveLength(1)
    expect(r.prompts[0]).not.toContain("Cody told")
    expect(r.prompts[0]).not.toContain("Cody messaged")
  })

  it("enforces actual identity changes between enqueue and delivery and never stores sealed snippets", async () => {
    const r = await start()
    const identity = r.yard.identities.create({ name: "Private", coordinatorSees: "everything" })
    r.yard.identities.assign(r.project.id, identity.id)
    await r.post(`/tasks/${r.task.id}/messages`, { content: "QUEUED-TASK-SECRET" })
    await r.post(`/projects/${r.project.id}/captain/messages`, { id: "cap_private01", content: "QUEUED-CAPTAIN-SECRET" })
    r.yard.identities.update(identity.id, { coordinatorSees: "status" })
    await r.post("/chat", { id: "chat_private01", content: "Hi" })
    await vi.waitFor(() => expect(r.yard.orchestrator.busy).toBe(false))
    expect(r.prompts[0]).toContain(`Cody messaged "Ship it" (${r.task.id})`)
    expect(r.prompts[0]).toContain("Cody messaged the demo Captain")
    expect(r.prompts[0]).not.toContain("SECRET")

    await r.post(`/tasks/${r.task.id}/messages`, { content: "SEALED-TASK-SECRET" })
    await r.post(`/projects/${r.project.id}/captain/messages`, { id: "cap_private02", content: "SEALED-CAPTAIN-SECRET" })
    expect(r.yard.db.prepare("SELECT snippet FROM coordinator_direct_messages").all()).toEqual([{ snippet: null }, { snippet: null }])
    // The owner can loosen privacy; content that was sealed on arrival still stays out of the queue.
    r.yard.identities.update(identity.id, { coordinatorSees: "everything" })
    await r.post("/chat", { id: "chat_private02", content: "Thanks" })
    await vi.waitFor(() => expect(r.yard.orchestrator.busy).toBe(false))
    expect(r.prompts[1]).not.toContain("SECRET")
  })
})
