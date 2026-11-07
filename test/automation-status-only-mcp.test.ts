import { afterEach, describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { HookStore } from "../server/hookStore.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { testConfig } from "./helpers.js"

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const PRIVATE = ["SEALED-PROMPT", "SEALED-TITLE-TEMPLATE", "SEALED-FILTER", "SEALED-RESULT", "SEALED-ERROR", "SEALED-SUMMARY", "SEALED-QUESTION"]

async function clientFor(yard: BoxYard, caller: McpCaller) {
  const server = buildMcpServer({
    store: yard.store, tasks: yard.tasks, hub: yard.hub, artifacts: null as never,
    uploads: null as never, publicUrl: () => "", scheduler: yard.scheduler,
    hooks: yard.hooks, identities: yard.identities,
  }, caller)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: "automation-privacy-test", version: "0" })
  await client.connect(b)
  cleanups.push(async () => { await client.close(); await server.close() })
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean }
    const text = res.content.map((c) => c.text).join("\n")
    return { error: Boolean(res.isError), text, json: () => JSON.parse(text) }
  }
}

async function setup() {
  const yard = createBoxYard(testConfig(), { webDir: "/nonexistent" })
  yard.tasks.stop()
  cleanups.push(() => yard.stop())
  const secret = yard.store.createProject({ name: "secret" })
  const open = yard.store.createProject({ name: "open" })
  const identity = yard.identities.create({ name: "Private", coordinatorSees: "status" })
  yard.identities.assign(secret.id, identity.id)
  const hooks = new HookStore(yard.store.db)
  const seed = async (projectId: string, prefix: string) => {
    const schedule = await yard.scheduler.create({ projectId, name: `${prefix} schedule`, cron: "@daily", prompt: `${prefix}-PROMPT`, enabled: false })
    yard.store.updateSchedule(schedule.id, { lastSkipReason: `${prefix}-ERROR` })
    const task = yard.store.createTask({ projectId, title: `${prefix} task`, prompt: `${prefix}-PROMPT`, scheduleId: schedule.id })
    yard.store.updateTask(task.id, { status: "failed", error: `${prefix}-ERROR`, summary: `${prefix}-SUMMARY`, question: `${prefix}-QUESTION` }, { quiet: true })
    const hook = yard.hooks.create({
      projectId, name: `${prefix} hook`, trigger: "task.finished", action: "create_task",
      prompt: `${prefix}-PROMPT`, taskTitle: `${prefix}-TITLE-TEMPLATE`,
      filters: { promptRegex: `${prefix}-FILTER` }, enabled: false, createdBy: "test owner",
    })
    const run = hooks.addRun({
      hookId: hook.id, hookName: hook.name, hookProjectId: projectId, projectId,
      taskId: task.id, taskTitle: task.title, event: "task.finished", headSha: null,
      action: hook.action, prompt: `${prefix}-PROMPT`, status: "failed",
      result: `${prefix}-RESULT ${prefix}-ERROR`, targetTaskId: null, fireKey: "test-turn",
    })
    return { schedule, task, hook, run }
  }
  const hidden = await seed(secret.id, "SEALED")
  const visible = await seed(open.id, "OPEN")
  const global = yard.hooks.create({ name: "Global hook", projectId: null, trigger: "task.finished", action: "send_to_task", prompt: "GLOBAL-PROMPT", enabled: false, createdBy: "the Coordinator" })
  // A global hook's most recent result belongs to the task's project, not the hook's scope.
  hooks.addRun({ ...hidden.run, hookId: global.id, hookName: global.name, hookProjectId: null, fireKey: "global-turn" })
  const coordinator = await clientFor(yard, { kind: "coordinator" })
  const captain = await clientFor(yard, { kind: "captain", projectId: secret.id })
  return { yard, hooks, secret, open, hidden, visible, global, coordinator, captain }
}

function sealed(text: string) {
  for (const word of PRIVATE) expect(text, `Coordinator must not receive ${word}`).not.toContain(word)
}

