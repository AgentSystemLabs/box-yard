// The open task's state in words when it changes, for screen readers. Its notifications (and their toasts) are
// skipped while it's open (lib/notifications.ts), and the header's dot changes silently, so without this a turn that
// ends, asks something or fails says nothing to someone who can't see the dot.
import { useState } from "react"
import { badgeStatus, type BadgeStatus } from "../lib/prState"
import { MERGED_BADGE, STATUS } from "./ui"
import type { Task } from "../../../shared/types"
import { questionsIntro } from "../../../shared/askQuestions"

/**
 * What it says when the open task moves to `status`; nothing for Starting, which Working follows at once. A task that
 * asks says its `question` too: the card it shows in isn't a live region.
 */
export function taskStatusAnnouncement(title: string, status: BadgeStatus, question?: string | null): string {
  if (status === "starting") return ""
  const said = `${title}: ${status === "merged" ? MERGED_BADGE.label : STATUS[status].label}`
  return status === "needs_input" && question ? `${said}. ${question}` : said
}

/** Several questions are read one at a time in their form, so it says how many (and the agent's intro), not all of them. */
function spokenAsk(task: Partial<Pick<Task, "question" | "questions">>): string | null {
  const n = task.questions?.length ?? 0
  if (!n) return task.question ?? null
  const intro = questionsIntro(task.question ?? null, task.questions!)
  return `${intro ? `${intro} ` : ""}It asks ${n} ${n === 1 ? "question" : "questions"}, one at a time, at the end of the conversation.`
}

/** A polite live region, in the page from the start (one added with its text is often not read), silent until the state changes. */
export function TaskStatusAnnouncer({ task }: { task: Pick<Task, "title" | "status" | "prUrl" | "prState"> & Partial<Pick<Task, "question" | "questions">> }) {
  const status = badgeStatus(task)
  // The state it last saw, and what it said then: updated during render when the state moves, as React suggests.
  const [seen, setSeen] = useState({ status, said: "" })
  if (seen.status !== status) setSeen({ status, said: taskStatusAnnouncement(task.title, status, spokenAsk(task)) || seen.said })
  return (
    <p aria-live="polite" className="sr-only" data-testid="task-status-announcer">
      {seen.said}
    </p>
  )
}
