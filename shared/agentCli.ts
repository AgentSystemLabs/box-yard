// Which coding agent CLI runs a Box Yard task: Claude Code (the legacy default), Codex, Cursor or OpenCode. The
// Coordinator and the Captains pick Claude Code or Codex (Settings › Coordinator); each project's task agents pick any
// registered task harnesses (Settings › Box agents, a project's Agent setting); idle continuation can change it (docs/codex.md,
// docs/cursor.md, docs/opencode.md).
import { EFFORTS } from "./types.js"

export const AGENT_CLIS = ["claude", "codex", "cursor", "opencode"] as const
export type AgentCli = (typeof AGENT_CLIS)[number]
export const DEFAULT_AGENT_CLI: AgentCli = "claude"

/**
 * The CLIs the Coordinator and Captains run on. Cursor and OpenCode run tasks only: a manager acts through Box Yard's tools
 * with no shell or file reads (status-only projects), and `cursor-agent` has no way to switch its built-in tools off.
 */
export const MANAGER_CLIS = ["claude", "codex"] as const
export type ManagerCli = (typeof MANAGER_CLIS)[number]
export const DEFAULT_MANAGER_CLI: ManagerCli = "claude"

export const AGENT_CLI_LABEL: Record<AgentCli, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", opencode: "OpenCode" }

/** Short names the UI shows on chips. */
export const AGENT_CLI_SHORT: Record<AgentCli, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor", opencode: "OpenCode" }

export const isAgentCli = (v: unknown): v is AgentCli => typeof v === "string" && (AGENT_CLIS as readonly string[]).includes(v)
export const isManagerCli = (v: unknown): v is ManagerCli => typeof v === "string" && (MANAGER_CLIS as readonly string[]).includes(v)

/** Claude uses streaming stdin; Codex uses app-server turn/steer. Cursor and OpenCode wait for the next turn. */
export const canSteer = (cli: AgentCli | null | undefined) => !(["cursor", "opencode"] as AgentCli[]).includes(cli ?? DEFAULT_AGENT_CLI)

/** Families that can be stored as `sol:latest` and resolved from Cursor's held list at launch. */
export const CURSOR_LATEST_FAMILIES = ["sol", "astra", "terra", "luna", "composer", "opus", "sonnet", "haiku", "fable"] as const
export type CursorLatestFamily = (typeof CURSOR_LATEST_FAMILIES)[number]

const CURSOR_LATEST_LABEL: Record<CursorLatestFamily, string> = {
  sol: "Sol",
  astra: "Astra",
  terra: "Terra",
  luna: "Luna",
  composer: "Composer",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fable: "Fable",
}

/** `sol:latest` → `sol`. Any other string, including a concrete id, is null. */
export function cursorLatestFamily(model: string | null | undefined): CursorLatestFamily | null {
  const m = /^([a-z]+):latest$/i.exec(model?.trim() ?? "")
  if (!m) return null
  switch (m[1]!.toLowerCase()) {
    case "sol": return "sol"
    case "astra": return "astra"
    case "terra": return "terra"
    case "luna": return "luna"
    case "composer": return "composer"
    case "opus": return "opus"
    case "sonnet": return "sonnet"
    case "haiku": return "haiku"
    case "fable": return "fable"
    default: return null
  }
}

export const cursorLatestLabel = (family: CursorLatestFamily) => `Latest ${CURSOR_LATEST_LABEL[family]}`

/** A Claude model id or alias (claude-opus-5-5, opus, sonnet[1m], haiku, fable…): Codex can't run it. */
export function isClaudeModel(model: string | null | undefined): boolean {
  const id = model?.trim()
  if (!id || cursorLatestFamily(id)) return false
  return /^(claude|opus|sonnet|haiku|fable)\b/i.test(id)
}

/** Stored Codex choice that resolves to the catalog's current default when a turn launches. */
export const CODEX_LATEST = "latest"

