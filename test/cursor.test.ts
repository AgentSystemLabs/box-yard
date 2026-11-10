import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { CURSOR_MODELS_TTL_MS, cursorAgentArgs, cursorErrorText, cursorKeyCheck, CursorModels, cursorUsageOf } from "../server/cursor.js"
import { cursorTurnLogin } from "../server/turnCredentials.js"
import { checkLocal } from "../server/localCheck.js"
import { canSteer, cliForModel, cursorContextWindow, cursorModel, cursorModelVendor, CURSOR_FALLBACK_MODELS, DEFAULT_CURSOR_MODEL, isCursorOnlyModel, isManagerCli, parseCursorModels } from "../shared/agentCli.js"
import { FAKE_CURSOR, tmpDir } from "./helpers.js"

// Cursor's CLI as a task agent (docs/cursor.md): its model list, the model a run gets, its flags, its token counts and
// the key check. The runs themselves are in test/cursor-task.e2e.test.ts.

// What `cursor-agent models` (2026.11.05-86047df) printed, trimmed: a heading, `<id> - <name>` lines, a tip.
const MODELS_OUTPUT = [
  "\u001b[1mAvailable models\u001b[0m",
  "",
  "auto - Auto  (current)",
  "composer-2.5 - Composer 2.5 (default)",
  "claude-opus-5-5-high - Claude Opus 5.5 1M High",
  "gpt-5.6-sol-high - GPT-5.6​ Sol 1M High",
  "gemini-4-argon-high - Gemini 4 Argon High",
  "cursor-grok-4.6-high - Grok 4.6",
  "auto - Auto",
  "",
  "Tip: use --model <id> (or /model <id> in interactive mode) to switch.",
].join("\n")

