// The panels beside the chat (OverlayHost), left to right, like columns in a file browser: `?session=<task>&stack=
// <a>,<b>` opens the task, then a beside it, then b. Each panel has a ref: a task's id, or `captain.<project>` /
// `schedule.<id>` for a Captain or a schedule among them. The first panel is the overlay's own param
// (lib/overlays.ts), the rest are the stack. Which panels an opening leaves follows the pins (lib/columns.ts):
// on a desktop just the pinned ones, in the tree's order; on a phone it takes the rightmost panel's place, and a
// sub-task link opens beside its task (openBeside) for the crumbs to step back up (lib/treeNav.ts). Where only one
// panel fits (a phone, a narrow window) only the last shows and its Back closes it (OverlayHost).
import { createContext, useContext, useMemo } from "react"
import { useLocationProperty } from "wouter/use-browser-location"
import type { Task } from "../../../shared/types"
import { OVERLAY_PARAMS, STACK_PARAM, overlayAt, readableQuery, type Overlay } from "./overlays"
import { SIDEBAR_INLINE } from "./sidebar"

export { STACK_PARAM }
/** Opening a panel adds a history entry; this marks it, so closing it can step back over it. */
const STACK_MARK = "boxyardStack"
const MARK = "boxyardOverlay"
const PANEL_REF = /^(?:(?:captain|schedule)\.)?[\w-]{1,64}$/

const currentHref = () => location.pathname + location.search + location.hash

/** A view's panel ref: a task's id as it is, a Captain's or a schedule's with its kind first. */
export const refOf = (view: Overlay): string => (view.kind === "session" ? view.id : `${view.kind}.${view.id}`)

/** The view a panel ref shows. */
export function viewOf(ref: string): Overlay {
  const m = /^(captain|schedule)\.(.+)$/.exec(ref)
  return m ? { kind: m[1] as "captain" | "schedule", id: m[2]! } : { kind: "session", id: ref }
}

/** The panels after the first in `href`. Only beside an open view. */
export function stackAt(href: string): string[] {
  const url = new URL(href, location.origin)
  if (!overlayAt(href)) return []
  return (url.searchParams.get(STACK_PARAM) ?? "").split(",").filter((ref) => PANEL_REF.test(ref))
}

/** The URL with its view's stack set to `refs` (none: no stack). */
export function withStack(href: string, refs: readonly string[]): string {
  const url = new URL(href, location.origin)
  if (refs.length) url.searchParams.set(STACK_PARAM, refs.join(","))
  else url.searchParams.delete(STACK_PARAM)
  return url.pathname + readableQuery(url.search) + url.hash
}

/** Every panel's ref, left to right: the view's, then the stack's. Empty without a view. */
export function panelsAt(href: string): string[] {
  const view = overlayAt(href)
  return view ? [refOf(view), ...stackAt(href)] : []
}

/** The URL with exactly these panels open, left to right (none: just the chat). The first one keeps its hash. */
export function panelsHref(href: string, refs: readonly string[]): string {
  const url = new URL(href, location.origin)
  const first = refs[0] ? viewOf(refs[0]) : null
  const before = overlayAt(href)
  for (const key of OVERLAY_PARAMS) url.searchParams.delete(key)
  url.searchParams.delete(STACK_PARAM)
  if (first) url.searchParams.set(first.kind, first.id)
  if (refs.length > 1) url.searchParams.set(STACK_PARAM, refs.slice(1).join(","))
  if (!first || before?.kind !== first.kind || before.id !== first.id) url.hash = ""
  return url.pathname + readableQuery(url.search) + url.hash
}

/** `href` with task `taskId` opened right after panel `index`, in place of any after it (a phone's sub-task: lib/treeNav.ts). */
export function stackHref(href: string, index: number, taskId: string): string {
  const panels = panelsAt(href)
  return withStack(href, [...panels.slice(1, index + 1), taskId])
}

/** A task's own URL with its chain open: its top task first, then each sub-task down to it (`parentOf` walks up). */
export function chainHref(taskId: string, parentOf: (id: string) => string | null | undefined): string {
  const chain = [taskId]
  for (let id = parentOf(taskId); id && chain.length < 12 && !chain.includes(id); id = parentOf(id)) chain.unshift(id)
  const [top, ...rest] = chain
  const url = new URL("/", location.origin)
  url.searchParams.set("session", top!)
  if (rest.length) url.searchParams.set(STACK_PARAM, rest.join(","))
  return url.pathname + readableQuery(url.search)
}

