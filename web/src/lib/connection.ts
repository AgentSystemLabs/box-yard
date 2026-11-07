// Live connection health: is the server's event stream (lib/stream.ts) open? The stream reports here; every Composer
// reads it to say "Reconnecting…" or "You're offline" and to hold a message sent meanwhile until the stream is back
// (ConnectionLine.tsx). A store outside React, so a change re-renders the composers and nothing else.
//
// Only the stream decides whether sends wait. The browser's online flag picks the words: a Box Yard on this computer
// (localhost) keeps working with the Wi-Fi off, so "offline" alone holds nothing back.
import { useSyncExternalStore } from "react"

/** What the composers say: nothing (null), why the stream is gone, or that it just came back. */
export type ConnectionView = "reconnecting" | "offline" | "back" | null

export interface ConnectionState {
  /** The stream is open: a send goes out now. */
  live: boolean
  view: ConnectionView
}

/** A drop shorter than this (a server restart, a phone back from the background) shows nothing; sends still wait for it. */
export const RECONNECT_GRACE_MS = 2500
/** How long "Reconnected" stays after an outage the composers showed. */
export const BACK_MS = 3000

const browser = typeof window !== "undefined"

let down = false
let graceOver = false
let online = !browser || navigator.onLine !== false
let back = false
/** An outage was on screen, so its end gets a "Reconnected". */
let shown = false
let grace: ReturnType<typeof setTimeout> | null = null
let backTimer: ReturnType<typeof setTimeout> | null = null
let reconnect: (() => void) | null = null
let state: ConnectionState = { live: true, view: null }
const listeners = new Set<() => void>()

function update() {
  if (down) {
    back = false
    if (backTimer) clearTimeout(backTimer)
    backTimer = null
  } else if (shown) {
    shown = false
    back = true
    backTimer = setTimeout(() => {
      back = false
      backTimer = null
      update()
    }, BACK_MS)
  }
  const view: ConnectionView = down ? (graceOver ? (online ? "reconnecting" : "offline") : null) : back ? "back" : null
  if (view === "reconnecting" || view === "offline") shown = true
  if (view === state.view && !down === state.live) return
  state = { live: !down, view }
  listeners.forEach((l) => l())
}

/** The stream opened (true), or dropped or was replaced (false). */
export function reportStream(open: boolean) {
  if (open !== down) return
  down = !open
  if (grace) clearTimeout(grace)
  grace = null
  graceOver = false
  if (down)
    grace = setTimeout(() => {
      grace = null
      graceOver = true
      update()
    }, RECONNECT_GRACE_MS)
  update()
}

/** The browser's word on the network: it only picks the words (lib/stream.ts reopens the stream on either change). */
export function reportOnline(on: boolean) {
  online = on
  update()
}

/** lib/stream.ts: how to reopen the stream now. Returns an unregister. */
export function setReconnectHandler(fn: () => void): () => void {
  reconnect = fn
  return () => {
    if (reconnect === fn) reconnect = null
  }
}

/** "Retry": reopen the stream now instead of at the next try. */
export const reconnectNow = () => reconnect?.()

export const connectionState = () => state

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export const useConnection = () => useSyncExternalStore(subscribe, connectionState, connectionState)

/** Just whether sends go out now, so a Composer re-renders when that flips and not for "Reconnected". */
export const useConnectionLive = () => useSyncExternalStore(subscribe, () => state.live, () => state.live)

/** Tests only: live again, with no timers. */
export function resetConnection() {
  if (grace) clearTimeout(grace)
  if (backTimer) clearTimeout(backTimer)
  grace = backTimer = null
  down = graceOver = back = shown = false
  online = true
  reconnect = null
  state = { live: true, view: null }
  listeners.forEach((l) => l())
}
