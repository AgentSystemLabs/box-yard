import { useCallback, useEffect, useRef, useState } from "react"
import type { KeyboardEvent, PointerEvent } from "react"
import { cx } from "../components/ui"
import { onSuspend } from "./resume"

type Options = {
  /** localStorage key the width is saved under; not used with `value` */
  key?: string
  defaultWidth: number
  min: number
  max: number
  /** which edge of the panel the handle sits on: "right" grows the panel when dragged right */
  edge: "left" | "right"
  /** a tighter max for now (the room left in the window); the saved width isn't clamped to it until a drag */
  limit?: number
  /** Stop a drag when the panel becomes a rail or drawer. */
  enabled?: boolean
  /** The width, when the caller keeps it (in memory: the conversation panels). Nothing then goes to localStorage. */
  value?: number
  /** Where a new width goes, with `value`: on every move of a drag. */
  onChange?: (width: number) => void
  /** What a double-click or Enter does instead of going back to `defaultWidth`. */
  onReset?: () => void
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

function load({ key, defaultWidth, min, max }: Options) {
  if (!key) return defaultWidth
  try {
    const n = Number(localStorage.getItem(key))
    if (Number.isFinite(n) && n > 0) return clamp(n, min, max)
  } catch {
    /* storage unavailable */
  }
  return defaultWidth
}

/**
 * A panel width the user can drag, persisted in localStorage (or kept by the caller: `value` and `onChange`). Spread
 * `handle` props onto <ResizeHandle>.
 */
export function useResizable(opts: Options) {
  const { key, defaultWidth, min, edge, enabled = true } = opts
  const max = Math.max(min, Math.min(opts.max, opts.limit ?? opts.max))
  const controlled = opts.value !== undefined
  const [own, setOwn] = useState(() => (controlled ? defaultWidth : load(opts)))
  const width = opts.value ?? own
  const setWidth = opts.onChange ?? setOwn
  const [active, setDragging] = useState(false)
  const dragging = enabled && active
  const start = useRef({ x: 0, w: 0 })
  const latest = useRef(width)
  latest.current = width
  const maxRef = useRef(max)
  maxRef.current = max

  const save = (w: number) => {
    if (controlled || !key) return
    try {
      if (w === defaultWidth) localStorage.removeItem(key)
      else localStorage.setItem(key, String(w))
    } catch {
      /* storage unavailable: the width just won't persist */
    }
  }

  useEffect(() => {
    if (!enabled) setDragging(false)
  }, [enabled])

  useEffect(() => {
    if (!dragging) return
    document.body.classList.add("resizing")
    // A drag whose pointerup never came (the page went to the background) ends there.
    const offSuspend = onSuspend(() => setDragging(false))
    return () => {
      offSuspend()
      document.body.classList.remove("resizing")
    }
  }, [dragging])

  const onPointerDown = useCallback((e: PointerEvent) => {
    if (!enabled || e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    // Start from the width on screen, which may be the saved one shrunk to fit.
    start.current = { x: e.clientX, w: clamp(latest.current, min, maxRef.current) }
    setDragging(true)
  }, [enabled, min])

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return
    const dx = e.clientX - start.current.x
    setWidth(clamp(start.current.w + (edge === "right" ? dx : -dx), min, max))
  }

  const stop = () => {
    if (!dragging) return
    setDragging(false)
    save(latest.current)
  }

  const reset = () => {
    if (opts.onReset) return opts.onReset()
    setWidth(defaultWidth)
    save(defaultWidth)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const step = e.shiftKey ? 50 : 10
    const current = clamp(latest.current, min, max)
    let next: number
    switch (e.key) {
      case "ArrowLeft": next = current + (edge === "right" ? -step : step); break
      case "ArrowRight": next = current + (edge === "right" ? step : -step); break
      case "Home": next = min; break
      case "End": next = max; break
      case "Enter":
        e.preventDefault()
        reset()
        return
      default: return
    }
    e.preventDefault()
    next = clamp(next, min, max)
    setWidth(next)
    save(next)
  }

  const handle = {
    dragging, edge, onPointerDown, onPointerMove, onPointerUp: stop, onPointerCancel: stop, onLostPointerCapture: stop, onDoubleClick: reset, onKeyDown,
    "aria-valuemin": min, "aria-valuemax": max, "aria-valuenow": clamp(width, min, max),
  }
  return { width, handle }
}

type HandleProps = ReturnType<typeof useResizable>["handle"]

/**
 * The drag strip on a panel border: a 1px line on the border, lit while hovered, focused or dragged, and a 12px zone
 * to grab beside it, plus a 44px grip halfway down for a finger (pointer: coarse). The zone lies right of the border
 * (inside a panel's left edge, past a panel's right edge), because left of it is a scrollbar. `className` picks where
 * the panel sits beside the content (e.g. "@min-[48rem]/app:block"). `inside` keeps a right edge's strip within the
 * panel, for a panel that clips its overflow. `belowHeader` starts the zone under a 3.5rem header row, so a Back
 * button in the panel's corner stays clickable.
 */
export function ResizeHandle({
  dragging,
  edge,
  className,
  inside,
  belowHeader,
  label = "Panel width",
  ...events
}: HandleProps & { className: string; inside?: boolean; belowHeader?: boolean; label?: string }) {
  // Left of the panel: just inside it. Right of it: just past it, or (`inside`) its last 12px.
  const after = edge === "right" && !inside
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      title="Drag or use arrow keys to resize; double-click or press Enter to reset"
      data-dragging={dragging || undefined}
      {...events}
      className={cx(
        "group absolute bottom-0 z-20 hidden w-3 cursor-col-resize touch-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-yard-500",
        belowHeader ? "top-14" : "top-0",
        className,
        edge === "left" ? "left-0" : after ? "left-full" : "right-0",
      )}
    >
      <span
        aria-hidden
        className={cx(
          "pointer-events-none absolute bottom-0 w-px",
          belowHeader ? "-top-14" : "top-0",
          edge === "left" ? "left-0" : after ? "-left-px" : "right-0",
          dragging ? "bg-yard-500" : "group-hover:bg-yard-500/60 group-focus-visible:bg-yard-500",
        )}
      />
      <span aria-hidden data-testid="resize-grip" className={cx("absolute top-1/2 hidden h-22 w-11 -translate-y-1/2 pointer-coarse:block", after || edge === "left" ? "left-0" : "right-0")}>
        <span className={cx("absolute top-1/2 h-10 w-1 -translate-y-1/2 rounded-full", after || edge === "left" ? "left-1" : "right-1", dragging ? "bg-yard-500" : "bg-zinc-600")} />
      </span>
    </div>
  )
}

/** An element's width in px, kept current while it's mounted; undefined until measured. */
export function useElementWidth(el: Element | null | undefined): number | undefined {
  const [width, setWidth] = useState<number>()
  useEffect(() => {
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => setWidth(el.getBoundingClientRect().width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return width
}
