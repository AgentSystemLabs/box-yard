import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import { useQuery } from "@tanstack/react-query"
import type { Project, Task } from "../../../shared/types"
import { ArrowDownRight, ChevronRight } from "lucide-react"
import { dayKey, dayLabel } from "../lib/calendarDay"
import { api } from "../lib/api"
import { DAY_SUMMARY_GROUPS, daySummaries, type ChatDay, type DaySummary } from "../lib/chatDays"
import { githubRef, routes, shortGithubLabel } from "../lib/linkify"
import type { NoticeLike } from "../lib/publishedNotices"
import { fetchTasks, keys } from "../lib/queries"
import { REVEAL_CHAT_EVENT, revealChatMessage, type ChatReveal } from "../lib/reveal"
import type { HistoryIndexState } from "../lib/transcriptHistory"
import { Loading } from "./Loading"
import { DismissButton } from "./Modal"
import { releaseListBottom, scrollIntoList, type StickyScrollHandle } from "./StickyScroll"
import { AppLink, Button, cx, TAP_AREA } from "./ui"

const summaryProjects = (projects: Project[]) => projects.map(({ id, repo }) => ({ id, repo }))

/** A midnight changes labels locally; the transcript's rows and Markdown stay memo'd. */
function useToday() {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const next = new Date()
    next.setHours(24, 0, 0, 0)
    const refresh = () => setNow(Date.now())
    const timer = setTimeout(refresh, Math.max(1, +next - Date.now()))
    document.addEventListener("visibilitychange", refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [now])
  return now
}

export function DayBoundary({ at, previousAt, messageId }: { at: number; previousAt?: number; messageId: string }) {
  if (previousAt !== undefined && dayKey(at) === dayKey(previousAt)) return null
  return <DayDivider at={at} messageId={messageId} />
}

/** ChatHistory watches the day dividers inside it, so its rail can mark the day being read. Null outside one. */
const DayWatch = createContext<((el: HTMLElement, at: number) => () => void) | null>(null)

/**
 * A divider counts as passed once its top is in the top quarter of the list or above it. The root reaches far above
 * the list, so "passed" is one side of a line: a jump of any length flips it, where a divider's own visibility would
 * miss a jump right over it.
 */
const PASSED_MARGIN = "9999999px 0px -75% 0px"

const DayDivider = memo(function DayDivider({ at, messageId }: { at: number; messageId: string }) {
  const now = useToday()
  const watch = useContext(DayWatch)
  const el = useRef<HTMLDivElement>(null)
  useEffect(() => (el.current && watch ? watch(el.current, at) : undefined), [watch, at])
  return (
    <div ref={el} data-day-start={messageId} tabIndex={-1} className="flex scroll-mt-3 items-center gap-3 py-2 text-xs text-zinc-400 outline-none focus-visible:text-yard-300">
      <span aria-hidden className="h-px min-w-2 flex-1 bg-zinc-800/80" />
      <time dateTime={new Date(at).toISOString()} className="shrink-0 font-medium">{dayLabel(at, now)}</time>
      <span aria-hidden className="h-px min-w-2 flex-1 bg-zinc-800/80" />
    </div>
  )
})

