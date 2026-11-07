// Cursor's CLI (`cursor-agent`) as a Box Yard task agent (docs/cursor.md): its arguments, its token counts in
// Claude's terms, its model list for Settings (read from the CLI, cached here, with a static fallback), and the check
// Settings › Credentials runs on a Cursor API key. Task agents run Cursor through runner/box-runner.mjs (runCursor),
// which has its own copy of the arguments and the translation of its stream-json events (it runs on boxes with plain
// Node); test/cursor-task.e2e.test.ts keeps the two in step. The Coordinator and Captains don't run on Cursor
// (shared/agentCli.ts MANAGER_CLIS).
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { CURSOR_FALLBACK_MODELS, parseCursorModels, type CursorModel, type CursorModelList } from "../shared/agentCli.js"

/** The env var cursor-agent logs in with headless; without it, the computer's own `cursor-agent login`. */
export const CURSOR_KEY_VAR = "CURSOR_API_KEY"

/** cursor-agent names a plugin's MCP server `plugin-<plugin folder>-<server>`: Box Yard's, in the runner's layout. */
export const CURSOR_BOXYARD_SERVER = "plugin-boxyard-boxyard"

export interface CursorRunSpec {
  /** The chat to continue, or start under this id (cursor-agent starts a new chat for an id it hasn't seen). */
  sessionId: string
  model: string | null
  /** The folder holding Box Yard's plugin (.cursor-plugin/plugin.json and mcp.json). */
  pluginDir: string
}

/**
 * Arguments for `cursor-agent` (the prompt goes on stdin): print mode with stream-json, nothing to approve (the box
 * is the sandbox, as with Claude Code's bypassPermissions), and Box Yard's tools as a plugin.
 */
export function cursorAgentArgs(spec: CursorRunSpec): string[] {
  const args = ["-p", "--output-format", "stream-json", "--force", "--trust", "--approve-mcps", "--sandbox", "disabled", "--plugin-dir", spec.pluginDir]
  if (spec.model) args.push("--model", spec.model)
  args.push("--resume", spec.sessionId)
  return args
}

/** Cursor's per-run token counts (camelCase) in Claude's terms: its inputTokens leave the cached ones out, as Claude's do. */
export function cursorUsageOf(u: unknown): Record<string, number> | null {
  if (!u || typeof u !== "object") return null
  const v = u as Record<string, unknown>
  return {
    input_tokens: Number(v.inputTokens) || 0,
    cache_creation_input_tokens: Number(v.cacheWriteTokens) || 0,
    cache_read_input_tokens: Number(v.cacheReadTokens) || 0,
    output_tokens: Number(v.outputTokens) || 0,
  }
}

/** cursor-agent's output as something to show: no colours, no warning glyphs, its own lines (the last few). */
export function cursorErrorText(text: string, lines = 4): string {
  return text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.replace(/^[^\w(]+\s*(?=Warning|Error)/, "").trim())
    .filter((l) => l && !/^at\s/.test(l))
    .slice(-lines)
    .join(" ")
}

/** Env for a cursor-agent run on this server: the server's own, with `key` (or none: this computer's login). */
function cursorEnv(home: string, key: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CURSOR_CONFIG_DIR: home, CURSOR_DATA_DIR: home, NO_COLOR: "1" }
  delete env.BOXYARD_SECRET_KEY
  delete env[CURSOR_KEY_VAR]
  if (key) env[CURSOR_KEY_VAR] = key
  return env
}

/** Run `cursor-agent <args>` to its end, with a time limit. Never throws. */
function runCli(bin: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<{ code: number | null; out: string; err: string; spawnError: string | null }> {
  const [cmd, ...pre] = bin.split(" ")
  return new Promise((resolve) => {
    let out = ""
    let err = ""
    let done = false
    const finish = (code: number | null, spawnError: string | null = null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, out, err, spawnError })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd!, [...pre, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    } catch (e) {
      return finish(null, (e as Error).message)
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(null, `cursor-agent didn't answer within ${Math.round(timeoutMs / 1000)} s`)
    }, timeoutMs)
    child.stdout!.setEncoding("utf8").on("data", (d: string) => (out = (out + d).slice(-200_000)))
    child.stderr!.setEncoding("utf8").on("data", (d: string) => (err = (err + d).slice(-4000)))
    child.on("error", (e: NodeJS.ErrnoException) => finish(null, e.code === "ENOENT" ? `cursor-agent isn't installed on the server (${bin} wasn't found)` : e.message))
    child.on("close", (code) => finish(code))
  })
}

// ------------------------------------------------------------------ the model list

