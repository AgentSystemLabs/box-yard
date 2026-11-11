import { createContext, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type Dispatch, type ReactNode, type Ref, type SetStateAction } from "react"
import { ArrowDown } from "lucide-react"
import { cx } from "./ui"
import { takeSpot, watchScroll, type LiveSpot } from "../lib/scrollMemory"

// Only rounding at the actual bottom is tolerated. Any upward input releases the pin.
const BOTTOM_SLOP_PX = 1
// Chrome and Safari scroll on the compositor, against the layout of a frame or two ago. While a reply streams, a
// scroll that lands on the bottom lands on that older bottom, short of the one the list has grown to by the time its
// scroll event arrives. A bottom the list had this recently still counts as the bottom.
const RECENT_BOTTOM_MS = 250

// Start loading earlier items this far before the top is reached.
const LOAD_EARLIER_MARGIN_PX = 800

// After Back/Forward, hold the restored row in place this long while late layout (markdown, images) settles.
const RESTORE_SETTLE_MS = 1000
// Give up on a restore whose list never shows the row (or any content) within this long.
const RESTORE_GIVE_UP_MS = 10_000

// "Jump to latest" glides to the bottom over this long (a send jumps). It's our own animation, aimed at the bottom as it
// is each frame, so a reply streaming in meanwhile can't leave it short. A native smooth scroll aims at the bottom as it
// was when it started: retargeting it on every streamed chunk restarted its slow start, and Safari drops retargets.
const GLIDE_MS = 320

// Keys that scroll a page up. Shift+Space too.
const UP_KEYS = new Set(["PageUp", "ArrowUp", "Home"])

const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")

// True if something between `target` and `root` (a code block, a tool output) can scroll up itself
// and would take the wheel or swipe instead of the list.
function innerCanScrollUp(target: EventTarget | null, root: HTMLElement) {
  for (let n = target instanceof Element ? target : null; n && n !== root; n = n.parentElement) {
    if (n.scrollTop > 0 && n.scrollHeight > n.clientHeight && /auto|scroll/.test(getComputedStyle(n).overflowY)) return true
  }
  return false
}

// Bubbles from an element `scrollIntoList` is about to scroll to, up to its StickyScroll.
const LEAVE_BOTTOM = "boxyard:leave-bottom"

/** Release the pin before revealing older rows, so their first layout can't pull the view back to the bottom. */
export function releaseListBottom(el: Element) {
  el.dispatchEvent(new Event(LEAVE_BOTTOM, { bubbles: true }))
}

// Bubbles from an element whose own change of height is over (a message's actions row put away), up to its StickyScroll.
const REJOIN_BOTTOM = "boxyard:rejoin-bottom"

/**
 * Undo `releaseListBottom` once what it was released for is gone: the list follows new messages again, but only if
 * it's at its bottom now. A reader who scrolled away meanwhile stays where they are.
 */
export function rejoinListBottom(el: Element) {
  el.dispatchEvent(new Event(REJOIN_BOTTOM, { bubbles: true }))
}

// Bubbles from an element that sends from inside the list (an ask's answers), up to its StickyScroll.
const TO_END = "boxyard:to-end"

/**
 * A send from inside the list, as `handle.scrollToEnd()` is one from outside it: re-pin the list and jump to its
 * bottom, so what's sent and the reply to it show as they come, from however far up.
 */
export function scrollListToEnd(el: Element) {
  el.dispatchEvent(new Event(TO_END, { bubbles: true }))
}

/**
 * Scroll `el` into view inside the StickyScroll that holds it (a card the cards view goes to, say). The list lets go
 * of the bottom first and holds the view where the scroll leaves it: pinned, content growing meanwhile (the card
 * opening as it's revealed, its history loading) would pull the view back down, cancel the scroll, or push `el` up
 * out of view. Reaching the bottom again pins it, as ever.
 *
 * Only the list scrolls. `Element.scrollIntoView` scrolls every ancestor that has overflow too, `overflow: hidden`
 * ones included: a Captain panel taller than its frame slid its header up out of sight, where nothing could scroll it
 * back. The element's `scroll-margin` is honoured, as scrollIntoView would.
 */
export function scrollIntoList(el: Element, options: ScrollIntoListOptions = {}) {
  releaseListBottom(el)
  const list = el.parentElement?.closest<HTMLElement>("[data-scroller]")
  if (!list) return void el.scrollIntoView?.(options)
  scrollListTo(list, el, options)
}

/** Scroll `list`, and nothing around it, so `el` inside it shows at `block` (a list that isn't a StickyScroll). */
export function scrollListTo(list: HTMLElement, el: Element, options: ScrollIntoListOptions = {}) {
  const top = listScrollTop(list, el, options.block ?? "start")
  if (top !== null) list.scrollTo({ top, behavior: options.behavior ?? "auto" })
}

