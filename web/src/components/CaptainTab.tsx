import { useTranscriptHistory } from "../lib/transcriptHistory"
import { HistoryNavigation } from "./HistoryNavigation"
// A project's Captain chat: the Captain's transcript as a chat, like the Coordinator panel.
// One slim header (its icon, which says its state, its name and the ⋯ menu: model, last active, context), the thread
// with task notices folded into one-line rows, and the shared Composer to message the Captain directly.
// A picked Captain is also a top-level chat: `centre` lays it out as the whole centre, like the Coordinator's.
import { Fragment, memo, useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react"
import {
  AlarmClock,
  AlertTriangle,
  Archive,
  ChevronRight,
  CirclePause,
  Clock,
  Cpu,
  Gauge,
  MoreHorizontal,
  Reply,
  Settings,
  UserRound,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react"
import {
  newClientId,
  useAgentSettings,
  useCaptainCompactions,
  useCaptainMessages,
  useCaptainState,
  useChatTurnStop,
  useSendCaptainMessage,
} from "../lib/queries"
import { firstPaintRows, useCountFromFirst, useTail } from "../lib/tail"
import { chatDays } from "../lib/chatDays"
import { ChatHistory, DayBoundary } from "./ChatHistory"
import { splitQueued } from "../lib/queued"
import { useEntityIndex } from "../lib/entities"
import { HEAD_CONTAINER, useAutoCompact } from "../lib/contextVisibility"
import { captainRows, groupLabel, parseNotice, plainText, stripFrontMatter, type CaptainNoticeItem, type CaptainRow } from "../lib/captainTranscript"
import { NOTICE_ICON } from "./noticeIcons"
import { AgentIcon, AppLink, Button, InRepo, LineIcon, Markdown, TimeAgo, cx, useRepoScope, warmMarkdown } from "./ui"
import { ChatLine, CollapsibleMarkdown, FullReplyLink } from "./ChatLine"
import { stripTruncation } from "../lib/truncated"
import { QueuedChatMessage } from "./QueuedMessages"
import { AttachmentList } from "./Attachments"
import { PickChips } from "./RunTargetMenu"
import { captainSourceOf, forwardedFromTask } from "../../../shared/captain"
import { modelLabel } from "../../../shared/usageLedger"
import { COMPOSER_FOOTER, Composer, type ComposerExtra, type ComposerHandle } from "./Composer"
import { DockComposer } from "./DockComposer"
import { ComposerIcon } from "./ChatIcons"
import { PullRequestsButton, PullRequestsMenuItem } from "./PullRequests"
import { SidebarMenuButton } from "./Sidebar"
import { CoordinatorCrumb } from "./TreeNav"
import { ProjectAvatar } from "./TaskIcon"
import { Helm } from "./ShipIcons"
import { useCaptainMark } from "./CaptainIcon"
import { SIDEBAR_INLINE, useMinWidth } from "../lib/sidebar"
import { pickProject, setChatProjectFilter } from "../lib/projectBar"
import { COORDINATOR_CHAT } from "../lib/threads"
import { useTiles } from "../lib/taskTiles"
import { CONTEXT_WARN_PCT, contextLabel, contextPct, contextTone, formatTokens } from "./ContextMeter"
import { StickyScroll, createJumpStore, type StickyScrollHandle } from "./StickyScroll"
import { SelectionToTask } from "./SelectionToTask"
import { SideThreadPane, ThreadChatProvider, ThreadMarkers, useReplyTo } from "./SideThread"
import { MESSAGE_BLOCK, MessageActions } from "./MessageActions"
import type { SelectionTaskSource } from "../lib/selectionTask"
import { DismissButton, Modal } from "./Modal"
import { PREVIEW_GROUP } from "./FileLink"
import { PublishedRow, SLIM_TITLE_LINK } from "./PublishedNotices"
import { CHAT_COLUMN, menuItem } from "./TaskHeader"
import { useOpenProjectSettings } from "../lib/projectSettings"
import { ChatName, ChatSwitcher } from "./ChatSwitcher"
import { SearchButton } from "./CommandPalette"
import { ChatControls, PanelControls } from "./ColumnControls"
import { useOpenSettings } from "./SettingsHost"
import { EmptyCaptain } from "./EmptyCaptain"
import { focusComposer, useComposerFocus } from "../lib/chatSwitch"
import { Loading } from "./Loading"
import { SpendButton } from "./SpendBreakdown"
import type { Attachment, CaptainCompaction, CaptainMessage, CaptainSource, CaptainState, Project } from "../../../shared/types"

const NO_MESSAGES: CaptainMessage[] = []

/**
 * Rows a Captain's first paint starts from, and adds while they don't fill the view (StickyScroll's `onFill`). Building
 * and laying out the newest 60 at once took half a second on a phone, so switching to a Captain whose chat was already
 * in memory still stalled before it showed. Once a chat has filled the view, first paints start from as many rows as
 * that took (lib/tail.ts firstPaintRows).
 */
export const CAPTAIN_FIRST_PAINT_ROWS = 4

/**
 * Rows added a frame at a time after that first paint, up to the newest 60. All at once, they held the main thread for
 * a quarter of a second on a phone right after a switch, so a click or a scroll then waited.
 */
export const CAPTAIN_GROW_ROWS = 8

/** Beside the chat a panel is a column (ColumnControls.tsx), so its Back is for the sheet: as a task's panel (TaskSession.tsx). */
const BACK_ON_SHEET = "@min-[35.5rem]/coord:hidden"

interface CaptainTabProps {
  project: Project
  scrollKey?: string
  centre?: boolean
  panel?: ReactNode
  /** In a side panel (OverlayHost.tsx), which leaves the header to this chat: its Back, shown where the panel is a sheet. */
  onClose?: () => void
  backLabel?: string
}

/**
 * A project's Captain chat. Everything in it is about the project, so "#12" and "PR #12" link to its repo. `centre`: it's
 * the centre (App.tsx), with `panel` (a task or Captain opened from it) beside it as the Coordinator's has. Otherwise
 * it's a side panel, and its one header is the panel's too (`onClose`).
 */
export function CaptainTab({ centre = false, ...rest }: CaptainTabProps) {
  return (
    <InRepo projectId={rest.project.id}>
      <CaptainChat centre={centre} {...rest} />
    </InRepo>
  )
}

function CaptainChat({ project, scrollKey, centre, panel: side, onClose, backLabel }: CaptainTabProps & { centre: boolean }) {
  const state = useCaptainState(project.id)
  const messages = useCaptainMessages(project.id)
  const send = useSendCaptainMessage(project.id)
  const panel = useRef<HTMLElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const handle = useRef<ComposerHandle>(null)
  const thread = useRef<StickyScrollHandle>(null)
  // With `centre`, "Jump to latest" goes in the line over the box (DockComposer.tsx), as in the Coordinator's chat.
  const jumpStore = useMemo(createJumpStore, [])
  const color = useTiles().colors.get(project.id)
  const target = useMemo(() => ({ label: `the ${project.name} Captain`, color }), [project.name, color])
  // Picked in a chat switcher: the composer takes focus.
  useComposerFocus(project.id, box)
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => setOpenGroups(new Set()), [project.id])

  // A suggested next step sends without touching the composer (no keyboard pops up on a phone).
  const followUp = useCallback(
    (text: string, attachments: Attachment[] = [], extra?: ComposerExtra) => {
      const content = text.trim()
      if (!content && !attachments.length) return
      const sending = send.mutateAsync({ id: newClientId("chat"), content, attachments, ...extra })
      sending.catch(() => {}) // onError already says so; the Composer puts the text back.
      thread.current?.scrollToEnd()
      return sending
    },
    [send.mutateAsync],
  )
  const submit = useCallback(
    (text: string, attachments: Attachment[] = [], extra?: ComposerExtra) => {
      const sending = followUp(text, attachments, extra)
      box.current?.focus()
      return sending
    },
    [followUp],
  )
  // A starter in the empty chat goes in the box to edit, never straight to the Captain.
  const fill = useCallback((text: string) => handle.current?.fill(text), [])
  const toggleGroup = useCallback(
    (id: string) =>
      setOpenGroups((prev) => {
        const next = new Set(prev)
        if (!next.delete(id)) next.add(id)
        return next
      }),
    [],
  )

  const history = useTranscriptHistory(`/api/projects/${project.id}/captain/history`, messages.data ?? NO_MESSAGES)
  const list = history.items
  // Messages sent mid-turn wait at the bottom until the turn that reads them starts.
  const { settled, queued } = useMemo(() => splitQueued(list), [list])
  // `centre` keeps the Captain's chat plain: its replies and the updates, without the tool calls between them.
  const rows = useMemo(() => captainRows(centre ? settled.filter((m) => m.role !== "tool") : settled), [settled, centre])
  const days = useMemo(() => chatDays(rows.map(firstMessage)), [rows])
  // Switching Captains (or opening one) paints just the newest rows that fill the view, then the rest of the newest 60.
  const tail = useTail(rows, project.id, { first: firstPaintRows(project.id, CAPTAIN_FIRST_PAINT_ROWS), grow: CAPTAIN_GROW_ROWS, max: 200 })
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const tailReveal = tail.reveal
  const reveal = useCallback((id: string) => {
    const row = rowsRef.current.find((r) => r.id === id || (r.type === "notices" && r.messages.some((m) => m.id === id)) || (r.type === "files" && r.group.messages.some((m) => m.id === id)))
    if (!row || !tailReveal(row.id)) return false
    if (row.type === "notices") setOpenGroups((prev) => prev.has(row.id) ? prev : new Set([...prev, row.id]))
    return true
  }, [tailReveal])
  const count = useCountFromFirst(messages.data ?? NO_MESSAGES, project.id)
  // `centre` offers next steps only under the newest reply, like the Coordinator's chat.
  const newest = useMemo(() => {
    if (!centre) return
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!
      if (r.type === "message" && r.message.role === "assistant") return r.id
    }
  }, [rows, centre])

  // Older replies aren't rendered yet: parse their markdown in idle time so loading them is quick.
  const hidden = tail.hidden
  const index = useEntityIndex()
  const repo = useRepoScope()
  useEffect(() => {
    if (hidden) warmMarkdown(rows.slice(0, hidden).flatMap((r) => (r.type === "message" && r.message.role === "assistant" ? [r.message.content] : [])), index, repo)
  }, [rows, hidden, index, repo])

  const busy = Boolean(state.data?.busy)
  const stop = useChatTurnStop(project.id, busy)
  // Selected Captain output becomes a task request to this Captain.
  const selectionSource = useMemo<SelectionTaskSource>(() => ({ kind: "captain", project: { id: project.id, name: project.name } }), [project.id, project.name])
  const lastActive = Math.max(list.at(-1)?.createdAt ?? 0, state.data?.usage.updatedAt ?? 0) || null

  return (
    <ThreadChatProvider value={project.id}>
      {/* A side panel's header is outside the section: Back and Pin/Close go by the centre's `coord`, not this chat's own. */}
      {!centre && <PanelCaptainHeader project={project} state={state.data} lastActive={lastActive} onClose={onClose} backLabel={backLabel} />}
      <section
        ref={panel}
        data-testid="captain-chat"
        data-centre={centre || undefined}
        // A `coord` container: an open side thread sits beside the chat when it's wide, over it when not.
        className={centre ? "@container/coord relative flex h-full min-w-0 bg-zinc-950" : "@container/coord relative flex min-h-0 min-w-0 flex-1 bg-zinc-950"}
      >
        <div className="relative flex min-w-0 flex-1 flex-col">
          {centre && <CentreCaptainHeader project={project} state={state.data} lastActive={lastActive} />}
          {state.data?.error && (
            <div role="alert" className="flex items-start gap-2 border-b border-red-900/50 bg-red-950/30 px-4 py-2 text-xs text-red-300">
              <LineIcon icon={AlertTriangle} className="h-3.5 w-3.5" />
              <span className="min-w-0 wrap-anywhere">{state.data.error}</span>
            </div>
          )}
          <LoopGuardLine until={state.data?.throttledUntil ?? null} />
          {/* The one line a screen reader hears about the Captain's work: always here, so a change of its text is
              announced. It names the Captain (the Coordinator's chat may be open beside this one), so the headers'
              icons don't announce too. An error has its own alert above. */}
          <span role="status" data-testid="captain-status" className="sr-only">
            {state.data?.compacting ? "The Captain is compacting its context" : busy ? "The Captain is working" : ""}
          </span>

          <SelectionToTask source={selectionSource} onPrompt={submit}>
            <ChatHistory index={history.index} days={history.days ?? days} messages={settled} reveal={reveal} ensure={history.ensure} scrollHandle={thread} projectId={project.id}>
              <StickyScroll
                handle={thread}
                count={count}
                resetKey={project.id}
                restoreKey={scrollKey ?? `captain:${project.id}`}
                hidden={tail.hidden || (history.moreBefore ? 1 : 0)}
                earlierLabel={tail.hidden ? undefined : "Show earlier messages"}
                onJump={() => { history.toLatest(); tail.reset() }}
                onLoadEarlier={tail.hidden ? tail.loadEarlier : history.earlier}
                onTrim={tail.trim}
                onFill={tail.fill}
                onFilled={tail.filled}
                growing={tail.growing}
                jumpStore={centre ? jumpStore : undefined}
                className={centre ? "chat-column py-6" : "chat-column py-4"}
                contentClassName="space-y-3"
              >
                {messages.isLoading && <Loading kind="chat" label="Loading the Captain's conversation" />}
                {list.length === 0 && !messages.isLoading && <EmptyCaptain project={project} onPick={fill} />}
                <CaptainTranscript rows={tail.visible} openGroups={openGroups} onToggle={toggleGroup} onFollowUp={followUp} centre={centre} newest={newest} />
                <HistoryNavigation newer={!!tail.later || history.moreAfter} onNewer={tail.later ? tail.loadLater : history.later} browsing={history.browsing} loading={history.loading} onLatest={history.toLatest} handle={thread} />
                {!history.browsing && busy && (
                  // Just the dots, like the Coordinator's (ChatPanel.tsx): the status line above says it in words. Still
                  // with reduced motion.
                  <div data-testid="captain-working" aria-hidden className="flex gap-1 px-1 py-2">
                    {[0, 1, 2].map((i) => (
                      <span key={i} className="h-1.5 w-1.5 rounded-full bg-zinc-500 motion-safe:animate-bounce" style={{ animationDelay: `${i * 120}ms` }} />
                    ))}
                  </div>
                )}
                {queued.map((m) => (
                  <InboundMessage key={m.id} m={m} />
                ))}
              </StickyScroll>
            </ChatHistory>
          </SelectionToTask>

          {centre ? (
            <DockComposer
              jumpStore={jumpStore}
              chat={target}
              onSubmit={submit}
              placeholder={busy ? "Queue another message for the Captain…" : `Message the ${project.name} Captain…`}
              label={`Message the ${project.name} Captain`}
              textareaRef={box}
              handleRef={handle}
              panelRef={panel}
              historyKey={`captain:${project.id}`}
              stop={stop}
              runTargetsProject={project.id}
              pullRequests
              className="chat-column overflow-hidden"
            />
          ) : (
            <Composer
              // The panel's column, as its header and transcript: a task's panel is laid out the same (TaskSession.tsx).
              className={cx(COMPOSER_FOOTER, "chat-column overflow-hidden")}
              onSubmit={submit}
              placeholder={busy ? "Queue another message for the Captain…" : `Message the ${project.name} Captain…`}
              label={`Message the ${project.name} Captain`}
              textareaRef={box}
              handleRef={handle}
              panelRef={panel}
              historyKey={`captain:${project.id}`}
              stop={stop}
              // As the centre's box (DockComposer.tsx): the Captain's icon in its project's colour, and this project's
              // pull requests (the centre may show another chat's).
              target={<ComposerIcon kind="captain" label={`Messaging ${target.label}`} color={color} projectId={project.id} />}
              runTargets
              runTargetsProject={project.id}
              tools={<PullRequestsButton projectId={project.id} />}
              toolsMenu={<PullRequestsMenuItem projectId={project.id} />}
              toolSlots={1.25}
            />
          )}
        </div>
        <SideThreadPane chat={project.id} panel={side} headerClassName={centre ? "min-h-14" : undefined} />
      </section>
    </ThreadChatProvider>
  )
}

