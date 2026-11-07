import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { DEFAULT_SETTINGS, SettingsStore } from "../server/settings.js"
import type { Hub } from "../server/hub.js"
import { SideThreads, quickQuestionHost, type ThreadHost } from "../server/sideThreads.js"
import type { AgentCli } from "../shared/agentCli.js"
import { testConfig, tmpDir, waitFor } from "./helpers.js"

// Settings › Coordinator › Quick questions: the model and effort side threads (a task's side questions, Reply and Ask
// on the Coordinator's and Captains' messages) run on. Unset, each runs on its chat's, as it always did.

// A stand-in for the CLI: logs the model and effort each run got, then answers.
const STUB = `
import fs from "node:fs"
const log = process.argv[2]
const args = process.argv.slice(3)
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
let prompt = ""
process.stdin.on("data", (d) => (prompt += d))
process.stdin.on("end", () => {
  fs.appendFileSync(log, JSON.stringify({ model: flag("--model"), effort: flag("--effort"), resumed: args.includes("--resume") }) + "\\n")
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
  out({ type: "system", subtype: "init", session_id: "s" })
  out({ type: "assistant", message: { content: [{ type: "text", text: "An answer." }] } })
  out({ type: "result", subtype: "success", is_error: false, result: "An answer.", usage: { input_tokens: 10, output_tokens: 5 } })
})
`

type Run = { model: string | null; effort: string | null; resumed: boolean }

function setup() {
  const dir = tmpDir()
  const stub = path.join(dir, "stub-claude.mjs")
  fs.writeFileSync(stub, STUB)
  const log = path.join(dir, "runs.log")
  const c = testConfig({ claudeBin: `${process.execPath} ${stub} ${log}` })
  const store = new Store(openDb(c.dataDir, ":memory:"))
  const hub = { broadcast: () => {} } as unknown as Hub
  const settings = new SettingsStore(store, { orchestratorModel: "", workerModel: "", captainModel: "", captainEffort: "" })
  // The Coordinator on Opus at high, the Captains on Sonnet at medium.
  const host = (projectId: string | null): ThreadHost => ({
    cwd: dir,
    session: () => ({ id: "main", started: false }),
    systemPrompt: () => "system",
    readRules: () => [],
    cli: () => "claude",
    model: () => (projectId ? "claude-sonnet-5-5" : "claude-opus-5-5"),
    effort: () => (projectId ? "medium" : "high"),
    compactionsDir: path.join(dir, "compactions"),
    caller: projectId ? { kind: "captain", projectId } : { kind: "coordinator" },
    claudeLogin: () => null,
    usage: { source: projectId ? "captain" : "orchestrator", projectId },
    ...(projectId ? {} : { taskState: async () => "[The task now]\n- Fix login: working" }),
  })
  const threads = new SideThreads(c, store, hub, settings, "http://127.0.0.1:1/mcp", host)
  const p = store.createProject({ name: "demo" })
  const task = store.createTask({ projectId: p.id, title: "Fix login", prompt: "x" })
  const coordinatorReply = store.addChat("assistant", "Three tasks are running.")
  const captainReply = store.addCaptainMessage(p.id, "assistant", "The login fix is in review.")
  const runs = (): Run[] => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Run) : [])
  const answered = (threadId: string, n: number) =>
    waitFor(() => threads.messages(threadId).filter((m) => m.role === "assistant").length >= n && !threads.get(threadId).busy, `${n} answers`)
  // One of each: an Ask in the Coordinator's chat, a Reply in a Captain's, and a task's side question.
  const askEach = async () => {
    const ask = threads.create({ projectId: null, anchorId: coordinatorReply.id, kind: "ask", quote: "Three tasks", question: "Which three?" }).thread
    await answered(ask.id, 1)
    const reply = threads.create({ projectId: p.id, anchorId: captainReply.id, kind: "reply", question: "Who reviews it?" }).thread
    await answered(reply.id, 1)
    const side = threads.create({ projectId: null, anchorId: task.id, kind: "task", question: "Where is it up to?" }).thread
    await answered(side.id, 1)
    return { ask, reply, side }
  }
  const usageModels = () => (store.db.prepare("SELECT model FROM claude_usage WHERE run_kind = 'thread' ORDER BY rowid").all() as { model: string }[]).map((r) => r.model)
  return { store, settings, threads, runs, answered, askEach, usageModels }
}

