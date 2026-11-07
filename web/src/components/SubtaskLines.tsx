// A parent task's transcript lines about its sub-tasks (server/subtasks.ts): the ones it started, as links with their
// live status, and each one's report. A sub-task link opens its task in the rightmost unpinned panel's place
// (lib/columns.ts); on a phone, in a panel beside this one (lib/panelStack.ts).
import { useMemo } from "react"
import { GitFork, Users } from "lucide-react"
import type { TaskMessage, TaskStatus } from "../../../shared/types"
import { useTasks } from "../lib/queries"
import { MESSAGE_BLOCK, MessageActions } from "./MessageActions"
import { AppLink, LineIcon, Markdown, STATUS, TimeAgo, cx } from "./ui"

type Listed = { id: string; title: string }

const listed = (m: TaskMessage): Listed[] =>
  Array.isArray(m.meta?.subtasks)
    ? (m.meta.subtasks as unknown[]).flatMap((s) => {
        const o = s as Partial<Listed> | null
        return o && typeof o.id === "string" ? [{ id: o.id, title: typeof o.title === "string" ? o.title : o.id }] : []
      })
    : []

/** An event that lists sub-tasks ("Started 4 sub-tasks.", "Cancelled 1 sub-task."). */
export const isSubtasksEvent = (m: TaskMessage) => m.role === "event" && m.meta?.kind === "subtasks" && listed(m).length > 0

/** "Started 4 sub-tasks." and a link to each, its dot and status kept live. */
export function SubtasksLine({ m }: { m: TaskMessage }) {
  const tasks = useTasks()
  const items = useMemo(() => listed(m), [m])
  const byId = useMemo(() => new Map((tasks.data ?? []).map((t) => [t.id, t])), [tasks.data])
  return (
    <div data-testid="subtasks-line" className="@container/subtasks flex items-start gap-1.5 text-xs text-zinc-500">
      <LineIcon icon={GitFork} className="h-3.5 w-3.5 text-zinc-500" />
      <div className="min-w-0 flex-1">
        <div className="wrap-anywhere">
          {m.content}
          <span className="ml-2 text-[10px] text-zinc-600">
            <TimeAgo ts={m.createdAt} />
          </span>
        </div>
        <ul className="mt-1 -ml-2 grid gap-px">
          {items.map((s) => {
            const task = byId.get(s.id)
            const status: TaskStatus | null = task?.status ?? null
            return (
              <li key={s.id} className="min-w-0">
                <AppLink
                  href={`/tasks/${s.id}`}
                  className="grid min-h-8 min-w-0 grid-cols-[0.5rem_minmax(0,1fr)] content-center items-center gap-x-2 rounded-md px-2 py-1 text-sm text-yard-300 hover:bg-zinc-900 hover:text-yard-200 @min-[20rem]/subtasks:grid-cols-[0.5rem_minmax(0,1fr)_auto] pointer-coarse:min-h-11"
                >
                  <span aria-hidden className={cx("h-2 w-2 shrink-0 rounded-full", status ? STATUS[status].dot : "bg-zinc-700")} />
                  <span className="col-start-2 min-w-0 truncate">{task?.title ?? s.title}</span>
                  {status && <span className="col-start-2 row-start-2 text-[11px] text-zinc-500 @min-[20rem]/subtasks:col-start-3 @min-[20rem]/subtasks:row-start-1">{STATUS[status].label}</span>}
                </AppLink>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

const REPORT_WORD: Partial<Record<TaskStatus, string>> = { done: "done", failed: "failed", needs_input: "asks", idle: "replied", pr_ready: "opened a PR" }

/** A sub-task's report: who sent it and how it ended, then its reply as Markdown. */
export function SubtaskReportLine({ m }: { m: TaskMessage }) {
  const from = String(m.meta?.from ?? "")
  const status = String(m.meta?.subtaskReport ?? "") as TaskStatus
  return (
    <div data-testid="subtask-report" className={cx(MESSAGE_BLOCK, "flex items-start gap-2 rounded-lg bg-violet-500/5 px-3 py-2 text-sm text-violet-100")}>
      <LineIcon icon={Users} className="h-4 w-4 text-violet-400" />
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex flex-wrap items-baseline gap-x-1.5 text-[11px] leading-5 font-semibold text-violet-400">
          <span>Report from</span>
          <AppLink href={`/tasks/${from}`} className="min-w-0 wrap-anywhere text-yard-300 hover:underline">
            {String(m.meta?.fromTitle ?? from)}
          </AppLink>
          <span className={cx("font-normal", status === "failed" ? "text-red-300" : status === "needs_input" ? "text-amber-300" : "text-violet-300/80")}>{REPORT_WORD[status] ?? status}</span>
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
