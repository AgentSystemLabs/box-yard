import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import { execFileSync } from "node:child_process"
import type { Server } from "node:http"
import os from "node:os"
import path from "node:path"
import { createBoxYard, type BoxYard } from "../server/app.js"
import type { CaptainMessage, ChatMessage, Project, Task } from "../shared/types.js"
import type { RunTarget, RunTargetPick } from "../shared/runTargets.js"
import { freePort, testConfig, tmpDir, waitFor } from "./helpers.js"

// The chats' "@" list of where tasks run (shared/runTargets.ts): the list, the checked pick on a send, the turn's
// prompt, and runs_on enforced on the task tools for that turn, carried to a Captain the Coordinator messages.

interface Running {
  yard: BoxYard
  server: Server
  base: string
  keyHome: string
}
const running: Running[] = []

async function start(): Promise<Running> {
  const port = await freePort()
  const keyHome = tmpDir("run-target-home-")
  const yard = createBoxYard(testConfig({ port }), { webDir: "/nonexistent", machines: { keys: { home: keyHome } } })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r: Running = { yard, server, base: `http://127.0.0.1:${port}`, keyHome }
  running.push(r)
  return r
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function call<T>(r: Running, method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(r.base + url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}

const status = async (r: Running, method: string, url: string, body?: unknown) =>
  (await fetch(r.base + url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status

function sessionPrompts(r: Running, kvKey: string): string[] {
  const id = r.yard.store.getKv(kvKey)
  if (!id) return []
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".fake-claude"), "fake-sessions", `${id}.json`)
  if (!fs.existsSync(file)) return []
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { turns: { prompt: string }[] }).turns.map((t) => t.prompt)
}

const coordinatorIdle = (r: Running) => waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", "/api/orchestrator")).busy, "Coordinator idle", 30_000)
const captainIdle = (r: Running, p: Project) => waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", `/api/projects/${p.id}/captain`)).busy, "Captain idle", 30_000)
const taskNamed = (r: Running, title: string) => waitFor(() => r.yard.store.listTasks().find((t: Task) => t.title === title), `task "${title}"`, 30_000)

async function addMachine(r: Running) {
  // Listing/picking a machine needs a valid key reference, never the developer's running SSH agent.
  const key = path.join(r.keyHome, ".ssh", "test-key")
  fs.mkdirSync(path.dirname(key), { recursive: true, mode: 0o700 })
  if (!fs.existsSync(key)) execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key])
  await call(r, "POST", "/api/machines", { name: "Studio-Mac", host: "studio.local", user: "cody", keyRef: `file:${key}`, labels: ["laptops"], test: false })
}

