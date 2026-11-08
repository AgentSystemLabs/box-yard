import { useTranscriptHistory } from "../lib/transcriptHistory"
import { HistoryNavigation } from "./HistoryNavigation"
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react"
import { Bot, MessageCircleQuestion, Navigation2, Users, Webhook } from "lucide-react"
import {
  newClientId,
  useArtifacts,
  useProjects,
  useSchedules,
  useSendChat,
  useSendTaskMessage,
  useTask,
  useTaskMessages,
} from "../lib/queries"
import { useEntityIndex } from "../lib/entities"
import { useTail } from "../lib/tail"
import { chatDays } from "../lib/chatDays"
import { ChatHistory, DayBoundary } from "./ChatHistory"
import { AppLink, Button, Elapsed, Empty, InRepo, LineIcon, LinkedText, Markdown, TAP_AREA, TimeAgo, cx, useRepoScope, warmMarkdown, WaitIcon } from "./ui"
import { StickyScroll, type StickyScrollHandle } from "./StickyScroll"
import { CaptainAnswerLine, TaskComposer, ToCaptainLine } from "./CaptainForward"
import { PAGE_BLEED_BOTTOM } from "../lib/layout"
import { TaskHeader } from "./TaskHeader"
import { PublishedFile } from "./TaskFiles"
import { PREVIEW_GROUP } from "./FileLink"
import { threadRuns } from "../lib/taskThread"
import { AttachmentList } from "./Attachments"
import { TaskQueue } from "./QueuedMessages"
import { RecommendedNextSteps, nextStepsFromMeta } from "./RecommendedNextSteps"
import { SelectionToTask } from "./SelectionToTask"
import { MESSAGE_BLOCK, MessageActions } from "./MessageActions"
import { projectContext, taskContext, type SelectionTaskSource } from "../lib/selectionTask"
import type { Attachment, TaskMessage } from "../../../shared/types"
import { userMessageLabel } from "../../../shared/sender"
import { useOwnerName } from "../lib/queries"
import { WaitFixButton, WaitReason } from "./WaitReason"
import { TaskFailure } from "./TaskFailure"
import { TurnTimingChip, timingOf } from "./TurnTimingChip"
import { runningSince } from "../lib/runningTasks"
import { Loading } from "./Loading"
import { SubtaskReportLine, SubtasksLine, isSubtasksEvent } from "./SubtaskLines"

/** A task's page. "#12" and "PR #12" in its text link to its project's repo. */
export function TaskView({ id }: { id: string }) {
  return (
    <InRepo taskId={id}>
      <TaskPage id={id} />
    </InRepo>
  )
}

