// The Coordinator's and Captains' chat picks (shared/runTargets.ts): the "@" list of where tasks run and the "!" list
// of agent CLIs, from the server's own runner checks, machines and CLI checks; the check of a sent pick against
// them; and the lines a turn's prompt gets for them. The Coordinator's "%" project pick is checked here too.

import { buildHarnessTargets, buildRunTargets, findRunTarget, inlinePicksOf, pickKey, pickOf, projectToken, runTargetPickOf, type InlinePick, type InlineReason, type RunTarget, type RunTargetPick } from "../shared/runTargets.js"
import { resolveRunsOn, type MachineSettings, type MachineStatus } from "../shared/machines.js"
import type { Runner } from "../shared/runner.js"
import { GPU_PROVIDERS, type GpuProvider } from "../shared/gpu.js"
import { AGENT_CLI_LABEL, AGENT_CLIS, type AgentCli } from "../shared/agentCli.js"
import { withOwner } from "../shared/owner.js"
import { BadRequestError } from "./store.js"
import { harnessModelTargets, type HarnessPickSources } from "../shared/harnessPicks.js"

export interface RunTargetDeps {
  /** Setup.runnerProblem: null when the runner can take tasks now (for "gpu", on `gpuCloud`). */
  runnerProblem: (runner: Runner, gpuCloud?: GpuProvider) => Promise<string | null>
  /**
   * The GPU clouds, for "@gpu:<cloud>" and "@gpu:<cloud>:<gpu>": what plain "@gpu" is (a project's own cloud, else
   * Settings' Default GPU cloud) and each cloud's GPU types from its settings. Without it, "@gpu" is one row.
   */
  gpu?: { default: (projectId: string | null) => GpuProvider; types: (cloud: GpuProvider) => readonly string[] }
  machines: () => { machines: Pick<MachineStatus, "name" | "labels" | "state" | "problem">[]; settings: MachineSettings }
  /** Identities.runnerProblem for a project's identity. */
  identityProblem?: (projectId: string, runner: Runner) => string | null
  /**
   * Why `cli` can't run a task on `runner` (for a project: with its keys), or null: TaskManager.requireRunner, the
   * check create_task makes. Without it, the "!" list has every CLI.
   */
  harnessProblem?: (cli: AgentCli, runner: Runner, projectId: string | null) => Promise<string | null>
  /** Where a message's tasks run when it picks nowhere: the project's Runs on, or the setup's default runner. */
  defaultRunner?: (projectId: string | null) => Runner
  /** Shared Settings defaults and installed model catalogs for the harness's optional model/effort submenu. */
  harnessModels?: (cli: AgentCli) => Promise<HarnessPickSources>
}

/** The "@" list for the Coordinator (no project) or a project's Captain (its identity may rule runners out). */
export async function listRunTargets(d: RunTargetDeps, projectId?: string | null): Promise<RunTarget[]> {
  const problem = (r: Runner, cloud?: GpuProvider) => d.runnerProblem(r, cloud).catch((err: Error) => err.message)
  const [[local, box, docker, gpu], clouds] = await Promise.all([
    Promise.all((["local", "box", "docker", "gpu"] as const).map((r) => problem(r))),
    d.gpu ? Promise.all(GPU_PROVIDERS.map((cloud) => problem("gpu", cloud))) : null,
  ])
  const { machines, settings } = d.machines()
  return buildRunTargets({
    problems: { local: local!, box: box!, docker: docker!, gpu: gpu! },
    machines,
    localLabel: settings.localLabel,
    identityProblem: projectId && d.identityProblem ? (runner) => d.identityProblem!(projectId, runner) : undefined,
    ...(d.gpu && clouds
      ? {
          gpu: {
            default: d.gpu.default(projectId ?? null),
            problems: Object.fromEntries(GPU_PROVIDERS.map((c, i) => [c, clouds[i] ?? null])) as Record<GpuProvider, string | null>,
            types: Object.fromEntries(GPU_PROVIDERS.map((c) => [c, d.gpu!.types(c)])) as Record<GpuProvider, readonly string[]>,
          },
        }
      : {}),
  })
}