/** An OpenAI model id Codex runs (gpt-6.2-sol, gpt-5.6-terra, o3, codex-mini, or the stored `latest`): Claude Code can't run it. */
export function isOpenAiModel(model: string | null | undefined): boolean {
  const id = model?.trim()
  if (!id) return false
  if (id.toLowerCase() === CODEX_LATEST) return true
  return /^(gpt-|o\d|codex)/i.test(id)
}

/**
 * A model only Cursor's CLI runs in Box Yard: Cursor's own (auto, composer-2.5, cursor-grok-4.6-high…) and
 * other labs' (Gemini, Grok, Kimi, GLM, DeepSeek, Muse). Cursor runs Claude and GPT models too, under its own names
 * (claude-opus-5-5-high), but those names pick Claude Code or Codex unless the task asks for Cursor.
 */
export function isCursorOnlyModel(model: string | null | undefined): boolean {
  const id = model?.trim()
  if (!id) return false
  if (cursorLatestFamily(id)) return true
  return /^(auto$|composer|cursor-|gemini|grok|kimi|glm|deepseek|muse)/i.test(id)
}

/** The CLI a model belongs to, when its name says; null for a name no CLI owns (a custom alias). */
export function cliForModel(model: string | null | undefined): AgentCli | null {
  return isOpenCodeModel(model) ? "opencode" : isClaudeModel(model) ? "claude" : isOpenAiModel(model) ? "codex" : isCursorOnlyModel(model) ? "cursor" : null
}

/**
 * The model a Codex run requests: `chosen` (a task's or the route's) unless it is a Claude model,
 * else the Codex model setting. An explicitly saved empty setting keeps the CLI's own default.
 * A stored `latest` stays `latest` in Settings and on the task; this resolves it for the launch.
 */
export function codexModel(chosen: string | null | undefined, setting: string | null | undefined): string | null {
  const raw = chosen && !isClaudeModel(chosen) && !isCursorOnlyModel(chosen) && !isOpenCodeModel(chosen)
    ? chosen.trim()
    : setting == null ? DEFAULT_CODEX_MODEL : setting.trim() || null
  return raw && raw.toLowerCase() === CODEX_LATEST ? CODEX_LATEST_MODEL : raw
}

export const DEFAULT_CODEX_MODEL = "gpt-6.1-sol"
export const DEFAULT_CODEX_EFFORT = "xhigh" as const
export const CODEX_EFFORTS = [...EFFORTS, "ultra"] as const
/**
 * What a stored `latest` launches as: catalog priority 1 in the codex-cli 0.171.0 cache (2026-11-23), which is also
 * that CLI's default. Astra is the stronger explicit pick. People who already saved a concrete id stay on it.
 */
export const CODEX_LATEST_MODEL = "gpt-6.2-sol"