function TaskPage({ id }: { id: string }) {
  // Only this task: other tasks' live updates don't re-render the view.
  const tasks = useTask(id)
  const projects = useProjects()
  const schedules = useSchedules()
  const artifacts = useArtifacts()
  const send = useSendTaskMessage(id)
  const sendChat = useSendChat()
  const panel = useRef<HTMLDivElement>(null)
  const thread = useRef<StickyScrollHandle>(null)
  const task = tasks.data
  const project = projects.data?.find((p) => p.id === task?.projectId)
  const schedule = task?.scheduleId ? schedules.data?.find((s) => s.id === task.scheduleId) : null
  // A message to a busy task shows as a queued row at the end of the transcript: either way, scroll to it.
  const submit = useCallback(
    (content: string, attachments: Attachment[]) => {
      const sending = send.mutateAsync({ content, attachments })
      sending.catch(() => {}) // onError already says so; the Composer puts the text back.
      thread.current?.scrollToEnd()
      return sending
    },
    [send.mutateAsync],
  )
  const scrollToEnd = useCallback(() => thread.current?.scrollToEnd(), [])
  const sendFollowUp = useCallback((content: string) => submit(content, []), [submit])
  const startFromSelection = useCallback(
    (content: string) => sendChat.mutate({ id: newClientId("chat"), content, attachments: [] }),
    [sendChat.mutate],
  )
  // Memoized so the header's files chip and drawer only recompute when this task's files change.
  const files = useMemo(() => (artifacts.data ?? []).filter((a) => a.taskId === id), [artifacts.data, id])
  const selectionSource: SelectionTaskSource | null = project && task ? { kind: "task", project: projectContext(project)!, task: taskContext(task)! } : null

  if (tasks.isLoading) return null
  if (!task) return <Empty title="Task not found">It may have been deleted.</Empty>

  const running = task.status === "working" || task.status === "starting"

  return (
    // Runs through the page's bottom padding so the composer lines up with the Coordinator panel's.
    <div ref={panel} className={cx("relative flex min-w-0 flex-col", PAGE_BLEED_BOTTOM)}>
      <TaskHeader task={task} project={project} schedule={schedule} files={files} />

      {task.status === "needs_input" && task.question && (
        <div className="mb-4 flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-amber-100">
          <MessageCircleQuestion className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
          <div>
            <div className="text-xs font-semibold tracking-wide text-amber-400 uppercase">The agent needs you</div>
            <div className="mt-1 text-sm">
              <LinkedText text={task.question} />
            </div>
          </div>
        </div>
      )}
      {task.status === "queued" && task.waitReason && (
        <div role="status" className="mb-4 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <WaitIcon task={task} className="h-4 w-4 shrink-0 text-amber-300" />
          <span className="min-w-0 flex-1">
            {/* A wait with a fix says when it ends itself ("…, or it resets at midnight"). */}
            <WaitReason task={task} />.
            {!task.waitFix && ` It starts on its own once there is room${task.waitBoxSize ? `, and never on a box smaller than ${task.waitBoxSize}` : ""}.`}
          </span>
          <WaitFixButton task={task} className="shrink-0" />
        </div>
      )}
      <TaskFailure task={task} project={project} className="mb-4" />

      <TaskThread
        handle={thread}
        id={id}
        working={running ? (task.status === "starting" ? "Preparing the box…" : "Agent is working…") : null}
        workingSince={running ? runningSince(task) : null}
        selectionSource={selectionSource}
        onStartFromSelection={startFromSelection}
        onFollowUp={sendFollowUp}
      />

      <TaskComposer task={task} project={project} panelRef={panel} onSubmit={submit} onForwarded={scrollToEnd} />
    </div>
  )
}

