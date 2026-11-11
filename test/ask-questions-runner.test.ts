// ask_user with several questions, end to end on the server: the runner's real MCP tool (over stdio) checks the call
// and emits the event, the server keeps the questions on the task through the turn's end, and the answers endpoint
// sends them back as one message queued for that task's session, and only that task's.
import type { Server } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { createBoxYard } from "../server/app.js"
import { LocalProvider } from "../server/providers/local.js"
import { FAKE_CLAUDE, freePort, testConfig, tmpDir, waitFor } from "./helpers.js"
import { askKey, questionsText } from "../shared/askQuestions.js"
import type { WorkerEvent } from "../server/bus.js"

const cleanups: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f()
})

async function fixture() {
  const port = await freePort()
  const provider = new LocalProvider(tmpDir(), FAKE_CLAUDE)
  const yard = createBoxYard(testConfig({ port }), { provider, webDir: "/nonexistent" })
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  cleanups.push(() => yard.stop(), () => new Promise((res) => server.close(() => res(null))))
  const box = await provider.create()
  yard.store.upsertBox({ id: box, provider: "local", status: "ready", created_at: 1, last_used_at: 1 })
  const project = yard.store.createProject({ name: "example" })
  const task = yard.store.createTask({ projectId: project.id, title: "Settings page", prompt: "Build the settings page" })
  const other = yard.store.createTask({ projectId: project.id, title: "Other task", prompt: "Something else" })
  yard.store.updateTask(task.id, { status: "working", boxId: box, currentTurnId: "turn_example" })
  const dir = path.join(provider.root(box), "tasks", task.id)
  fs.mkdirSync(path.join(dir, "work"), { recursive: true })
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ taskId: task.id, projectId: project.id, ownerName: "Ana" }))
  fs.writeFileSync(path.join(dir, "turn.json"), JSON.stringify({ turnId: "turn_example" }))
  const client = new Client({ name: "ask-test", version: "0" })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve("runner/box-runner.mjs"), "mcp", dir], stderr: "pipe" }))
  cleanups.push(() => client.close())
  const events = () =>
    fs.existsSync(path.join(dir, "events.jsonl")) ? fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map((s) => JSON.parse(s) as WorkerEvent) : []
  const post = (taskId: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/answers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  return { yard, client, task, other, events, post }
}

type ToolResult = { content: { text: string }[]; isError?: boolean }

