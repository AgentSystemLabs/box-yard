// The line under a task's question, PR or failure card in the Coordinator's transcript (lib/noticeNow.ts). While it
// waits on Cody it leads with a status word in its colour and offers one action: Answer (the task's panel, its box
// focused), its PR on GitHub, or Retry. Once the task has moved on it says where it is now ("Now · Working"), and the
// card goes gray (ChatLine.tsx NoticeLine).
import { memo, useCallback } from "react"
import { MessageSquareReply, RotateCcw } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { fetchTasks, keys, useRetryTask } from "../lib/queries"
import { isAskKind, noticeNow, useIsNewestAsk, type AskKind, type NoticeNow, type NoticeTask } from "../lib/noticeNow"
import type { NoticeKind } from "../lib/captainTranscript"
import { focusComposer } from "../lib/chatSwitch"
import { navigateApp, taskSessionHref } from "../lib/navigation"
import { PrChip, STATUS, StatusDot, cx } from "./ui"
import type { Task } from "../../../shared/types"

type CardTask = NoticeTask & Pick<Task, "prMergedAt" | "prMergedBy">

/** What the card needs of its task, the same object until one of these changes, so other task updates skip it. */
function useCardTask(taskId: string | null): CardTask | null {
  const select = useCallback(
    (list: Task[]): CardTask | null => {
      const t = taskId ? list.find((x) => x.id === taskId) : undefined
      return t ? { status: t.status, prUrl: t.prUrl, prState: t.prState, prMergedAt: t.prMergedAt, prMergedBy: t.prMergedBy } : null
    },
    [taskId],
  )
  return useQuery({ queryKey: keys.tasks, queryFn: fetchTasks, select, enabled: Boolean(taskId) }).data ?? null
}

/** A notice's card now: null for any other notice, outside the transcript, or about a task the app doesn't know. */
export function useNoticeNow(kind: NoticeKind, taskId: string | null, id: string): { now: NoticeNow; task: CardTask } | null {
  const newest = useIsNewestAsk(isAskKind(kind) ? taskId : null, id)
  const task = useCardTask(newest === null ? null : taskId)
  const now = noticeNow(kind, task, Boolean(newest))
  return now && task ? { now, task } : null
}

/** Its status word's look: the task status colours (ui.tsx STATUS), so it reads like the badge it is. */
const TONE: Record<AskKind, { chip: string; dot: string; action: string }> = {
  needs_input: { ...STATUS.needs_input, action: "border-amber-500/45 bg-amber-500/15 text-amber-100 hover:bg-amber-500/25" },
  pr: { ...STATUS.pr_ready, action: "" },
  failed: { ...STATUS.failed, action: "border-red-500/45 bg-red-500/10 text-red-100 hover:bg-red-500/20" },
}

/** The card's one action: 28px drawn, 44px to a finger (its row is that tall then, so nothing overlaps). */
const ACTION_SIZE = "h-7 text-xs pointer-coarse:h-11 focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none"
const ACTION = cx(ACTION_SIZE, "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 font-semibold whitespace-nowrap transition pointer-coarse:px-3.5")
/** PrChip draws its own chip (GitHub's colours, ↗); this only sizes it like the other actions. */
const PR_ACTION = cx(ACTION_SIZE, "px-2.5! pointer-coarse:px-3.5!")

export const NoticeNowRow = memo(function NoticeNowRow({ now, task, taskId, title }: { now: NoticeNow; task: CardTask; taskId: string; title: string | null }) {
  if (!now.live)
    return (
      <div data-testid="notice-now" data-live="false" className="mt-1 flex min-w-0 items-center gap-1.5 text-zinc-500">
        <span>Now</span>
        <StatusDot status={now.status} className="font-normal text-zinc-400" />
      </div>
    )
  const tone = TONE[now.kind]
  return (
    <div data-testid="notice-now" data-live="true" className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className={cx("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap", tone.chip)}>
        <span aria-hidden className={cx("h-1.5 w-1.5 shrink-0 rounded-full", tone.dot)} />
        {now.label}
      </span>
      {now.kind === "pr" ? (
        <PrChip task={task} verb="Review" className={PR_ACTION} />
      ) : now.kind === "needs_input" ? (
        <AnswerButton taskId={taskId} title={title} className={cx(ACTION, tone.action)} />
      ) : (
        <RetryButton taskId={taskId} title={title} className={cx(ACTION, tone.action)} />
      )}
    </div>
  )
})

/** Opens the task beside the chat with its box focused: the question is its newest message, right above it. */
function AnswerButton({ taskId, title, className }: { taskId: string; title: string | null; className: string }) {
  const answer = () => {
    navigateApp(taskSessionHref(taskId))
    focusComposer(taskId)
  }
  return (
    <button type="button" data-testid="notice-answer" onClick={answer} title={`Open ${title ?? "the task"} and answer it`} className={className}>
      <MessageSquareReply className="h-3.5 w-3.5" aria-hidden />
      Answer
    </button>
  )
}

/** Runs the task again from where it failed (the task header's Retry). */
function RetryButton({ taskId, title, className }: { taskId: string; title: string | null; className: string }) {
  const retry = useRetryTask()
  return (
    <button
      type="button"
      data-testid="notice-retry"
      onClick={() => retry.mutate(taskId)}
      disabled={retry.isPending}
      title={`Run ${title ?? "the task"} again: its agent checks where things stand and continues`}
      className={cx(className, "disabled:opacity-60")}
    >
      <RotateCcw className="h-3.5 w-3.5" aria-hidden />
      {retry.isPending ? "Retrying…" : "Retry"}
    </button>
  )
}