/** Visible account catalog cached by codex-cli 0.171.0 on 2026-11-23, priority order; provenance: docs/codex-model-catalog.md. */
export const CODEX_MODELS = [
  { id: CODEX_LATEST, label: "Latest (GPT-6.2 Sol)", efforts: CODEX_EFFORTS },
  { id: "gpt-6.2-sol", label: "GPT-6.2 Sol", efforts: CODEX_EFFORTS },
  { id: "gpt-6.2-astra", label: "GPT-6.2 Astra", efforts: CODEX_EFFORTS },
  { id: "gpt-6.1-terra", label: "GPT-6.1 Terra", efforts: CODEX_EFFORTS },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", efforts: CODEX_EFFORTS },
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
 * A snapshot of `cursor-agent models` (2026.11.05-86047df, 2026-11-05), plus newer OpenAI ids added 2026-11-23.
 * Those ids follow this snapshot's `{base}-high` shape and the Codex catalog names from the same day
 * (`gpt-6.2-sol`, `gpt-6.2-astra`, `gpt-6.1-terra`, `gpt-6-luna`). `cursor-agent models` on this machine required a
 * login, so the 6.x ids were not confirmed by a live Cursor listing. A later live or cached list replaces them.
 * One entry per family at its usual effort; the live list (server/cursor.ts) has every variant. Cursor's ids carry
 * the effort (…-low, …-high, …-max) and speed (…-fast).
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
  { id: "gpt-6.2-sol-high", label: "GPT-6.2 Sol High" },
  { id: "gpt-6.2-astra-high", label: "GPT-6.2 Astra High" },
  { id: "gpt-6.1-terra-high", label: "GPT-6.1 Terra High" },
  { id: "gpt-6-luna-high", label: "GPT-6 Luna High" },
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
 * The model an inherited Cursor route passes to `cursor-agent --model`: `chosen` when Cursor runs it (a
 * name only Cursor has, a stored `sol:latest` alias, or one in its live list `known`), else the Cursor model setting.
 * A route's Claude alias (opus) or Codex name (gpt-6.1-sol) isn't a Cursor id, so it gives way. Explicit task pins
 * bypass this compatibility fallback. An explicitly saved empty setting keeps the CLI's default. This returns a stored
 * alias unchanged; `resolveCursorModel` turns it into a concrete id at launch.
 */
export function cursorModel(chosen: string | null | undefined, setting: string | null | undefined, known?: (id: string) => boolean): string | null {
  const c = chosen?.trim()
  if (c && (isCursorOnlyModel(c) || known?.(c))) return c
  return setting == null ? DEFAULT_CURSOR_MODEL : setting.trim() || null
}

interface ParsedCursorFamily {
  family: string
  version: number[]
  rest: string
}

/** The family, version and effort tail of a concrete Cursor id. Aliases and unknown shapes are null. */
export function cursorFamilyOf(id: string): ParsedCursorFamily | null {
  const gpt = /^gpt-(\d+(?:\.\d+)*)-(sol|astra|terra|luna)(?:-(.*))?$/i.exec(id)
  if (gpt) return { family: gpt[2]!.toLowerCase(), version: gpt[1]!.split(".").map(Number), rest: gpt[3] ?? "" }
  const composer = /^composer-(\d+(?:\.\d+)*)(?:-(.*))?$/i.exec(id)
  if (composer) return { family: "composer", version: composer[1]!.split(".").map(Number), rest: composer[2] ?? "" }
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+(?:-\d+)*)(?:-(.*))?$/i.exec(id)
  if (claude) return { family: claude[1]!.toLowerCase(), version: claude[2]!.split("-").map(Number), rest: claude[3] ?? "" }
  return null
}

/** Usual effort wins: plain `-high` over fast, thinking, and extra-high. `-xhigh` is not `-high`. */
function cursorEffortRank(rest: string): number {
  const parts = rest.toLowerCase().split("-").filter(Boolean)
  if (parts.length === 0) return 1
  if (parts.includes("fast")) return 0
  if (parts.includes("thinking")) return 1
  if (parts.some((p) => p === "xhigh" || p === "max" || p === "ultra")) return 2
  if (parts.includes("medium")) return 3
  if (parts.includes("high")) return 4
  return 1
}

