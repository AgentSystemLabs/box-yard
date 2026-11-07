// Test-only app-server transport around fake-codex's existing login, MCP, session and usage fixtures.
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
let thread = null, options = {}, turn = null, child = null, buffer = "", inputBuffer = "", items = []
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n")
const notify = (method, params) => send({ method, params: { threadId: thread, ...params } })
const user = (text) => JSON.stringify({ type: "user", session_id: "", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null }) + "\n"
const text = (input) => input.map((i) => i.text ?? "").join("\n")
const complete = (status, error) => { if (!turn) return; const ended = turn; turn = null; notify("turn/completed", { turn: { id: ended, status, items, error } }) }
async function receive(msg) {
  const p = msg.params ?? {}, answer = (result) => send({ id: msg.id, result })
  const reject = (message) => send({ id: msg.id, error: { code: -32600, message } })
  if (msg.method === "initialize") return answer({ userAgent: "fake-codex" })
  if (msg.method === "initialized") return
  if (msg.method === "thread/start" || msg.method === "thread/resume") {
    options = p; thread = p.threadId ?? randomUUID(); return answer({ thread: { id: thread, turns: [] } })
  }
  if (msg.method === "turn/start") {
    turn = randomUUID(); items = []
    const args = [fileURLToPath(new URL("fake-codex.mjs", import.meta.url)), "exec", "--fake-stream", ...process.argv.slice(3)]
    if (p.model || options.model) args.push("--model", p.model || options.model)
    if (options.threadId) args.push("resume", thread)
    else args.push("--fake-thread", thread)
    child = spawn(process.execPath, args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] })
    child.stderr.pipe(process.stderr)
    const native = turn
    child.stdout.on("data", (data) => {
      buffer += data
      const lines = buffer.split("\n"); buffer = lines.pop() ?? ""
      for (const line of lines) {
        let e
        try { e = JSON.parse(line) } catch { continue }
        if (e.type === "item.started" || e.type === "item.completed") {
          const item = { ...e.item, type: ({ agent_message: "agentMessage", command_execution: "commandExecution", mcp_tool_call: "mcpToolCall", file_change: "fileChange", web_search: "webSearch" })[e.item.type] ?? e.item.type, exitCode: e.item.exit_code, aggregatedOutput: e.item.aggregated_output }
          items.push(item); notify(e.type.replace(".", "/"), { turnId: native, item })
        } else if (e.type === "turn.completed") {
          const total = Object.fromEntries(Object.entries(e.usage).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]))
          notify("thread/tokenUsage/updated", { turnId: native, tokenUsage: { total, last: total, modelContextWindow: 200_000 } })
          complete("completed", null)
          child.stdin.end()
        } else if (e.type === "turn.failed" || e.type === "error") complete("failed", e.error ?? { message: e.message })
      }
    })
    child.on("close", (code) => { if (turn) complete("failed", { message: `fake codex exited ${code}` }) })
    notify("turn/started", { turn: { id: turn, status: "inProgress", items: [] } })
    answer({ turn: { id: turn, status: "inProgress", items: [] } })
    child.stdin.write(user(text(p.input)))
    return
  }
  if (msg.method === "turn/steer") {
    if (p.threadId !== thread || p.expectedTurnId !== turn || !turn) return reject("expectedTurnId does not match active turn")
    if (process.env.FAKE_CODEX_STEER === "stale") { complete("completed", null); child.kill(); return reject("No active turn") }
    const item = { id: randomUUID(), type: "userMessage", clientId: p.clientUserMessageId, content: p.input }
    items.push(item)
    notify("item/completed", { turnId: turn, item })
    if (process.env.FAKE_CODEX_STEER === "disconnect") { child.kill(); process.exit(7) }
    child.stdin.write(user(text(p.input)))
    answer({ turnId: turn })
    return
  }
  if (msg.method === "turn/interrupt") { child?.kill(); complete("interrupted", null); return answer({}) }
  reject(`Unsupported method ${msg.method}`)
}
process.stdin.on("data", (data) => {
  inputBuffer += data
  const lines = inputBuffer.split("\n"); inputBuffer = lines.pop() ?? ""
  for (const line of lines) if (line.trim()) void receive(JSON.parse(line))
})
process.stdin.on("end", () => { child?.kill(); process.exit(0) })
process.on("SIGTERM", () => { child?.kill(); process.exit(0) })
