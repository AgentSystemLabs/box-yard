// The changes that shortened "ask a Captain → it starts a task → the task answers → the Captain answers"
// (scripts/perf/captain-task-loop.ts measures the loop itself).
import { afterEach, describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { ALWAYS_LOAD, buildMcpServer, settle, type McpCaller } from "../server/mcp.js"
import { claudeTelemetryEnv, serverClaudeEnv } from "../server/turnCredentials.js"
import { testConfig, tmpDir } from "./helpers.js"

const yards: BoxYard[] = []
afterEach(() => yards.splice(0).forEach((y) => y.stop()))

function start() {
  const yard = createBoxYard(testConfig(), { webDir: "/nonexistent" })
  yards.push(yard)
  return yard
}

async function mcp(yard: BoxYard, caller?: McpCaller) {
  const server = buildMcpServer({ store: yard.store, tasks: yard.tasks, hub: yard.hub, artifacts: null as never, scheduler: yard.scheduler, settings: yard.settings, publicUrl: () => "" } as never, caller)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "t", version: "0" })
  await Promise.all([server.connect(a), client.connect(b)])
  return async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text)
}

describe("a task's MCP tools", () => {
  it("keeps the tools a turn ends with out of the CLI's tool search", async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ taskId: "task_1", env: {} }))
    const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../runner/box-runner.mjs"), "mcp", dir], { stdio: ["pipe", "pipe", "inherit"] })
    const reply = new Promise<string>((resolve) => {
      let out = ""
      child.stdout.on("data", (d) => {
        out += d
        if (out.includes("\n")) resolve(out)
      })
    })
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n")
    const tools = JSON.parse((await reply).split("\n")[0]!).result.tools as { name: string; _meta?: Record<string, unknown> }[]
    child.kill()
    const loaded = tools.filter((t) => t._meta?.[ALWAYS_LOAD] === true).map((t) => t.name).sort()
    // Deferred, each costs a model round trip on ToolSearch before its first call; every other tool stays deferred.
    expect(loaded).toEqual(["ask_user", "create_pull_request", "finish"])
    expect(tools.length).toBeGreaterThan(10)
  })
})

describe("settle (wait_for_tasks)", () => {
  function fake(initial: boolean) {
    const fns = new Set<() => void>()
    const state = { busy: initial }
    return {
      state,
      tasks: { onTaskUpdate: (fn: () => void) => (fns.add(fn), () => void fns.delete(fn)) },
      read: () => [{ id: "task_1", busy: state.busy }],
      update(busy: boolean) {
        state.busy = busy
        for (const fn of fns) fn()
      },
      listeners: () => fns.size,
    }
  }

  it("returns in the tick a task it saw busy stops, without waiting for the poll or the grace", async () => {
    const f = fake(true)
    const started = Date.now()
    const done = settle(f.tasks, f.read, Date.now() + 10_000)
    setTimeout(() => f.update(false), 30)
    await done
    expect(Date.now() - started).toBeLessThan(500)
    expect(f.listeners()).toBe(0)
  })

  it("gives a task that hasn't left idle yet the grace, then counts idle as finished", async () => {
    const f = fake(false)
    const started = Date.now()
    await settle(f.tasks, f.read, Date.now() + 10_000, 200)
    expect(Date.now() - started).toBeGreaterThanOrEqual(190)
    expect(Date.now() - started).toBeLessThan(900)
  })

  it("waits for a task that turns busy inside the grace", async () => {
    const f = fake(false)
    const started = Date.now()
    const done = settle(f.tasks, f.read, Date.now() + 10_000, 150)
    setTimeout(() => f.update(true), 20)
    setTimeout(() => f.update(false), 400)
    await done
    expect(Date.now() - started).toBeGreaterThanOrEqual(390)
    expect(Date.now() - started).toBeLessThan(900)
  })

  it("stops at the deadline while a task is still busy", async () => {
    const f = fake(true)
    const started = Date.now()
    await settle(f.tasks, f.read, Date.now() + 120)
    expect(Date.now() - started).toBeGreaterThanOrEqual(110)
    expect(f.state.busy).toBe(true)
    expect(f.listeners()).toBe(0)
  })
})

