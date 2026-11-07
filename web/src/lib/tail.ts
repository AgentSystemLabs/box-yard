import { startTransition, useCallback, useEffect, useMemo, useReducer, useRef } from "react"

/** Index of the first item to render: the pinned one, or the newest `initial` items if it's gone. */
export function tailStart(items: { id: string }[], pinnedId: string | null, initial: number): number {
  const at = pinnedId ? items.findIndex((m) => m.id === pinnedId) : -1
  return at >= 0 ? at : Math.max(0, items.length - initial)
}

/**
 * Where the tail should start after trimming, or null to leave it: once more than twice `initial` items are
 * rendered, back to the newest `initial`. The slack keeps a list that loaded a page of older items from
 * trimming on every new item.
 */
export function trimmedStart(length: number, start: number, initial: number): number | null {
  return length - start > initial * 2 ? length - initial : null
}

// A press that's about to open another chat holds the growing back (lib/captainPrerender.ts): each step renders as a
// transition, above that chat's hidden pre-render, which would start over after every one. The held steps go on
// once the press is over.
let growthHeld = false
const heldSteps = new Set<() => void>()

/** Hold the first paints' growing (`useTail`'s `first`), or let it go on. */
export function holdTailGrowth(hold: boolean) {
  growthHeld = hold
  if (hold) return
  const steps = [...heldSteps]
  heldSteps.clear()
  for (const step of steps) step()
}

// How many rows each list (by its resetKey) needs for its first paint to reach past the view, as of its last first paint
// that did (StickyScroll's `onFilled`), and the last such count: the list's next first paint, or that of a list not
// shown yet, starts from that many, so it renders and lays out once rather than filling up in a second render and
// layout (`fill`). Another list's count is only a guess, so it goes no higher than `GUESS_TIMES` the least: a chat of
// one-liners shouldn't make every chat opened after it build dozens of rows first. Counts only, in memory.
const fills = new Map<unknown, number>()
let lastFilled = 0
const GUESS_TIMES = 4

/** The rows a list's first paint starts from: `min`, or as many as it (or else the last list) took to fill the view. */
export function firstPaintRows(key: unknown, min: number): number {
  return Math.max(min, fills.get(key) ?? Math.min(lastFilled, min * GUESS_TIMES))
}

/** Back to a page that hasn't filled any list yet; for tests. */
export function resetFirstPaintRows() {
  fills.clear()
  lastFilled = 0
}

/**
 * Render only the newest part of a long list and grow it towards older items on
 * demand (StickyScroll calls `loadEarlier` as you scroll near the top).
 *
 * The first shown item is pinned by id, so new items arriving at the end never
 * push older ones out from under someone who is reading. A new `resetKey`
 * (another task) starts over from the newest `initial` items, and so does a
 * pinned item that's gone (e.g. tool calls hidden).
 *
 * Pinning alone would let the rendered part grow for as long as the page stays open (a phone's home-screen
 * app stays open for days), until every layout, keyboard and rotation takes seconds. So `trim` drops back to
 * the newest items; StickyScroll calls it while the reader is at the bottom, where nothing moves.
 *
 * With `max`, reading older items keeps at most that many rows, with `later`/`loadLater` to move forward again.
 * `reset` returns to the newest rows after a send or a latest jump.
 *
 * With `first` under `initial`, a list's first paint (a task just opened) has only its newest `first` items, a
 * screenful or more, so it's on screen sooner; the rest of the newest `initial` render right after that paint, `grow`
 * more a frame (all at once by default), and `growing` says so meanwhile. `fill` doubles them at once, for a first paint
 * that doesn't fill the screen (StickyScroll's `onFill`), and `filled` (StickyScroll's `onFilled`) keeps how many it
 * took for the next first paint (firstPaintRows).
 */
