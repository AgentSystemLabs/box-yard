// The Coordinator's and Captains' chat picks. "@" picks where the tasks a message leads to run (`@local`, `@box`,
// `@docker`, `@gpu` (the Default GPU cloud), `@gpu:<cloud>`, `@gpu:<cloud>:<gpu>`, an SSH machine by name,
// `@label:<label>`); "!" picks the agent CLI (harness) they run on
// (`!claude`, `!codex`, `!cursor`). Both lists are built from the server's real runners, machines and CLIs (GET /api/run-targets
// and /api/harness-targets, server/runTargets.ts), never hard-coded, and the composer's Where and Harness buttons
// pick from the same lists. A pick goes with the message as meta.runsOn / meta.agent (a RunTargetPick), the turn's
// prompt says so, and the task tools take it as their runs_on / agent for that turn (server/mcp.ts). A runs_on pick's
// `value` is a runs_on as the task tools take it (resolveRunsOn); an agent pick's is "claude", "codex" or "cursor".
// In the Coordinator's chat only, "%" picks the project the message is about (`%box-yard`): it goes as meta.project and
// the turn's prompt tells the Coordinator to route the message to that project's Captain (server/runTargets.ts).
// Only the whole message's picks go that way. One typed for part of it (inside one item of a list of tasks, or one
// that disagrees with another) goes as meta.inlinePicks: the prompt lists it with where it is, and nothing applies it
// (scopePicks).

import { normalizeLabel, THIS_COMPUTER, type MachineState } from "./machines.js"
import { RUNNER_LABEL, type Runner } from "./runner.js"
import { AGENT_CLI_LABEL, AGENT_CLIS, cliForModel, CODEX_MODEL_SUGGESTIONS, isAgentCli, type AgentCli } from "./agentCli.js"
import { GPU_PROVIDER_LABEL, GPU_PROVIDERS, type GpuProvider } from "./gpu.js"
import { gpuChoices, gpuTypesWords } from "./gpuCatalog.js"
import { BOX_SIZE_ORDER, BOX_SIZE_SPECS, sizeSpecLine } from "./boxSizes.js"
import { DAYTONA_SIZES } from "./daytona.js"
import { DAYTONA_SIZE_ALIASES } from "./runnerSizes.js"
import { rankPickerOptions, type PickerField } from "./pickerRank.js"
import type { Effort } from "./types.js"

/** "gpu" is one GPU cloud ("@gpu:daytona") or one GPU on it ("@gpu:daytona:h100"). */
export type RunTargetKind = "runner" | "machine" | "label" | "harness" | "project" | "gpu"

/** The two picks a chat message can carry: where its tasks run ("@") and the agent CLI they run on ("!"). */
export type PickKind = "runsOn" | "agent"
export const PICK_KINDS: readonly PickKind[] = ["runsOn", "agent"]
/** What starts a pick in the text. Only at the start of a word, so "great!" and "me@host" never open a list. */
export const PICK_TRIGGER: Record<PickKind, "@" | "!"> = { runsOn: "@", agent: "!" }
/** The Coordinator chat's project pick ("%box-yard"). Same rule: only at the start of a word, so "%%" and "a%b" never open it. */
export const PROJECT_TRIGGER = "%"
/** Any of the chat's pick triggers. */
export type PickTrigger = "@" | "!" | "%"
/** A tag a chat's draft can hold: where its tasks run, their harness, or (the Coordinator's) the project it's for. */
export type TagKind = PickKind | "project"
/** What starts each kind of tag. */
export const TAG_TRIGGER: Record<TagKind, PickTrigger> = { ...PICK_TRIGGER, project: PROJECT_TRIGGER }

export interface RunTarget {
  /** What follows "@" (or "!"): "local", "box", "studio-mac", "label:gpu" ("claude", "codex", "cursor"). Lowercase. */
  token: string
  /** Accepted typed spellings; the picker inserts the canonical token. */
  aliases?: string[]
  /** The runs_on it means: "local", "box", "this_computer", "label:studio-mac" (a harness: its agent CLI). */
  value: string
  kind: RunTargetKind
  /** What it is, for the list and the sent message's chip: "This computer", "Upstash box", "Studio Mac". */
  label: string
  /** A short second line: a machine's state, a label's machines, what Local means points at. */
  detail: string | null
  /** Why it can't be picked now (shown, greyed out), or null. */
  disabled: string | null
  /**
   * One GPU's row: the token of its cloud's row ("gpu:daytona"). The typed list shows it only once that's typed, or
   * its GPU's name ("@h100"), so a bare "@" isn't a list of every GPU (`filterRunTargets`).
   */
  under?: string
  /** Label for this parent when offered as the first choice inside its own submenu. */
  defaultLabel?: string
  /** Short label in a drill-down; the full label remains on the sent pick. */
  menuLabel?: string
  /** An explicit model/effort on a harness pick. Omitted fields follow that harness's Settings. */
  model?: string
  effort?: Effort
}

