import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { tmpDir, waitFor } from "./helpers.js"

const live: ChildProcess[] = []
afterEach(() => { for (const child of live.splice(0)) child.kill("SIGKILL") })
async function fixture(mode = "success", resume = false) {
  const dir = tmpDir("codex-protocol-")
  fs.mkdirSync(path.join(dir, "work"))
  const log = path.join(dir, "rpc.jsonl")
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ taskId: "task_protocol", agent: "codex", isolateCodex: true, codexBin: process.execPath, codexArgs: [path.resolve("test/fixtures/codex-app-server.mjs")], env: { CODEX_FIXTURE_MODE: mode, CODEX_FIXTURE_LOG: log }, unsetEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"] }))
  fs.writeFileSync(path.join(dir, "turn.json"), JSON.stringify({ turnId: "turn_protocol", sessionId: "thread-fixture", resume, prompt: "initial instruction", systemPrompt: "test instructions", model: "gpt-example", effort: "medium" }))
  const child = spawn(process.execPath, [path.resolve("runner/box-runner.mjs"), "turn", dir], { env: { ...process.env, BOXYARD_RUNNER_DETACHED: "1" }, stdio: "pipe" })
  live.push(child)
  let stderr = ""
  child.stderr!.on("data", (d) => { stderr += d })
  const exit = new Promise((resolve) => child.on("close", (code) => resolve(code)))
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []
  const events = () => fs.existsSync(path.join(dir, "events.jsonl")) ? fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []
  const journal = () => JSON.parse(fs.readFileSync(path.join(dir, "codex-delivery-turn_protocol.json"), "utf8"))
  await waitFor(() => calls().find((c) => c.method === "turn/start"), `turn start (${stderr})`, 5000)
  const steer = () => fs.writeFileSync(path.join(dir, "steer-batch.json"), JSON.stringify({ id: "batch", turnId: "turn_protocol", inputIds: ["input-1"], text: "follow up", at: 1 }))
  return { dir, child, exit, calls, events, journal, steer }
}
describe("Codex app-server task transport", () => {
  it.each(["success", "completion-first"])("settles accepted input once even with %s ordering", async (mode) => {
    const f = await fixture(mode)
    f.steer()
    await f.exit
    expect(f.calls().filter((c) => c.method === "turn/steer")).toHaveLength(1)
    expect(f.calls().find((c) => c.method === "turn/steer").params).toMatchObject({ expectedTurnId: "native-turn-fixture", threadId: "thread-fixture", clientUserMessageId: "batch" })
    expect(f.journal()).toMatchObject({ terminal: "completed", entries: [{ state: "settled", accepted: true, incorporated: true, inputIds: ["input-1"] }] })
    expect(f.events().at(-1)).toMatchObject({ t: "turn_end", ok: true, sessionId: "thread-fixture", resultUsage: { input_tokens: 100, cache_read_input_tokens: 10, output_tokens: 20 } })
    expect(f.calls().find((c) => c.method === "thread/start").params).toMatchObject({ model: "gpt-example", approvalPolicy: "never", sandbox: "danger-full-access", developerInstructions: "test instructions" })
  })
  it("records stale rejection for safe fallback and never steers a replacement turn", async () => {
    const f = await fixture("stale"); f.steer(); await f.exit
    expect(f.journal().entries[0].state).toBe("rejected")
    expect(f.calls().filter((c) => c.method === "turn/steer")).toHaveLength(1)
  })
  it("delivers simultaneous batches in publication order rather than random filename order", async () => {
    const f = await fixture()
    for (const [id, sequence] of [["z-first", 1], ["a-second", 2]] as const) {
      fs.writeFileSync(path.join(f.dir, `steer-${id}.json`), JSON.stringify({ id, sequence, turnId: "turn_protocol", inputIds: [id], text: id, at: 1 }))
    }
    await f.exit
    expect(f.calls().filter((c) => c.method === "turn/steer").map((c) => c.params.clientUserMessageId)).toEqual(["z-first", "a-second"])
    expect(f.journal().entries.map((e: { state: string }) => e.state)).toEqual(["settled", "settled"])
  })
  it("retains uncertain submission after the peer disconnects without an acknowledgment", async () => {
    const f = await fixture("disconnect"); f.steer(); await f.exit
    expect(f.journal()).toMatchObject({ entries: [{ state: "uncertain", incorporated: false }] })
    expect(f.events().at(-1)).toMatchObject({ ok: false })
    expect(f.events().some((e) => e.delivery === "accepted")).toBe(false)
  })
  it("does not replay a steer after an internal error that cannot establish non-delivery", async () => {
    const f = await fixture("internal-error"); f.steer(); await f.exit
    expect(f.journal().entries[0].state).toBe("uncertain")
    expect(f.events().at(-1)).toMatchObject({ ok: false })
  })
  it("holds accepted input when successful completion cannot correlate its client ID", async () => {
    const f = await fixture("uncorrelated"); f.steer(); await f.exit
    expect(f.journal()).toMatchObject({ terminal: "completed", entries: [{ state: "uncertain", accepted: true, incorporated: false }] })
    expect(f.calls().filter((c) => c.method === "turn/steer")).toHaveLength(1)
  })
  it("holds an accepted input when Stop interrupts the turn instead of silently replaying it", async () => {
    const f = await fixture("accepted-stop"); f.steer()
    await waitFor(() => f.events().some((e) => e.delivery === "accepted"), "steer acceptance")
    f.child.kill("SIGTERM"); await f.exit
    expect(f.journal()).toMatchObject({ terminal: "interrupted", entries: [{ state: "uncertain", accepted: true, incorporated: true }] })
    expect(f.events().at(-1)).toMatchObject({ stopped: true })
  })
  it("resumes only the selected thread and interrupts the native turn on stop", async () => {
    const f = await fixture("success", true)
    f.child.kill("SIGTERM"); await f.exit
    expect(f.calls().find((c) => c.method === "thread/resume").params.threadId).toBe("thread-fixture")
    expect(f.calls().find((c) => c.method === "turn/interrupt").params).toEqual({ threadId: "thread-fixture", turnId: "native-turn-fixture" })
    expect(f.events().at(-1)).toMatchObject({ stopped: true })
  })
  it("rejects interactive approval requests instead of treating queued text as permission", async () => {
    const f = await fixture("approval"); await f.exit
    expect(f.calls().find((c) => c.id === "approval-1")).toMatchObject({ error: { code: -32601 } })
    expect(f.events().at(-1)).toMatchObject({ ok: false, error: expect.stringContaining("Unexpected Codex interactive request") })
  })
})
