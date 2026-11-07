import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { SettingsStore } from "../server/settings.js"
import type { Hub } from "../server/hub.js"
import { SideThreads, chatForward, routeRules, routedTurnPrompt, answerHere, replyPrompt, type ThreadHost, type ThreadRouter } from "../server/sideThreads.js"
import { mayBeDirective, parseRouteDirective, routeMeta, routeOf } from "../shared/threadRoutes.js"
import type { SideThreadMessage } from "../shared/types.js"
import { testConfig, tmpDir, waitFor } from "./helpers.js"

// The one Reply on a message opens its reply thread, and the chat's own agent routes each message Cody sends there
// (server/sideThreads.ts, shared/threadRoutes.ts): a question is answered in the thread, an instruction goes to the
// task's agent word for word, and what only the main chat can do goes there. Every message shows where it went, and
// Cody can send it the other way.

describe("route directives", () => {
  it("read [[route:agent]] and [[route:chat]], and leave any other reply an answer", () => {
    expect(parseRouteDirective("[[route:agent]]")).toEqual({ route: "agent", rest: "" })
    expect(parseRouteDirective("  [[ Route : CHAT ]]\n")).toEqual({ route: "chat", rest: "" })
    expect(parseRouteDirective("Sending it on. [[route:agent]]")).toEqual({ route: "agent", rest: "Sending it on." })
    expect(parseRouteDirective("It failed because the token expired.")).toEqual({ route: null, rest: "It failed because the token expired." })
    expect(parseRouteDirective("[[route:somewhere]]").route).toBeNull()
  })

  it("hold streamed text back only while it may still be a directive", () => {
    for (const t of ["", " ", "[", "[[", "[[ro", "[[route", "[[route:", "[[route:ag", "[[route:agent]]"]) expect(mayBeDirective(t)).toBe(true)
    for (const t of ["I", "It failed", "[x", "[[rot", "Sure [[route:agent]]"]) expect(mayBeDirective(t)).toBe(false)
  })

  it("keep a message's route in its meta, with the forward a re-route can take back", () => {
    const meta = { ...routeMeta({ route: "agent", taskId: "task_1", inputId: "in_1" }), other: 1 }
    expect(routeOf(meta)).toEqual({ route: "agent", by: "router", taskId: "task_1", inputId: "in_1", chatMessageId: null, recalled: false, delivered: false })
    expect(routeOf(routeMeta({ route: "thread", by: "cody", recalled: true }))).toMatchObject({ route: "thread", by: "cody", recalled: true })
    // A message from before routing (or still being routed) has none.
    expect(routeOf(null)).toBeNull()
    expect(routeOf({ route: "nowhere" })).toBeNull()
  })
})

describe("routing prompts", () => {
  it("offer the task's agent only on a message about a task, and name the owner", () => {
    const withTask = routeRules({ task: { id: "task_1", title: "Fix login" }, ownerName: "Sam" })
    expect(withTask).toContain('"Fix login" (task_1)')
    expect(withTask).toContain("[[route:agent]]")
    expect(withTask).toContain("[[route:chat]]")
    expect(withTask).toContain("If you aren't sure, answer here")
    expect(withTask).not.toContain("Cody")
    expect(withTask).toContain("Sam's messages")
    const noTask = routeRules({ task: null })
    expect(noTask).not.toContain("[[route:agent]]")
    expect(noTask).toContain("[[route:chat]]")
  })

  it("put the rules in a reply thread's first prompt and every later one", () => {
    const rules = routeRules({ task: null, ownerName: "Sam" })
    const first = replyPrompt({ original: "The deploy failed.", reply: "fix it", context: null, ownerName: "Sam", rules })
    expect(first).toContain(rules)
    expect(first).not.toContain("Sam can ask for it in the main chat")
    expect(first).toContain("Sam's reply:\nfix it")
    expect(routedTurnPrompt({ reply: "and again", rules, ownerName: "Sam" })).toBe(`${rules}\n\nSam's reply:\nand again`)
    expect(answerHere("Sam")).toContain("Sam chose to have this answered here")
  })

  it("quote the start of the message replied to when a reply goes to the main chat", () => {
    expect(chatForward("The deploy failed.\nDetails…", "start a new task for it")).toBe("> The deploy failed.\n> Details…\n\nstart a new task for it")
    const long = chatForward("x".repeat(400), "ok")
    expect(long.split("\n")[0]).toBe(`> ${"x".repeat(280)}…`)
    expect(chatForward("", "ok")).toBe("ok")
    expect(chatForward("✅ **Fix sync** finished", "ok")).toBe("> ✅ Fix sync finished\n\nok")
  })
})