/** A sent message's pick (meta.runsOn, meta.agent): enough to show its chip without the list. */
export interface RunTargetPick {
  value: string
  token: string
  label: string
  model?: string
  effort?: Effort
}

/** What the server knows, for buildRunTargets. */
export interface RunTargetSources {
  /**
   * Each runner's problem (Setup.runnerProblem): null when it can run tasks, a reason when it can't. Docker and GPU
   * are left out of the list while they can't (they're opt-in); this computer and Upstash boxes show greyed out.
   */
  problems: Record<Exclude<Runner, "ssh">, string | null>
  /** Cody's SSH machines (Settings › Machines). */
  machines: { name: string; labels: string[]; state?: MachineState; problem?: string | null }[]
  /** Settings › Machines › Local means: null is this computer. */
  localLabel: string | null
  /** A project's identity rules a runner out (Identities.runnerProblem); only for a Captain's list. */
  identityProblem?: (runner: Runner) => string | null
  /**
   * The GPU clouds: plain "@gpu" is `default` (a Captain's: its project's cloud, else Settings' Default GPU cloud), and
   * each cloud that can run tasks gets "@gpu:<cloud>" plus a row per GPU it offers (its guide's, then the types its
   * settings name). Without it, "@gpu" is one row.
   */
  gpu?: { default: GpuProvider; problems: Record<GpuProvider, string | null>; types: Record<GpuProvider, readonly string[]> }
}

const HIDDEN_WHEN_UNAVAILABLE: Runner[] = ["docker", "gpu"]

const STATE_DETAIL: Record<MachineState, string> = {
  ready: "SSH · ready",
  busy: "SSH · busy (tasks wait)",
  offline: "SSH · offline (tasks wait)",
  problem: "SSH · has a problem (tasks wait)",
  off: "SSH · turned off (tasks wait)",
  untested: "SSH · not tested yet",
}