describe("Cursor's model list", () => {
  it("reads `cursor-agent models` lines, without colours, marks, zero-width spaces or repeats", () => {
    expect(parseCursorModels(MODELS_OUTPUT)).toEqual([
      { id: "auto", label: "Auto" },
      { id: "composer-2.5", label: "Composer 2.5" },
      { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 1M High" },
      { id: "gpt-5.6-sol-high", label: "GPT-5.6 Sol 1M High" },
      { id: "gemini-4-argon-high", label: "Gemini 4 Argon High" },
      { id: "cursor-grok-4.6-high", label: "Grok 4.6" },
    ])
    expect(parseCursorModels("No models available for this account.")).toEqual([])
    expect(parseCursorModels("")).toEqual([])
  })

  it("groups by family and reads the context window a name states", () => {
    expect(["auto", "composer-2.5-fast", "claude-opus-5-5-high", "gpt-5.3-codex-high", "gemini-4-argon-high", "cursor-grok-4.6-high", "grok-4.7-high", "kimi-k3-high"].map(cursorModelVendor)).toEqual([
      "Cursor",
      "Cursor",
      "Anthropic",
      "OpenAI",
      "Google",
      "xAI",
      "xAI",
      "Other",
    ])
    expect(cursorContextWindow("Claude Opus 5.5 1M High")).toBe(1_000_000)
    expect(cursorContextWindow("GPT-5.6 Sol 272K")).toBe(272_000)
    expect(cursorContextWindow("Grok 4.6")).toBeNull()
    expect(cursorContextWindow(null)).toBeNull()
  })

  it("has a snapshot to fall back on, Auto first, every id one the parser would read", () => {
    expect(CURSOR_FALLBACK_MODELS[0]!.id).toBe(DEFAULT_CURSOR_MODEL)
    const text = CURSOR_FALLBACK_MODELS.map((m) => `${m.id} - ${m.label}`).join("\n")
    expect(parseCursorModels(text)).toEqual(CURSOR_FALLBACK_MODELS)
  })
})

describe("the model a Cursor run gets", () => {
  it("takes a task's own Cursor model, else the setting, else Auto; an empty setting keeps the CLI's default", () => {
    expect(cursorModel("gemini-4-argon-high", "composer-2.5")).toBe("gemini-4-argon-high")
    expect(cursorModel(null, "composer-2.5")).toBe("composer-2.5")
    expect(cursorModel(null, null)).toBe(DEFAULT_CURSOR_MODEL)
    expect(cursorModel(null, "")).toBeNull()
    // A Claude alias or a Codex name isn't a Cursor id, so the setting stands in for it...
    expect(cursorModel("opus", "composer-2.5")).toBe("composer-2.5")
    expect(cursorModel("gpt-6.1-sol", null)).toBe("auto")
    // ...unless Cursor's live list has it: Cursor's own names for Claude and GPT models.
    const known = (id: string) => id === "claude-opus-5-5-high"
    expect(cursorModel("claude-opus-5-5-high", "composer-2.5", known)).toBe("claude-opus-5-5-high")
    expect(cursorModel("claude-opus-5-5-high", "composer-2.5")).toBe("composer-2.5")
  })

  it("picks Cursor for a model only Cursor runs, and leaves Claude's and OpenAI's names to their own CLIs", () => {
    for (const m of ["auto", "composer-2.5", "cursor-grok-4.6-high", "gemini-4-argon-high", "grok-4.7-high", "kimi-k3-high", "glm-5.2-high", "deepseek-v41-flash-1017-high"]) {
      expect(isCursorOnlyModel(m), m).toBe(true)
      expect(cliForModel(m), m).toBe("cursor")
    }
    expect(cliForModel("opus")).toBe("claude")
    expect(cliForModel("claude-opus-5-5-high")).toBe("claude")
    expect(cliForModel("gpt-6.1-sol")).toBe("codex")
    expect(cliForModel("autopilot")).toBeNull()
  })

  it("can't be steered, and doesn't run the Coordinator or Captains", () => {
    expect(canSteer("cursor")).toBe(false)
    expect(canSteer("codex")).toBe(true)
    expect(canSteer("claude")).toBe(true)
    expect(canSteer(null)).toBe(true)
    expect(isManagerCli("cursor")).toBe(false)
    expect(isManagerCli("codex")).toBe(true)
  })
})

describe("cursor-agent's flags and output", () => {
  it("runs print mode with stream-json, nothing to approve, Box Yard's plugin, the model and the chat", () => {
    expect(cursorAgentArgs({ sessionId: "c-1", model: "composer-2.5", pluginDir: "/t/cursor-plugin/boxyard" })).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--force",
      "--trust",
      "--approve-mcps",
      "--sandbox",
      "disabled",
      "--plugin-dir",
      "/t/cursor-plugin/boxyard",
      "--model",
      "composer-2.5",
      "--resume",
      "c-1",
    ])
    expect(cursorAgentArgs({ sessionId: "c-1", model: null, pluginDir: "/p" })).not.toContain("--model")
  })

  it("counts tokens in Claude's terms", () => {
    expect(cursorUsageOf({ inputTokens: 1200, outputTokens: 80, cacheReadTokens: 30_000, cacheWriteTokens: 900 })).toEqual({
      input_tokens: 1200,
      cache_creation_input_tokens: 900,
      cache_read_input_tokens: 30_000,
      output_tokens: 80,
    })
    expect(cursorUsageOf({ inputTokens: "x" })).toEqual({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 })
    expect(cursorUsageOf(null)).toBeNull()
  })

  it("shows its own error lines, without colours, glyphs or stack traces", () => {
    const err = "\u001b[31m⚠ Warning: something minor\u001b[0m\nError: The provided API key is invalid.\n    at run (file:///x.js:1:1)\n"
    expect(cursorErrorText(err)).toBe("Warning: something minor Error: The provided API key is invalid.")
    expect(cursorErrorText("a\nb\nc\nd\ne", 2)).toBe("d e")
  })
})