/** The transcript. Its own component so header updates (status, context meter) don't re-render it. */
export const TaskThread = memo(function TaskThread({
  handle,
  id,
  working,
  workingSince = null,
  selectionSource,
  onStartFromSelection,
  onFollowUp,
  bare = false,
  scrollKey,
}: {
  handle: Ref<StickyScrollHandle>
  id: string
  /** In the task panel: no framed box, and the text in the Captain chat's column (`chat-column`), at its width. */
  bare?: boolean
  scrollKey?: string
  working: string | null
  /** Since when it has been working, for the live "· 12m" after `working`. */
  workingSince?: number | null
  selectionSource: SelectionTaskSource | null
  onStartFromSelection: (prompt: string) => void
  onFollowUp: (message: string) => void
}) {
  const historyHandle = useRef<StickyScrollHandle>(null)
  const setHistoryHandle = useCallback((value: StickyScrollHandle | null) => {
    historyHandle.current = value
    if (typeof handle === "function") handle(value)
    else if (handle) handle.current = value
  }, [handle])
  const messages = useTaskMessages(id)
  const history = useTranscriptHistory(`/api/tasks/${id}/history`, messages.data ?? [])
  const newestReply = useMemo(() => {
    const list = history.items
    for (let i = list.length - 1; i >= 0; i--) if (list[i]!.role === "assistant") return list[i]!.id
    return null
  }, [history.items])
  const shown = useMemo(() => history.items.filter((m) => m.role !== "tool"), [history.items])
  const days = useMemo(() => chatDays(shown), [shown])
  // Opening a task paints its newest rows first, then the rest of the tail right after.
  const tail = useTail(shown, id, { first: firstPaintCount(shown), max: 200 })
  const [revealedMessage, setRevealedMessage] = useState<{ id: string } | null>(null)
  const tailReveal = tail.reveal
  const reveal = useCallback((messageId: string) => {
    if (!tailReveal(messageId)) return false
    setRevealedMessage({ id: messageId })
    return true
  }, [tailReveal])
  const runs = useMemo(() => threadRuns(tail.visible), [tail.visible])
  const firstMessages = useMemo(() => runs.map((r) => r.kind === "line" ? r.m : r.messages[0]!), [runs])

  // Older replies aren't rendered yet: parse their markdown in idle time so loading them is quick.
  const hidden = tail.hidden
  const index = useEntityIndex()
  const repo = useRepoScope()
  useEffect(() => {
    if (hidden) warmMarkdown(shown.slice(0, hidden).flatMap((m) => (m.role === "assistant" ? [m.content] : [])), index, repo)
  }, [shown, hidden, index, repo])

  return (
    <SelectionToTask source={selectionSource} onPrompt={onStartFromSelection}>
      <ChatHistory index={history.index} days={history.days ?? days} messages={shown} reveal={reveal} ensure={history.ensure} scrollHandle={historyHandle} taskId={id}>
        <StickyScroll
          handle={setHistoryHandle}
          count={messages.data?.length ?? 0}
          resetKey={id}
          restoreKey={scrollKey ?? `task:${id}`}
          hidden={tail.hidden || (history.moreBefore ? 1 : 0)}
          earlierLabel={tail.hidden ? undefined : "Show earlier messages"}
          onJump={() => { history.toLatest(); tail.reset() }}
          onLoadEarlier={tail.hidden ? tail.loadEarlier : history.earlier}
          onTrim={tail.trim}
          className={bare ? "chat-column py-3" : "rounded-xl border border-zinc-900 bg-zinc-950 p-4"}
          contentClassName="space-y-2.5"
        >
          {messages.isLoading && <Loading kind="chat" label="Loading the transcript" />}
          {messages.isError && <div role="alert" className="text-sm text-red-300">Couldn't load the transcript. <Button variant="ghost" onClick={() => void messages.refetch()}>Retry</Button></div>}
          {runs.map((r, i) => (
            <Fragment key={firstMessages[i]!.id}>
              <DayBoundary at={firstMessages[i]!.createdAt} previousAt={firstMessages[i - 1]?.createdAt} messageId={firstMessages[i]!.id} />
              {r.kind === "published" ? <PublishedRun messages={r.messages} />
              : r.kind === "housekeeping" ? <HousekeepingRun messages={r.messages} revealRequest={r.messages.some((m) => m.id === revealedMessage?.id) ? revealedMessage : null} />
              : <Line m={r.m} next={r.m.id === newestReply} onFollowUp={onFollowUp} />}
            </Fragment>
          ))}
          <HistoryNavigation newer={!!tail.later || history.moreAfter} onNewer={tail.later ? tail.loadLater : history.later} browsing={history.browsing} loading={history.loading} onLatest={history.toLatest} handle={historyHandle} />
          {working && (
            <div className="flex items-center gap-2 pt-1 text-xs text-sky-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" /> {working}
              {workingSince !== null && (
                <span data-testid="working-for" className="text-zinc-500">
                  · <Elapsed since={workingSince} title="Started" className="tabular-nums" />
                </span>
              )}
            </div>
          )}
          <TaskQueue taskId={id} />
        </StickyScroll>
      </ChatHistory>
    </SelectionToTask>
  )
})

/** Rows a task's first paint shows: even short ones fill a tall screen. */
const FIRST_PAINT_ROWS = 20

/** How many of the newest messages the first paint shows: FIRST_PAINT_ROWS of them that aren't events, which fold. */
export function firstPaintCount(shown: readonly TaskMessage[]): number {
  let rows = 0
  for (let i = shown.length - 1; i >= 0; i--) if (shown[i]!.role !== "event" && ++rows === FIRST_PAINT_ROWS) return shown.length - i
  return shown.length
}

/** Back-to-back published files as one wrapping row of file chips (one ←/→ gallery), with the newest one's time. */
const PublishedRun = memo(
  function PublishedRun({ messages }: { messages: TaskMessage[] }) {
    return (
      <div className="flex flex-wrap items-center gap-1.5 pl-6" {...PREVIEW_GROUP}>
        {messages.map((m) => (
          <PublishedFile key={m.id} artifactId={typeof m.meta?.artifactId === "string" ? m.meta.artifactId : undefined} url={String(m.meta!.url)} text={m.content} />
        ))}
        <span className="text-[10px] text-zinc-600">
          <TimeAgo ts={messages.at(-1)!.createdAt} />
        </span>
      </div>
    )
  },
  (a, b) => a.messages.length === b.messages.length && a.messages.every((m, i) => m === b.messages[i]),
)

/**
 * Back-to-back housekeeping events (lib/taskThread.ts) as their newest line, with "N earlier" to unfold the rest above
 * it. The newest stays in view, so a starting task still reads as a live status line ("Cloned…", "Workspace ready").
 */
const HousekeepingRun = memo(
  function HousekeepingRun({ messages, revealRequest }: { messages: TaskMessage[]; revealRequest: { id: string } | null }) {
    const [open, setOpen] = useState(false)
    useLayoutEffect(() => { if (revealRequest) setOpen(true) }, [revealRequest])
    const earlier = messages.length - 1
    const toggle = (
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? `Hide ${earlier} earlier ${earlier === 1 ? "event" : "events"}` : `Show ${earlier} earlier ${earlier === 1 ? "event" : "events"}`}
        onClick={() => setOpen((o) => !o)}
        className={cx(TAP_AREA, "ml-2 rounded text-[11px] text-zinc-500 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-300 hover:decoration-zinc-500 focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none")}
      >
        {open ? "Show less" : `${earlier} earlier`}
      </button>
    )
    return (
      <div data-testid="housekeeping" data-open={open || undefined} className="space-y-2.5">
        {open && messages.slice(0, -1).map((m) => <EventText key={m.id} m={m} />)}
        <EventText m={messages.at(-1)!}>{toggle}</EventText>
      </div>
    )
  },
  (a, b) => a.revealRequest === b.revealRequest && a.messages.length === b.messages.length && a.messages.every((m, i) => m === b.messages[i]),
)