/**
 * The loop guard is holding task updates back (CaptainState.throttledUntil): the chat says so and until when, so a
 * quiet Captain isn't taken for a stuck one. Nothing is dropped. The line goes when the hold ends.
 */
function LoopGuardLine({ until }: { until: number | null }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!until) return
    setNow(Date.now())
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, until - Date.now()) + 250)
    return () => clearTimeout(timer)
  }, [until])
  if (!until || until <= now) return null
  return (
    <div role="status" data-testid="captain-loop-guard" className="flex items-start gap-2 border-b border-amber-900/40 bg-amber-950/30 px-4 py-2 text-xs text-amber-200">
      <LineIcon icon={CirclePause} className="h-3.5 w-3.5" />
      <span className="min-w-0 wrap-anywhere">
        Loop guard: task updates are held until <time dateTime={new Date(until).toISOString()}>{new Date(until).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</time>, then delivered together.
      </span>
    </div>
  )
}

const firstMessage = (row: CaptainRow): CaptainMessage => row.type === "files" ? row.group.messages[0]! : row.type === "notices" ? row.messages[0]! : row.message

/** Header/context updates leave the transcript and its day boundaries alone. */
const CaptainTranscript = memo(function CaptainTranscript({ rows, openGroups, onToggle, onFollowUp, centre, newest }: {
  rows: CaptainRow[]
  openGroups: ReadonlySet<string>
  onToggle: (id: string) => void
  onFollowUp: (message: string) => void
  centre: boolean
  newest?: string
}) {
  return rows.map((row, i) => (
    <Fragment key={row.id}>
      <DayBoundary at={firstMessage(row).createdAt} previousAt={i ? firstMessage(rows[i - 1]!).createdAt : undefined} messageId={row.id} />
      <Row row={row} open={openGroups.has(row.id)} onToggle={onToggle} onFollowUp={onFollowUp} next={!centre || row.id === newest} />
    </Fragment>
  ))
})

