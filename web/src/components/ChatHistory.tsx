import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import { useQuery } from "@tanstack/react-query"
import type { Project, Task } from "../../../shared/types"
import { ArrowDownRight, CalendarDays, ChevronDown, ChevronRight } from "lucide-react"
import { dayKey, dayLabel } from "../lib/calendarDay"
import { api } from "../lib/api"
import { DAY_SUMMARY_GROUPS, daySummaries, type ChatDay, type DaySummary, type DaySummaryKind } from "../lib/chatDays"
import { githubRef, routes, shortGithubLabel } from "../lib/linkify"
import type { NoticeLike } from "../lib/publishedNotices"
import { fetchTasks, keys } from "../lib/queries"
import { REVEAL_CHAT_EVENT, revealChatMessage, type ChatReveal } from "../lib/reveal"
import type { HistoryIndexState } from "../lib/transcriptHistory"
import { Loading } from "./Loading"
import { DismissButton } from "./Modal"
import { releaseListBottom, scrollIntoList, type StickyScrollHandle } from "./StickyScroll"
import { TaskStatusIcon } from "./TaskIcon"
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
        {/* The rail beside the chat; a narrow panel (a phone) stacks the rail's chip over it instead. A container
            query can't restyle its own container, hence this box. */}
        <div className="flex min-h-0 min-w-0 flex-1 @max-[28rem]/history:flex-col">
          {days.length > 0 && <DayRail days={days} messages={messages} scope={scope} projectId={projectId} taskId={taskId} complete={!index || index.status === "ready"} current={current} onEnd={jumpToEnd} />}
          <DayWatch.Provider value={watch}>{children}</DayWatch.Provider>
        </div>
      </div>
    </div>
  )
})

/** The popup's three jumps: drawn as buttons in one row, 44px tall at every width. A narrow popup breaks their words over two lines rather than the row. */
const JUMP = "min-h-11! min-w-0 flex-1 basis-0 px-2! leading-tight whitespace-normal! transition-none @max-[15rem]/day:px-1!"
/** The rail's rows start under its padding and its label. */
const RAIL_HEAD = 28
/** A milestone's row in the popup, as one target: 44px tall, its title wrapping in it. Too narrow for its title, it sends its PRs and then its own trailing word to a line below; a narrow popup always has the PRs on a line of their own. */
const SUMMARY_ROW = "flex min-h-11 min-w-0 flex-1 basis-64 @max-[22rem]/day:basis-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg px-2 py-1.5 text-left wrap-anywhere text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-yard-400"
/** A long group of milestones shows this many, then its "Show all N". One more than this is shown whole: the button would take the row it hid. */
const GROUP_ROWS = 5
/** A PR or issue at a row's end: drawn as a small link, 44px to a finger (its row is that tall). */
const SUMMARY_REF = cx(TAP_AREA, "inline-block h-7 shrink-0 rounded px-1 leading-7 whitespace-nowrap text-sky-400 hover:underline focus-visible:outline-2 focus-visible:outline-sky-400")

