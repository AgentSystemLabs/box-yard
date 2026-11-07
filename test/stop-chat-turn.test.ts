import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { openDb } from "../server/db.js"
import { Hub } from "../server/hub.js"
import { Orchestrator } from "../server/orchestrator.js"
import { CaptainManager } from "../server/captains.js"
import { SettingsStore } from "../server/settings.js"
import { Store } from "../server/store.js"
import { CAPTAIN_STOPPED_REPLY, STOPPED_NOTE } from "../server/stoppedTurn.js"
import { withOwner } from "../shared/owner.js"
import type { CaptainMessage, ChatMessage } from "../shared/types.js"
import { testConfig, tmpDir, waitFor } from "./helpers.js"

// Cody's Stop on a Coordinator or Captain turn (Orchestrator.stopTurn, Captain.stopTurn): the claude process ends,
// the session is kept for the next turn, and the turn is recorded as stopped, not as an error. A queued message
// Cody took back (cancelQueued) never gets a turn.

/** A claude stand-in: logs each run's args and prompt, says it's working, and replies, or with [hang] waits to be killed. */
function fakeClaude(dir: string) {
  const log = path.join(dir, "runs.jsonl")
  const script = path.join(dir, "fake-claude.mjs")
  fs.writeFileSync(
    script,
    `import fs from "node:fs"
let prompt = ""
process.stdin.on("data", (c) => (prompt += c))
process.stdin.on("end", () => {
  const args = process.argv.slice(2)
  const at = Math.max(args.indexOf("--resume"), args.indexOf("--session-id"))
  const session = args[at + 1]
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, prompt }) + "\\n")
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
  out({ type: "system", subtype: "init", session_id: session })
  if (prompt.includes("[hang]")) {
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 600" } }] } })
    setInterval(() => {}, 1000)
    return
  }
  out({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } })
  out({ type: "result", subtype: "success", is_error: false, result: "Done.", session_id: session })
})
`,
  )
  const runs = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { args: string[]; prompt: string })
      : []
  return { bin: `${process.execPath} ${script}`, runs }
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function setup() {
  const dir = tmpDir()
  const fake = fakeClaude(dir)
  const config = testConfig({ claudeBin: fake.bin, orchestratorAutoWake: false })
  const db = openDb(config.dataDir)
  const store = new Store(db)
  const hub = new Hub()
  // What the open chats hear (chat.busy, captain.state), in order.
  const events: { type: string; busy?: boolean; state?: { busy: boolean } }[] = []
  const broadcast = hub.broadcast.bind(hub)
  hub.broadcast = (ev) => {
    events.push(ev as (typeof events)[number])
    broadcast(ev)
  }
  const settings = new SettingsStore(store, config)
  settings.update({ ownerName: "Sam" })
  const project = store.createProject({ name: "Sam's project" })
  return { config, db, store, hub, settings, project, fake, events }
}

const session = (args: string[]) => args[Math.max(args.indexOf("--resume"), args.indexOf("--session-id")) + 1]
const note = withOwner(STOPPED_NOTE, "Sam")

describe("Coordinator: Stop", () => {
  function coordinator() {
    const s = setup()
    const orchestrator = new Orchestrator(s.config, s.store, s.hub, { url: "http://boxyard.invalid/mcp", token: "test" }, s.settings)
    cleanups.push(() => s.db.close(), () => orchestrator.stop())
    const chat = () => s.store.listChat(100) as ChatMessage[]
    return { ...s, orchestrator, chat }
  }

  it("stops the running turn, says so (not an error), and resumes the same session with a note", async () => {
    const { orchestrator, chat, fake, store, events } = coordinator()
    expect(orchestrator.stopTurn()).toBe(false)
    orchestrator.send("Refactor everything [hang]")
    await waitFor(() => fake.runs().length === 1 || null, "the turn to start")
    // Mid-turn it's queued for the next turn, and still runs after the stop.
    orchestrator.send("Then tell me the status")
    const before = events.length
    expect(orchestrator.stopTurn()).toBe(true)
    // The chats show it stopped from the click, while the process is still ending.
    expect(events.slice(before).filter((e) => e.type === "chat.busy")).toEqual([{ type: "chat.busy", busy: false }])
    expect(orchestrator.state().busy).toBe(false)

    await waitFor(() => fake.runs().length === 2 || null, "the queued message's turn")
    await waitFor(() => !orchestrator.busy || null, "idle")
    // The queued message's turn said it was busy again, then idle when it ended.
    expect(events.slice(before).filter((e) => e.type === "chat.busy").map((e) => e.busy)).toEqual([false, true, false])
    const lines = chat()
    const stopped = lines.find((m) => m.meta?.stopped === true)
    expect(stopped).toMatchObject({ role: "error", content: "Stopped by Sam." })
    expect(lines.some((m) => m.content.includes("hit an error"))).toBe(false)

    const [first, second] = fake.runs()
    expect(second!.args).toContain("--resume")
    expect(session(second!.args)).toBe(session(first!.args))
    expect(second!.prompt).toContain(note)
    expect(second!.prompt).toContain("Then tell me the status")
    expect(second!.prompt).not.toContain("Refactor everything")
    // The turn that read the note finished: the one after it doesn't get it again.
    expect(store.getKv("orchestrator_stopped")).toBeNull()
    orchestrator.send("And now?")
    await waitFor(() => fake.runs().length === 3 || null, "a third turn")
    expect(fake.runs()[2]!.prompt).not.toContain(note)
  })

  it("a turn stopped while it's still setting up never starts its process", async () => {
    const { orchestrator, chat, fake } = coordinator()
    orchestrator.send("Hello [hang]")
    expect(orchestrator.stopTurn()).toBe(true)
    await waitFor(() => chat().some((m) => m.meta?.stopped === true) || null, "the stopped line")
    await waitFor(() => !orchestrator.busy || null, "idle")
    expect(fake.runs()).toHaveLength(0)
  })

  it("a queued message Cody took back gets no turn after the stop", async () => {
    const { orchestrator, chat, fake } = coordinator()
    orchestrator.send("Long job [hang]")
    await waitFor(() => fake.runs().length === 1 || null, "the turn to start")
    const queued = orchestrator.send("Never mind this one")
    expect(queued.meta?.queued).toBe(true)
    expect(orchestrator.cancelQueued(queued.id).meta?.cancelled).toBe(true)
    orchestrator.stopTurn()
    await waitFor(() => chat().some((m) => m.meta?.stopped === true) || null, "the stopped line")
    await waitFor(() => !orchestrator.busy || null, "idle")
    expect(fake.runs()).toHaveLength(1)
  })
})

