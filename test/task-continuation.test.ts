import { afterEach, describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { harnessHandoffKey } from "../shared/taskContinuation.js"
import type { TaskStatus } from "../shared/types.js"
import { freePort, testConfig } from "./helpers.js"

const yards: BoxYard[] = []
const closes: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of closes.splice(0)) await close()
  for (const y of yards.splice(0)) y.stop()
})
function setup(status: TaskStatus = "failed") {
  const y = createBoxYard(testConfig(), { webDir: "/nonexistent" })
  yards.push(y)
  y.tasks.stop() // Seeded resting tasks only; no worker is launched by these contract checks.
  const project = y.store.createProject({ name: "example-project", agentCli: "claude" })
  const task = y.store.createTask({ projectId: project.id, title: "Continue feature", prompt: "PRIVATE-PROMPT", agentCli: "claude", model: "claude-opus-5-5", effort: "max" })
  y.store.updateTask(task.id, { status, turnCount: 2, sessionStarted: true, branch: "feature-example", prUrl: "https://github.com/acme/example/pull/12", archivePath: "/example/archive.tgz", summary: "PRIVATE-SUMMARY", error: "PRIVATE-ERROR", routingRule: "old-rule", routingReason: "PRIVATE-ROUTE", contextWindow: 1_000_000, contextTokens: 900_000 })
  return { y, project, task: y.store.getTask(task.id)! }
}
async function mcp(y: BoxYard, caller: McpCaller) {
  const server = buildMcpServer({ store: y.store, tasks: y.tasks, hub: y.hub, artifacts: null as never, uploads: null as never, publicUrl: () => "", settings: y.settings, identities: y.identities }, caller)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: "continuation-test", version: "0" })
  await client.connect(b)
  closes.push(async () => { await client.close(); await server.close() })
  return (args: Record<string, unknown>) => client.callTool({ name: "continue_task", arguments: args })
}

