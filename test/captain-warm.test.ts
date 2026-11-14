import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { CaptainMessage, CaptainState, Project, UiEvent } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// Settings › Coordinator › Warm Claude process (server/warmClaude.ts): one claude process per Captain the owner is
// chatting with, taking its turns over stream-json stdin, restarted when its launch changes, gone when idle, on
// Settings › off, or when Box Yard stops. And Stream Captain replies: captain.delta events as the reply is written.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  /** One line per claude process started: its pid and its Claude login. */
  starts: () => { pid: number; token: string }[]
  /** One line per turn the fake claude ran: its process's flags and the prompt. */
  turns: () => { args: string[]; prompt: string }[]
  events: UiEvent[]
}
const running: Running[] = []
const ENV_KEYS = ["FAKE_CLAUDE_LOG", "FAKE_CLAUDE_LOG_FULL", "FAKE_CLAUDE_DIE_ON_INPUT", "FAKE_CLAUDE_WORD_MS"]

async function start(): Promise<Running> {
  const dir = tmpDir("captain-warm-")
  const startLog = path.join(dir, "starts.log")
  const turnLog = path.join(dir, "turns.log")
  process.env.FAKE_CLAUDE_LOG = turnLog
  process.env.FAKE_CLAUDE_LOG_FULL = "1"
  // Logs each process's pid (exec keeps it) and login, then runs the fake claude.
  const claude = path.join(dir, "claude")
  fs.writeFileSync(claude, `#!/bin/sh\necho "{\\"pid\\":$$,\\"token\\":\\"$CLAUDE_CODE_OAUTH_TOKEN\\"}" >> ${JSON.stringify(startLog)}\nexec ${FAKE_CLAUDE} "$@"\n`, { mode: 0o755 })
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port, claudeBin: claude }), { webDir: "/nonexistent" })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const events: UiEvent[] = []
  const broadcast = yard.hub.broadcast.bind(yard.hub)
  yard.hub.broadcast = (ev: UiEvent) => {
    events.push(ev)
    return broadcast(ev)
  }
  const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])
  const r: Running = { yard, server, base: `http://127.0.0.1:${port}`, starts: () => lines(startLog), turns: () => lines(turnLog).filter((t: { args: string[] }) => t.args.includes("--mcp-config")), events }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
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

async function captain(r: Running, name = "demo") {
  const p = await call<Project>(r, "POST", "/api/projects", { name })
  const messages = () => call<CaptainMessage[]>(r, "GET", `/api/projects/${p.id}/captain/messages`)
  const say = async (content: string) => {
    const before = (await messages()).filter((m) => m.role === "assistant").length
    await call(r, "POST", `/api/projects/${p.id}/captain/messages`, { content })
    await waitFor(async () => !(await call<CaptainState>(r, "GET", `/api/projects/${p.id}/captain`)).busy && (await messages()).filter((m) => m.role === "assistant").length > before, "Captain reply")
    return (await messages()).filter((m) => m.role === "assistant").at(-1)!
  }
  const warm = () => r.yard.captains.warmProcesses().find((w) => w.projectId === p.id) ?? null
  return { p, say, messages, warm }
}

const settings = (r: Running, patch: Record<string, unknown>) => call(r, "PUT", "/api/agent-settings", patch)
const gone = (pid: number) => {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}
const argOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

