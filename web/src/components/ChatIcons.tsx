// Who a message box talks to, as one icon per kind: the Coordinator, a project's Captain, a task, a sub-task or a side
// question. Every composer shows its kind at the text's leading edge (ComposerIcon), and the sidebar and the chat
// switcher draw the Coordinator with the same helm, so a chat looks the same in the nav and in its box. A Captain's
// icon is its project's (lib/captainIcon.tsx): the cap unless the project or Settings picks another.
import { ListTodo, MessageCircleQuestion, createLucideIcon, type LucideIcon } from "lucide-react"
import { CaptainCap, Helm } from "./ShipIcons"
import { projectColorStyle } from "./TaskIcon"
import { CaptainIcon } from "./CaptainIcon"
import { useProjectColor } from "../lib/taskTiles"
import type { ProjectColor } from "../../../shared/projectColors"
import type { Task } from "../../../shared/types"

/**
 * A sub-task: the task icon's first row (its box and line), with a smaller box hanging off it, as a task a task
 * started. Drawn on lucide's 24px grid, so it takes their 2px stroke, round caps and `currentColor`.
 */
export const Subtask = createLucideIcon({
  name: "subtask",
  node: [
    ["rect", { x: "3", y: "3", width: "6", height: "6", rx: "1", key: "parent" }],
    ["path", { d: "M13 6h8", key: "line" }],
    ["path", { d: "M6 9v6a2 2 0 0 0 2 2h3", key: "branch" }],
    ["rect", { x: "11", y: "14", width: "6", height: "6", rx: "1", key: "child" }],
  ],
})

export type ChatKind = "coordinator" | "captain" | "task" | "subtask" | "side-question"

export const CHAT_ICONS: Record<ChatKind, LucideIcon> = {
  // The yard's helm: it steers the work across every project. A Captain's cap is the default; where a project is
  // known, CaptainIcon draws the one it shows (lib/captainIcon.tsx), in its project's colour.
  coordinator: Helm,
  captain: CaptainCap,
  // The task's icon everywhere else (the panel's header, the palette, a project's Tasks).
  task: ListTodo,
  subtask: Subtask,
  // As on the task box's "Side question" button.
  "side-question": MessageCircleQuestion,
}

/** Drawn in their project's colour, as in the sidebar; the Coordinator and a side question take the yard's. */
const IN_PROJECT_COLOUR: ReadonlySet<ChatKind> = new Set(["captain", "task", "subtask"])

/** A kind's icon where its name is already beside it (a sidebar row, a menu item). */
export function ChatIcon({ kind, className }: { kind: ChatKind; className?: string }) {
  const Icon = CHAT_ICONS[kind]
  return <Icon data-chat-icon={kind} className={className} aria-hidden />
}

/**
 * Who a composer messages, for its leading edge (Composer's `icon` or `target`). `label` says it ("Messaging the
 * Coordinator"), to a screen reader and as a tooltip. It's static: a press on it puts the caret in the text. A
 * Captain's is its project's (`projectId`, CaptainIcon.tsx).
 */
export function ComposerIcon({ kind, label, color, projectId }: { kind: ChatKind; label: string; color?: ProjectColor | null; projectId?: string | null }) {
  const Icon = CHAT_ICONS[kind]
  const tinted = IN_PROJECT_COLOUR.has(kind) && color ? color : null
  const tint = tinted ? "text-(--pc)" : kind === "task" || kind === "subtask" ? "text-zinc-400" : "text-yard-400"
  return (
    <span role="img" aria-label={label} title={label} data-chat-kind={kind} style={projectColorStyle(tinted)} className="inline-grid place-items-center">
      {kind === "captain" ? <CaptainIcon projectId={projectId} className={`h-4 w-4 ${tint}`} /> : <Icon className={`h-4 w-4 ${tint}`} aria-hidden />}
    </span>
  )
}

/**
 * A task's box: the task icon, or the sub-task icon for one a task started, in its project's colour. With `captain` (its
 * name), the box sends to the project's Captain instead and shows the Captain's icon.
 */
export function TaskComposerIcon({ task, captain = null }: { task: Pick<Task, "projectId" | "parentTaskId">; captain?: string | null }) {
  const color = useProjectColor(task.projectId)
  if (captain) return <ComposerIcon kind="captain" label={`Messaging the ${captain}`} color={color} projectId={task.projectId} />
  return task.parentTaskId ? <ComposerIcon kind="subtask" label="Messaging this sub-task" color={color} /> : <ComposerIcon kind="task" label="Messaging this task" color={color} />
}
