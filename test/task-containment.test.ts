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
import { Scheduler } from "../server/scheduler.js"
import type { Task } from "../shared/types.js"

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

  it("keeps task-derived hook work isolated when project defaults change, including recursive hooks", () => {
    const { yard, task, project } = fixture()
    const marker = "fixture-worker-controlled-instructions"
    yard.store.updateProject(project.id, { runner: "local" })
    const hook = yard.hooks.create({ name: "Review output", projectId: project.id, trigger: "task.failed", action: "create_task", taskTitle: "Review {task_title}", prompt: "Review: {summary}", enabled: true, allowSelfTrigger: true, createdBy: "Example operator" })
    const fire = (id: string) => {
      yard.store.updateTask(id, { status: "failed", summary: marker })
      return yard.hooks.handle({ type: "task.failed", taskId: id, turnId: null, originHookIds: [], sawPr: false }).find(r => r.hookId === hook.id)!
    }
    const first = fire(task.id)
    expect(first.status).toBe("fired")
    const created = yard.store.getTask(first.targetTaskId!)!
    expect(created.prompt).toContain(marker)
    expect(created.runsOn).toBe("docker")
    expect(created.parentTaskId).toBeNull()
    expect(() => yard.tasks.setRunsOn(created.id, "local")).toThrow(/containment/)
    const second = fire(created.id)
    expect(second.status).toBe("fired")
    expect(yard.store.getTask(second.targetTaskId!)?.runsOn).toBe("docker")
    expect(() => yard.tasks.setRunsOn(second.targetTaskId!, "ssh")).toThrow(/containment/)
  })

  it("refuses task-derived hook work when its only remaining placement would exceed the saved ceiling", () => {
    const { yard, task, project } = fixture()
    yard.store.updateProject(project.id, { runner: "ssh" })
    yard.store.updateTask(task.id, { runsOn: null, boxId: null, status: "failed" })
    yard.hooks.create({ name: "Review output", projectId: project.id, trigger: "task.failed", action: "create_task", taskTitle: "Review output", prompt: "Review: {summary}", enabled: true, createdBy: "Example operator" })
    const before = yard.store.listTaskRows().length
    const [run] = yard.hooks.handle({ type: "task.failed", taskId: task.id, turnId: null, originHookIds: [], sawPr: false })
    expect(run).toMatchObject({ status: "failed", targetTaskId: null })
    expect(run?.result).toMatch(/containment/)
    expect(yard.store.listTaskRows()).toHaveLength(before)
  })

  it("withholds previous worker titles and summaries from host schedule runs, including timed and catch-up dispatch", async () => {
    for (const runner of ["local", "ssh"] as const) for (const mode of ["manual", "timed", "catch-up"] as const) {
      const { yard, project, config } = fixture()
      const clock = { now: Date.parse("2026-11-01T08:30:00Z") }
      const scheduler = new Scheduler({ config, store: yard.store, tasks: yard.tasks, hub: yard.hub, now: () => clock.now })
      const schedule = await scheduler.create({ projectId: project.id, name: "Example check", cron: "0 * * * *", timezone: "UTC", prompt: "Run the configured check" })
      const previous = scheduler.runNow(schedule.id) as Task
      const marker = "fixture-worker-controlled-host-command"
      yard.store.updateTask(previous.id, { status: "idle", title: marker, summary: marker })
      yard.store.updateProject(project.id, { runner })
      if (mode === "manual") scheduler.runNow(schedule.id)
      else {
        clock.now = schedule.nextRunAt! + (mode === "catch-up" ? 3 * 60 * 60_000 : 1000)
        scheduler.tick()
      }
      const next = yard.store.listTasks({ projectId: project.id }).find(t => t.scheduleId === schedule.id && t.id !== previous.id)!
      expect(next, mode).toBeDefined()
      expect(next.runsOn).toBe(runner)
      expect(next.prompt).not.toContain(marker)
      expect(next.prompt).toContain("text is withheld across the host authority boundary")
      expect(next.prompt).toContain("Run the configured check")
      scheduler.stop()
    }
  })

  it("preserves previous schedule output within the same execution authority", async () => {
    for (const runner of ["docker", "local", "ssh"] as const) {
      const { yard, project } = fixture()
      const schedule = await yard.scheduler.create({ projectId: project.id, runsOn: runner, name: "Example check", cron: "@daily", prompt: "Run the check" })
      const previous = yard.scheduler.runNow(schedule.id) as Task
      yard.store.updateTask(previous.id, { status: "idle", summary: "Ordinary previous result" })
      const next = yard.scheduler.runNow(schedule.id) as Task
      expect(next.prompt).toContain("Ordinary previous result")
      expect(next.runsOn).toBe(runner)
    }
  })

  it("refuses isolated worker messages to local/SSH recipients, including FYI, title refs and nested children", async () => {
    const { yard, task, project } = fixture()
    const child = yard.tasks.createTask({ projectId: project.id, title: "Child", prompt: "Example", runsOn: "docker", subtask: { parentId: task.id, rootId: task.id, depth: 1, withParent: false } })
    for (const runner of ["local", "ssh"] as const) {
      const host = yard.tasks.createTask({ projectId: project.id, title: `Host ${runner}`, prompt: "Example", runsOn: runner })
      yard.store.updateTask(host.id, { status: "idle" })
      const before = yard.store.listTaskMessages(host.id, 100)
      for (const from of [task, child]) for (const to of [host.id, host.title]) for (const fyi of [false, true]) {
        await yard.tasks.apply(from.id, { t: "message_agent", seq: 1, ts: 1, turnId: null, to, message: "Fixture: run an unauthorized host action", expectReply: !fyi, fyi, source: "cody", approved: true })
      }
      expect(yard.store.peekInputs(host.id)).toEqual([])
      expect(yard.store.listTaskMessages(host.id, 100)).toEqual(before)
      expect(yard.store.getTask(host.id)?.status).toBe("idle")
      expect(() => yard.tasks.requireIsolatedTask(host.id)).toThrow(/Manager authority/)
    }
    await yard.tasks.apply(task.id, { t: "message_agent", seq: 1, ts: 1, turnId: null, to: child.id, message: "Ordinary contained collaboration" })
    expect(yard.store.peekInputs(child.id)[0]?.content).toContain("Ordinary contained collaboration")
  })

  it("withholds isolated child report bodies from host parent queues, history and wait files", async () => {
    const { yard, project, provider } = fixture()
    const parent = yard.tasks.createTask({ projectId: project.id, title: "Host parent", prompt: "Example", runsOn: "local" })
    yard.store.updateTask(parent.id, { status: "idle", boxId: LOCAL_BOX_ID })
    const child = yard.tasks.createTask({ projectId: project.id, title: "fixture-untrusted-child-title", prompt: "Example", runsOn: "docker", subtask: { parentId: parent.id, rootId: parent.id, depth: 1, withParent: false } })
    const internals = yard.tasks as unknown as { reportToParent(row: unknown, status: string, text: string, question: string): void; writeSubtasksFile(id: string): Promise<void> }
    const before = yard.store.listTaskMessages(parent.id, 100)
    const marker = "fixture-untrusted-report-command"
    internals.reportToParent(yard.store.getTaskRow(child.id), "needs_input", marker, marker)
    await internals.writeSubtasksFile(parent.id)
    expect(yard.store.peekInputs(parent.id)).toEqual([])
    expect(yard.store.listTaskMessages(parent.id, 100)).toEqual(before)
    expect(yard.store.getTask(parent.id)?.status).toBe("idle")
    expect(provider.writeFile).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining("subtasks.json"), expect.not.stringContaining(marker))
    expect(provider.writeFile).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.not.stringContaining(child.title))
    // A report saved before a later human elevation is checked again at delivery, not trusted from storage.
    yard.store.setKv(`subtask_report:${child.id}`, JSON.stringify({ status: "idle", text: marker, at: 1, inputId: "old" }))
    await internals.writeSubtasksFile(parent.id)
    expect(provider.writeFile).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.not.stringContaining(marker))
  })

  it("rechecks queued worker messages at steer and launch after human elevation, including recovered claims", async () => {
    for (const mode of ["steer", "launch"] as const) for (const runner of ["local", "ssh"] as const) {
      const { yard, task, project, provider, config } = fixture()
      const child = yard.tasks.createTask({ projectId: project.id, title: "Contained sender", prompt: "Example", runsOn: "docker" })
      const marker = "fixture-delayed-worker-command"
      await yard.tasks.apply(child.id, { t: "message_agent", seq: 1, ts: 1, turnId: null, to: task.id, message: marker })
      expect(yard.store.peekInputs(task.id)[0]?.content).toContain(marker)
      // A pending legacy/recovered message must not copy any attachment either. Unknown senders fail closed.
      yard.store.queueInput(task.id, "agent:task_missing000", marker, ["fixture-withheld-file"])
      yard.store.queueInput(task.id, "cody", "fixture-human-message")
      if (mode === "launch") yard.store.claimSteer(task.id, "steer:turn_previous")
      yard.tasks.elevateRunner(task.id, runner)
      yard.tasks.setRunsOn(task.id, runner)
      const box = runner === "local" ? LOCAL_BOX_ID : "ssh-example"
      vi.spyOn(yard.tasks, "taskDir").mockImplementation((_box, id) => path.join(config.dataDir, "fixture-tasks", id))
      yard.store.updateTask(task.id, { boxId: box, status: mode === "steer" ? "working" : "starting", currentTurnId: "turn_example", agentCli: "codex" })
      if (mode === "steer") {
        const result = await yard.tasks.steerQueued(task.id, { by: "captain" })
        expect(result.delivery, result.note).toBe("steering")
        const call = vi.mocked(provider.writeFile).mock.calls.find(c => c[1].includes("/steer-"))!
        expect(call).toBeDefined()
        expect(call[2]).not.toContain(marker)
        expect(call[2]).not.toContain("fixture-withheld-file")
        expect(call[2]).toContain("withheld across the host authority boundary")
        expect(call[2]).toContain("fixture-human-message")
      } else {
        vi.spyOn(provider, "wake").mockResolvedValue()
        vi.spyOn(provider, "exec").mockResolvedValue({ exitCode: 0, stdout: "present", stderr: "" })
        vi.spyOn(provider, "health").mockResolvedValue("running")
        // Stop before agent installation/credentials. This observes the real launch's claimed delivery payload.
        const delivery = vi.spyOn(yard.tasks, "deliverAttachments").mockRejectedValue(new Error("fixture stopped before agent installation"))
        await (yard.tasks as unknown as { launch(id: string, box: string, turn: string): Promise<void> }).launch(task.id, box, "turn_example")
        expect(delivery).toHaveBeenCalledOnce()
        const inputs = delivery.mock.calls[0]![2]
        expect(JSON.stringify(inputs)).not.toContain(marker)
        expect(inputs.every(i => i.attachments.length === 0)).toBe(true)
        expect(inputs.some(i => i.content === "fixture-human-message")).toBe(true)
      }
    }
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