describe("automation MCP views across a status-only identity", () => {
  it("keeps schedule status visible in all-project lists and enabled-only updates without saved content", async () => {
    const r = await setup()
    for (const args of [{}, { project: "secret" }, { target: "project" }]) {
      const res = await r.coordinator("list_schedules", args)
      expect(res.error).toBe(false)
      expect(res.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: r.hidden.schedule.id, enabled: false })]))
      sealed(res.text)
    }
    const changed = await r.coordinator("update_schedule", { schedule: r.hidden.schedule.id, enabled: false })
    expect(changed.error).toBe(false)
    sealed(changed.text)
    expect(r.yard.store.getSchedule(r.hidden.schedule.id)?.prompt).toBe("SEALED-PROMPT")
    const runs = await r.coordinator("list_schedule_runs", { schedule: r.hidden.schedule.id })
    expect(runs.json()[0]).toMatchObject({ id: r.hidden.task.id, status: "failed" })
    sealed(runs.text)
    // Chat-run error serialization must also respect the schedule's owning project.
    vi.spyOn(r.yard.scheduler, "runs").mockReturnValue([{
      id: "srun_test123", scheduleId: r.hidden.schedule.id, prompt: "SEALED-PROMPT",
      reason: "manual", dueAt: Date.now(), startedAt: null, finishedAt: null,
      status: "failed", error: "SEALED-ERROR", chatMessageId: null, createdAt: Date.now(),
    }])
    sealed((await r.coordinator("list_schedule_runs", { schedule: r.hidden.schedule.id })).text)
  })

  it("keeps hook status visible while sealing templates, filters, last results and failed run details", async () => {
    const r = await setup()
    for (const args of [{}, { project: "secret" }, { project: "global" }]) {
      const res = await r.coordinator("list_hooks", args)
      expect(res.error).toBe(false)
      expect(res.json().length).toBeGreaterThan(0)
      sealed(res.text)
    }
    const changed = await r.coordinator("update_hook", { hook: r.hidden.hook.id, enabled: true })
    expect(changed.error).toBe(false)
    expect(changed.json()).toMatchObject({ id: r.hidden.hook.id, enabled: true })
    sealed(changed.text)
    for (const args of [{}, { project: "secret" }, { hook: r.hidden.hook.id }, { hook: r.global.id }, { task: r.hidden.task.id }]) {
      const res = await r.coordinator("list_hook_runs", args)
      expect(res.error).toBe(false)
      expect(res.json()).toEqual(expect.arrayContaining([expect.objectContaining({ status: "failed" })]))
      sealed(res.text)
    }
    // Historical ownership survives deleted hooks/tasks and missing legacy project ids.
    r.hooks.addRun({ ...r.hidden.run, projectId: null, taskId: null, fireKey: "historical-turn" })
    r.hooks.delete(r.hidden.hook.id)
    sealed((await r.coordinator("list_hook_runs")).text)
    // Legacy rows can rely on their task, and results can describe a different target task.
    r.hooks.addRun({ ...r.hidden.run, hookId: r.global.id, hookProjectId: null, projectId: null, fireKey: "legacy-turn" })
    r.hooks.addRun({ ...r.hidden.run, hookId: r.global.id, hookProjectId: null, projectId: r.open.id,
      taskId: r.visible.task.id, targetTaskId: r.hidden.task.id, fireKey: "target-turn" })
    sealed((await r.coordinator("list_hook_runs")).text)
  })

  it("gates private content mutations and execution before errors or saved fields can escape", async () => {
    const r = await setup()
    const runNow = vi.spyOn(r.yard.scheduler, "runNow").mockImplementation(() => { throw new Error("SEALED-ERROR") })
    const cases: [string, Record<string, unknown>][] = [
      ["create_schedule", { project: "secret", name: "New schedule", cron: "@daily", prompt: "new content" }],
      ["update_schedule", { schedule: r.hidden.schedule.id, prompt: "new content" }],
      ["run_schedule_now", { schedule: r.hidden.schedule.id }],
      ["create_hook", { project: "secret", name: "New hook", trigger: "task.finished", action: "send_to_task", prompt: "new content" }],
      ["create_hook", { project: "secret", template: "pr_merge" }],
      ["update_hook", { hook: r.hidden.hook.id, prompt: "new content" }],
      ["update_hook", { hook: r.hidden.hook.id, task_title: "new template" }],
      ["update_hook", { hook: r.hidden.hook.id, filters: { title_regex: "new pattern" } }],
    ]
    for (const [tool, args] of cases) {
      const res = await r.coordinator(tool, args)
      expect(res.error, tool).toBe(true)
      expect(res.text, tool).toMatch(/^Status only:/)
      sealed(res.text)
    }
    expect(runNow).not.toHaveBeenCalled()
    expect(r.yard.store.getSchedule(r.hidden.schedule.id)?.prompt).toBe("SEALED-PROMPT")
    expect(r.yard.hooks.get(r.hidden.hook.id).prompt).toBe("SEALED-PROMPT")
  })

  it("preserves own-Captain content and scoping, open-project content and Coordinator global automation", async () => {
    const r = await setup()
    expect((await r.captain("list_schedules")).text).toContain("SEALED-PROMPT")
    expect((await r.captain("list_hooks")).text).toContain("SEALED-TITLE-TEMPLATE")
    expect((await r.captain("list_hook_runs")).text).toContain("SEALED-RESULT")
    expect((await r.captain("list_schedule_runs", { schedule: r.hidden.schedule.id })).text).toContain("SEALED-ERROR")
    expect((await r.captain("update_schedule", { schedule: r.hidden.schedule.id, prompt: "Captain prompt" })).json().prompt).toBe("Captain prompt")
    expect((await r.captain("update_hook", { hook: r.hidden.hook.id, enabled: true })).json().filters).toEqual({ promptRegex: "SEALED-FILTER" })
    expect((await r.coordinator("list_schedules")).text).toContain("OPEN-PROMPT")
    expect((await r.coordinator("list_hooks")).text).toContain("OPEN-TITLE-TEMPLATE")
    expect((await r.coordinator("list_hook_runs", { project: "open" })).text).toContain("OPEN-RESULT")
    expect((await r.coordinator("update_schedule", { schedule: r.visible.schedule.id, enabled: false })).json().prompt).toBe("OPEN-PROMPT")
    expect((await r.coordinator("update_hook", { hook: r.global.id, prompt: "Global changed" })).json().prompt).toBe("Global changed")
    const created = await r.coordinator("create_schedule", { name: "Global schedule", cron: "@daily", prompt: "GLOBAL-PROMPT" })
    expect(created.json()).toMatchObject({ target: "orchestrator", prompt: "GLOBAL-PROMPT" })
    const run = await r.coordinator("run_schedule_now", { schedule: created.json().id })
    expect(run.error).toBe(false)
    expect(run.json().status).toBe("queued")
    const ownRun = await r.captain("run_schedule_now", { schedule: r.hidden.schedule.id })
    expect(ownRun.error).toBe(false)
    for (const [tool, args] of [
      ["list_schedules", { project: "open" }], ["list_hooks", { project: "open" }],
      ["update_schedule", { schedule: r.visible.schedule.id, enabled: true }],
      ["update_hook", { hook: r.visible.hook.id, enabled: true }],
      ["list_hook_runs", { hook: r.global.id }],
    ] as [string, Record<string, unknown>][]) {
      expect((await r.captain(tool, args)).text).toMatch(/^Out of scope:/)
    }
  })
})
