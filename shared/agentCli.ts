// Which coding agent CLI runs a Box Yard agent: Claude Code (the default), OpenAI's Codex or Cursor's CLI. The
// Coordinator and the Captains pick Claude Code or Codex (Settings › Coordinator); each project's task agents pick any
// of the three (Settings › Box agents, a project's Agent setting); explicit idle continuation can change it (docs/codex.md,
// docs/cursor.md).
import { EFFORTS } from "./types.js"

export const AGENT_CLIS = ["claude", "codex", "cursor"] as const
export type AgentCli = (typeof AGENT_CLIS)[number]
export const DEFAULT_AGENT_CLI: AgentCli = "claude"

/**
 * The CLIs the Coordinator and Captains run on. Cursor runs task agents only: a manager acts through Box Yard's tools
 * with no shell or file reads (status-only projects), and `cursor-agent` has no way to switch its built-in tools off.
 */
export const MANAGER_CLIS = ["claude", "codex"] as const
export type ManagerCli = (typeof MANAGER_CLIS)[number]
export const DEFAULT_MANAGER_CLI: ManagerCli = "claude"

export const AGENT_CLI_LABEL: Record<AgentCli, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" }

/** Short names the UI shows on chips. */
export const AGENT_CLI_SHORT: Record<AgentCli, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor" }

export const isAgentCli = (v: unknown): v is AgentCli => typeof v === "string" && (AGENT_CLIS as readonly string[]).includes(v)
export const isManagerCli = (v: unknown): v is ManagerCli => typeof v === "string" && (MANAGER_CLIS as readonly string[]).includes(v)

/** Claude uses streaming stdin; Codex uses app-server turn/steer. Cursor waits for the next turn. */
export const canSteer = (cli: AgentCli | null | undefined) => (cli ?? DEFAULT_AGENT_CLI) !== "cursor"

/** A Claude model id or alias (claude-opus-5-5, opus, sonnet[1m], haiku, fable…): Codex can't run it. */
export function isClaudeModel(model: string | null | undefined): boolean {
  return Boolean(model && /^(claude|opus|sonnet|haiku|fable)\b/i.test(model.trim()))
}

/** An OpenAI model id Codex runs (gpt-6.1-sol, gpt-5.6-terra, o3, codex-mini…): Claude Code can't run it. */
export function isOpenAiModel(model: string | null | undefined): boolean {
  return Boolean(model && /^(gpt-|o\d|codex)/i.test(model.trim()))
}

/**
 * A model only Cursor's CLI runs among Box Yard's three: Cursor's own (auto, composer-2.5, cursor-grok-4.6-high…) and
 * other labs' (Gemini, Grok, Kimi, GLM, DeepSeek, Muse). Cursor runs Claude and GPT models too, under its own names
 * (claude-opus-5-5-high), but those names pick Claude Code or Codex unless the task asks for Cursor.
 */
export function isCursorOnlyModel(model: string | null | undefined): boolean {
  return Boolean(model && /^(auto$|composer|cursor-|gemini|grok|kimi|glm|deepseek|muse)/i.test(model.trim()))
}

/** The CLI a model belongs to, when its name says; null for a name no CLI owns (a custom alias). */
export function cliForModel(model: string | null | undefined): AgentCli | null {
  return isClaudeModel(model) ? "claude" : isOpenAiModel(model) ? "codex" : isCursorOnlyModel(model) ? "cursor" : null
}

/**
 * The model a Codex run requests: `chosen` (a task's or the route's) unless it is a Claude model,
 * else the Codex model setting. An explicitly saved empty setting keeps the CLI's own default.
 */
export function codexModel(chosen: string | null | undefined, setting: string | null | undefined): string | null {
  if (chosen && !isClaudeModel(chosen) && !isCursorOnlyModel(chosen)) return chosen.trim()
  return setting == null ? DEFAULT_CODEX_MODEL : setting.trim() || null
}

export const DEFAULT_CODEX_MODEL = "gpt-6.1-sol"
export const DEFAULT_CODEX_EFFORT = "xhigh" as const
export const CODEX_EFFORTS = [...EFFORTS, "ultra"] as const

/** Visible account catalog cached by codex-cli 0.159.2 on 2026-11-03; provenance and limits: docs/codex-model-catalog.md. */
export const CODEX_MODELS = [
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", efforts: CODEX_EFFORTS },
  { id: "gpt-6.1-terra", label: "GPT-6.1 Terra", efforts: CODEX_EFFORTS },
  { id: "gpt-6-astra", label: "GPT-6 Astra", efforts: CODEX_EFFORTS },
  { id: "gpt-6-sol", label: "GPT-6 Sol", efforts: CODEX_EFFORTS },
  { id: "gpt-6-luna", label: "GPT-6 Luna", efforts: EFFORTS },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol (CLI catalog)", efforts: CODEX_EFFORTS },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra (CLI catalog)", efforts: CODEX_EFFORTS },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna (CLI catalog)", efforts: EFFORTS },
] as const

/** Shared with task creation and runner summaries; derived from the same verified catalog. */
export const CODEX_MODEL_SUGGESTIONS = CODEX_MODELS.map((m) => m.id)

// ------------------------------------------------------------------ Cursor (docs/cursor.md)