// A stand-in for the CLI: answers, or routes an instruction ("fix …") when the prompt has routing rules; "FAIL" fails.
const STUB = `
import fs from "node:fs"
let prompt = ""
process.stdin.on("data", (d) => (prompt += d))
process.stdin.on("end", () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(prompt) + "\\n")
  out({ type: "system", subtype: "init", session_id: "s" })
  const q = prompt.split(/'s (?:question|reply):\\n/).pop().trim()
  if (/FAIL/.test(q)) {
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" })
    process.exit(1)
  }
  const routes = prompt.includes("[[route:chat]]") && /^fix|^new task/i.test(q)
  const text = routes ? (/^fix/i.test(q) && prompt.includes("[[route:agent]]") ? "[[route:agent]]" : "[[route:chat]]") : "Answer: " + q
  for (const part of text.match(/.{1,3}/gs)) out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: part } } })
  out({ type: "assistant", message: { content: [{ type: "text", text }] } })
  out({ type: "result", subtype: "success", is_error: false, result: text })
})
`

function setup(opts: { failAgent?: boolean; delivered?: boolean } = {}) {
  const dir = tmpDir()
  const stub = path.join(dir, "stub-claude.mjs")
  fs.writeFileSync(stub, STUB)
  const log = path.join(dir, "prompts.log")
  process.env.STUB_LOG = log
  const c = testConfig({ claudeBin: `${process.execPath} ${stub}` })
  const store = new Store(openDb(c.dataDir, ":memory:"))
  const events: { type: string; text?: string; message?: SideThreadMessage }[] = []
  const hub = { broadcast: (e: { type: string }) => void events.push(e) } as unknown as Hub
  const settings = new SettingsStore(store, { orchestratorModel: "", workerModel: "", captainModel: "", captainEffort: "" })
  const host = (projectId: string | null): ThreadHost => ({
    cwd: dir,
    session: () => ({ id: "main", started: false }),
    systemPrompt: () => "system",
    readRules: () => [],
    cli: () => "claude",
    model: () => "fake",
    effort: () => "low",
    compactionsDir: path.join(dir, "compactions"),
    caller: projectId ? { kind: "captain", projectId } : { kind: "coordinator" },
    claudeLogin: () => null,
    usage: { source: projectId ? "captain" : "orchestrator", projectId },
  })
  const threads = new SideThreads(c, store, hub, settings, "http://127.0.0.1:1/mcp", host)
  const calls: string[][] = []
  let input = 0
  const router: ThreadRouter = {
    toAgent: async (taskId, content) => {
      calls.push(["toAgent", taskId, content])
      if (opts.failAgent) throw new Error("no runner")
      return { inputId: `in_${++input}` }
    },
    recallAgent: (taskId, inputId) => {
      calls.push(["recallAgent", taskId, inputId])
      return !opts.delivered
    },
    toChat: (projectId, content) => {
      calls.push(["toChat", String(projectId), content])
      return { messageId: "chat_1" }
    },
    recallChat: (projectId, messageId) => {
      calls.push(["recallChat", String(projectId), messageId])
      return true
    },
  }
  threads.router = router
  const p = store.createProject({ name: "demo" })
  const task = store.createTask({ projectId: p.id, title: "Fix login", prompt: "x" })
  const notice = store.addChat("notice", "✅ **Fix login** finished: the login page works.", { taskId: task.id, projectId: p.id })
  const reply = store.addChat("assistant", "Three tasks are running.")
  const prompts = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string) : [])
  const settled = (threadId: string, n: number) =>
    waitFor(() => {
      const list = threads.messages(threadId)
      const routed = list.filter((m) => m.role === "user" && routeOf(m.meta))
      return routed.length >= n && !threads.get(threadId).busy ? list : null
    }, `${n} routed messages`)
  return { store, threads, events, calls, task, notice, reply, prompts, settled }
}

