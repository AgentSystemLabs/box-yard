// The app's first requests start with the page, beside its own script instead of after it: the inline script in
// web/index.html asks for /api/me, opens the event stream and fetches GET /api/boot, which answers the GETs every load
// makes in one gzipped response (shared/boot.ts) instead of a dozen queued behind the browser's six connections. Once
// that's in, it asks for every Captain's newest messages (GET /api/captains/recent, lib/captainPrefetch.ts).
// The answers go into the query cache together (lib/bootSeed.ts), so the app's first render has them all; a GET made
// while they're on the way waits for them (lib/api.ts). The live stream (lib/stream.ts) takes over the page's stream
// with what it heard so far, dropping the events the snapshot already includes.
// Memory only: nothing here goes to any browser storage.
import { isBootPath, type BootPayload, type StreamPosition } from "../../../shared/boot"

/** What web/index.html started. */
export interface EarlyStart {
  me: Promise<unknown>
  boot: Promise<BootPayload | null>
  /** GET /api/captains/recent, asked for once the boot data is in (null: signed out, or it failed). */
  recent?: Promise<unknown>
  stream: EventSource | null
  /** What the stream said before the app took it, in order: its "hello", then its messages and "boot" marks. */
  heard: MessageEvent[]
  /** The stream failed before the app took it (signed out, the server went away): the app opens its own. */
  failed: boolean
  /** The page's own listener, removed when the app takes the stream. */
  listen: (e: MessageEvent) => void
}

declare global {
  interface Window {
    __boxYardEarly?: EarlyStart
  }
}

let early: EarlyStart | null = null
let meTaken = false
let recentTaken = false
let boot: BootPayload | null = null
let pending = false
let settled: Promise<void> = Promise.resolve()

/** Puts what arrives into the query cache: /api/me, and the boot data (done when its promise settles). */
export interface EarlySeed {
  me: (data: unknown) => void
  boot: (payload: BootPayload) => void | Promise<void>
}

/** Pick up what the page started (once, as the app loads; tests pass their own), seeding the cache as it arrives. */
export function adoptEarlyStart(seed: EarlySeed, start: EarlyStart | undefined = typeof window === "undefined" ? undefined : window.__boxYardEarly) {
  if (typeof window !== "undefined") delete window.__boxYardEarly
  early = start ?? null
  meTaken = false
  recentTaken = false
  boot = null
  pending = Boolean(early)
  if (!early) return void (settled = Promise.resolve())
  // Already here, it's in the cache before the app's first render.
  void early.me.then((data) => {
    if (data) seed.me(data)
  })
  settled = early.boot
    .then((payload) => {
      if (!payload?.responses || !payload.stream) return
      boot = payload
      return seed.boot(payload)
    })
    .catch(() => {})
    .finally(() => void (pending = false))
}

/**
 * The page's early answer for a GET of `path`, if it has one. Undefined: ask the server. /api/me's and
 * /api/captains/recent's are handed out once.
 * While the boot data is on its way, a GET of a path it answers waits for it (two queries read /api/health); once it's
 * in, GETs go to the server, and events newer than the boot data keep it current until then.
 */
export function takeEarly(path: string): Promise<unknown> | undefined {
  if (!early) return undefined
  if (path === "/api/me") {
    if (meTaken) return undefined
    meTaken = true
    return early.me.then((data) => data ?? undefined)
  }
  if (path === "/api/captains/recent" && early.recent) {
    if (recentTaken) return undefined
    recentTaken = true
    return early.recent.then((data) => data ?? undefined)
  }
  if (!pending || !isBootPath(path)) return undefined
  return settled.then(() => boot?.responses[path])
}

/** Run `fn` now, or once the boot data on its way is in (or failed): events must not land before the data they update. */
export function afterBoot(fn: () => void) {
  if (pending) void settled.then(fn)
  else fn()
}

/**
 * The page's event stream, for the live stream to take over (once). Null: open a new one (none was opened, or it
 * failed). Set your handlers, then `replay` it to hear what it heard before, in order.
 */
export function takeEarlyStream(): { es: EventSource; replay: () => void } | null {
  const start = early
  const es = start?.stream
  if (!start || !es) return null
  start.stream = null
  es.removeEventListener("hello", start.listen)
  es.removeEventListener("boot", start.listen)
  es.removeEventListener("message", start.listen)
  if (start.failed || es.readyState === EventSource.CLOSED) {
    es.close()
    return null
  }
  const heard = start.heard
  start.heard = []
  return { es, replay: () => heard.forEach((e) => es.dispatchEvent(new MessageEvent(e.type, { data: e.data }))) }
}

const positionOf = (e: MessageEvent): StreamPosition | null => {
  try {
    return JSON.parse(e.data)
  } catch {
    return null
  }
}

/**
 * Line the live stream's first connection up with the snapshot the app opened with: its "hello" says where it started,
 * `keep` drops the events the snapshot already includes, up to the snapshot's "boot" mark, and `onGap` runs when the
 * stream started after events the snapshot lacks (refetch). Null without a snapshot.
 */
export function alignWithBoot(onGap: () => void): { hello: (e: MessageEvent) => void; mark: (e: MessageEvent) => void; keep: () => boolean } | null {
  if (!boot) return null
  const at = boot.stream
  // At most this many: one per event since the hello, or fewer (a task update that changed nothing sends nothing).
  let skip = 0
  return {
    hello: (e) => {
      const pos = positionOf(e)
      if (!pos) return
      if (pos.epoch === at.epoch && pos.seq <= at.seq) skip = at.seq - pos.seq
      else onGap()
    },
    mark: (e) => {
      const pos = positionOf(e)
      if (pos?.epoch === at.epoch && pos.seq === at.seq) skip = 0
    },
    keep: () => {
      if (skip <= 0) return true
      skip--
      return false
    },
  }
}