describe("a Captain's warm claude process", () => {
  it("takes the owner's turns in one process, started ahead when they open the chat box", async () => {
    const r = await start()
    const { p, say, warm } = await captain(r)
    // Opening the chat box starts it, before any message.
    await call(r, "POST", `/api/projects/${p.id}/captain/warm`)
    const first = await waitFor(warm, "a warm process")
    expect(first.turns).toBe(0)
    await say("status")
    await say("status again")
    expect(warm()).toMatchObject({ pid: first.pid, turns: 2 })
    expect(r.starts()).toHaveLength(1)
    const turns = r.turns()
    expect(turns).toHaveLength(2)
    // The same process, so the same flags: the session it was started on, and stdin as stream-json.
    for (const t of turns) {
      expect(argOf(t.args, "--input-format")).toBe("stream-json")
      expect(t.args).toContain("--include-partial-messages")
    }
    expect(turns[1]!.prompt).toContain("status again")
  })

  it("starts again when its settings or login change, and goes when turned off or Box Yard stops", async () => {
    const r = await start()
    const { p, say, warm } = await captain(r)
    await say("status")
    const first = warm()!
    // A new effort: the process for the old one goes, and one for the new one starts (Settings were saved).
    await settings(r, { captainEffort: "low" })
    const second = await waitFor(() => (warm()?.pid !== first.pid ? warm() : null), "a restarted warm process")
    await waitFor(() => gone(first.pid!), "the old process to exit")
    await say("status after the effort change")
    expect(warm()).toMatchObject({ pid: second.pid, turns: 1 })
    expect(argOf(r.turns().at(-1)!.args, "--effort")).toBe("low")
    // Its project's own Claude login: the next turn starts one with it.
    r.yard.store.updateProject(p.id, { env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-project-a" } })
    await say("status with its own login")
    expect(warm()!.pid).not.toBe(second.pid)
    expect(r.starts().at(-1)!.token).toBe("sk-ant-oat01-project-a")
    const third = warm()!
    // Off: it goes at once.
    await settings(r, { captainWarmProcess: false })
    await waitFor(() => gone(third.pid!), "the warm process to exit when turned off")
    expect(warm()).toBeNull()
    // Each turn its own process again.
    await say("status cold")
    expect(r.turns().at(-1)!.args).not.toContain("--input-format")
    // On again, then Box Yard stops: no process is left behind.
    await settings(r, { captainWarmProcess: true })
    await say("status warm again")
    const last = warm()!
    r.yard.stop()
    await waitFor(() => gone(last.pid!), "the warm process to exit with Box Yard")
  })

  it("never shares a process or a login between projects", async () => {
    const r = await start()
    const a = await captain(r, "alpha")
    const b = await captain(r, "beta")
    r.yard.store.updateProject(a.p.id, { env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-alpha" } })
    r.yard.store.updateProject(b.p.id, { env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-beta" } })
    await a.say("status")
    await b.say("status")
    await a.say("status again")
    expect(a.warm()!.pid).not.toBe(b.warm()!.pid)
    expect(a.warm()!.turns).toBe(2)
    const tokens = new Map(r.starts().map((s) => [s.pid, s.token]))
    expect(tokens.get(a.warm()!.pid!)).toBe("sk-ant-oat01-alpha")
    expect(tokens.get(b.warm()!.pid!)).toBe("sk-ant-oat01-beta")
  })

  it("goes after the idle time, read live: a shorter one applies to a process already warm", async () => {
    const r = await start()
    r.yard.captains.tuning.warmMinuteMs = 200
    await settings(r, { captainWarmIdleMinutes: 60 })
    const { say, warm } = await captain(r)
    await say("status")
    const w = warm()!
    await new Promise((res) => setTimeout(res, 600))
    expect(warm()).toMatchObject({ pid: w.pid })
    await settings(r, { captainWarmIdleMinutes: 1 })
    await waitFor(() => gone(w.pid!), "the idle warm process to exit")
    expect(warm()).toBeNull()
  })

  it("ends with a turn stopped in it; the next turn starts a new one on the same session", async () => {
    const r = await start()
    const { p, say, warm } = await captain(r)
    await say("status")
    const first = warm()!
    await call(r, "POST", `/api/projects/${p.id}/captain/messages`, { content: "a long job [hang]" })
    await waitFor(() => r.turns().length === 2 || null, "the hanging turn")
    expect(r.yard.captains.stopTurn(p.id)).toBe(true)
    await waitFor(() => gone(first.pid!), "the warm process to end with its turn")
    const reply = await say("status after the stop")
    expect(reply.content).toBeTruthy()
    expect(warm()!.pid).not.toBe(first.pid)
    const session = (args: string[]) => (args.includes("--resume") ? argOf(args, "--resume") : argOf(args, "--session-id"))
    expect(r.turns().at(-1)!.args).toContain("--resume")
    expect(session(r.turns().at(-1)!.args)).toBe(session(r.turns()[0]!.args))
  })

  it("hands a turn to a new process when the warm one dies on it", async () => {
    const r = await start()
    const { p, say, warm } = await captain(r)
    process.env.FAKE_CLAUDE_DIE_ON_INPUT = "1"
    await call(r, "POST", `/api/projects/${p.id}/captain/warm`)
    await waitFor(warm, "a warm process")
    const reply = await say("status")
    expect(reply.content).toBeTruthy()
    // The warm process died before it printed anything; the turn ran in a process of its own.
    expect(r.turns()).toHaveLength(1)
    expect(r.turns()[0]!.args).not.toContain("--input-format")
  })
})

describe("streamed Captain replies", () => {
  it("send the reply as it's written, without its hidden next steps, and end on the stored reply", async () => {
    process.env.FAKE_CLAUDE_WORD_MS = "1"
    const r = await start()
    const { p, say } = await captain(r)
    const reply = await say("status")
    const deltas = r.events.filter((e): e is Extract<UiEvent, { type: "captain.delta" }> => e.type === "captain.delta" && e.projectId === p.id)
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas[0]!.reset).toBe(true)
    let shown = ""
    for (const d of deltas) shown = d.reset ? d.text : shown + d.text
    expect(shown).toBe(reply.content)
    expect(deltas.some((d) => d.text.includes("boxyard-"))).toBe(false)
    // Off: no deltas, the same reply.
    await settings(r, { captainStreamReplies: false })
    const count = r.events.filter((e) => e.type === "captain.delta").length
    await say("status again")
    expect(r.events.filter((e) => e.type === "captain.delta").length).toBe(count)
    expect(r.turns().at(-1)!.args).not.toContain("--include-partial-messages")
  })
})
