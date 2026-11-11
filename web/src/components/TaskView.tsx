import { useTranscriptHistory } from "../lib/transcriptHistory"
import { HistoryNavigation } from "./HistoryNavigation"
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react"
import { Bot, ChevronDown, ChevronRight, MessageCircleQuestion, MessageSquareReply, Navigation2, Users, Webhook } from "lucide-react"
import { useOwnerName, useTaskMessages } from "../lib/queries"
import { useEntityIndex } from "../lib/entities"
import { useTail } from "../lib/tail"
import { chatDays } from "../lib/chatDays"
import { ChatHistory, DayBoundary } from "./ChatHistory"
import { AppLink, Button, Elapsed, LineIcon, Markdown, TAP_AREA, TimeAgo, cx, useRepoScope, warmMarkdown } from "./ui"
import { StickyScroll, type StickyScrollHandle } from "./StickyScroll"
import { CaptainAnswerLine, ToCaptainLine } from "./CaptainForward"
import { PublishedFile } from "./TaskFiles"
import { PREVIEW_GROUP } from "./FileLink"
import { STEPS_SO_FAR, threadLines, threadRuns } from "../lib/taskThread"
import { focusComposer } from "../lib/chatSwitch"
import { AttachmentList } from "./Attachments"
import { TaskQueue } from "./QueuedMessages"
import { RecommendedNextSteps, nextStepsFromMeta } from "./RecommendedNextSteps"
import { SelectionToTask, type SelectionAsk } from "./SelectionToTask"
import { MESSAGE_BLOCK, MessageActions } from "./MessageActions"
import type { SelectionTaskSource } from "../lib/selectionTask"
import type { TaskMessage, TaskStatus } from "../../../shared/types"
import { submissionId } from "../lib/taskSubmissions"
import { userMessageLabel } from "../../../shared/sender"
import { DEFAULT_OWNER_NAME } from "../../../shared/owner"
import { toolBrief } from "../../../shared/activity"
import { TurnTimingChip, timingOf } from "./TurnTimingChip"
import { Loading } from "./Loading"
import { SubtaskReportLine, SubtasksLine } from "./SubtaskLines"

/** The live line's words while a turn runs: what is going on, never the task's state (its icon says that). */
export const workingLabel = (status: TaskStatus) => (status === "starting" ? "Preparing the workspace" : "Turn running")

/** How far back the live line looks for the running turn's newest tool call. */
const TOOL_SCAN = 200
/** "Turn 3 finished · $0.42." (server/tasks.ts): the event that closes a turn. */
const TURN_END = /^Turn (\d+ )?(finished|stopped|failed)\b/

/** The running turn's newest tool call, as it was stored: the live line shows it on one line (toolBrief), since the transcript folds tool calls away. */
function latestTool(items: readonly TaskMessage[]): string | null {
  for (let i = items.length - 1, end = Math.max(0, items.length - TOOL_SCAN); i >= end; i--) {
    const m = items[i]!
    if (m.role === "tool" && !m.meta?.error) return m.content.trim() || null
    // The message that started the turn, or the end of the turn before it: nothing older is this turn's.
    if (m.role === "user" ? !m.meta?.pending : m.role === "event" && (timingOf(m.meta) !== null || TURN_END.test(m.content))) return null
  }
  return null
}