const Row = memo(function Row({
  row,
  open,
  onToggle,
  onFollowUp,
  next,
}: {
  row: CaptainRow
  open: boolean
  onToggle: (id: string) => void
  onFollowUp: (message: string) => void
  /** Whether a reply shows its suggested next steps. */
  next: boolean
}) {
  if (row.type === "message")
    return row.message.role === "user" ? (
      // Like a ChatLine: named for a side thread on it, with its threads under it.
      <div data-chat-id={row.message.id}>
        <InboundMessage m={row.message} />
        <ThreadMarkers m={row.message} />
      </div>
    ) : (
      <ChatLine m={row.message} onFollowUp={onFollowUp} next={next} />
    )
  if (row.type === "notice") return <NoticeRow m={row.message} />
  if (row.type === "files") return <PublishedRow group={row.group} />
  return <NoticeGroup id={row.id} items={row.items} messages={row.messages} open={open} onToggle={onToggle} />
})

const INBOUND: Record<CaptainSource, { label: string; icon: LucideIcon; box: string; head: string }> = {
  cody: { label: "You", icon: UserRound, box: "rounded-br-md bg-yard-500/15", head: "text-yard-300" },
  coordinator: { label: "From Coordinator", icon: Helm, box: "rounded-bl-md border border-sky-500/25 bg-sky-500/5", head: "text-sky-300" },
  schedule: { label: "Scheduled", icon: AlarmClock, box: "rounded-bl-md border border-violet-500/25 bg-violet-500/5", head: "text-violet-300" },
  hook: { label: "Hook", icon: Webhook, box: "rounded-bl-md border border-teal-500/25 bg-teal-500/5", head: "text-teal-300" },
  agent: { label: "From task", icon: Users, box: "rounded-bl-md border border-amber-500/25 bg-amber-500/5", head: "text-amber-300" },
}