describe("a reply thread routes each message", () => {
  it("answers a question in the thread and never touches the agent", async () => {
    const { threads, calls, notice, task, settled } = setup()
    const { thread } = threads.create({ projectId: null, anchorId: notice.id, kind: "reply", question: "Why did it take so long?" })
    expect(thread.taskId).toBe(task.id)
    const list = await settled(thread.id, 1)
    expect(list.map((m) => [m.role, m.content])).toEqual([
      ["user", "Why did it take so long?"],
      ["assistant", "Answer: Why did it take so long?"],
    ])
    expect(routeOf(list[0]!.meta)).toMatchObject({ route: "thread", by: "router" })
    expect(calls).toEqual([])
  })

  it("sends an instruction to the task's agent word for word, with nothing shown in the thread but its route", async () => {
    const { threads, calls, notice, task, events, prompts, settled } = setup()
    const { thread } = threads.create({ projectId: null, anchorId: notice.id, kind: "reply", question: "fix the redirect after login too" })
    const list = await settled(thread.id, 1)
    expect(calls).toEqual([["toAgent", task.id, "fix the redirect after login too"]])
    expect(list).toHaveLength(1)
    expect(routeOf(list[0]!.meta)).toMatchObject({ route: "agent", by: "router", taskId: task.id, inputId: "in_1" })
    // The directive never streamed into the thread.
    expect(events.filter((e) => e.type === "thread.delta").map((e) => e.text).join("")).not.toContain("[[")
    // The turn was told the task and both routes.
    expect(prompts()[0]).toContain(`"Fix login" (${task.id})`)
    expect(prompts()[0]).toContain("[[route:agent]]")
  })

  it("posts what only the main chat can do in the main chat, quoting the message it replies to", async () => {
    const { threads, calls, reply, settled } = setup()
    const { thread } = threads.create({ projectId: null, anchorId: reply.id, kind: "reply", question: "new task for the flaky test" })
    expect(thread.taskId).toBeNull()
    const [m] = await settled(thread.id, 1)
    expect(calls).toEqual([["toChat", "null", "> Three tasks are running.\n\nnew task for the flaky test"]])
    expect(routeOf(m!.meta)).toMatchObject({ route: "chat", chatMessageId: "chat_1" })
  })

  it("sends an instruction on a message with no task to the main chat: there's no agent to send it to", async () => {
    const { threads, calls, reply, prompts, settled } = setup()
    const { thread } = threads.create({ projectId: null, anchorId: reply.id, kind: "reply", question: "fix the flaky test" })
    await settled(thread.id, 1)
    expect(prompts()[0]).not.toContain("[[route:agent]]")
    expect(calls.map((c) => c[0])).toEqual(["toChat"])
  })

  it("re-routes with one tap: 'Just ask instead' takes the queued forward back and answers here", async () => {
    const { threads, calls, notice, task, prompts, settled } = setup()
    const { thread, message } = threads.create({ projectId: null, anchorId: notice.id, kind: "reply", question: "fix the redirect" })
    await settled(thread.id, 1)
    const asked = await threads.reroute(thread.id, message.id, "thread")
    expect(routeOf(asked.meta)).toMatchObject({ route: "thread", by: "cody", recalled: true, delivered: false })
    expect(calls.at(-1)).toEqual(["recallAgent", task.id, "in_1"])
    const list = await waitFor(() => {
      const l = threads.messages(thread.id)
      return l.some((m) => m.role === "assistant") && !threads.get(thread.id).busy ? l : null
    }, "the answer")
    expect(list.at(-1)).toMatchObject({ role: "assistant", content: "Answer: fix the redirect" })
    // That turn was told to answer, not route.
    expect(prompts().at(-1)).toContain("chose to have this answered here")
    expect(prompts().at(-1)).not.toContain("[[route:agent]]")
    expect(routeOf(threads.messages(thread.id)[0]!.meta)).toMatchObject({ route: "thread", by: "cody", recalled: true })
  })

  it("says so when the agent already had it: the answer comes too, and nothing is taken back silently", async () => {
    const { threads, notice, settled } = setup({ delivered: true })
    const { thread, message } = threads.create({ projectId: null, anchorId: notice.id, kind: "reply", question: "fix the redirect" })
    await settled(thread.id, 1)
    const asked = await threads.reroute(thread.id, message.id, "thread")
    expect(routeOf(asked.meta)).toMatchObject({ route: "thread", recalled: false, delivered: true })
  })

  it("re-routes an answered question to the agent: 'Send to agent instead'", async () => {
    const { threads, calls, notice, task, settled } = setup()
    const { thread, message } = threads.create({ projectId: null, anchorId: notice.id, kind: "reply", question: "could you also add a test?" })
    await settled(thread.id, 1)
    const sent = await threads.reroute(thread.id, message.id, "agent")
    expect(calls).toEqual([["toAgent", task.id, "could you also add a test?"]])
    expect(routeOf(sent.meta)).toMatchObject({ route: "agent", by: "cody", taskId: task.id, inputId: "in_1" })
    // Sending it there again does nothing.
    await threads.reroute(thread.id, message.id, "agent")
    expect(calls).toHaveLength(1)
  })

  it("never drops a message: a failed forward or turn is marked, explained, and can be sent again", async () => {
    const failing = setup({ failAgent: true })
    const { thread } = failing.threads.create({ projectId: null, anchorId: failing.notice.id, kind: "reply", question: "fix the redirect" })
    const list = await failing.settled(thread.id, 1)
    expect(list.map((m) => m.role)).toEqual(["user", "error"])
    expect(list[0]).toMatchObject({ content: "fix the redirect" })
    expect(routeOf(list[0]!.meta)).toMatchObject({ route: "failed" })
    expect(list[1]!.content).toContain("Couldn't send it to the agent: no runner")

    const { threads, notice, settled } = setup()
    const t2 = threads.create({ projectId: null, anchorId: notice.id, kind: "reply", question: "FAIL please" }).thread
    const after = await settled(t2.id, 1)
    expect(after[0]).toMatchObject({ role: "user", content: "FAIL please" })
    expect(routeOf(after[0]!.meta)).toMatchObject({ route: "failed" })
    expect(after.at(-1)!.role).toBe("error")
  })

  it("only ever answers an ask, and routes a Captain chat's task update to that task", async () => {
    const { threads, calls, store, reply, settled } = setup()
    const ask = threads.create({ projectId: null, anchorId: reply.id, quote: "Three tasks", question: "fix it" }).thread
    await waitFor(() => threads.messages(ask.id).some((m) => m.role === "assistant") && !threads.get(ask.id).busy, "the ask's answer")
    expect(threads.messages(ask.id).map((m) => m.content)).toEqual(["fix it", "Answer: fix it"])
    expect(calls).toEqual([])
    // A Captain chat's task update: its thread's task is the update's.
    const p = store.listProjects()[0]!
    const task = store.listTasks()[0]!
    const update = store.addCaptainMessage(p.id, "notice", "✅ **Fix login** finished", { taskId: task.id })
    const capThread = threads.create({ projectId: p.id, anchorId: update.id, kind: "reply", question: "fix the copy" }).thread
    expect(capThread.taskId).toBe(task.id)
    await settled(capThread.id, 1)
    expect(calls).toEqual([["toAgent", task.id, "fix the copy"]])
  })
})