/** The transcript. Its own component so header updates (status, context meter) don't re-render it. */
export const TaskThread = memo(function TaskThread({
  handle,
  id,
  working,
  workingSince = null,
  ask = null,
  selectionSource,
  selectionAsk,
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
  /** The question the task waits on (needs_input), as a card at the thread's foot until it's answered. */
  ask?: string | null
  /** Where its lines are, for the selection's Create task (its project's Captain gets it). */
  selectionSource: SelectionTaskSource | null
  /** Where the selection's Ask goes: a thread of its project's Captain chat, shown in the task's panel. Null: no Ask. */
  selectionAsk: SelectionAsk | null
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
  // The pending question's own event: the card at the foot says it, so its line steps aside until it's answered.
  const asked = useMemo(() => {
    if (!ask) return null
    const list = history.items
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]!
      if (m.role === "event" && m.meta?.kind === "question") return m.content.endsWith(ask) ? m : null
    }
    return null
  }, [ask, history.items])
  const tool = useMemo(() => (working ? latestTool(history.items) : null), [working, history.items])
  const { lines: shown, steps } = useMemo(() => threadLines(history.items, asked?.id), [history.items, asked])
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
  // The tool calls each row followed; a fold's are the ones before any of its lines.
  const runSteps = useMemo(
    () =>
      runs.map((r) => {
        if (r.kind === "line") return steps.get(r.m.id) ?? null
        const all = r.messages.flatMap((m) => steps.get(m.id) ?? [])
        return all.length ? all : null
      }),
    [runs, steps],
  )
  // The ones after the newest line (not while reading older rows): a running turn's so far, which its live line
  // counts and unfolds, or a stopped turn's last, in a row of their own.
  const stepsSoFar = tail.later ? null : (steps.get(STEPS_SO_FAR) ?? null)

  // Older replies aren't rendered yet: parse their markdown in idle time so loading them is quick.
  const hidden = tail.hidden
  const index = useEntityIndex()
  const repo = useRepoScope()
  useEffect(() => {
    if (hidden) warmMarkdown(shown.slice(0, hidden).flatMap((m) => (m.role === "assistant" ? [m.content] : [])), index, repo)
  }, [shown, hidden, index, repo])

  return (
    <SelectionToTask source={selectionSource} askOn={selectionAsk}>
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
          {/* One list, so a run of steps keeps its row (and whether it's open) once the line it led to arrives. */}
          {[
            ...runs.flatMap((r, i) => {
              const before = runSteps[i]
              const row = (
                <Fragment key={submissionId(firstMessages[i]!)}>
                  <DayBoundary at={firstMessages[i]!.createdAt} previousAt={firstMessages[i - 1]?.createdAt} messageId={firstMessages[i]!.id} />
                  {r.kind === "published" ? <PublishedRun messages={r.messages} />
                  : r.kind === "housekeeping" ? <HousekeepingRun messages={r.messages} revealRequest={r.messages.some((m) => m.id === revealedMessage?.id) ? revealedMessage : null} />
                  : <Line m={r.m} next={r.m.id === newestReply} onFollowUp={onFollowUp} />}
                </Fragment>
              )
              return before ? [<StepsRun key={stepsKey(before)} messages={before} />, row] : [row]
            }),
            stepsSoFar && !working && <StepsRun key={stepsKey(stepsSoFar)} messages={stepsSoFar} />,
          ]}
          <HistoryNavigation newer={!!tail.later || history.moreAfter} onNewer={tail.later ? tail.loadLater : history.later} browsing={history.browsing} loading={history.loading} onLatest={history.toLatest} handle={historyHandle} />
          {working && <WorkingLine label={working} since={workingSince} tool={tool} steps={stepsSoFar} />}
          {ask && (
            // At the foot, where the working line was, so it's the last thing above the box however long the thread.
            <div role="group" aria-label="The agent asks" data-testid="pending-ask" className="flex items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 text-sm">
              {/* Its first row is as tall as Answer (h-7), and so is the icon's box. A narrow card (a small phone) drops
                  the time and Answer's icon, so the label is never cut. */}
              <LineIcon icon={MessageCircleQuestion} className="h-4 w-4 text-amber-400" box="h-7!" />
              <div className="@container/ask min-w-0 flex-1">
                <div className="flex h-7 min-w-0 items-center gap-2 text-[11px] font-semibold text-amber-400">
                  <span className="shrink-0">The agent asks</span>
                  {asked && (
                    <span className="shrink-0 text-[11px] font-normal text-zinc-400 @max-[15rem]/ask:hidden">
                      <TimeAgo ts={asked.createdAt} />
                    </span>
                  )}
                  <button type="button" data-testid="pending-ask-answer" onClick={() => focusComposer(id)} className={cx(TAP_AREA, ANSWER_BUTTON)}>
                    <MessageSquareReply className="h-3.5 w-3.5 @max-[15rem]/ask:hidden" aria-hidden />
                    Answer
                  </button>
                </div>
                <div className="min-w-0 leading-relaxed wrap-anywhere text-zinc-100 [&>.prose-chat>:first-child]:mt-0!">
                  <Markdown>{ask}</Markdown>
                </div>
              </div>
            </div>
          )}
          <TaskQueue taskId={id} />
        </StickyScroll>
      </ChatHistory>
    </SelectionToTask>
  )
})

/** The ask card's Answer: 28px drawn, 44px to a finger (TAP_AREA). It puts the caret in the task's box. */
const ANSWER_BUTTON =
  "ml-auto inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-amber-500/45 bg-amber-500/15 px-2.5 text-xs font-semibold whitespace-nowrap text-amber-100 transition hover:bg-amber-500/25 focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none"

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
        <span className="text-[11px] text-zinc-400">
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
        className={cx(TAP_AREA, "ml-2 rounded text-[11px] text-zinc-400 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-300 hover:decoration-zinc-500 focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none")}
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

