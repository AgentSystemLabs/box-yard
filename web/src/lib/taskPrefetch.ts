// Opening a task (a sidebar row, a link to it, a notice) finds its conversation in memory: a press, a hover that rests
// on it or keyboard focus starts loading its messages before the click, and parses the Markdown its first screen shows
// while the browser is idle. React Query's cache only, like every conversation: nothing goes to browser storage
// (test/captain-prefetch.test.ts).
import { useEffect } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { fetchTaskMessages, keys } from "./queries"
import { currentEntityIndex } from "./entities"
import { repoScopeKey, resolveRepoScope } from "./repoScope"
import { overlayAt } from "./overlays"
import { APP_HOME, appHref } from "./navigation"
import { warmMarkdown } from "../components/ui"
import type { TaskMessage } from "../../../shared/types"

/** A hover this long means it: the pointer sweeping across the sidebar loads nothing. */
export const HOVER_INTENT_MS = 65
/** The newest messages a task opens on (useTail's first screen in TaskThread). */
const OPENS_ON = 60

/** The task a press on `el` opens: a row marked data-open-task, or a link (href, data-href) to its conversation. */
export function taskToOpen(el: EventTarget | null): string | null {
  const target = el instanceof Element ? el.closest<HTMLElement>("[data-open-task], a[href], [data-href]") : null
  if (!target) return null
  if (target.dataset.openTask) return target.dataset.openTask
  const href = target.getAttribute("href") ?? target.dataset.href
  const to = href ? appHref(href, location.origin) : null
  const view = to?.startsWith(APP_HOME) ? overlayAt(to) : null
  return view?.kind === "session" ? view.id : null
}

/** The texts TaskThread renders as Markdown among the messages a task opens on, newest last. */
export function openingMarkdown(messages: readonly TaskMessage[]): string[] {
  const shown = messages.filter((m) => m.role !== "tool").slice(-OPENS_ON)
  return shown.flatMap((m) => (m.role === "assistant" || m.meta?.kind === "hook" ? [m.content] : []))
}

/** Load a task's messages unless they're in memory and fresh, then parse what it opens on in idle time. */
export function warmTask(qc: QueryClient, id: string): Promise<void> {
  return qc.prefetchQuery({ queryKey: keys.taskMessages(id), queryFn: () => fetchTaskMessages(id, qc) }).then(() => {
    const messages = qc.getQueryData<TaskMessage[]>(keys.taskMessages(id))
    const index = currentEntityIndex()
    // In the task's repo, as its page's <InRepo> links it.
    if (messages && index) warmMarkdown(openingMarkdown(messages), index, resolveRepoScope(repoScopeKey({ taskId: id }), index))
  })
}

/** Mounted once (App), signed in: warm the task under a press, a resting hover or focus. */
export function useWarmTaskOnIntent(enabled: boolean) {
  const qc = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    // The task under the pointer or focus, and the wait before warming it.
    let over: string | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const warm = (id: string) => void warmTask(qc, id).catch(() => {})
    const rest = (e: Event) => {
      const id = taskToOpen(e.target)
      if (id === over) return
      over = id
      clearTimeout(timer)
      if (id) timer = setTimeout(() => warm(id), HOVER_INTENT_MS)
    }
    const hover = (e: PointerEvent) => e.pointerType !== "touch" && rest(e)
    // A finger or a button going down: the click is coming (on a phone, once the finger lifts).
    const press = (e: Event) => {
      over = taskToOpen(e.target)
      clearTimeout(timer)
      if (over) warm(over)
    }
    const opts = { capture: true, passive: true }
    document.addEventListener("pointerover", hover, opts)
    document.addEventListener("focusin", rest, opts)
    document.addEventListener("pointerdown", press, opts)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("pointerover", hover, opts)
      document.removeEventListener("focusin", rest, opts)
      document.removeEventListener("pointerdown", press, opts)
    }
  }, [enabled, qc])
}
