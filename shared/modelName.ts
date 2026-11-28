// A model named for people, wherever a task says what it ran on (its details, turn timings, a PR's agents):
// "Opus 5.5", not "claude-opus-5-5", and an alias by the model it runs ("opus" is "Opus 5.5") when that's known.
import { CODEX_MODELS, CURSOR_FALLBACK_MODELS, cursorLatestFamily, cursorLatestLabel, type AgentCli, type CursorModel } from "./agentCli.js"
import { BUILTIN_MODELS, claudeIdLabel, findModel, type ClaudeModel } from "./models.js"
import type { Effort, TaskModel } from "./types.js"

export interface ModelNameLists {
  /** The Claude list (GET /api/models), whose aliases know what they run on now; the built-in one by default. */
  claude?: readonly ClaudeModel[]
  /** Cursor's list (GET /api/cursor/models); its snapshot by default. */
  cursor?: readonly CursorModel[]
}

/** "GPT-5.6 Sol (CLI catalog)" is the picker's; the name is "GPT-5.6 Sol". */
const codexLabel = (id: string) => CODEX_MODELS.find((m) => m.id === id)?.label.replace(/\s*\([^)]*\)$/, "") ?? null

const cursorLabel = (id: string, lists: ModelNameLists) => (lists.cursor ?? CURSOR_FALLBACK_MODELS).find((m) => m.id === id)?.label ?? null

/** A Claude model id or alias by name, or null when it isn't one the list (or the id's own parts) can name. */
function claudeLabel(id: string, models: readonly ClaudeModel[]): string | null {
  const m = findModel(models, id)
  if (m?.group === "alias") {
    const runs = m.runsOn && m.runsOn !== id ? claudeLabel(m.runsOn, models.filter((x) => x.group !== "alias")) : null
    return runs ?? m.label
  }
  if (m) return m.label
  // The CLI names a long-context run "claude-opus-5-5[1m]"; the list has the model without it.
  const window = /^(.*)(\[[^\]]*\])$/.exec(id)
  const base = window ? findModel(models, window[1]!) : null
  if (base && base.group !== "alias") return `${base.label} ${window![2]!.toLowerCase()}`
  return claudeIdLabel(id)
}

/**
 * A model id or alias as its name: Claude's by the list's label (an alias by the model the CLI says it runs now, else
 * as it is), a Claude id the list doesn't have yet read from its parts, Codex's and Cursor's by their lists' labels.
 * Anything else (a Cursor label, an OpenCode provider/model) is shown as it is. Without a harness, every list is asked.
 */
export function modelName(id: string, harness?: AgentCli | null, lists: ModelNameLists = {}): string {
  const v = id.trim()
  if (!v) return v
  const family = cursorLatestFamily(v)
  if (family && harness !== "codex" && harness !== "claude" && harness !== "opencode") return cursorLatestLabel(family)
  const claude = () => claudeLabel(v, lists.claude ?? BUILTIN_MODELS)
  if (harness === "codex") return codexLabel(v) ?? v
  if (harness === "cursor") return cursorLabel(v, lists) ?? v
  if (harness === "opencode") return v
  if (harness === "claude") return claude() ?? v
  return claude() ?? codexLabel(v) ?? cursorLabel(v, lists) ?? v
}

/** "Opus 5.5 · xhigh effort": a model and effort as one line; null when neither is known. */
export function modelEffortLine(model: string | null | undefined, effort: Effort | string | null | undefined, harness?: AgentCli | null, lists: ModelNameLists = {}): string | null {
  const parts = [model ? modelName(model, harness, lists) : "", effort ? `${effort} effort` : ""].filter(Boolean)
  return parts.length ? parts.join(" · ") : null
}

/**
 * What the task details say its agent runs on: the latest turn's model as the CLI named it (else as the turn asked),
 * before its first turn what that will ask for, and a task from an older server by its own pins.
 */
export function taskModelLine(
  task: { agentCli?: AgentCli | null; model: string | null; effort: Effort | null; turnModel?: TaskModel | null },
  lists: ModelNameLists = {},
): { text: string; title: string } | null {
  const harness = task.agentCli ?? "claude"
  const tm = task.turnModel
  const text = tm ? modelEffortLine(tm.model, tm.effort, harness, lists) : modelEffortLine(task.model, task.effort, harness, lists)
  if (!text) return null
  if (!tm) return { text, title: "The model and effort this task asked for" }
  const said = tm.from === "ran" ? "The model its latest turn ran on, as the CLI said" : tm.from === "asked" ? "The model its latest turn asked for" : "The model its first turn will run on"
  const asked = tm.from === "ran" && tm.asked && tm.asked !== tm.model ? ` (it asked for ${tm.asked})` : ""
  const where = tm.model && modelName(tm.model, harness, lists) !== tm.model ? `: ${tm.model}` : ""
  return { text, title: `${said}${where}${asked}` }
}