function cmpVersion(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** The newest id of `family` in `models`, preferring usual `-high`. Null when the list has none. */
export function cursorLatestModel(family: string, models: readonly CursorModel[]): CursorModel | null {
  let best: { model: CursorModel; version: number[]; rank: number; index: number } | null = null
  for (let index = 0; index < models.length; index++) {
    const model = models[index]!
    const parsed = cursorFamilyOf(model.id)
    if (!parsed || parsed.family !== family) continue
    const rank = cursorEffortRank(parsed.rest)
    if (!best || cmpVersion(parsed.version, best.version) > 0 || (cmpVersion(parsed.version, best.version) === 0 && rank > best.rank)) {
      best = { model, version: parsed.version, rank, index }
    }
  }
  return best?.model ?? null
}

/** Picker rows for the families this list can resolve. Not written into cursor-models.json. */
export function cursorLatestChoices(models: readonly CursorModel[]): CursorModel[] {
  const out: CursorModel[] = []
  for (const family of CURSOR_LATEST_FAMILIES) {
    const hit = cursorLatestModel(family, models)
    if (!hit) continue
    out.push({ id: `${family}:latest`, label: `${cursorLatestLabel(family)} (${hit.label})` })
  }
  return out
}

/** Concrete models, with a Latest row in front of each family this list can resolve. */
export function cursorPickerModels(models: readonly CursorModel[]): CursorModel[] {
  const choices = cursorLatestChoices(models)
  const alias = new Set(choices.map((m) => m.id))
  return [...choices, ...models.filter((m) => !alias.has(m.id))]
}

/**
 * The id a Cursor launch passes for a stored model. A concrete id is unchanged. `sol:latest` becomes the newest
 * matching id in the list held now. With no match, the alias is passed through so the CLI's error names it.
 */
export function resolveCursorModel(model: string | null | undefined, models: readonly CursorModel[]): string | null {
  const id = model?.trim()
  if (!id) return null
  const family = cursorLatestFamily(id)
  if (!family) return id
  return cursorLatestModel(family, models)?.id ?? id
}

/** The context window a Cursor model's name states ("Claude Opus 5.5 1M High", "GPT-5.6 Sol 272K"), or null. */
export function cursorContextWindow(name: string | null | undefined): number | null {
  const m = /\b(\d+(?:\.\d+)?)\s*([KM])\b/i.exec(name ?? "")
  if (!m) return null
  const n = Number(m[1]) * (m[2]!.toUpperCase() === "M" ? 1_000_000 : 1_000)
  return n >= 8_000 ? Math.round(n) : null
}

// OpenCode's provider/model namespace is distinct from Claude aliases and Codex/Cursor ids.
export const DEFAULT_OPENCODE_MODEL = ""
export const isOpenCodeModel = (model: string | null | undefined): boolean => Boolean(model && /^[a-zA-Z0-9_.-]+\/[^\s/#]+(?:\/[^\s#]+)*(?:#[^\s#]+)?$/.test(model.trim()))

/** Effort controls belong only to harnesses that implement Box Yard's generic effort levels. */
export const hasSeparateEffort = (cli: AgentCli): boolean => cli === "claude" || cli === "codex"

/**
 * Why `cli` can't take these model and effort pins, or null (continue_task, spawn_subtasks). A model another CLI owns
 * doesn't run on it; Cursor runs other labs' models under its own ids, so a Cursor pin must be one only Cursor has or
 * one its catalog (`knownCursor`) lists. Cursor's ids carry their effort, OpenCode takes provider/model#variant with no
 * generic effort, and Ultra is Codex's alone.
 */
export function pinProblem(cli: AgentCli, model: string | null | undefined, effort: string | null | undefined, knownCursor?: (id: string) => boolean): string | null {
  const owner = cliForModel(model)
  if (model && owner && cli !== "cursor" && owner !== cli) return `Model ${model} cannot run on ${AGENT_CLI_LABEL[cli]}. Choose a compatible model or use its defaults.`
  if (model && cli === "cursor" && !cursorModel(model, "", knownCursor)) return `Model ${model} is not a Cursor model in its catalog. Choose a Cursor model or use its defaults.`
  if (effort === "ultra" && cli !== "codex") return "Ultra effort is only available on Codex."
  if (cli === "opencode" && model && !isOpenCodeModel(model)) return "OpenCode models use provider/model or provider/model#variant."
  if (cli === "opencode" && effort) return "OpenCode uses provider-specific variants: omit effort and use provider/model#variant."
  if (cli === "cursor" && effort) return "Cursor's effort is part of its model id; omit effort."
  return null
}
