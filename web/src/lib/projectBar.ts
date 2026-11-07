// The project the centre's chat is talking to (its Captain's; null: the Coordinator's), and the projects Cody pinned
// to the sidebar or took off it (this browser remembers). The names are from the project bar these once drove.
import { useSyncExternalStore } from "react"
import { closeUnpinnedPanels, followedTaskProject } from "./columns"

/**
 * Cody's own say over a project in the sidebar: "pinned" stays in its list even with nothing going on (picking a project
 * in the chat switcher pins it); "unpinned" moves to More projects however busy it gets, until it's pinned again. A
 * project with neither shows while it has open tasks.
 */
export type PinState = "pinned" | "unpinned"
export type BarPins = Readonly<Record<string, PinState>>

// The project picked, for this page's life: its Captain is the centre's chat (null: the Coordinator).
let filter: string | null = null
const listeners = new Set<() => void>()
const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function setChatProjectFilter(projectId: string | null) {
  if (filter === projectId) return
  // An unpinned task never shows beside another project's Captain: picking one closes them (lib/centreCaptain.ts).
  // A pinned one stays where it was put, whichever chat is beside it.
  const owner = projectId && followedTaskProject()
  if (owner && owner !== projectId) closeUnpinnedPanels()
  filter = projectId
  for (const l of listeners) l()
}

export const chatProjectFilter = () => filter

export const useChatProjectFilter = () => useSyncExternalStore(subscribe, () => filter, () => filter)

// The pins, in this browser's localStorage and in sync across its tabs.
export const PINS_KEY = "box-yard:project-bar-pins"
const NO_PINS: BarPins = {}
const pinListeners = new Set<() => void>()
let pinsCache: { raw: string | null; pins: BarPins } = { raw: null, pins: NO_PINS }

export function readPins(): BarPins {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(PINS_KEY)
  } catch {}
  if (raw === pinsCache.raw) return pinsCache.pins
  let pins: BarPins = NO_PINS
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      pins = Object.fromEntries(Object.entries(parsed).filter(([, v]) => v === "pinned" || v === "unpinned")) as BarPins
  } catch {}
  pinsCache = { raw, pins }
  return pins
}

function setPin(projectId: string, state: PinState) {
  const pins = readPins()
  if (pins[projectId] === state) return
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify({ ...pins, [projectId]: state }))
  } catch {}
  for (const l of pinListeners) l()
}

/** In the sidebar for good: the chat switcher's pick. */
export const pinProject = (projectId: string) => setPin(projectId, "pinned")

/** Into More projects, however busy it gets; the centre goes back to the Coordinator if it was this project's Captain. */
export function unpinProject(projectId: string) {
  if (filter === projectId) setChatProjectFilter(null)
  setPin(projectId, "unpinned")
}

/** Picked in the chat switcher: pinned, and its Captain takes the centre. */
export function pickProject(projectId: string) {
  pinProject(projectId)
  setChatProjectFilter(projectId)
}

const subscribePins = (cb: () => void) => {
  pinListeners.add(cb)
  const onStorage = (e: StorageEvent) => {
    if (e.key === PINS_KEY || e.key === null) cb()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    pinListeners.delete(cb)
    window.removeEventListener("storage", onStorage)
  }
}

export const useBarPins = () => useSyncExternalStore(subscribePins, readPins, () => NO_PINS)