/** A sent runs_on checked against the same list: the pick to store on the message, or a 400 saying why not. */
export async function resolveRunTargetPick(d: RunTargetDeps, value: string, projectId?: string | null): Promise<RunTargetPick> {
  const targets = await listRunTargets(d, projectId)
  const t = findRunTarget(targets, value)
  if (!t) throw new BadRequestError(`"${value}" isn't a place tasks can run here. Pick one from the @ list: ${targets.filter((x) => !x.disabled).map((x) => `@${x.token}`).join(", ") || "none is available"}.`)
  if (t.disabled) throw new BadRequestError(`Tasks can't run on @${t.token} now: ${t.disabled}.`)
  return pickOf(t)
}

/** A sent "%" pick (a project id) as the pick to store, or a 400 when there's no such project. */
export function resolveProjectPick(project: { id: string; name: string } | null | undefined, value: string): RunTargetPick {
  if (!project) throw new BadRequestError(`"${value}" isn't one of your projects: pick one from the % list.`)
  return { value: project.id, token: projectToken(project.name), label: project.name }
}

/** The runner a message's tasks go to: its "@" pick's (a runs_on value), else the project's or the default. */
function runnerOf(d: RunTargetDeps, projectId: string | null, runsOn: string | null): Runner {
  if (runsOn) {
    try {
      const r = resolveRunsOn(runsOn, undefined, d.machines().settings.localLabel).runner
      if (r) return r
    } catch {
      // Not a runs_on: the list ignores it, and the send's own check refuses it.
    }
  }
  return d.defaultRunner?.(projectId) ?? "box"
}

/** Each CLI's problem on the runner a message's tasks go to (`runsOn`: its "@" pick, if any). */
async function harnessProblems(d: RunTargetDeps, projectId: string | null, runsOn: string | null): Promise<{ runner: Runner; problems: Record<AgentCli, string | null> }> {
  const runner = runnerOf(d, projectId, runsOn)
  const list = await Promise.all(AGENT_CLIS.map((cli) => (d.harnessProblem ? d.harnessProblem(cli, runner, projectId).catch((err: Error) => err.message) : null)))
  return { runner, problems: Object.fromEntries(AGENT_CLIS.map((cli, i) => [cli, list[i] ?? null])) as Record<AgentCli, string | null> }
}

/**
 * The "!" list for a message whose tasks go where `runsOn` says (its "@" pick; null: the project's runner or the
 * default): each CLI the runner can take. SSH placement checks each machine's installed CLI and login.
 */
export async function listHarnessTargets(d: RunTargetDeps, projectId: string | null, runsOn: string | null): Promise<RunTarget[]> {
  const { problems } = await harnessProblems(d, projectId, runsOn)
  return buildHarnessTargets({ problems })
}

/** A sent "!" pick checked against that list: the pick to store, or a 400 saying why not. */
export async function resolveHarnessPick(d: RunTargetDeps, value: string, projectId: string | null, runsOn: string | null): Promise<RunTargetPick> {
  const token = value.trim().toLowerCase()
  const cli = AGENT_CLIS.find((c) => c === token.split(":")[0])
  if (!cli) throw new BadRequestError(`"${value}" isn't a harness: pick !claude, !codex or !cursor.`)
  const { problems } = await harnessProblems(d, projectId, runsOn)
  const t = buildHarnessTargets({ problems }).find((x) => x.value === cli)
  if (!t) throw new BadRequestError(`!${cli} can't run this message's tasks: ${problems[cli]}`)
  if (token === cli) return pickOf(t)
  const targets = d.harnessModels ? harnessModelTargets([t], await d.harnessModels(cli)) : [t]
  const chosen = targets.find((x) => x.token.toLowerCase() === token)
  if (!chosen) throw new BadRequestError(`"!${value}" isn't a model and effort this harness offers. Pick one from the !${cli} list.`)
  return pickOf(chosen)
}

/**
 * The line under a message with a pick, in the turn's prompt. Box Yard also applies it to the turn's create_task,
 * create_tasks and send_to_task calls, and carries it to a Captain the turn messages (server/mcp.ts, captains.ts).
 */