describe("ask_user with several questions", () => {
  it("lists questions on ask_user, keeping the plain question working", async () => {
    const { client } = await fixture()
    const ask = (await client.listTools()).tools.find((t) => t.name === "ask_user")!
    const props = ask.inputSchema.properties as Record<string, { type: string; items?: { required?: string[]; properties?: Record<string, unknown> } }>
    expect(props.question!.type).toBe("string")
    expect(props.questions!.type).toBe("array")
    expect(props.questions!.items!.required).toEqual(["question", "default_answer"])
    expect(Object.keys(props.questions!.items!.properties!)).toEqual(["question", "default_answer", "options"])
    expect(ask.description).toContain("Ask Ana (the human)")
    expect(ask.description).toContain("one at a time")
  })

  it("refuses a call it can't ask, saying why, and emits nothing", async () => {
    const { client, events } = await fixture()
    const res = (await client.callTool({ name: "ask_user", arguments: { questions: [{ question: "Which database?" }] } })) as ToolResult
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toMatch(/questions\[0\]\.default_answer is required/)
    const none = (await client.callTool({ name: "ask_user", arguments: {} })) as ToolResult
    expect(none.isError).toBe(true)
    expect(events().filter((e) => e.t === "ask_user")).toEqual([])
  })

  it("sends a plain question as before", async () => {
    const { yard, client, task, events } = await fixture()
    const res = (await client.callTool({ name: "ask_user", arguments: { question: "Blue or green?", questions: [] } })) as ToolResult
    expect(res.isError).toBeFalsy()
    const ev = await waitFor(() => events().find((e) => e.t === "ask_user"), "ask event")
    expect(ev).not.toHaveProperty("questions")
    await yard.tasks.apply(task.id, ev)
    expect(yard.store.getTask(task.id)).toMatchObject({ question: "Blue or green?", questions: null })
  })

  it("round-trips the questions to the task and the answers back to its session as one message", async () => {
    const { yard, client, task, other, events, post } = await fixture()
    const res = (await client.callTool({
      name: "ask_user",
      arguments: {
        question: "A few choices before I build it.",
        questions: [
          { question: "Which database should it use?", default_answer: "Postgres", options: ["SQLite", "MySQL", "postgres"] },
          { question: "Where should it deploy?", default_answer: "Fly.io", options: ["Render"] },
          { question: "What should the service be called?", default_answer: "acme-settings" },
        ],
      },
    })) as ToolResult
    expect(res.isError).toBeFalsy()
    expect(res.content[0]!.text).toBe("Your 3 questions were sent to Ana. End your turn now; the answers will arrive as your next message.")

    const ev = await waitFor(() => events().find((e) => e.t === "ask_user"), "ask event")
    expect(ev.turnId).toBe("turn_example")
    await yard.tasks.apply(task.id, ev)
    const questions = [
      { question: "Which database should it use?", defaultAnswer: "Postgres", options: ["SQLite", "MySQL"] },
      { question: "Where should it deploy?", defaultAnswer: "Fly.io", options: ["Render"] },
      { question: "What should the service be called?", defaultAnswer: "acme-settings", options: [] },
    ]
    const text = questionsText("A few choices before I build it.", questions)
    expect(yard.store.getTask(task.id)).toMatchObject({ status: "working", question: text, questions })
    const asked = yard.store.listTaskMessages(task.id, 100).find((m) => m.meta?.kind === "question")!
    expect(asked.content).toBe(`Asked Cody: ${text}`.replace("Cody", yard.settings.get().ownerName?.trim() || "the owner"))

    // The turn ends: the task waits on the answers, with its questions.
    await yard.tasks.apply(task.id, { seq: 99, ts: Date.now(), turnId: "turn_example", t: "turn_end", ok: true })
    const waiting = yard.store.getTask(task.id)!
    expect(waiting).toMatchObject({ status: "needs_input", question: text, questions })
    const key = askKey(waiting.questions!)

    // Answers to other questions, or the wrong number of them, are refused.
    expect((await post(task.id, { key: "stale", answers: ["Postgres", "Render", "x"] })).status).toBe(409)
    expect((await post(task.id, { key, answers: ["Postgres", "Render"] })).status).toBe(400)
    expect((await post(task.id, { key, answers: ["Postgres", " ", "x"] })).status).toBe(400)
    expect((await post(other.id, { key, answers: ["Postgres", "Render", "x"] })).status).toBe(409)
    expect(yard.store.listQueuedInputs(task.id)).toEqual([])

    const ok = await post(task.id, { key, answers: ["Postgres", "Render", "settings-api"] })
    expect(ok.status).toBe(200)
    const message = [
      "My answers to your 3 questions:",
      "",
      "1. Which database should it use?",
      "   - Postgres (your default)",
      "2. Where should it deploy?",
      "   - Render",
      "3. What should the service be called?",
      "   - settings-api (my own answer)",
    ].join("\n")
    const queued = yard.store.listQueuedInputs(task.id)
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ source: "cody", content: message })
    expect(yard.store.listQueuedInputs(other.id)).toEqual([])
    // Answered: the question and its form are gone, and the answers start the next turn.
    const answered = yard.store.getTask(task.id)!
    expect(answered.question).toBeNull()
    expect(answered.questions).toBeNull()
    expect(answered.status).not.toBe("needs_input")
    expect((await post(task.id, { key, answers: ["Postgres", "Render", "settings-api"] })).status).toBe(409)
  })

  it("keeps the questions through Mark done and Reopen", async () => {
    const { yard, client, task, events } = await fixture()
    await client.callTool({ name: "ask_user", arguments: { questions: [{ question: "Which database?", default_answer: "Postgres" }] } })
    await yard.tasks.apply(task.id, await waitFor(() => events().find((e) => e.t === "ask_user"), "ask event"))
    await yard.tasks.apply(task.id, { seq: 99, ts: Date.now(), turnId: "turn_example", t: "turn_end", ok: true })
    const questions = [{ question: "Which database?", defaultAnswer: "Postgres", options: [] }]
    expect(yard.store.getTask(task.id)).toMatchObject({ status: "needs_input", questions })
    await yard.tasks.closeTask(task.id)
    expect(yard.store.getTask(task.id)).toMatchObject({ status: "done", question: null, questions: null })
    yard.tasks.reopenTask(task.id)
    expect(yard.store.getTask(task.id)).toMatchObject({ status: "needs_input", question: "1 question:\n\n1. Which database? (default: Postgres)", questions })
  })
})
