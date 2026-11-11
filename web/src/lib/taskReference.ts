// A task named in a message as context: a sidebar row dragged onto a message box, or its menu's "Add to …"
// (components/SidebarReorder.tsx). The reference is plain text put in the box's draft (lib/composerDraft.ts) at the
// caret, so Cody sees and can edit what goes, and the receiving agent can act on it:
//
// - the Coordinator, and a Captain for its own project's tasks, read a task with get_task, so they get its title and id;
// - everyone else can't read another task (a task's agent has only message_agent; a Captain can't get_task another
//   project's; a New task's agent doesn't exist yet), so they also get what the task is at: its project, state, PR and
//   the start of its latest reply or question.
//
// The id renders as a link to the task in the sent message (lib/linkify.ts). Nothing is stored anywhere but the draft.
import { flushSync } from "react-dom"
import type { Project, Task, TaskStatus } from "../../../shared/types"
import { readDraft, setDraftText } from "./composerDraft"

/** The attribute a message box carries with its draft key: where a dragged task can land. */
export const DROP_ATTR = "data-draft-key"

/** The most of a task's latest reply, question or error the reference carries. */
export const EXCERPT_CHARS = 400

const STATE: Record<TaskStatus, string> = {
  queued: "queued",
  starting: "starting",
  working: "working",
  needs_input: "waiting on an answer",
  waiting: "waiting on another agent",
  idle: "idle",
  pr_ready: "PR open",
  done: "done",
  failed: "failed",
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()

/** `text` on one line, cut at a word to at most `max` characters. */
export function excerpt(text: string, max = EXCERPT_CHARS): string {
  const line = oneLine(text)
  if (line.length <= max) return line
  const cut = line.slice(0, max - 1)
  const space = cut.lastIndexOf(" ")
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** The task's own id from a sidebar row key ("task:<id>@project", "task:<id>@waiting"); null for other rows. */
export function taskIdOfRowKey(key: string | null | undefined): string | null {
  const m = key ? /^task:(.+)@(?:project|waiting)$/.exec(key) : null
  return m ? m[1]! : null
}

/** Whether the agent behind draft `key` can't read `task` itself, so the reference carries what the task is at. */
export function needsContext(key: string, task: Pick<Task, "projectId">): boolean {
  return key !== "coordinator" && key !== `captain:${task.projectId}`
}

/** The text that names `task` in a message: one line, plus a quoted excerpt when the reader needs `context`. */
export function taskReference(task: Task, { context = false, projectName }: { context?: boolean; projectName?: string } = {}): string {
  const head = `Task “${oneLine(task.title)}”`
  if (!context) return `${head} (${task.id})`
  const where = task.prUrl ? task.prUrl : task.branch ? `branch ${task.branch}` : null
  const meta = [task.id, projectName && `project ${projectName}`, STATE[task.status] ?? task.status, where].filter(Boolean).join(", ")
  const [label, said] = task.question ? ["It asks", task.question] : task.status === "failed" && task.error ? ["Error", task.error] : task.summary ? ["Latest reply", task.summary] : task.activity ? ["Latest step", task.activity] : ["", ""]
  const quote = said.trim() ? `\n> ${label}: ${excerpt(said)}` : ""
  return `${head} (${meta})${quote}`
}

/**
 * `text` with `ref` put in at `at` (the caret; a selection is kept and the reference goes after it), spaced from its
 * neighbours: a one-line reference inline, between spaces; a quoted one on lines of its own, a blank line after it so
 * what's typed next isn't part of the quote. `caret`: just past it, where typing goes on.
 */
export function insertReference(text: string, at: number, ref: string): { text: string; caret: number } {
  const i = Math.max(0, Math.min(at, text.length))
  let before = text.slice(0, i)
  const after = text.slice(i)
  let lead: string
  let tail: string
  if (ref.includes("\n")) {
    // Its own line: the spaces the line before ended with go.
    before = before.replace(/[ \t]+$/, "")
    lead = before && !before.endsWith("\n") ? "\n" : ""
    tail = after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n"
  } else {
    lead = before && !/\s$/.test(before) ? " " : ""
    tail = /^\s/.test(after) ? "" : " "
  }
  const head = `${before}${lead}${ref}${tail}`
  return { text: head + after, caret: head.length }
}

/** A box a task can be added to: its draft key, the element that marks it, its text field and its name in a menu. */
export interface ContextTarget {
  key: string
  zone: HTMLElement
  input: HTMLTextAreaElement | null
}

const fieldOf = (zone: HTMLElement) => (zone instanceof HTMLTextAreaElement ? zone : zone.querySelector<HTMLTextAreaElement>("textarea"))

const target = (zone: HTMLElement | null | undefined): ContextTarget | null => {
  const key = zone?.getAttribute(DROP_ATTR)
  return zone && key ? { key, zone, input: fieldOf(zone) } : null
}

/** The message box under a point, if any; `skip`: a task's own chat, which it isn't added to. */
export function targetAt(x: number, y: number, skip?: string | null): ContextTarget | null {
  const found = target(document.elementFromPoint?.(x, y)?.closest<HTMLElement>(`[${DROP_ATTR}]`))
  return found && (!skip || found.key !== `task:${skip}`) ? found : null
}

/** The message boxes on screen, once each, in page order; `skip` as above. */
export function openTargets(skip?: string | null): ContextTarget[] {
  const seen = new Set<string>()
  const out: ContextTarget[] = []
  for (const zone of document.querySelectorAll<HTMLElement>(`[${DROP_ATTR}]`)) {
    const t = target(zone)
    if (!t || seen.has(t.key) || (skip && t.key === `task:${skip}`)) continue
    if (!(zone.checkVisibility?.() ?? true)) continue
    seen.add(t.key)
    out.push(t)
  }
  return out
}

/** Short enough for a menu line. */
const short = (s: string, max = 32) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s)

/** What a box is called in "Add to …" and in what a screen reader hears after. */
export function targetName(key: string, data: { tasks?: readonly Task[]; projects?: readonly Project[] }): string {
  if (key === "coordinator") return "Coordinator chat"
  const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)]
  if (kind === "captain") return `${short(data.projects?.find((p) => p.id === id)?.name ?? "project")} Captain`
  if (kind === "task") {
    const title = data.tasks?.find((t) => t.id === id)?.title
    return title ? `task “${short(title)}”` : "task chat"
  }
  if (kind === "thread") return "side thread"
  if (kind === "new-task") return "New task"
  return "chat"
}

/**
 * Put `task`'s reference in `to`'s draft at its caret, then give the box the focus with the caret just past it.
 * Returns the reference added.
 */
export function addTaskReference(to: ContextTarget, task: Task, projects: readonly Project[] = []): string {
  const draft = readDraft(to.key).text
  const input = to.input
  // The field's caret, while it shows this draft (its selection outlives its focus); else the end.
  const at = input && input.value === draft ? (input.selectionEnd ?? draft.length) : draft.length
  const ref = taskReference(task, { context: needsContext(to.key, task), projectName: projects.find((p) => p.id === task.projectId)?.name })
  const next = insertReference(draft, at, ref)
  flushSync(() => setDraftText(to.key, next.text))
  if (input?.isConnected) {
    input.focus({ preventScroll: true })
    input.setSelectionRange(next.caret, next.caret)
  }
  return ref
}
