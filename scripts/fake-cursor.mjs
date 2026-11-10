#!/usr/bin/env node
// A stand-in for Cursor's `cursor-agent` CLI, for trying Box Yard's Cursor support with no Cursor account and for
// tests. It speaks the `cursor-agent -p --output-format stream-json` protocol Box Yard uses (runner/box-runner.mjs
// runCursor, server/cursor.ts) and does the work by running scripts/fake-claude.mjs, so every prompt marker
// fake-claude knows ([ask], [fail], task <project>: …) works here too. It turns Cursor's flags into fake-claude's and
// fake-claude's stream-json back into Cursor's events.
//
//   CURSOR_BIN="node scripts/fake-cursor.mjs" npm run dev
//
// Commands: `-p` (a run), `models` (the model list), `status`, `--version`.
// Beyond fake-claude's:
//   FAKE_CURSOR_LOG=<file>        records each run's args, config dir, login, chat id, model and plugin MCP servers
//   FAKE_CURSOR_LOGIN=required    fails like cursor-agent with no login: no CURSOR_API_KEY
//   FAKE_CURSOR_MODELS=fail       `models` fails, as it does with no login or no network
// A CURSOR_API_KEY containing "invalid" fails like a key Cursor doesn't know.
// Chats live where the real CLI keeps them, $CURSOR_CONFIG_DIR/chats/<md5 of the folder>/<id>/ (store.db, meta.json):
// `--resume <id>` with no chat there starts a new one under that id, as the real CLI does. The work is fake-claude's
// session, kept in $CURSOR_CONFIG_DIR/fake-claude. A `<boxyard_instructions>` block opening the prompt is the
// system prompt (fake-claude's --append-system-prompt), kept with the chat for its later turns.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

const argv = process.argv.slice(2)
if (argv.includes("--version") || argv[0] === "-v") {
  console.log("2026.11.05-fake")
  process.exit(0)
}

const key = process.env.CURSOR_API_KEY || ""
const loggedIn = Boolean(key) || process.env.FAKE_CURSOR_LOGIN !== "required"
const badKey = /invalid/i.test(key)
const loginError = badKey
  ? "The provided API key is invalid.\nThe API key was loaded from the CURSOR_API_KEY environment variable.\nPlease check you have the right key, create a new one, or authenticate without it."
  : "Authentication required. Please run 'cursor-agent login' first, or set CURSOR_API_KEY environment variable."

const FAKE_MODELS = [
  ["auto", "Auto (default)"],
  ["composer-2.5", "Composer 2.5"],
  ["composer-2.5-fast", "Composer 2.5 Fast"],
  ["claude-opus-5-5-high", "Claude Opus 5.5 1M High"],
  ["claude-sonnet-5-5-high", "Claude Sonnet 5.5 High"],
  ["gpt-5.6-sol-high", "GPT-5.6 Sol 1M High"],
  ["gemini-4-argon-high", "Gemini 4 Argon High"],
  ["grok-4.7-high", "Grok 4.7 High"],
  ["kimi-k3-high", "Kimi K3 High"],
  // Synthetic runner-only entry: deliberately absent from Box Yard's server snapshot.
  ["claude-example-1-high", "Example Claude 1 1M High"],
]

if (argv[0] === "models" || argv.includes("--list-models")) {
  if (!loggedIn || badKey || process.env.FAKE_CURSOR_MODELS === "fail") {
    console.error(process.env.FAKE_CURSOR_MODELS === "fail" ? "Failed to fetch models: network error" : loginError)
    process.exit(1)
  }
  console.log("Available models\n")
  for (const [id, label] of FAKE_MODELS) console.log(`${id} - ${label}`)
  console.log("\nTip: use --model <id> (or /model <id> in interactive mode) to switch.")
  process.exit(0)
}

if (argv[0] === "status" || argv[0] === "whoami") {
  if (!loggedIn || badKey) {
    console.log("Not logged in")
    process.exit(1)
  }
  console.log(key ? "Logged in with an API key" : "Logged in as fake@example.com")
  process.exit(0)
}

if (!argv.includes("-p") && !argv.includes("--print")) {
  console.error(`fake cursor-agent: only -p, models, status and --version are supported (got: ${argv.join(" ")})`)
  process.exit(2)
}

// ---------------------------------------------------------------- flags

let model = null
let resume = null
let pluginDir = null
let sandbox = null
const positional = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === "--model" || a === "-m") model = argv[++i]
  else if (a === "--resume") resume = argv[++i]
  else if (a === "--plugin-dir") pluginDir = argv[++i]
  else if (a === "--sandbox") sandbox = argv[++i]
  else if (a === "--output-format" || a === "--workspace" || a === "--mode") i++
  else if (!a.startsWith("-")) positional.push(a)
}

process.stdout.on("error", () => {})
const emit = (ev) => process.stdout.write(JSON.stringify(ev) + "\n")