describe('chat "@" run targets', () => {
  it("lists runners, SSH machines by name and labels, from the real config", async () => {
    const r = await start()
    let list = await call<RunTarget[]>(r, "GET", "/api/run-targets")
    expect(list.map((t) => t.token)).toEqual(expect.arrayContaining(["local", "box"]))
    expect(list.some((t) => t.kind === "machine")).toBe(false)
    // Plain @gpu is the Default GPU cloud; each cloud is listed, with its GPUs under it.
    expect(list.find((t) => t.token === "gpu")?.detail).toBe("Default: RunPod")
    expect(list.find((t) => t.token === "gpu:daytona:h100")).toMatchObject({ kind: "gpu", value: "gpu:daytona:h100", label: "Daytona H100", under: "gpu:daytona" })
    r.yard.settings.update({ gpuProvider: "daytona" })
    const p = await call<Project>(r, "POST", "/api/projects", { name: "vast-project", runner: "gpu", gpuProvider: "vast" })
    expect((await call<RunTarget[]>(r, "GET", "/api/run-targets")).find((t) => t.token === "gpu")?.detail).toBe("Default: Daytona")
    // A Captain's plain @gpu is its project's own cloud.
    expect((await call<RunTarget[]>(r, "GET", `/api/run-targets?project=${p.id}`)).find((t) => t.token === "gpu")?.detail).toBe("Default: Vast.ai")
    const sent = await call<ChatMessage>(r, "POST", "/api/chat", { content: "train @gpu:daytona:h100", runsOn: "gpu:daytona:h100" })
    expect(sent.meta?.runsOn).toEqual({ value: "gpu:daytona:h100", token: "gpu:daytona:h100", label: "Daytona H100" })
    await coordinatorIdle(r)

    await addMachine(r)
    list = await call<RunTarget[]>(r, "GET", "/api/run-targets")
    expect(list.find((t) => t.token === "studio-mac")).toMatchObject({ kind: "machine", value: "label:studio-mac", label: "Studio-Mac", disabled: null })
    expect(list.find((t) => t.token === "label:laptops")).toMatchObject({ kind: "label", value: "label:laptops", detail: "Studio-Mac" })
    expect(list.find((t) => t.token === "ssh")).toMatchObject({ value: "ssh" })

    // Local means a label: @local goes there, and @this-computer is this computer.
    await call(r, "PUT", "/api/machines/settings", { localLabel: "laptops" })
    list = await call<RunTarget[]>(r, "GET", "/api/run-targets")
    expect(list.find((t) => t.token === "local")).toMatchObject({ value: "local", label: "SSH machines labelled laptops" })
    expect(list.find((t) => t.token === "this-computer")).toMatchObject({ value: "this_computer", label: "This computer" })
  })

  it("refuses a pick that isn't on the list, and keeps a good one on the message", async () => {
    const r = await start()
    expect(await status(r, "POST", "/api/chat", { content: "hi", runsOn: "label:nowhere" })).toBe(400)
    expect(await status(r, "POST", "/api/chat", { content: "hi", runsOn: "mars" })).toBe(400)
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    expect(await status(r, "POST", `/api/projects/${p.id}/captain/messages`, { content: "hi", runsOn: "nope" })).toBe(400)
    expect(r.yard.store.listChat(50).filter((m: ChatMessage) => m.role === "user")).toHaveLength(0)

    const sent = await call<ChatMessage>(r, "POST", "/api/chat", { content: "status @box", runsOn: "box" })
    expect(sent.meta?.runsOn).toEqual({ value: "box", token: "box", label: "Upstash box" })
    await coordinatorIdle(r)
  })

  it("the Coordinator's turn says what the owner picked, and its create_task runs there even when it passes no runs_on", async () => {
    const r = await start()
    await addMachine(r)
    await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    await call(r, "POST", "/api/chat", { content: "task demo: Picked machine -- build it @studio-mac", runsOn: "label:studio-mac" })
    const t = await taskNamed(r, "Picked machine")
    expect(t.runsOn).toBe("ssh")
    expect(r.yard.store.getTaskRow(t.id)?.machine_label).toBe("studio-mac")
    await coordinatorIdle(r)
    const prompt = sessionPrompts(r, "orchestrator_session")[0]!
    expect(prompt).toContain('[the owner picked where tasks run for this message: @studio-mac (Studio-Mac), runs_on "label:studio-mac".')
    expect(r.yard.orchestrator.turnPicks).toEqual({ runsOn: null, agent: null })

    // The next message has no pick: its task follows the project.
    await call(r, "POST", "/api/chat", { content: "task demo: No pick -- plain" })
    const plain = await taskNamed(r, "No pick")
    expect(plain.runsOn).toBeNull()
    await coordinatorIdle(r)
  })

  it("carries the pick to a Captain the Coordinator messages, whose create_task gets it", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    await call(r, "POST", "/api/chat", { content: "tell captain demo: task demo: Relayed -- go @box", runsOn: "box" })
    const t = await taskNamed(r, "Relayed")
    expect(t.runsOn).toBe("box")
    const relayed = (await call<CaptainMessage[]>(r, "GET", `/api/projects/${p.id}/captain/messages`)).find((m) => m.role === "user")!
    expect(relayed.meta).toMatchObject({ source: "coordinator", runsOn: { value: "box", token: "box" } })
    await captainIdle(r, p)
    await coordinatorIdle(r)
    expect(sessionPrompts(r, `captain_session:${p.id}`).join("\n")).toContain("[the owner picked where tasks run for this message: @box")
  })

  it("a Captain message's pick wins over the project's runner", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const sent = await call<CaptainMessage>(r, "POST", `/api/projects/${p.id}/captain/messages`, { content: "task demo: Captain picked -- go @local", runsOn: "local" })
    expect(sent.meta?.runsOn).toMatchObject({ value: "local", token: "local", label: "This computer" })
    const t = await taskNamed(r, "Captain picked")
    expect(t.runsOn).toBe("local")
    await captainIdle(r, p)
  })
})