/** A chip in a message's header: what the sender expects, in words. */
const HEAD_CHIP = "shrink-0 rounded px-1 font-normal tracking-normal normal-case"
/**
 * A message's header: the sender's icon and name, what follows it, then the time. A grid, so the time always ends the
 * first line: where there's no room the name truncates instead (a 320px phone at 125% zoom).
 */
const HEAD = "mb-1 grid grid-cols-[auto_minmax(0,auto)_minmax(0,1fr)_auto] items-center gap-x-1.5 gap-y-0.5 text-[11px] font-semibold tracking-wide uppercase"
/**
 * What follows the sender in a message's header: the task it's from and its chips. On the header's line where the row
 * is wide; in a narrow row (a phone: the row's own `@container`) on a second line, at the bubble's whole width.
 */
const HEAD_DETAIL = "flex min-w-0 items-center gap-x-1.5 gap-y-0.5 @max-xl:col-span-full @max-xl:row-start-2 @max-xl:flex-wrap"
/** A task's title there: one truncated line beside the rest, all of it on the line of its own. */
const HEAD_TITLE = "min-w-0 truncate tracking-normal normal-case @max-xl:whitespace-normal @max-xl:wrap-anywhere"
/** Its link is 44px tall to a finger (a 16px line and 14px each side): padding that its own negative margin takes back, so the header's lines stay put. */
const HEAD_LINK = "hover:underline pointer-coarse:-my-3.5 pointer-coarse:py-3.5"

/** The task an agent's message_captain came from (its title links to it), and whether the agent waited for a reply. */
function AgentSource({ meta }: { meta: CaptainMessage["meta"] }) {
  const taskId = typeof meta?.taskId === "string" ? meta.taskId : null
  const title = typeof meta?.taskTitle === "string" && meta.taskTitle.trim() ? meta.taskTitle : (taskId ?? "unknown task")
  const wait = typeof meta?.waitSeconds === "number" ? meta.waitSeconds : 0
  const held = typeof meta?.heldUntil === "number"
  return (
    <span className={HEAD_DETAIL}>
      {taskId ? (
        <AppLink href={`/tasks/${taskId}`} className={cx(HEAD_TITLE, HEAD_LINK, "font-semibold")}>
          {title}
        </AppLink>
      ) : (
        <span className={HEAD_TITLE}>{title}</span>
      )}
      {(held || wait > 0) && <span className={cx(HEAD_CHIP, "bg-amber-500/15")}>{held ? "held by the loop guard" : `waited up to ${wait}s for a reply`}</span>}
    </span>
  )
}

/** A message to the Captain, labelled by who sent it: Cody (right), the Coordinator or a schedule (left). Long ones fold. */
export const InboundMessage = memo(function InboundMessage({ m }: { m: CaptainMessage }) {
  const source = captainSourceOf(m)
  const s = INBOUND[source]
  const Icon = s.icon
  // The Coordinator's ask_captain waits for the answer; which tool sent a message is otherwise no one's business here.
  const asks = source === "coordinator" && m.meta?.tool === "ask_captain"
  // Cody's message from a task's chat (TaskManager.forwardToCaptain): the task it's about.
  const via = source === "cody" ? forwardedFromTask(m.meta) : null
  const detail =
    source === "agent" ? (
      <AgentSource meta={m.meta} />
    ) : via ? (
      <span className={HEAD_DETAIL}>
        <AppLink href={`/tasks/${via.taskId}`} data-testid="captain-via-task" className={cx(HEAD_TITLE, HEAD_LINK, "font-normal")}>
          <span className="@max-xl:hidden">· </span>from {via.taskTitle}
        </AppLink>
      </span>
    ) : asks ? (
      <span className={HEAD_DETAIL}>
        <span className={cx(HEAD_CHIP, "bg-sky-500/15")}>wants a reply</span>
      </span>
    ) : null
  const bubble = (
    <div className={cx(MESSAGE_BLOCK, "max-w-[85%] min-w-0 rounded-2xl px-3 py-2 text-sm text-zinc-100 @max-[14rem]:max-w-full", s.box)} aria-busy={m.meta?.pending === true || undefined}>
      <div className={cx(HEAD, s.head)}>
        <Icon className="h-3 w-3" aria-hidden />
        <span className="min-w-0 truncate">{source === "hook" && typeof m.meta?.hookName === "string" ? `Hook: ${m.meta.hookName}` : s.label}</span>
        {detail}
        <span className="col-start-4 row-start-1 pl-2 font-normal tracking-normal whitespace-nowrap normal-case text-zinc-500">
          <TimeAgo ts={m.createdAt} />
        </span>
      </div>
      {m.content && <CollapsibleMarkdown>{m.content}</CollapsibleMarkdown>}
      <AttachmentList files={m.meta?.attachments} />
      <PickChips meta={m.meta} />
      {!m.meta?.pending && m.meta?.queued !== true && <MessageActions text={m.content} anchorId={m.id} />}
    </div>
  )
  // Queued (sent mid-turn): the bubble, then the Queued label with Edit and Delete under it.
  const queued = m.meta?.queued === true
  return (
    <div
      id={`captain-${m.id}`}
      data-testid="captain-inbound"
      data-source={source}
      // Its own container: the bubble's header takes a second line by the row's width, not the window's.
      className={cx("@container flex", queued && "flex-col gap-1", source === "cody" && (queued ? "items-end" : "justify-end"))}
    >
      {queued ? (
        <QueuedChatMessage m={m} projectId={m.projectId} who="the Captain">
          {bubble}
        </QueuedChatMessage>
      ) : (
        bubble
      )}
    </div>
  )
})