/**
 * The live line while a turn runs, in the events' column (pl-6), with no dot or colour of its own: the task's icon in
 * the header says it works. "Turn running · 2m · › 4 steps · Bash npm run typecheck": the steps since the newest line
 * unfold under it, where the newest one then is, so the line stops repeating it. A narrow line (a phone, under 24rem)
 * is two: "Turn running · 2m", then the steps and the tool, which so keeps the room to be read.
 */
function WorkingLine({ label, since, tool, steps }: { label: string; since: number | null; tool: string | null; steps: TaskMessage[] | null }) {
  const [open, setOpen] = useState(false)
  const listed = open && steps !== null
  const Chevron = listed ? ChevronDown : ChevronRight
  const summary = steps && stepsSummary(steps)
  const showTool = tool !== null && !listed
  return (
    <>
      <div data-testid="working-line" className="@container/live pt-1 pl-6 text-xs text-zinc-400">
        <div className="flex min-w-0 items-center gap-x-1.5 @max-[24rem]/live:flex-col @max-[24rem]/live:items-start @max-[24rem]/live:gap-y-0.5">
          <span className="flex shrink-0 items-center gap-1.5">
            <span>{label}</span>
            {since !== null && (
              <span data-testid="working-for">
                · <Elapsed since={since} title="Started" className="tabular-nums" />
              </span>
            )}
          </span>
          {(summary || showTool) && (
            // On its own line a finger gets a taller row, so the toggle's 44px stays clear of the lines around it.
            <span className="flex min-w-0 items-center gap-1.5 @max-[24rem]/live:max-w-full pointer-coarse:@max-[24rem]/live:min-h-8">
              {summary && (
                <>
                  <span aria-hidden className="@max-[24rem]/live:hidden">·</span>
                  <button type="button" data-testid="working-steps" aria-expanded={listed} onClick={() => setOpen((o) => !o)} className={cx(TAP_AREA, STEPS_TOGGLE, "inline-flex shrink-0 items-center gap-0.5")}>
                    <Chevron className="h-3.5 w-3.5 text-zinc-500" aria-hidden />
                    {summary.count}
                    {summary.failed > 0 && <span className="ml-1 text-red-300">· {summary.failed} failed</span>}
                  </button>
                </>
              )}
              {showTool && (
                <span data-testid="working-tool" title={tool.slice(0, 600)} className="min-w-0 truncate font-mono text-[11px]">
                  {/* Leading its own line (no steps to follow), it needs no dot. */}
                  <span aria-hidden className={cx(!summary && "@max-[24rem]/live:hidden")}>· </span>
                  {toolBrief(tool).split("\n", 1)[0]!.slice(0, 160)}
                </span>
              )}
            </span>
          )}
        </div>
      </div>
      {listed && (
        <div data-testid="working-steps-list" className="space-y-1">
          {steps.map((m) => <ToolText key={m.id} m={m} />)}
        </div>
      )}
    </>
  )
}

const stepsKey = (messages: TaskMessage[]) => `steps:${messages[0]!.id}`

/** A steps toggle's own look: plain words (its chevron says it opens), brighter under the pointer. */
const STEPS_TOGGLE = "rounded text-left hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none"

/**
 * What a run of tool messages says while closed: how many calls ("3 steps"), their first three different tools in the
 * order they ran ("Read, Grep, Edit +2"), and how many errors came back.
 */
function stepsSummary(messages: readonly TaskMessage[]): { count: string; tools: string; failed: number } {
  const names: string[] = []
  let failed = 0
  for (const m of messages) {
    if (m.meta?.error) {
      failed++
      continue
    }
    const name = typeof m.meta?.name === "string" && m.meta.name ? m.meta.name : m.content.trim().split(/\s/, 1)[0]
    if (name && !names.includes(name)) names.push(name)
  }
  // A tool's error is its own message, not a step.
  const calls = messages.length - failed || messages.length
  return { count: `${calls} ${calls === 1 ? "step" : "steps"}`, tools: names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", "), failed }
}

/**
 * Back-to-back tool calls (lib/taskThread.ts) as one closed row, "3 steps · Read, Grep, Edit": what a turn ran is there
 * to unfold (after a failed turn, say) and costs one row until then. It hangs close under the line before it, its
 * chevron in the icons' column; its words stay the same open or closed.
 */