/** A plain event: dim small text, its time, and a finished turn's timing. */
function EventText({ m, children }: { m: TaskMessage; children?: ReactNode }) {
  const url = typeof m.meta?.url === "string" ? m.meta.url : null
  const timing = timingOf(m.meta)
  return (
    <div data-chat-id={m.id} className="pl-6 text-xs wrap-anywhere text-zinc-500">
      {url ? (
        <AppLink href={url} className="hover:text-zinc-300 hover:underline">
          {m.content}
        </AppLink>
      ) : (
        m.content
      )}
      <span className="ml-2 text-[10px] text-zinc-600">
        <TimeAgo ts={m.createdAt} />
      </span>
      {timing && <TurnTimingChip id={timing.id} ms={timing.ms} className="ml-2 align-middle" />}
      {children}
    </div>
  )
}

export const Line = memo(function Line({ m, onFollowUp, next = true }: { m: TaskMessage; onFollowUp: (message: string) => void; next?: boolean }) {
  const ownerName = useOwnerName()
  const time = (
    <span className="ml-2 text-[10px] text-zinc-600">
      <TimeAgo ts={m.createdAt} />
    </span>
  )
  switch (m.role) {
    case "user": {
      // A hook's message (server/hooks.ts) is an automation's, not Cody's: its own colour and icon.
      const hook = m.meta?.source === "hook"
      return (
        <div className={cx(MESSAGE_BLOCK, "rounded-lg border-l-2 px-3 py-2", hook ? "border-teal-500 bg-teal-500/5" : "border-yard-500 bg-yard-500/5")} data-testid={hook ? "hook-message" : undefined}>
          <div className={cx("mb-0.5 flex items-center gap-1 text-[11px] font-semibold", hook ? "text-teal-300" : "text-yard-400")}>
            {hook && <Webhook className="h-3 w-3" />}
            {userMessageLabel(m.meta, ownerName)}
            {/* Transport acceptance does not establish when the model processed a follow-up. */}
            {m.meta?.steered === true && (
              <span className="inline-flex items-center gap-0.5 rounded bg-yard-500/10 px-1 text-[10px] font-semibold text-yard-300" title={m.meta?.steerAccepted ? "Codex accepted this input; model processing is not confirmed" : "Written to the agent's input stream; model processing is not confirmed"}>
                <Navigation2 className="h-2.5 w-2.5 rotate-90" aria-hidden />
                {m.meta?.steerAccepted ? "Accepted by Codex" : "Steered"}
              </span>
            )}
            {time}
          </div>
          {m.content && <div className="text-sm whitespace-pre-wrap wrap-anywhere text-zinc-200">{m.content}</div>}
          <AttachmentList files={m.meta?.attachments} />
          {m.meta?.undelivered === true && <div className="mt-1 text-[11px] text-zinc-500">Not delivered: the task was stopped or marked done first.</div>}
          {m.meta?.deliveryUncertain === true && <div className="mt-1 text-[11px] text-zinc-500">Delivery uncertain: this may already have reached Codex. Removing it from the queue does not undo delivery.</div>}
          {!m.meta?.pending && <MessageActions text={m.content} />}
        </div>
      )
    }
    case "assistant":
      return (
        // The reply's first block drops its top margin (pt-1.5 keeps the gap) and the row sets one leading,
        // so the icon's one-line box sits on the first line. A reply opening with a code block: the box
        // skips the block's p-3 and is one 16px code line tall.
        <div className={cx(MESSAGE_BLOCK, "group flex min-w-0 items-start gap-2 pt-1.5 text-sm leading-relaxed")}>
          <LineIcon icon={Bot} className="h-4 w-4 text-zinc-500" box="group-has-[>div>.prose-chat>.code-block:first-child]:mt-3 group-has-[>div>.prose-chat>.code-block:first-child]:h-4" />
          <div className="min-w-0 text-zinc-200 [&>.prose-chat>:first-child]:mt-0!">
            <Markdown>{m.content}</Markdown>
            {next && <RecommendedNextSteps steps={nextStepsFromMeta(m.meta)} onPick={onFollowUp} />}
          </div>
          <MessageActions text={m.content} />
        </div>
      )
    case "tool":
      return (
        <div className={cx("overflow-x-auto pl-6 font-mono text-[11px] whitespace-nowrap", m.meta?.error ? "text-red-400/80" : "text-zinc-600")}>
          {m.meta?.error ? "✗ " : "› "}
          {m.content}
        </div>
      )
    case "agent":
      if (m.meta?.subtaskReport) return <SubtaskReportLine m={m} />
      return (
        <div className={cx(MESSAGE_BLOCK, "flex items-start gap-2 rounded-lg bg-violet-500/5 px-3 py-2 text-sm text-violet-200")}>
          <LineIcon icon={Users} className="h-4 w-4 text-violet-400" />
          <div className="min-w-0">
            {typeof m.meta?.from === "string" && (
              <AppLink href={`/tasks/${m.meta.from}`} className="mb-0.5 block text-[11px] leading-5 font-semibold text-violet-400 hover:underline">
                From {String(m.meta.fromTitle ?? m.meta.from)}
              </AppLink>
            )}
            <div className="whitespace-pre-wrap wrap-anywhere">{m.content}</div>
          </div>
          <MessageActions text={m.content} />
        </div>
      )
    default: {
      if (m.meta?.kind === "to_captain") return <ToCaptainLine m={m} />
      if (m.meta?.kind === "captain_answer") return <CaptainAnswerLine m={m} />
      if (isSubtasksEvent(m)) return <SubtasksLine m={m} />
      if (m.meta?.kind === "hook")
        return (
          <div className={cx("flex items-start gap-1.5 pl-1 text-xs leading-relaxed", m.meta.status === "fired" ? "text-teal-300/90" : "text-amber-200/80")} data-testid="hook-event">
            <LineIcon icon={Webhook} className="h-3.5 w-3.5" />
            <div className="min-w-0 wrap-anywhere [&_p]:inline">
              <Markdown>{m.content}</Markdown>
              {time}
            </div>
          </div>
        )
      return <EventText m={m} />
    }
  }
})