export type ScrollIntoListOptions = { block?: "start" | "center" | "end" | "nearest"; behavior?: ScrollBehavior }

// DOMRects include CSS zoom/transforms; scrollTop/clientHeight use the list's unscaled CSS pixels.
const scrollScale = (list: HTMLElement) => {
  const style = getComputedStyle(list)
  // Computed border-box height keeps fractional flex sizing, which offsetHeight rounds.
  const height = (style.boxSizing === "border-box" ? parseFloat(style.height) : 0) || list.offsetHeight
  return height ? list.getBoundingClientRect().height / height || 1 : 1
}

/** The `scrollTop` that shows `el` at `block` in `list` (the browser clamps it), or null if `nearest` needs none. */
function listScrollTop(list: HTMLElement, el: Element, block: NonNullable<ScrollIntoListOptions["block"]>) {
  const style = getComputedStyle(el)
  const frame = list.getBoundingClientRect()
  const rect = el.getBoundingClientRect()
  const scale = scrollScale(list)
  // Where `el` sits in the list's content, its scroll margins added.
  const start = (rect.top - frame.top) / scale - list.clientTop + list.scrollTop - (parseFloat(style.scrollMarginTop) || 0)
  const end = (rect.bottom - frame.top) / scale - list.clientTop + list.scrollTop + (parseFloat(style.scrollMarginBottom) || 0)
  const view = list.clientHeight
  if (block === "center") return (start + end - view) / 2
  if (block === "end") return end - view
  if (block === "nearest") {
    const above = start < list.scrollTop
    const below = end > list.scrollTop + view
    if ((!above && !below) || (above && below)) return null
    return (above && end - start <= view) || (below && end - start > view) ? start : end - view
  }
  return start
}

// The list's latest row while it's there (useLatestRow), for "Jump to latest" to keep off it.
const LatestRow = createContext<Dispatch<SetStateAction<Element | null>> | null>(null)

/**
 * The ref callback that marks its row as the list's latest while it's mounted: a task's pending ask at its foot.
 * Taller than a phone's screen, it's read from its top, a scroll up from the bottom; that isn't leaving the latest, so
 * while the row fills half the view (or half of it shows) "Jump to latest" doesn't come up over it, unless new
 * messages came meanwhile.
 */
export function useLatestRow() {
  const set = useContext(LatestRow)
  return useCallback((el: Element | null) => {
    if (!set || !el) return
    set(el)
    return () => set((now) => (now === el ? null : now))
  }, [set])
}

/**
 * Where "Jump to latest" lives when the list doesn't float it over itself: the Coordinator chat puts it in the line
 * over its box (DockComposer.tsx), so it never covers a card. The list publishes whether it's away from the bottom
 * and how many new items came since; `jump()` takes it there.
 */
export interface JumpStore {
  get: () => JumpState
  subscribe: (l: () => void) => () => void
  set: (s: JumpState) => void
  jump: () => void
  /** The list's own jump, while it's mounted. */
  run: (() => void) | null
}
export type JumpState = { away: boolean; unread: number }
const NOT_AWAY: JumpState = { away: false, unread: 0 }