/** A rail beside, rather than on top of, the list. Only this rail subscribes to task milestones. */
export const ChatHistory = memo(function ChatHistory({ days, messages, reveal, ensure, index, scrollHandle, projectId, taskId, children }: {
  days: ChatDay[]
  messages: readonly NoticeLike[]
  reveal: (id: string) => boolean
  ensure?: (id: string) => Promise<boolean>
  index?: HistoryIndexState
  scrollHandle: RefObject<StickyScrollHandle | null>
  projectId?: string
  taskId?: string
  children: ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  const scope = useId()
  const pendingReveal = useRef<(() => void) | null>(null)
  const cancelReveal = useRef<(() => void) | null>(null)
  const jumpToEnd = useCallback(() => {
    cancelReveal.current?.()
    scrollHandle.current?.scrollToEnd()
    root.current?.querySelector<HTMLElement>("[data-scroller]")?.focus({ preventScroll: true })
  }, [scrollHandle])
  // The day being read: the newest divider that has reached the top of the list, else the oldest one rendered. One
  // IntersectionObserver over the rendered dividers (no scroll listener), and only the rail re-renders when it moves.
  const [current, setCurrent] = useState<string | null>(null)
  const dividers = useRef(new Map<Element, { at: number; passed: boolean }>())
  const observer = useRef<IntersectionObserver | null>(null)
  const watch = useCallback((el: HTMLElement, at: number) => {
    if (typeof IntersectionObserver === "undefined") return () => {}
    const mark = () => {
      let passed: number | undefined
      let oldest: number | undefined
      for (const d of dividers.current.values()) {
        if (d.passed && (passed === undefined || d.at > passed)) passed = d.at
        if (oldest === undefined || d.at < oldest) oldest = d.at
      }
      const at = passed ?? oldest
      setCurrent(at === undefined ? null : dayKey(at))
    }
    // A list that was replaced takes its dividers with it; the next ones get an observer on the new list.
    if (observer.current?.root && !observer.current.root.isConnected) {
      observer.current.disconnect()
      observer.current = null
    }
    observer.current ??= new IntersectionObserver((entries) => {
      for (const e of entries) {
        const d = dividers.current.get(e.target)
        if (d) d.passed = e.isIntersecting
      }
      mark()
    }, { root: root.current?.querySelector("[data-scroller]") ?? null, rootMargin: PASSED_MARGIN })
    dividers.current.set(el, { at, passed: false })
    observer.current.observe(el)
    return () => {
      dividers.current.delete(el)
      observer.current?.unobserve(el)
      mark()
    }
  }, [])
  useEffect(() => () => {
    observer.current?.disconnect()
    observer.current = null
  }, [])
  useLayoutEffect(() => { pendingReveal.current?.() })
  useEffect(() => {
    const frames = new Set<number>()
    const frame = (run: () => void) => {
      const id = requestAnimationFrame(() => { frames.delete(id); run() })
      frames.add(id)
    }
    let highlighted: HTMLElement | undefined
    let originalTabIndex: string | null = null
    const clearHighlight = () => {
      if (!highlighted) return
      highlighted.removeAttribute("data-chat-highlight")
      if (originalTabIndex === null) highlighted.removeAttribute("tabindex")
      else highlighted.setAttribute("tabindex", originalTabIndex)
      highlighted = undefined
    }
    let sequence = 0
    const cancel = () => {
      sequence++
      pendingReveal.current = null
      frames.forEach(cancelAnimationFrame)
      frames.clear()
      clearHighlight()
    }
    cancelReveal.current = cancel
    const onReveal = (event: Event) => {
      const raw = (event as CustomEvent<ChatReveal>).detail
      if (typeof raw === "string" ? !!projectId || !!taskId : raw.scope !== scope) return
      const detail = typeof raw === "string" ? { id: raw, target: "message" as const, highlight: true, fallbackId: undefined } : raw
      const token = ++sequence
      pendingReveal.current = null
      frames.forEach(cancelAnimationFrame)
      frames.clear()
      const list = root.current?.querySelector("[data-scroller]")
      if (list) releaseListBottom(list)
      clearHighlight()
      const show = () => {
        const id = reveal(detail.id) ? detail.id : detail.fallbackId && reveal(detail.fallbackId) ? detail.fallbackId : undefined
        if (!id) return false
        // Let useTail commit and StickyScroll settle before the explicit jump.
        frame(() => frame(() => {
          const q = CSS.escape(id)
          const message = detail.target === "message" && (root.current?.querySelector<HTMLElement>(`[data-chat-id="${q}"]`) ?? root.current?.querySelector<HTMLElement>(`[id="chat-${q}"], [id="captain-${q}"]`))
          const target = message || root.current?.querySelector<HTMLElement>(`[data-day-start="${CSS.escape(detail.fallbackId ?? id)}"]`)
          if (!target) return
          if (detail.highlight) {
            highlighted = target
            originalTabIndex = target.getAttribute("tabindex")
            target.setAttribute("tabindex", "-1")
            target.setAttribute("data-chat-highlight", "")
          }
          scrollIntoList(target, { block: "start", behavior: "auto" })
          target.focus({ preventScroll: true })
        }))
        return true
      }
      if (show() || !ensure) return
      pendingReveal.current = () => {
        if (token === sequence && show()) pendingReveal.current = null
      }
      void ensure(detail.id).then((found) => {
        if (token !== sequence) return
        if (found) frame(() => pendingReveal.current?.())
        else pendingReveal.current = null
      })
    }
    window.addEventListener(REVEAL_CHAT_EVENT, onReveal)
    document.addEventListener("pointerdown", clearHighlight, true)
    document.addEventListener("keydown", clearHighlight, true)
    document.addEventListener("wheel", clearHighlight, { passive: true, capture: true })
    return () => {
      cancel()
      cancelReveal.current = null
      window.removeEventListener(REVEAL_CHAT_EVENT, onReveal)
      document.removeEventListener("pointerdown", clearHighlight, true)
      document.removeEventListener("keydown", clearHighlight, true)
      document.removeEventListener("wheel", clearHighlight, true)
    }
  }, [scope, reveal, ensure, projectId, taskId])
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {index && index.status !== "ready" && <div className="shrink-0 border-b border-zinc-900 px-3 py-2 text-xs text-zinc-400" aria-live="polite">
        {index.status === "loading" ? <Loading kind="line" label="Loading all chat dates" /> : <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="min-w-0 flex-1 basis-48 wrap-anywhere">{index.status === "unsupported"
            ? "Older dates need a newer Box Yard server. Update Box Yard, then retry."
            : "Couldn't load all chat dates. Some older days may be missing."}</p>
          <button type="button" onClick={index.retry} className="min-h-11 shrink-0 rounded px-2 font-medium text-yard-300 hover:bg-zinc-900">Retry dates</button>
        </div>}
      </div>}
      <div ref={root} data-chat-history className="@container/history relative flex min-h-0 min-w-0 flex-1">
        {days.length > 0 && <DayRail days={days} messages={messages} scope={scope} projectId={projectId} taskId={taskId} complete={!index || index.status === "ready"} current={current} onEnd={jumpToEnd} />}
        <DayWatch.Provider value={watch}>{children}</DayWatch.Provider>
      </div>
    </div>
  )
})