export function useTail<T extends { id: string }>(
  items: T[],
  resetKey: unknown,
  { initial = 60, step = 50, first = initial, grow = initial, max = Infinity }: { initial?: number; step?: number; first?: number; grow?: number; max?: number } = {},
) {
  const following = useRef(true)
  const pinned = useRef<{ key: unknown; id: string | null }>({ key: resetKey, id: null })
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  if (pinned.current.key !== resetKey) { pinned.current = { key: resetKey, id: null }; following.current = true }

  // Nothing pinned yet: a list not shown before.
  const start = tailStart(items, pinned.current.id, pinned.current.id === null ? Math.min(first, initial) : initial)
  pinned.current.id = items[start]?.id ?? null

  const latest = useRef({ items, start })
  latest.current = { items, start }

  const end = Math.min(items.length, start + max)
  const visible = useMemo(() => (start || end < items.length ? items.slice(start, end) : items), [items, start, end])
  const loadLater = useCallback(() => {
    const { items, start } = latest.current
    const to = Math.min(items.length - 1, start + step)
    pinned.current.id = items[to]?.id ?? null
    following.current = to + max >= items.length
    rerender()
  }, [step, max])

  /** Show `step` more older items (than the newest `initial`, during a short first paint). */
  const loadEarlier = useCallback(() => {
    const { items, start } = latest.current
    if (!start) return
    const to = Math.max(0, Math.min(start, items.length - initial) - step)
    pinned.current.id = items[to]!.id
    following.current = to + max >= items.length
    rerender()
  }, [step, initial, max])

  // Fewer than the newest `initial` rendered, with more there: the first paint's. Grow once it's on screen (the frame,
  // then a task after it), `grow` items at a time, a frame apart, so a click or a scroll never waits behind them all.
  // A step renders as a transition, in slices a tap can come between (React sets it aside for the tap and renders it
  // again after): rendered in one go, a step of a long chat's rows (~70 ms on a phone) held up a tap right after launch.
  const short = start > Math.max(0, items.length - initial)
  useEffect(() => {
    if (!short) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const step = () => {
      const { items, start } = latest.current
      const to = Math.max(0, items.length - initial)
      if (start <= to) return
      pinned.current.id = items[Math.max(to, start - grow)]!.id
      startTransition(rerender)
    }
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => (growthHeld ? heldSteps.add(step) : step()))
    })
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      heldSteps.delete(step)
    }
  }, [short, start, initial, grow])

  // Hidden (a chat the centre keeps for going back to, lib/keptChats.ts), go back to the first paint's items, as a list
  // not shown before: React renders that while it waits, so shown again it lays out and starts only those, and the rest
  // grow in after it as on a first open. Kept whole, a chat of 60 rows took longer to show again than to build anew.
  // (Hiding is the only time this runs before an unmount, where it does nothing.)
  useEffect(
    () => () => {
      pinned.current = { key: pinned.current.key, id: null }
      rerender()
    },
    [],
  )

  /** Render twice as many items now, up to the newest `initial`. False when they're all there already. */
  const fill = useCallback(() => {
    const { items, start } = latest.current
    const to = Math.max(0, items.length - initial, start - Math.max(first, items.length - start))
    if (to >= start) return false
    pinned.current.id = items[to]!.id
    rerender()
    return true
  }, [first, initial])

  /**
   * The rendered items reach past the view, which shows `share` of them (by height): the next first paint starts from
   * about as many as that takes, and one more (firstPaintRows).
   */
  const filled = useCallback((share: number) => {
    const { items, start } = latest.current
    const rendered = items.length - start
    lastFilled = Math.min(rendered, Math.ceil(rendered * share) + 1)
    fills.set(pinned.current.key, lastFilled)
  }, [])

  /** Render only the newest `initial` items again, if many more than that are rendered. */
  const trim = useCallback(() => {
    if (!following.current) return
    const { items, start } = latest.current
    const to = items.length - start > max ? Math.max(0, items.length - Math.min(initial, max)) : trimmedStart(items.length, start, initial)
    if (to === null) return
    pinned.current.id = items[to]!.id
    rerender()
  }, [initial, max])

  /** Make sure the item with this id is rendered. Returns false if it isn't in the list at all. */
  const reveal = useCallback((id: string) => {
    const { items, start } = latest.current
    const idx = items.findIndex((m) => m.id === id)
    if (idx < 0) return false
    if (idx < start || idx >= start + max) {
      const to = Math.max(0, idx - 5)
      pinned.current.id = items[to]!.id
      following.current = to + max >= items.length
      rerender()
    }
    return true
  }, [max])

  const reset = useCallback(() => { following.current = true; pinned.current.id = null; rerender() }, [])

  return { reset, visible, hidden: start, later: items.length - end, loadLater, growing: short, loadEarlier, fill, filled, trim, reveal }
}

/**
 * StickyScroll's `count` for a list that can also grow at its start: the items from the first one it opened with, so
 * history loading in above a prefetched Captain's newest messages (lib/captainPrefetch.ts) doesn't count as new
 * messages at the end (an "N new" badge for someone who scrolled up).
 */
export function useCountFromFirst(items: { id: string }[], resetKey: unknown): number {
  const first = useRef<{ key: unknown; id: string | undefined }>({ key: resetKey, id: undefined })
  if (first.current.key !== resetKey || first.current.id === undefined) first.current = { key: resetKey, id: items[0]?.id }
  const id = first.current.id
  return useMemo(() => items.length - Math.max(0, id === undefined ? 0 : items.findIndex((m) => m.id === id)), [items, id])
}
