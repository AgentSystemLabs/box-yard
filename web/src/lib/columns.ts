// The columns on a desktop (OverlayHost): the chat, then the panels beside it (lib/panelStack.ts). Anything opened
// (a sidebar row, search, a link, a crumb, a strip) shows just itself and whatever is pinned (arrangement): the
// unpinned panels close, and so does the chat, unless it's pinned or it's what was opened. Anything can be pinned: the
// Coordinator, a Captain, a task, a sub-task, a schedule. What shows is laid out in the tree's order (orderRefs): the
// Coordinator, a Captain, its tasks, their sub-tasks, and pin order among the rest, the item opened in its place in it.
// The first one is the chat when it's the Coordinator or a Captain; otherwise the chat hides and the panels take its
// room, the rightmost filling it. A hidden chat stays hidden as tasks open, until a chat is picked (the sidebar, a
// crumb) or the last panel closes. Every column's header has Pin, and Close while another column is in view
// (ColumnControls.tsx); nothing folds.
// With the sidebar folded (its icon rail, or none) the levels above the item opened that aren't showing are strips
// beside it, each listing the level below (hierarchyStrips, Rails.tsx), and a Captain's chat showing lists its tasks
// in a bar beside it (Rails.tsx ChatBar), however it was opened.
// All of it is kept in memory only, never in web storage: a reload starts with nothing pinned.
// A phone keeps its own way (lib/navigation.ts): an opening takes the last panel's place (placedHref).
import { useCallback, useMemo, useSyncExternalStore } from "react"
import { useQuery } from "@tanstack/react-query"
import type { Task } from "../../../shared/types"
import { fetchTasks, keys } from "./queries"
import { closeOverlay, overlayAt, projectOfTask, taskParent } from "./overlays"
import { closeStackPanel, panelsAt, panelsHref, refOf, usePanels, viewOf } from "./panelStack"
import { SIDEBAR_INLINE } from "./sidebar"

/** The Coordinator's ref, as the chat or among the pins. A Captain's is `captain.<project>`, as a panel's. */
export const COORDINATOR_REF = "coordinator"
/** The ref of the chat showing `projectId`'s Captain, or the Coordinator's (null). */
export const chatRef = (projectId: string | null) => (projectId === null ? COORDINATOR_REF : `captain.${projectId}`)
/** The Coordinator or a Captain: what the chat can show. */
export const isChatRef = (ref: string) => ref === COORDINATOR_REF || ref.startsWith("captain.")
/** The project of a chat's ref (null: the Coordinator). */
export const chatProject = (ref: string) => (ref === COORDINATOR_REF ? null : ref.slice("captain.".length))

export interface ColumnsState {
  /** What's pinned, in the order it was pinned. */
  pins: readonly string[]
  /** The chat hidden: the panels take its room. */
  chatHidden: boolean
  /** The item opened last, as long as it shows (focusedRef). */
  focus: string | null
  /** The sidebar folded (its icon rail, or none on a narrow window): the levels above `focus` show as strips. */
  rails: boolean
}

const EMPTY: ColumnsState = { pins: [], chatHidden: false, focus: null, rails: false }
let state: ColumnsState = EMPTY
const listeners = new Set<() => void>()
const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}
function update(next: Partial<ColumnsState>) {
  state = { ...state, ...next }
  for (const cb of listeners) cb()
}

const currentHref = () => location.pathname + location.search + location.hash
const panelsNow = () => (typeof location === "undefined" ? [] : panelsAt(currentHref()))

/** Wide enough for columns beside the chat (a phone's way is its own: placedHref). */
export const isDesktop = () => typeof matchMedia === "function" && matchMedia(`(min-width: ${SIDEBAR_INLINE}px)`).matches

export const columnsState = () => state
export const useColumnsState = () => useSyncExternalStore(subscribe, columnsState, columnsState)
/** The item opened last, live (null: none yet). */
export const useFocus = () => useSyncExternalStore(subscribe, () => state.focus, () => null)
/** The chat hidden, live. */
export const useChatHidden = () => useSyncExternalStore(subscribe, () => state.chatHidden, () => false)

