import { useTranscriptHistory } from "../lib/transcriptHistory"
import { HistoryNavigation } from "./HistoryNavigation"
import { memo, useCallback, useEffect, useMemo, useRef, type ReactNode } from "react"
import { useLocation } from "wouter"
import {
  newClientId,
  useChat,
  useChatBusy,
  useChatTurnStop,
  useChatStream,
  useProjects,
  useSendChat,
  useTask,
} from "../lib/queries"
import { REVEAL_CHAT_EVENT } from "../lib/reveal"
import { chatDays } from "../lib/chatDays"
import { firstPaintRows, useTail } from "../lib/tail"
import { setOpen } from "../lib/chipState"
import { itemMessages, rowFirstMessage, rowHolding } from "../lib/chatUpdates"
import { splitQueued } from "../lib/queued"
import { AgentIcon, InRepo, Markdown, cx, warmMarkdown } from "./ui"
import { MENTIONS } from "../lib/linkify"
import { useEntityIndex } from "../lib/entities"
import { StickyScroll, createJumpStore, type StickyScrollHandle } from "./StickyScroll"
import { ChatHistory } from "./ChatHistory"
import { type ComposerExtra, type ComposerHandle } from "./Composer"
import { DockComposer, type ChatTarget } from "./DockComposer"
import { useOpenSettings } from "./SettingsHost"
import { ChatName } from "./ChatSwitcher"
import { SearchButton } from "./CommandPalette"
import { focusComposer, useComposerFocus } from "../lib/chatSwitch"
import { VoiceControl } from "./VoiceControl"
import { CloudMeter, useShowCloudMeter } from "./CloudMeter"
import { ChatLine } from "./ChatLine"
import { CoordinatorTranscript, useCoordinatorRows, usePlainRows } from "./UpdateChips"
import { SelectionToTask } from "./SelectionToTask"
import { SideThreadPane, ThreadChatProvider } from "./SideThread"
import { SidebarMenuButton } from "./Sidebar"
import { ChatControls } from "./ColumnControls"
import { SIDEBAR_INLINE, useMinWidth } from "../lib/sidebar"
import { pickProject, setChatProjectFilter } from "../lib/projectBar"
import { CAPTAIN_FIRST_PAINT_ROWS, CAPTAIN_GROW_ROWS } from "./CaptainTab"
import { COORDINATOR_CHAT } from "../lib/threads"
import { projectContext, type SelectionTaskSource } from "../lib/selectionTask"
import { HEAD_CONTAINER } from "../lib/contextVisibility"
import { SetupCard, SetupReminder, setSetupSkipped, useSetupNeeded, useSetupSkipped } from "./Setup"
import { TryFirst, markTryFirstDone, useTryFirstDone } from "./TryFirst"
import { Loading } from "./Loading"
import type { Attachment, ChatMessage } from "../../../shared/types"

const NO_MESSAGES: ChatMessage[] = []
/** The box always talks to the Coordinator: a picked Captain takes the centre with its own (CaptainTab.tsx). */
const COORDINATOR_TARGET: ChatTarget = { label: "the Coordinator" }

/**
 * The transcript opens like a Captain's (CaptainTab.tsx): its first paint has the rows that fill the view, and the
 * rest of the newest 60 follow a few a frame. On a fresh launch, building all 60 in one go (every reply's Markdown
 * parsed for the first time) held a phone's main thread for half a second, so a tap on a Captain waited behind it.
 */
const tailOptions = () => ({ first: firstPaintRows("chat", CAPTAIN_FIRST_PAINT_ROWS), grow: CAPTAIN_GROW_ROWS })

/** A chat switcher pick: a project's Captain takes the centre (App.tsx), the Coordinator brings this chat back. */
function pickHere(chat: string) {
  if (chat === COORDINATOR_CHAT) setChatProjectFilter(null)
  else pickProject(chat)
  focusComposer(chat)
  return true
}

/**
 * The Coordinator's chat, the whole window's centre: every row shares one centered column (`.chat-column` in
 * styles.css), and the header keeps navigation and voice within reach. It's a plain transcript (CoordinatorTranscript):
 * progress is in the sidebar, and a picked Captain takes the whole centre (App renders its CaptainTab instead).
 * `conversation` is the panel App opens beside it.
 */
