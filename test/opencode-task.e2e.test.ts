import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Project, Task, TaskMessage } from "../shared/types.js"
import { openCodeArgs } from "../server/opencode.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Full worker/server path with a safe CLI fixture: no real provider calls or credentials.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  call: <T>(method: string, url: string, body?: unknown) => Promise<T>
  raw: (method: string, url: string, body?: unknown) => Promise<{ status: number; text: string }>
}
const running: Running[] = []
let log = ""

beforeEach(() => {
  log = path.join(tmpDir("opencode-task-log"), "opencode.jsonl")
  process.env.FAKE_OPENCODE_LOG = log
})

afterEach(async () => {
  delete process.env.FAKE_OPENCODE_LOG
  for (const r of running.splice(0)) {
    for (const task of r.yard.store.listTaskRows()) {
      for (const input of r.yard.store.listQueuedInputs(task.id)) if (input.status === "queued") r.yard.tasks.cancelQueued(task.id, input.id)
      if (task.current_turn_id) await r.yard.tasks.stopTask(task.id)
    }
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "all OpenCode fixture turns to stop")
    for (const task of r.yard.store.listTaskRows()) await r.yard.tasks.archive(task.id)
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function start(config: Parameters<typeof testConfig>[0] = {}): Promise<Running> {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port, pushAtTurnEnd: false, claudeOauthToken: "global-claude-oauth", ...config }), { webDir: "/nonexistent" })
  yard.captains.tuning.wakeDebounceMs = yard.captains.tuning.wakeQuietMs = 10 * 60_000
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const base = `http://127.0.0.1:${port}`
  const raw = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, text: await res.text() }
  }
  const call = async <T,>(method: string, url: string, body?: unknown): Promise<T> => {
    const r = await raw(method, url, body)
    if (r.status >= 300) throw new Error(`${method} ${url} -> ${r.status}: ${r.text}`)
    return JSON.parse(r.text) as T
  }
  const r = { yard, server, base, call, raw }
  running.push(r)
  return r
}

const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])
const resting = (r: Running, id: string) =>
  waitFor(() => (["done", "idle", "failed"].includes(r.yard.store.getTask(id)?.status ?? "") && !r.yard.store.getTaskRow(id)?.current_turn_id ? r.yard.store.getTask(id) : null), "the turn to end", 30_000)
const usage = (r: Running, id: string) =>
  r.yard.store.db
    .prepare("SELECT model, input_tokens AS i, output_tokens AS o, total_tokens AS t, cost_usd AS c, reported_cost_usd AS rc FROM claude_usage WHERE task_id = ? ORDER BY ended_at, rowid")
    .all(id) as { model: string | null; i: number; o: number; t: number; c: number | null; rc: number | null }[]
const said = async (r: Running, id: string, role: string) => (await r.call<TaskMessage[]>("GET", `/api/tasks/${id}/messages`)).filter((m) => m.role === role).map((m) => m.content)

