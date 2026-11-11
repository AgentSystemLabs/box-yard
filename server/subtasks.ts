// Sub-tasks (prototype): an agent splits its work with spawn_subtasks. Each sub-task is a task of its own (its own
// session, transcript and placement) under the task that started it (tasks.parent_task_id), and reports back to it
// when its turn ends: done, failed, asking for input, or resting with a final reply. A sub-task can start its own,
// down to Settings › Sub-task depth; one task starts at most Settings › Sub-tasks per task.
//
// The runner's tools (runner/box-runner.mjs) never call the server. spawn_subtasks emits an event and waits for
// subtasks-reply-<id>.json; wait_for_subtasks and finish read subtasks.json, which TaskManager rewrites in the
// parent's task folder whenever one of its sub-tasks changes (SubtasksFile below).

import { AGENT_CLIS, AGENT_CLI_LABEL, CODEX_EFFORTS, cliForModel, isAgentCli, pinProblem, type AgentCli } from "../shared/agentCli.js"
import { BUILTIN_MODELS, MAX_MODEL_NAME, MODEL_NAME, checkEffort } from "../shared/models.js"
import { RUNNERS, type Runner } from "../shared/runner.js"
import type { Effort, TaskStatus } from "../shared/types.js"

/** Where spawn_subtasks may run a sub-task: a runner of its inherited physical environment type, or "same" (sharing its parent's slot). */
export type SubtaskRunsOn = Runner | "same"

export interface SubtaskAsk {
  id: string | null
  title: string
  prompt: string
  runsOn: SubtaskRunsOn
  /** Its own harness, model and effort, pinned like create_task's; left out, its parent's (subtaskPins). */
  agent?: AgentCli
  model?: string
  effort?: Effort
}

/** A sub-task still on its way to a report: running, or waiting to run (its own sub-tasks, a slot). */
export const LIVE_SUBTASK: readonly TaskStatus[] = ["queued", "starting", "working", "waiting"]
export const isLiveSubtask = (status: TaskStatus) => LIVE_SUBTASK.includes(status)

/** The statuses a sub-task's turn ends in that report to its parent. "waiting" (on its own sub-tasks) doesn't. */
export const REPORTING: readonly TaskStatus[] = ["done", "failed", "needs_input", "idle", "pr_ready"]

export const MAX_SUBTASK_TITLE = 120
export const MAX_SUBTASK_PROMPT = 20_000
/** A report longer than this is cut; the whole of it stays in the sub-task's own transcript. */
export const MAX_REPORT_CHARS = 8_000

const TASK_ID = /^task_[0-9a-f]{12}$/

/** spawn_subtasks' event, checked: what each sub-task asks for, or why the whole call is refused. */
export function parseSpawn(raw: unknown): { asks: SubtaskAsk[] } | { problem: string } {
  const list = Array.isArray(raw) ? raw : []
  if (!list.length) return { problem: "Give at least one sub-task (tasks: [{ title, prompt }])." }
  const asks: SubtaskAsk[] = []
  for (const [i, item] of list.entries()) {
    const o = item && typeof item === "object" ? (item as Record<string, unknown>) : {}
    const title = typeof o.title === "string" ? o.title.trim().replace(/\s+/g, " ") : ""
    const prompt = typeof o.prompt === "string" ? o.prompt.trim() : ""
    const where = typeof o.runsOn === "string" && o.runsOn.trim() ? o.runsOn.trim().toLowerCase() : "same"
    if (!title) return { problem: `Sub-task ${i + 1} has no title.` }
    if (!prompt) return { problem: `Sub-task ${i + 1} ("${title}") has no prompt.` }
    if (where !== "same" && !(RUNNERS as readonly string[]).includes(where)) return { problem: `Sub-task ${i + 1} ("${title}"): runs_on must be "same" or one of ${RUNNERS.join(", ")}.` }
    // Left out (or empty), each is its parent's. A value of the wrong shape refuses the call rather than running on a default.
    const agent = lower(given(o.agent))
    const model = given(o.model)
    const effort = lower(given(o.effort))
    if (agent === null || (agent && !isAgentCli(agent))) return { problem: `Sub-task ${i + 1} ("${title}"): agent must be one of ${AGENT_CLIS.join(", ")}, or left out to run on yours.` }
    if (model === null || (model && (model.length > MAX_MODEL_NAME || !MODEL_NAME.test(model)))) {
      return { problem: `Sub-task ${i + 1} ("${title}"): model must be a model id (no spaces, at most ${MAX_MODEL_NAME} characters), or left out to use yours.` }
    }
    if (effort === null || (effort && !(CODEX_EFFORTS as readonly string[]).includes(effort))) {
      return { problem: `Sub-task ${i + 1} ("${title}"): effort must be one of ${CODEX_EFFORTS.join(", ")} (ultra on Codex only), or left out to use yours.` }
    }
    asks.push({
      id: typeof o.id === "string" && TASK_ID.test(o.id) ? o.id : null,
      title: title.slice(0, MAX_SUBTASK_TITLE),
      prompt: prompt.slice(0, MAX_SUBTASK_PROMPT),
      runsOn: where as SubtaskRunsOn,
      ...(agent ? { agent: agent as AgentCli } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort: effort as Effort } : {}),
    })
  }
  return { asks }
}

/** An optional string option: its trimmed text, undefined when left out or empty, null when it isn't a string. */
const given = (v: unknown): string | undefined | null => (v === undefined || v === null ? undefined : typeof v === "string" ? v.trim() || undefined : null)
const lower = (v: string | undefined | null) => (typeof v === "string" ? v.toLowerCase() : v)