/** The popup's three jumps: drawn as buttons, 44px tall at every width. */
const JUMP = "min-h-11! flex-1 transition-none"
/** The rail's rows start under its padding and its label. */
const RAIL_HEAD = 28
/** A milestone's row in the popup, as one target: 44px tall, its title wrapping in it. */
const SUMMARY_ROW = "flex min-h-11 min-w-0 flex-1 basis-32 items-center gap-2 rounded-lg px-2 py-1.5 text-left wrap-anywhere text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-yard-400"
/** A PR or issue at a row's end: drawn as a small link, 44px to a finger (its row is that tall). */
const SUMMARY_REF = cx(TAP_AREA, "inline-block h-7 shrink-0 rounded px-1 leading-7 whitespace-nowrap text-sky-400 hover:underline focus-visible:outline-2 focus-visible:outline-sky-400")

const DayRail = memo(function DayRail({ days, messages, scope, projectId, taskId, complete, current, onEnd }: {
  days: ChatDay[]
  messages: readonly NoticeLike[]
  scope: string
  projectId?: string
  taskId?: string
  complete: boolean
  /** The day being read in the transcript (its key), marked in the rail. */
  current: string | null
  onEnd: () => void
}) {
  // The app already loads tasks. Observe only milestone fields in that cache, so status/context SSE updates don't
  // rebuild summaries and opening a rail never starts another request.
  const select = useCallback((tasks: Task[]) => tasks.filter((t) =>
    (!projectId || t.projectId === projectId) && (!taskId || t.id === taskId),
  ).map(({ id, title, createdAt, prState, prMergedAt, projectId, prUrl }) => ({ id, title, createdAt, prState, prMergedAt, projectId, prUrl })), [projectId, taskId])
  const tasks = useQuery({ queryKey: keys.tasks, queryFn: fetchTasks, enabled: false, select }).data
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/api/projects"), enabled: false, select: summaryProjects }).data
  const now = useToday()
  const summaries = useMemo(() => daySummaries(messages, tasks ?? [], projects ?? [], projectId), [messages, tasks, projects, projectId])
  const [open, setOpen] = useState<string | null>(null)
  const nav = useRef<HTMLElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const popupId = useId()
  const day = days.find((d) => d.key === open)
  const bullets = day ? summaries.get(day.key) ?? [] : []
  const lastDay = days.at(-1)?.key
  // Keep even years of day buttons bounded. Fixed 44px rows preserve native scrolling and keyboard focus.
  const [railTop, setRailTop] = useState(0)
  const railStart = Math.max(0, Math.floor((railTop - RAIL_HEAD) / 44) - 12)
  const railEnd = Math.min(days.length, railStart + 80)
  // One Tab stop for the rail (arrow keys move inside it): the open day, else the day last focused, else the newest.
  // It's always one of the rendered rows, so Tab can reach the rail wherever it's scrolled.
  const [rover, setRover] = useState<string | null>(null)
  const stopKey = open ?? rover ?? lastDay
  const stopAt = days.findIndex((d) => d.key === stopKey)
  const tabStop = stopAt >= railStart && stopAt < railEnd ? stopAt : railEnd - 1
  const currentAt = current ? days.findIndex((d) => d.key === current) : -1
  const close = useCallback(() => {
    setOpen(null)
    anchor.current?.focus({ preventScroll: true })
  }, [])

  useLayoutEffect(() => {
    if (nav.current) { nav.current.scrollTop = nav.current.scrollHeight; setRailTop(nav.current.scrollTop) }
  }, [lastDay, days.length])
  // The day being read stays in view in the rail, a row clear of its edge. Not while the rail has the focus: the
  // arrow keys scroll it themselves. scrollTop, not scrollIntoView, which could scroll the page too.
  useEffect(() => {
    const el = nav.current
    if (!el || currentAt < 0 || el.contains(document.activeElement)) return
    const top = RAIL_HEAD + currentAt * 44
    const next = top < el.scrollTop ? top - 44 : top + 44 > el.scrollTop + el.clientHeight ? top + 88 - el.clientHeight : null
    if (next === null) return
    el.scrollTop = Math.max(0, next)
    setRailTop(el.scrollTop)
  }, [currentAt, days.length])
  // A day opened: the keyboard continues in its popup. Esc brings the focus back to the day.
  useLayoutEffect(() => {
    if (open) popup.current?.querySelector<HTMLElement>("[data-day-jump]")?.focus({ preventScroll: true })
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      if (!nav.current?.contains(e.target as Node) && !popup.current?.contains(e.target as Node)) setOpen(null)
    }
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      e.stopPropagation()
      close()
    }
    document.addEventListener("pointerdown", outside)
    document.addEventListener("keydown", escape, true)
    return () => {
      document.removeEventListener("pointerdown", outside)
      document.removeEventListener("keydown", escape, true)
    }
  }, [open, close])
  const jump = (d: ChatDay, sourceId?: string, highlight = false) => {
    setOpen(null)
    revealChatMessage(sourceId ?? d.messageId, { scope, highlight, target: sourceId ? "message" : "day", fallbackId: d.messageId })
  }

  return (
    <>
      <nav ref={nav} onScroll={(e) => setRailTop(e.currentTarget.scrollTop)} aria-label={`Chat days${complete ? "" : " (recent only; older dates may be missing)"}: activate to preview`} className="scroll-thin w-11 shrink-0 overflow-x-hidden overflow-y-auto border-r border-zinc-900 py-2">
        <p aria-hidden className="py-1 text-center text-[11px] text-zinc-400">{complete ? "Days" : "Recent"}</p>
        {railStart > 0 && <div aria-hidden style={{ height: railStart * 44 }} />}
        {days.slice(railStart, railEnd).map((d, index) => {
          const here = railStart + index
          const marked = d.key === open || d.key === current
          return (
            <button
              key={d.key}
              type="button"
              data-day-index={here}
              tabIndex={here === tabStop ? 0 : -1}
              onFocus={() => setRover(d.key)}
              onKeyDown={(e) => {
                // Tab leaves the rail; the arrows, Home and End move in it.
                const direction = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0
                const next = e.key === "Home" ? 0 : e.key === "End" ? days.length - 1 : here + direction
                if ((!direction && e.key !== "Home" && e.key !== "End") || next < 0 || next >= days.length) return
                e.preventDefault()
                const top = Math.max(0, next * 44 - (nav.current?.clientHeight ?? 0) / 2)
                if (nav.current) nav.current.scrollTop = top
                setRailTop(top)
                requestAnimationFrame(() => nav.current?.querySelector<HTMLElement>(`[data-day-index="${next}"]`)?.focus({ preventScroll: true }))
              }}
              aria-label={`${dayLabel(d.at, now)}: preview day summary`}
              aria-current={d.key === current ? "date" : undefined}
              aria-expanded={d.key === open}
              aria-controls={d.key === open ? popupId : undefined}
              onClick={(e) => {
                anchor.current = e.currentTarget
                setRover(d.key)
                setOpen(d.key)
              }}
              className={cx(
                "flex h-11 min-h-11 w-11 flex-col items-center justify-center border-l-2 text-[11px] leading-tight focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-yard-400",
                // Only the open day is filled. The day being read is marked in its text and a thin bar, so it doesn't
                // read as the focus or as a second open day.
                d.key === open ? "border-yard-400 bg-yard-500/10 text-yard-300" : d.key === current ? "border-zinc-600 font-semibold text-zinc-100 hover:bg-zinc-900" : "border-transparent text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
              )}
            >
              <span>{new Date(d.at).toLocaleDateString(undefined, { month: "short" })}</span>
              <span className={cx("text-xs font-semibold tabular-nums", !marked && "text-zinc-300")}>{new Date(d.at).getDate()}</span>
            </button>
          )
        })}
        {railEnd < days.length && <div aria-hidden style={{ height: (days.length - railEnd) * 44 }} />}
      </nav>
      {day && (
        <div ref={popup} id={popupId} role="region" aria-label={`${dayLabel(day.at, now)} work summary`} className="scroll-thin absolute top-2 left-12 z-20 max-h-[calc(100%-1rem)] w-[calc(100%-3.5rem)] max-w-sm overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-3 text-xs shadow-xl">
          <div className="flex min-h-11 items-center justify-between gap-2">
            <p className="font-semibold text-zinc-100">{dayLabel(day.at, now)}</p>
            <DismissButton kind="close" className="h-11 w-11 transition-none!" onClick={close} label="Close day summary" />
          </div>
          {/* A narrow panel gives "Jump to day" its own row, so the three never squeeze. */}
          <div role="group" aria-label="Transcript navigation" className="mb-3 flex flex-wrap gap-2">
            {/* It takes the focus as the day opens: a held Enter on the day must not also jump. */}
            <Button data-day-jump size="sm" className={cx(JUMP, "@max-[26rem]/history:basis-full")} onKeyDown={(e) => { if (e.repeat) e.preventDefault() }} onClick={() => jump(day)}>Jump to day</Button>
            <Button size="sm" className={JUMP} disabled={!complete} title={complete ? undefined : "Load all chat dates to jump to start"} onClick={() => jump(days[0]!)}>Jump to start</Button>
            <Button size="sm" className={JUMP} onClick={() => { setOpen(null); onEnd() }}>Jump to end</Button>
          </div>
          {bullets.length > 0 ? (
            <div className="space-y-2">
              {DAY_SUMMARY_GROUPS.map((g) => {
                const rows = bullets.filter((b) => b.kind === g.kind)
                if (!rows.length) return null
                return (
                  <section key={g.kind} data-summary-group={g.kind}>
                    <h3 className="px-2 text-[11px] text-zinc-400">{g.label} <span aria-hidden>·</span> {rows.length}</h3>
                    <ul role="list">
                      {rows.map((b, i) => (
                        <SummaryRow
                          key={b.taskId ?? `${i}:${b.title}`}
                          summary={b}
                          // The task's own page has nowhere else to open it.
                          openTask={Boolean(b.taskId) && b.taskId !== taskId}
                          onShow={() => jump(day, b.sourceMessageId, true)}
                          onOpen={() => setOpen(null)}
                        />
                      ))}
                    </ul>
                  </section>
                )
              })}
            </div>
          ) : <p className="py-1 text-zinc-400">No task milestones on this day.</p>}
        </div>
      )}
    </>
  )
})

