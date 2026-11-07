// Steer for a task's queued messages: POST /api/tasks/:id/queue/steer, deliver_queued_now and send_to_task steer.
// The messages go into the running turn without stopping it: the server writes a steer file to the task's folder,
// the runner writes it into Claude's open stream-json stdin, and the (fake) CLI reads it at its next step. A steer
// that misses the turn goes in as the next turn. Codex uses app-server; Cursor waits with a note.
import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { buildMcpServer, type McpCaller } from "../server/mcp.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import type { BoxProvider } from "../server/providers/types.js"
import type { Project, SteerDelivery, Task } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

interface Running {
  yard: BoxYard
  server: Server
  base: string
  dataDir: string
}
const running: Running[] = []
const clients: { close(): Promise<void> }[] = []

async function start(): Promise<Running> {
  const port = await freePort()
  const config = testConfig({ port })
  const yard = createBoxYard(config, { webDir: "/nonexistent" })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r = { yard, server, base: `http://127.0.0.1:${port}`, dataDir: config.dataDir }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const r of running.splice(0)) {
    // Stop hanging turns so the database isn't closed under them.
    for (const t of r.yard.store.listTasks()) if (t.status === "working" || t.status === "starting") await r.yard.tasks.stopTask(t.id).catch(() => {})
    await waitFor(() => r.yard.store.listTasks().every((t) => !["starting", "working"].includes(t.status) && !r.yard.store.getTaskRow(t.id)?.current_turn_id), "agents idle", 30_000)
    await waitFor(() => !(r.yard.tasks as unknown as { archiving: Set<string> }).archiving.size, "turn-end archives finished", 30_000)
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function raw(r: Running, method: string, p: string, body?: unknown) {
  const res = await fetch(r.base + p, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, data: (await res.json()) as unknown }
}
async function call<T>(r: Running, method: string, p: string, body?: unknown): Promise<T> {
  const res = await raw(r, method, p, body)
  if (res.status >= 400) throw new Error(`${method} ${p} -> ${res.status}: ${JSON.stringify(res.data)}`)
  return res.data as T
}
type Steer = { task: Task; delivery: SteerDelivery; queued: number; note?: string }
const getTask = (r: Running, id: string) => call<Task>(r, "GET", `/api/tasks/${id}`)
const send = (r: Running, id: string, content: string) => call<Task>(r, "POST", `/api/tasks/${id}/messages`, { content })
const steer = (r: Running, id: string) => call<Steer>(r, "POST", `/api/tasks/${id}/queue/steer`, {})
const taskDir = (r: Running, t: Task) => path.join(r.dataDir, "local-boxes", t.boxId!, "tasks", t.id)
const turnJson = (r: Running, t: Task) => JSON.parse(fs.readFileSync(path.join(taskDir(r, t), "turn.json"), "utf8")) as { turnId: string; prompt: string; sessionId: string; resume: boolean }
/** The fake CLI's record of a session: each turn's prompt, and the steers it read. */
const session = (id: string) =>
  JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".fake-claude"), "fake-sessions", `${id}.json`), "utf8")) as {
    turns: { prompt: string; result: string; steers?: string[] }[]
  }
const turns = (r: Running, taskId: string) =>
  (r.yard.store.db.prepare("SELECT status FROM task_turns WHERE task_id = ? ORDER BY turn_index, started_at").all(taskId) as { status: string }[]).map((x) => x.status)
const lines = (r: Running, taskId: string) => r.yard.store.listTaskMessages(taskId, 200)
const said = (r: Running, taskId: string, role: string) => lines(r, taskId).filter((m) => m.role === role).map((m) => m.content)
const steerFiles = (r: Running, t: Task) => fs.readdirSync(taskDir(r, t)).filter((f) => f.startsWith("steer-"))
const resting = (t: Task) => !["queued", "starting", "working"].includes(t.status)
const providerOf = (r: Running) => (r.yard.tasks as unknown as { provider: BoxProvider }).provider

