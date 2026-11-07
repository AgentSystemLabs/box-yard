// The centre keeps the chats you left last mounted, hidden (App.tsx's CentreChat, each in <Activity mode="hidden">),
// so going back to one only shows it: React keeps its rows and their DOM, and mounts its effects again on the way back.
//
// Hidden, a chat mounts no effects, so it listens to nothing and never renders while it waits: a message for it, a
// clock tick or a project update renders nothing until it's shown, and showing it catches it up. Its props stay the
// same (a project id, no panel), so the centre rendering again doesn't render it either.
//
// At most KEEP_CHATS, one on a phone with little memory, none while the JS heap is nearly full, and all of them go
// when the tab is hidden. Memory only, like the conversations themselves: nothing is written anywhere.
import { useEffect, useState } from "react"

/** How many chats the centre keeps hidden, besides the one shown. */
export const KEEP_CHATS = 2
/** A device with less memory than this (GB, `navigator.deviceMemory`) keeps one. */
const LOW_MEMORY_GB = 4
/** With more of the JS heap's limit than this in use (`performance.memory`, Chrome), none. */
const HEAP_FULL = 0.6

type Heap = { usedJSHeapSize: number; jsHeapSizeLimit: number }

/** How many chats to keep hidden now. */
export function keepLimit(): number {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return 0
  const heap = (globalThis.performance as (Performance & { memory?: Heap }) | undefined)?.memory
  if (heap && heap.jsHeapSizeLimit > 0 && heap.usedJSHeapSize > heap.jsHeapSizeLimit * HEAP_FULL) return 0
  const device = (globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined)?.deviceMemory
  return device !== undefined && device < LOW_MEMORY_GB ? 1 : KEEP_CHATS
}

/**
 * The chats (the centre's keys) to keep hidden beside `shown`: the ones left last, most recent first, up to
 * keepLimit() as of leaving one. A hidden tab drops them.
 */
export function useKeptChats(shown: string): string[] {
  const [left, setLeft] = useState<{ shown: string; kept: string[] }>({ shown, kept: [] })
  let kept = left.kept
  if (left.shown !== shown) {
    kept = [left.shown, ...kept.filter((k) => k !== left.shown && k !== shown)].slice(0, keepLimit())
    setLeft({ shown, kept })
  }
  useEffect(() => {
    const away = () => {
      if (document.visibilityState === "hidden") setLeft((l) => (l.kept.length ? { ...l, kept: [] } : l))
    }
    document.addEventListener("visibilitychange", away)
    return () => document.removeEventListener("visibilitychange", away)
  }, [])
  return kept
}