/** The "@" list, in this order: runners, SSH machines, any SSH machine, labels. Tokens are unique. */
export function buildRunTargets(s: RunTargetSources): RunTarget[] {
  const out: RunTarget[] = []
  const blocked = (runner: Runner, problem: string | null) => problem ?? s.identityProblem?.(runner) ?? null
  const sshProblem = s.machines.length ? null : "no SSH machine is set up (Settings › Machines)"
  const local = s.localLabel
  if (local) {
    const has = s.machines.some((m) => m.labels.includes(local) || normalizeLabel(m.name) === local)
    out.push({
      token: "local",
      value: "local",
      kind: "runner",
      label: `SSH machines labelled ${local}`,
      detail: "What Local means in Settings › Machines",
      disabled: blocked("ssh", has ? null : `no SSH machine has the label ${local}`),
    })
    out.push({ token: "this-computer", value: THIS_COMPUTER, kind: "runner", label: "This computer", detail: "Box Yard's own computer", disabled: blocked("local", s.problems.local) })
  } else {
    out.push({ token: "local", value: "local", kind: "runner", label: "This computer", detail: "Box Yard's own computer", disabled: blocked("local", s.problems.local) })
  }
  out.push({ token: "box", value: "box", kind: "runner", label: "Upstash box", detail: "A cloud sandbox", disabled: blocked("box", s.problems.box), defaultLabel: "Default size" })
  out.push(...BOX_SIZE_ORDER.map((size): RunTarget => ({ token: `box:${size}`, aliases: [`box-${size}`], value: `box:${size}`, kind: "runner", label: `Upstash ${BOX_SIZE_SPECS[size].label}`, detail: sizeSpecLine(size), disabled: blocked("box", s.problems.box), under: "box" })))
  for (const runner of ["docker", "gpu"] as const) {
    const problem = s.gpu && runner === "gpu" ? s.gpu.problems[s.gpu.default] : s.problems[runner]
    if (problem && HIDDEN_WHEN_UNAVAILABLE.includes(runner)) continue
    out.push({
      token: runner,
      value: runner,
      kind: "runner",
      label: runner === "docker" ? "Docker container" : "GPU",
      detail: runner === "docker" ? "On this computer" : s.gpu ? `Default: ${GPU_PROVIDER_LABEL[s.gpu.default]}` : "RunPod, Vast.ai or Daytona",
      disabled: blocked(runner, problem),
    })
  }
  if (s.gpu) out.push(...gpuTargets(s.gpu, (problem) => blocked("gpu", problem)))
  if (s.gpu && !s.gpu.problems.daytona) {
    const disabled = blocked("gpu", null)
    out.push({ token: "daytona", value: "gpu:daytona", kind: "gpu", label: "Daytona", detail: "CPU sizes and GPU machine types", disabled, defaultLabel: "Default machine" })
    out.push(...DAYTONA_SIZES.map((size): RunTarget => {
      const key = size.key.toLowerCase()
      const friendly = Object.keys(DAYTONA_SIZE_ALIASES).find((alias) => DAYTONA_SIZE_ALIASES[alias] === key)
      return { token: `daytona:${key}`, aliases: [`daytona-${key}`, `gpu:daytona:${key}`, ...(friendly ? [`daytona:${friendly}`, `daytona-${friendly}`] : [])], value: `daytona:${key}`, kind: "gpu", label: `Daytona ${size.label}`, detail: `${size.vcpus} vCPU · ${size.memoryGb} GB RAM · ${size.diskGb} GB disk`, disabled, under: "daytona" }
    }))
  }
  const taken = new Set(out.flatMap((t) => [t.token, ...(t.aliases ?? [])]))
  for (const m of [...s.machines].sort((a, b) => a.name.localeCompare(b.name))) {
    const name = normalizeLabel(m.name)
    if (!name) continue
    const token = taken.has(name) ? `label:${name}` : name
    if (taken.has(token)) continue
    taken.add(token)
    out.push({
      token,
      value: `label:${name}`,
      kind: "machine",
      label: m.name,
      detail: m.state ? STATE_DETAIL[m.state] : "SSH machine",
      disabled: blocked("ssh", sshProblem),
    })
  }
  if (s.machines.length) {
    out.push({ token: "ssh", value: "ssh", kind: "runner", label: "Any SSH machine", detail: "The first free one", disabled: blocked("ssh", sshProblem) })
    taken.add("ssh")
  }
  const labels = new Map<string, string[]>()
  for (const m of s.machines) for (const l of m.labels) labels.set(l, [...(labels.get(l) ?? []), m.name])
  for (const [label, names] of [...labels.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const token = `label:${label}`
    if (taken.has(token)) continue
    taken.add(token)
    out.push({ token, value: token, kind: "label", label: `Machines labelled ${label}`, detail: names.join(", "), disabled: blocked("ssh", sshProblem) })
  }
  return out
}

/**
 * "@gpu:<cloud>" for each GPU cloud that can run tasks (one that can't is left out, as "@gpu" is), each with a row
 * per GPU it offers under it: "@gpu:daytona:h100".
 */
function gpuTargets(g: NonNullable<RunTargetSources["gpu"]>, blocked: (problem: string | null) => string | null): RunTarget[] {
  return GPU_PROVIDERS.filter((cloud) => !g.problems[cloud]).flatMap((cloud): RunTarget[] => {
    const token = `gpu:${cloud}`
    const disabled = blocked(null)
    const configured = g.types[cloud]
    const types = gpuTypesWords(cloud, configured)
    const cloudRow: RunTarget = {
      token,
      value: token,
      kind: "gpu",
      defaultLabel: "Any GPU",
      label: `${GPU_PROVIDER_LABEL[cloud]}${cloud === "daytona" ? "" : " GPU"}`,
      detail: `${cloud === g.default ? "Default cloud · " : ""}${types || "its own GPU types"}`,
      disabled,
    }
    const gpus = gpuChoices(cloud, configured).map(
      (c): RunTarget => ({ token: `${token}:${c.slug}`, value: `${token}:${c.slug}`, kind: "gpu", label: `${GPU_PROVIDER_LABEL[cloud]} ${c.label}`, detail: c.hint, disabled, under: token }),
    )
    return [cloudRow, ...gpus]
  })
}

/** What the server knows for the "!" list: each CLI's problem on the runner the message's tasks go to. */
export interface HarnessSources {
  /**
   * Null when the CLI is installed and signed in for that runner. A CLI with a problem is left out of the list,
   * except one `blocked` names: that shows greyed out, so a typed pick can be warned about.
   */
  problems: Record<AgentCli, string | null>
  blocked?: Partial<Record<AgentCli, string>>
}

/** Model names each harness takes, for its second line in the "!" list. */
export const HARNESS_MODELS: Record<AgentCli, string> = {
  claude: "opus · sonnet · haiku",
  codex: CODEX_MODEL_SUGGESTIONS.slice(0, 2).join(" · "),
  cursor: "auto · composer · any lab's",
}

/** The "!" list: Claude Code, Codex and Cursor, each only where it can run the message's tasks. */
export function buildHarnessTargets(s: HarnessSources): RunTarget[] {
  return AGENT_CLIS.flatMap((cli): RunTarget[] => {
    const blocked = s.blocked?.[cli] ?? null
    if (s.problems[cli] && !blocked) return []
    return [{ token: cli, value: cli, kind: "harness", label: AGENT_CLI_LABEL[cli], detail: HARNESS_MODELS[cli], disabled: blocked }]
  })
}

/** The target a runs_on value names, by value (what the client sends). */
export const findRunTarget = (targets: RunTarget[], value: string): RunTarget | null => targets.find((t) => t.value === value.trim() || t.aliases?.includes(value.trim().toLowerCase())) ?? null

export const pickOf = (t: RunTarget): RunTargetPick => ({ value: t.value, token: t.token, label: t.label, ...(t.model !== undefined ? { model: t.model } : {}), ...(t.effort ? { effort: t.effort } : {}) })

/** A project's "%" token: its name in lowercase, with anything a token can't hold (spaces, slashes) as "-". */
export const projectToken = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project"

/** The Coordinator chat's "%" list: Cody's projects in their saved order. Its `value` is the project id. */
export function buildProjectTargets(projects: { id: string; name: string; repo?: string | null }[]): RunTarget[] {
  return projects.map((p) => ({ token: projectToken(p.name), value: p.id, kind: "project", label: p.name, detail: p.repo || null, disabled: null }))
}

/** A message's meta.runsOn (or meta.agent, meta.project), when it's well formed. */
export function runTargetPickOf(meta: Record<string, unknown> | null | undefined, kind: PickKind | "project" = "runsOn"): RunTargetPick | null {
  const v = meta?.[kind] as Partial<RunTargetPick> | undefined
  if (!v || typeof v !== "object" || typeof v.value !== "string" || typeof v.token !== "string") return null
  if (kind === "agent" && !isAgentCli(v.value)) return null
  return { value: v.value, token: v.token, label: typeof v.label === "string" ? v.label : v.token, ...(kind === "agent" && typeof v.model === "string" ? { model: v.model } : {}), ...(kind === "agent" && typeof v.effort === "string" ? { effort: v.effort } : {}) }
}

/** A turn's picks, one per kind (TurnPicks.runsOn: where; .agent: which CLI). */
export interface TurnPicks {
  runsOn: RunTargetPick | null
  agent: RunTargetPick | null
}
export const NO_PICKS: TurnPicks = { runsOn: null, agent: null }

/** What makes two picks the same: the value, and a harness pick's model and effort ("!codex" isn't "!codex:o3"). */
export const pickKey = (p: Pick<RunTargetPick, "value" | "model" | "effort">) => `${p.value}\u0000${p.model ?? ""}\u0000${p.effort ?? ""}`

/**
 * The one pick of a kind a turn enforces: every message in it that has one agrees. None, or two that differ: null
 * (the prompt still says each message's own). A message's inline pick of the kind that differs (one for a list item,
 * meta.inlinePicks) is a disagreement too: the turn must leave that item's task free to follow it.
 */
export function turnPick(metas: (Record<string, unknown> | null | undefined)[], kind: PickKind = "runsOn"): RunTargetPick | null {
  const picks = metas.map((m) => runTargetPickOf(m, kind)).filter((p): p is RunTargetPick => p !== null)
  if (!picks.length) return null
  const values = new Set([...picks.map(pickKey), ...metas.flatMap((m) => inlinePicksOf(m).filter((p) => p.kind === kind).map(pickKey))])
  return values.size === 1 ? picks[picks.length - 1]! : null
}

/** Both of a turn's picks. */
export const turnPicks = (metas: (Record<string, unknown> | null | undefined)[]): TurnPicks => ({ runsOn: turnPick(metas, "runsOn"), agent: turnPick(metas, "agent") })

// ---- inline picks: ones typed for one part of a message, which Box Yard passes on as hints and never applies

/** Any pick a message can name: where ("@"), which harness ("!"), and the Coordinator's project ("%"). */
export type MessagePickKind = PickKind | "project"

/**
 * Why a typed pick isn't the whole message's: it's in one item of a list of tasks ("item"); the message names
 * another pick of its kind too ("mixed"); or its words ask for another harness ("words": "use Codex gpt-6.1-sol").
 */
export type InlineReason = "item" | "mixed" | "words"

/**
 * A pick Cody typed that's only for part of the message (meta.inlinePicks): the turn's prompt lists it, where it
 * is, for the Coordinator or Captain to pass on the tasks it's for. Box Yard never applies it to the turn.
 */
export interface InlinePick extends RunTargetPick {
  kind: MessagePickKind
  /** The list item it's in, as Cody numbered it, with its first words: `item 9 ("Port the pickaxe…")`. Null: outside the list. */
  where: string | null
  reason: InlineReason
}

/** A message's meta.inlinePicks, the well-formed ones. */
export function inlinePicksOf(meta: Record<string, unknown> | null | undefined): InlinePick[] {
  const list = meta?.inlinePicks
  if (!Array.isArray(list)) return []
  return list.flatMap((v: Partial<InlinePick> | null): InlinePick[] => {
    if (!v || typeof v !== "object" || typeof v.value !== "string" || typeof v.token !== "string") return []
    if (v.kind !== "runsOn" && v.kind !== "agent" && v.kind !== "project") return []
    if (v.kind === "agent" && !isAgentCli(v.value)) return []
    const reason: InlineReason = v.reason === "mixed" || v.reason === "words" ? v.reason : "item"
    const choice = v.kind === "agent" ? { ...(typeof v.model === "string" ? { model: v.model } : {}), ...(typeof v.effort === "string" ? { effort: v.effort } : {}) } : {}
    return [{ kind: v.kind, value: v.value, token: v.token, label: typeof v.label === "string" ? v.label : v.token, ...choice, where: typeof v.where === "string" ? v.where : null, reason }]
  })
}

/** A top-level item of a message's numbered or bulleted list: its span, and how to name it ("item 9", "bullet 2"). */
export interface ListItem {
  start: number
  end: number
  label: string
}

// "1. ", "9) ", "(3) ", "- ", "* ", "+ ", "• " at the start of a line, before the item's first word.
const ITEM_MARK = /^([ \t]*)(?:(\d{1,3})[.)]|\((\d{1,3})\)|[-*+•])[ \t]+(?=\S)/

