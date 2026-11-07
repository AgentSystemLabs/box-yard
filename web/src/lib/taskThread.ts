// How a task's transcript groups its lines (TaskThread in TaskView.tsx). Back-to-back published files share one row
// of file chips, and back-to-back housekeeping events (Box Yard's own bookkeeping: "Waiting for…", "Cloned…",
// "Moved from…", "Turn 2 finished") fold under the newest one, so the agent's replies aren't buried under them.
import type { TaskMessage } from "../../../shared/types"
import { dayKey } from "./calendarDay"

export type ThreadRun =
  | { kind: "line"; m: TaskMessage }
  | { kind: "published"; messages: TaskMessage[] }
  | { kind: "housekeeping"; messages: TaskMessage[] }

/** A "Published artifact" event; back-to-back ones show together as one row of file chips. */
export const isPublishedEvent = (m: TaskMessage) => m.role === "event" && m.meta?.kind === "artifact" && typeof m.meta.url === "string"

/** Words that make an event worth reading on its own, even among bookkeeping: something went wrong or was stopped. */
const NOTABLE = /couldn['’]t|can['’]t|fail|error|interrupt|ran out|stopped|unavailable|skipped/i

/**
 * Box Yard's own bookkeeping: a plain event with no kind of its own (every event Cody acts on, such as a preview, a
 * PR, a question, a hook, a Captain's answer or a quiet run, has one) and nothing gone wrong in it.
 */
export const isHousekeeping = (m: TaskMessage) => m.role === "event" && !m.meta?.kind && !NOTABLE.test(m.content)

/** The transcript's rows, oldest first. A lone housekeeping event stays a plain line: there's nothing to fold. */
export function threadRuns(messages: readonly TaskMessage[]): ThreadRun[] {
  const out: ThreadRun[] = []
  for (const m of messages) {
    const prev = out.at(-1)
    const first = prev?.kind === "line" ? prev.m : prev?.messages[0]
    const last = first && dayKey(first.createdAt) === dayKey(m.createdAt) ? prev : undefined
    if (isPublishedEvent(m)) {
      if (last?.kind === "published") last.messages.push(m)
      else out.push({ kind: "published", messages: [m] })
    } else if (isHousekeeping(m)) {
      if (last?.kind === "housekeeping") last.messages.push(m)
      // A second one in a row turns the plain line before it into a fold.
      else if (last?.kind === "line" && isHousekeeping(last.m)) out[out.length - 1] = { kind: "housekeeping", messages: [last.m, m] }
      else out.push({ kind: "line", m })
    } else out.push({ kind: "line", m })
  }
  return out
}
