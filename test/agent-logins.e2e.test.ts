import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { LocalProvider } from "../server/providers/local.js"
import type { Identity } from "../shared/identities.js"
import type { AgentLogin } from "../shared/agentLogins.js"
import type { TurnTiming } from "../shared/turnTimings.js"
import type { Project, Task } from "../shared/types.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// More Claude logins, end to end (docs/logins.md): values go in and only labels and last 4s come out, new task
// sessions and Coordinator runs take the next login round robin, a run on a login at its limit carries on on the next
// one, and a project identity's own login still wins.

const running: { yard: BoxYard; server: Server }[] = []
afterEach(async () => {
  for (const r of running.splice(0)) {
    await waitFor(() => !r.yard.orchestrator.busy, "the Coordinator to finish")
    await waitFor(() => r.yard.store.listTaskRows().every((t) => !t.current_turn_id), "turns to end").catch(() => {})
    await waitFor(() => !(r.yard.tasks as unknown as { archiving: Set<string> }).archiving.size, "archives to finish")
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function start(claudeOauthToken: string) {
  const dir = tmpDir("agent-logins-e2e-")
  const log = path.join(dir, "claude-env.log")
  // Writes where it runs and the Claude login it was handed, then runs the fake claude.
  const claude = path.join(dir, "claude")
  fs.writeFileSync(
    claude,
    `#!/bin/sh\n${JSON.stringify(process.execPath)} -e 'const env = Object.entries(process.env).filter(([k]) => /^(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)$/.test(k)).map(([k,v]) => k + "=" + v); require("node:fs").appendFileSync(process.argv[1], JSON.stringify({cwd: process.cwd(), env}) + "\\n")' ${JSON.stringify(log)}\nexec ${FAKE_CLAUDE} "$@"\n`,
    { mode: 0o755 },
  )
  const port = await freePort()
  const config = testConfig({ port, claudeBin: claude, claudeOauthToken, maxBoxes: 4 })
  const yard = createBoxYard(config, { webDir: "/nonexistent", provider: new LocalProvider(path.join(dir, "boxes"), claude) })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  running.push({ yard, server })
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
  /** The Claude login each run had, in order: task turns', or (`coordinator`) the Coordinator's. */
  const runs = (coordinator = false) =>
    (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").slice(0, -1) : [])
      .map((line) => JSON.parse(line) as { cwd: string; env: string[] })
      .filter((run) => run.cwd.includes(`${path.sep}orchestrator`) === coordinator && !run.cwd.includes(`${path.sep}captains${path.sep}`))
      .map((run) => run.env.join(" "))
  const runTask = async (project: Project, prompt = "Say hi") => {
    const task = await call<Task>("POST", "/api/tasks", { projectId: project.id, title: "Hello", prompt })
    await waitFor(() => {
      const t = yard.store.getTask(task.id)
      return t?.status === "idle" && !t.currentTurnId
    }, "the task's turn to end", 30_000)
    return task
  }
  const events = (taskId: string) =>
    yard.store
      .listTaskMessages(taskId)
      .filter((m) => m.role === "event")
      .map((m) => m.content)
  return { yard, raw, call, runs, runTask, events }
}

describe("more Claude logins", () => {
  it("take a value in and give back only a label and its last 4", async () => {
    const r = await start("oat-global-0001")
    const added = await r.call<AgentLogin>("POST", "/api/logins", { harness: "claude", label: "Work Max", value: "oat-work-secret-a1b2" })
    expect(added).toMatchObject({ harness: "claude", label: "Work Max", last4: "a1b2", source: "added", state: "ok" })
    const listed = await r.raw("GET", "/api/logins")
    for (const secret of ["oat-work-secret-a1b2", "oat-global-0001"]) expect(listed.text).not.toContain(secret)
    expect((JSON.parse(listed.text) as AgentLogin[]).map((l) => [l.label, l.last4])).toEqual([
      ["Credentials", "0001"],
      ["Work Max", "a1b2"],
    ])
    // An API key isn't a subscription login, and one account is one login.
    expect(await r.raw("POST", "/api/logins", { harness: "claude", label: "Key", value: "sk-ant-api03-xyz" })).toMatchObject({ status: 400 })
    expect(await r.raw("POST", "/api/logins", { harness: "claude", label: "Again", value: "oat-work-secret-a1b2" })).toMatchObject({ status: 400 })
    // A Test answers without the value, even when the CLI's message would carry it.
    const tested = await r.raw("POST", `/api/logins/${added.id}/test`)
    expect(tested.status).toBe(200)
    expect(tested.text).not.toContain("oat-work-secret-a1b2")
    expect(await r.raw("DELETE", `/api/logins/${added.id}`)).toMatchObject({ status: 200 })
    expect((await r.call<AgentLogin[]>("GET", "/api/logins")).map((l) => l.label)).toEqual(["Credentials"])
  })

  it("hand new task sessions and Coordinator runs the next login, round robin", async () => {
    const r = await start("oat-global-0001")
    await r.call("POST", "/api/logins", { harness: "claude", label: "A", value: "oat-a-0002" })
    await r.call("POST", "/api/logins", { harness: "claude", label: "B", value: "oat-b-0003" })
    const project = await r.call<Project>("POST", "/api/projects", { name: "app" })
    for (let i = 0; i < 3; i++) await r.runTask(project)
    expect(r.runs()).toEqual(["CLAUDE_CODE_OAUTH_TOKEN=oat-global-0001", "CLAUDE_CODE_OAUTH_TOKEN=oat-a-0002", "CLAUDE_CODE_OAUTH_TOKEN=oat-b-0003"])

    // Each turn's timing names its login.
    const task = await r.runTask(project)
    const turn = r.yard.store.listTaskTurns(task.id).at(-1)!
    expect(turn.login_id).toBeTruthy()
    const timing = await waitFor(() => r.yard.store.listTurnTimings({ since: 0, taskId: task.id }).at(-1), "the turn's timing")
    expect((await r.call<TurnTiming>("GET", `/api/turn-timings/${timing.id}`)).login).toMatchObject({ label: "Credentials", last4: "0001" })

    // The Coordinator takes the next one too, and keeps it for its session's next turns.
    await r.call("POST", "/api/chat", { content: "Hello" })
    await waitFor(() => r.runs(true).length === 1 && !r.yard.orchestrator.busy, "the Coordinator's run")
    await r.call("POST", "/api/chat", { content: "Again" })
    await waitFor(() => r.runs(true).length === 2 && !r.yard.orchestrator.busy, "the Coordinator's second run")
    const [first, second] = r.runs(true)
    expect(first).toBe("CLAUDE_CODE_OAUTH_TOKEN=oat-a-0002")
    expect(second).toBe(first)
  })

  it("carry a turn on to the next login when its login hits its usage limit, and skip it until it resets", async () => {
    const r = await start("oat-limited-0001")
    await r.call("POST", "/api/logins", { harness: "claude", label: "Spare", value: "oat-spare-0002" })
    const project = await r.call<Project>("POST", "/api/projects", { name: "app" })
    const task = await r.runTask(project)
    // (The fake CLI saves no session for a run its limit stopped, so the retry starts a new one from a recap: two runs.)
    const [limited, ...rest] = r.runs()
    expect(limited).toBe("CLAUDE_CODE_OAUTH_TOKEN=oat-limited-0001")
    expect(new Set(rest)).toEqual(new Set(["CLAUDE_CODE_OAUTH_TOKEN=oat-spare-0002"]))
    expect(r.events(task.id).join("\n")).toMatch(/stopped: the Credentials \(…0001\) login hit its usage limit\. It carries on now on the next login/)
    expect(r.yard.store.getTask(task.id)!.status).toBe("idle")

    const credentials = (await r.call<AgentLogin[]>("GET", "/api/logins")).find((l) => l.source === "credentials")!
    expect(credentials.state).toBe("limited")
    // The CLI said when its limit resets (in an hour).
    expect(credentials.limitedUntil).toBeGreaterThan(Date.now() + 50 * 60_000)

    // The next new session skips it.
    await r.runTask(project)
    expect(r.runs().at(-1)).toBe("CLAUDE_CODE_OAUTH_TOKEN=oat-spare-0002")
  })

  it("leave a project whose identity has its own Claude login on that login", async () => {
    const r = await start("oat-global-0001")
    await r.call("POST", "/api/logins", { harness: "claude", label: "A", value: "oat-a-0002" })
    const acme = await r.call<Identity>("POST", "/api/identities", { name: "Acme" })
    await r.call("PUT", `/api/identities/${acme.id}/claude`, { kind: "oauth_token", value: "acme-oauth-0009" })
    const pinned = await r.call<Project>("POST", "/api/projects", { name: "acme-app", identityId: acme.id })
    await r.runTask(pinned)
    await r.runTask(pinned)
    expect(r.runs()).toEqual(["CLAUDE_CODE_OAUTH_TOKEN=acme-oauth-0009", "CLAUDE_CODE_OAUTH_TOKEN=acme-oauth-0009"])
    // It didn't move the rotation: the next Default project's task takes its first login.
    const plain = await r.call<Project>("POST", "/api/projects", { name: "plain" })
    await r.runTask(plain)
    expect(r.runs().at(-1)).toBe("CLAUDE_CODE_OAUTH_TOKEN=oat-global-0001")
  })
})
