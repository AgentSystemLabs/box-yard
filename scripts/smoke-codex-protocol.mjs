// No model calls or credentials: validate the installed app-server protocol in a disposable home/workspace.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-yard-codex-protocol-"))
const env = { PATH: process.env.PATH, HOME: dir, CODEX_HOME: path.join(dir, "codex"), TMPDIR: os.tmpdir() }
fs.mkdirSync(env.CODEX_HOME)
const bin = process.argv[2] || "codex"
let child, exited
try {
  const version = spawnSync(bin, ["--version"], { env, encoding: "utf8" })
  assert.equal(version.status, 0, version.stderr)
  const schemaDir = path.join(dir, "schema")
  const schema = spawnSync(bin, ["app-server", "generate-json-schema", "--out", schemaDir], { env, encoding: "utf8" })
  assert.equal(schema.status, 0, schema.stderr)
  const steerSchema = JSON.parse(fs.readFileSync(path.join(schemaDir, "v2", "TurnSteerParams.json"), "utf8"))
  assert(steerSchema.required.includes("expectedTurnId"))
  assert(steerSchema.properties.clientUserMessageId)
  const items = JSON.parse(fs.readFileSync(path.join(schemaDir, "v2", "ItemCompletedNotification.json"), "utf8"))
  assert(JSON.stringify(items).includes('"clientId"'))

  child = spawn(bin, ["app-server", "--listen", "stdio://"], { cwd: dir, env, stdio: "pipe" })
  exited = new Promise((resolve) => child.once("close", resolve))
  let id = 0, buf = "", stderr = ""
  const calls = new Map()
  child.stdout.on("data", (chunk) => {
    buf += chunk
    const lines = buf.split("\n"); buf = lines.pop() ?? ""
    for (const line of lines) {
      const msg = JSON.parse(line), call = calls.get(msg.id)
      if (call) { clearTimeout(call.timer); calls.delete(msg.id); call.resolve(msg) }
    }
  })
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000) })
  child.once("close", (code) => { for (const call of calls.values()) { clearTimeout(call.timer); call.reject(new Error(`app-server exited ${code}: ${stderr}`)) } })
  const request = (method, params) => new Promise((resolve, reject) => {
    const key = ++id
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10_000)
    calls.set(key, { resolve, reject, timer })
    child.stdin.write(JSON.stringify({ id: key, method, params }) + "\n")
  })
  assert((await request("initialize", { clientInfo: { name: "boxyard_protocol_smoke", version: "1" }, capabilities: {} })).result)
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n")
  const start = await request("thread/start", { cwd: dir, approvalPolicy: "never", sandbox: "danger-full-access" })
  assert(start.result?.thread?.id, JSON.stringify(start.error))
  const threadId = start.result.thread.id
  const steer = await request("turn/steer", { threadId, expectedTurnId: "inactive-fixture", clientUserMessageId: "fixture-message", input: [{ type: "text", text: "fixture", text_elements: [] }] })
  assert(steer.error, "Inactive turn must reject steering")
  assert.match(steer.error.message, /no active turn|no turn.*active/i)
  console.log(`${version.stdout.trim()}: initialize, isolated thread/start, required expectedTurnId/client message schema, inactive turn/steer rejection PASS`)
  console.log(`Inactive steer: ${steer.error.code} ${steer.error.message}`)
  console.log("No turn/start, model calls, login reads, or production sessions used.")
} finally {
  if (child) {
    child.stdin.end()
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000)
    await exited
    clearTimeout(timer)
  }
  fs.rmSync(dir, { recursive: true, force: true })
}