/** A task whose first turn has finished, then a second turn `second` (by default one that hangs until a steer or a stop). */
async function busyTask(r: Running, second = "now polish it [hang]", project: Record<string, unknown> = {}) {
  const p = await call<Project>(r, "POST", "/api/projects", { name: "alpha", ...project })
  const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Haiku", prompt: "write a haiku" })
  await waitFor(async () => (await getTask(r, t.id)).status === "idle", "first turn")
  await send(r, t.id, second)
  await waitFor(async () => {
    const x = await getTask(r, t.id)
    return x.status === "working" && x.turnCount === 2
  }, "second turn runs")
  const busy = await getTask(r, t.id)
  return { p, t: busy, before: turnJson(r, busy) }
}

/** The task has run turn `n` to its end (resting again). */
const ranTurn = (r: Running, id: string, n: number) =>
  waitFor(async () => {
    const x = await getTask(r, id)
    return x.turnCount >= n && resting(x) && !x.pendingCount ? x : null
  }, `turn ${n} done`, 30_000)

describe("Steer", () => {
  it("steers a Codex task in the same session through app-server once", async () => {
    const r = await start()
    const { t, before } = await busyTask(r, "now polish it [hang]", { agentCli: "codex" })
    await send(r, t.id, "also add a title")
    expect(await steer(r, t.id)).toMatchObject({ delivery: "steering", queued: 1 })
    const done = await ranTurn(r, t.id, 2)
    expect(done.sessionId).toBe(before.sessionId)
    expect(turns(r, t.id)).toEqual(["idle", "idle"])
    const mine = lines(r, t.id).filter((m) => m.role === "user" && m.content === "also add a title")
    expect(mine).toHaveLength(1)
    expect(mine[0]!.meta).toMatchObject({ steered: true, steerAccepted: true })
    expect(said(r, t.id, "assistant").join("\n")).toContain("Steered mid-turn")
  })

  it("recovers lost Codex acknowledgment events from the completed worker journal", async () => {
    const r = await start()
    const apply = r.yard.tasks.apply.bind(r.yard.tasks)
    r.yard.tasks.apply = async (id, ev) => { if (ev.t !== "codex_delivery") await apply(id, ev) }
    const { t } = await busyTask(r, "now polish it [hang]", { agentCli: "codex" })
    await send(r, t.id, "recover my follow up")
    await steer(r, t.id)
    await ranTurn(r, t.id, 2)
    expect(lines(r, t.id).filter((m) => m.content === "recover my follow up")).toMatchObject([{ meta: { steerAccepted: true } }])
    expect(r.yard.tasks.listQueue(t.id)).toEqual([])
    expect(turns(r, t.id)).toEqual(["idle", "idle"])
  })

  it("carries a stale-turn rejection into exactly one new Codex turn", async () => {
    const r = await start()
    const { t } = await busyTask(r, "now polish it [hang]", { agentCli: "codex", env: { FAKE_CODEX_STEER: "stale" } })
    await send(r, t.id, "run this after the completed turn")
    await steer(r, t.id)
    await ranTurn(r, t.id, 3)
    expect(turns(r, t.id)).toEqual(["idle", "queued", "idle"])
    expect(lines(r, t.id).filter((m) => m.content === "run this after the completed turn")).toHaveLength(1)
    expect(said(r, t.id, "assistant").join("\n")).not.toContain("Steered mid-turn")
  })

  it("holds an uncertain Codex submission instead of retrying or declaring it ready", async () => {
    const r = await start()
    const { t } = await busyTask(r, "now polish it [hang]", { agentCli: "codex", env: { FAKE_CODEX_STEER: "disconnect" } })
    const events: string[] = []
    r.yard.tasks.subscribe((event) => { if (event.taskId === t.id) events.push(event.type) })
    r.yard.store.updateTask(t.id, { prUrl: "https://github.com/acme/example/pull/12", prState: "open" })
    await send(r, t.id, "also add a title")
    await r.yard.tasks.apply(t.id, { t: "finish", turnId: turnJson(r, t).turnId, summary: "Premature finish" })
    expect(r.yard.store.turnFlags(r.yard.store.getTaskRow(t.id)!).finished).toBeUndefined()
    await steer(r, t.id)
    await waitFor(() => !r.yard.store.getTaskRow(t.id)?.current_turn_id, "disconnected turn ends")
    expect(r.yard.store.getTask(t.id)).toMatchObject({ status: "needs_input", pendingCount: 1, turnCount: 2 })
    const held = r.yard.tasks.listQueue(t.id)[0]!
    expect(held.status).toBe("uncertain")
    expect(events).not.toContain("task.pr_ready")
    expect(events).not.toContain("task.finished")
    // Startup recovery and ordinary claiming must not silently replay a possibly accepted message.
    r.yard.store.releaseInputs()
    expect(r.yard.store.claimInputs(t.id, "turn_unused")).toEqual([])
    expect((await raw(r, "PATCH", `/api/tasks/${t.id}/queue/${held.id}`, { text: "changed" })).status).toBe(409)
    expect((await raw(r, "DELETE", `/api/tasks/${t.id}/queue/${held.id}`)).status).toBe(200)
    expect((await raw(r, "POST", `/api/tasks/${t.id}/queue/${held.id}/restore`)).status).toBe(409)
    expect(r.yard.tasks.listQueue(t.id)).toEqual([])
  })

  it("hands every queued message to the running turn at its next step, without stopping it", async () => {
    const r = await start()
    const { t, before } = await busyTask(r)
    await send(r, t.id, "first: use blue")
    await send(r, t.id, "second: add a footer")
    expect((await getTask(r, t.id)).pendingCount).toBe(2)

    const res = await steer(r, t.id)
    expect(res).toMatchObject({ delivery: "steering", queued: 2 })
    const done = await ranTurn(r, t.id, 2)
    // The same turn read them and carried on: nothing was stopped and no turn was added.
    expect(done.turnCount).toBe(2)
    expect(turns(r, t.id)).toEqual(["idle", "idle"])
    expect(turnJson(r, done).turnId).toBe(before.turnId)

    // The CLI read both, in send order, in that turn.
    const read = session(before.sessionId).turns.at(-1)!
    expect(read.prompt).toContain("now polish it")
    expect(read.steers).toHaveLength(1)
    expect(read.steers![0]!.indexOf("first: use blue")).toBeGreaterThan(-1)
    expect(read.steers![0]!.indexOf("first: use blue")).toBeLessThan(read.steers![0]!.indexOf("second: add a footer"))
    expect(said(r, t.id, "assistant").some((m) => m.includes("Steered mid-turn: second: add a footer"))).toBe(true)

    // The transcript has them where they landed, marked steered.
    const users = lines(r, t.id).filter((m) => m.role === "user").slice(-2)
    expect(users.map((m) => m.content)).toEqual(["first: use blue", "second: add a footer"])
    for (const m of users) expect(m.meta).toMatchObject({ steered: true })
    const events = said(r, t.id, "event")
    expect(events.some((e) => /^Cody requested steering all 2 queued messages into the running turn; delivery has not been acknowledged yet/.test(e))).toBe(true)
    expect(events.some((e) => /Stopped by Cody|didn't reach the agent/.test(e))).toBe(false)
    expect(steerFiles(r, done)).toEqual([])
  }, 60_000)

  it("goes in as the next turn when the turn ends before the steer reaches the box", async () => {
    const r = await start()
    const { t } = await busyTask(r, "now polish it [slow:2] [pr]")
    await send(r, t.id, "also add a title [pr]")

    // Hold the steer's file until the turn it was meant for has ended.
    const provider = providerOf(r)
    const writeFile = provider.writeFile.bind(provider)
    let landed = false
    provider.writeFile = async (boxId, file, content) => {
      if (/\/steer-[\w-]+\.json$/.test(file)) {
        await waitFor(() => (turns(r, t.id)[1] ?? "started") !== "started", "the steered turn ends", 30_000)
        landed = true
      }
      return writeFile(boxId, file, content)
    }
    // The request waits for the box, and the message is locked meanwhile.
    const asked = steer(r, t.id)
    await waitFor(() => r.yard.tasks.listQueue(t.id).some((m) => m.status === "steering"), "the steer is on its way")
    expect(await asked).toMatchObject({ delivery: "steering", queued: 1 })
    expect(landed).toBe(true)
    const done = await ranTurn(r, t.id, 3)
    // Nothing was lost: it ran as one more turn, once, and isn't marked steered.
    expect(turns(r, t.id)).toEqual(["idle", "queued", "idle"])
    expect(turnJson(r, done).prompt).toContain("also add a title")
    const mine = lines(r, t.id).filter((m) => m.role === "user" && m.content === "also add a title [pr]")
    expect(mine).toHaveLength(1)
    expect(mine[0]!.meta?.steered).toBeUndefined()
    expect(said(r, t.id, "event")).toContain("The steer didn't reach the agent before its turn ended, so it goes in as the next turn.")
  }, 60_000)

  it("runs a steer that comes in as the CLI finishes as a follow-up in the same turn", async () => {
    const r = await start()
    // [tail:3]: the turn's work is over (its reply is out), but its result isn't yet.
    const { t, before } = await busyTask(r, "now polish it [tail:3] [pr]")
    await waitFor(() => said(r, t.id, "assistant").filter((m) => m.startsWith("Done for now")).length === 2, "the turn's last reply")
    await send(r, t.id, "also add a title [pr]")
    expect(await steer(r, t.id)).toMatchObject({ delivery: "steering", queued: 1 })

    const done = await ranTurn(r, t.id, 2)
    // One Box Yard turn: the CLI ran the steer as a turn of its own before it exited.
    expect(turns(r, t.id)).toEqual(["idle", "idle"])
    expect(lines(r, t.id).find((m) => m.role === "user" && m.content === "also add a title [pr]")?.meta).toMatchObject({ steered: true })
    const runs = session(before.sessionId).turns
    expect(runs).toHaveLength(3)
    expect(runs[2]!.prompt).toContain("also add a title")
    expect(said(r, t.id, "event").some((e) => /didn't reach the agent/.test(e))).toBe(false)
    expect(steerFiles(r, done)).toEqual([])
  }, 60_000)

  it("waits for the turn's end with a note on a Cursor agent, which can't take a message mid-turn", async () => {
    const r = await start()
    const { t } = await busyTask(r, "now polish it [hang]", { agentCli: "cursor", env: { CURSOR_API_KEY: "sk-proj-steer-0000000000000000" } })
    await send(r, t.id, "also add a title")
    const res = await steer(r, t.id)
    expect(res).toMatchObject({ delivery: "after_turn", queued: 1 })
    expect(res.note).toMatch(/Cursor can't take a message in the middle of a turn/)
    expect(said(r, t.id, "event").some((e) => /^Cody asked to steer the queued message into the running turn, but Cursor can't/.test(e))).toBe(true)
    // Never a silent stop: the turn still runs, and the message is still queued (and editable).
    expect(await getTask(r, t.id)).toMatchObject({ status: "working", pendingCount: 1 })
    expect(r.yard.tasks.listQueue(t.id).map((m) => m.status)).toEqual(["queued"])

    await r.yard.tasks.stopTask(t.id)
    const done = await ranTurn(r, t.id, 3)
    expect(turns(r, t.id)).toEqual(["idle", "stopped", "idle"])
    expect(turnJson(r, done).prompt).toContain("also add a title")
  }, 60_000)

  it("waits for the turn's end the same way on a Cursor agent", async () => {
    const r = await start()
    const { t } = await busyTask(r, "now polish it [hang]", { agentCli: "cursor" })
    await send(r, t.id, "also add a title")
    const res = await steer(r, t.id)
    expect(res).toMatchObject({ delivery: "after_turn", queued: 1 })
    expect(res.note).toMatch(/Cursor can't take a message in the middle of a turn/)
    expect(said(r, t.id, "event").some((e) => /^Cody asked to steer the queued message into the running turn, but Cursor can't/.test(e))).toBe(true)
    expect(await getTask(r, t.id)).toMatchObject({ status: "working", pendingCount: 1 })

    await r.yard.tasks.stopTask(t.id)
    const done = await ranTurn(r, t.id, 3)
    expect(turns(r, t.id)).toEqual(["idle", "stopped", "idle"])
    expect(turnJson(r, done).prompt).toContain("also add a title")
  }, 60_000)

  it("gives the messages back to the queue with a note when the box can't take the steer", async () => {
    const r = await start()
    const { t } = await busyTask(r)
    await send(r, t.id, "also add a title")
    const provider = providerOf(r)
    const writeFile = provider.writeFile.bind(provider)
    provider.writeFile = async (boxId, file, content) => {
      if (/\/steer-[\w-]+\.json$/.test(file)) throw new Error("box unreachable")
      return writeFile(boxId, file, content)
    }
    const res = await steer(r, t.id)
    expect(res).toMatchObject({ delivery: "after_turn", queued: 1 })
    expect(res.note).toMatch(/^the box couldn't be reached \(box unreachable\)/)
    expect(r.yard.tasks.listQueue(t.id).map((m) => m.status)).toEqual(["queued"])
    expect(said(r, t.id, "event").some((e) => /^The steer didn't reach the agent: the box couldn't be reached/.test(e))).toBe(true)
    expect((await getTask(r, t.id)).status).toBe("working")
  }, 60_000)

  it("on a task with no running turn, behaves like a normal send", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "alpha" })
    const t = await call<Task>(r, "POST", "/api/tasks", { projectId: p.id, title: "Haiku", prompt: "write a haiku" })
    await waitFor(async () => (await getTask(r, t.id)).status === "idle", "first turn")
    // Nothing queued: nothing to do.
    expect(await steer(r, t.id)).toMatchObject({ delivery: "already_delivered", queued: 0 })

    // Queued behind a launch that is waiting (no turn runs yet): it just goes out with that turn.
    const provider = providerOf(r)
    const wake = provider.wake.bind(provider)
    let open!: () => void
    const gate = new Promise<void>((res) => (open = res))
    provider.wake = async (boxId) => (await gate, wake(boxId))
    await send(r, t.id, "add a title")
    expect(await steer(r, t.id)).toMatchObject({ delivery: "next_turn", queued: 1 })
    open()
    const done = await ranTurn(r, t.id, 2)
    expect(turns(r, t.id)).toEqual(["idle", "idle"])
    expect(lines(r, t.id).some((m) => m.meta?.kind === "steer" || m.meta?.steered)).toBe(false)
    expect(turnJson(r, done).prompt).toContain("add a title")
  }, 60_000)

  it("steers a merge turn too, telling the agent to settle the merge first", async () => {
    const r = await start()
    const { t, before } = await busyTask(r)
    await send(r, t.id, "also bump the version")
    const PR = "https://github.com/acme/shop/pull/12"
    r.yard.store.updateTask(t.id, { prUrl: PR, prState: "open" })
    r.yard.store.updateTask(t.id, { mergeRequest: { prNumber: 12, prUrl: PR, requestedAt: Date.now(), deliveredAt: Date.now(), inputId: "in_gone01", requestedBy: null } })

    expect(await steer(r, t.id)).toMatchObject({ delivery: "steering", queued: 1 })
    await ranTurn(r, t.id, 2)
    expect(turns(r, t.id)).toEqual(["idle", "pr_ready"])
    const text = session(before.sessionId).turns.at(-1)!.steers![0]!
    expect(text).toMatch(/^Box Yard notice:\n\nYou are merging PR #12 in this turn\. Settle the merge first/)
    expect(text).toContain("also bump the version")
  }, 60_000)
})

describe("Steer over MCP", () => {
  type ToolRes = { content: { text: string }[]; isError?: boolean }
  async function mcpAs(r: Running, caller: McpCaller) {
    const y = r.yard
    const deps = { store: y.store, tasks: y.tasks, hub: y.hub, artifacts: null as never, publicUrl: () => "", scheduler: y.scheduler, captains: y.captains, settings: y.settings, notes: y.notes, uploads: new Uploads(uploadsDir(r.dataDir), 1024 * 1024) }
    const mcp = buildMcpServer(deps, caller)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await mcp.connect(a)
    const client = new Client({ name: "test", version: "0" })
    await client.connect(b)
    clients.push({ close: async () => (await client.close(), await mcp.close()) })
    return async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolRes
  }

  it("send_to_task steer: true steers the queue with the new message into the running turn", async () => {
    const r = await start()
    const { t, before } = await busyTask(r)
    await send(r, t.id, "from Cody: keep it short")
    const tool = await mcpAs(r, { kind: "coordinator" })
    const res = await tool("send_to_task", { task: t.id, message: "from the Coordinator: rename it", steer: true })
    expect(res.isError).toBeFalsy()
    expect(JSON.parse(res.content[0]!.text).delivery).toMatch(/^steering: delivery requested for all 2 queued messages, in order/)

    await ranTurn(r, t.id, 2)
    expect(turns(r, t.id)).toEqual(["idle", "idle"])
    const text = session(before.sessionId).turns.at(-1)!.steers![0]!
    expect(text.indexOf("keep it short")).toBeLessThan(text.indexOf("rename it"))
    expect(said(r, t.id, "event").some((e) => /^The Coordinator requested steering all 2 queued messages into the running turn/.test(e))).toBe(true)
  }, 60_000)

  it("deliver_queued_now and send_to_task interrupt steer, Captain-scoped, a merge turn included", async () => {
    const r = await start()
    const { p, t, before } = await busyTask(r)
    const PR = "https://github.com/acme/shop/pull/7"
    r.yard.store.updateTask(t.id, { prUrl: PR, prState: "open", mergeRequest: { prNumber: 7, prUrl: PR, requestedAt: Date.now(), deliveredAt: Date.now(), inputId: "in_gone02", requestedBy: null } })
    await send(r, t.id, "rename the file")

    const other = await call<Project>(r, "POST", "/api/projects", { name: "beta" })
    const outsider = await mcpAs(r, { kind: "captain", projectId: other.id })
    const scoped = await outsider("deliver_queued_now", { task: t.id })
    expect(scoped.isError).toBe(true)
    expect(scoped.content[0]!.text).toMatch(/Out of scope/)
    const scopedSend = await outsider("send_to_task", { task: t.id, message: "and the README", steer: true })
    expect(scopedSend.content[0]!.text).toMatch(/Out of scope/)
    expect((await getTask(r, t.id)).pendingCount).toBe(1)

    const captain = await mcpAs(r, { kind: "captain", projectId: p.id })
    const res = await captain("deliver_queued_now", { task: t.id })
    expect(res.isError).toBeFalsy()
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ queuedMessages: 1, delivery: expect.stringMatching(/^steering:/) })
    await ranTurn(r, t.id, 2)
    expect(lines(r, t.id).find((m) => m.content === "rename the file")?.meta).toMatchObject({ steered: true })
    expect(said(r, t.id, "event").some((e) => /^The project's Captain requested steering the queued message into the running turn/.test(e))).toBe(true)

    // interrupt, the old name for steer, does the same: it no longer stops the turn.
    await send(r, t.id, "now the README [hang]")
    await waitFor(async () => {
      const x = await getTask(r, t.id)
      return x.status === "working" && x.turnCount === 3
    }, "third turn runs")
    const again = await captain("send_to_task", { task: t.id, message: "and the changelog", interrupt: true })
    expect(again.isError).toBeFalsy()
    expect(JSON.parse(again.content[0]!.text).delivery).toMatch(/^steering:/)
    await ranTurn(r, t.id, 3)
    expect(turns(r, t.id)).toEqual(["idle", "pr_ready", "pr_ready"])
    expect(lines(r, t.id).find((m) => m.content === "and the changelog")?.meta).toMatchObject({ steered: true })
    expect(session(before.sessionId).turns.at(-1)!.steers![0]).toContain("and the changelog")
  }, 60_000)
})
