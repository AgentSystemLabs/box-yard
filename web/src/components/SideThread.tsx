// Side threads in a chat: Reply to a message in the Coordinator's (or a Captain's) chat, or to a passage of it (the
// selection's "Reply quoting selection"), and the replies stay out of the chat, which shows "↰ N replies" under the
// message, and open in a panel on the right (Slack's and Claude's threads). The chat's agent routes each reply: it
// answers a question there, or sends it on to the task's agent or into its own chat, and a line under the reply says
// where it went (ThreadRoute.tsx). Older threads asked about a highlighted passage show the same way. A thread sees
// the chat up to that message (server/sideThreads.ts) but shows only the message or highlight and the replies.
//
// The panel lives inside the chat's section, which is a `coord` container: from 35.5rem wide (a 125%-zoomed laptop; a 560px phone stays a sheet) it's a column beside the
// chat (the Coordinator's dock widens to make room, App.tsx), below that a full-height sheet over it.
import { Fragment, createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { flushSync } from "react-dom"
import { useQueryClient } from "@tanstack/react-query"
import {
  AlertTriangle,
  ChevronRight,
  CircleCheck,
  Loader2,
  Maximize2,
  MessageCircle,
  Minimize2,
  MoreHorizontal,
  Reply,
  Search,
  Square,
  TextSearch,
  Trash2,
  Undo2,
} from "lucide-react"
import { COMPOSER_FOOTER, Composer } from "./Composer"
import { ComposerIcon } from "./ChatIcons"
import { RouteLine, routerName } from "./ThreadRoute"
import { StickyScroll, type StickyScrollHandle } from "./StickyScroll"
import { DismissButton } from "./Modal"
import { MessageMenu, type MenuItem } from "./MessageActions"
import { LineIcon, Markdown, cx } from "./ui"
import { quotePreview } from "./NewTask"
import { confirmDialog } from "../lib/confirm"
import { revealChatMessage } from "../lib/reveal"
import { newClientId } from "../lib/queries"
import {
  closeThread,
  openReply,
  openThread,
  threadDraftKey,
  toggleExpanded,
  useAskThread,
  useMessageThreads,
  useOpenThread,
  useSendThreadMessage,
  useThread,
  useThreadControl,
  useThreadMessages,
  useThreadStream,
  type OpenThread,
  type ThreadChat,
} from "../lib/threads"
import { caretAt, findQuoteRange, setOpenHighlight, setThreadRange, threadRange } from "../lib/threadHighlight"
import { ResizeHandle, useElementWidth, useResizable } from "../lib/resize"
import { THREAD_MAX, THREAD_MIN, THREAD_ROOM, stripWidthCss, threadLimit, threadWidthCss } from "../lib/layout"
import { useChatRoom, usePanelWidths } from "../lib/panelWidths"
import { useColumnLayout } from "../lib/columns"
import type { ChatMessage, SideThread, SideThreadMessage } from "../../../shared/types"

const ThreadChatContext = createContext<ThreadChat | null>(null)

/** Turns on side threads for the chat lines inside (ChatLine's markers, the Ask actions). */
export const ThreadChatProvider = ThreadChatContext.Provider
/** The chat whose lines these are, or null where there are no threads (a task's transcript). */
export const useThreadChat = () => useContext(ThreadChatContext)

/**
 * Reply to a whole message in its reply thread (MessageActions' Reply, the selection's "Reply quoting selection"):
 * `quote` goes in the thread's box, ready to add to. Null where the chat has no threads. Call it from the press: the
 * panel mounts and its box takes the caret before the handler returns, which is what brings up a phone's keyboard.
 */
export function useReplyTo(): ((anchorId: string, text: string, quote?: string) => void) | null {
  const chat = useThreadChat()
  const qc = useQueryClient()
  const reply = useCallback((anchorId: string, text: string, quote?: string) => chat && flushSync(() => openReply(qc, chat, anchorId, text, quote)), [qc, chat])
  return chat ? reply : null
}

// ---------------------------------------------------------------- the panel

/**
 * The chat's open thread: a column on the right, or a sheet over the chat in a narrow panel (or when expanded).
 * `headerClassName` sizes its header like the chat's, so the two line up side by side. It has no slide or fade: it's
 * there in full the moment it opens and gone the moment it closes.
 */
export function SideThreadPane({ chat, headerClassName = "min-h-12", panel }: { chat: ThreadChat; headerClassName?: string; panel?: ReactNode }) {
  const cur = useOpenThread(chat)
  const id = panel ? "panel-conversation" : cur?.id ?? null
  const expanded = !panel && Boolean(cur?.expanded)
  // A column's left edge drags (one width for every chat's panel); the chat it sits in caps the drag.
  const [aside, setAside] = useState<HTMLElement | null>(null)
  const container = useElementWidth(aside?.parentElement)
  const size = useResizable({ key: "box-yard:thread-width", defaultWidth: THREAD_ROOM, min: THREAD_MIN, max: THREAD_MAX, limit: container && threadLimit(container), edge: "left" })
  // The conversation panels (OverlayHost): as wide as the panels together and the levels' strips, as far as the
  // chat's room allows, then they scroll. Each panel has its own width; the borders drag there.
  const layout = useColumnLayout()
  const strip = usePanelWidths(panel ? layout.panels.length : 0)
  const strips = panel ? layout.strips.length : 0
  const chatRoom = useChatRoom()
  // The chat hidden (lib/columns.ts): the panels cover the whole chat. The chat stays laid out under them, so it
  // shows again as it was (its scroll, its box), but Tab and screen readers skip it.
  const covering = Boolean(panel) && layout.chat !== "open"
  useLayoutEffect(() => {
    const chat = covering ? aside?.previousElementSibling : null
    if (!chat) return
    chat.setAttribute("inert", "")
    return () => chat.removeAttribute("inert")
  }, [covering, aside])

  useEffect(() => {
    if (!id || panel) return
    setOpenHighlight(id, true)
    return () => setOpenHighlight(id, false)
  }, [id, Boolean(panel)])

  if (!id || (!panel && !cur)) return null
  return (
    <aside
      data-testid="side-thread"
      data-expanded={expanded || undefined}
      data-conversation={panel ? true : undefined}
      data-covering={covering || undefined}
      aria-label={panel ? "Conversation panel" : "Thread"}
      onKeyDown={(e) => {
        if (panel || e.key !== "Escape" || e.defaultPrevented) return
        e.stopPropagation()
        closeThread(chat)
      }}
      ref={setAside}
      style={{ "--thread-w": panel ? stripWidthCss(strip, chatRoom, strips) : threadWidthCss(size.width) } as React.CSSProperties}
      className={cx(
        // A sheet over the chat...
        "absolute inset-0 z-30 flex flex-col bg-zinc-950 shadow-2xl shadow-black/60",
        // ...or, in a wide panel, a column beside it at its saved width. Expanded, or with the chat collapsed or
        // closed, it stays over the whole chat.
        !expanded &&
          !covering &&
          "@min-[35.5rem]/coord:relative @min-[35.5rem]/coord:w-(--thread-w) @min-[35.5rem]/coord:shrink-0 @min-[35.5rem]/coord:overflow-hidden @min-[35.5rem]/coord:shadow-none",
        // The panels draw their own left borders.
        !expanded && !panel && "@min-[35.5rem]/coord:border-l @min-[35.5rem]/coord:border-zinc-800",
      )}
    >
      {/* Inside the column, which clips. A sheet has no edge to drag; the panels each have their own. */}
      {!expanded && !panel && <ResizeHandle {...size.handle} inside className="@min-[35.5rem]/coord:block" />}
      <div className="flex h-full min-h-0 w-full flex-col">
        {panel ?? <PaneBody id={id} chat={chat} open={cur!} headerClassName={headerClassName} />}
      </div>
    </aside>
  )
}

/** The thread. Memoized: dragging the panel's edge re-renders the pane on every move. */
const PaneBody = memo(function PaneBody({ id, chat, open, headerClassName }: { id: string; chat: ThreadChat; open: OpenThread; headerClassName: string }) {
  return <ThreadView key={id} chat={chat} open={open} headerClassName={headerClassName} />
})

const NO_MESSAGES: SideThreadMessage[] = []

/** A message's first line as a title: no Markdown marks, at most a line. */
export function threadTitle(text: string) {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? ""
  return quotePreview(line.replace(/^\s*(?:#+|>|[-*+]|\d+\.)\s+/, "").replace(/[*_`~]+/g, ""), 140)
}

export const repliesLabel = (n: number) => `${n} ${n === 1 ? "reply" : "replies"}`

/** The panel header's icon buttons: 44px for a finger, 32px for a mouse. */
const PANEL_ICON =
  "grid h-11 w-11 shrink-0 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 aria-expanded:bg-zinc-800 aria-pressed:text-yard-300 [@media(pointer:fine)]:h-8 [@media(pointer:fine)]:w-8"
/** A header button only for the column beside the chat: a sheet has ‹ instead. */
const PANEL_WIDE = "hidden @min-[35.5rem]/coord:grid"

/** The panel's header: ‹ on a sheet, "Threads › title", its own buttons (`children`), and × in a column. */
function PanelHeader({
  chat,
  open,
  className,
  crumb,
  title,
  closeLabel,
  closeTitle,
  children,
}: {
  chat: ThreadChat
  open: OpenThread
  className: string
  crumb: string
  title: ReactNode
  closeLabel: string
  closeTitle: string
  children?: ReactNode
}) {
  const close = () => closeThread(chat)
  return (
    <header className={cx(className, "flex shrink-0 items-center gap-1 border-b border-zinc-900 pt-[env(safe-area-inset-top)] pr-[max(0.5rem,env(safe-area-inset-right))] pl-2")}>
      {/* A sheet goes back to the chat; a column closes with the × on the right. */}
      <DismissButton kind="back" onClick={close} label="Back to the chat" className={open.expanded ? "hidden" : "@min-[35.5rem]/coord:hidden"} />
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1 text-sm @min-[35.5rem]/coord:pl-2">
        <span className="shrink-0 font-semibold text-zinc-100">{crumb}</span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
        {title}
      </nav>
      <div className="flex shrink-0 items-center gap-0.5">
        {children}
        <DismissButton kind="close" onClick={close} label={closeLabel} title={closeTitle} className={open.expanded ? undefined : PANEL_WIDE} />
      </div>
    </header>
  )
}

/** The last Reply whose caret was placed (OpenThread.focus), so showing the panel again leaves the focus be. */
let caretPlaced = 0

function ThreadView({ chat, open, headerClassName }: { chat: ThreadChat; open: OpenThread; headerClassName: string }) {
  const id = open.id
  const draft = open.draft ?? null
  const thread = useThread(chat, id)
  const messages = useThreadMessages(id, Boolean(thread)).data ?? NO_MESSAGES
  const send = useSendThreadMessage(chat, id)
  const start = useAskThread(chat)
  const control = useThreadControl(chat)
  const pane = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const more = useRef<HTMLButtonElement>(null)
  const list = useRef<StickyScrollHandle>(null)
  const [menu, setMenu] = useState(false)
  const busy = Boolean(thread?.busy)
  const reply = draft !== null || thread?.kind === "reply"
  const anchorId = thread?.anchorId ?? draft?.anchorId ?? null
  const original = thread?.quote ?? draft?.text ?? ""
  const resolved = thread?.resolvedAt != null
  const router = routerName(chat)

  // Opened from Reply: straight to the composer, the caret after anything in it ("Reply quoting selection" put the
  // quote there, openReply), once, not on every mount. In the commit Reply's press makes (useReplyTo), so a phone's
  // keyboard comes up with it.
  const focus = open.focus
  useLayoutEffect(() => {
    const el = input.current
    if (!focus || focus <= caretPlaced || !el) return
    caretPlaced = focus
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
  }, [focus])

  // Cody's messages an answer (or an error) came after: a message from before routing has only that.
  const answered = useMemo(() => {
    const ids = new Set<string>()
    let waiting: string[] = []
    for (const m of messages) {
      if (m.role === "user") waiting.push(m.id)
      else if (m.role === "assistant" || m.role === "error") {
        for (const w of waiting) ids.add(w)
        waiting = []
      }
    }
    return ids
  }, [messages])

  // Open: what it says is read (now, and as answers arrive).
  const unread = Boolean(thread?.unread)
  useEffect(() => {
    if (unread) control.seen(id)
  }, [unread, id]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (text: string) => {
    const content = text.trim()
    if (!content) return
    list.current?.scrollToEnd()
    if (!thread && draft) return start.mutateAsync({ id, messageId: newClientId("thm"), anchorId: draft.anchorId, quote: draft.text, question: content, kind: "reply" })
    return send.mutateAsync({ id: newClientId("thm"), content })
  }
  const remove = async () => {
    const ok = await confirmDialog({
      title: "Delete this thread?",
      body: reply ? "Its replies are deleted. The main chat isn't affected." : "Its question and replies are deleted, and the highlight goes. The main chat isn't affected.",
      confirmLabel: "Delete",
      danger: true,
    })
    if (ok) await control.remove(id)
  }
  const reveal = () => {
    if (!anchorId) return
    if (chat === "coordinator") return revealChatMessage(anchorId)
    document.querySelector(`[data-chat-id="${CSS.escape(anchorId)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" })
  }
  const items: MenuItem[] = [
    { icon: TextSearch, label: "Show in the chat", run: reveal },
    ...(thread && busy ? [{ icon: Square, label: "Stop answering", run: () => control.stop(id) }] : []),
    ...(thread ? [{ icon: Trash2, label: "Delete thread", run: () => void remove() }] : []),
  ]

  return (
    <div ref={pane} className="relative flex h-full min-h-0 flex-col">
      <PanelHeader
        chat={chat}
        open={open}
        className={headerClassName}
        crumb="Threads"
        closeLabel="Close thread"
        closeTitle="Close (Esc). It stays under the message."
        title={
          <span data-testid="side-thread-title" title={quotePreview(original, 400)} className="min-w-0 truncate text-zinc-400">
            {reply ? threadTitle(original) : `“${quotePreview(original, 140)}”`}
          </span>
        }
      >
        {thread && (
          <button
            type="button"
            data-testid="side-thread-resolve"
            onClick={() => void control.resolve(id, !resolved)}
            aria-pressed={resolved}
            aria-label={resolved ? "Reopen thread" : "Resolve thread"}
            title={resolved ? "Resolved. Reopen it" : "Resolve: fold it away under the message"}
            className={PANEL_ICON}
          >
            {resolved ? <Undo2 className="h-4 w-4" /> : <CircleCheck className="h-4 w-4" />}
          </button>
        )}
        <button ref={more} type="button" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu} aria-label="More thread actions" title="More" className={PANEL_ICON}>
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {menu && <MessageMenu trigger={more} items={items} onClose={() => setMenu(false)} />}
        <button
          type="button"
          data-testid="side-thread-expand"
          onClick={() => toggleExpanded(chat)}
          aria-pressed={Boolean(open.expanded)}
          aria-label={open.expanded ? "Back beside the chat" : "Expand over the chat"}
          title={open.expanded ? "Back beside the chat" : "Expand over the chat"}
          className={cx(PANEL_ICON, PANEL_WIDE)}
        >
          {open.expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
      </PanelHeader>
      {!reply && thread && (
        <div className="shrink-0 border-b border-zinc-900 px-3 py-2.5">
          <button
            type="button"
            onClick={reveal}
            title="Show it in the chat"
            data-testid="side-thread-quote"
            className="block w-full rounded-lg border border-zinc-800 border-l-2 border-l-yard-500/70 bg-zinc-900/60 px-3 py-2 text-left text-xs leading-5 wrap-anywhere whitespace-pre-wrap text-zinc-300 hover:border-zinc-700"
          >
            <span className="line-clamp-4">{thread.quote}</span>
          </button>
          {thread.context === "summary" && (
            <p className="mt-1.5 text-[11px] leading-4 text-zinc-500">The chat was compacted since, so this thread started from the compaction summary and the messages up to the highlight.</p>
          )}
        </div>
      )}
      <StickyScroll handle={list} count={messages.length} resetKey={id} className={cx("px-3 py-3", open.expanded && "mx-auto w-full max-w-3xl")} contentClassName="space-y-3">
        {reply && (
          <div data-testid="side-thread-original" className="space-y-2.5">
            <div className="text-sm text-zinc-200">
              <Markdown>{original}</Markdown>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-zinc-500">
              <span className="shrink-0">{thread?.replies ? repliesLabel(thread.replies) : "No replies yet"}</span>
              <span className="h-px flex-1 bg-zinc-800" />
            </div>
            {!thread?.replies && (
              <p data-testid="side-thread-routing-hint" className="text-[11px] leading-4 text-zinc-500">
                The {router} answers questions here and sends instructions on, to the task&apos;s agent or its own chat. Each message says where it went.
              </p>
            )}
            {thread?.context === "summary" && <p className="text-[11px] leading-4 text-zinc-500">The chat was compacted since, so this thread started from the compaction summary and the messages up to this one.</p>}
          </div>
        )}
        {messages.map((m) =>
          reply && thread && m.role === "user" ? (
            <Fragment key={m.id}>
              <ThreadLine m={m} />
              <RouteLine m={m} chat={chat} thread={thread} answered={answered.has(m.id)} />
            </Fragment>
          ) : (
            <ThreadLine key={m.id} m={m} />
          ),
        )}
        <ThreadStreaming id={id} busy={busy} />
      </StickyScroll>
      <Composer
        onSubmit={submit}
        draftKey={threadDraftKey(id)}
        githubProject={chat === "coordinator" ? null : chat}
        files={false}
        textareaRef={input}
        stop={thread && busy ? { label: `Stop the ${router}'s answer`, onStop: () => control.stop(id) } : null}
        icon={<ComposerIcon kind="side-question" label={`Side question to the ${router}`} />}
        placeholder={reply ? (busy ? "Queue another reply…" : "Reply…") : busy ? "Queue a follow-up…" : "Reply in this thread…"}
        panelRef={pane}
        className={cx(COMPOSER_FOOTER, "px-3", open.expanded && "mx-auto w-full max-w-3xl")}
      />
    </div>
  )
}

/** A thread's message: Cody's on the right, the answer as Markdown, a lookup it used, or an error. */
export const ThreadLine = memo(function ThreadLine({ m }: { m: SideThreadMessage }) {
  if (m.role === "user")
    return (
      <div className="flex justify-end">
        <div className={cx("max-w-[85%] min-w-0 rounded-2xl rounded-br-md bg-yard-500/15 px-3 py-2 text-sm whitespace-pre-wrap wrap-anywhere text-zinc-100")}>{m.content}</div>
      </div>
    )
  if (m.role === "tool")
    return (
      <div className="flex items-start gap-1.5 pl-1 text-xs text-zinc-500">
        <LineIcon icon={Search} className="h-3.5 w-3.5" />
        <span className="min-w-0 wrap-anywhere">
          Used <span className="font-mono text-zinc-400">{m.content}</span>
        </span>
      </div>
    )
  if (m.role === "error")
    return (
      <div className="flex items-start gap-2 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">
        <LineIcon icon={AlertTriangle} className="h-3.5 w-3.5" />
        <div className="min-w-0 whitespace-pre-wrap wrap-anywhere">{m.content}</div>
      </div>
    )
  return (
    <div data-testid="side-thread-reply" className="text-sm text-zinc-200">
      <Markdown>{m.content}</Markdown>
    </div>
  )
})

/** The answer as it streams in, or "Claude is working" until its first words. */
export function ThreadStreaming({ id, busy }: { id: string; busy: boolean }) {
  const stream = useThreadStream(id).data
  if (stream)
    return (
      <div className="text-sm text-zinc-200">
        <Markdown live>{stream}</Markdown>
      </div>
    )
  if (!busy) return null
  return (
    <div data-testid="side-thread-working" role="status" className="flex items-center gap-2 px-1 py-2 text-xs text-zinc-500">
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-yard-400/80" style={{ animationDelay: `${i * 120}ms` }} />
        ))}
      </span>
      Claude is working
    </div>
  )
}

// ---------------------------------------------------------------- markers on the chat

/**
 * Under a message with threads: "↰ N replies" for its reply thread, a chip per question about a highlight, and the
 * highlighted passages tinted in the text (a click on one opens its thread too). Nothing for a message without threads.
 */
export const ThreadMarkers = memo(function ThreadMarkers({ m }: { m: ChatMessage }) {
  const chat = useThreadChat()
  if (!chat) return null
  return <Markers chat={chat} m={m} />
})

function Markers({ chat, m }: { chat: ThreadChat; m: ChatMessage }) {
  const threads = useMessageThreads(chat, m.id)
  const open = useOpenThread(chat)
  const row = useRef<HTMLDivElement>(null)
  const asks = useMemo(() => threads.filter((t) => t.kind !== "reply"), [threads])
  const replies = threads.find((t) => t.kind === "reply") ?? null
  const quotes = useMemo(() => asks.map((t) => [t.id, t.quote] as const), [asks])

  // Tint each question's passage. After the text renders, and again when it changes.
  useLayoutEffect(() => {
    const root = row.current?.closest("[data-chat-id]")
    if (!root) return
    for (const [id, quote] of quotes) setThreadRange(id, findQuoteRange(root, quote))
    return () => {
      for (const [id] of quotes) setThreadRange(id, null)
    }
  }, [quotes, m.content])

  // A click (not a drag that selects) on a tinted passage opens its thread.
  useEffect(() => {
    const root = row.current?.closest("[data-chat-id]")
    if (!root || !quotes.length) return
    const click = (e: Event) => {
      const ev = e as MouseEvent
      if (!window.getSelection()?.isCollapsed || (ev.target as Element | null)?.closest?.("a, button")) return
      const at = caretAt(ev.clientX, ev.clientY)
      if (!at) return
      const hit = quotes.find(([id]) => {
        const r = threadRange(id)
        try {
          return r && r.isPointInRange(at.node, at.offset)
        } catch {
          return false
        }
      })
      if (hit) openThread(chat, hit[0])
    }
    root.addEventListener("click", click)
    return () => root.removeEventListener("click", click)
  }, [chat, quotes])

  if (!threads.length) return null
  const right = m.role === "user"
  const isOpen = (t: SideThread) => open?.id === t.id
  const toggle = (t: SideThread) => (isOpen(t) ? closeThread(chat) : openThread(chat, t.id))
  return (
    <div ref={row} data-thread-markers className={cx("mt-1.5 flex flex-wrap items-center gap-1.5", right && "justify-end")}>
      {replies && <RepliesButton t={replies} active={isOpen(replies)} onOpen={() => toggle(replies)} />}
      {asks.map((t) => (
        <ThreadChip key={t.id} t={t} active={isOpen(t)} onOpen={() => toggle(t)} />
      ))}
    </div>
  )
}

/** "↰ 2 replies" under a message: opens its reply thread. It says when an answer is coming, unread or resolved. */
function RepliesButton({ t, active, onOpen }: { t: SideThread; active: boolean; onOpen: () => void }) {
  const resolved = t.resolvedAt != null
  const state = t.busy ? "answering" : t.unread ? "new reply" : resolved ? "resolved" : null
  return (
    <button
      type="button"
      data-testid="thread-replies"
      data-unread={(t.unread && !t.busy) || undefined}
      data-resolved={resolved || undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onOpen}
      aria-pressed={active}
      aria-label={`${repliesLabel(t.replies)}${state ? `, ${state}` : ""}`}
      title={active ? "Close the replies" : "Open the replies"}
      className={cx(
        "-ml-1.5 inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs [@media(pointer:coarse)]:h-9",
        active ? "bg-yard-500/15 text-yard-100" : resolved && !t.unread && !t.busy ? "text-zinc-600 hover:bg-zinc-900 hover:text-zinc-300" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100",
      )}
    >
      <Reply className="h-3.5 w-3.5 shrink-0" />
      <span className="whitespace-nowrap">{repliesLabel(t.replies)}</span>
      {t.busy ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-yard-300" aria-hidden />
      ) : t.unread ? (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-yard-400" aria-hidden />
      ) : resolved ? (
        <CircleCheck className="h-3 w-3 shrink-0" aria-hidden />
      ) : null}
    </button>
  )
}

function ThreadChip({ t, active, onOpen }: { t: SideThread; active: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      data-testid="thread-marker"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onOpen}
      aria-pressed={active}
      title={active ? "Close this side thread" : "Open this side thread"}
      className={cx(
        "inline-flex h-11 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-xs sm:h-6",
        active ? "border-yard-400/60 bg-yard-500/15 text-yard-100" : "border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200",
      )}
    >
      {t.busy ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> : <MessageCircle className="h-3 w-3 shrink-0" />}
      <span className="min-w-0 truncate">“{quotePreview(t.quote, 48)}”</span>
    </button>
  )
}