/** The harness, model and effort a sub-task runs on: its task row's agent_cli, model and effort. */
export interface SubtaskPins {
  agent: AgentCli
  model: string | null
  effort: Effort | null
}

/**
 * Each sub-task's pins: what it asked for, else its parent's, as every sub-task got before it could ask (a parent's
 * null model or effort follows the routing chain each turn, and so does its sub-task's). On another harness than its
 * parent's, the parent's model and effort stay behind (they're that harness's): what it leaves out follows the new
 * harness's defaults and routing, as continue_task does. What it asks for is checked like a continue_task pin
 * (pinProblem, with Cursor's catalog in `knownCursor`), and one bad item refuses the whole call, as parseSpawn does.
 */
export function subtaskPins(asks: readonly SubtaskAsk[], parent: SubtaskPins, knownCursor?: (id: string) => boolean): { pins: SubtaskPins[] } | { problem: string } {
  const pins: SubtaskPins[] = []
  for (const [i, ask] of asks.entries()) {
    const agent = ask.agent ?? parent.agent
    const problem = pinProblem(agent, ask.model, ask.effort, knownCursor)
    if (problem) {
      // A model another harness owns, on the harness it inherited: say which agent to ask for.
      const owner = cliForModel(ask.model)
      const hint = !ask.agent && owner && owner !== agent ? ` It runs on ${AGENT_CLI_LABEL[agent]} like you unless it asks for another agent: pass agent "${owner}" with that model.` : ""
      return { problem: `Sub-task ${i + 1} ("${ask.title}"): ${problem}${hint}` }
    }
    const same = agent === parent.agent
    pins.push({ agent, model: ask.model ?? (same ? parent.model : null), effort: ask.effort ?? (same ? parent.effort : null) })
  }
  return { pins }
}

/** What spawn_subtasks' reply says a sub-task with pins of its own runs on ("Claude Code · claude-sonnet-5-5 · high effort"), with any effort note. */
export function pinsLabel(p: SubtaskPins): string {
  const label = [AGENT_CLI_LABEL[p.agent], p.model, p.effort ? `${p.effort} effort` : null].filter(Boolean).join(" · ")
  const effort = p.agent === "claude" && p.model && p.effort ? checkEffort(BUILTIN_MODELS, p.model, p.effort) : null
  return effort && !effort.ok ? `${label} (${effort.message})` : label
}

export interface SubtaskLimits {
  maxDepth: number
  maxChildren: number
}

/** Why a task can't start these sub-tasks (too deep, too many), or null. */
export function spawnProblem(p: { depth: number; started: number; asked: number; limits: SubtaskLimits }): string | null {
  if (p.depth + 1 > p.limits.maxDepth) {
    return `Sub-tasks nest at most ${p.limits.maxDepth} deep (Settings › Box agents › Sub-task depth) and this task is at depth ${p.depth}, so it can't start its own. Do the work yourself.`
  }
  if (p.started + p.asked > p.limits.maxChildren) {
    const left = Math.max(0, p.limits.maxChildren - p.started)
    return `A task starts at most ${p.limits.maxChildren} sub-tasks (Settings › Box agents › Sub-tasks per task); this one has started ${p.started}, so ${left ? `at most ${left} more` : "no more"}.`
  }
  return null
}

const STATUS_WORD: Partial<Record<TaskStatus, string>> = {
  done: "done",
  failed: "failed",
  needs_input: "asking for input",
  idle: "finished its turn",
  pr_ready: "opened a PR",
}

/** The text a parent's agent gets when a sub-task reports. Never starts "Message from agent": it isn't a chat line. */
export function reportText(p: { id: string; title: string; status: TaskStatus; text: string; question?: string | null; live: number; total: number }): string {
  const body = p.text.length > MAX_REPORT_CHARS ? `${p.text.slice(0, MAX_REPORT_CHARS)}… (cut; the whole report is in ${p.id}'s transcript)` : p.text
  const head = `Sub-task report from "${p.title}" (${p.id}), ${STATUS_WORD[p.status] ?? p.status}:`
  const ask =
    p.status === "needs_input" && p.question
      ? `\n\nIt asks: ${p.question}\nAnswer it with message_agent to "${p.id}" if you can, or pass the question on with ask_user.`
      : ""
  const tail = p.live
    ? `${p.live} of your ${p.total} sub-tasks were still running when this report came; theirs come the same way (wait_for_subtasks waits for them).`
    : p.total > 1
      ? `All ${p.total} of your sub-tasks have reported. Write your answer from their reports.`
      : `Your sub-task has reported. Write your answer from its report.`
  return `${head}\n\n${body || "(no reply)"}${ask}\n\n${tail}`
}

export interface SubtaskReport {
  status: TaskStatus
  text: string
  at: number
  /** The queued input that carries it to the parent, so a mid-turn wait_for_subtasks can take it off the queue. */
  inputId: string
}

/** subtasks.json in the parent's task folder: what its runner's wait_for_subtasks and finish read. */
export interface SubtasksFile {
  updatedAt: number
  children: {
    id: string
    title: string
    status: TaskStatus
    url: string
    /** Its latest report; delivered once the parent's agent has it (a turn's prompt, or wait_for_subtasks). */
    report: (SubtaskReport & { delivered: boolean }) | null
  }[]
}
