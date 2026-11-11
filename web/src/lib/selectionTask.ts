import { withOwner } from "../../../shared/owner"
import type { Project, Task } from "../../../shared/types"

/** A safety cap well above any chat message, so a whole message (its toolbar's Respond) is quoted in full. */
const MAX_SELECTED_CHARS = 50_000

export interface SelectionProjectContext {
  id: string
  name: string
}

export interface SelectionTaskContext {
  id: string
  title: string
  branch: string | null
  prUrl: string | null
}

export type SelectionTaskSource =
  | { kind: "task"; project: SelectionProjectContext; task: SelectionTaskContext }
  | { kind: "orchestrator"; project?: SelectionProjectContext | null }
  | { kind: "captain"; project: SelectionProjectContext }

export function projectContext(project: Project | null | undefined): SelectionProjectContext | null {
  return project ? { id: project.id, name: project.name } : null
}

export function taskContext(task: Task | null | undefined): SelectionTaskContext | null {
  return task ? { id: task.id, title: task.title, branch: task.branch, prUrl: task.prUrl } : null
}

/** Where in the app the text was highlighted, beyond its `source`: ids the chat's agent can look up. */
export interface SelectionPlace {
  /** The chat message (or transcript line) the selection is in. */
  messageId?: string | null
  /** The side thread it was highlighted in, and the passage that thread is about. */
  thread?: { id: string; quote: string } | null
}

/**
 * "Create task" on highlighted text: the message for whoever creates it (selectionTargetProject: the project's
 * Captain, or the Coordinator). It asks for a new task from Cody's request and the passage, and says where the passage
 * was highlighted. The browser never creates the task itself.
 */
export function buildSelectionTaskPrompt(input: { source: SelectionTaskSource; selectedText: string; instructions: string; place?: SelectionPlace; ownerName?: string }): string {
  const selected = truncate(input.selectedText.trim(), MAX_SELECTED_CHARS)
  const instructions = input.instructions.trim()
  const here = selectionTargetProject(input.source)
  const lines = [
    withOwner(
      `Create a new task from Cody's request and the text Cody highlighted, both below. Write the task's prompt from the request, and give it the highlighted text and where it was highlighted as context. ${
        here ? "It belongs in this project unless the request says otherwise." : "Put it in the project it belongs to."
      } Create a new task: don't add this to an existing one unless the request asks for that.`,
      input.ownerName,
    ),
    "",
    withOwner("## Cody's request", input.ownerName),
    instructions || withOwner("(Cody didn't write one: work out the task from the highlighted text.)", input.ownerName),
    "",
    "## Where it was highlighted",
    ...contextLines(input.source, input.place),
    "",
    "## Highlighted text",
    quote(selected),
  ]
  return lines.join("\n")
}

/** The project whose Captain gets a selection's "Create task" (a task's, or the Captain chat's own), or null: the Coordinator. */
export function selectionTargetProject(source: SelectionTaskSource): string | null {
  return source.kind === "orchestrator" ? null : source.project.id
}

/** Who that is, for the popover's "Send to …" button and the toast after sending it. */
export function selectionTarget(source: SelectionTaskSource): string {
  return source.kind === "orchestrator" ? "the Coordinator" : `${source.project.name}'s Captain`
}

function contextLines(source: SelectionTaskSource, place?: SelectionPlace): string[] {
  const lines: string[] = []
  if (source.project) lines.push(`- Project: ${source.project.name} (${source.project.id})`)
  else lines.push("- Project: unknown; decide from the request, the highlighted text and the existing projects.")
  if (source.kind === "task") {
    lines.push(`- In the transcript of the task: ${source.task.title} (${source.task.id})`)
    if (source.task.branch) lines.push(`- That task's branch: ${source.task.branch}`)
    if (source.task.prUrl) lines.push(`- That task's pull request: ${source.task.prUrl}`)
  } else if (source.kind === "captain") {
    lines.push("- In this chat (the project Captain's)")
  } else {
    lines.push("- In this chat (the Coordinator's)")
  }
  if (place?.thread) lines.push(`- In a side thread (${place.thread.id}) about: “${oneLine(place.thread.quote, 200)}”`)
  if (place?.messageId) lines.push(`- Message: ${place.messageId}`)
  return lines
}

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function quote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n")
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n\n[Selection truncated by Box Yard.]` : text
}