describe("same-task harness continuation", () => {
  it("changes only this task's harness/session/pins and preserves identity, archive, PR and queued inputs", async () => {
    const { y, task } = setup()
    const queued = y.store.queueInput(task.id, "cody", "Already queued", ["up_example"])
    const before = y.store.getTaskRow(task.id)!
    const after = await y.tasks.continueTask(task.id, { agent: "codex", message: "Continue the same work" })
    expect(after).toMatchObject({ id: task.id, agentCli: "codex", branch: task.branch, prUrl: task.prUrl, status: "queued", turnCount: 2, model: null, effort: null, routingRule: null, routingReason: null, contextTokens: null, contextWindow: null })
    expect(after.sessionId).not.toBe(task.sessionId)
    const row = y.store.getTaskRow(task.id)!
    for (const key of ["archive_path", "box_id", "runs_on", "push_state_json", "event_cursor", "session_started"] as const) expect(row[key]).toEqual(before[key])
    expect(y.store.listQueuedInputs(task.id)).toMatchObject([{ id: queued, content: "Already queued", attachments: ["up_example"] }, { content: "Continue the same work" }])
    expect(y.store.getKv(harnessHandoffKey(task.id))).toContain('"from":"claude","to":"codex"')
    expect(y.store.listTaskRows()).toHaveLength(1)
  })

  it("can switch a task whose first turn never started without pretending it had a workspace to recover", async () => {
    const { y, task } = setup()
    y.store.updateTask(task.id, { turnCount: 0, sessionStarted: false, archivePath: null, boxId: "example-box" })
    await y.tasks.continueTask(task.id, { agent: "codex" })
    expect(JSON.parse(y.store.getKv(harnessHandoffKey(task.id))!)).toMatchObject({ needsWorkspace: false })
  })

  it("keeps saved choices on ordinary retry/continuation and resolves an explicit default once", async () => {
    const { y, project, task } = setup()
    y.settings.update({ agentCli: "codex" })
    expect(y.store.getTask(task.id)?.agentCli).toBe("claude")
    await y.tasks.continueTask(task.id)
    expect(y.store.getTask(task.id)).toMatchObject({ agentCli: "claude", sessionId: task.sessionId, model: task.model, effort: task.effort })
    y.store.updateTask(task.id, { status: "failed" })
    y.tasks.retryTask(task.id)
    expect(y.store.getTask(task.id)?.agentCli).toBe("claude")
    y.store.updateTask(task.id, { status: "failed" })
    // A project override wins over Settings. Explicit default resets pins even if it selects the same CLI.
    await y.tasks.continueTask(task.id, { agent: "default" })
    expect(y.store.getTask(task.id)).toMatchObject({ agentCli: "claude", model: null, effort: null, sessionId: task.sessionId })
    y.store.updateProject(project.id, { agentCli: null })
    y.store.updateTask(task.id, { status: "idle" })
    await y.tasks.continueTask(task.id, { agent: "default" })
    y.settings.update({ agentCli: "cursor" })
    expect(y.store.getTask(task.id)?.agentCli).toBe("codex")
  })

  it.each(["starting", "working", "queued", "waiting", "needs_input", "done"] as TaskStatus[])("refuses %s without changing anything", async (status) => {
    const { y, task } = setup(status)
    const before = y.store.getTaskRow(task.id)
    await expect(y.tasks.continueTask(task.id, { agent: "codex" })).rejects.toThrow(/Wait for the task/)
    expect(y.store.getTaskRow(task.id)).toEqual(before)
    expect(y.store.listQueuedInputs(task.id)).toEqual([])
  })

  it("refuses an active turn even if its status says failed, and refuses workspace saving", async () => {
    const { y, task } = setup()
    y.store.updateTask(task.id, { currentTurnId: "turn_example" })
    await expect(y.tasks.continueTask(task.id, { agent: "codex" })).rejects.toThrow(/Wait/)
    y.store.updateTask(task.id, { currentTurnId: null })
    const archiving = (y.tasks as unknown as { archiving: Set<string> }).archiving
    archiving.add(task.id)
    await expect(y.tasks.continueTask(task.id, { agent: "codex" })).rejects.toThrow(/workspace operations/)
    archiving.delete(task.id)
  })

  it("checks the selected harness on the same runner, rechecks busy state, and leaves failures untouched", async () => {
    const { y, task } = setup()
    y.store.updateTask(task.id, { runsOn: "ssh", machineLabel: "example-label" })
    const check = vi.spyOn(y.tasks, "requireRunner").mockRejectedValueOnce(new Error("Codex login unavailable"))
    await expect(y.tasks.continueTask(task.id, { agent: "codex" })).rejects.toThrow(/login unavailable/)
    expect(check).toHaveBeenCalledWith("ssh", task.projectId, {}, expect.objectContaining({ agentCli: "codex", machineLabel: "example-label" }))
    expect(y.store.getTask(task.id)).toMatchObject({ agentCli: "claude", status: "failed", sessionId: task.sessionId })
    check.mockImplementationOnce(async () => { y.store.updateTask(task.id, { status: "working", currentTurnId: "turn_example" }) })
    await expect(y.tasks.continueTask(task.id, { agent: "codex" })).rejects.toThrow(/Wait/)
    expect(y.store.getTask(task.id)?.agentCli).toBe("claude")
  })

  it("rejects incompatible explicit choices and accepts Codex pins including ultra", async () => {
    const { y, task } = setup()
    for (const options of [{ agent: "codex" as const, model: "claude-opus-5-5" }, { agent: "claude" as const, model: "gpt-6.1-sol" }, { agent: "codex" as const, model: "composer-2.5" }, { agent: "claude" as const, effort: "ultra" as const }, { agent: "cursor" as const, effort: "high" as const }, { agent: "cursor" as const, model: "opus" }]) {
      await expect(y.tasks.continueTask(task.id, options)).rejects.toThrow()
    }
    expect(y.store.listQueuedInputs(task.id)).toEqual([])
    await y.tasks.continueTask(task.id, { agent: "codex", model: "gpt-6.1-terra", effort: "ultra" })
    expect(y.store.getTask(task.id)).toMatchObject({ model: "gpt-6.1-terra", effort: "ultra", routingRule: null })
  })

  it("rolls back the harness and handoff if queuing the continuation fails", async () => {
    const { y, task } = setup()
    const before = y.store.getTaskRow(task.id)
    vi.spyOn(y.store, "queueInput").mockImplementation(() => { throw new Error("queue write failed") })
    await expect(y.tasks.continueTask(task.id, { agent: "codex" })).rejects.toThrow(/queue write failed/)
    expect(y.store.getTaskRow(task.id)).toEqual(before)
    expect(y.store.getKv(harnessHandoffKey(task.id))).toBeNull()
  })

  it("validates the REST continuation body and reports busy conflicts without changing the runner", async () => {
    const { y, task } = setup()
    const port = await freePort()
    const server = await new Promise<ReturnType<typeof y.app.listen>>((resolve) => {
      const listening = y.app.listen(port, "127.0.0.1", () => resolve(listening))
    })
    closes.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}/continue`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    expect((await post({ agent: "codex", runsOn: "local" })).status).toBe(400)
    expect((await post({ agent: "unknown" })).status).toBe(400)
    const res = await post({ agent: "codex", message: "Continue same work", model: "gpt-6.1-sol" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: task.id, agentCli: "codex", model: "gpt-6.1-sol", status: "queued" })
    const before = y.store.getTaskRow(task.id)
    expect((await post({ agent: "claude" })).status).toBe(409)
    expect(y.store.getTaskRow(task.id)).toEqual(before)
  })

  it("scopes Captains and seals status-only replies for the Coordinator", async () => {
    const { y, project, task } = setup()
    const other = y.store.createProject({ name: "example-other" })
    const captain = await mcp(y, { kind: "captain", projectId: other.id })
    expect(JSON.stringify(await captain({ task: task.id, agent: "codex" }))).toContain("Out of scope")
    expect(y.store.getTask(task.id)?.agentCli).toBe("claude")
    const identity = y.identities.create({ name: "Example restricted", coordinatorSees: "status" })
    y.identities.assign(project.id, identity.id)
    const coordinator = await mcp(y, { kind: "coordinator" })
    const reply = await coordinator({ task: task.id, agent: "codex" })
    expect(reply.isError).not.toBe(true)
    expect(JSON.stringify(reply)).not.toMatch(/PRIVATE-/)
    expect(y.store.getTask(task.id)?.agentCli).toBe("codex")
  })
})