/**
 * The top-level items of the list a message holds. An item runs to the next one at its indent; a deeper marker (a
 * sub-list) and the lines right under it belong to it; a blank line and then a line at the list's indent that isn't
 * an item ends the list.
 */
export function listItems(text: string): ListItem[] {
  const lines: { start: number; end: number; mark: RegExpExecArray | null; blank: boolean; indent: number }[] = []
  let at = 0
  for (const line of text.split("\n")) {
    const mark = ITEM_MARK.exec(line)
    lines.push({ start: at, end: at + line.length, mark, blank: !line.trim(), indent: /^[ \t]*/.exec(line)![0].replace(/\t/g, "    ").length })
    at += line.length + 1
  }
  const marked = lines.filter((l) => l.mark)
  if (!marked.length) return []
  const top = Math.min(...marked.map((l) => l.indent))
  const items: ListItem[] = []
  let open: ListItem | null = null
  let bullets = 0
  let afterBlank = false
  for (const l of lines) {
    if (l.blank) {
      afterBlank = true
      continue
    }
    if (l.mark && l.indent <= top) {
      if (open) items.push(open)
      const n = l.mark[2] ?? l.mark[3]
      open = { start: l.start, end: l.end, label: n ? `item ${Number(n)}` : `bullet ${++bullets}` }
    } else if (open && afterBlank && l.indent <= top) {
      items.push(open)
      open = null
    } else if (open) {
      open.end = l.end
    }
    afterBlank = false
  }
  if (open) items.push(open)
  return items
}