export function createJumpStore(): JumpStore {
  let state = NOT_AWAY
  const listeners = new Set<() => void>()
  const store: JumpStore = {
    get: () => state,
    subscribe: (l) => {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    set: (s) => {
      if (s.away === state.away && s.unread === state.unread) return
      state = s
      listeners.forEach((l) => l())
    },
    jump: () => store.run?.(),
    run: null,
  }
  return store
}

export const useJumpState = (store: JumpStore) => useSyncExternalStore(store.subscribe, store.get)

/** What a chat view calls after a send: `scrollToEnd()` re-pins the list and jumps to the bottom. */
export type StickyScrollHandle = { scrollToEnd: () => void }

// A scroll container that follows layout growth until any upward user input or scroll.
// It stays unpinned, with the view held still, until the user returns to the actual bottom,
// sends, or presses "Jump to latest". Our own scrollTop writes never count as user scrolling.
// `count` is the number of items; `resetKey` changes when the content is swapped (e.g. another task).
// With `hidden` > 0 (older items not rendered yet), scrolling near the top calls `onLoadEarlier`,
// and the view stays on the same content while they are added above it. `onTrim` is called when items arrive
// while the view is pinned to the bottom, so the list can stop rendering old items again (useTail's `trim`).
// With `onFill`, a list that opens with only its newest few items (useTail's `first`) gets more before it's
// painted (useTail's `fill`) until they reach past the top of the view, so it opens full however tall the rows are;
// `onFilled` hears when they do, with the share of their height the view (and the slop) takes (useTail's `filled`, so
// the next first paint starts from about as many as that).
// While `growing` (useTail's: the rest of those newest items are still coming in by themselves), it doesn't load
// earlier ones ahead of the reader.
// With `restoreKey`, browser Back/Forward to a page puts the list back where it was when that page was left
// (lib/scrollMemory.ts): at the bottom if it was pinned there, else with the same row at the same height.
// `handle.scrollToEnd()` (after a send) re-pins it and jumps to the bottom, even from far up.
// `overlay` floats bottom-center over the list, beside "Jump to latest", above everything in it (sticky headers
// included), with room left under the last row so it covers nothing at the bottom. With `jumpStore`, "Jump to latest"
// is the caller's to show (JumpStore), not floated.
export function StickyScroll({
  handle,
  count,
  resetKey,
  restoreKey,
  hidden = 0,
  earlierLabel,
  onLoadEarlier,
  onTrim,
  onJump,
  onFill,
  onFilled,
  growing = false,
  className,
  contentClassName,
  overlay,
  jumpStore,
  children,
}: {
  handle?: Ref<StickyScrollHandle>
  count: number
  resetKey?: string
  restoreKey?: string
  hidden?: number
  earlierLabel?: string
  onLoadEarlier?: () => void
  onTrim?: () => void
  onJump?: () => void
  onFill?: () => boolean
  onFilled?: (share: number) => void
  growing?: boolean
  className?: string
  contentClassName?: string
  overlay?: ReactNode
  jumpStore?: JumpStore
  children: ReactNode
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  // The scrollTop we last saw or wrote. A scroll event that lands here again is our own write.
  const lastTop = useRef(0)
  // Distinguish the browser clamping a shorter list from an upward scrollbar/assistive scroll.
  const lastBottom = useRef(0)
  const pendingFrames = useRef(new Set<number>())
  const lastCount = useRef(count)
  const touchStart = useRef<{ x: number; y: number } | null>(null)
  // The last pointerdown was inside this list, so keys pressed on <body> scroll it.
  const pointerInside = useRef(false)
  // A pointer is pressed down in the list (a scrollbar drag, a text selection) and hasn't come up yet.
  const pressing = useRef(false)
  // A row near the top of the view and its offset, to hold it still while unpinned.
  const anchor = useRef<{ node: Element; top: number } | null>(null)
  const [away, setAway] = useState(false)
  const [unread, setUnread] = useState(0)
  const sentinel = useRef<HTMLButtonElement>(null)
  // Scroll metrics captured just before older items are added above.
  const beforePrepend = useRef<{ height: number; top: number; hidden: number; anchor: { node: Element; top: number } | null } | null>(null)
  // A spot from Back/Forward being put back: `since` it started, `found` when its row (or content) first showed.
  const restoring = useRef<{ spot: LiveSpot; since: number; found: number } | null>(null)
  // Gliding to the bottom after a send: how far short of the bottom it started, and when (see glideFrame).
  const glide = useRef<{ from: number; start: number } | null>(null)
  // Bottoms the list had until a moment ago (RECENT_BOTTOM_MS), and when each stopped being the bottom.
  const pastBottoms = useRef<{ bottom: number; until: number }[]>([])
  const latest = useRef({ hidden, onLoadEarlier, onTrim, onFill, onFilled, count })
  latest.current = { hidden, onLoadEarlier, onTrim, onFill, onFilled, count }
  // Opened (or switched to) and not yet reaching past the view: see fillView.
  const filling = useRef(false)

  const nextFrame = (cb: () => void) => {
    const id = requestAnimationFrame(() => {
      pendingFrames.current.delete(id)
      cb()
    })
    pendingFrames.current.add(id)
  }
  useEffect(() => () => {
    pendingFrames.current.forEach(cancelAnimationFrame)
    pendingFrames.current.clear()
    glide.current = null
  }, [])

  // Note the list's bottom as of this layout, keeping the ones it had a moment ago.
  const seeBottom = (bottom: number) => {
    if (bottom !== lastBottom.current) {
      const now = performance.now()
      pastBottoms.current = pastBottoms.current.filter((b) => now - b.until < RECENT_BOTTOM_MS)
      pastBottoms.current.push({ bottom: lastBottom.current, until: now })
    }
    lastBottom.current = bottom
  }

  // At the bottom: the one the list has now, or one it had a moment ago (RECENT_BOTTOM_MS) and has grown less than a
  // screen past since, so a long new reply isn't skipped to its end.
  const reachedBottom = (el: HTMLElement, top: number, bottom: number) => {
    if (bottom - top < BOTTOM_SLOP_PX) return true
    const now = performance.now()
    return pastBottoms.current.some((b) => now - b.until < RECENT_BOTTOM_MS && b.bottom - top < BOTTOM_SLOP_PX && bottom - b.bottom <= el.clientHeight)
  }

  // Write scrollTop ourselves, remembering where it landed so the scroll event it fires is ignored.
  const setTop = (el: HTMLElement, top: number) => {
    const target = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight))
    if (el.scrollTop !== target) {
      el.scrollTop = target
      // WebKit floors scrollTop to whole CSS pixels. Pick the nearest representable position, so zoomed
      // prepends do not accumulate a full pixel of drift on each compensation. Chromium keeps fractions.
      const landed = el.scrollTop
      if (Math.abs(landed - target) > 0.5) {
        el.scrollTop = landed < target ? Math.ceil(target) : Math.floor(target)
        if (Math.abs(el.scrollTop - target) > Math.abs(landed - target)) el.scrollTop = landed
      }
    }
    lastTop.current = el.scrollTop
    seeBottom(Math.max(0, el.scrollHeight - el.clientHeight))
  }

  const toBottom = (smooth = false) => {
    const el = scroller.current
    if (!el) return
    const gap = el.scrollHeight - el.clientHeight - el.scrollTop
    // Under prefers-reduced-motion a glide is a jump.
    if (!smooth || reducedMotion() || gap < BOTTOM_SLOP_PX) {
      glide.current = null
      return setTop(el, el.scrollHeight)
    }
    // From far up, start a screen above the bottom and glide only that last stretch.
    const g = { from: Math.min(gap, el.clientHeight), start: performance.now() }
    glide.current = g
    glideFrame(g)
  }

  // One frame of a glide: ease out towards the bottom as it is now, never back up, and land on it at GLIDE_MS.
  const glideFrame = (g: { from: number; start: number }) => {
    const el = scroller.current
    if (!el || glide.current !== g) return
    // A scrollbar drag since our last write is the user's: upward, it lets go (and ends this glide).
    if (el.scrollTop !== lastTop.current) onScroll()
    if (glide.current !== g || !stuck.current) return
    const t = Math.min(1, (performance.now() - g.start) / GLIDE_MS)
    const bottom = el.scrollHeight - el.clientHeight
    setTop(el, t >= 1 ? bottom : Math.max(el.scrollTop, bottom - g.from * (1 - t) ** 3))
    if (t < 1) nextFrame(() => glideFrame(g))
    else glide.current = null
  }

  // Remember the first row that reaches into the view and where it sits.
  const markAnchor = () => {
    const el = scroller.current
    const rows = content.current?.children
    if (!el || !rows?.length) return void (anchor.current = null)
    const viewTop = el.getBoundingClientRect().top
    let lo = 0
    let hi = rows.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (rows[mid]!.getBoundingClientRect().bottom > viewTop) hi = mid
      else lo = mid + 1
    }
    const node = (rows[lo] === sentinel.current ? rows[lo + 1] ?? rows[lo] : rows[lo])!
    anchor.current = { node, top: node.getBoundingClientRect().top - viewTop }
  }

  // Where the list is now, to come back to: pinned, or the rows at the top of the view.
  const capture = (): LiveSpot => {
    const el = scroller.current
    if (!el) return { bottom: true, fromBottom: 0 }
    const fromBottom = el.scrollHeight - el.scrollTop
    if (stuck.current) return { bottom: true, fromBottom }
    markAnchor()
    const a = anchor.current
    if (!a) return { bottom: false, fromBottom }
    const spot: LiveSpot = { bottom: false, fromBottom, node: a.node, nodeOffset: a.top }
    // A row with an id (a message) finds the same place after a remount, when the element itself is gone.
    const rows = [...content.current!.children]
    const at = rows.indexOf(a.node)
    const withId = rows.slice(at).find((r) => r.id) ?? rows.slice(0, at).reverse().find((r) => r.id)
    if (withId) {
      spot.id = withId.id
      spot.offset = withId.getBoundingClientRect().top - el.getBoundingClientRect().top
    }
    return spot
  }

  const startRestore = (spot: LiveSpot) => {
    restoring.current = { spot, since: performance.now(), found: 0 }
    applyRestore()
  }

  // Put the restoring spot back. Runs again on every layout change until it has held for RESTORE_SETTLE_MS.
  const applyRestore = () => {
    const r = restoring.current
    const el = scroller.current
    const box = content.current
    if (!r || !el || !box) return
    const now = performance.now()
    if (now - (r.found || r.since) > (r.found ? RESTORE_SETTLE_MS : RESTORE_GIVE_UP_MS)) return void (restoring.current = null)
    const { spot } = r
    if (spot.bottom) {
      restoring.current = null
      pin()
      return toBottom()
    }
    const byId = spot.id ? document.getElementById(spot.id) : null
    const row =
      spot.node?.isConnected && box.contains(spot.node)
        ? { node: spot.node, offset: spot.nodeOffset ?? 0 }
        : byId && box.contains(byId)
          ? { node: byId, offset: spot.offset ?? 0 }
          : null
    if (row) {
      setTop(el, el.scrollTop + (row.node.getBoundingClientRect().top - el.getBoundingClientRect().top - row.offset) / scrollScale(el))
    } else {
      const { hidden, onLoadEarlier } = latest.current
      // The row is in the older part that isn't rendered yet: render more (the prepend keeps the view), then retry.
      if (spot.id && hidden > 0 && onLoadEarlier) return loadEarlier()
      // Nothing to show yet (the messages are loading): wait for them.
      if (el.scrollHeight - el.clientHeight < BOTTOM_SLOP_PX) return
      setTop(el, el.scrollHeight - spot.fromBottom)
    }
    r.found ||= now
    if (el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLOP_PX) return
    stuck.current = false
    setAway(true)
    markAnchor()
  }

  const pin = () => {
    stuck.current = true
    anchor.current = null
    setAway(false)
    setUnread(0)
  }

  const unpin = () => {
    const el = scroller.current
    // A glide stops where it is.
    glide.current = null
    // A list that fits has nowhere to scroll.
    if (!el || el.scrollHeight - el.clientHeight < BOTTOM_SLOP_PX) return
    // A native scroll may already have moved before its queued scroll event. That pre-intent
    // movement must not re-pin after this release, even if it just reached the bottom.
    lastTop.current = el.scrollTop
    seeBottom(Math.max(0, el.scrollHeight - el.clientHeight))
    if (stuck.current) {
      stuck.current = false
      setAway(true)
    }
    markAnchor()
  }

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const top = el.scrollTop
    const moved = top - lastTop.current
    const bottom = Math.max(0, el.scrollHeight - el.clientHeight)
    // The browser moved scrollTop back to the end, not the user: a list that got shorter (or a viewport that got
    // taller) clamped, or a rubber band past the end settling. Within rounding: at 2x or 3x, scrollTop is fractional.
    const toEnd = moved < 0 && bottom - top < BOTTOM_SLOP_PX && (bottom < lastBottom.current || lastTop.current > bottom)
    // WebKit moves scrollTop up by itself when the list grows and loses a row above the end in the same layout (a new
    // reply arrives and the next-step chips leave the one before it): up by what left, short of the new bottom.
    // Pinned, an upward move in a layout that moved the bottom, with no pointer pressed in the list, is that, not the
    // reader: wheel, touch and keys have let go already (beginInput), a scrollbar drag holds a pointer down.
    const shifted = moved < 0 && !toEnd && stuck.current && !pressing.current && bottom !== lastBottom.current
    lastTop.current = top
    seeBottom(bottom)
    // Our own write (or nothing moved): it says nothing about what the user wants.
    if (moved === 0) return
    // Mid-restore, a native clamp still belongs to the restore; an upward user move wins.
    if (restoring.current) {
      if (moved < 0 && !toEnd) restoring.current = null
      else return applyRestore()
    }
    // An upward scroll wins even during a glide. Only our writes and the browser's own moves (back to the end, or
    // WebKit's while pinned, which goes back down to the new bottom) are excluded; there is no distance/dead zone to
    // escape. Mid-glide, the glide's next frame aims at the new bottom.
    if (shifted) {
      if (!glide.current) toBottom()
    } else if (moved < 0 && !toEnd) unpin()
    else if (moved > 0 && reachedBottom(el, top, bottom)) {
      // Landed on the bottom of a frame ago: catch up with what grew since.
      if (!stuck.current) {
        pin()
        if (!glide.current) toBottom()
      }
    } else if (!stuck.current) markAnchor()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Intent releases the pin immediately, before the compositor scroll event. Waiting even
  // one frame lets streamed growth swallow slow trackpad/touch/key increments indefinitely.
  const beginInput = () => {
    restoring.current = null
    unpin()
  }

  // Read intent ahead of the scroll so observers cannot pull against the user.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      restoring.current = null
      if (e.deltaY < 0 && !e.ctrlKey && !innerCanScrollUp(e.target, el)) beginInput()
    }
    const onTouchStart = (e: TouchEvent) => {
      restoring.current = null
      const t = e.touches[0]
      touchStart.current = t ? { x: t.clientX, y: t.clientY } : null
    }
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0]
      const from = touchStart.current
      if (!t || !from) return
      const dx = t.clientX - from.x
      const dy = t.clientY - from.y
      // A finger moving down drags the content up.
      if (dy > 0 && dy >= Math.abs(dx) && !innerCanScrollUp(e.target, el)) beginInput()
    }
    const onPointerDown = () => {
      restoring.current = null
      // A scrollbar drag's actual upward movement is handled by onScroll, even mid-glide.
      pointerInside.current = true
      pressing.current = true
    }
    const onDocPointerDown = () => {
      pointerInside.current = false
      pressing.current = false
    }
    const onPointerUp = () => {
      pressing.current = false
    }
    // scrollIntoList: a scroll to something on its way.
    const onLeaveBottom = () => {
      restoring.current = null
      unpin()
    }
    // rejoinListBottom: back at the bottom after a release that scrolled nothing, so follow it again.
    const onRejoinBottom = () => {
      if (stuck.current || restoring.current) return
      const bottom = Math.max(0, el.scrollHeight - el.clientHeight)
      if (bottom - el.scrollTop >= BOTTOM_SLOP_PX) return
      lastTop.current = el.scrollTop
      seeBottom(bottom)
      pin()
    }
    // scrollListToEnd: a send from inside the list.
    const onToEnd = () => jumpRef.current(false)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(UP_KEYS.has(e.key) || (e.key === " " && e.shiftKey)) || isEditable(e.target) || innerCanScrollUp(e.target, el)) return
      const t = e.target
      if ((t instanceof Node && el.contains(t)) || ((t === document.body || t === document) && pointerInside.current)) {
        restoring.current = null
        beginInput()
      }
    }
    const passive = { passive: true }
    el.addEventListener("wheel", onWheel, passive)
    el.addEventListener("touchstart", onTouchStart, passive)
    el.addEventListener("touchmove", onTouchMove, passive)
    el.addEventListener("pointerdown", onPointerDown)
    el.addEventListener(LEAVE_BOTTOM, onLeaveBottom)
    el.addEventListener(REJOIN_BOTTOM, onRejoinBottom)
    el.addEventListener(TO_END, onToEnd)
    // Capture runs before the list's own listener, which then sets it back for clicks inside.
    document.addEventListener("pointerdown", onDocPointerDown, true)
    document.addEventListener("pointerup", onPointerUp, true)
    document.addEventListener("pointercancel", onPointerUp, true)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      el.removeEventListener("wheel", onWheel)
      el.removeEventListener("touchstart", onTouchStart)
      el.removeEventListener("touchmove", onTouchMove)
      el.removeEventListener("pointerdown", onPointerDown)
      el.removeEventListener(LEAVE_BOTTOM, onLeaveBottom)
      el.removeEventListener(REJOIN_BOTTOM, onRejoinBottom)
      el.removeEventListener(TO_END, onToEnd)
      document.removeEventListener("pointerdown", onDocPointerDown, true)
      document.removeEventListener("pointerup", onPointerUp, true)
      document.removeEventListener("pointercancel", onPointerUp, true)
      document.removeEventListener("keydown", onKeyDown)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Opening or switching to another list starts at the bottom, unless Back/Forward brought it back to a spot.
  useLayoutEffect(() => {
    glide.current = null
    lastCount.current = count
    // Fill the view before it's painted (fillView), unless it's going back to a spot above the bottom.
    filling.current = Boolean(onFill)
    const spot = restoreKey ? takeSpot(restoreKey) : null
    if (spot) return startRestore(spot)
    if (restoring.current) return applyRestore()
    pin()
    toBottom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  // A list that just opened with only its newest few rows (useTail's `first`), short of the top of the view: render
  // more now (`onFill`), in this same frame, rather than paint a part-empty list and fill it in a frame later. Each
  // render checks again until the rows reach past the view, all of them are there, or the reader scrolls.
  const fillView = () => {
    const el = scroller.current
    const { hidden, onFill, onFilled, count } = latest.current
    if (!el || !onFill || !stuck.current || restoring.current) return void (filling.current = false)
    if (el.scrollHeight - el.clientHeight >= BOTTOM_SLOP_PX) {
      filling.current = false
      onFilled?.((el.clientHeight + BOTTOM_SLOP_PX) / el.scrollHeight)
      return toBottom()
    }
    // No rows yet: they're still loading.
    if (!hidden) return void (filling.current = !count)
    if (!onFill()) filling.current = false
  }
  useLayoutEffect(() => {
    if (filling.current) fillView()
  })

  // Take this list's spot when the page changes, and go back to it on Back/Forward while mounted.
  useEffect(() => {
    if (!restoreKey) return
    return watchScroll({
      key: restoreKey,
      capture: () => {
        restoring.current = null
        return capture()
      },
      // The page renders after this: its layout effects (or the next frame) put the spot back.
      restore: (spot) => {
        restoring.current = { spot, since: performance.now(), found: 0 }
        nextFrame(applyRestore)
      },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreKey])

  // Each render may be the restored page's new layout (a wider column, the messages arriving).
  useLayoutEffect(() => {
    if (restoring.current) applyRestore()
  })

  // Keep the decision separate from the measurements: growth consumes the existing pin, never
  // resets it. This also holds the row being read through prepend, expansion and image layout.
  const followLayout = () => {
    const box = scroller.current
    if (!box) return
    // Native/assistive scrolling can move before its scroll event is delivered. Read that
    // movement before an observer write could undo it (including a tiny scrollbar drag).
    if (box.scrollTop !== lastTop.current) onScroll()
    if (restoring.current) return applyRestore()
    // Mid-glide, its next frame aims at the new bottom.
    if (stuck.current) return void (glide.current || toBottom())
    // Remember this layout's bottom: a scroll that lands on it a frame later still reaches the bottom.
    seeBottom(Math.max(0, box.scrollHeight - box.clientHeight))
    const a = anchor.current
    if (!a || !a.node.isConnected) return markAnchor()
    const shift = a.node.getBoundingClientRect().top - box.getBoundingClientRect().top - a.top
    if (Math.abs(shift) >= 1) setTop(box, box.scrollTop + shift / scrollScale(box))
    markAnchor()
  }

  useEffect(() => {
    const el = content.current
    const box = scroller.current
    if (!el || !box) return
    // Observe the growing content AND the actual scroll viewport (composer/keyboard/rotation).
    const ro = new ResizeObserver(followLayout)
    ro.observe(el)
    ro.observe(box)
    // Nested/memoized replies can change without a new message or a StickyScroll render.
    // Coalesce DOM changes into one layout read per frame; scrollTop writes don't mutate this tree.
    let queued = false
    const mo = new MutationObserver(() => {
      if (queued) return
      queued = true
      nextFrame(() => {
        queued = false
        followLayout()
      })
    })
    mo.observe(el, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ["open", "hidden", "class", "style", "src"] })
    const vv = window.visualViewport
    vv?.addEventListener("resize", followLayout)
    window.addEventListener("resize", followLayout)
    return () => {
      ro.disconnect()
      mo.disconnect()
      vv?.removeEventListener("resize", followLayout)
      window.removeEventListener("resize", followLayout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const added = count - lastCount.current
    lastCount.current = count
    if (added > 0 && !stuck.current) setUnread((n) => n + added)
    // Pinned to the bottom, rows dropped from the top don't move anything on screen.
    if (added > 0 && stuck.current && !restoring.current) latest.current.onTrim?.()
  }, [count])

  const loadEarlier = useCallback(() => {
    const el = scroller.current
    const { hidden, onLoadEarlier } = latest.current
    if (!el || !onLoadEarlier) return
    markAnchor()
    beforePrepend.current = { height: el.scrollHeight, top: el.scrollTop, hidden, anchor: anchor.current }
    onLoadEarlier()
  }, [])

  // Keep what's on screen in place when older items appear above it.
  useLayoutEffect(() => {
    const el = scroller.current
    const prev = beforePrepend.current
    if (!el || !prev || prev.hidden === hidden) return
    beforePrepend.current = null
    if (stuck.current) return
    const a = prev.anchor
    // Bounded windows also drop rows below the viewport: total height no longer measures the prepend.
    setTop(el, a?.node.isConnected
      ? el.scrollTop + (a.node.getBoundingClientRect().top - el.getBoundingClientRect().top - a.top) / scrollScale(el)
      : prev.top + (el.scrollHeight - prev.height))
    // The bottom moved for rows above, not for anything new at the end: where it was is no bottom to reach.
    pastBottoms.current = []
    markAnchor()
  })

  // Load earlier items before the reader reaches the top. Not while the list is still growing by itself: right after a
  // short first paint the sentinel is near the top, and loading earlier then built every row at once anyway.
  useEffect(() => {
    const el = sentinel.current
    const root = scroller.current
    if (!el || !root || !hidden || growing) return
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadEarlier(), {
      root,
      rootMargin: `${LOAD_EARLIER_MARGIN_PX}px 0px 0px 0px`,
    })
    io.observe(el)
    return () => io.disconnect()
  }, [hidden, growing, loadEarlier])

  // Re-pin and go to the bottom: a glide for "Jump to latest", a jump after a send.
  const jump = (smooth = true) => {
    onJump?.()
    restoring.current = null
    pin()
    toBottom(smooth)
  }
  const jumpRef = useRef(jump)
  jumpRef.current = jump
  useEffect(() => {
    if (!jumpStore) return
    jumpStore.run = () => jumpRef.current()
    return () => {
      jumpStore.run = null
      jumpStore.set(NOT_AWAY)
    }
  }, [jumpStore])
  // The latest row (useLatestRow) in view: at least half of it, or of the view. Watched by an IntersectionObserver,
  // not on every scroll; its thresholds step 5% of the row, fine enough for a row up to a few screens tall.
  const [latestRow, setLatestRow] = useState<Element | null>(null)
  const [atLatest, setAtLatest] = useState(false)
  useEffect(() => {
    const root = scroller.current
    if (!latestRow || !root || typeof IntersectionObserver === "undefined") return setAtLatest(false)
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries.at(-1)!
        const view = e.rootBounds?.height ?? root.getBoundingClientRect().height
        setAtLatest(e.isIntersecting && e.intersectionRect.height >= Math.min(e.boundingClientRect.height, view) / 2)
      },
      { root, threshold: Array.from({ length: 21 }, (_, i) => i / 20) },
    )
    io.observe(latestRow)
    return () => io.disconnect()
  }, [latestRow])
  const jumpAway = away && (unread > 0 || !atLatest)
  useEffect(() => jumpStore?.set({ away: jumpAway, unread }), [jumpStore, jumpAway, unread])
  const floatJump = jumpAway && !jumpStore

  // Whether the overlay shows something besides "Jump to latest" (`overlay` may render nothing), for the room under
  // the last row. Watched on the overlay itself, not with a CSS :has() on the list: with that, any element added
  // anywhere in the list (a new message, a streamed paragraph) restyled every rendered row.
  const [overlayBox, setOverlayBox] = useState<HTMLDivElement | null>(null)
  const [room, setRoom] = useState(false)
  useLayoutEffect(() => {
    if (!overlayBox) return setRoom(false)
    const check = () => setRoom(overlayBox.querySelector(":scope > :not([data-jump])") !== null)
    check()
    const mo = new MutationObserver(check)
    mo.observe(overlayBox, { childList: true })
    return () => mo.disconnect()
  }, [overlayBox])

  // After a send, from however far up: straight to the bottom, with no glide, so the sent message is in view at once.
  // The pin then follows whatever renders later (the resize observer above, and WebKit's own moves in onScroll).
  // Scrolling up again unpins as usual, so the streaming reply doesn't pull the view back down.
  const scrollToEnd = useCallback(() => jumpRef.current(false), [])
  useImperativeHandle(handle, () => ({ scrollToEnd }), [scrollToEnd])

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* relative z-0: the list is its own stacking context, so what's inside it (the cards' sticky z-20 headers, their
          menus) stays under the overlay, whatever its z-index. */}
      <div ref={scroller} data-scroller tabIndex={-1} onScroll={onScroll} className={cx("scroll-thin relative z-0 min-h-0 flex-1 overflow-x-hidden overflow-y-auto [overflow-anchor:none]", className)}>
        <div ref={content} className={cx("flow-root", contentClassName)}>
          {hidden > 0 && (
            <button
              ref={sentinel}
              type="button"
              onClick={loadEarlier}
              className="block min-h-11 w-full py-1 text-center text-xs text-zinc-500 hover:text-zinc-300"
            >
              {earlierLabel ?? `Show ${hidden} earlier message${hidden === 1 ? "" : "s"}`}
            </button>
          )}
          <LatestRow.Provider value={setLatestRow}>{children}</LatestRow.Provider>
        </div>
        {/* Room under the last row while the overlay shows something, so at the bottom it covers nothing. Not for "Jump to
            latest": it shows only away from the bottom, and room that came and went with it moved the list every time
            it pinned or let go (reaching the bottom pulled the view up by the room). */}
        <div aria-hidden data-testid="overlay-room" className={cx("h-12 pointer-coarse:h-16", !room && "hidden")} />
      </div>
      {(floatJump || overlay) && (
        <div ref={setOverlayBox} data-overlay data-chat-float className="pointer-events-none absolute bottom-3 left-1/2 z-10 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-2 *:pointer-events-auto">
          {overlay}
          {floatJump && (
            <button
              type="button"
              data-jump
              onClick={() => jump()}
              aria-label={unread > 0 ? `Jump to latest, ${unread} new messages` : "Jump to latest"}
              className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900/95 px-3 py-1.5 text-xs font-medium whitespace-nowrap text-zinc-100 shadow-lg hover:bg-zinc-800"
            >
              <ArrowDown className="h-3.5 w-3.5" aria-hidden />
              {unread > 0 ? `${unread} new message${unread === 1 ? "" : "s"}` : "Jump to latest"}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