/**
 * One task notice: status icon, linked task title, a plain summary and the time. Its icon is the button that shows all
 * of it, and a click on the row's text does the same; its links stay beside the button, never inside one. A wide row is
 * one line, title first; in a narrow one (its own `@container`, not the window) or once opened, the whole title gets
 * its own row and the summary and time go under it. Reply (MessageActions) is the hover toolbar with a mouse; on touch
 * it's a button in the opened row, so a tap on a row never moves the rows under the finger.
 */
const NoticeRow = memo(function NoticeRow({ m }: { m: CaptainMessage }) {
  const [full, setFull] = useState(false)
  const replyTo = useReplyTo()
  const n = useMemo(() => parseNotice(m.content, m.meta), [m.content, m.meta])
  const taskId = typeof m.meta?.taskId === "string" ? m.meta.taskId : null
  const { icon: Icon, className, label } = NOTICE_ICON[n.kind]
  const toggle = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("a, button")) return
    setFull((v) => !v)
  }
  // The summary answers a tap itself, so a finger that lands on it isn't snapped to the title's link beside it; the
  // row's own handler must not then toggle it back.
  const toggleSummary = (e: MouseEvent) => {
    e.stopPropagation()
    toggle(e)
  }
  // One line (title · summary · time) only for a collapsed row with a title in a wide row.
  const inline = Boolean(n.title) && !full
  // Collapsed: one line, or two under the title in a narrow row.
  const text = full ? "whitespace-normal wrap-anywhere" : "truncate @max-md:line-clamp-2 @max-md:whitespace-normal @max-md:wrap-anywhere"
  return (
    <div
      id={`captain-${m.id}`}
      title={full ? undefined : plainText(stripTruncation(m.content).text)}
      onClick={toggle}
      className={cx(
        // MessageActions' hover group and positioning box, without MESSAGE_BLOCK's room for a tapped toolbar.
        "group/msg relative",
        // 44px to a finger: a 16px line and 14px above and under it. The button's focus ring goes round the row.
        "flex min-w-0 cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-xs text-zinc-500 hover:bg-zinc-900/60 has-[>button:focus-visible]:ring-2 has-[>button:focus-visible]:ring-yard-500/40 pointer-coarse:min-h-11 pointer-coarse:py-3.5",
      )}
      {...PREVIEW_GROUP}
    >
      <button
        type="button"
        aria-expanded={full}
        aria-label={`${label}: show the whole update`}
        onClick={() => setFull((v) => !v)}
        // The row's left end is its target: from the row's edge to the text, as tall as the row.
        className="relative flex h-lh shrink-0 items-center rounded focus-visible:outline-none after:absolute after:-inset-x-2 after:top-1/2 after:h-7 after:-translate-y-1/2 pointer-coarse:after:h-11"
      >
        <Icon className={cx("h-3.5 w-3.5", className)} aria-hidden />
      </button>
      <div className="@container min-w-0 flex-1">
        <div className={cx("grid grid-cols-[minmax(0,1fr)_auto] gap-x-2", inline && "@md:grid-cols-[minmax(0,max-content)_minmax(0,1fr)_auto]")}>
          {n.title && (
            <div data-testid="notice-title" className={cx("col-span-2 wrap-anywhere", inline && "@md:col-span-1 @md:truncate")}>
              {taskId ? (
                <AppLink href={`/tasks/${taskId}`} className={SLIM_TITLE_LINK}>
                  {n.title}
                </AppLink>
              ) : (
                <span className="font-medium text-zinc-200">{n.title}</span>
              )}
            </div>
          )}
          <div data-testid="notice-meta" onClick={toggleSummary} className={text}>
            {inline && n.summary.length > 0 && <span className="text-zinc-600 @max-md:hidden">· </span>}
            {n.summary.map((s, i) =>
              "href" in s ? (
                <AppLink key={i} href={s.href} className="text-yard-400 hover:underline">
                  {s.label}
                </AppLink>
              ) : (
                <span key={i}>{s.text}</span>
              ),
            )}
            {n.truncated && taskId && <FullReplyLink taskId={taskId} />}
          </div>
          <span className="text-right text-[11px] text-zinc-600">
            <TimeAgo ts={m.createdAt} />
          </span>
        </div>
        {full && replyTo && (
          <button
            type="button"
            data-testid="notice-reply"
            aria-label="Reply in a thread"
            onClick={(e) => {
              e.stopPropagation()
              replyTo(m.id, m.content)
            }}
            // Its 44px ends where the row does: under its label there's only the row's own 14px.
            className="mt-1 -mb-1.5 -ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-yard-500/50 focus-visible:outline-none pointer-coarse:-mb-3.5 pointer-fine:hidden"
          >
            <Reply className="h-4 w-4" aria-hidden />
            Reply
          </button>
        )}
      </div>
      <MessageActions text={m.content} anchorId={m.id} className="pointer-coarse:hidden" />
    </div>
  )
})

/**
 * Consecutive notices folded into "4 task updates", with their icons and titles as a preview: the first title and how
 * many more. A wide row is one line; a narrow one (its own `@container`) has the whole title on a second line, under
 * the label, never a stub of it; the narrowest (a 320px phone at 125% zoom) leaves out the time, which each row has.
 */