if (!loggedIn || badKey) {
  console.error(loginError)
  process.exit(1)
}
const known = new Set(FAKE_MODELS.map(([id]) => id))
if (model && !known.has(model)) {
  console.error(`Cannot use this model: ${model}. Available models: ${[...known].join(", ")}`)
  process.exit(1)
}

const configDir = process.env.CURSOR_CONFIG_DIR || path.join(os.tmpdir(), "fake-cursor")
const realCwd = (() => {
  try {
    return fs.realpathSync(process.cwd())
  } catch {
    return process.cwd()
  }
})()
const chatId = resume ?? randomUUID()
const chatDir = path.join(configDir, "chats", createHash("md5").update(realCwd).digest("hex"), chatId)
const existing = fs.existsSync(path.join(chatDir, "store.db"))
const claudeDir = path.join(configDir, "fake-claude")
// A chat this folder doesn't have is a new one, whatever fake-claude kept under the same id.
if (!existing) fs.rmSync(path.join(claudeDir, "fake-sessions", `${chatId}.json`), { force: true })
fs.mkdirSync(chatDir, { recursive: true })
fs.writeFileSync(path.join(chatDir, "store.db"), "fake")
fs.writeFileSync(path.join(chatDir, "meta.json"), JSON.stringify({ schemaVersion: 1, hasConversation: true, cwd: realCwd, updatedAtMs: Date.now() }))

const pluginServers = (() => {
  if (!pluginDir) return {}
  try {
    return JSON.parse(fs.readFileSync(path.join(pluginDir, "mcp.json"), "utf8")).mcpServers ?? {}
  } catch {
    return {}
  }
})()
const pluginName = pluginDir ? path.basename(pluginDir) : null

const readStdin = () =>
  new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("")
    let text = ""
    process.stdin.setEncoding("utf8").on("data", (d) => (text += d))
    process.stdin.on("end", () => resolve(text))
  })

let prompt = positional.join(" ") || (await readStdin())
let instructions = null
const block = /^\s*<boxyard_instructions>\n?([\s\S]*?)\n?<\/boxyard_instructions>\s*/.exec(prompt)
if (block) {
  instructions = block[1]
  prompt = prompt.slice(block[0].length)
  fs.writeFileSync(path.join(chatDir, "instructions.txt"), instructions)
} else {
  try {
    instructions = fs.readFileSync(path.join(chatDir, "instructions.txt"), "utf8")
  } catch {}
}

if (process.env.FAKE_CURSOR_LOG) {
  fs.appendFileSync(
    process.env.FAKE_CURSOR_LOG,
    JSON.stringify({ args: argv, configDir: process.env.CURSOR_CONFIG_DIR ?? null, dataDir: process.env.CURSOR_DATA_DIR ?? null, key: key || null, chat: chatId, existing, model, resume, sandbox, plugin: pluginName, servers: Object.keys(pluginServers), instructions: Boolean(block), usageLines: process.env.CURSOR_EMIT_MODEL_CALL_USAGE === "1", prompt }) + "\n",
  )
}

// ---------------------------------------------------------------- run fake-claude

const fakeClaude = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.mjs")
const claudeArgs = ["-p", "--output-format", "stream-json", "--verbose", ...(existing ? ["--resume", chatId] : ["--session-id", chatId])]
if (instructions) claudeArgs.push("--append-system-prompt", instructions)
if (model) claudeArgs.push("--model", model)
if (Object.keys(pluginServers).length) {
  const servers = Object.fromEntries(Object.entries(pluginServers).map(([name, s]) => [name, { type: "stdio", ...s }]))
  const file = path.join(os.tmpdir(), `fake-cursor-mcp-${process.pid}-${Date.now()}.json`)
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 })
  process.on("exit", () => fs.rmSync(file, { force: true }))
  claudeArgs.push("--strict-mcp-config", "--mcp-config", file)
}

const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir }
// The stand-in Claude must not log in with (or fail on) Claude credentials: Cursor has its own login.
delete env.FAKE_CLAUDE_LOGIN
delete env.FAKE_CLAUDE_LOG
const child = spawn(process.execPath, [fakeClaude, ...claudeArgs], { env, stdio: ["pipe", "pipe", "pipe"] })
process.on("SIGTERM", () => child.kill("SIGTERM"))
process.on("SIGINT", () => child.kill("SIGINT"))
child.stdin.on("error", () => {})
child.stdin.end(prompt)

// ---------------------------------------------------------------- fake-claude stream-json → cursor-agent stream-json