describe('chat "%" project pick', () => {
  it("refuses an unknown project and a Captain's chat, keeps the %token in the text, and tells the Coordinator to route it", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    expect(await status(r, "POST", "/api/chat", { content: "hi %nope", project: "prj_nope" })).toBe(400)
    expect(await status(r, "POST", `/api/projects/${p.id}/captain/messages`, { content: "hi %demo", project: p.id })).toBe(400)
    const sent = await call<ChatMessage>(r, "POST", "/api/chat", { content: "what's open? %demo", project: p.id })
    expect(sent.content).toBe("what's open? %demo")
    expect(sent.meta?.project).toEqual({ value: p.id, token: "demo", label: "demo" })
    await coordinatorIdle(r)
    const prompt = sessionPrompts(r, "orchestrator_session")[0]!
    expect(prompt).toContain(`[the owner picked the project for this message: %demo, project "demo" (${p.id}).`)
    expect(prompt).toContain(`send_to_captain (project "${p.id}")`)
  })
})

describe('chat "@" pick on the task tools', () => {
  /** The Coordinator's MCP tools with a turn's pick, called directly. */
  type Pick = RunTargetPick
  async function tools(r: Running, pick: Pick | null, agent: Pick | null = null) {
    const { buildMcpServer } = await import("../server/mcp.js")
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js")
    const server = buildMcpServer({
      store: r.yard.store,
      tasks: r.yard.tasks,
      hub: r.yard.hub,
      artifacts: null as never,
      publicUrl: () => "",
      scheduler: r.yard.scheduler,
      captains: r.yard.captains,
      settings: r.yard.settings,
      uploads: null as never,
      turnPicks: () => ({ runsOn: pick, agent }),
    })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: "test", version: "0" })
    await client.connect(b)
    return async (name: string, args: Record<string, unknown>) => {
      const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
      if (res.isError) throw new Error(res.content[0]?.text)
      return JSON.parse(res.content[0]!.text)
    }
  }

  it("carries size picks through create_task, batches, and a later move", async () => {
    const r = await start()
    await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const box = await tools(r, { value: "box:medium", token: "box:medium", label: "Upstash Medium" })
    const one = await box("create_task", { project: "demo", title: "Sized", prompt: "x", runs_on: "local" })
    expect(r.yard.store.getTask(one.id)).toMatchObject({ runsOn: "box", boxSize: "medium" })
    const tool = await tools(r, null)
    const batch = await tool("create_tasks", { project: "demo", runs_on: "box-large", tasks: [{ title: "B1", prompt: "x" }, { title: "B2", prompt: "x", runs_on: "daytona:cpu-small" }] })
    expect(r.yard.store.getTask(batch.tasks[0].id)).toMatchObject({ runsOn: "box", boxSize: "large" })
    expect(r.yard.store.getTask(batch.tasks[1].id)).toMatchObject({ runsOn: "gpu", gpu: { provider: "daytona", type: "CPU", size: "cpu-small" } })
    await tool("send_to_task", { task: one.id, message: "continue", runs_on: "daytona-large" })
    expect(r.yard.store.getTask(one.id)).toMatchObject({ runsOn: "gpu", boxSize: null, gpu: { provider: "daytona", type: "CPU", size: "cpu-large" } })
    await tool("send_to_task", { task: one.id, message: "continue", runs_on: "local" })
    expect(r.yard.store.getTask(one.id)).toMatchObject({ runsOn: "local", boxSize: null, gpu: null })
    await expect(tool("create_task", { project: "demo", title: "Invalid", prompt: "x", runs_on: "box:giant" })).rejects.toThrow(/Unknown box size/)
  })

  it("wins over a runs_on the call passes, on create_task, create_tasks and send_to_task, and says so", async () => {
    const r = await start()
    await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const tool = await tools(r, { value: "local", token: "local", label: "This computer" })

    const one = await tool("create_task", { project: "demo", title: "Asked box", prompt: "x", runs_on: "box" })
    expect(r.yard.store.getTask(one.id)?.runsOn).toBe("local")
    expect(one.runs_on_pick).toMatch(/the owner picked @local \(This computer\) for this prompt, so it runs there/)

    const same = await tool("create_task", { project: "demo", title: "No runs_on", prompt: "x" })
    expect(r.yard.store.getTask(same.id)?.runsOn).toBe("local")
    expect(same.runs_on_pick).toMatch(/^@local \(This computer\): the owner's pick/)

    const batch = await tool("create_tasks", { project: "demo", tasks: [{ title: "B1", prompt: "x" }, { title: "B2", prompt: "x", runs_on: "box" }] })
    for (const t of batch.tasks) expect(r.yard.store.getTask(t.id)?.runsOn).toBe("local")
    expect(batch.runs_on_pick).toMatch(/so it runs there/)

    const other = await (await tools(r, null))("create_task", { project: "demo", title: "Elsewhere", prompt: "x", runs_on: "box" })
    expect(r.yard.store.getTask(other.id)?.runsOn).toBe("box")
    const moved = await tool("send_to_task", { task: other.id, message: "carry on" })
    expect(r.yard.store.getTask(other.id)?.runsOn).toBe("local")
    expect(moved.runs_on_pick).toMatch(/the owner's pick/)
  })

  it("a ! pick wins over the agent and drops the other CLI's model; send_to_task keeps a task's agent and says so", async () => {
    const r = await start()
    await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const codex = { value: "codex", token: "codex", label: "Codex" }
    const tool = await tools(r, null, codex)

    const one = await tool("create_task", { project: "demo", title: "Asked claude", prompt: "x", agent: "claude", model: "opus" })
    expect(r.yard.store.getTask(one.id)).toMatchObject({ agentCli: "codex", model: null })
    expect(one.agent_pick).toMatch(/the owner picked !codex \(Codex\) for this prompt, so it runs on that/)

    const batch = await tool("create_tasks", { project: "demo", tasks: [{ title: "C1", prompt: "x" }, { title: "C2", prompt: "x", agent: "claude" }] })
    for (const t of batch.tasks) expect(r.yard.store.getTask(t.id)?.agentCli).toBe("codex")
    expect(batch.agent_pick).toMatch(/not the agent or model you asked for/)

    const claudeTask = await (await tools(r, null))("create_task", { project: "demo", title: "On Claude", prompt: "x" })
    expect(r.yard.store.getTask(claudeTask.id)?.agentCli).toBe("claude")
    const sent = await tool("send_to_task", { task: claudeTask.id, message: "carry on" })
    expect(r.yard.store.getTask(claudeTask.id)?.agentCli).toBe("claude")
    expect(sent.agent_pick).toMatch(/runs on Claude Code.*continue_task.*Do not create a replacement task/)
  })

  it("writes explicit model/effort picks into individual and batched tasks, while plain picks retain Settings defaults", async () => {
    const r = await start()
    await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const codex: Pick = { value: "codex", token: "codex:gpt-6.1-sol:ultra", label: "Codex · GPT-6.1 Sol · Ultra", model: "gpt-6.1-sol", effort: "ultra" }
    const tool = await tools(r, null, codex)
    const one = await tool("create_task", { project: "demo", title: "Explicit", prompt: "x", model: "gpt-6-astra", effort: "low" })
    expect(r.yard.store.getTask(one.id)).toMatchObject({ agentCli: "codex", model: "gpt-6.1-sol", effort: "ultra" })
    const batch = await tool("create_tasks", { project: "demo", effort: "low", tasks: [{ title: "Explicit B1", prompt: "x" }, { title: "Explicit B2", prompt: "x", model: "opus", effort: "high" }] })
    for (const t of batch.tasks) expect(r.yard.store.getTask(t.id)).toMatchObject({ agentCli: "codex", model: "gpt-6.1-sol", effort: "ultra" })
    const plain = await (await tools(r, null, { value: "codex", token: "codex", label: "Codex" }))("create_task", { project: "demo", title: "Default", prompt: "x", model: "gpt-6-astra", effort: "low" })
    expect(r.yard.store.getTask(plain.id)).toMatchObject({ agentCli: "codex", model: null, effort: null })
    const cursor = await (await tools(r, null, { value: "cursor", token: "cursor:auto", label: "Cursor · Auto", model: "auto" }))("create_task", { project: "demo", title: "Cursor", prompt: "x", effort: "high" })
    expect(r.yard.store.getTask(cursor.id)).toMatchObject({ agentCli: "cursor", model: "auto", effort: null })
  })
})