describe("Captain: Stop", () => {
  function captains() {
    const s = setup()
    const manager = new CaptainManager(s.config, s.store, s.hub, { url: "http://boxyard.invalid/mcp", token: "test" }, s.settings)
    const reports: { content: string; fyi: boolean }[] = []
    manager.onReport = (_projectId, content, report) => reports.push({ content, fyi: report.fyi === true })
    const agentReplies: string[] = []
    manager.onAgentMessagesHandled = (_projectId, _messages, reply) => agentReplies.push(reply)
    cleanups.push(() => s.db.close(), () => manager.stop())
    const messages = () => s.store.listCaptainMessages(s.project.id, 100) as CaptainMessage[]
    const busy = () => manager.state(s.project.id).busy
    return { ...s, manager, reports, agentReplies, messages, busy }
  }

  it("stops the running turn, tells the Coordinator and waiting agents, and resumes the same session with a note", async () => {
    const { manager, project, messages, busy, fake, reports, agentReplies, store, events } = captains()
    // A Captain that never ran has nothing to stop.
    expect(manager.stopTurn(project.id)).toBe(false)
    // The turn answers an agent's message_captain and the Coordinator's message together.
    store.addCaptainMessage(project.id, "user", "Which branch?", { source: "agent", tool: "message_captain", taskId: "task_1", taskTitle: "Build it", agentMessageId: "am_1", waitSeconds: 30 })
    manager.send(project.id, "Plan the release [hang]")
    await waitFor(() => fake.runs().length === 1 || null, "the turn to start")
    manager.send(project.id, "Then list the open PRs", { source: "cody" })
    expect(busy()).toBe(true)
    const before = events.length
    expect(manager.stopTurn(project.id)).toBe(true)
    // The chats show it stopped from the click, while the process is still ending.
    expect(busy()).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: "captain.state", state: { busy: false } })

    await waitFor(() => fake.runs().length >= 2 || null, "the queued message's turn")
    await waitFor(() => !busy() || null, "idle")
    // The queued message's turn said it was busy again before it ended.
    const shown = events.slice(before).flatMap((e) => (e.type === "captain.state" ? [e.state!.busy] : []))
    expect(shown.indexOf(true)).toBeGreaterThan(0)
    expect(shown.at(-1)).toBe(false)
    const lines = messages()
    expect(lines.find((m) => m.meta?.stopped === true)).toMatchObject({ role: "error", content: "Stopped by Sam." })
    expect(lines.some((m) => m.content.includes("hit an error"))).toBe(false)
    const stoppedReply = withOwner(CAPTAIN_STOPPED_REPLY, "Sam")
    // The Coordinator hears it as an FYI; the agent stops waiting with the same words.
    expect(reports).toContainEqual({ content: stoppedReply, fyi: true })
    expect(agentReplies).toContain(stoppedReply)

    const [first, second] = fake.runs()
    expect(session(second!.args)).toBe(session(first!.args))
    expect(second!.args).toContain("--resume")
    expect(second!.prompt).toContain(note)
    expect(second!.prompt).toContain("Then list the open PRs")
    expect(second!.prompt).not.toContain("Plan the release")
    expect(second!.prompt).not.toContain("Which branch?")
    expect(store.getKv(`captain_stopped:${project.id}`)).toBeNull()
  })

  it("a queued message Cody took back gets no turn after the stop", async () => {
    const { manager, project, messages, busy, fake } = captains()
    manager.send(project.id, "Long job [hang]", { source: "cody" })
    await waitFor(() => fake.runs().length === 1 || null, "the turn to start")
    const queued = manager.send(project.id, "Never mind this one", { source: "cody" })
    expect(queued.meta?.queued).toBe(true)
    expect(manager.cancelQueued(project.id, queued.id).meta?.cancelled).toBe(true)
    manager.stopTurn(project.id)
    await waitFor(() => messages().some((m) => m.meta?.stopped === true) || null, "the stopped line")
    await waitFor(() => !busy() || null, "idle")
    expect(fake.runs()).toHaveLength(1)
  })
})
