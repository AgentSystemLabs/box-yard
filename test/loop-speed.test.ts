// The changes that shortened "ask a Captain → it starts a task → the task answers → the Captain answers"
// (scripts/perf/captain-task-loop.ts measures the loop itself).
import { afterEach, describe, expect, it } from "vitest"
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { mergedHeadsScript, parseMergedHeads } from "../server/branchNames.js"
import { ALWAYS_LOAD, buildMcpServer, settle, type McpCaller } from "../server/mcp.js"
import { claudeTelemetryEnv, serverClaudeEnv } from "../server/turnCredentials.js"
import { testConfig, tmpDir } from "./helpers.js"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { SettingsStore } from "../server/settings.js"

const memSettings = () => {
  const store = new Store(openDb(tmpDir(), ":memory:"))
  return { store, settings: new SettingsStore(store, { orchestratorModel: "", workerModel: "", captainModel: "", captainEffort: "" }) }
}

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
  it("is off unless Settings turns it on, which leaves the CLI's own default", () => {
    expect(claudeTelemetryEnv(true)).toEqual({})
    expect(serverClaudeEnv(null, {}, true).DISABLE_TELEMETRY).toBe(process.env.DISABLE_TELEMETRY)
    const off = serverClaudeEnv(null, {})
    expect(off.DISABLE_TELEMETRY).toBe("1")
    // The CLI keeps its cached feature flags, so a run has the same tools as one with telemetry on.
    expect(off.CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF).toBe("1")
  })

  it("defaults to off, and saves on", () => {
    const yard = start()
    expect(yard.settings.get().claudeTelemetry).toBe(false)
    yard.settings.update({ claudeTelemetry: true })
    expect(yard.settings.get().claudeTelemetry).toBe(true)
  })

  it("drops, once, the 'on' older builds saved with every Save, and keeps a saved 'off' and a later 'on'", () => {
    const old = memSettings()
    old.store.setKv("settings", JSON.stringify({ claudeTelemetry: true, ownerName: "Sam" }))
    expect(old.settings.upgradeTelemetryDefault()).toBe(true)
    expect(old.settings.info()).toMatchObject({ settings: { claudeTelemetry: false, ownerName: "Sam" }, sources: { claudeTelemetry: "default" } })
    // Once: an "on" chosen after the upgrade stays.
    old.settings.update({ claudeTelemetry: true })
    expect(old.settings.upgradeTelemetryDefault()).toBe(false)
    expect(old.settings.get().claudeTelemetry).toBe(true)

    const chose = memSettings()
    chose.store.setKv("settings", JSON.stringify({ claudeTelemetry: false }))
    expect(chose.settings.upgradeTelemetryDefault()).toBe(false)
    expect(chose.settings.info().sources.claudeTelemetry).toBe("ui")
  })

  it("runs that upgrade when the server starts", () => {
    const yard = start()
    expect(yard.store.getKv("settings_upgrade_telemetry_off")).toBeTruthy()
  })
})

describe("the merged PR branches a new branch's name goes by", () => {
  it("are asked of GitHub by a script of their own, which a launch runs beside the clone", () => {
    const bin = tmpDir()
    const gh = path.join(bin, "gh")
    const args = ["pr", "list", "--repo", "acme/site", "--state", "merged", "--limit", "50", "--json", "headRefName"]
    fs.writeFileSync(gh, `#!${process.execPath}\nif (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(args))} || process.env.GH_TOKEN !== 'project-test-token') process.exit(1); console.log(JSON.stringify([{headRefName:'feature/new-menu'}, {headRefName:7}, {headRefName:'feature/new-search'}]));\n`, { mode: 0o755 })
    const ask = () => execFileSync("sh", ["-c", mergedHeadsScript(process.execPath, "acme/site")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "ambient-test-token", GITHUB_TOKEN: "project-test-token" } }).toString()
    expect(parseMergedHeads(ask())).toEqual(["feature/new-menu", "feature/new-search"])
    // gh failing is no evidence, as it is inside the evidence script: not an error.
    fs.writeFileSync(gh, "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    expect(parseMergedHeads(ask())).toEqual([])
    // The script never ran (the box didn't answer): nothing to read.
    expect(parseMergedHeads("")).toBeNull()
    expect(parseMergedHeads("boxyard-merged-heads=oops")).toBeNull()
  })
})
