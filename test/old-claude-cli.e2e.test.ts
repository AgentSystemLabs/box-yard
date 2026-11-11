import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Project, Task, TaskMessage } from "../shared/types.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// A runner whose Claude Code is too old for the task's model, end to end with the fake claude playing the old CLI
// (FAKE_CLAUDE_VERSION, FAKE_CLAUDE_UNKNOWN_MODELS): the turn is refused before it starts when Box Yard knows the
// model's minimum, and stopped at the CLI's own "unrecognized model" line when it doesn't. Either way the task says
// the model, the CLI's version and what to do, and never reaches "Autocompact is thrashing".

interface Running {
  yard: BoxYard
  server: Server
  base: string
}
const running: Running[] = []
const ENV_KEYS = ["FAKE_CLAUDE_LOG", "FAKE_CLAUDE_VERSION", "FAKE_CLAUDE_UNKNOWN_MODELS", "FAKE_CLAUDE_THRASH_MS"]

async function start(): Promise<Running> {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port }), { webDir: "/nonexistent" })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}` }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    for (const t of r.yard.store.listTaskRows()) if (t.current_turn_id) await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
  for (const k of ENV_KEYS) delete process.env[k]
})

async function call<T>(r: Running, method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + p, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

/** Turns the fake claude ran, by its log. */
const turnLog = () => {
  const file = path.join(tmpDir(), "fake-claude.log")
  process.env.FAKE_CLAUDE_LOG = file
  return () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length : 0)
}
const settled = (r: Running, id: string, status: Task["status"]) =>
  waitFor(async () => {
    const t = await call<Task>(r, "GET", `/api/tasks/${id}`)
    return t.status === status && !t.currentTurnId ? t : null
  }, `task ${id} to be ${status}`, 60_000)
let projects = 0
const newTask = async (r: Running, model: string, env?: Record<string, string>) => {
  const p = await call<Project>(r, "POST", "/api/projects", { name: `example-${++projects}`, env })
  return call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Settings review", prompt: "write a haiku", model })
}

describe("a runner whose Claude Code is too old for the model", () => {
  it("refuses the turn before it starts, and runs it once the CLI is updated", { timeout: 120_000 }, async () => {
    const turns = turnLog()
    process.env.FAKE_CLAUDE_VERSION = "2.1.293"
    const r = await start()
    const t = await newTask(r, "claude-fable-5-2")
    const failed = await settled(r, t.id, "failed")
    expect(failed.error).toContain("Couldn't start the agent: Claude Code 2.1.293 on this computer doesn't know the model claude-fable-5-2, which needs Claude Code 2.1.321 or later.")
    expect(failed.error).toContain("the turn wasn't started")
    expect(failed.error).toContain("npm install -g @anthropic-ai/claude-code@latest")
    expect(turns()).toBe(0)

    // A model that CLI knows still runs there.
    const other = await newTask(r, "claude-opus-5-5")
    await settled(r, other.id, "idle")
    expect(turns()).toBe(1)

    // So does the same model in a project that sets the window by hand: the CLI's own way round it.
    const byHand = await newTask(r, "claude-fable-5-2", { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000" })
    await settled(r, byHand.id, "idle")
    expect(turns()).toBe(2)

    // The owner updates the CLI: the refusal wasn't remembered.
    process.env.FAKE_CLAUDE_VERSION = "2.1.322"
    await call(r, "POST", `/api/tasks/${t.id}/retry`)
    expect((await settled(r, t.id, "idle")).error).toBeFalsy()
    expect(turns()).toBe(3)
  })

  it("stops a turn at the CLI's own unrecognized-model line, with a clear error instead of the thrashing one", { timeout: 120_000 }, async () => {
    process.env.FAKE_CLAUDE_VERSION = "2.1.322"
    process.env.FAKE_CLAUDE_UNKNOWN_MODELS = "claude-next-9"
    // Left alone, the fake goes on for 30 s and ends in "Autocompact is thrashing".
    process.env.FAKE_CLAUDE_THRASH_MS = "30000"
    const r = await start()
    const started = Date.now()
    const t = await newTask(r, "claude-next-9")
    const failed = await settled(r, t.id, "failed")
    expect(Date.now() - started).toBeLessThan(25_000)
    expect(failed.error).toContain("Claude Code 2.1.322 on this computer doesn't know the model claude-next-9.")
    expect(failed.error).toContain("Box Yard stopped the turn")
    expect(failed.error).toContain("Update it there")
    expect(failed.error).not.toContain("Autocompact is thrashing")
    expect(failed.error).not.toContain("[claude-code:unrecognized_model]")
    const messages = await call<TaskMessage[]>(r, "GET", `/api/tasks/${t.id}/messages`)
    expect(messages.some((m) => m.content.includes("Autocompact is thrashing"))).toBe(false)
  })
})