/** How long a list the CLI gave stays fresh: Cursor adds models every few weeks, and Settings has a Refresh. */
export const CURSOR_MODELS_TTL_MS = 6 * 3_600_000
const LIST_TIMEOUT_MS = 30_000

export interface CursorModelsDeps {
  /** The CLI on this server (Config.cursorBin). */
  bin: string
  /** Box Yard's data folder: the last list is kept in cursor-models.json, and the CLI's own state in cursor-cli/. */
  dataDir: string
  /** The Cursor API key in effect (Settings › Credentials), or "" for this computer's own login. */
  key: () => string
  now?: () => number
}

/**
 * Cursor's models as `cursor-agent models` lists them, for Settings › Box agents and the composer. The list depends
 * on the account, so it's read with the key agents use (or this computer's login), kept for CURSOR_MODELS_TTL_MS and
 * saved to disk; when the CLI can't run here (not installed, not logged in, offline) the saved list stands in, and
 * without one, the snapshot in shared/agentCli.ts. Concurrent asks share one CLI run.
 */
export class CursorModels {
  private current: CursorModelList | null = null
  private inflight: Promise<CursorModelList> | null = null
  private readonly file: string
  private readonly now: () => number

  constructor(private readonly d: CursorModelsDeps) {
    this.file = path.join(d.dataDir, "cursor-models.json")
    this.now = d.now ?? Date.now
  }

  /** The list, read again from the CLI when `refresh` or when the one held is stale. */
  async list(refresh = false): Promise<CursorModelList> {
    const held = this.current ?? this.saved()
    if (!refresh && held?.source === "cli" && held.fetchedAt && this.now() - held.fetchedAt < CURSOR_MODELS_TTL_MS) return held
    this.inflight ??= this.fetch().finally(() => (this.inflight = null))
    return this.inflight
  }

  /** The list held now, without running the CLI: for checks that mustn't wait (cursorModel's `known`). */
  peek(): CursorModelList {
    return this.current ?? this.saved() ?? { models: [...CURSOR_FALLBACK_MODELS], source: "fallback", fetchedAt: null, error: null }
  }

  /** Whether `id` is one of Cursor's models, by the list held now (or the snapshot). */
  has(id: string): boolean {
    return this.peek().models.some((m) => m.id === id)
  }

  private async fetch(): Promise<CursorModelList> {
    const home = path.join(this.d.dataDir, "cursor-cli")
    let error: string
    try {
      fs.mkdirSync(home, { recursive: true, mode: 0o700 })
      const r = await runCli(this.d.bin, ["models"], cursorEnv(home, this.d.key() || null), home, LIST_TIMEOUT_MS)
      const models = r.code === 0 ? parseCursorModels(r.out) : []
      if (models.length) {
        const list: CursorModelList = { models, source: "cli", fetchedAt: this.now(), error: null }
        this.current = list
        this.save(list)
        return list
      }
      error = r.spawnError ?? (cursorErrorText(`${r.err}\n${r.out}`) || `cursor-agent models exited with code ${r.code}`)
    } catch (e) {
      error = (e as Error).message
    }
    const saved = this.saved()
    const list: CursorModelList = saved ? { ...saved, source: "cache", error } : { models: [...CURSOR_FALLBACK_MODELS], source: "fallback", fetchedAt: null, error }
    this.current = list
    return list
  }

  private saved(): CursorModelList | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"))
      const models: CursorModel[] = Array.isArray(raw?.models) ? raw.models.filter((m: any) => typeof m?.id === "string" && typeof m?.label === "string") : []
      if (!models.length) return null
      return { models, source: "cli", fetchedAt: typeof raw.fetchedAt === "number" ? raw.fetchedAt : null, error: null }
    } catch {
      return null
    }
  }

  private save(list: CursorModelList) {
    try {
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ models: list.models, fetchedAt: list.fetchedAt }))
      fs.renameSync(tmp, this.file)
    } catch {}
  }
}

// ------------------------------------------------------------------ the key check

/**
 * Settings › Credentials' Test for a Cursor API key: `cursor-agent models` with only that key, in a throwaway config
 * folder. It costs no request to a model, and Cursor refuses a key it doesn't know ("The provided API key is invalid").
 */
export async function cursorKeyCheck(bin: string, key: string, timeoutMs = LIST_TIMEOUT_MS): Promise<{ ok: boolean; text: string }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "box-yard-cursor-check-"))
  try {
    const r = await runCli(bin, ["models"], cursorEnv(home, key), home, timeoutMs)
    const models = r.code === 0 ? parseCursorModels(r.out) : []
    if (models.length) return { ok: true, text: `${models.length} models available` }
    return { ok: false, text: r.spawnError ?? (cursorErrorText(`${r.err}\n${r.out}`) || `cursor-agent exited with code ${r.code}`) }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}