const StepsRun = memo(
  function StepsRun({ messages }: { messages: TaskMessage[] }) {
    const [open, setOpen] = useState(false)
    const { count, tools, failed } = stepsSummary(messages)
    const Chevron = open ? ChevronDown : ChevronRight
    return (
      <div data-testid="tool-steps" data-open={open || undefined} className="space-y-1 not-first:-mt-1.5">
        <div className="flex min-w-0">
          {/* 16px of text, 28px on a touch screen (and 44px to a finger), so its tap area stays clear of the lines around it. */}
          <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={cx(TAP_AREA, STEPS_TOGGLE, "flex max-w-full min-w-11 items-center gap-2 text-xs text-zinc-400 pointer-coarse:py-1.5")}>
            <Chevron className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="shrink-0">{count}</span>
              {tools && <span className="min-w-0 truncate">· {tools}</span>}
              {failed > 0 && <span className="shrink-0 text-red-300">· {failed} failed</span>}
            </span>
          </button>
        </div>
        {open && messages.map((m) => <ToolText key={m.id} m={m} />)}
      </div>
    )
  },
  (a, b) => a.messages.length === b.messages.length && a.messages.every((m, i) => m === b.messages[i]),
)

/**
 * One tool call (the tool and what it ran or touched, on up to three lines; all it was given in its tooltip), or a
 * tool's error: all of it, in a box that scrolls past ten lines or so, since the error is what a failed turn is opened for.
 */
function ToolText({ m }: { m: TaskMessage }) {
  if (m.meta?.error)
    return (
      <div role="group" aria-label="Tool error" tabIndex={0} className={cx(TOOL_TEXT, "scroll-thin max-h-40 overflow-y-auto rounded text-red-300 focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none")}>
        ✗ {m.content}
      </div>
    )
  return <div title={m.content} className={cx(TOOL_TEXT, "line-clamp-3 text-zinc-400")}>› {toolBrief(m.content)}</div>
}

const TOOL_TEXT = "pl-6 font-mono text-[11px] whitespace-pre-wrap wrap-anywhere"

/** A plain event: small quiet text, then its time and a finished turn's timing, which wrap together or not at all. */
function EventText({ m, children }: { m: TaskMessage; children?: ReactNode }) {
  const url = typeof m.meta?.url === "string" ? m.meta.url : null
  const timing = timingOf(m.meta)
  return (
    <div data-chat-id={m.id} className="pl-6 text-xs wrap-anywhere text-zinc-400">
      {url ? (
        <AppLink href={url} className="hover:text-zinc-300 hover:underline">
          {m.content}
        </AppLink>
      ) : (
        m.content
      )}
      <span className="ml-2 text-[11px] whitespace-nowrap text-zinc-400">
        <TimeAgo ts={m.createdAt} />
        {timing && <TurnTimingChip id={timing.id} ms={timing.ms} className="ml-2 align-middle" />}
      </span>
      {children}
    </div>
  )
}

/** A sender's label starts with a capital, whatever the owner's name in Settings does. */
const capitalised = (label: string) => label.charAt(0).toUpperCase() + label.slice(1)

export const Line = memo(function Line({ m, onFollowUp, next = true }: { m: TaskMessage; onFollowUp: (message: string) => void; next?: boolean }) {
  const ownerName = useOwnerName()
  const time = (
    <span className="ml-2 text-[11px] text-zinc-400">
      <TimeAgo ts={m.createdAt} />
    </span>
  )
  switch (m.role) {
    case "user": {
      // A hook's message (server/hooks.ts) is an automation's, not Cody's: its own colour and icon.
      const hook = m.meta?.source === "hook"
      return (
        <div className={cx(MESSAGE_BLOCK, "rounded-lg border-l-2 px-3 py-2", hook ? "border-teal-500 bg-teal-500/5" : "border-yard-500 bg-yard-500/5")} data-testid={hook ? "hook-message" : undefined} aria-busy={m.meta?.pending === true || undefined}>
          <div className={cx("mb-0.5 flex items-center gap-1 text-[11px] font-semibold", hook ? "text-teal-300" : "text-yard-400")}>
            {hook && <Webhook className="h-3 w-3" />}
            {/* With no name in Settings the owner's own bubbles say "You", not "the owner". */}
            {capitalised(userMessageLabel(m.meta, ownerName === DEFAULT_OWNER_NAME ? "You" : ownerName))}
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
          {m.meta?.undelivered === true && <div className="mt-1 text-[11px] text-zinc-400">Not delivered: the task was stopped or marked done first.</div>}
          {m.meta?.deliveryUncertain === true && <div className="mt-1 text-[11px] text-zinc-400">Delivery uncertain: this may already have reached Codex. Removing it from the queue does not undo delivery.</div>}
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
      return <ToolText m={m} />
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
      if (m.meta?.kind === "subtasks") return <SubtasksLine m={m} />
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