describe("task agents on OpenCode", () => {
  it("runs scoped MCP tools, preserves the CLI session through follow-up and archive restore, and charges each run once", async () => {
    const r = await start()
    r.yard.settings.credentials.update({ opencodeAuthJson: JSON.stringify({ example: { type: "api", key: "example-global-api" } }) })
    r.yard.settings.update({ agentOpencodeModel: "example/model#high" })
    const p = await r.call<Project>("POST", "/api/projects", { name: "example", agentCli: "opencode" })
    const t = await r.call<Task>("POST", "/api/tasks", { projectId: p.id, title: "Example task", prompt: "Say hi [artifact]" })
    const done = await resting(r, t.id)
    expect(done.status).toBe("idle")
    expect(done.agentCli).toBe("opencode")
    expect(done.sessionId).toMatch(/^ses_/)
    const [first] = runs()
    expect(first.args).toEqual(openCodeArgs("example/model#high", null))
    expect(first.config.mcp.boxyard.command.slice(-2)).toEqual(["mcp", r.yard.tasks.taskDir(done.boxId!, t.id)])
    expect(first.config.permission.task).toBe("deny")
    expect(first.hasAuth).toBe(true)
    expect(first.env).toEqual({ claude: false, codex: false, cursor: false })
    expect(first.prompt).toContain("<boxyard_instructions>")
    expect(r.yard.store.listArtifacts({ taskId: t.id })).toHaveLength(1)
    expect(await said(r, t.id, "assistant")).not.toHaveLength(0)
    expect(usage(r, t.id)).toEqual([expect.objectContaining({ c: 0.125, rc: 0.125, i: 100, o: 25, t: 165 })])
    await r.yard.tasks.archive(t.id)
    const archive = r.yard.store.getTaskRow(t.id)!.archive_path!
    expect(execFileSync("tar", ["tzf", archive], { encoding: "utf8" })).toMatch(/opencode\/data\/opencode\/ses_/)
    expect(execFileSync("tar", ["xzOf", archive], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).not.toContain("example-global-api")
    // Restore into a fresh task folder on the next assignment, including the native session store.
    fs.rmSync(r.yard.tasks.taskDir(done.boxId!, t.id), { recursive: true, force: true })
    r.yard.store.updateTask(t.id, { boxId: null })
    r.yard.settings.update({ agentCli: "claude" })
    await r.call("POST", `/api/tasks/${t.id}/messages`, { content: "Say hi again" })
    await waitFor(() => runs().length === 2, "the restored OpenCode run")
    const again = await resting(r, t.id)
    expect(again.sessionId).toBe(done.sessionId)
    expect(again.agentCli).toBe("opencode")
    expect(runs()[1].resume).toBe(done.sessionId)
    expect(usage(r, t.id).map((u) => u.c)).toEqual([0.125, 0.125])
    await r.yard.tasks.archive(t.id)
    const compact = await r.raw("POST", `/api/tasks/${t.id}/compact`)
    expect(compact.status).toBe(400)
    expect(compact.text).toContain("OpenCode manages its own compaction")
    await r.call("POST", `/api/tasks/${t.id}/continue`, { agent: "codex", message: "Continue the same work" })
    const switched = await resting(r, t.id)
    expect(switched.agentCli).toBe("codex")
    expect(switched.sessionId).not.toBe(done.sessionId)
    await r.yard.tasks.archive(t.id)
  })

  it("normalizes split JSON, final tails, repeated parts, tools, cache/reasoning tokens and per-step cost", async () => {
    const r = await start()
    const p = await r.call<Project>("POST", "/api/projects", { name: "example" })
    const t = await r.call<Task>("POST", "/api/tasks", { projectId: p.id, title: "Wire fixture", prompt: "[opencode-fragments]", model: "example/model#high" })
    const done = await resting(r, t.id)
    expect(done.agentCli).toBe("opencode")
    expect(done.contextTokens).toBe(165) // last step, not the run's sum
    expect(usage(r, t.id)).toEqual([expect.objectContaining({ c: 0.2, i: 200, o: 50, t: 330 })])
    expect(await said(r, t.id, "assistant")).toContain("Fixture reply")
    const events = (await r.call<TaskMessage[]>("GET", `/api/tasks/${t.id}/messages`)).filter((m) => m.role === "tool")
    expect(JSON.stringify(events)).toContain("Bash")
    expect(JSON.stringify(events)).toContain("fixture tool error")
    await r.yard.tasks.archive(t.id)
  })

  it("delivers uploaded paths and uses scoped worker MCP for subtasks on the parent's runner", async () => {
    const r = await start()
    const p = await r.call<Project>("POST", "/api/projects", { name: "example", agentCli: "opencode" })
    const upload = await (await fetch(`${r.base}/api/uploads?name=example.txt`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: "Example attachment" })).json() as { id: string }
    const parent = await r.call<Task>("POST", "/api/tasks", { projectId: p.id, title: "Worker tools", prompt: "spawn subtasks: Example child [wait]", attachments: [upload.id] })
    const done = await resting(r, parent.id)
    expect(done.status).toBe("idle")
    const children = r.yard.store.listTasks().filter((t) => t.parentTaskId === parent.id)
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({ agentCli: "opencode", status: "idle", boxId: done.boxId })
    expect(runs().find((run) => run.prompt.includes("spawn subtasks:"))?.prompt).toContain("attachments/example.txt")
    expect(fs.readFileSync(path.join(r.yard.tasks.taskDir(done.boxId!, parent.id), "attachments", "example.txt"), "utf8")).toBe("Example attachment")
    expect(r.yard.store.listTaskMessages(parent.id, 100).some((m) => m.meta?.subtaskReport)).toBe(true)
    for (const task of [parent, ...children]) await r.yard.tasks.archive(task.id)
  })

  it("keeps errors actionable, never falls back to another CLI, and rejects incompatible effort and model choices", async () => {
    const r = await start()
    const p = await r.call<Project>("POST", "/api/projects", { name: "example", agentCli: "opencode" })
    for (const body of [{ model: "opus" }, { effort: "high" }]) {
      const bad = await r.raw("POST", "/api/tasks", { projectId: p.id, agentCli: "opencode", title: "Bad choices", prompt: "Hello", ...body })
      expect(bad.status).toBe(400)
      expect(bad.text).toMatch(/OpenCode/)
    }
    for (const marker of ["opencode-error", "opencode-empty", "opencode-malformed", "opencode-length", "opencode-secret-error"]) {
      r.yard.settings.credentials.update({ opencodeAuthJson: '{"example":{"type":"api","key":"example-redaction-key"}}' })
      const t = await r.call<Task>("POST", "/api/tasks", { projectId: p.id, title: "Failure fixture", prompt: `[${marker}]` })
      const done = await resting(r, t.id)
      expect(done.status).toBe("failed")
      expect(done.agentCli).toBe("opencode")
      expect(done.error).toMatch(/OpenCode/)
      expect(done.error).not.toContain("example-redaction-key")
      expect(() => r.yard.tasks.setTaskModel(t.id, { effort: "high" })).toThrow(/omit effort/)
      expect(() => r.yard.tasks.sendInput(t.id, "Retry", "cody", [], { model: "opus" })).toThrow(/provider\/model/)
      expect(r.yard.store.listQueuedInputs(t.id)).toHaveLength(0)
      await r.yard.tasks.archive(t.id)
    }
    const t = await r.call<Task>("POST", "/api/tasks", { projectId: p.id, title: "Version fixture", prompt: "Hello", env: { FAKE_OPENCODE_VERSION: "2.0.0" } })
    expect((await resting(r, t.id)).error).toContain("OpenCode 1.19.5 is required")
    await r.yard.tasks.archive(t.id)
    const before = runs().length
    const variant = await r.call<Task>("POST", "/api/tasks", { projectId: p.id, title: "Unknown variant", prompt: "Hello", model: "example/model#unsupported" })
    expect((await resting(r, variant.id)).error).toContain("does not list variant unsupported")
    expect(runs()).toHaveLength(before) // fail before requesting any generation
    await r.yard.tasks.archive(variant.id)
  })

  it("reports a missing binary and resets a missing native session with a visible recap", async () => {
    const absent = await start({ opencodeBin: "/example-missing/opencode" })
    const p = await absent.call<Project>("POST", "/api/projects", { name: "example", agentCli: "opencode" })
    const t = await absent.call<Task>("POST", "/api/tasks", { projectId: p.id, title: "Absent binary", prompt: "Hello" })
    expect((await resting(absent, t.id)).error).toMatch(/OpenCode isn't installed.*1\.19\.5/s)
    await absent.yard.tasks.archive(t.id)

    const r = await start()
    const project = await r.call<Project>("POST", "/api/projects", { name: "example", agentCli: "opencode" })
    const task = await r.call<Task>("POST", "/api/tasks", { projectId: project.id, title: "Session reset", prompt: "Remember this fixture" })
    const first = await resting(r, task.id)
    await r.yard.tasks.archive(task.id)
    fs.rmSync(path.join(runs().at(-1).data, `${first.sessionId}.json`))
    await r.call("POST", `/api/tasks/${task.id}/messages`, { content: "Continue this fixture" })
    const next = await resting(r, task.id)
    expect(next.status).toBe("idle")
    expect(next.sessionId).not.toBe(first.sessionId)
    expect((await said(r, task.id, "event")).join()).toContain("OpenCode session was missing on this box")
    expect(runs().at(-1).prompt).toContain("Remember this fixture")
    await r.yard.tasks.archive(task.id)
    const count = runs().length
    await r.call("POST", `/api/tasks/${task.id}/messages`, { content: "[opencode-auth-session]" })
    const authError = await resting(r, task.id)
    expect(authError.status).toBe("failed")
    expect(authError.error).toContain("401")
    expect(authError.sessionId).toBe(next.sessionId)
    expect(runs()).toHaveLength(count + 1) // a provider's missing session is not a lost CLI session
    await r.yard.tasks.archive(task.id)
  })

  it("stops a running OpenCode turn and queues follow-up input instead of pretending to steer it", async () => {
    const r = await start()
    const p = await r.call<Project>("POST", "/api/projects", { name: "example", agentCli: "opencode" })
    const t = await r.call<Task>("POST", "/api/tasks", { projectId: p.id, title: "Stop fixture", prompt: "Say hi [hang]" })
    await waitFor(() => runs().length === 1 && r.yard.store.getTask(t.id)?.status === "working", "OpenCode's running turn")
    await r.call("POST", `/api/tasks/${t.id}/messages`, { content: "Queued follow-up" })
    const queued = r.yard.store.listQueuedInputs(t.id)
    expect(queued).not.toHaveLength(0)
    expect(await r.call("POST", `/api/tasks/${t.id}/queue/steer`)).toMatchObject({ delivery: "after_turn", note: expect.stringContaining("OpenCode") })
    for (const input of queued) await r.call("DELETE", `/api/tasks/${t.id}/queue/${input.id}`)
    await r.call("POST", `/api/tasks/${t.id}/stop`)
    await resting(r, t.id)
    expect(runs()).toHaveLength(1)
    await r.yard.tasks.archive(t.id)
  })
})
