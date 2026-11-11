import { useEffect, useState } from "react"

type Viewport = Pick<VisualViewport, "height" | "offsetTop" | "scale">

/**
 * How much of the window's bottom an on-screen keyboard covers, in CSS px. A phone's keyboard shrinks only the visual
 * viewport: a `fixed` sheet keeps its place and ends up under the keys. 0 with no keyboard, for a browser bar that
 * comes and goes (under 80px), and while pinch-zoomed, where the visual viewport is a magnifier.
 */
export function keyboardInset(innerHeight: number, viewport: Viewport | null | undefined): number {
  if (!viewport || Math.abs(viewport.scale - 1) > 0.01) return 0
  const inset = Math.round(innerHeight - viewport.height - viewport.offsetTop)
  return inset >= 80 ? inset : 0
}

/** `keyboardInset`, live while `on`: a sheet with a search field lifts itself over the keyboard with it. */
export function useKeyboardInset(on: boolean): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const viewport = typeof window === "undefined" ? null : window.visualViewport
    if (!on || !viewport) return
    const measure = () => setInset(keyboardInset(window.innerHeight, viewport))
    measure()
    viewport.addEventListener("resize", measure)
    viewport.addEventListener("scroll", measure)
    return () => {
      viewport.removeEventListener("resize", measure)
      viewport.removeEventListener("scroll", measure)
      setInset(0)
    }
  }, [on])
  return inset
}