export function runTargetNote(pick: RunTargetPick, ownerName: string | undefined, relay: boolean): string {
  return (
    `[${withOwner("Cody", ownerName)} picked where tasks run for this message: @${pick.token} (${pick.label}), runs_on "${pick.value}". ` +
      `Every task you create or message for it gets runs_on "${pick.value}": Box Yard applies it to create_task, create_tasks and send_to_task during this turn` +
      (relay ? ", and a Captain you message this turn gets the same pick." : ".") +
      ` Don't ask ${withOwner("Cody", ownerName)} where to run it.]`
  )
}

/**
 * The line under a message with a "!" pick, in the turn's prompt. Box Yard applies it to create_task and
 * create_tasks; send_to_task keeps the existing harness. continue_task explicitly switches a resting task.
 */
export function harnessNote(pick: RunTargetPick, ownerName: string | undefined, relay: boolean): string {
  return (
    `[${withOwner("Cody", ownerName)} picked the harness for this message: !${pick.token} (${pick.label}), agent "${pick.value}".` +
      (pick.model !== undefined ? ` Model "${pick.model}"${pick.effort ? `, effort "${pick.effort}"` : pick.value === "cursor" ? " with effort included in its model ID" : " with the harness's Settings effort"}.` : " Use this harness's model and effort defaults in Settings.") + " " +
      `Every task you create for it gets agent "${pick.value}": Box Yard applies it to create_task and create_tasks during this turn` +
      (relay ? ", and a Captain you message this turn gets the same pick." : ".") +
      ` send_to_task keeps the saved harness. To continue the same work on ${pick.label}, wait for it to stop and finish saving, then call continue_task with the same task and agent "${pick.value}" (and this pick's model/effort if specified); do not create a replacement task.]`
  )
}

/**
 * The line under a Coordinator message with a "%" pick: the project it's for, so the Coordinator routes it to that
 * project's Captain instead of guessing. The "%token" stays in the message's text as Cody wrote it.
 */
export function projectNote(pick: RunTargetPick, ownerName: string | undefined): string {
  return (
    `[${withOwner("Cody", ownerName)} picked the project for this message: %${pick.token}, project "${pick.label}" (${pick.value}). ` +
      `It's about that project: route it to its Captain with send_to_captain (project "${pick.value}") as you would any project-scoped work, ` +
      `unless it's a quick question you can answer yourself. Don't ask ${withOwner("Cody", ownerName)} which project it's for.]`
  )
}

const INLINE_TRIGGER: Record<InlinePick["kind"], string> = { runsOn: "@", agent: "!", project: "%" }
const INLINE_ARG: Record<InlinePick["kind"], string> = { runsOn: "runs_on", agent: "agent", project: "project" }
const INLINE_WHY: Record<InlinePick["reason"], string> = {
  item: "",
  mixed: ", with another of its kind in the message",
  words: ", though the message's words ask for another harness",
}

/**
 * The line under a message with picks typed for only part of it (meta.inlinePicks, shared/runTargets.ts scopePicks):
 * each with where it is. Box Yard applies none of them, so a list item's "!claude" can't switch the other items' tasks;
 * the Coordinator or Captain passes each on the tasks it's for.
 */
export function inlinePicksNote(picks: InlinePick[], ownerName: string | undefined, relay: boolean): string {
  // A harness's model and effort (shared/harnessPicks.ts) go with it as the tools' model and effort.
  const args = (p: InlinePick) => `${INLINE_ARG[p.kind]} "${p.value}"${p.model !== undefined ? `, model "${p.model}"` : ""}${p.effort ? `, effort "${p.effort}"` : ""}`
  const each = picks.map((p) => `${INLINE_TRIGGER[p.kind]}${p.token} (${p.label}, ${args(p)}) ${p.where ? `in ${p.where}` : "outside any list item"}${INLINE_WHY[p.reason]}`)
  return (
    `[${withOwner("Cody", ownerName)} typed picks for only part of this message, so Box Yard applies none of them to this turn: ${each.join("; ")}. ` +
      `Pass each yourself, on the create_task call or create_tasks item for the task it's written with (a "%" one: send that part to its project's Captain), ` +
      `and follow the message's own words for the rest: the agent, model, effort and runs_on you pass are what each task gets.` +
      (relay ? ` When you send such a part to a Captain, say its pick in your message: Box Yard doesn't carry these to Captains.` : "") +
      `]`
  )
}

