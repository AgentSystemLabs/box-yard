import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import { useQuery } from "@tanstack/react-query"
import type { Project, Task } from "../../../shared/types"
import { ArrowDownRight, GitPullRequest } from "lucide-react"
import { dayKey, dayLabel } from "../lib/calendarDay"
import { api } from "../lib/api"
import { daySummaries, type ChatDay } from "../lib/chatDays"
import { splitGithubRefs } from "../lib/linkify"
import type { NoticeLike } from "../lib/publishedNotices"
import { fetchTasks, keys } from "../lib/queries"
import { REVEAL_CHAT_EVENT, revealChatMessage, type ChatReveal } from "../lib/reveal"
import type { HistoryIndexState } from "../lib/transcriptHistory"
import { Loading } from "./Loading"
import { DismissButton } from "./Modal"
import { releaseListBottom, scrollIntoList, type StickyScrollHandle } from "./StickyScroll"
import { Button, cx, NewTabLink } from "./ui"

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

const DayDivider = memo(function DayDivider({ at, messageId }: { at: number; messageId: string }) {
  const now = useToday()
  return (
    <div data-day-start={messageId} tabIndex={-1} className="flex scroll-mt-3 items-center gap-3 py-2 text-xs text-zinc-400 outline-none focus-visible:text-yard-300">
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
        {days.length > 0 && <DayRail days={days} messages={messages} scope={scope} projectId={projectId} taskId={taskId} complete={!index || index.status === "ready"} onEnd={jumpToEnd} />}
        {children}
      </div>
    </div>
  )
})

const DayRail = memo(function DayRail({ days, messages, scope, projectId, taskId, complete, onEnd }: {
  days: ChatDay[]
  messages: readonly NoticeLike[]
  scope: string
  projectId?: string
  taskId?: string
  complete: boolean
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
  const railStart = Math.max(0, Math.floor((railTop - 28) / 44) - 12)
  const railEnd = Math.min(days.length, railStart + 80)
  const close = useCallback(() => {
    setOpen(null)
    anchor.current?.focus({ preventScroll: true })
  }, [])

  useLayoutEffect(() => {
    if (nav.current) { nav.current.scrollTop = nav.current.scrollHeight; setRailTop(nav.current.scrollTop) }
  }, [lastDay, days.length])
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
        <p aria-hidden className="py-1 text-center text-[10px] text-zinc-500">{complete ? "Days" : "Recent"}</p>
        {railStart > 0 && <div aria-hidden style={{ height: railStart * 44 }} />}
        {days.slice(railStart, railEnd).map((d, index) => (
          <button
            key={d.key}
            type="button"
            data-day-index={railStart + index}
            onKeyDown={(e) => {
              const here = railStart + index
              const direction = e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey) ? 1 : e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey) ? -1 : 0
              const next = e.key === "Home" ? 0 : e.key === "End" ? days.length - 1 : here + direction
              if ((!direction && e.key !== "Home" && e.key !== "End") || next < 0 || next >= days.length) return
              e.preventDefault()
              const top = Math.max(0, next * 44 - (nav.current?.clientHeight ?? 0) / 2)
              if (nav.current) nav.current.scrollTop = top
              setRailTop(top)
              requestAnimationFrame(() => nav.current?.querySelector<HTMLElement>(`[data-day-index="${next}"]`)?.focus({ preventScroll: true }))
            }}
            aria-label={`${dayLabel(d.at, now)}: preview day summary`}
            aria-expanded={d.key === open}
            aria-controls={d.key === open ? popupId : undefined}
            onClick={(e) => {
              anchor.current = e.currentTarget
              setOpen(d.key)
            }}
            className={cx("flex h-11 min-h-11 w-11 flex-col items-center justify-center border-l-2 text-[10px] leading-tight focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-yard-400", d.key === open ? "border-yard-400 bg-yard-500/10 text-yard-300" : "border-transparent text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300")}
          >
            <span>{new Date(d.at).toLocaleDateString(undefined, { month: "short" })}</span>
            <span className="text-xs font-semibold tabular-nums">{new Date(d.at).getDate()}</span>
          </button>
        ))}
        {railEnd < days.length && <div aria-hidden style={{ height: (days.length - railEnd) * 44 }} />}
      </nav>
      {day && (
        <div ref={popup} id={popupId} role="region" aria-label={`${dayLabel(day.at, now)} work summary`} className="scroll-thin absolute top-2 left-12 z-20 max-h-[calc(100%-1rem)] w-[calc(100%-3.5rem)] max-w-sm overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-3 text-xs shadow-xl">
          <div className="flex min-h-11 items-center justify-between gap-2">
            <p className="font-semibold text-zinc-100">{dayLabel(day.at, now)}</p>
            <DismissButton kind="close" className="h-11 w-11 transition-none!" onClick={close} label="Close day summary" />
          </div>
          <div role="group" aria-label="Transcript navigation" className="mb-3 flex flex-wrap gap-2">
            <Button variant="ghost" className="min-h-11! flex-1 transition-none" disabled={!complete} title={complete ? undefined : "Load all chat dates to jump to start"} onClick={() => jump(days[0]!)}>Jump to start</Button>
            <Button variant="ghost" className="min-h-11! flex-1 transition-none" onClick={() => { setOpen(null); onEnd() }}>Jump to end</Button>
          </div>
          {bullets.length > 0 ? (
            <ul className="list-disc space-y-2 pl-4 text-zinc-300">
              {bullets.map((b, i) => <li key={i} className="wrap-anywhere"><div
                role="link"
                tabIndex={0}
                data-summary-jump
                onClick={() => jump(day, b.sourceMessageId, true)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return
                  e.preventDefault()
                  jump(day, b.sourceMessageId, true)
                }}
                className="min-h-11 cursor-pointer rounded-lg border border-zinc-700/80 px-2 py-2 hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-yard-400"
              >{splitGithubRefs(b.text, b.repo).map((s, j) => s.url && s.kind !== "commit" ? (
                <NewTabLink key={j} href={s.url} mark="end" className="inline-flex min-h-11 min-w-11 max-w-full items-center justify-center gap-1 rounded px-1 py-1 align-middle text-sky-400 underline decoration-sky-400/40 underline-offset-2 focus-visible:outline-2 focus-visible:outline-sky-400">
                  {s.kind === "pull" && <GitPullRequest aria-hidden className="h-3.5 w-3.5 shrink-0" />}
                  <span className="min-w-0 wrap-anywhere">{s.label ?? s.text}</span>
                </NewTabLink>
              ) : <span key={j}>{s.text}</span>)}
                <span className="mt-1 flex items-center gap-1 text-[11px] font-medium text-yard-300"><ArrowDownRight aria-hidden className="h-3.5 w-3.5 shrink-0" />{b.sourceMessageId ? "Jump to message" : "Jump to day"}</span>
              </div></li>)}
            </ul>
          ) : <p className="py-1 text-zinc-400">No task milestones in the loaded messages. Jump to this day to read more.</p>}
          <p className="mt-3 text-[11px] text-zinc-400">Tap a summary to find it in chat. Links open GitHub.</p>
          <button type="button" onClick={() => jump(day)} className="mt-2 min-h-11 w-full rounded-lg border border-zinc-700 px-3 text-left font-medium text-yard-300 hover:bg-zinc-800">Jump to day</button>
        </div>
      )}
    </>
  )
})
