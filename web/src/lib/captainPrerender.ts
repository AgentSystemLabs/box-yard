// A Captain's chat starts rendering the moment a press on its sidebar row says it's about to open, hidden behind the
// centre's chat (<Activity mode="hidden"> in App.tsx's CentreChat), so the click that follows only shows it. A mouse
// resting on the row starts it too, as a bonus: the press alone is enough. On a phone the finger is down for a tenth of
// a second or so before the click, which is most of what building the chat takes.
//
// A hidden pre-render has no side effects: React mounts none of its effects until it's shown, so it subscribes to
// nothing, fetches nothing, focuses nothing and saves no scroll spot. It renders only from what's already in memory:
// a Captain whose conversation isn't cached yet isn't pre-rendered. A press that turns into a scroll, a cancelled
// press, a release off the row, or a click that never comes throws it away.
//
// While a press is down, the chat on screen stops growing its first paint's rows (holdTailGrowth): each step would start
// the pre-render over, and that chat is about to go.
import { useEffect, useSyncExternalStore } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { keys } from "./queries"
import { chatProjectFilter } from "./projectBar"
import { holdTailGrowth } from "./tail"
import { HOVER_INTENT_MS } from "./taskPrefetch"

/** On a phone the click follows the finger lifting once the browser has seen it was a tap; one this late isn't coming. */
export const CLICK_GRACE_MS = 400

let ahead: string | null = null
const listeners = new Set<() => void>()
const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function setAhead(projectId: string | null) {
  if (ahead === projectId) return
  ahead = projectId
  for (const l of listeners) l()
}

/** The Captain being rendered ahead of its click, hidden, if any. */
export const prerenderedCaptain = () => ahead

/** CentreChat's half: the Captain to render hidden beside the centre's chat. */
export const usePrerenderedCaptain = () => useSyncExternalStore(subscribe, () => ahead, () => null)

/** The sidebar row a pointer event is on, when it opens a Captain (marked data-open-captain). */
const captainRow = (el: EventTarget | null) => (el instanceof Element ? el.closest<HTMLElement>("[data-open-captain]") : null)

/** Mounted once (App), signed in: pre-render the Captain under a press, or under a mouse resting on its row. */
export function useCaptainPrerender(enabled: boolean) {
  const qc = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    // The row the pre-render is for, whether it's pressed, and the waits for a resting hover and for the click.
    let row: HTMLElement | null = null
    let pressed = false
    let hoverTimer: ReturnType<typeof setTimeout> | undefined
    let clickTimer: ReturnType<typeof setTimeout> | undefined
    const drop = () => {
      clearTimeout(hoverTimer)
      clearTimeout(clickTimer)
      row = null
      pressed = false
      setAhead(null)
      holdTailGrowth(false)
    }
    // Only a Captain that isn't the one shown, with its conversation in memory: a pre-render fetches nothing.
    const start = (el: HTMLElement) => {
      const id = el.dataset.openCaptain
      row = el
      setAhead(id && id !== chatProjectFilter() && qc.getQueryData(keys.captainMessages(id)) !== undefined ? id : null)
    }

    // The press is what counts: a finger or a button going down on a Captain's row. One anywhere else drops it.
    const press = (e: PointerEvent) => {
      if (!e.isPrimary) return
      clearTimeout(hoverTimer)
      clearTimeout(clickTimer)
      const el = captainRow(e.target)
      if (!el) return drop()
      pressed = true
      start(el)
      holdTailGrowth(ahead !== null)
    }
    // Let go on the row: the click comes now, or on a phone a moment later. Let go off it: no click is coming.
    const release = (e: PointerEvent) => {
      if (!pressed || !e.isPrimary) return
      pressed = false
      if (captainRow(e.target) !== row) return drop()
      clickTimer = setTimeout(drop, CLICK_GRACE_MS)
    }
    // The click has come and shown it (or gone elsewhere): done, once React has handled it.
    const click = () => void setTimeout(drop)
    // A mouse resting on a row starts it too; moving off the row, unpressed, drops it.
    const hover = (e: PointerEvent) => {
      if (e.pointerType === "touch" || pressed) return
      const el = captainRow(e.target)
      if (el === row) return
      clearTimeout(hoverTimer)
      if (!el) return drop()
      hoverTimer = setTimeout(() => start(el), HOVER_INTENT_MS)
    }
    // The list scrolling under the row (a press that was a swipe) throws it away.
    const scroll = (e: Event) => {
      if (row && e.target instanceof Node && e.target.contains(row)) drop()
    }

    const opts = { capture: true, passive: true }
    document.addEventListener("pointerdown", press, opts)
    document.addEventListener("pointerup", release, opts)
    document.addEventListener("pointercancel", drop, opts)
    document.addEventListener("click", click, opts)
    document.addEventListener("pointerover", hover, opts)
    document.addEventListener("scroll", scroll, opts)
    return () => {
      document.removeEventListener("pointerdown", press, opts)
      document.removeEventListener("pointerup", release, opts)
      document.removeEventListener("pointercancel", drop, opts)
      document.removeEventListener("click", click, opts)
      document.removeEventListener("pointerover", hover, opts)
      document.removeEventListener("scroll", scroll, opts)
      drop()
    }
  }, [enabled, qc])
}