// ---------------------------------------------------------------- pins

export const isPinned = (ref: string) => state.pins.includes(ref)
export const usePinned = (ref: string) => useSyncExternalStore(subscribe, () => state.pins.includes(ref), () => false)

export function setPinned(ref: string, on: boolean) {
  if (isPinned(ref) === on) return
  update({ pins: on ? [...state.pins, ref] : state.pins.filter((p) => p !== ref) })
}
export const togglePinned = (ref: string) => setPinned(ref, !isPinned(ref))

/** Only the pins on what shows stay (App, as the columns change): Back, or a chat switched in its header, unpins the rest. */
export function keepPinsShown(shown: readonly string[]) {
  const pins = state.pins.filter((p) => shown.includes(p))
  if (pins.length !== state.pins.length) update({ pins })
}

// ---------------------------------------------------------------- the tree's order

/** The level above `ref`: a sub-task's task, a task's Captain, a Captain's (or a schedule's) Coordinator. Null: the top, or a task not loaded. */
export function refParent(ref: string): string | null {
  if (ref === COORDINATOR_REF) return null
  const view = viewOf(ref)
  if (view.kind !== "session") return COORDINATOR_REF
  const parent = taskParent(view.id)
  if (parent) return parent
  const project = projectOfTask(view.id)
  return project ? chatRef(project) : null
}

/**
 * `refs` (in pin order, the one opened last) in the tree's order: each after the nearest of its levels above among
 * them, and pin order among the rest (siblings, and unrelated trees), a tree going where its first pin is.
 */
export function orderRefs(refs: readonly string[], parentOf: (ref: string) => string | null = refParent): string[] {
  const set = new Set(refs)
  const rank = new Map(refs.map((r, i) => [r, i]))
  const above = (ref: string) => {
    let p = parentOf(ref)
    for (let n = 0; p !== null && !set.has(p) && n < 16; n++) p = parentOf(p)
    return p !== null && set.has(p) && p !== ref ? p : null
  }
  const kids = new Map<string | null, string[]>()
  for (const r of rank.keys()) kids.set(above(r), [...(kids.get(above(r)) ?? []), r])
  const low = new Map<string, number>()
  const lowest = (r: string, seen: Set<string>): number => {
    const known = low.get(r)
    if (known !== undefined) return known
    seen.add(r)
    const v = Math.min(rank.get(r)!, ...(kids.get(r) ?? []).filter((k) => !seen.has(k)).map((k) => lowest(k, seen)))
    low.set(r, v)
    return v
  }
  const out: string[] = []
  const walk = (p: string | null) => {
    for (const r of [...(kids.get(p) ?? [])].sort((a, b) => lowest(a, new Set()) - lowest(b, new Set()))) {
      if (out.includes(r)) continue
      out.push(r)
      walk(r)
    }
  }
  walk(null)
  // A loop in the data (never expected) leaves its refs out of the walk: they go last, as pinned.
  for (const r of rank.keys()) if (!out.includes(r)) out.push(r)
  return out
}

/** What shows on a desktop with `ref` opened: the pins and it, in the tree's order, the first as the chat when it's one. */
export function arrangement(ref: string, pins: readonly string[] = state.pins, parentOf?: (ref: string) => string | null): { chat: string | null; panels: string[] } {
  const order = orderRefs(pins.includes(ref) ? pins : [...pins, ref], parentOf)
  // The Coordinator is above everything, even a task whose project hasn't loaded yet.
  const top = order.indexOf(COORDINATOR_REF)
  if (top > 0) order.unshift(...order.splice(top, 1))
  const first = order[0]
  return first !== undefined && isChatRef(first) ? { chat: first, panels: order.slice(1) } : { chat: null, panels: order }
}

/** The item opened: the chat shows when it leads, else it hides. Set as it's opened (lib/navigation.ts). */
export function setOpened(ref: string, chatShown: boolean) {
  if (state.focus !== ref || state.chatHidden === chatShown) update({ focus: ref, chatHidden: !chatShown })
}