/**
 * The lines for a message's picks ("@", "!" and the Coordinator's "%"), each on its own line under it, or "". A
 * whole-message pick that one of the message's own hints disagrees with isn't the message's (turnPick doesn't apply
 * it), so it's listed with the hints instead: a "%" has no tool to force, and its line is all it does.
 */
export function pickNotes(meta: Record<string, unknown> | null | undefined, ownerName: string | undefined, relay: boolean): string {
  const hints = inlinePicksOf(meta)
  const outvoted: InlinePick[] = []
  const own = (kind: InlinePick["kind"]): RunTargetPick | null => {
    const p = runTargetPickOf(meta, kind)
    if (!p || !hints.some((h) => h.kind === kind && pickKey(h) !== pickKey(p))) return p
    outvoted.push({ kind, ...p, where: null, reason: "mixed" })
    return null
  }
  const project = own("project")
  const where = own("runsOn")
  const agent = own("agent")
  const inline = [...outvoted, ...hints]
  return (
    (project ? `\n${projectNote(project, ownerName)}` : "") +
    (where ? `\n${runTargetNote(where, ownerName, relay)}` : "") +
    (agent ? `\n${harnessNote(agent, ownerName, relay)}` : "") +
    (inline.length ? `\n${inlinePicksNote(inline, ownerName, relay)}` : "")
  )
}

/**
 * A chat send's inline picks (picks typed for only part of the message), checked: each names something on the lists
 * (a greyed-out one too: it's only a hint), and gets the list's own label. A 400 when one doesn't.
 */
export async function resolveInlinePicks(
  d: RunTargetDeps,
  sent: { kind: InlinePick["kind"]; value: string; where?: string | null; reason: InlineReason }[],
  projectId: string | null,
  findProject: (id: string) => { id: string; name: string } | null | undefined,
): Promise<InlinePick[]> {
  if (!sent.length) return []
  const places = sent.some((p) => p.kind === "runsOn") ? await listRunTargets(d, projectId) : []
  return Promise.all(sent.map(async (p): Promise<InlinePick> => {
    const where = p.where?.trim() || null
    if (p.kind === "agent") {
      // Its "!" token: a harness, or one with a model and effort (shared/harnessPicks.ts), unchecked for availability.
      const token = p.value.trim().toLowerCase()
      const cli = AGENT_CLIS.find((c) => c === token.split(":")[0])
      if (!cli) throw new BadRequestError(`"${p.value}" isn't a harness: pick !claude, !codex or !cursor.`)
      const plain: RunTarget = { token: cli, value: cli, kind: "harness", label: AGENT_CLI_LABEL[cli], detail: null, disabled: null }
      const chosen = token === cli ? plain : d.harnessModels ? harnessModelTargets([plain], await d.harnessModels(cli)).find((x) => x.token.toLowerCase() === token) : undefined
      if (!chosen) throw new BadRequestError(`"!${p.value}" isn't a model and effort this harness offers. Pick one from the !${cli} list.`)
      return { kind: "agent", ...pickOf(chosen), where, reason: p.reason }
    }
    if (p.kind === "project") {
      if (projectId) throw new BadRequestError("A Captain's chat is already its project's: % picks a project only in the Coordinator's chat.")
      return { kind: "project", ...resolveProjectPick(findProject(p.value), p.value), where, reason: p.reason }
    }
    const t = findRunTarget(places, p.value)
    if (!t) throw new BadRequestError(`"${p.value}" isn't a place tasks can run here. Pick one from the @ list.`)
    return { kind: "runsOn", ...pickOf(t), where, reason: p.reason }
  }))
}