/** A rail day's name. "Today" and "Yesterday" say their date too: the button shows it, and its name has to hold what it shows. */
function railName(at: number, now: number) {
  const label = dayLabel(at, now)
  return /\d/.test(label) ? label : `${label}, ${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
}

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
  /** A narrow panel's way to the rail: it names the open day, else the day being read (the newest, until one is). */
  const chip = useRef<HTMLButtonElement>(null)
  const scrim = useRef<HTMLDivElement>(null)
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
  const reading = days[currentAt] ?? days.at(-1)
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
  // A day opened: it's in view in the rail (a narrow panel's rail was hidden until now, so it kept no scroll).
  const openAt = open ? days.findIndex((d) => d.key === open) : -1
  useLayoutEffect(() => {
    const el = nav.current
    if (!el || openAt < 0) return
    const top = RAIL_HEAD + openAt * 44
    if (top >= el.scrollTop && top + 44 <= el.scrollTop + el.clientHeight) return
    el.scrollTop = Math.max(0, top + 22 - el.clientHeight / 2)
    setRailTop(el.scrollTop)
  }, [openAt])
  // A day opened: the keyboard continues in its popup. Esc brings the focus back to the day.
  useLayoutEffect(() => {
    if (open) popup.current?.querySelector<HTMLElement>("[data-day-jump]")?.focus({ preventScroll: true })
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      const at = e.target as Node
      // The chip closes it itself, and so does the scrim.
      if (!nav.current?.contains(at) && !popup.current?.contains(at) && !chip.current?.contains(at) && at !== scrim.current) setOpen(null)
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
      {/* A narrow panel keeps its width for the chat: the rail waits behind this chip, in a row of its own over the
          chat. It opens the day being read, with the rail beside it to pick another. */}
      {reading && (
        <div className="hidden h-10 shrink-0 items-center border-b border-zinc-900 px-2 @max-[28rem]/history:flex">
          <button
            ref={chip}
            type="button"
            data-day-chip
            aria-label={`Chat days: ${dayLabel((day ?? reading).at, now)}`}
            aria-expanded={open !== null}
            aria-controls={open ? popupId : undefined}
            onClick={() => {
              anchor.current = chip.current
              setOpen((was) => (was ? null : reading.key))
            }}
            className={cx(
              TAP_AREA,
              "inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border px-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yard-400",
              open ? "border-yard-400/60 bg-yard-500/10 text-yard-300" : "border-zinc-800 text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100",
            )}
          >
            <CalendarDays aria-hidden className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{dayLabel((day ?? reading).at, now)}</span>
            <ChevronDown aria-hidden className="h-3 w-3 shrink-0" />
          </button>
        </div>
      )}
      {/* A narrow panel: the rail and the popup lie over the chat, which is dimmed under them so its text doesn't
          show between and around them. Before them, so under them at the same z-index. A tap on it closes them as its tap ends (not as it lands, or the tap would
          end on the chat under it). */}
      {day && <div ref={scrim} aria-hidden data-day-scrim onClick={close} className="absolute inset-x-0 top-10 bottom-0 z-20 hidden bg-zinc-950/85 @max-[28rem]/history:block" />}
      <nav
        ref={nav}
        onScroll={(e) => setRailTop(e.currentTarget.scrollTop)}
        aria-label={`Chat days${complete ? "" : " (recent only; older dates may be missing)"}: activate to preview`}
        className={cx(
          "scroll-thin w-11 shrink-0 overflow-x-hidden overflow-y-auto border-r border-zinc-900 py-2",
          // Behind the chip in a narrow panel; out over the chat's edge, under the chip's row, while a day is open.
          open
            ? "@max-[28rem]/history:absolute @max-[28rem]/history:top-10 @max-[28rem]/history:bottom-0 @max-[28rem]/history:left-0 @max-[28rem]/history:z-20 @max-[28rem]/history:bg-zinc-950"
            : "@max-[28rem]/history:hidden",
        )}
      >
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
              aria-label={`${railName(d.at, now)}: preview day summary`}
              aria-current={d.key === current ? "date" : undefined}
              aria-expanded={d.key === open}
              aria-controls={d.key === open ? popupId : undefined}
              onClick={(e) => {
                // Esc returns to this day; in a narrow panel to the chip, since the rail goes with the popup.
                anchor.current = chip.current?.offsetParent ? chip.current : e.currentTarget
                setRover(d.key)
                setOpen(d.key)
              }}
              className={cx(
                "flex h-11 min-h-11 w-11 flex-col items-center justify-center border-l-2 text-[11px] leading-tight focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-yard-400",
                // Only the open day is filled. The day being read is marked in its text and a thin bar, so it doesn't
                // read as the focus or as a second open day.
                d.key === open ? "border-yard-400 bg-yard-500/10 text-yard-300" : d.key === current ? "border-zinc-500 font-semibold text-zinc-100 hover:bg-zinc-900" : "border-transparent text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
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
        // The title and the jumps stay put; the milestones scroll under them. A panel too short for both (the list
        // keeps a row or two: min-h) scrolls the popup instead.
        <div ref={popup} id={popupId} role="region" aria-label={`${dayLabel(day.at, now)} work summary`} className="@container/day scroll-thin absolute top-2 left-12 z-20 flex max-h-[calc(100%-1rem)] w-[calc(100%-3.5rem)] max-w-sm flex-col overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 text-xs shadow-xl @max-[28rem]/history:top-12 @max-[28rem]/history:left-11 @max-[28rem]/history:max-h-[calc(100%-3.5rem)] @max-[28rem]/history:w-[calc(100%-3.25rem)] @max-[28rem]/history:max-w-none">
          <div role="group" aria-label="Transcript navigation" className="shrink-0 border-b border-zinc-800 px-3 pt-1 pb-3">
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 font-semibold text-zinc-100">{dayLabel(day.at, now)}</p>
              <DismissButton kind="close" className="-mr-1.5 h-11 w-11 transition-none!" onClick={close} label="Close day summary" />
            </div>
            {/* The three jumps in one row, in the chat's order: its start, this day (the one the popup is for, so the
                tinted one), its end. */}
            <div className="mt-1 flex gap-1.5 @max-[15rem]/day:gap-1">
              <Button size="sm" className={JUMP} disabled={!complete} title={complete ? undefined : "Load all chat dates to jump to start"} onClick={() => jump(days[0]!)}>Jump to start</Button>
              {/* It takes the focus as the day opens: a held Enter on the day must not also jump. */}
              <Button data-day-jump size="sm" className={cx(JUMP, "bg-yard-500/15! text-yard-200! hover:bg-yard-500/25!")} onKeyDown={(e) => { if (e.repeat) e.preventDefault() }} onClick={() => jump(day)}>Jump to day</Button>
              <Button size="sm" className={JUMP} onClick={() => { setOpen(null); onEnd() }}>Jump to end</Button>
            </div>
          </div>
          {/* scroll-pt: a row the keyboard reaches stops clear of its group's pinned heading. */}
          <div data-day-groups className={cx("scroll-thin flex-1 scroll-pt-8 overflow-y-auto px-3 pb-3", bullets.length > 1 ? "min-h-24" : "min-h-11")}>
            {bullets.length > 0 ? (
              <DayGroups key={day.key} bullets={bullets} taskId={taskId} onShow={(b) => jump(day, b.sourceMessageId, true)} onOpen={() => setOpen(null)} />
            ) : <p className="py-3 text-zinc-400">No task milestones on this day.</p>}
          </div>
        </div>
      )}
    </>
  )
})

/**
 * A day's milestones, by kind, each group under a heading that stays at the top while its rows scroll. A long group
 * shows its first rows and a "Show all N" that opens the rest in place. Keyed by the day, so every day starts folded.
 */
function DayGroups({ bullets, taskId, onShow, onOpen }: { bullets: DaySummary[]; taskId?: string; onShow: (summary: DaySummary) => void; onOpen: () => void }) {
  const [whole, setWhole] = useState<readonly DaySummaryKind[]>([])
  const opened = useRef<HTMLElement | null>(null)
  // The button that opened a group is gone: the keyboard goes on at the first row it revealed.
  useLayoutEffect(() => {
    const list = opened.current
    opened.current = null
    if (list) (list.querySelector<HTMLElement>(`li:nth-child(n+${GROUP_ROWS + 1}) :is(button, a)`) ?? list).focus()
  }, [whole])
  return (
    <div className="space-y-2">
      {DAY_SUMMARY_GROUPS.map((g) => {
        const rows = bullets.filter((b) => b.kind === g.kind)
        if (!rows.length) return null
        const folded = rows.length > GROUP_ROWS + 1 && !whole.includes(g.kind)
        return (
          <section key={g.kind} data-summary-group={g.kind}>
            <h3 className="sticky top-0 z-10 bg-zinc-900 px-2 pt-2 pb-1 text-[11px] text-zinc-400">{g.label} <span aria-hidden>·</span> {rows.length}</h3>
            <ul role="list" tabIndex={-1} className="outline-none">
              {(folded ? rows.slice(0, GROUP_ROWS) : rows).map((b, i) => (
                <SummaryRow
                  key={b.taskId ?? `${i}:${b.title}`}
                  summary={b}
                  // The task's own page has nowhere else to open it.
                  openTask={Boolean(b.taskId) && b.taskId !== taskId}
                  onShow={() => onShow(b)}
                  onOpen={onOpen}
                />
              ))}
            </ul>
            {folded && (
              <button
                type="button"
                data-summary-more
                onClick={(e) => {
                  opened.current = e.currentTarget.previousElementSibling as HTMLElement | null
                  setWhole((kinds) => [...kinds, g.kind])
                }}
                className="flex min-h-11 w-full items-center rounded-lg px-2 text-left font-medium text-yard-300 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-yard-400"
              >
                Show all {rows.length}
                <span className="sr-only"> in {g.label}</span>
              </button>
            )}
          </section>
        )
      })}
    </div>
  )
}

/** A row's trailing word and glyph, at every width: the glyph alone doesn't say where the row goes. They keep to the row's end, also on a line of their own. */
const SUMMARY_WORD = "ml-auto flex shrink-0 items-center gap-2 text-[11px] text-zinc-400"

/**
 * A milestone's task as it is now. Its own look at the tasks the app has loaded, so a status update redraws this
 * icon and not the day's summaries. A task that's gone has none.
 */
function SummaryIcon({ taskId }: { taskId: string }) {
  const select = useCallback((tasks: Task[]) => {
    const t = tasks.find((t) => t.id === taskId)
    return t ? { id: t.id, title: t.title, icon: t.icon, projectId: t.projectId, status: t.status } : null
  }, [taskId])
  const task = useQuery({ queryKey: keys.tasks, queryFn: fetchTasks, enabled: false, select }).data
  return task ? <TaskStatusIcon task={task} size="sm" /> : null
}

/**
 * One milestone: the task's title as the row's one target, and its PRs and issues as links at the row's end (beside
 * the target, never inside it). With a message in this chat the row shows it there; otherwise it opens the task.
 */
function SummaryRow({ summary, openTask, onShow, onOpen }: { summary: DaySummary; openTask: boolean; onShow: () => void; onOpen: () => void }) {
  const title = (
    <>
      {summary.taskId && <SummaryIcon taskId={summary.taskId} />}
      <span className="min-w-0 flex-1 basis-24">{summary.title}</span>
    </>
  )
  return (
    <li className="flex flex-wrap items-center gap-x-1">
      {summary.sourceMessageId ? (
        <button type="button" data-summary-jump title="Show in chat" onClick={onShow} className={SUMMARY_ROW}>
          {title}
          <span className={SUMMARY_WORD}>
            Show in chat
            <ArrowDownRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-yard-300" />
          </span>
        </button>
      ) : openTask ? (
        // AppLink keeps its click to itself, so the popup closes on the way down.
        <span data-summary-open className="contents" onClickCapture={onOpen}>
          <AppLink href={routes.task(summary.taskId!)} className={SUMMARY_ROW}>
            {title}
            <span className={SUMMARY_WORD}>
              Open
              <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
            </span>
          </AppLink>
        </span>
      ) : (
        <span data-summary-plain className="flex min-w-0 flex-1 items-center @max-[22rem]/day:basis-full gap-2 px-2 py-1.5 wrap-anywhere text-zinc-300">{title}</span>
      )}
      {summary.refs.length > 0 && (
        // At the row's end; in a narrow popup on a line of their own, close under the title and starting where it does.
        <span className="ml-auto flex max-w-full shrink-0 flex-wrap items-center gap-x-2 pr-1 pointer-coarse:min-h-11 pointer-coarse:gap-y-4 @max-[22rem]/day:-mt-1.5 @max-[22rem]/day:mr-auto @max-[22rem]/day:mb-1.5 @max-[22rem]/day:ml-7 @max-[22rem]/day:min-h-0! @max-[22rem]/day:max-w-[calc(100%-1.75rem)]">
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