/** The same first panel with different ones beside it: the panels change, the conversation trail stays (closeOverlay). */
export function sameSession(a: string, b: string): boolean {
  const x = overlayAt(a)
  const y = overlayAt(b)
  return Boolean(x && y && x.kind === y.kind && x.id === y.id)
}

/** History state for a stack change: one more entry in the overlay's trail, marked as a panel opening. */
export function stackHistoryState(to: string): object {
  const mark = history.state?.[MARK] as { depth?: number } | undefined
  return { ...history.state, ...(mark ? { [MARK]: { ...mark, depth: (mark.depth ?? 1) + 1 } } : {}), [STACK_MARK]: { from: currentHref(), to } }
}

/** History state for an entry that changed the panels from `from` to `to`, so closing what it added can step back over it. */
export const panelsOpening = (from: string, to: string): object => ({ [STACK_MARK]: { from, to } })

/**
 * Close panel `index` alone: the panels on either side stay where they are. Back over the entry that opened it when
 * that's where we are; with none left, the view closes as it always has (closeOverlay). Returns the panels left.
 */
export function closeStackPanel(index: number, closeAll: () => void): string[] {
  const href = currentHref()
  const panels = panelsAt(href)
  if (index < 0 || index >= panels.length) return panels
  const rest = panels.filter((_, i) => i !== index)
  if (!rest.length) {
    closeAll()
    return rest
  }
  const to = panelsHref(href, rest)
  const opened = history.state?.[STACK_MARK] as { from?: string; to?: string } | undefined
  if (opened?.to === href && opened.from === to) history.back()
  else history.replaceState(history.state, "", to)
  return rest
}

/** Close panel `index` and every one after it (a phone's Up: lib/treeNav.ts), stepping back when that opened them. */
export function closeStackFrom(index: number) {
  const href = currentHref()
  const panels = panelsAt(href)
  if (index < 1 || index >= panels.length) return
  const to = panelsHref(href, panels.slice(0, index))
  const opened = history.state?.[STACK_MARK] as { from?: string; to?: string } | undefined
  if (opened?.to === href && opened.from === to) return history.back()
  history.replaceState(history.state, "", to)
}

type Click = { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean; preventDefault(): void }
type TreeTask = Pick<Task, "id" | "parentTaskId" | "rootTaskId">
const rootOf = (t: TreeTask) => t.rootTaskId ?? t.id

/**
 * On a phone (no pins there), a plain click on a link to a task in the same sub-task tree as panel `index`'s (its
 * sub-task, its parent): open it in the panel beside, closing any past it. Returns whether it did; other links, and any
 * link on a wider window, show just what they open beside the pins (lib/navigation.ts showOnly).
 */
export function openBeside(e: Click, destination: string, index: number, tasks: readonly TreeTask[] | undefined, navigate: (to: string) => void): boolean {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false
  if (matchMedia(`(min-width: ${SIDEBAR_INLINE}px)`).matches) return false
  const target = overlayAt(destination)
  const href = currentHref()
  const panels = panelsAt(href)
  const here = panels[index]
  if (target?.kind !== "session" || !here || target.id === here) return false
  const from = tasks?.find((t) => t.id === here)
  const to = tasks?.find((t) => t.id === target.id)
  if (!from || !to || rootOf(from) !== rootOf(to)) return false
  e.preventDefault()
  navigate(stackHref(href, index, target.id))
  return true
}

/** Every panel's ref, live (none without a view). */
export function usePanels(): string[] {
  const raw = useLocationProperty(() => panelsAt(currentHref()).join(","))
  return useMemo(() => (raw ? raw.split(",") : NO_PANELS), [raw])
}
const NO_PANELS: string[] = []

/** Which panel a control sits in: its place, left to right, and its ref (lib/columns.ts keys its state by it). */
export interface PanelPlace {
  index: number
  ref: string
}
export const PanelStackContext = createContext<PanelPlace | null>(null)
export const usePanelPlace = () => useContext(PanelStackContext)