/** A typed pick in a message: what tokensIn found, for any kind. */
export interface PlacedPick {
  kind: MessagePickKind
  target: RunTarget
  start: number
  end: number
}

/** A typed pick with what it's for: the whole message, or only its part (then `reason` and `item` say why and which). */
export interface ScopedPick extends PlacedPick {
  scope: "message" | "inline"
  item: ListItem | null
  reason: InlineReason | null
}

/** A message's typed picks, scoped, in text order: `wide` is the one pick of each kind for the whole message (applied), or null. */
export interface MessagePicks {
  wide: Record<MessagePickKind, RunTarget | null>
  picks: ScopedPick[]
}

// "use Codex", "with cursor", "run it on Claude Code": words that ask for a harness by name.
const HARNESS_WORDS = /\b(?:use|using|with|via|on|(?:run|runs|running)(?:\s+(?:it|them))?|switch(?:ed)?\s+to)\s+(?:the\s+)?(claude|codex|cursor)\b/gi
// A model id with a version in it ("gpt-6.1-sol", "claude-opus-5-5", "o3"): it names the CLI that runs it.
const MODEL_WORD = /(?<![\w.-])[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*(?![\w-])/gi

/**
 * The harnesses a message's own words ask for, besides its "!" tokens: "use Codex gpt-6.1-sol xhigh" asks for Codex.
 * Bare words such as "haiku" or "composer" don't count, only a CLI named after use/with/on or a model id with a digit.
 */
export function harnessesInWords(text: string, placed: Pick<PlacedPick, "start" | "end">[] = []): Set<AgentCli> {
  let plain = text
  for (const p of placed) plain = plain.slice(0, p.start) + " ".repeat(p.end - p.start) + plain.slice(p.end)
  const out = new Set<AgentCli>()
  for (const m of plain.matchAll(HARNESS_WORDS)) out.add(m[1]!.toLowerCase() as AgentCli)
  for (const m of plain.matchAll(MODEL_WORD)) {
    if (!/\d/.test(m[0])) continue
    const cli = cliForModel(m[0])
    if (cli) out.add(cli)
  }
  return out
}

/**
 * Which of a message's typed picks are the whole message's, and which only one part's (shared by the composer, its
 * chips and what it sends). A pick is the message's when nothing in it says otherwise:
 * - In a message with a list of two or more items (a numbered or bulleted list of tasks), a pick inside an item is
 *   that item's. One outside the list (a line above it, say) is the whole message's, unless an item names another
 *   pick of its kind: then each is only for its own part.
 * - Two different picks of a kind for the whole message: neither is (each says where it is).
 * - A harness pick with words asking for another one ("!claude … use Codex gpt-6.1-sol"): not the message's.
 * The message's picks go as meta.runsOn / meta.agent / meta.project and Box Yard applies them to the turn; the rest go
 * as meta.inlinePicks, which the turn's prompt only lists for the Coordinator or Captain to pass on.
 */
export function scopePicks(text: string, placed: PlacedPick[]): MessagePicks {
  const items = listItems(text)
  const list = items.length >= 2
  const itemAt = (at: number) => (list ? (items.find((i) => at >= i.start && at <= i.end) ?? null) : null)
  const wide: Record<MessagePickKind, RunTarget | null> = { runsOn: null, agent: null, project: null }
  const reasons = new Map<PlacedPick, InlineReason>()
  const words = placed.some((p) => p.kind === "agent") ? harnessesInWords(text, placed) : new Set<AgentCli>()
  for (const kind of ["runsOn", "agent", "project"] as const) {
    const all = placed.filter((p) => p.kind === kind)
    if (!all.length) continue
    const inItems = all.filter((p) => itemAt(p.start))
    const outside = all.filter((p) => !itemAt(p.start))
    for (const p of inItems) reasons.set(p, "item")
    const values = new Set(outside.map((p) => pickKey(p.target)))
    const candidate = outside.at(-1)
    if (!candidate) continue
    const mixed = values.size > 1 || inItems.some((p) => pickKey(p.target) !== pickKey(candidate.target))
    const contrary = kind === "agent" && [...words].some((cli) => cli !== candidate.target.value)
    if (mixed || contrary) for (const p of outside) reasons.set(p, mixed ? "mixed" : "words")
    else {
      wide[kind] = candidate.target
      // An item that names the message's own pick again is covered by it.
      for (const p of inItems) reasons.delete(p)
    }
  }
  return {
    wide,
    picks: [...placed]
      .sort((a, b) => a.start - b.start)
      .map((p) => {
        const reason = reasons.get(p) ?? null
        return { ...p, scope: reason ? "inline" : "message", item: itemAt(p.start), reason }
      }),
  }
}

/** The words of a list item that say which it is: its first words, without its marker or picks, clipped. */
export function itemExcerpt(text: string, item: ListItem, max = 48): string {
  const first = text.slice(item.start, item.end).split("\n")[0]!.replace(ITEM_MARK, "")
  const words = first
    .replace(/(^|\s)[@!%](?:[A-Za-z0-9._:%-]|\[[A-Za-z0-9]+\])+/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/ ([,.;:!?])/g, "$1")
    .trim()
  return words.length > max ? `${words.slice(0, max - 1).trimEnd()}…` : words
}

/** A message's inline picks as they go with it (meta.inlinePicks): each one not for the whole message. */
export function inlinePicksFrom(text: string, scoped: MessagePicks): InlinePick[] {
  return scoped.picks
    .filter((p) => p.scope === "inline")
    .map((p) => ({
      kind: p.kind,
      ...pickOf(p.target),
      where: p.item ? `${p.item.label}${itemExcerpt(text, p.item) ? ` ("${itemExcerpt(text, p.item)}")` : ""}` : null,
      reason: p.reason!,
    }))
}

// ---- the composer's side: the "@word" or "!word" being typed, filtering, inserting, and which picks a draft holds

const TOKEN_CHARS = /[A-Za-z0-9._:%\[\]-]/

/**
 * The "@word" ("!word", "%word") the caret is in or right after, when it starts a word: what the list filters by.
 * A word starts at the start of the text, after whitespace or after ( [ " '; so "great!", "me@host", "%%" and "a%b" don't.
 */
export function mentionAt(text: string, caret: number, trigger: PickTrigger = "@"): { start: number; end: number; query: string } | null {
  let i = caret
  while (i > 0 && text[i - 1] !== trigger && TOKEN_CHARS.test(text[i - 1]!)) i--
  if (i === 0 || text[i - 1] !== trigger) return null
  const at = i - 1
  if (at > 0 && !/[\s(["']/.test(text[at - 1]!)) return null
  let end = caret
  while (end < text.length && TOKEN_CHARS.test(text[end]!)) end++
  return { start: at, end, query: text.slice(i, caret).toLowerCase() }
}

/** Searchable fields for one run-target row (token, labels, aliases). Detail is omitted so a machine listed in another row's blurb doesn't steal the match. */
export function runTargetFields(t: RunTarget): PickerField[] {
  const fields: PickerField[] = [
    { text: t.token, kind: "token" },
    { text: t.menuLabel ?? "", kind: "label" },
    { text: t.label, kind: "label" },
  ]
  for (const alias of t.aliases ?? []) fields.push({ text: alias, kind: "alias" })
  return fields
}

/**
 * The list filtered by what's typed after "@" / "!" / "%": ranked by shared/pickerRank.ts (exact > prefix > word >
 * substring > fuzzy). A GPU's row (`under` its cloud's) shows once its cloud's token is typed ("@gpu:daytona"), or
 * its GPU's own name ("@h100", "@rtx"). Nested levels (harness → model → effort, box sizes) filter the same way on
 * the text after the parent's token. `fuzzy` defaults on; pass false only for strict callers (legacy tests).
 */
export function filterRunTargets(all: RunTarget[], query: string, fuzzy = true): RunTarget[] {
  const q = query.trim().toLowerCase()
  const parent = runTargetParent(all, q)
  if (parent) {
    const term = q.slice(parent.token.length).replace(/^:/, "")
    const children = all.filter((t) => t.under === parent.token)
    const ranked = term
      ? rankPickerOptions(children, term, (t) => {
          const suffix = t.token.slice(parent.token.length + 1)
          return [{ text: suffix, kind: "token" }, ...runTargetFields(t)]
        }, fuzzy)
      : children
    return [...(!term ? [{ ...parent, menuLabel: parent.defaultLabel! }] : []), ...ranked]
  }
  // A GPU's name: any word of its slug ("4090" finds rtx-4090).
  const named = (t: RunTarget) => q.length >= 2 && `-${t.token.slice(t.under!.length + 1).replace(/^(cpu|gpu)-/, "")}`.includes(`-${q}`)
  const targets = all.filter((t) => !t.under || (t.kind !== "harness" && (q.startsWith(t.under) || (t.aliases?.some((a) => a.startsWith(q)) && q.length > t.under.length) || named(t))))
  if (!q) return targets
  return rankPickerOptions(targets, q, runTargetFields, fuzzy)
}

/** The deepest open drill-down, shared by filtering and the composer's Back/Esc behavior. */
export const runTargetParent = (all: RunTarget[], query: string): RunTarget | undefined =>
  all.filter((t) => t.defaultLabel && (query === t.token || query.startsWith(`${t.token}:`)) && all.some((x) => x.under === t.token)).sort((a, b) => b.token.length - a.token.length)[0]

/**
 * `text` with the "@word" at `m` replaced by `@token ` ("!token " for `trigger` "!"), and where the caret goes.
 * `drill` leaves the caret right after `token:` (trailing colon, no space) so typing continues as the nested filter
 * ("!cursor:" then "deep" finds DeepSeek) without discovering the colon by hand (`drillsInto`, `advancesInto`).
 */
export function insertRunTarget(text: string, m: { start: number; end: number }, token: string, trigger: PickTrigger = "@", drill = false): { value: string; caret: number } {
  const after = text.slice(m.end)
  if (drill) {
    // A nested level keeps a trailing ":" so the next letters filter children; Back to the root is just the trigger.
    const insert = token ? `${trigger}${token}:` : trigger
    return { value: text.slice(0, m.start) + insert + after, caret: m.start + insert.length }
  }
  const insert = `${trigger}${token}${after.startsWith(" ") ? "" : " "}`
  return { value: text.slice(0, m.start) + insert + after, caret: m.start + insert.length + (after.startsWith(" ") ? 1 : 0) }
}

/**
 * Whether picking `t` while `query` is typed opens what's under it rather than picking it: a GPU cloud's row with GPUs
 * under it, until its token is typed in full. Then the list shows "any GPU on it" first and each GPU after.
 * An exact token (`!cursor`) does not drill on Enter (that picks the Settings default); Tab/Space use `advancesInto`.
 */
export const drillsInto = (t: RunTarget, all: RunTarget[], query: string) => {
  const q = query.trim().toLowerCase()
  return q !== t.token && !q.startsWith(`${t.token}:`) && all.some((x) => x.under === t.token)
}

/**
 * Tab/Space on an exact parent token (`!cursor`, `@box`) advances into its children (inserts `token:`) so the next
 * letters filter the nested list. Enter still picks the Settings/default row via `drillsInto` being false.
 */
export const advancesInto = (t: RunTarget, all: RunTarget[], query: string) => {
  const q = query.trim().toLowerCase()
  return q === t.token && all.some((x) => x.under === t.token)
}

/** Every "@word" ("!word", "%word") in `text` that names a target of `targets`, in order, where it is. */
export function tokensIn(text: string, targets: RunTarget[], trigger: PickTrigger, disabledToo = false): { target: RunTarget; start: number; end: number }[] {
  const byToken = new Map(targets.filter((t) => disabledToo || !t.disabled).flatMap((t) => [t.token, ...(t.aliases ?? [])].map((token) => [token, t] as const)))
  const out: { target: RunTarget; start: number; end: number }[] = []
  const re = new RegExp(`(^|[\\s(["'])\\${trigger}((?:[A-Za-z0-9._:%-]|\\[[A-Za-z0-9]+\\])+)`, "g")
  for (const m of text.matchAll(re)) {
    const word = m[2]!.toLowerCase()
    const bare = word.replace(/[.:_-]+$/, "")
    const target = byToken.get(word) ?? byToken.get(bare)
    if (!target) continue
    const start = m.index! + m[1]!.length
    out.push({ target, start, end: start + 1 + (byToken.get(word) ? word.length : bare.length) })
  }
  return out
}

/** A tag in a draft: a "%project", "@runner" or "!harness" word that names a target of its kind's list, and where it is. */
export interface TextTag {
  kind: TagKind
  target: RunTarget
  start: number
  end: number
  /** Only its part of the message's (a pick in one item of a list: ScopedPick's "inline"): drawn with a dashed underline. */
  partial?: boolean
}

/**
 * Every tag in `text`, in order: the composer colours them (ComposerTags.tsx). A kind without a list (a Captain's "%",
 * a list still loading) has none, so its words stay plain, as does a word no list names. Greyed-out targets count:
 * the composer warns about them rather than dropping them. Words are read by tokensIn, as the picks and the send read
 * them, so a new form (a new row in a list, or a new way tokensIn reads a word) is coloured once it can be picked.
 */
export function tagsIn(text: string, lists: Partial<Record<TagKind, RunTarget[] | undefined>>): TextTag[] {
  const out: TextTag[] = []
  for (const kind of Object.keys(TAG_TRIGGER) as TagKind[]) {
    const list = lists[kind]
    const trigger = TAG_TRIGGER[kind]
    if (!list?.length || !text.includes(trigger)) continue
    for (const t of tokensIn(text, list, trigger, true)) out.push({ kind, ...t })
  }
  // Each starts at a trigger and holds none, so they never overlap.
  return out.sort((a, b) => a.start - b.start)
}

/**
 * The pick a draft holds: its last "@token" ("!token") that names a target that can be picked. Trailing punctuation
 * is ignored. `disabledToo`: a greyed-out one counts as well (the composer warns about it rather than dropping it).
 */
export function pickedRunTarget(text: string, targets: RunTarget[], trigger: PickTrigger = "@", disabledToo = false): RunTarget | null {
  return tokensIn(text, targets, trigger, disabledToo).at(-1)?.target ?? null
}

/**
 * The draft with its pick changed from a button: the last "@token" ("!token") rewritten to `token`, or taken out
 * when `token` is null (back to the default). Null when the draft has none (the button keeps its own pick then).
 */
export function replacePickToken(text: string, targets: RunTarget[], trigger: PickTrigger, token: string | null): string | null {
  const last = tokensIn(text, targets, trigger, true).at(-1)
  if (!last) return null
  if (token) return text.slice(0, last.start) + trigger + token + text.slice(last.end)
  // Taken out with one of the spaces around it, so "deploy @box now" reads "deploy now".
  const before = text.slice(0, last.start)
  const after = text.slice(last.end)
  return before.endsWith(" ") && (after.startsWith(" ") || !after) ? before.slice(0, -1) + after : before + after.replace(/^ /, "")
}

/**
 * Why a draft's two picks can't go together, or null. The "!" list already greys out a blocked harness; this says
 * so in words before the send checks it.
 */
export function pickConflict(runsOn: RunTarget | null, agent: RunTarget | null): string | null {
  if (!agent?.disabled) return null
  return `${agent.disabled}${runsOn ? ` (you picked @${runsOn.token})` : ""}: pick another place, or another harness.`
}

// ---- what Default means in a Captain's chat: its project's own Runs on and agent

const DEFAULT_RUNNER_LABEL: Record<Runner, string> = { ...RUNNER_LABEL, gpu: "GPU", ssh: "Any SSH machine" }

/**
 * The "@" target a project's own Runs on is, so its Captain's Where button can say what Default means. `targets` is
 * the Captain's list (undefined while it loads): a runner it leaves out or greys out can't run its tasks now, and
 * the target says why.
 */
export function projectRunTarget(targets: RunTarget[] | undefined, runner: Runner, machineLabel: string | null): RunTarget {
  const label = runner === "ssh" ? normalizeLabel(machineLabel) : null
  const value = label ? `label:${label}` : runner === "local" ? THIS_COMPUTER : runner
  // Without a "Local means" label, "@local" is this computer and the list has no "this_computer" of its own.
  const found = targets?.find((t) => t.value === value) ?? (runner === "local" ? targets?.find((t) => t.value === "local") : undefined)
  if (found) return found
  const name = label ? `SSH machines labelled ${label}` : DEFAULT_RUNNER_LABEL[runner]
  return { token: label ? `label:${label}` : runner, value, kind: label ? "label" : "runner", label: name, detail: null, disabled: targets ? `${name} can't run these tasks now` : null }
}

/** The "!" target a project's own agent is (its Agent, else Settings › Box agents); `targets` as for projectRunTarget. */
export function projectHarnessTarget(targets: RunTarget[] | undefined, cli: AgentCli): RunTarget {
  const found = targets?.find((t) => t.value === cli)
  if (found) return found
  const label = AGENT_CLI_LABEL[cli]
  return { token: cli, value: cli, kind: "harness", label, detail: HARNESS_MODELS[cli], disabled: targets ? `${label} isn't set up where these tasks run` : null }
}
