// Exercise the installed Codex and Box Yard runner against a loopback-only Responses fixture. No real login/API.
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "box-yard-codex-runner-"))
const runner = fileURLToPath(new URL("../runner/box-runner.mjs", import.meta.url))
const bin = process.argv[2] || "codex"
const children = new Set(), requests = []
let held = null, hold = true
const reply = (res, index) => {
  const item = { type: "message", id: `message-${index}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture reply", annotations: [] }] }
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
  send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } })
  send({ type: "response.output_item.done", output_index: 0, item })
  send({ type: "response.completed", response: { id: `response-${index}`, status: "completed", output: [item], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 10 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 120 } } })
  res.end()
}
const api = http.createServer(async (req, res) => {
  let body = ""
  for await (const chunk of req) body += chunk
  if (!req.url?.endsWith("/responses")) { res.writeHead(404); res.end(); return }
  requests.push(JSON.parse(body))
  res.writeHead(200, { "Content-Type": "text/event-stream" })
  res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: `response-${requests.length}`, status: "in_progress", output: [] } })}\n\n`)
  if (hold && !held) held = () => reply(res, requests.length)
  else reply(res, requests.length)
})
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve))
const address = api.address()
const wait = async (check, label) => {
  const until = Date.now() + 20_000
  while (Date.now() < until) { const value = check(); if (value) return value; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error(`Timed out: ${label}`)
}
const read = (name, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) } catch { return fallback } }
const events = () => { try { return fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) } catch { return [] } }
try {
  fs.mkdirSync(path.join(dir, "work"))
  const env = { PATH: process.env.PATH, HOME: dir, TMPDIR: os.tmpdir(), BOXYARD_RUNNER_DETACHED: "1" }
  const version = spawnSync(bin, ["--version"], { env, encoding: "utf8" })
  assert.equal(version.status, 0, version.stderr)
  const config = ["model_provider=\"fixture\"", "model_providers.fixture.name=\"Fixture\"", `model_providers.fixture.base_url=\"http://127.0.0.1:${address.port}/v1\"`, "model_providers.fixture.env_key=\"BOXYARD_FIXTURE_TOKEN\"", "model_providers.fixture.wire_api=\"responses\"", "web_search=\"disabled\""]
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ taskId: "task_fixture", agent: "codex", isolateCodex: true, codexBin: bin, codexArgs: config.flatMap((c) => ["-c", c]), env: { BOXYARD_FIXTURE_TOKEN: "example-fixture" } }))
  const launch = (turnId, sessionId, resume) => {
    fs.writeFileSync(path.join(dir, "turn.json"), JSON.stringify({ turnId, sessionId, resume, model: "gpt-example", effort: "medium", prompt: "Reply with fixture text.", systemPrompt: "Use the fixture response. Do not call tools." }))
    const child = spawn(process.execPath, [runner, "turn", dir], { env, stdio: "pipe", detached: true })
    children.add(child)
    let stderr = ""
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000) })
    const exited = new Promise((resolve) => child.on("close", (code) => { children.delete(child); resolve({ code, stderr }) }))
    return { child, exited }
  }
  const first = launch("turn-fixture-1", "unused", false)
  await wait(() => held && read("codex-delivery-turn-fixture-1.json", {})?.nativeTurnId, "active turn and local API request")
  fs.writeFileSync(path.join(dir, "steer-fixture.json"), JSON.stringify({ id: "fixture-steer", turnId: "turn-fixture-1", text: "Include the follow-up.", inputIds: ["input-fixture"], at: 1 }))
  await wait(() => read("codex-delivery-turn-fixture-1.json", {})?.entries?.[0]?.accepted, "steer acknowledgment")
  hold = false; held(); held = null
  await wait(() => events().some((e) => e.t === "turn_end" && e.turnId === "turn-fixture-1"), "first turn end")
  const exit = await first.exited
  const end = events().find((e) => e.t === "turn_end" && e.turnId === "turn-fixture-1")
  assert(end.ok, JSON.stringify(end) + exit.stderr)
  assert.equal(read("codex-delivery-turn-fixture-1.json").entries[0].state, "settled")
  assert(requests.some((r) => JSON.stringify(r.input).includes("Include the follow-up.")), "follow-up present in the fixture API input")
  assert(requests.some((r) => r.tools?.some((t) => t.name === "mcp__boxyard__finish" || t.name === "mcp__boxyard" && t.tools?.some((tool) => tool.name === "finish"))), "Box Yard MCP tools loaded by installed Codex")
  assert(requests.every((r) => r.model === "gpt-example" && r.reasoning?.effort === "medium"), "explicit model and effort preserved")
  const second = launch("turn-fixture-2", end.sessionId, true)
  await wait(() => events().some((e) => e.t === "turn_end" && e.turnId === "turn-fixture-2"), "resumed turn end")
  await second.exited
  const resumed = events().find((e) => e.t === "turn_end" && e.turnId === "turn-fixture-2")
  assert(resumed.ok, JSON.stringify(resumed))
  assert.equal(resumed.sessionId, end.sessionId)
  assert.deepEqual(resumed.resultUsage, { input_tokens: 90, cache_creation_input_tokens: 0, cache_read_input_tokens: 10, output_tokens: 20 })
  hold = true
  const third = launch("turn-fixture-3", end.sessionId, true)
  await wait(() => held, "interruptible local request")
  third.child.kill("SIGTERM")
  await wait(() => events().some((e) => e.t === "turn_end" && e.turnId === "turn-fixture-3"), "interrupted turn end")
  await third.exited
  assert(events().find((e) => e.t === "turn_end" && e.turnId === "turn-fixture-3").stopped)
  console.log(`${version.stdout.trim()}: real runner + local Responses fixture: MCP, model/effort, active steer, client message correlation, session resume, usage delta, Stop PASS`)
  console.log("Only loopback fixture responses; no real credentials, model service, or production sessions used.")
} finally {
  await Promise.all([...children].map((child) => new Promise((resolve) => {
    child.once("close", resolve)
    try { process.kill(-child.pid, "SIGKILL") } catch { resolve() }
  })))
  api.closeAllConnections()
  await new Promise((resolve) => api.close(resolve))
  fs.rmSync(dir, { recursive: true, force: true })
}