const NoticeGroup = memo(function NoticeGroup({
  id,
  items,
  messages,
  open,
  onToggle,
}: {
  id: string
  items: CaptainNoticeItem[]
  messages: CaptainMessage[]
  open: boolean
  onToggle: (id: string) => void
}) {
  const parsed = useMemo(() => messages.map((m) => parseNotice(m.content, m.meta)), [messages])
  const kinds = [...new Set(parsed.map((p) => p.kind))].slice(0, 4)
  const titles = [...new Set(parsed.flatMap((p) => (p.title ? [p.title] : [])))]
  const last = messages.at(-1)!
  return (
    <div data-testid="notice-group" className="@container/group rounded-lg border border-zinc-900 bg-zinc-900/20">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(id)}
        className="grid w-full min-w-0 grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 rounded-lg px-2 py-1.5 text-left text-xs text-zinc-500 hover:bg-zinc-900/60 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none pointer-coarse:min-h-11 @[26rem]/group:grid-cols-[auto_auto_auto_minmax(0,1fr)_auto]"
      >
        <ChevronRight className={cx("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="flex shrink-0 gap-0.5">
          {kinds.map((k) => {
            const { icon: Icon, className } = NOTICE_ICON[k]
            return <Icon key={k} className={cx("h-3.5 w-3.5", className)} />
          })}
        </span>
        <span className="min-w-0 font-medium text-zinc-300">{groupLabel(messages, items.length)}</span>
        {titles.length > 0 && (
          // Wide: on the label's line, cut where the row ends, and the count is never what's cut. Narrow: all of it on
          // the second line, from the label's left edge to the row's end; from the icons' in the narrowest (a 320px phone).
          <span
            data-testid="notice-group-titles"
            className="col-span-2 col-start-3 row-start-2 min-w-0 wrap-anywhere text-zinc-600 @max-[20rem]/group:col-span-3 @max-[20rem]/group:col-start-2 @[26rem]/group:col-span-1 @[26rem]/group:col-start-4 @[26rem]/group:row-start-1 @[26rem]/group:flex"
          >
            <span className="@[26rem]/group:min-w-0 @[26rem]/group:truncate">
              <span className="@max-[26rem]/group:hidden">· </span>
              {titles[0]}
            </span>
            {titles.length > 1 && <span className="shrink-0 whitespace-pre"> +{titles.length - 1}</span>}
          </span>
        )}
        <span className="col-start-4 row-start-1 pl-1 text-right text-[11px] whitespace-nowrap text-zinc-600 @max-[14.5rem]/group:hidden @[26rem]/group:col-start-5">
          <TimeAgo ts={last.createdAt} />
        </span>
      </button>
      {open && (
        <div className="space-y-0.5 border-t border-zinc-900 px-1 py-1">
          {items.map((item) => (item.type === "files" ? <PublishedRow key={item.id} group={item.group} /> : <NoticeRow key={item.id} m={item.message} />))}
        </div>
      )}
    </div>
  )
})

interface MeterProps {
  tokens: number | null
  window: number | null
  compacting: boolean
  /** A compaction is waiting for the current turn to end. */
  queued: boolean
}

/** The Captain's model as the pickers name it ("Opus 5.5 · high effort"), and its context reading unless auto-compact makes it moot. */
function useCaptainMeter(state: CaptainState | undefined) {
  const settings = useAgentSettings().data?.settings
  // Every Captain runs on one CLI, each with a model of its own; Codex's may be empty (its own default).
  const codex = settings?.captainCli === "codex"
  const id = (codex ? settings?.captainCodexModel : settings?.captainModel)?.trim()
  const model = settings ? `${id ? modelLabel(id) : codex ? "Codex's default model" : "Default model"} · ${settings.captainEffort} effort` : null
  // Captains compact on the Coordinator's auto-compact setting; the meter is only a reading.
  const autoCompact = useAutoCompact("coordinator")
  const meter: MeterProps | null = autoCompact ? null : {
    tokens: state?.usage.tokens ?? null,
    window: state?.usage.window ?? null,
    compacting: state?.compacting ?? false,
    queued: Boolean(state?.compactQueued),
  }
  return { model, meter }
}

/**
 * "<project> Captain" in a header. The project's name comes first and is only cut when it alone doesn't fit; " Captain"
 * shows whole or not at all (it wraps to a second line, which the one-line box clips), never as "Ca…". Still read out.
 */
function CaptainName({ name }: { name: string }) {
  return (
    <span className="flex h-lh min-w-0 flex-wrap overflow-hidden">
      <span className="min-w-0 truncate">{name}</span>
      <span className="shrink-0 whitespace-pre"> Captain</span>
    </span>
  )
}

/**
 * The centre's header for a Captain, laid out like the Coordinator's (ChatPanel): on a phone the sidebar's menu
 * button and the Coordinator's crumb, then its icon in its project's colour (it pulses while the Captain works: no
 * status word) and its name (where the sidebar is a column, the name opens the chat switcher; on a phone ☰ switches),
 * and on a phone 🔍; its ⋯ menu as in the panel.
 */
function CentreCaptainHeader({ project, state, lastActive }: { project: Project; state: CaptainState | undefined; lastActive: number | null }) {
  const { model, meter } = useCaptainMeter(state)
  const sidebarInline = useMinWidth(SIDEBAR_INLINE)
  const color = useTiles().colors.get(project.id)
  // Its icon is the project's image when it has one and picks no icon: the name doesn't show it a second time.
  const imageMark = useCaptainMark(project.id).kind === "image"
  // The switcher's pick stays in the centre: another Captain, or back to the Coordinator, with its box focused.
  const pick = useCallback((chat: string) => {
    if (chat === COORDINATOR_CHAT) setChatProjectFilter(null)
    else pickProject(chat)
    focusComposer(chat)
    return true
  }, [])
  return (
    <div className={HEAD_CONTAINER}>
      <header className="@container chat-column flex min-h-14 flex-col justify-center border-b border-zinc-900 pt-[env(safe-area-inset-top)] sm:overflow-hidden sm:pt-[max(0.5rem,env(safe-area-inset-top))] [&_button]:min-h-11 [&_button]:min-w-11">
        <div className="flex min-w-0 items-center gap-2">
          {!sidebarInline && <SidebarMenuButton />}
          {/* On a phone, the Coordinator is one tap up from here (TreeNav.tsx). Under 280px (a 320px phone at 125% zoom)
              the crumb gives its room to the project's name; ☰ still reaches the Coordinator. */}
          {!sidebarInline && <CoordinatorCrumb className="@max-[17.5rem]:hidden" />}
          <AgentIcon busy={Boolean(state?.busy)} compacting={Boolean(state?.compacting)} error={Boolean(state?.error)} color={color} projectId={project.id} announce={false} />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <ChatName current={project.id} onPick={pick}>
              {/* Which Captain matters more than the word, so a narrow header keeps the project's name. */}
              <span data-testid="chat-title" className="flex min-w-0 items-center gap-1.5">
                <ProjectAvatar src={imageMark ? null : project.iconUrl} className="h-4 w-4 rounded-[4px]" />
                <CaptainName name={project.name} />
              </span>
            </ChatName>
          </div>
          {/* Context readings stay out of the header, as in the Coordinator's: the meter is in ⋯, which shows the percentage when it's nearly full. */}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {!sidebarInline && <SearchButton />}
            <SpendButton scope={{ kind: "captain", projectId: project.id, name: project.name, version: String(lastActive ?? "") }} />
            <CaptainMenu project={project} meter={meter} model={model} lastActive={lastActive} />
            <ChatControls name={`the ${project.name} Captain`} />
          </div>
        </div>
      </header>
    </div>
  )
}

/**
 * A side panel's one header, which is the panel's too (OverlayHost.tsx draws none over it): Back where the panel is a
 * sheet, the Captain's icon (which says its state), "<project> Captain" (it opens the chat switcher: the Coordinator,
 * then every project's Captain), ⋯ (model, last active and the context meter; it shows the percentage when the context
 * is nearly full), then Pin and Close beside the chat. A task's panel header's height and column (TaskHeader.tsx), so
 * the two line up.
 */
function PanelCaptainHeader({ project, state, lastActive, onClose, backLabel }: { project: Project; state: CaptainState | undefined; lastActive: number | null; onClose?: () => void; backLabel?: string }) {
  const { model, meter } = useCaptainMeter(state)
  const color = useTiles().colors.get(project.id)
  const imageMark = useCaptainMark(project.id).kind === "image"
  return (
    <header data-testid="captain-panel-header" className={cx(HEAD_CONTAINER, "shrink-0 border-b border-zinc-900")}>
      <div className={cx(CHAT_COLUMN, "flex min-h-[calc(3.5rem-1px)] items-center gap-2 pt-[env(safe-area-inset-top)] [&_button]:min-h-11 [&_button]:min-w-11")}>
        {onClose && <DismissButton kind="back" label={backLabel} onClick={onClose} className={cx("-ml-3", BACK_ON_SHEET)} />}
        <AgentIcon busy={Boolean(state?.busy)} compacting={Boolean(state?.compacting)} error={Boolean(state?.error)} color={color} projectId={project.id} announce={false} />
        <div className="flex min-w-0 flex-1 items-center">
          <ChatSwitcher current={project.id}>
            <span className="flex min-w-0 items-center gap-1.5">
              <ProjectAvatar src={imageMark ? null : project.iconUrl} className="h-4 w-4 rounded-[4px]" />
              <CaptainName name={project.name} />
            </span>
          </ChatSwitcher>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <SpendButton scope={{ kind: "captain", projectId: project.id, name: project.name, version: String(lastActive ?? "") }} />
          <CaptainMenu project={project} meter={meter} model={model} lastActive={lastActive} />
          <PanelControls name={`${project.name} Captain`} />
        </div>
      </div>
    </header>
  )
}

/** A fact's row in ⋯: its icon, its name, then what it is. The names share a column. */
const FACT = "flex gap-2 px-2 py-1.5 text-sm"
const FACT_NAME = "w-20 shrink-0 text-zinc-500"
const FACT_ICON = "h-3.5 w-3.5 text-zinc-500"

/** "Context 142k / 200k · 71%" over a bar as wide as the sheet, with the compaction's state. A reading, not a control. */
function ContextFact({ tokens, window, compacting, queued }: MeterProps) {
  const pct = contextPct(tokens, window)
  const bar = pct === null ? "bg-zinc-600" : pct >= CONTEXT_WARN_PCT ? contextTone(pct).bar : "bg-yard-500"
  return (
    <div data-testid="context-meter" title="How much of the Captain's context window is used." className={cx(FACT, "items-start")}>
      <LineIcon icon={Gauge} className={FACT_ICON} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className={FACT_NAME}>Context</span>
          <span className="min-w-0 wrap-anywhere text-zinc-300 tabular-nums">{tokens === null ? "Not measured yet" : contextLabel(tokens, window)}</span>
          {(compacting || queued) && (
            <span role="status" className="ml-auto text-xs text-zinc-400">
              {compacting ? "Compacting…" : "Compact queued"}
            </span>
          )}
        </div>
        <div aria-hidden className="mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-800">
          <div className={cx("h-full rounded-full", bar)} style={{ width: `${pct ?? 0}%` }} />
        </div>
      </div>
    </div>
  )
}

/**
 * ⋯: the Captain's model (it opens Settings, where every Captain's is picked), last activity and context, then
 * Project settings and compaction history. The header has no meter: with auto-compact off (a `meter`), from where the
 * sheet's bar changes colour the button shows the percentage beside ⋯ in the bar's tone, and its name and tooltip say
 * it. A sheet like the task header's ⓘ (a Modal portalled to the body), so the header's overflow can't clip it.
 */
function CaptainMenu({ project, meter, model, lastActive }: { project: Project; meter: MeterProps | null; model: string | null; lastActive: number | null }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const openProjectSettings = useOpenProjectSettings()
  const openSettings = useOpenSettings()
  const [history, setHistory] = useState(false)
  const compactions = useCaptainCompactions(project.id)
  const count = compactions.data?.length ?? 0
  const facts = Boolean(model || lastActive || meter)
  const modelHint = useId()
  const pct = meter ? contextPct(meter.tokens, meter.window) : null
  const cue = pct !== null && pct >= CONTEXT_WARN_PCT
  const tone = cue ? contextTone(pct).text : undefined
  // What opens next takes ⋯ as the place focus returns to, not the row that's about to go.
  const then = (next: () => void) => () => {
    trigger.current?.focus()
    setOpen(false)
    next()
  }
  return (
    <>
      <Button
        ref={trigger}
        size="sm"
        variant="ghost"
        className="px-1.5"
        aria-label={`${project.name} Captain menu${cue ? `, context ${pct}% used` : ""}`}
        title={cue ? `Context ${pct}% used` : "More"}
        data-context-cue={cue || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {cue && <span className={cx("text-xs tabular-nums", tone)}>{pct}%</span>}
        <MoreHorizontal className={cx("h-4 w-4", tone)} />
      </Button>
      {open && (
        <Modal
          title={`${project.name} Captain`}
          size="sm"
          placement="sheet"
          onClose={() => setOpen(false)}
          bodyClassName={cx(
            "scroll-thin min-h-0 flex-1 overflow-y-auto p-3 text-sm [&_button]:min-h-11",
            // "Last active" says exactly when on a tap: 44px to a finger, as in a task's details.
            "[&_time[role=button]]:inline-flex [&_time[role=button]]:min-h-11 [&_time[role=button]]:min-w-11 [&_time[role=button]]:items-center [&_time[role=button]]:whitespace-nowrap",
          )}
        >
          {facts && (
            <div className="pb-1.5">
              {model && (
                <button
                  type="button"
                  className={menuItem}
                  onClick={then(() => openSettings("orchestrator"))}
                  data-testid="captain-model"
                  aria-label={`Model ${model.replace(" · ", ", ")}. Opens Settings`}
                  aria-describedby={modelHint}
                >
                  {/* Its icon sits on the "Model" line, as the Context row's does; the chevron stays at the row's middle. */}
                  <LineIcon icon={Cpu} className={FACT_ICON} box="self-start" />
                  {/* The hint starts where the value does: under it, in the names' second column. A box too narrow
                      for two columns (a 320px phone at 125% zoom) stacks them from its left edge. */}
                  <span className="@container min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2 @[13rem]:grid @[13rem]:grid-cols-[5rem_minmax(0,1fr)]">
                      <span className={FACT_NAME}>Model</span>
                      <span className="min-w-0 wrap-anywhere">{model}</span>
                      <span id={modelHint} className="basis-full text-xs text-zinc-500 @[13rem]:col-start-2">
                        Shared by every Captain.
                      </span>
                    </span>
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" aria-hidden />
                </button>
              )}
              {lastActive && (
                <div className={cx(FACT, "items-center")}>
                  <Clock className={cx(FACT_ICON, "shrink-0")} aria-hidden />
                  <span className={FACT_NAME}>Last active</span>
                  <span className="text-zinc-300">
                    <TimeAgo ts={lastActive} />
                  </span>
                </div>
              )}
              {meter && <ContextFact {...meter} />}
            </div>
          )}
          <div className={cx("space-y-0.5", facts && "border-t border-zinc-800/80 pt-1.5")}>
            <button type="button" className={menuItem} onClick={then(() => openProjectSettings(project.id))} data-testid="captain-project-settings">
              <Settings className="h-3.5 w-3.5 text-zinc-500" />
              <span className="flex-1">Project settings</span>
            </button>
            <button
              type="button"
              className={cx(menuItem, "disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent")}
              disabled={count === 0}
              onClick={then(() => setHistory(true))}
            >
              <Archive className="h-3.5 w-3.5 text-zinc-500" />
              <span className="flex-1">{count === 0 ? "No compactions yet" : "Compaction history"}</span>
              {count > 0 && <span className="rounded-full bg-zinc-800 px-1.5 text-[11px] text-zinc-400 tabular-nums">{count}</span>}
            </button>
          </div>
        </Modal>
      )}
      {history && <CompactionHistory compactions={compactions.data ?? []} onClose={() => setHistory(false)} />}
    </>
  )
}

/** The Captain's compaction summaries, newest first; the newest is open. */
function CompactionHistory({ compactions, onClose }: { compactions: CaptainCompaction[]; onClose: () => void }) {
  const list = useMemo(() => [...compactions].reverse(), [compactions])
  const [openFile, setOpenFile] = useState<string | null>(list[0]?.file ?? null)
  return (
    <Modal onClose={onClose} size="xl" title="Captain compaction history" description="What the Captain wrote down each time its context filled up. Newest first.">
      {list.length === 0 ? (
        <p className="text-sm text-zinc-500">No compactions yet.</p>
      ) : (
        <ol className="space-y-2">
          {list.map((c) => {
            const open = openFile === c.file
            return (
              // Its own container: a narrow row (a phone) is two lines, the date and how it started, then when and how much.
              <li key={c.file} className="@container rounded-xl border border-zinc-800 bg-zinc-900/30">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenFile(open ? null : c.file)}
                  className="flex min-h-11 w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-zinc-900/60 focus-visible:ring-2 focus-visible:ring-yard-500/40 focus-visible:outline-none"
                >
                  <LineIcon icon={ChevronRight} className={cx("h-3.5 w-3.5 text-zinc-500 transition-transform", open && "rotate-90")} />
                  <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 @lg:flex">
                    <span className="min-w-0 truncate text-zinc-200 @lg:shrink-0">{new Date(c.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400 @lg:order-last @lg:shrink-0">{c.trigger === "auto" ? "Automatic" : "Manual"}</span>
                    <span className="col-span-2 min-w-0 text-xs text-zinc-500 tabular-nums @lg:flex-1 @lg:truncate">
                      <TimeAgo ts={c.at} />
                      {/* How much it freed, when both ends were measured. */}
                      {c.tokensBefore !== null && c.tokensAfter !== null && ` · ${formatTokens(c.tokensBefore)} → ${formatTokens(c.tokensAfter)} tokens`}
                    </span>
                  </span>
                </button>
                {open && (
                  <div className="border-t border-zinc-800 px-4 py-3 text-sm text-zinc-300">
                    <Markdown>{stripFrontMatter(c.content)}</Markdown>
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </Modal>
  )
}
