// A parent task's transcript lines about its sub-tasks (server/subtasks.ts): the ones it started, as links with their
// live status, and each one's report. A sub-task link opens its task in the rightmost unpinned panel's place
// (lib/columns.ts); on a phone, in a panel beside this one (lib/panelStack.ts).
import { useMemo } from "react"
import { GitFork, Users } from "lucide-react"
import type { TaskMessage, TaskStatus } from "../../../shared/types"
import { useTask, useTasks } from "../lib/queries"
import { MESSAGE_BLOCK, MessageActions } from "./MessageActions"
import { TaskStatusIcon } from "./TaskIcon"
import { TaskRowTitle } from "./TaskRowTitle"
import { AppLink, LineIcon, Markdown, PrChip, STATUS, TAP_AREA, TimeAgo, cx } from "./ui"

type Listed = { id: string; title: string }

const listed = (m: TaskMessage): Listed[] =>
  Array.isArray(m.meta?.subtasks)
    ? (m.meta.subtasks as unknown[]).flatMap((s) => {
        const o = s as Partial<Listed> | null
        return o && typeof o.id === "string" ? [{ id: o.id, title: typeof o.title === "string" ? o.title : o.id }] : []
      })
    : []

/**
 * An event about the task's sub-tasks: "Started 4 sub-tasks." with a row for each (SubtaskRows), or a line of its own
 * ("Waiting for 3 sub-tasks to report…"), which says why the task rests and so reads brighter than bookkeeping.
 */
export function SubtasksLine({ m }: { m: TaskMessage }) {
  const items = useMemo(() => listed(m), [m])
  return (
    <div data-chat-id={m.id} data-testid="subtasks-line" className="flex items-start gap-1.5 pl-1 text-xs text-zinc-400">
      <LineIcon icon={GitFork} className="h-3.5 w-3.5 text-zinc-500" />
      <div className="min-w-0 flex-1">
        <div className="wrap-anywhere">
          {m.content}
          <span className="ml-2 text-[10px] text-zinc-600">
            <TimeAgo ts={m.createdAt} />
          </span>
        </div>
        {items.length > 0 && <SubtaskRows items={items} />}
      </div>
    </div>
  )
}

/**
 * A link to each sub-task: its icon says its live state (the words are for a screen reader), and its PR sits at the
 * row's end, beside the link, never inside it. Only a line that lists sub-tasks follows the task list.
 */
function SubtaskRows({ items }: { items: Listed[] }) {
  const tasks = useTasks()
  const byId = useMemo(() => new Map((tasks.data ?? []).map((t) => [t.id, t])), [tasks.data])
  return (
    <ul className="mt-1 -ml-2 grid gap-px">
      {items.map((s) => {
        const task = byId.get(s.id)
        const status: TaskStatus | null = task?.status ?? null
        return (
          <li key={s.id} className="flex min-w-0 items-center gap-1">
            <AppLink
              href={`/tasks/${s.id}`}
              className="grid min-h-8 min-w-0 flex-1 grid-cols-[1.25rem_minmax(0,1fr)] content-center items-center gap-x-2 rounded-md px-2 py-1 text-sm text-yard-300 hover:bg-zinc-900 hover:text-yard-200 pointer-coarse:min-h-11"
            >
              {/* The word after the title names the state, so the icon stays out of the accessible name. A task that
                  is gone (deleted) keeps a neutral tile. */}
              <span aria-hidden className="col-start-1 row-start-1 grid h-5 w-5 place-items-center">
                <TaskStatusIcon task={task ?? { id: s.id, title: s.title, icon: null, projectId: "", status: "done" }} muted={!task || status === "done"} />
              </span>
              <TaskRowTitle title={task?.title ?? s.title} status={status} />
              {status && <span data-subtask-status className="sr-only">{STATUS[status].label}</span>}
            </AppLink>
            {task?.prUrl && <PrChip task={task} variant="number" className="mr-2 shrink-0 text-xs leading-5 tabular-nums pointer-coarse:min-h-11" />}
          </li>
        )
      })}
    </ul>
  )
}

const REPORT_WORD: Partial<Record<TaskStatus, string>> = { done: "done", failed: "failed", needs_input: "asks", idle: "replied", pr_ready: "opened a PR" }

/** A sub-task's report: who sent it and how it ended (its PR as a link, once it has one), then its reply as Markdown. */
export function SubtaskReportLine({ m }: { m: TaskMessage }) {
  const from = String(m.meta?.from ?? "")
  const status = String(m.meta?.subtaskReport ?? "") as TaskStatus
  const child = useTask(from).data
  const pr = child?.prUrl ? child : null
  // The PR link already says "opened a PR".
  const word = status === "pr_ready" && pr ? null : (REPORT_WORD[status] ?? status)
  return (
    <div data-testid="subtask-report" className={cx(MESSAGE_BLOCK, "flex items-start gap-2 rounded-lg bg-violet-500/5 px-3 py-2 text-sm text-violet-100")}>
      <LineIcon icon={Users} className="h-4 w-4 text-violet-400" />
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex flex-wrap items-baseline gap-x-1.5 text-[11px] leading-5 font-semibold text-violet-400 pointer-coarse:min-h-9 pointer-coarse:items-center">
          <span>Report from</span>
          <AppLink href={`/tasks/${from}`} className={cx(TAP_AREA, "min-w-0 wrap-anywhere text-yard-300 hover:underline")}>
            {String(m.meta?.fromTitle ?? from)}
          </AppLink>
          {word && <span className={cx("font-normal", status === "failed" ? "text-red-300" : status === "needs_input" ? "text-amber-300" : "text-violet-300/80")}>{word}</span>}
          {pr && <PrChip task={pr} variant="number" className={cx(TAP_AREA, "font-normal tabular-nums")} />}
          <span className="text-[10px] font-normal text-zinc-600">
            <TimeAgo ts={m.createdAt} />
          </span>
        </div>
        <div className="min-w-0 text-zinc-200 [&>.prose-chat>:first-child]:mt-0!">
          <Markdown>{m.content}</Markdown>
        </div>
        {typeof m.meta?.question === "string" && <div className="mt-1 text-xs text-amber-200">It asks: {m.meta.question}</div>}
      </div>
      <MessageActions text={m.content} />
    </div>
  )
}