describe("a Captain's wait_for_tasks", () => {
  it("marks its own notices about the tasks it waited on seen, so they don't wake it again", async () => {
    const yard = start()
    const p = yard.store.createProject({ name: "p" })
    const other = yard.store.createProject({ name: "other" })
    const t = yard.store.createTask({ projectId: p.id, title: "T", prompt: "go" })
    const t2 = yard.store.createTask({ projectId: p.id, title: "T2", prompt: "go" })
    yard.store.updateTask(t.id, { status: "idle" })
    yard.store.addCaptainMessage(p.id, "notice", "💬 **T** finished its turn: done", { taskId: t.id })
    yard.store.addCaptainMessage(p.id, "notice", "💬 **T2** finished its turn: done", { taskId: t2.id })
    yard.store.addCaptainMessage(other.id, "notice", "💬 **T** finished its turn: done", { taskId: t.id })
    const call = await mcp(yard, { kind: "captain", projectId: p.id })
    const out = await call("wait_for_tasks", { tasks: [t.id], timeout_seconds: 5 })
    expect(out.allFinished).toBe(true)
    // The task it has the result of is seen; a task it didn't wait on, and another project's notice, still wake.
    expect(yard.store.unseenCaptainNoticeTasks(p.id)).toEqual([t2.id])
    expect(yard.store.unseenCaptainNoticeTasks(other.id)).toEqual([t.id])
  })

  it("leaves a Captain's notices alone when the Coordinator waits", async () => {
    const yard = start()
    const p = yard.store.createProject({ name: "p" })
    const t = yard.store.createTask({ projectId: p.id, title: "T", prompt: "go" })
    yard.store.updateTask(t.id, { status: "idle" })
    yard.store.addCaptainMessage(p.id, "notice", "💬 **T** finished its turn: done", { taskId: t.id })
    const call = await mcp(yard)
    await call("wait_for_tasks", { tasks: [t.id], timeout_seconds: 5 })
    expect(yard.store.unseenCaptainNoticeTasks(p.id)).toEqual([t.id])
  })
})

describe("a Captain's wake-up delay", () => {
  it("is short when no task of its project runs, and the full debounce while one does", () => {
    const yard = start()
    const p = yard.store.createProject({ name: "p" })
    const other = yard.store.createProject({ name: "other" })
    const t = yard.store.createTask({ projectId: p.id, title: "T", prompt: "go" })
    const elsewhere = yard.store.createTask({ projectId: other.id, title: "E", prompt: "go" })
    const delay = () => (yard.captains.get(p.id) as unknown as { wakeDelay(): number }).wakeDelay()
    yard.store.updateTask(t.id, { status: "idle" })
    yard.store.updateTask(elsewhere.id, { status: "working" })
    expect(yard.store.hasBusyTask(p.id)).toBe(false)
    expect(delay()).toBe(yard.captains.tuning.wakeQuietMs)
    for (const status of ["queued", "starting", "working"] as const) {
      yard.store.updateTask(t.id, { status })
      expect(yard.store.hasBusyTask(p.id)).toBe(true)
      expect(delay()).toBe(yard.captains.tuning.wakeDebounceMs)
    }
    // A debounce set below the quiet delay (a test's 20 ms) is the delay either way.
    yard.captains.tuning.wakeDebounceMs = 20
    yard.store.updateTask(t.id, { status: "idle" })
    expect(delay()).toBe(20)
  })
})

describe("Claude Code usage telemetry", () => {
  it("is the CLI's own default unless Settings turns it off", () => {
    expect(claudeTelemetryEnv(true)).toEqual({})
    expect(serverClaudeEnv(null, {}).DISABLE_TELEMETRY).toBe(process.env.DISABLE_TELEMETRY)
    const off = serverClaudeEnv(null, {}, false)
    expect(off.DISABLE_TELEMETRY).toBe("1")
    // The CLI keeps its cached feature flags, so a run has the same tools as one with telemetry on.
    expect(off.CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF).toBe("1")
  })

  it("defaults to on, and saves off", () => {
    const yard = start()
    expect(yard.settings.get().claudeTelemetry).toBe(true)
    yard.settings.update({ claudeTelemetry: false })
    expect(yard.settings.get().claudeTelemetry).toBe(false)
  })
})
