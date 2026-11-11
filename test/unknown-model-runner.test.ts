import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { tmpDir, waitFor } from "./helpers.js"

// A Claude Code too old for the turn's model says so on stderr and runs on in a 200k-token window, where a model with
// a larger one ends in "Autocompact is thrashing". The runner stops the turn at that line instead, and says which
// model and which CLI. Runs the real runner against scripts/fake-claude.mjs (FAKE_CLAUDE_UNKNOWN_MODELS).

const RUNNER = path.resolve(import.meta.dirname, "../runner/box-runner.mjs")
const FAKE = path.resolve(import.meta.dirname, "../scripts/fake-claude.mjs")

interface Ev {
  t: string
  ok?: boolean
  error?: string | null
  exitCode?: number
  unrecognizedModel?: { model: string; cliVersion: string | null }
}

/** One turn of the runner in a task folder of its own; resolves with its turn_end and how long the turn took. */
async function runTurn(opts: { model: string; fakeEnv: Record<string, string>; taskEnv?: Record<string, string> }) {
  const dir = path.join(tmpDir(), "task_example")
  fs.mkdirSync(path.join(dir, "work"), { recursive: true })
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ taskId: "task_example", projectId: "proj_example", claudeBin: process.execPath, claudeArgs: [FAKE], env: opts.taskEnv ?? {} }))
  fs.writeFileSync(path.join(dir, "turn.json"), JSON.stringify({ turnId: "turn_example", prompt: "Review the settings page", sessionId: randomUUID(), resume: false, model: opts.model, systemPrompt: "" }))
  const started = Date.now()
  const child = spawn(process.execPath, [RUNNER, "turn", dir], { env: { ...process.env, ...opts.fakeEnv, BOXYARD_RUNNER_DETACHED: "1" }, stdio: "ignore" })
  const events = (): Ev[] => {
    const file = path.join(dir, "events.jsonl")
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Ev) : []
  }
  try {
    const end = await waitFor(() => events().find((e) => e.t === "turn_end"), "the turn's end")
    return { end, ms: Date.now() - started }
  } finally {
    child.kill("SIGKILL")
  }
}

const OLD_CLI = { FAKE_CLAUDE_VERSION: "2.1.293", FAKE_CLAUDE_UNKNOWN_MODELS: "claude-fable-5-2" }

describe("a turn whose Claude Code doesn't know the model", () => {
  it("fails fast with the model and the CLI version, not after thrashing on auto-compact", async () => {
    const { end, ms } = await runTurn({ model: "claude-fable-5-2", fakeEnv: { ...OLD_CLI, FAKE_CLAUDE_THRASH_MS: "15000" } })
    expect(end.ok).toBe(false)
    expect(end.exitCode).not.toBe(0)
    expect(end.unrecognizedModel).toEqual({ model: "claude-fable-5-2", cliVersion: "2.1.293" })
    expect(end.error).toContain("Claude Code 2.1.293 doesn't recognize the model claude-fable-5-2")
    expect(end.error).toContain("Update Claude Code")
    expect(end.error).not.toContain("Autocompact is thrashing")
    // The fake would have gone on for 15 s before thrashing.
    expect(ms).toBeLessThan(10_000)
  })

  it("lets the turn run where the window is the owner's own business (a gateway names its own models)", async () => {
    const { end } = await runTurn({ model: "claude-fable-5-2", fakeEnv: { ...OLD_CLI, FAKE_CLAUDE_THRASH_MS: "200" }, taskEnv: { ANTHROPIC_BASE_URL: "https://gateway.example.com" } })
    expect(end.ok).toBe(false)
    expect(end.unrecognizedModel).toBeUndefined()
    // What every such turn said before: the CLI's stderr line, then its thrashing result.
    expect(end.error).toContain("[claude-code:unrecognized_model]")
    expect(end.error).toContain("Autocompact is thrashing")
  })

  it("leaves a turn on a model the CLI knows alone", async () => {
    const { end } = await runTurn({ model: "claude-opus-5-5", fakeEnv: OLD_CLI })
    expect(end).toMatchObject({ ok: true, error: null })
    expect(end.unrecognizedModel).toBeUndefined()
  })
})

describe("the CLI's unknown-model lines", () => {
  /** The runner's own check, run from its source (runner/box-runner.mjs is one file copied to boxes). */
  function watch(): (stderr: string, model: string) => string | null {
    const src = fs.readFileSync(RUNNER, "utf8")
    const start = src.indexOf("// Unknown-model watch.")
    const end = src.indexOf("// end unknown-model watch")
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    return new Function(`${src.slice(start, end)}\nreturn unrecognizedModelIn`)()
  }
  const signal = (model: string, source = "sdk") => `[claude-code:unrecognized_model] ${JSON.stringify({ model, query_source: source })}\n`

  it("reads the signal an old CLI prints at its first request, and the line a newer one prints at start", () => {
    const named = watch()
    expect(named(signal("claude-fable-5-2"), "claude-fable-5-2")).toBe("claude-fable-5-2")
    expect(named(`Claude Code doesn't recognize the model "claude-fable-5-2", so it assumes a context window of 200k tokens. Update Claude Code.\n`, "claude-fable-5-2")).toBe("claude-fable-5-2")
    expect(named(`some warning\n${signal("claude-fable-5-2")}more\n`, "claude-fable-5-2[1m]")).toBe("claude-fable-5-2")
  })

  it("ignores another model's line (a subagent's), a line still arriving, and other stderr", () => {
    const named = watch()
    expect(named(signal("claude-nope-9", "agent:custom"), "claude-fable-5-2")).toBeNull()
    expect(named(`[claude-code:unrecognized_model] {"model":"claude-fab`, "claude-fable-5-2")).toBeNull()
    expect(named("Warning: no stdin data received in 3s\n", "claude-fable-5-2")).toBeNull()
    expect(named("", "claude-fable-5-2")).toBeNull()
  })
})