describe('chat "!" harness picks', () => {
  it("lists every harness on SSH machines", async () => {
    const r = await start()
    expect((await call<RunTarget[]>(r, "GET", "/api/harness-targets")).map((t) => [t.token, t.disabled])).toEqual([
      ["claude", null],
      ["codex", null],
      ["cursor", null],
    ])
    await addMachine(r)
    const onAir = await call<RunTarget[]>(r, "GET", "/api/harness-targets?runsOn=label%3Astudio-mac")
    expect(onAir.find((t) => t.token === "codex")?.disabled).toBeNull()
    expect(onAir.find((t) => t.token === "claude")?.disabled).toBeNull()
  })

  it("refuses a harness that isn't on the list or can't go with the @ pick, and keeps a good one", async () => {
    const r = await start()
    await addMachine(r)
    expect(await status(r, "POST", "/api/chat", { content: "hi", agent: "gpt" })).toBe(400)
    expect(r.yard.store.listChat(50).filter((m: ChatMessage) => m.role === "user")).toHaveLength(0)
    const sent = await call<ChatMessage>(r, "POST", "/api/chat", { content: "status !codex @box", agent: "codex", runsOn: "box" })
    expect(sent.meta).toMatchObject({ agent: { value: "codex", token: "codex", label: "Codex" }, runsOn: { value: "box" } })
    await coordinatorIdle(r)
    const onSsh = await call<ChatMessage>(r, "POST", "/api/chat", { content: "status !codex @studio-mac", agent: "codex", runsOn: "label:studio-mac" })
    expect(onSsh.meta).toMatchObject({ agent: { value: "codex" }, runsOn: { value: "label:studio-mac" } })
    await coordinatorIdle(r)
  })

  it("the Coordinator's create_task gets the picked harness, and a Captain it messages gets the pick too", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    await call(r, "POST", "/api/chat", { content: "task demo: Picked codex -- build it !codex", agent: "codex" })
    const t = await taskNamed(r, "Picked codex")
    expect(t.agentCli).toBe("codex")
    await coordinatorIdle(r)
    expect(sessionPrompts(r, "orchestrator_session")[0]).toContain('[the owner picked the harness for this message: !codex (Codex), agent "codex".')
    expect(r.yard.orchestrator.turnPicks).toEqual({ runsOn: null, agent: null })

    await call(r, "POST", "/api/chat", { content: "tell captain demo: task demo: Relayed codex -- go", agent: "codex", runsOn: "box" })
    const relayedTask = await taskNamed(r, "Relayed codex")
    expect(relayedTask).toMatchObject({ agentCli: "codex", runsOn: "box" })
    const relayed = (await call<CaptainMessage[]>(r, "GET", `/api/projects/${p.id}/captain/messages`)).find((m) => m.role === "user")!
    expect(relayed.meta).toMatchObject({ source: "coordinator", agent: { value: "codex" }, runsOn: { value: "box" } })
    await captainIdle(r, p)
    await coordinatorIdle(r)
    expect(sessionPrompts(r, `captain_session:${p.id}`).join("\n")).toContain("[the owner picked the harness for this message: !codex")
  })
})

