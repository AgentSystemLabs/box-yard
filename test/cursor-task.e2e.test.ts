import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { Project, Task, TaskMessage } from "../shared/types.js"
import { CURSOR_BOXYARD_SERVER, cursorAgentArgs } from "../server/cursor.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Task agents on Cursor's CLI (docs/cursor.md), through runner/box-runner.mjs and scripts/fake-cursor.mjs: the CLI a
// task keeps, cursor-agent's flags, Box Yard's tools as a plugin, the chat it resumes, the instructions it reads once,
// the key a turn gets, and the tokens (no cost) it records.

interface Running {
  yard: BoxYard
  server: Server
  call: <T>(method: string, url: string, body?: unknown) => Promise<T>
  raw: (method: string, url: string, body?: unknown) => Promise<{ status: number; text: string }>
}
const running: Running[] = []
let log = ""

beforeEach(() => {
  log = path.join(tmpDir("cursor-task-log"), "cursor.jsonl")
  process.env.FAKE_CURSOR_LOG = log
})

afterEach(async () => {
  delete process.env.FAKE_CURSOR_LOG
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function start(): Promise<Running> {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port, claudeOauthToken: "global-claude-oauth" }), { webDir: "/nonexistent" })
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
  const r = { yard, server, call, raw }
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

describe("task agents on Cursor", () => {
  it("run cursor-agent with Box Yard's tools as a plugin; the next turn resumes the chat without the instructions again", async () => {
    const r = await start()
    const p = await r.call<Project>("POST", "/api/projects", { name: "cu", agentCli: "cursor" })
    expect(p.agentCli).toBe("cursor")
    const created = await r.call<Task>("POST", "/api/tasks", { projectId: p.id, title: "Hello", prompt: "Say hi [artifact]" })
    expect(created.agentCli).toBe("cursor")
    const done = await resting(r, created.id)
    expect(["idle", "done"]).toContain(done.status)

    const [first] = runs()
    const dir = r.yard.tasks.taskDir(done.boxId!, done.id)
    // Settings' Cursor model is Auto until one is saved.
    expect(first.model).toBe("auto")
    expect(first.resume).toBe(done.sessionId)
    expect(first.existing).toBe(false)
    expect(first.sandbox).toBe("disabled")
    // The runner keeps its own copy of cursorAgentArgs (it runs on boxes with plain Node): the two stay the same.
    expect(first.args).toEqual(cursorAgentArgs({ sessionId: first.chat, model: first.model, pluginDir: path.join(dir, "cursor-plugin", "boxyard") }))
    expect(first.plugin).toBe("boxyard")
    expect(first.servers).toEqual(["boxyard"])
    expect(first.instructions).toBe(true)
    expect(first.usageLines).toBe(true)
    // The task's own Cursor folder, so its chats move with it.
    expect(first.configDir).toBe(path.join(dir, "cursor"))
    expect(first.dataDir).toBe(path.join(dir, "cursor"))
    // Box Yard's tools work through the plugin: the stand-in published its file (publish_artifact).
    expect(r.yard.store.listArtifacts({ taskId: done.id }).map((a) => a.filename)).toEqual([expect.stringMatching(/box-yard-demo/)])
    expect((await said(r, done.id, "assistant")).length).toBeGreaterThan(0)
    expect(done.contextTokens).toBeGreaterThan(0)

    // Settings' Claude login doesn't reach a Cursor turn, and with no key it runs on this computer's login.
    const taskJson = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"))
    expect(taskJson).toMatchObject({ agent: "cursor" })
    expect(taskJson.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(taskJson.unsetEnv).toEqual(expect.arrayContaining(["CLAUDE_CODE_OAUTH_TOKEN", "CURSOR_API_KEY"]))
    expect(first.key).toBeNull()

    // Tokens are recorded at no cost: Cursor bills its own plan and reports no price.
    const ledger = usage(r, done.id)
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ model: "auto", c: 0, rc: 0 })
    expect(ledger[0]!.t).toBeGreaterThan(0)

    await r.call("POST", `/api/tasks/${done.id}/messages`, { content: "Say hi again" })
    await waitFor(() => runs().length === 2, "the second turn")
    const again = await resting(r, done.id)
    expect(runs()[1]).toMatchObject({ resume: first.chat, chat: first.chat, existing: true, instructions: false })
    expect(again.sessionId).toBe(first.chat)
    expect(usage(r, done.id)).toHaveLength(2)

    // Its chats go into the archive; the plugin folder (written every turn) doesn't.
    await waitFor(() => r.yard.store.getTaskRow(done.id)?.archive_path, "the turn-end archive")
    const listing = execFileSync("tar", ["tzf", r.yard.store.getTaskRow(done.id)!.archive_path!], { encoding: "utf8" })
    expect(listing).toMatch(/cursor\/chats\//)
    expect(listing).not.toMatch(/cursor-plugin/)
  })

  it("hands a turn Settings' Cursor key, a project's own key over it, and the model Settings or the task names", async () => {
    const r = await start()
    r.yard.settings.credentials.update({ cursorApiKey: "crsr_settings_0000000000" })
    r.yard.settings.update({ agentCursorModel: "composer-2.5" })
    const p = await r.call<Project>("POST", "/api/projects", { name: "cu", agentCli: "cursor" })
    const t = await r.call<Task>("POST", "/api/tasks", { projectId: p.id, title: "Hello", prompt: "Say hi [pr]" })
    await resting(r, t.id)
    expect(runs()[0]).toMatchObject({ key: "crsr_settings_0000000000", model: "composer-2.5" })

    const own = await r.call<Project>("POST", "/api/projects", { name: "own", agentCli: "cursor", env: { CURSOR_API_KEY: "crsr_project_0000000000" } })
    // A model only Cursor runs picks Cursor by itself, and stays the task's.
    const gem = await r.call<Task>("POST", "/api/tasks", { projectId: own.id, title: "Gemini", prompt: "Say hi [pr]", model: "gemini-4-argon-high" })
    expect(gem.agentCli).toBe("cursor")
    await resting(r, gem.id)
    expect(runs()[1]).toMatchObject({ key: "crsr_project_0000000000", model: "gemini-4-argon-high" })
    expect(usage(r, gem.id)[0]).toMatchObject({ model: "gemini-4-argon-high", c: 0 })

    // An empty saved model leaves the choice to the CLI; the ledger names the model it said it ran.
    r.yard.settings.update({ agentCursorModel: "" })
    const plain = await r.call<Task>("POST", "/api/tasks", { projectId: p.id, title: "Default", prompt: "Say hi [pr]" })
    await resting(r, plain.id)
    expect(runs()[2].model).toBeNull()
    expect(runs()[2].args).not.toContain("--model")
    expect(usage(r, plain.id)[0]!.model).toBe("Auto")

    // The key never goes into the archive.
    await waitFor(() => r.yard.store.getTaskRow(t.id)?.archive_path, "the turn-end archive")
    const archive = r.yard.store.getTaskRow(t.id)!.archive_path!
    const files = execFileSync("tar", ["xzOf", archive], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    expect(files).not.toContain("crsr_settings_0000000000")
  })

  it("keeps a task's harness after Settings changes, refuses /compact, and starts a new chat with a recap when its chat is gone", async () => {
    const r = await start()
    r.yard.settings.update({ agentCli: "cursor" })
    const p = await r.call<Project>("POST", "/api/projects", { name: "mixed" })
    const t = await r.call<Task>("POST", "/api/tasks", { projectId: p.id, title: "On Cursor", prompt: "Say hi [pr]" })
    expect(t.agentCli).toBe("cursor")
    const done = await resting(r, t.id)
    const compact = await r.raw("POST", `/api/tasks/${t.id}/compact`)
    expect(compact.status).toBe(400)
    expect(compact.text).toMatch(/Cursor, which summarizes its own context/)

    r.yard.settings.update({ agentCli: "claude" })
    // The chat is lost (a fresh box, a lost archive): the runner notices before the CLI would start an empty one.
    fs.rmSync(path.join(r.yard.tasks.taskDir(done.boxId!, done.id), "cursor", "chats"), { recursive: true, force: true })
    await r.call("POST", `/api/tasks/${t.id}/messages`, { content: "Say hi again [pr]" })
    await waitFor(() => runs().length === 2, "the second turn")
    const again = await resting(r, t.id)
    expect(r.yard.store.getTask(t.id)?.agentCli).toBe("cursor")
    expect(again.sessionId).not.toBe(done.sessionId)
    expect(runs()[1]).toMatchObject({ existing: false, instructions: true, chat: again.sessionId })
    expect(await said(r, t.id, "event")).toEqual(expect.arrayContaining([expect.stringMatching(/^Cursor session was missing on this box/)]))
  })

  it("fails a turn whose key Cursor refuses, saying so", async () => {
    const r = await start()
    r.yard.settings.credentials.update({ cursorApiKey: "crsr_invalid_0000000000" })
    const p = await r.call<Project>("POST", "/api/projects", { name: "bad", agentCli: "cursor" })
    const t = await r.call<Task>("POST", "/api/tasks", { projectId: p.id, title: "Hello", prompt: "Say hi" })
    const done = await resting(r, t.id)
    expect(done.status).toBe("failed")
    expect(done.error ?? "").toMatch(/The provided API key is invalid/)
    expect(done.error ?? "").not.toContain("crsr_invalid_0000000000")
    // The ledger keeps the turn's time, with no tokens.
    expect(usage(r, t.id).map((u) => u.t)).toEqual([0])
  })

  it("names Box Yard's MCP server the way cursor-agent does", () => {
    expect(CURSOR_BOXYARD_SERVER).toBe("plugin-boxyard-boxyard")
  })
})