/** Cursor's own choice of model per request; `cursor-agent models` lists it first, as its default. */
export const DEFAULT_CURSOR_MODEL = "auto"

/** One entry of `cursor-agent models`: the id `--model` takes (effort is part of it) and Cursor's name for it. */
export interface CursorModel {
  id: string
  label: string
}

/**
 * Where Settings' Cursor list came from: the CLI just now (or within the cache's hours), the last list saved on disk,
 * or the static snapshot below when the CLI can't be run here.
 */
export type CursorModelSource = "cli" | "cache" | "fallback"

export interface CursorModelList {
  models: CursorModel[]
  source: CursorModelSource
  /** When the CLI listed them (epoch ms); null for the static snapshot. */
  fetchedAt: number | null
  /** Why the CLI couldn't list them, when it couldn't. */
  error: string | null
}

/**
 * A snapshot of `cursor-agent models` (2026.11.05-86047df, 2026-11-05): what Settings offers when the CLI can't be run
 * on the server. One entry per family at its usual effort; the live list (server/cursor.ts cursorModels) has every
 * variant. Cursor's ids carry the effort (…-low, …-high, …-max) and speed (…-fast).
 */
export const CURSOR_FALLBACK_MODELS: readonly CursorModel[] = [
  { id: "auto", label: "Auto" },
  { id: "composer-2.5", label: "Composer 2.5" },
  { id: "composer-2.5-fast", label: "Composer 2.5 Fast" },
  { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 1M High" },
  { id: "claude-opus-5-5-xhigh", label: "Claude Opus 5.5 1M Extra High" },
  { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 High" },
  { id: "claude-fable-5-1-high", label: "Claude Fable 5.1 1M" },
  { id: "claude-haiku-5-5-thinking-high", label: "Claude Haiku 5.5 High" },
  { id: "gpt-5.6-sol-high", label: "GPT-5.6 Sol 1M High" },
  { id: "gpt-5.6-terra-high", label: "GPT-5.6 Terra 1M High" },
  { id: "gpt-5.6-luna-high-fast", label: "GPT-5.6 Luna 1M High Fast" },
  { id: "gpt-5.3-codex-high", label: "Codex 5.3 High" },
  { id: "gemini-4-argon-high", label: "Gemini 4 Argon High" },
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash High" },
  { id: "grok-4.7-high", label: "Grok 4.7 High" },
  { id: "cursor-grok-4.6-high", label: "Grok 4.6" },
  { id: "kimi-k3-high", label: "Kimi K3 High" },
  { id: "glm-5.2-high", label: "GLM 5.2" },
  { id: "deepseek-v41-flash-1017-high", label: "DeepSeek V4.1 Flash 1017 High" },
]

/** `cursor-agent models` output as a list: its `<id> - <name>` lines, without the "(default)"/"(current)" marks. */
export function parseCursorModels(text: string): CursorModel[] {
  const out: CursorModel[] = []
  const seen = new Set<string>()
  for (const raw of text.split("\n")) {
    // The CLI pads some names with zero-width spaces and colours its output when it thinks it's a terminal.
    const line = raw.replace(/\u001b\[[0-9;]*m/g, "").replace(/[\u200b-\u200d\ufeff]/g, "").trim()
    const m = /^([A-Za-z0-9][A-Za-z0-9._:\[\]=,/-]*)\s+-\s+(.+)$/.exec(line)
    if (!m || seen.has(m[1]!)) continue
    seen.add(m[1]!)
    out.push({ id: m[1]!, label: m[2]!.replace(/\s*\((default|current)\)\s*/gi, " ").replace(/\s+/g, " ").trim() })
  }
  return out
}

/** The family a Cursor model belongs to, for grouping Settings' list. */
export function cursorModelVendor(id: string): string {
  if (/^(auto$|composer)/.test(id)) return "Cursor"
  if (/^claude/.test(id)) return "Anthropic"
  if (/^(gpt-|o\d|codex)/.test(id)) return "OpenAI"
  if (/^gemini/.test(id)) return "Google"
  if (/^(cursor-)?grok/.test(id)) return "xAI"
  return "Other"
}

/**
 * The model a Cursor run passes to `cursor-agent --model`: `chosen` (a task's or the route's) when Cursor runs it (a
 * name only Cursor has, or one in its live list `known`), else the Cursor model setting. A route's Claude alias (opus)
 * or Codex name (gpt-6.1-sol) isn't a Cursor id, so it gives way. An explicitly saved empty setting keeps the CLI's default.
 */
export function cursorModel(chosen: string | null | undefined, setting: string | null | undefined, known?: (id: string) => boolean): string | null {
  const c = chosen?.trim()
  if (c && (isCursorOnlyModel(c) || known?.(c))) return c
  return setting == null ? DEFAULT_CURSOR_MODEL : setting.trim() || null
}

/** The context window a Cursor model's name states ("Claude Opus 5.5 1M High", "GPT-5.6 Sol 272K"), or null. */
export function cursorContextWindow(name: string | null | undefined): number | null {
  const m = /\b(\d+(?:\.\d+)?)\s*([KM])\b/i.exec(name ?? "")
  if (!m) return null
  const n = Number(m[1]) * (m[2]!.toUpperCase() === "M" ? 1_000_000 : 1_000)
  return n >= 8_000 ? Math.round(n) : null
}
