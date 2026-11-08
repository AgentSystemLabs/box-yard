// Sub-tasks (prototype): an agent splits its work with spawn_subtasks. Each sub-task is a task of its own (its own
// session, transcript and placement) under the task that started it (tasks.parent_task_id), and reports back to it
// when its turn ends: done, failed, asking for input, or resting with a final reply. A sub-task can start its own,
// down to Settings › Sub-task depth; one task starts at most Settings › Sub-tasks per task.
//
// The runner's tools (runner/box-runner.mjs) never call the server. spawn_subtasks emits an event and waits for
// subtasks-reply-<id>.json; wait_for_subtasks and finish read subtasks.json, which TaskManager rewrites in the
// parent's task folder whenever one of its sub-tasks changes (SubtasksFile below).

import { RUNNERS, type Runner } from "../shared/runner.js"
import type { TaskStatus } from "../shared/types.js"

/** Where spawn_subtasks may run a sub-task: a runner of its inherited physical environment type, or "same" (sharing its parent's slot). */
export type SubtaskRunsOn = Runner | "same"

export interface SubtaskAsk {
  id: string | null
  title: string
  prompt: string
  runsOn: SubtaskRunsOn
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
    asks.push({
      id: typeof o.id === "string" && TASK_ID.test(o.id) ? o.id : null,
      title: title.slice(0, MAX_SUBTASK_TITLE),
      prompt: prompt.slice(0, MAX_SUBTASK_PROMPT),
      runsOn: where as SubtaskRunsOn,
    })
  }
  return { asks }
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
