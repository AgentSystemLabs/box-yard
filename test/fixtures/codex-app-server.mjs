// Isolated protocol peer: intentionally varies reply/notification ordering and transport loss.
import fs from "node:fs"
const mode = process.env.CODEX_FIXTURE_MODE
let turn = null, buf = ""
const send = (v) => process.stdout.write(JSON.stringify(v) + "\n")
const note = (method, params) => send({ method, params: { threadId: "thread-fixture", ...params } })
const complete = (status = "completed", items = []) => note("turn/completed", { turn: { id: turn, status, items } })
process.stdin.on("data", (data) => {
  buf += data
  const lines = buf.split("\n"); buf = lines.pop() ?? ""
  for (const line of lines) {
    const m = JSON.parse(line), p = m.params ?? {}
    fs.appendFileSync(process.env.CODEX_FIXTURE_LOG, JSON.stringify(m) + "\n")
    const result = (value) => send({ id: m.id, result: value })
    if (m.method === "initialize") result({ userAgent: "fixture" })
    else if (m.method === "thread/start" || m.method === "thread/resume") result({ thread: { id: "thread-fixture", turns: [] } })
    else if (m.method === "turn/start") {
      turn = "native-turn-fixture"
      note("turn/started", { turn: { id: turn, status: "inProgress", items: [] } })
      result({ turn: { id: turn, status: "inProgress", items: [] } })
      if (mode === "approval") send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: "thread-fixture", turnId: turn } })
      if (mode === "immediate") complete()
    } else if (m.method === "turn/steer") {
      if (mode === "disconnect") process.exit(8)
      if (mode === "internal-error") { send({ id: m.id, error: { code: -32603, message: "Internal failure after submission" } }); continue }
      if (mode === "stale") {
        complete()
        send({ id: m.id, error: { code: -32600, message: "expectedTurnId mismatch" } })
        continue
      }
      const item = { id: "user-item", type: "userMessage", clientId: p.clientUserMessageId, content: p.input }
      if (mode !== "uncorrelated") note("item/completed", { turnId: turn, item })
      note("thread/tokenUsage/updated", { turnId: turn, tokenUsage: { total: { inputTokens: 110, cachedInputTokens: 10, outputTokens: 20 }, last: { inputTokens: 110, cachedInputTokens: 10, outputTokens: 20 } } })
      if (mode === "completion-first") { complete("completed", [item]); setTimeout(() => result({ turnId: turn }), 100) }
      else if (mode === "accepted-stop") result({ turnId: turn })
      else if (mode === "uncorrelated") { result({ turnId: turn }); complete() }
      else { result({ turnId: turn }); setTimeout(() => complete("completed", [item]), 200) }
    } else if (m.method === "turn/interrupt") { result({}); complete("interrupted") }
  }
})
process.stdin.on("end", () => process.exit(0))
