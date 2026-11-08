#!/usr/bin/env node
// Safe OpenCode 1.19.5 stand-in: no network/providers. JSON wire shapes follow upstream run.ts.
// Runs fake-claude for Box Yard MCP tool exercises. Log only credential presence, never values.
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

const args = process.argv.slice(2)
if (args.includes("--version")) { console.log(process.env.FAKE_OPENCODE_VERSION || "1.19.5"); process.exit(0) }
if (args[0] === "models") {
  for (const id of ["example/model", "example/model-other"]) {
    console.log(id)
    if (args.includes("--verbose")) console.log(JSON.stringify({ id: id.split("/")[1], variants: { high: {}, max: {} } }, null, 2))
  }
  process.exit(0)
}
if (args[0] !== "run" || !args.includes("--format") || !args.includes("json")) throw new Error("Expected run --format json")
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : null
let prompt = ""
for await (const chunk of process.stdin) prompt += chunk
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}")
const data = path.join(process.env.XDG_DATA_HOME || os.tmpdir(), "opencode")
fs.mkdirSync(data, { recursive: true })
const resume = option("--session")
const sessionID = resume || `ses_${randomUUID().replaceAll("-", "")}`
const file = path.join(data, `${sessionID}.json`)
if (resume && !fs.existsSync(file)) { console.error("Session not found"); process.exit(1) }
fs.writeFileSync(file, JSON.stringify({ sessionID, cwd: process.cwd() }))
if (process.env.FAKE_OPENCODE_LOG) fs.appendFileSync(process.env.FAKE_OPENCODE_LOG, JSON.stringify({ args, resume, sessionID, model: option("--model"), variant: option("--variant"), config, hasAuth: Boolean(process.env.OPENCODE_AUTH_CONTENT && process.env.OPENCODE_AUTH_CONTENT !== "{}"), prompt, data, env: { claude: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN), codex: Boolean(process.env.CODEX_API_KEY), cursor: Boolean(process.env.CURSOR_API_KEY) } }) + "\n")
const emit = (type, data) => process.stdout.write(JSON.stringify({ type, timestamp: Date.now(), sessionID, ...data }) + "\n")
if (prompt.includes("[opencode-empty]")) process.exit(0)
if (prompt.includes("[opencode-error]")) { emit("error", { error: { name: "ProviderAuthError", data: { message: "OpenCode provider authentication required; check API login" } } }); process.exit(0) }
if (prompt.includes("[opencode-auth-session]")) { emit("error", { error: { name: "APIError", data: { message: "OpenCode authentication failed: provider session not found (401)" } } }); process.exit(1) }
if (prompt.includes("[opencode-secret-error]")) {
  const key = Object.values(JSON.parse(process.env.OPENCODE_AUTH_CONTENT || "{}"))[0]?.key || "fixture"
  process.stderr.write(key.slice(0, 4))
  await new Promise((r) => setTimeout(r, 10))
  process.stderr.write(key.slice(4))
  emit("error", { error: { name: "APIError", data: { message: `OpenCode API rejected ${key}` } } })
  process.exit(0)
}
if (prompt.includes("[opencode-malformed]")) process.stdout.write("{malformed output}\n")
if (prompt.includes("[opencode-length]")) {
  emit("step_finish", { part: { id: "step1", reason: "length", cost: 0.1, tokens: { input: 100, output: 20 } } })
  process.exit(0)
}
if (prompt.includes("[opencode-fragments]")) {
  const step = { type: "step-finish", id: "step1", reason: "tool-calls", cost: 0.1, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } } }
  const line = JSON.stringify({ type: "step_finish", timestamp: Date.now(), sessionID, part: step }) + "\n"
  process.stdout.write(line.slice(0, 17))
  await new Promise((r) => setTimeout(r, 10))
  process.stdout.write(line.slice(17) + line) // duplicate part: charge once
  emit("tool_use", { part: { id: "tool1", type: "tool", tool: "bash", state: { status: "error", input: { command: "false" }, error: "fixture tool error" } } })
  emit("tool_use", { part: { id: "tool2", type: "tool", tool: "boxyard_finish", state: { status: "completed", input: {} } } })
  emit("text", { part: { id: "text1", type: "text", text: "Fixture reply" } })
  // No final newline: the adapter must flush its tail.
  process.stdout.write(JSON.stringify({ type: "step_finish", timestamp: Date.now(), sessionID, part: { ...step, id: "step2", reason: "stop" } }))
  process.exit(0)
}
const instructions = /^<boxyard_instructions>\n([\s\S]*?)\n<\/boxyard_instructions>\s*/.exec(prompt)
if (instructions) prompt = prompt.slice(instructions[0].length)
const fakeClaude = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.mjs")
const claudeHome = path.join(data, "fake-claude")
const mcpFile = path.join(os.tmpdir(), `fake-opencode-${process.pid}.json`)
fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(config.mcp || {}).filter(([, s]) => s.enabled !== false).map(([key, s]) => [key, { type: "stdio", command: s.command[0], args: s.command.slice(1) }])) }))
process.on("exit", () => fs.rmSync(mcpFile, { force: true }))
const uuid = sessionID.slice(4).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5")
const child = spawn(process.execPath, [fakeClaude, "-p", "--output-format", "stream-json", "--verbose", resume ? "--resume" : "--session-id", uuid, "--strict-mcp-config", "--mcp-config", mcpFile, ...(instructions ? ["--append-system-prompt", instructions[1]] : [])], { env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, FAKE_CLAUDE_LOGIN: "", FAKE_CLAUDE_LOG: "" }, stdio: ["pipe", "pipe", "pipe"] })
process.on("SIGTERM", () => child.kill("SIGTERM"))
let buf = "", index = 0
function translate(msg) {
  if (msg.type === "assistant") for (const b of msg.message?.content || []) {
    if (b.type === "text") emit("text", { part: { id: `part${index++}`, type: "text", text: b.text, time: { end: Date.now() } } })
    if (b.type === "tool_use") emit("tool_use", { part: { id: b.id, type: "tool", tool: b.name.replace(/^mcp__boxyard__/, "boxyard_"), state: { status: "completed", input: b.input } } })
  }
  if (msg.type === "result") {
    if (msg.is_error) emit("error", { error: { name: "APIError", data: { message: msg.result } } })
    emit("step_finish", { part: { id: `step${index++}`, type: "step-finish", reason: "stop", cost: 0.125, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } } } })
  }
}
child.stdout.setEncoding("utf8").on("data", (chunk) => {
  buf += chunk
  const lines = buf.split("\n"); buf = lines.pop() || ""
  for (const line of lines) { try { translate(JSON.parse(line)) } catch {} }
})
child.stderr.pipe(process.stderr)
child.on("close", (code) => { if (buf.trim()) { try { translate(JSON.parse(buf)) } catch {} }; process.exit(code ?? 1) })
child.stdin.on("error", () => {})
child.stdin.end(prompt)
