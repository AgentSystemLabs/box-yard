// The widths of the conversation panels (OverlayHost: the task's, then each sub-task's beside it), by place: the
// first panel's, the second's, and so on, and the room the chat beside them keeps. In memory only, never web storage:
// a panel closed and opened again keeps its width while the app is open, and a reload starts from the defaults.
import { useMemo, useSyncExternalStore } from "react"
import { PANEL_DEFAULT, THREAD_CHAT_ROOM } from "./layout"

const widths = new Map<number, number>()
let room = THREAD_CHAT_ROOM
const listeners = new Set<() => void>()

const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}
const notify = () => {
  for (const cb of listeners) cb()
}

/** Panel `index`'s width (0: the leftmost). */
export const panelWidth = (index: number) => widths.get(index) ?? PANEL_DEFAULT

export function setPanelWidth(index: number, width: number) {
  if (panelWidth(index) === width) return
  if (width === PANEL_DEFAULT) widths.delete(index)
  else widths.set(index, width)
  notify()
}

/** The least room the chat keeps beside the panels: theirs when they fit, and past that they scroll. */
export const chatRoom = () => room

/** The edge between the chat and the panels moved (layout.ts' moveChatEdge): the first panel's width and the chat's room. */
export function setChatEdge(first: number, chat: number) {
  if (panelWidth(0) === first && room === chat) return
  if (first === PANEL_DEFAULT) widths.delete(0)
  else widths.set(0, first)
  room = chat
  notify()
}

export const useChatRoom = () => useSyncExternalStore(subscribe, chatRoom)

/** Panel `index`'s width, live. */
export const usePanelWidth = (index: number) => useSyncExternalStore(subscribe, () => panelWidth(index))

/** The first `count` panels' widths, live; the same array until one changes. */
export function usePanelWidths(count: number): number[] {
  const joined = useSyncExternalStore(subscribe, () => Array.from({ length: count }, (_, i) => panelWidth(i)).join(","))
  return useMemo(() => (joined ? joined.split(",").map(Number) : []), [joined])
}

/** Back to the defaults (tests). */
export function resetPanelWidths() {
  widths.clear()
  room = THREAD_CHAT_ROOM
  notify()
}