describe("quick questions' model and effort", () => {
  it("default to each chat's own, as before the setting", async () => {
    const { settings, runs, askEach, usageModels } = setup()
    const info = settings.info()
    expect(info.settings).toMatchObject({ quickQuestionModel: "", quickQuestionEffort: "" })
    expect(info.sources).toMatchObject({ quickQuestionModel: "default", quickQuestionEffort: "default" })
    expect(DEFAULT_SETTINGS).toMatchObject({ quickQuestionModel: "", quickQuestionEffort: "" })

    await askEach()
    expect(runs().map((r) => [r.model, r.effort])).toEqual([
      ["claude-opus-5-5", "high"],
      ["claude-sonnet-5-5", "medium"],
      ["claude-opus-5-5", "high"],
    ])
    expect(usageModels()).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5-5"])
  })

  it("run every kind, in the Coordinator's chat and a Captain's, on the model and effort Settings picks", async () => {
    const { settings, runs, askEach, usageModels } = setup()
    settings.update({ quickQuestionModel: "claude-haiku-5-5", quickQuestionEffort: "low" })
    expect(settings.info().sources).toMatchObject({ quickQuestionModel: "ui", quickQuestionEffort: "ui" })

    await askEach()
    expect(runs().map((r) => [r.model, r.effort])).toEqual([
      ["claude-haiku-5-5", "low"],
      ["claude-haiku-5-5", "low"],
      ["claude-haiku-5-5", "low"],
    ])
    // Usage is counted on the model that ran.
    expect(usageModels()).toEqual(["claude-haiku-5-5", "claude-haiku-5-5", "claude-haiku-5-5"])
  })

  it("keep the chat's effort when only the model is set, and its model when only the effort is", async () => {
    const { settings, runs, askEach } = setup()
    settings.update({ quickQuestionModel: "haiku" })
    await askEach()
    expect(runs().map((r) => [r.model, r.effort])).toEqual([
      ["haiku", "high"],
      ["haiku", "medium"],
      ["haiku", "high"],
    ])

    const second = setup()
    second.settings.update({ quickQuestionEffort: "max" })
    await second.askEach()
    expect(second.runs().map((r) => [r.model, r.effort])).toEqual([
      ["claude-opus-5-5", "max"],
      ["claude-sonnet-5-5", "max"],
      ["claude-opus-5-5", "max"],
    ])
  })

  it("apply from a thread's next question, and go back to the chat's when cleared", async () => {
    const { settings, threads, runs, askEach, answered } = setup()
    const { ask } = await askEach()
    settings.update({ quickQuestionModel: "claude-haiku-5-5", quickQuestionEffort: "low" })
    threads.send(ask.id, "And the fourth?")
    await answered(ask.id, 2)
    settings.update({ quickQuestionModel: "", quickQuestionEffort: "" })
    threads.send(ask.id, "Thanks, and the fifth?")
    await answered(ask.id, 3)
    expect(runs().slice(3)).toEqual([
      { model: "claude-haiku-5-5", effort: "low", resumed: true },
      { model: "claude-opus-5-5", effort: "high", resumed: true },
    ])
  })

  it("leave a chat on Codex on its own model and effort", () => {
    const host = (cli: AgentCli) => ({ cli: () => cli, model: () => "gpt-6.1-sol", effort: () => "xhigh" }) as unknown as ThreadHost
    const picked = { quickQuestionModel: "claude-haiku-5-5", quickQuestionEffort: "low" } as const
    const codex = quickQuestionHost(host("codex"), picked)
    expect([codex.model(), codex.effort()]).toEqual(["gpt-6.1-sol", "xhigh"])
    const claude = quickQuestionHost(host("claude"), picked)
    expect([claude.model(), claude.effort()]).toEqual(["claude-haiku-5-5", "low"])
    // Unset: the chat's own host, unchanged.
    const same = host("claude")
    expect(quickQuestionHost(same, { quickQuestionModel: "", quickQuestionEffort: "" })).toBe(same)
  })

  it("take a Claude model or none, and an effort level or none", () => {
    const { settings } = setup()
    expect(() => settings.update({ quickQuestionModel: "gpt-6.1-sol" })).toThrow(/run on Claude/)
    expect(() => settings.update({ quickQuestionModel: "claude haiku" })).toThrow(/no spaces/)
    expect(() => settings.update({ quickQuestionEffort: "huge" })).toThrow()
    expect(settings.get()).toMatchObject({ quickQuestionModel: "", quickQuestionEffort: "" })
    settings.update({ quickQuestionModel: "claude-haiku-5-5", quickQuestionEffort: "xhigh" })
    expect(settings.get()).toMatchObject({ quickQuestionModel: "claude-haiku-5-5", quickQuestionEffort: "xhigh" })
    // Reset: back to each chat's own.
    settings.reset(["quickQuestionModel", "quickQuestionEffort"])
    expect(settings.info().sources).toMatchObject({ quickQuestionModel: "default", quickQuestionEffort: "default" })
  })
})