describe("CursorModels", () => {
  const make = (env: Record<string, string> = {}, now = () => 1_000) => {
    const dataDir = tmpDir("cursor-models-")
    // The fake reads FAKE_CURSOR_MODELS from its env, which is the server's.
    Object.assign(process.env, env)
    return { dataDir, models: new CursorModels({ bin: FAKE_CURSOR, dataDir, key: () => "", now }) }
  }

  it("lists what the CLI lists, keeps it for hours and on disk, and reads it again on Refresh", async () => {
    let t = 1_000
    const { dataDir, models } = make({}, () => t)
    const first = await models.list()
    expect(first).toMatchObject({ source: "cli", fetchedAt: 1_000, error: null })
    expect(first.models[0]).toEqual({ id: "auto", label: "Auto" })
    expect(first.models.map((m) => m.id)).toContain("kimi-k3-high")
    expect(models.has("kimi-k3-high")).toBe(true)
    expect(models.has("opus")).toBe(false)
    t += 60_000
    expect(await models.list()).toBe(first)
    expect((await models.list(true)).fetchedAt).toBe(t)
    // A new server reads the saved list without running the CLI.
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "cursor-models.json"), "utf8"))
    expect(saved.models).toHaveLength(first.models.length)
    const again = new CursorModels({ bin: "/nonexistent/cursor-agent", dataDir, key: () => "", now: () => t })
    expect((await again.list()).source).toBe("cli")
    // Stale: the CLI is asked again, and when it can't answer the saved list stands in, saying why.
    const later = new CursorModels({ bin: "/nonexistent/cursor-agent", dataDir, key: () => "", now: () => t + CURSOR_MODELS_TTL_MS + 1 })
    const stale = await later.list()
    expect(stale).toMatchObject({ source: "cache", fetchedAt: t })
    expect(stale.error).toMatch(/isn't installed on the server/)
  })

  it("falls back to the snapshot when the CLI can't list them and nothing is saved, and shares one run between asks", async () => {
    const { models } = make({ FAKE_CURSOR_MODELS: "fail" })
    try {
      const [a, b] = await Promise.all([models.list(), models.list()])
      expect(a).toBe(b)
      expect(a).toMatchObject({ source: "fallback", fetchedAt: null })
      expect(a.models).toEqual(CURSOR_FALLBACK_MODELS)
      expect(a.error).toMatch(/network error/)
      expect(models.peek()).toBe(a)
    } finally {
      delete process.env.FAKE_CURSOR_MODELS
    }
  })

  it("asks with the key agents use, in its own config folder", async () => {
    const dataDir = tmpDir("cursor-models-key-")
    process.env.FAKE_CURSOR_LOGIN = "required"
    try {
      const none = await new CursorModels({ bin: FAKE_CURSOR, dataDir, key: () => "" }).list()
      expect(none.source).toBe("fallback")
      expect(none.error).toMatch(/Authentication required/)
      const keyed = await new CursorModels({ bin: FAKE_CURSOR, dataDir, key: () => "crsr_test_0000" }).list()
      expect(keyed.source).toBe("cli")
      expect(fs.existsSync(path.join(dataDir, "cursor-cli"))).toBe(true)
    } finally {
      delete process.env.FAKE_CURSOR_LOGIN
    }
  })
})

describe("a Cursor key", () => {
  it("passes Test when Cursor lists models with it, and says why when it doesn't", async () => {
    expect(await cursorKeyCheck(FAKE_CURSOR, "crsr_good_0000")).toEqual({ ok: true, text: "10 models available" })
    const bad = await cursorKeyCheck(FAKE_CURSOR, "crsr_invalid_0000")
    expect(bad.ok).toBe(false)
    expect(bad.text).toMatch(/The provided API key is invalid/)
    expect(bad.text).not.toContain("crsr_invalid_0000")
    expect((await cursorKeyCheck("/nonexistent/cursor-agent", "k")).text).toMatch(/isn't installed on the server/)
  })

  it("comes from the project (or task) first, then Settings, else this computer's login", () => {
    expect(cursorTurnLogin({ CURSOR_API_KEY: "own" }, "global")).toEqual({ env: { CURSOR_API_KEY: "own" }, from: "project" })
    expect(cursorTurnLogin({}, "global")).toEqual({ env: { CURSOR_API_KEY: "global" }, from: "global" })
    expect(cursorTurnLogin({}, "")).toEqual({ env: {}, from: null })
  })
})

describe("this computer's cursor-agent", () => {
  it("is found with its version; a stand-in isn't asked for a login", async () => {
    const r = await checkLocal({ claudeBin: "/nonexistent/claude", codexBin: "/nonexistent/codex", cursorBin: FAKE_CURSOR, fakeClaude: true })
    expect(r.check.tools.find((t) => t.key === "cursor")).toMatchObject({ found: true, version: "2026.11.05-fake" })
    expect(r.check.cursorLogin).toBeNull()
  })

  it("reads `cursor-agent status` for its login", async () => {
    const opts = { claudeBin: "/nonexistent/claude", codexBin: "/nonexistent/codex", cursorBin: FAKE_CURSOR, fakeClaude: false }
    expect((await checkLocal(opts)).check.cursorLogin).toBe(true)
    process.env.FAKE_CURSOR_LOGIN = "required"
    try {
      expect((await checkLocal(opts)).check.cursorLogin).toBe(false)
    } finally {
      delete process.env.FAKE_CURSOR_LOGIN
    }
    const missing = await checkLocal({ ...opts, cursorBin: "/nonexistent/cursor-agent" })
    expect(missing.check.tools.find((t) => t.key === "cursor")?.found).toBe(false)
    expect(missing.check.cursorLogin).toBeNull()
  })
})