describe("picks typed for only part of a message (inline)", () => {
  const hint = (kind: "runsOn" | "agent" | "project", value: string, where: string | null = 'item 2 ("Port the pickaxe")', reason = "item") => ({ kind, value, where, reason })

  it("checks them, keeps them on the message with the list's labels, and refuses one that isn't on the lists", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    expect(await status(r, "POST", "/api/chat", { content: "hi", inline: [hint("agent", "gpt")] })).toBe(400)
    expect(await status(r, "POST", "/api/chat", { content: "hi", inline: [hint("runsOn", "mars")] })).toBe(400)
    expect(await status(r, "POST", "/api/chat", { content: "hi", inline: [hint("project", "prj_nope")] })).toBe(400)
    expect(await status(r, "POST", `/api/projects/${p.id}/captain/messages`, { content: "hi", inline: [hint("project", p.id)] })).toBe(400)
    expect(r.yard.store.listChat(50).filter((m: ChatMessage) => m.role === "user")).toHaveLength(0)
    const sent = await call<ChatMessage>(r, "POST", "/api/chat", { content: "status", inline: [hint("agent", "codex"), hint("runsOn", "local", null, "mixed"), hint("project", p.id)] })
    expect(sent.meta?.inlinePicks).toEqual([
      { kind: "agent", value: "codex", token: "codex", label: "Codex", where: 'item 2 ("Port the pickaxe")', reason: "item" },
      { kind: "runsOn", value: "local", token: "local", label: "This computer", where: null, reason: "mixed" },
      { kind: "project", value: p.id, token: "demo", label: "demo", where: 'item 2 ("Port the pickaxe")', reason: "item" },
    ])
    expect(sent.meta?.runsOn).toBeUndefined()
    expect(sent.meta?.agent).toBeUndefined()
    // A harness hint keeps the model and effort typed after it (%405's "!codex:<model>:<effort>").
    expect(await status(r, "POST", "/api/chat", { content: "hi", inline: [hint("agent", "codex:no-such-model")] })).toBe(400)
    const chosen = await call<ChatMessage>(r, "POST", "/api/chat", { content: "go", inline: [hint("agent", "codex:gpt-6.1-sol:xhigh")] })
    expect(chosen.meta?.inlinePicks).toEqual([expect.objectContaining({ kind: "agent", value: "codex", token: "codex:gpt-6.1-sol:xhigh", model: "gpt-6.1-sol", effort: "xhigh" })])
    await coordinatorIdle(r)
  })

  it("the Coordinator's turn lists them and applies none; a Captain it messages gets no pick from them", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    await call(r, "POST", "/api/chat", { content: "tell captain demo: task demo: Relayed hint -- go !codex @local", inline: [hint("agent", "codex"), hint("runsOn", "local")] })
    const t = await taskNamed(r, "Relayed hint")
    // Neither the Captain's create_task nor its runner was forced by the inline picks, nor by the tokens it quotes.
    expect(t).toMatchObject({ agentCli: "claude", runsOn: null })
    const relayed = (await call<CaptainMessage[]>(r, "GET", `/api/projects/${p.id}/captain/messages`)).find((m) => m.role === "user")!
    expect(relayed.meta).toMatchObject({ source: "coordinator" })
    expect(relayed.meta).not.toHaveProperty("agent")
    expect(relayed.meta).not.toHaveProperty("runsOn")
    expect(relayed.meta).not.toHaveProperty("inlinePicks")
    await captainIdle(r, p)
    await coordinatorIdle(r)
    const prompt = sessionPrompts(r, "orchestrator_session")[0]!
    expect(prompt).toContain('[the owner typed picks for only part of this message, so Box Yard applies none of them to this turn: !codex (Codex, agent "codex") in item 2 ("Port the pickaxe"); @local (This computer, runs_on "local") in item 2')
    expect(prompt).toContain("Box Yard doesn't carry these to Captains.]")
    expect(prompt).not.toContain("[the owner picked")
    expect(sessionPrompts(r, `captain_session:${p.id}`).join("\n")).not.toContain("[the owner picked")
  })

  it("a picker pick for the whole message still applies, and still reaches the Captain, beside an item's hint", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    await call(r, "POST", "/api/chat", { content: "task demo: Whole box -- go @box", runsOn: "box", inline: [hint("agent", "codex")] })
    expect(await taskNamed(r, "Whole box")).toMatchObject({ runsOn: "box", agentCli: "claude" })
    await coordinatorIdle(r)
    const prompt = sessionPrompts(r, "orchestrator_session")[0]!
    expect(prompt).toContain('[the owner picked where tasks run for this message: @box (Upstash box), runs_on "box".')
    expect(prompt).toContain("[the owner typed picks for only part of this message")

    await call(r, "POST", "/api/chat", { content: "tell captain demo: task demo: Relayed box -- go", runsOn: "box", inline: [hint("agent", "codex")] })
    expect(await taskNamed(r, "Relayed box")).toMatchObject({ runsOn: "box", agentCli: "claude" })
    const relayed = (await call<CaptainMessage[]>(r, "GET", `/api/projects/${p.id}/captain/messages`)).find((m) => m.role === "user")!
    expect(relayed.meta).toMatchObject({ source: "coordinator", runsOn: { value: "box" } })
    expect(relayed.meta).not.toHaveProperty("agent")
    await captainIdle(r, p)
    await coordinatorIdle(r)
  })

  it("a whole-message pick that an item's hint disagrees with isn't applied either", async () => {
    const r = await start()
    await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    await call(r, "POST", "/api/chat", { content: "task demo: Exception -- go", runsOn: "box", inline: [hint("runsOn", "local")] })
    expect(await taskNamed(r, "Exception")).toMatchObject({ runsOn: null })
    await coordinatorIdle(r)
  })

  it('an item\'s "%" is only that item\'s: the Coordinator isn\'t told the whole message is that project\'s', async () => {
    const r = await start()
    const demo = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const web = await call<Project>(r, "POST", "/api/projects", { name: "web" })
    await call(r, "POST", "/api/chat", { content: "status of both", inline: [hint("project", web.id)] })
    await coordinatorIdle(r)
    // A "%" over the list that an item's other "%" contradicts isn't the message's either.
    await call(r, "POST", "/api/chat", { content: "status of both again", project: demo.id, inline: [hint("project", web.id)] })
    await coordinatorIdle(r)
    const prompts = sessionPrompts(r, "orchestrator_session").join("\n")
    expect(prompts).not.toContain("[the owner picked the project")
    expect(prompts).toContain(`[the owner typed picks for only part of this message, so Box Yard applies none of them to this turn: %web (web, project "${web.id}") in item 2 ("Port the pickaxe").`)
    expect(prompts).toContain(`%demo (demo, project "${demo.id}") outside any list item, with another of its kind in the message; %web (web, project "${web.id}") in item 2`)
  })

  it("a Captain's message lists them too, without the relay sentence, and applies none", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    const sent = await call<CaptainMessage>(r, "POST", `/api/projects/${p.id}/captain/messages`, { content: "task demo: Captain hint -- go", inline: [hint("agent", "codex")] })
    expect(sent.meta?.inlinePicks).toHaveLength(1)
    expect(await taskNamed(r, "Captain hint")).toMatchObject({ agentCli: "claude" })
    await captainIdle(r, p)
    const prompt = sessionPrompts(r, `captain_session:${p.id}`).join("\n")
    expect(prompt).toContain('!codex (Codex, agent "codex") in item 2')
    expect(prompt).not.toContain("Box Yard doesn't carry these to Captains")
  })
})