export const ChatPanel = memo(function ChatPanel({ conversation }: { conversation?: ReactNode }) {
  const chat = useChat()
  const busy = useChatBusy()
  const send = useSendChat()
  const openSettings = useOpenSettings()
  // Settings › Usage: off by default, since not everyone uses boxes.
  const showCloud = useShowCloudMeter()
  const projects = useProjects()
  const [location] = useLocation()
  const routeTask = useTask(location.match(/^\/tasks\/([^/?#]+)/)?.[1] ?? "").data
  // The sidebar sits beside the chat from SIDEBAR_INLINE; under it, the header's menu button opens it as a drawer.
  const sidebarInline = useMinWidth(SIDEBAR_INLINE)
  const box = useRef<HTMLTextAreaElement>(null)
  const composer = useRef<ComposerHandle>(null)
  const panel = useRef<HTMLElement>(null)
  const scroller = useRef<StickyScrollHandle>(null)
  // "Jump to latest" goes in the line over the box (DockComposer.tsx), not over the transcript.
  const jumpStore = useMemo(createJumpStore, [])
  // Until the required keys are set, the centre shows the setup card instead of a chat that can't answer. The
  // thread and composer stay mounted behind it, so a draft survives.
  const setup = useSetupNeeded()
  const skipped = useSetupSkipped()
  const showSetup = setup.needed && !skipped
  const finishSetup = useCallback(() => setSetupSkipped(false), [])
  // Picked in a chat switcher: the composer takes focus.
  useComposerFocus(COORDINATOR_CHAT, box)
  // Then an empty chat shows example requests, until one message is sent or they're dismissed.
  const tryFirstDone = useTryFirstDone()
  const fill = useCallback((text: string, select?: string) => composer.current?.fill(text, select), [])
  const addGithub = useCallback(() => openSettings("credentials"), [openSettings])

  // A suggested next step sends without touching the composer (no keyboard pops up on a phone).
  const followUp = useCallback(
    (text: string, attachments: Attachment[] = [], extra?: ComposerExtra) => {
      const content = text.trim()
      if (!content && !attachments.length) return
      const sending = send.mutateAsync({ id: newClientId("chat"), content, attachments, ...extra })
      sending.catch(() => {}) // onError already says so; the Composer puts the text back.
      scroller.current?.scrollToEnd()
      markTryFirstDone()
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

  const history = useTranscriptHistory("/api/chat/history", chat.data ?? NO_MESSAGES)
  const messages = history.items
  const index = useEntityIndex()
  // Messages sent mid-turn wait under the streaming reply until the turn that reads them starts.
  const { settled: all, queued } = useMemo(() => splitQueued(messages), [messages])
  const allRows = useCoordinatorRows(all)
  // The plain transcript, only its newest rows rendered (useTail).
  const plain = usePlainRows(allRows)
  const days = useMemo(() => chatDays(plain.map(rowFirstMessage)), [plain])
  const tail = useTail(plain, "chat", { ...tailOptions(), max: 200 })
  // Older replies aren't rendered yet: parse their markdown in idle time (as the transcript shows them, InRepo
  // mentions), so scrolling up into them only builds their DOM.
  const hidden = tail.hidden
  useEffect(() => {
    if (hidden) warmMarkdown(plain.slice(0, hidden).flatMap((r) => (r.type === "message" && r.message.role === "assistant" ? [r.message.content] : [])), index, MENTIONS)
  }, [plain, hidden, index])
  const currentProject = useMemo(() => {
    const projectId = location.match(/^\/projects\/([^/?#]+)/)?.[1]
    if (projectId) return projects.data?.find((p) => p.id === projectId) ?? null
    return routeTask ? (projects.data?.find((p) => p.id === routeTask.projectId) ?? null) : null
  }, [location, projects.data, routeTask])
  const selectionSource: SelectionTaskSource = useMemo(() => ({ kind: "orchestrator", project: projectContext(currentProject) }), [currentProject])
  const talking = Boolean(busy.data)
  // Stop sits in the box, before Send.
  const stop = useChatTurnStop(null, talking)

  // Links to a chat message (e.g. a schedule run, a reply's "from:" line): go to it in the transcript, rendering it
  // first if it's older than the rendered part and opening the group it's in.
  const plainRef = useRef(plain)
  plainRef.current = plain
  const tailReveal = tail.reveal
  const reveal = useCallback((id: string) => {
    const row = rowHolding(plainRef.current, id)
    if (!row || !tailReveal(row.id)) return false
    if (row.type !== "message") {
      const items = row.type === "updates" ? row.items : [row.item]
      const item = items.find((i) => i.id === id || itemMessages(i).some((m) => m.id === id))
      if (item) setOpen([item.id], true)
    }
    return true
  }, [tailReveal])


  return (
    <ThreadChatProvider value={COORDINATOR_CHAT}>
      {/* A `coord` container: an open side thread sits beside the chat when the panel is wide, over it when not. */}
      <section ref={panel} data-testid="chat-panel" className="@container/coord relative flex h-full min-w-0 bg-zinc-950">
        <div className="relative flex min-w-0 flex-1 flex-col">
          {/* Header controls respond to the panel width. */}
          <div className={HEAD_CONTAINER}>
          <header
            className={cx(
              // A container, so the cloud meter (if shown) and the voice chip shrink in a narrow header (see CloudMeter, VoiceControl).
              // A column: the controls' row, then (in a narrow header) the cloud meter's strip.
              "@container flex flex-col justify-center [&_button]:min-h-11 [&_button]:min-w-11",
              // overflow-hidden (for the column's scrollbar gutter) only from sm: phones have no gutter.
              "chat-column min-h-14 border-b border-zinc-900 pt-[env(safe-area-inset-top)] sm:overflow-hidden sm:pt-[max(0.5rem,env(safe-area-inset-top))]",
            )}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {!sidebarInline && <SidebarMenuButton />}
              <AgentIcon busy={talking} kind="coordinator" />
              {/* The title takes what's left (flex-1 from 0), so it gives way before the cloud meter's text does. */}
              {/* The title opens the chat switcher: the Coordinator, then every project's Captain (on a phone the title is
                  plain text, and ☰ switches: ChatName). Too narrow for the word beside the three controls (under 280px:
                  a 320px phone at 125% zoom), the icon says it alone and the switcher keeps its chevron. */}
              <div className="flex min-w-0 flex-1">
                <ChatName current={COORDINATOR_CHAT} onPick={pickHere}>
                  <span data-testid="chat-title" className="@max-[17.5rem]:sr-only">
                    {/* It names the app too; a phone keeps the short title so it isn't cut beside the controls. */}
                    <span className="max-sm:hidden">Box Yard </span>
                    Coordinator
                  </span>
                </ChatName>
              </div>
              {showCloud && <CloudMeter variant="inline" />}
              <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-1">
                {/* The sidebar has search (its top row's 🔍) and Settings; ⌘K still opens the palette. */}
                {!sidebarInline && <SearchButton />}
                <VoiceControl />
                <ChatControls name="the Coordinator" />
              </div>
            </div>
            {showCloud && <CloudMeter variant="strip" />}
          </header>
          </div>

          {showSetup && <SetupCard status={setup.status!} className="chat-column" />}
          {setup.needed && !showSetup && <SetupReminder status={setup.status!} onFinish={finishSetup} className="chat-column" />}

          <div className={showSetup ? "hidden" : "contents"}>
            <SelectionToTask source={selectionSource} onPrompt={submit}>
              <ChatHistory days={history.days ?? days} messages={all} reveal={reveal} ensure={history.ensure}>
                <StickyScroll
                  handle={scroller}
                  count={(chat.data?.length ?? 0) + (talking ? 1 : 0)}
                  restoreKey="chat:centre"
                  hidden={tail.hidden || (history.moreBefore ? 1 : 0)}
                  earlierLabel={tail.hidden ? undefined : "Show earlier messages"}
                  onJump={() => { history.toLatest(); tail.reset() }}
                  onLoadEarlier={tail.hidden ? tail.loadEarlier : history.earlier}
                  onTrim={tail.trim}
                  onFill={tail.fill}
                  onFilled={tail.filled}
                  growing={tail.growing}
                  jumpStore={jumpStore}
                  className="chat-column py-6"
                  contentClassName="space-y-3"
                >
                  {chat.isLoading && <Loading kind="chat" label="Loading the conversation" />}
                  {messages.length === 0 && !chat.isLoading && !tryFirstDone && (
                    <TryFirst
                      ready={!setup.needed}
                      github={setup.status?.github.state === "set" && !setup.status.mock}
                      needsGithub={setup.status?.github.state === "unset" && !setup.status.mock}
                      onPick={fill}
                      onGithub={addGithub}
                    />
                  )}
                  {/* The Coordinator's replies span projects: "#12" links only where a paragraph is about one repo. Notices and chips set their task's. */}
                  <InRepo mentions>
                    <CoordinatorTranscript rows={tail.visible} onFollowUp={followUp} />
                    <HistoryNavigation newer={!!tail.later || history.moreAfter} onNewer={tail.later ? tail.loadLater : history.later} browsing={history.browsing} loading={history.loading} onLatest={history.toLatest} handle={scroller} />
                    {!history.browsing && <StreamingReply busy={talking} />}
                    {queued.length > 0 && <ChatLines messages={queued} onFollowUp={followUp} />}
                  </InRepo>
                </StickyScroll>
              </ChatHistory>
            </SelectionToTask>

            <DockComposer
              jumpStore={jumpStore}
              chat={COORDINATOR_TARGET}
              onSubmit={submit}
              placeholder={talking ? "Queue another message…" : "Ask the Coordinator…"}
              textareaRef={box}
              handleRef={composer}
              panelRef={panel}
              historyKey="coordinator"
              stop={stop}
              runTargetsProject={null}
              pullRequests
              className="chat-column overflow-hidden"
            />
          </div>
        </div>
        {/* Its header as tall as the chat's. */}
        <InRepo mentions>
          <SideThreadPane panel={conversation} chat={COORDINATOR_CHAT} headerClassName="min-h-14" />
        </InRepo>
      </section>
    </ThreadChatProvider>
  )
})

/** Messages Cody queued mid-turn. */
const ChatLines = memo(function ChatLines({ messages, onFollowUp }: { messages: ChatMessage[]; onFollowUp: (message: string) => void }) {
  return messages.map((m) => <ChatLine key={m.id} m={m} onFollowUp={onFollowUp} />)
})

/** The reply being streamed. Only this re-renders per streamed chunk, not the thread above it. */
function StreamingReply({ busy }: { busy: boolean }) {
  const stream = useChatStream()
  if (stream.data)
    return (
      <div className="rounded-xl bg-zinc-900/60 px-3 py-2 text-sm text-zinc-200">
        <Markdown live>{stream.data}</Markdown>
      </div>
    )
  if (!busy) return null
  return (
    <div className="flex gap-1 px-1 py-2">
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-500" style={{ animationDelay: `${i * 120}ms` }} />
      ))}
    </div>
  )
}
