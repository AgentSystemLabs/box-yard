// The owner is about to write to a Captain: its composer took the focus or got typed in. The server starts that
// Captain's warm claude process now (Settings › Coordinator › Warm Claude process), so the message's turn skips
// Claude Code's start-up, and the idle time it may wait for the owner starts over. With the setting off the server
// does nothing.

import { useEffect, type RefObject } from "react"
import { api } from "./api"

/** At most one ping a minute per Captain: the idle time is minutes, so finer doesn't change anything. */
const PING_EVERY_MS = 60_000
const pinged = new Map<string, number>()

export function warmCaptain(projectId: string, now = Date.now()) {
  if (now - (pinged.get(projectId) ?? -Infinity) < PING_EVERY_MS) return
  pinged.set(projectId, now)
  api(`/api/projects/${encodeURIComponent(projectId)}/captain/warm`, { method: "POST", priority: "low" }).catch(() => pinged.delete(projectId))
}

/** Pings the Captain's warm-up when its composer box takes the focus or is typed in. */
export function useWarmCaptain(projectId: string, box: RefObject<HTMLTextAreaElement | null>, centre: boolean) {
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ping = () => warmCaptain(projectId)
    el.addEventListener("focus", ping)
    el.addEventListener("input", ping)
    if (document.activeElement === el) ping()
    return () => {
      el.removeEventListener("focus", ping)
      el.removeEventListener("input", ping)
    }
    // `centre` swaps the composer (and its box) for another.
  }, [projectId, box, centre])
}