const label = FAKE_MODELS.find(([id]) => id === (model ?? "auto"))?.[1].replace(/\s*\(default\)/, "") ?? model
const usageLines = process.env.CURSOR_EMIT_MODEL_CALL_USAGE === "1"
const tools = new Map()
let started = false
let reply = ""
let calls = 0
const camel = (u) => ({
  inputTokens: u?.input_tokens ?? 0,
  outputTokens: u?.output_tokens ?? 0,
  cacheReadTokens: u?.cache_read_input_tokens ?? 0,
  cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
})
const start = () => {
  if (started) return
  started = true
  emit({ type: "system", subtype: "init", apiKeySource: key ? "env" : "login", cwd: realCwd, session_id: chatId, model: label, permissionMode: "default" })
  emit({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, session_id: chatId })
}

function toolCall(b) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(b.name))
  if (m) {
    const server = pluginName && m[1] in pluginServers ? `plugin-${pluginName}-${m[1]}` : m[1]
    return { mcpToolCall: { args: { name: `${server}-${m[2]}`, args: b.input ?? {}, toolCallId: b.id, providerIdentifier: server, toolName: m[2] } } }
  }
  if (b.name === "Read") return { readToolCall: { args: { path: String(b.input?.file_path ?? "") } } }
  if (b.name === "Write" || b.name === "Edit") return { editToolCall: { args: { path: String(b.input?.file_path ?? ""), streamContent: String(b.input?.content ?? b.input?.new_string ?? "") } } }
  return { shellToolCall: { args: { command: typeof b.input?.command === "string" ? b.input.command : JSON.stringify(b.input ?? {}), toolCallId: b.id } } }
}

function toolResult(call, text, isError) {
  const [k, body] = Object.entries(call)[0]
  if (k === "mcpToolCall") return { [k]: { ...body, result: { success: { content: [{ text: { text } }], isError } } } }
  if (k === "shellToolCall") return { [k]: { ...body, result: isError ? { failure: { exitCode: 1, stdout: "", stderr: text } } : { success: { exitCode: 0, stdout: text, stderr: "" } } } }
  return { [k]: { ...body, result: isError ? { error: { errorMessage: text } } : { success: { message: text } } } }
}

function translate(msg) {
  if (msg.type === "system" && msg.subtype === "init") return start()
  if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
    start()
    for (const b of msg.message.content) {
      if (b.type === "text" && b.text) {
        reply += b.text
        emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: b.text }] }, session_id: chatId, model_call_id: `call-${calls}` })
      }
      if (b.type === "tool_use") {
        const call = toolCall(b)
        tools.set(b.id, call)
        if (call.mcpToolCall) {
          // The real CLI reads an MCP tool's schema before it calls it.
          const lookup = { getMcpToolsToolCall: { args: { server: call.mcpToolCall.args.providerIdentifier, toolName: call.mcpToolCall.args.toolName } } }
          emit({ type: "tool_call", subtype: "started", call_id: `${b.id}-schema`, tool_call: lookup, session_id: chatId })
          emit({ type: "tool_call", subtype: "completed", call_id: `${b.id}-schema`, tool_call: { getMcpToolsToolCall: { ...lookup.getMcpToolsToolCall, result: { success: { content: "{}" } } } }, session_id: chatId })
        }
        emit({ type: "tool_call", subtype: "started", call_id: b.id, tool_call: call, session_id: chatId })
      }
    }
    if (msg.message.usage && usageLines) emit({ type: "usage", subtype: "model_call", model_call_id: `call-${calls++}`, usage: camel(msg.message.usage), session_id: chatId })
    return
  }
  if (msg.type === "user" && Array.isArray(msg.message?.content)) {
    for (const b of msg.message.content) {
      if (b.type !== "tool_result") continue
      const call = tools.get(b.tool_use_id)
      if (!call) continue
      tools.delete(b.tool_use_id)
      const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c) => c?.text ?? "").join("") : ""
      emit({ type: "tool_call", subtype: "completed", call_id: b.tool_use_id, tool_call: toolResult(call, text, Boolean(b.is_error)), session_id: chatId })
    }
    return
  }
  if (msg.type === "result") {
    start()
    emit({
      type: "result",
      subtype: msg.is_error ? "error" : "success",
      duration_ms: msg.duration_ms ?? 0,
      duration_api_ms: msg.duration_ms ?? 0,
      is_error: Boolean(msg.is_error),
      result: msg.is_error ? String(msg.result ?? "error") : reply,
      session_id: chatId,
      request_id: `req-${Date.now()}`,
      usage: camel(msg.usage),
    })
  }
}

let buf = ""
child.stdout.on("data", (d) => {
  buf += d
  const lines = buf.split("\n")
  buf = lines.pop() ?? ""
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      translate(JSON.parse(line))
    } catch {}
  }
})
child.stderr.on("data", (d) => process.stderr.write(d))
child.on("close", (code, signal) => {
  if (buf.trim()) {
    try {
      translate(JSON.parse(buf))
    } catch {}
  }
  process.exit(code ?? (signal ? 1 : 0))
})
