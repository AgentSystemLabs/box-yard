// Where each chat list (StickyScroll with a `restoreKey`) was scrolled on each page, so browser Back and Forward
// return to it instead of the bottom. A spot is taken the moment the URL changes, before the next page lays out,
// and kept per list and path in memory and in sessionStorage (for lists that remount, and a page that comes back
// after a full load). Only a back/forward move restores; a link, a reload or a new tab starts fresh.
//
// A page is its path and query (a project's ?tab=captain is its own page); a hash change isn't a new page.

/** A list's scroll position: pinned to the bottom, or a row and where it sat in the view. */
export interface ScrollSpot {
  bottom: boolean
  /** Distance from the bottom of the content to the top of the view, for when no row can be found. */
  fromBottom: number
  /** The first row with an id at or below the top of the view, and its offset from the view's top. */
  id?: string
  offset?: number
}

/** A spot plus the row element itself, which is only good while the list stays mounted. */
export interface LiveSpot extends ScrollSpot {
  node?: Element
  nodeOffset?: number
}

export interface ScrollWatcher {
  key: string
  /** The URL just left `path`: take the spot now, before the next page renders. */
  capture(): LiveSpot
  /** Back/Forward landed on this list's page and there's a spot to go back to. */
  restore(spot: LiveSpot): void
}

const STORE_KEY = "box-yard:scroll"
const MAX_SPOTS = 50

// The row is held weakly. Once its list unmounts (another task, another Captain), a strong reference would keep that
// whole detached list alive, DOM and React tree with all its messages, for each of the MAX_SPOTS pages.
type KeptSpot = ScrollSpot & { node?: WeakRef<Element>; nodeOffset?: number }
const memory = new Map<string, KeptSpot>()
const watchers = new Set<ScrollWatcher>()

const spotKey = (key: string, path: string) => `${key}@${path}`

function readStore(): Record<string, ScrollSpot> {
  try {
    return JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "{}") as Record<string, ScrollSpot>
  } catch {
    return {}
  }
}

/** Keep `spot` for the list `key` on `path`. */
export function saveSpot(key: string, path: string, spot: LiveSpot) {
  const k = spotKey(key, path)
  const { node, nodeOffset, ...plain } = spot
  memory.delete(k)
  memory.set(k, node ? { ...plain, node: new WeakRef(node), nodeOffset } : plain)
  if (memory.size > MAX_SPOTS) memory.delete(memory.keys().next().value!)
  const all = readStore()
  delete all[k]
  all[k] = plain
  const keys = Object.keys(all)
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SPOTS))) delete all[old]
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(all))
  } catch {}
}

/** The spot kept for the list `key` on `path`, if any. */
export function readSpot(key: string, path: string): LiveSpot | null {
  const k = spotKey(key, path)
  const kept = memory.get(k)
  if (!kept) return readStore()[k] ?? null
  const { node, nodeOffset, ...plain } = kept
  // Gone with its list: the id and offsets still find the place.
  const el = node?.deref()
  return el ? { ...plain, node: el, nodeOffset } : plain
}

// The page shown now, and how it was reached. `pop` (back/forward) is spent per list: a list restores once per move.
const here = () => location.pathname + location.search
let path = typeof location === "undefined" ? "/" : here()
let pop = false
const spent = new Set<string>()

function onNavigate(e: Event) {
  const isPop = e.type === "popstate"
  const next = here()
  if (next === path) return
  for (const w of watchers) saveSpot(w.key, path, w.capture())
  path = next
  pop = isPop
  spent.clear()
  if (!pop) return
  for (const w of watchers) {
    const spot = readSpot(w.key, path)
    spent.add(w.key)
    if (spot) w.restore(spot)
  }
}

/** For a list that mounts now: the spot to go back to, if this page was reached with Back/Forward. */
export function takeSpot(key: string): LiveSpot | null {
  if (!pop || spent.has(key)) return null
  spent.add(key)
  return readSpot(key, path)
}

/** Watch a mounted list: its spot is taken whenever the page changes. Returns the unwatch function. */
export function watchScroll(w: ScrollWatcher) {
  watchers.add(w)
  return () => void watchers.delete(w)
}

/** Start over (tests). */
export function resetScrollMemory(nav: "push" | "pop" = "push") {
  memory.clear()
  watchers.clear()
  spent.clear()
  path = here()
  pop = nav === "pop"
  try {
    sessionStorage.removeItem(STORE_KEY)
  } catch {}
}

if (typeof window !== "undefined") {
  // A page that comes back with Back after a full load (left for another site, not kept in the back/forward cache).
  pop = (performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined)?.type === "back_forward"
  // Added at import, before the router's own listeners, so spots are taken before the next page renders.
  for (const type of ["popstate", "pushState", "replaceState"]) addEventListener(type, onNavigate)
  addEventListener("pagehide", () => {
    for (const w of watchers) saveSpot(w.key, path, w.capture())
  })
}
