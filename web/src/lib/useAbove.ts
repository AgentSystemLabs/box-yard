import { useLayoutEffect, useState, type RefObject } from "react"

/** Where a list sits: just over `anchor` (the composer's box), as wide as it, never past the top of the screen. */
export function useAbove(anchor: RefObject<HTMLElement | null>) {
  const [box, setBox] = useState<{ left: number; width: number; bottom: number; maxHeight: number } | null>(null)
  useLayoutEffect(() => {
    const el = anchor.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      const vh = window.innerHeight
      setBox((b) => {
        const next = { left: r.left, width: r.width, bottom: vh - r.top + 6, maxHeight: Math.max(120, Math.min(320, r.top - 12)) }
        return b && b.left === next.left && b.width === next.width && b.bottom === next.bottom && b.maxHeight === next.maxHeight ? b : next
      })
    }
    measure()
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null
    ro?.observe(el)
    window.addEventListener("resize", measure)
    window.addEventListener("scroll", measure, true)
    window.visualViewport?.addEventListener("resize", measure)
    return () => {
      ro?.disconnect()
      window.removeEventListener("resize", measure)
      window.removeEventListener("scroll", measure, true)
      window.visualViewport?.removeEventListener("resize", measure)
    }
  }, [anchor])
  return box
}