/** Back or Forward: the entry's own chat state and item opened, where it says them (lib/navigation.ts). */
export function restoreOpened(focus: string | null | undefined, chatHidden: boolean | undefined) {
  const next = { focus: focus === undefined ? state.focus : focus, chatHidden: chatHidden ?? state.chatHidden }
  if (next.focus !== state.focus || next.chatHidden !== state.chatHidden) update(next)
}

/**
 * The item opened, while it shows (`shown`: the chat's ref if it shows, then the panels'); else the newest unpinned
 * panel, else the newest panel, else the chat.
 */
export function focusedRef(shown: readonly string[], s: ColumnsState = state): string | null {
  if (s.focus && shown.includes(s.focus)) return s.focus
  for (let i = shown.length - 1; i >= 0; i--) if (!s.pins.includes(shown[i]!)) return shown[i]!
  return shown.at(-1) ?? null
}

// ---------------------------------------------------------------- the phone's placement

/**
 * Where `ref` goes among the panels open on a phone: in place of the rightmost unpinned one, else after them all. One
 * already open stays where it is.
 */
export function placeRefs(panels: readonly string[], ref: string, pinned: (ref: string) => boolean = isPinned): string[] {
  if (panels.includes(ref)) return [...panels]
  for (let i = panels.length - 1; i >= 0; i--) if (!pinned(panels[i]!)) return panels.map((p, j) => (j === i ? ref : p))
  return [...panels, ref]
}

/** The URL that opens `href`'s view (one task, Captain or schedule, from anywhere) among the panels open at `current`. */
export function placedHref(current: string, href: string): string {
  const view = overlayAt(href)
  return view ? panelsHref(href, placeRefs(panelsAt(current), refOf(view))) : href
}

/** The task the phone's chat follows to its Captain: the rightmost unpinned task panel's. */
export function followedTask(panels: readonly string[], pinned: (ref: string) => boolean = isPinned): string | null {
  for (let i = panels.length - 1; i >= 0; i--) {
    const view = viewOf(panels[i]!)
    if (view.kind === "session" && !pinned(panels[i]!)) return view.id
  }
  return null
}

/** The project of the task a phone's chat follows, or null: none open unpinned, one that hasn't loaded, or a desktop. */
export function followedTaskProject(): string | null {
  if (isDesktop()) return null
  const id = followedTask(panelsNow())
  return id ? projectOfTask(id) : null
}

/**
 * Close every unpinned panel: a chat picked takes the room, beside the pinned ones. `push`: a step of its own in
 * history, like following a link, so Back opens them again.
 */
export function closeUnpinnedPanels(push = false) {
  const href = currentHref()
  const panels = panelsAt(href)
  const kept = panels.filter((p) => isPinned(p))
  if (kept.length === panels.length) return
  const to = panelsHref(href, kept)
  if (push) history.pushState(null, "", to)
  else history.replaceState(kept.length ? history.state : null, "", to)
}

// ---------------------------------------------------------------- close

/** The chat's Close: it hides, unpinned, and the panels take its room. */
export function closeChat(ref: string) {
  update({ chatHidden: true, pins: state.pins.filter((p) => p !== ref) })
}

/** Panel `index`'s Close: it goes, alone, and forgets its pin. */
export function closePanel(index: number) {
  const ref = panelsNow()[index]
  closeStackPanel(index, closeOverlay)
  if (ref && isPinned(ref)) setPinned(ref, false)
}

/** The panels all closed (App): the chat shows again. Its pin stays, so the next task opens beside it. */
export function settleColumns() {
  if (state.chatHidden) update({ chatHidden: false })
}

/** The sidebar folded or not (App): strips list the levels above the item opened only while it is. */
export function setRails(on: boolean) {
  if (state.rails !== on) update({ rails: on })
}

/** Nothing pinned, the chat showing, nothing opened (tests). */
export function resetColumns() {
  state = EMPTY
  for (const cb of listeners) cb()
}

// ---------------------------------------------------------------- layout

/** A panel's look: open at its width, or open filling the room the chat left. */
export type Fold = "open" | "fill"

/**
 * A level above the item opened, as a strip just before panel `before` (the first of its descendants showing).
 * `below`: the level under it on the way to the item opened, which it marks.
 */
