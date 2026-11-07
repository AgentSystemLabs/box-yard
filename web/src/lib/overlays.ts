// One URL-backed view in the shared side panel. History records the conversation trail without stacking views.
import { useLocationProperty } from "wouter/use-browser-location"

export const OVERLAY_PARAMS = ["session", "captain", "schedule"] as const
/** Panels stacked to the right of a session's (lib/panelStack.ts): task ids, comma separated. */
export const STACK_PARAM = "stack"
/** A query string with its stack's commas left readable (URLSearchParams writes them as %2C). */
export const readableQuery = (search: string) => search.replace(/%2C/gi, ",")
export type Overlay = { kind: typeof OVERLAY_PARAMS[number]; id: string }
type ReturnTo = { opened: Overlay; depth?: number; direct?: boolean; parents?: Overlay[] }
const MARK = "boxyardOverlay"

export function overlayAt(href: string): Overlay | null {
  const url = new URL(href, location.origin)
  if (url.pathname !== "/") return null
  for (const kind of OVERLAY_PARAMS) {
    const id = url.searchParams.get(kind)
    if (id) return { kind, id }
  }
  return null
}

const same = (a: Overlay | null, b: Overlay | null) => a?.kind === b?.kind && a?.id === b?.id
const currentHref = () => location.pathname + location.search + location.hash
const returnTo = (): ReturnTo | null => history.state?.[MARK] ?? null

/** Replace the panel view while keeping project/card picks and the source chat intact. */
export function overlayNavigation(to: string): { to: string; state: object } | null {
  const opened = overlayAt(to)
  if (!opened) return null
  const current = overlayAt(currentHref())
  const mark = returnTo()
  const linked = mark && same(mark.opened, current)
  const depth = linked ? mark.depth ?? (mark.parents?.length ?? 0) + 1 : 0
  const url = new URL(location.href)
  for (const key of OVERLAY_PARAMS) url.searchParams.delete(key)
  url.searchParams.delete(STACK_PARAM)
  url.searchParams.delete("task")
  url.searchParams.delete("project")
  url.searchParams.set(opened.kind, opened.id)
  const target = new URL(to, location.origin)
  // The panels beside it come along (lib/columns.ts places an opening among the pinned ones).
  const stack = target.searchParams.get(STACK_PARAM)
  if (stack) url.searchParams.set(STACK_PARAM, stack)
  url.hash = target.hash
  return {
    to: url.pathname + readableQuery(url.search) + url.hash,
    state: { ...history.state, [MARK]: { opened, depth: depth + 1, direct: linked ? mark.direct : Boolean(current) } satisfies ReturnTo },
  }
}

/** Panel Back/Esc closes the whole panel; browser Back still traverses its conversation trail. */
export function closeOverlay() {
  const mark = returnTo()
  if (mark && !mark.direct && same(mark.opened, overlayAt(currentHref()))) {
    history.go(-(mark.depth ?? (mark.parents?.length ?? 0) + 1))
    return
  }
  dismissOverlay()
}

/** Switching to a question uses the same panel slot without traversing unrelated history. */
export function dismissOverlay() {
  history.replaceState(null, "", withoutOverlay())
}

/**
 * Picking the Coordinator or a Captain in the sidebar gives that chat the whole width: an open task's panel closes.
 * A step of its own in history, like following a link to a Captain, so Back opens the task again. The one place a
 * pick closes the task, so whatever the panel stacks beside it closes here too. `state`: the new entry's (lib/treeNav.ts
 * says which chat it shows).
 */
export function closeTaskPanel(state: object | null = null) {
  if (overlayAt(currentHref())?.kind === "session") history.pushState(state, "", withoutOverlay())
}

function withoutOverlay() {
  const url = new URL(location.href)
  for (const key of OVERLAY_PARAMS) url.searchParams.delete(key)
  url.searchParams.delete(STACK_PARAM)
  url.hash = ""
  return url.pathname + url.search
}

// Whose task a panel shows, and under which task: App's task list answers (lib/centreCaptain.ts), so this module never
// reads the cache.
type TaskPlace = { projectId: string; parentTaskId: string | null }
let taskPlace: (taskId: string) => TaskPlace | null = () => null
export const setTaskProbe = (probe: (taskId: string) => TaskPlace | null) => void (taskPlace = probe)

/** The project of task `taskId`, or null: one that hasn't loaded. */
export const projectOfTask = (taskId: string): string | null => taskPlace(taskId)?.projectId ?? null
/** The task `taskId` is a sub-task of, or null: a top task, or one that hasn't loaded. */
export const taskParent = (taskId: string): string | null => taskPlace(taskId)?.parentTaskId ?? null

/** Preserve return history when an existing view updates its query string in place. */
export function overlayHistoryState(to: string) {
  return same(overlayAt(to), overlayAt(currentHref())) ? history.state : null
}

export function useOverlay(): Overlay | null {
  const href = useLocationProperty(currentHref)
  return overlayAt(href)
}