/**
 * One milestone: the task's title as the row's one target, and its PRs and issues as links at the row's end (beside
 * the target, never inside it). With a message in this chat the row shows it there; otherwise it opens the task.
 */
function SummaryRow({ summary, openTask, onShow, onOpen }: { summary: DaySummary; openTask: boolean; onShow: () => void; onOpen: () => void }) {
  const title = <span className="min-w-0 flex-1">{summary.title}</span>
  return (
    <li className="flex flex-wrap items-center gap-x-1">
      {summary.sourceMessageId ? (
        <button type="button" data-summary-jump title="Show in chat" onClick={onShow} className={SUMMARY_ROW}>
          {title}
          <ArrowDownRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-yard-300" />
          <span className="sr-only">Show in chat</span>
        </button>
      ) : openTask ? (
        // AppLink keeps its click to itself, so the popup closes on the way down.
        <span data-summary-open className="contents" onClickCapture={onOpen}>
          <AppLink href={routes.task(summary.taskId!)} className={SUMMARY_ROW}>
            {title}
            <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          </AppLink>
        </span>
      ) : (
        <span data-summary-plain className="min-w-0 flex-1 px-2 py-1.5 wrap-anywhere text-zinc-300">{summary.title}</span>
      )}
      {summary.refs.length > 0 && (
        <span className="ml-auto flex max-w-full shrink-0 flex-wrap items-center gap-x-2 pr-1 pointer-coarse:min-h-11 pointer-coarse:gap-y-4">
          {summary.refs.map((url) => (
            <AppLink key={url} href={url} className={SUMMARY_REF}>
              {githubRef(url)?.kind === "pull" ? shortGithubLabel(url)! : `#${githubRef(url)?.number}`}
            </AppLink>
          ))}
        </span>
      )}
    </li>
  )
}