export interface Strip {
  ref: string
  before: number
  below: string
}

export interface ColumnLayout {
  chat: "open" | "closed"
  panels: Fold[]
  strips: Strip[]
}

/**
 * With the sidebar folded, the levels above `focus` (its Captain, its tasks above) that aren't showing, top first,
 * each before the first of its descendants among `panels`. The Coordinator has none: the sidebar's rail is its list.
 */
export function hierarchyStrips(focus: string | null, chat: string | null, panels: readonly string[], parentOf: (ref: string) => string | null = refParent): Strip[] {
  if (!focus || isChatRef(focus)) return []
  const chain: string[] = []
  for (let p = parentOf(focus); p !== null && p !== COORDINATOR_REF && chain.length < 16 && !chain.includes(p); p = parentOf(p)) chain.unshift(p)
  const isBelow = (ref: string, top: string) => {
    for (let p: string | null = ref, n = 0; p !== null && n < 16; p = parentOf(p), n++) if (p === top) return true
    return false
  }
  return chain
    .map((ref, i) => ({ ref, before: Math.max(0, panels.findIndex((p) => isBelow(p, ref))), below: chain[i + 1] ?? focus }))
    .filter((s) => s.ref !== chat && !panels.includes(s.ref))
}

/**
 * How the columns draw for the panels open. With the chat hidden the rightmost panel fills the room it left, its
 * content centred; with the sidebar folded the levels above the item opened are strips (hierarchyStrips).
 */
export function columnLayout(panels: readonly string[], chat: string | null, s: ColumnsState = state, parentOf?: (ref: string) => string | null): ColumnLayout {
  if (!panels.length) return { chat: "open", panels: [], strips: [] }
  const hidden = s.chatHidden
  const folds: Fold[] = panels.map((_, i) => (hidden && i === panels.length - 1 ? "fill" : "open"))
  const shown = hidden ? [...panels] : [...(chat ? [chat] : []), ...panels]
  const strips = s.rails ? hierarchyStrips(focusedRef(shown, s), hidden ? null : chat, panels, parentOf) : []
  return { chat: hidden ? "closed" : "open", panels: folds, strips }
}

/** The chat's ref, live, for the layout (App sets it as the centre's chat changes). */
let chatNow: string = COORDINATOR_REF
const chatListeners = new Set<() => void>()
export function setChatShowing(ref: string) {
  if (chatNow === ref) return
  chatNow = ref
  for (const cb of chatListeners) cb()
}
export const chatShowing = () => chatNow
export const useChatShowing = () =>
  useSyncExternalStore(
    (cb) => {
      chatListeners.add(cb)
      return () => void chatListeners.delete(cb)
    },
    () => chatNow,
    () => chatNow,
  )

/**
 * The way up the tree from each of the panels' tasks (`refs`), as far as the task list has it, in one string: it
 * changes only as a task on one of those ways loads, never on another task's update.
 */
export function treeWays(refs: readonly string[], tasks: readonly Task[]): string {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  return refs
    .map((ref) => {
      const view = viewOf(ref)
      const way: string[] = []
      for (let t = view.kind === "session" ? byId.get(view.id) : undefined; t && way.length < 16; t = t.parentTaskId ? byId.get(t.parentTaskId) : undefined)
        way.push(t.parentTaskId ?? chatRef(t.projectId))
      return way.join(">")
    })
    .join(",")
}

/** The columns' layout, live: on a change of the panels open, a pin, the chat, the item opened or the sidebar. */
export function useColumnLayout(): ColumnLayout & { refs: string[] } {
  const refs = usePanels()
  const s = useColumnsState()
  const chat = useChatShowing()
  // The strips read the tree (refParent): they're laid out again as a task on the way up from a panel loads, such as
  // one opened before the list had it (just spawned), and not on every task update.
  const select = useCallback((tasks: Task[]) => treeWays(refs, tasks), [refs])
  const ways = useQuery({ queryKey: keys.tasks, queryFn: fetchTasks, select }).data
  return useMemo(() => ({ refs, ...columnLayout(refs, chat, s) }), [refs, chat, s, ways])
}
