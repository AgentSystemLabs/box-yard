// Switching Captains (the sidebar, the Captain ⌄ switcher, the palette, a link) shows the conversation at once.
// Every project's Captain (its newest messages, state and side threads) comes in one request (GET /api/captains/recent,
// server/captainRecent.ts) that the page starts once the boot data is in (web/index.html, lib/boot.ts). Right after the
// app's first paint it goes into React Query's cache, and its Markdown is parsed while the browser is idle. The live
// stream keeps it current (lib/stream.ts); opening a Captain shows it and revalidates quietly (useCaptainMessages loads
// the whole history in above a prefetched tail).
// Memory only: none of it goes to localStorage, sessionStorage, IndexedDB, the Cache API, a service worker or a
// query persister (test/captain-prefetch.test.ts fails if it does).
import { useEffect } from "react"
import { notifyManager, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { api } from "./api"
import { afterBoot } from "./boot"
import { currentEntityIndex } from "./entities"
import { keys, markCaptainTail } from "./queries"
import { repoScopeKey, resolveRepoScope } from "./repoScope"
import { threadKeys } from "./threads"
import { warmTimeFormats } from "./time"
import { warmMarkdown } from "../components/ui"
import type { RecentCaptain } from "../../../shared/types"

/** The app's own first requests get this long before what waits for them (whenSettled) goes anyway. */
const SETTLE_MAX_MS = 4000

/**
 * Prefetched Captains stay in memory (and stay live) for the session instead of React Query's default five minutes
 * without a view, so a Captain opened an hour later is still instant.
 */
export function keepCaptainsInMemory(qc: QueryClient) {
  for (const key of [["captain-messages"], ["captain"], ["threads"]]) qc.setQueryDefaults(key, { gcTime: Infinity })
}

/**
 * Put prefetched Captains into the cache, never over what's there (a Captain already opened has its whole history and
 * live updates). A tail with older messages beyond it is marked, so opening it loads the rest.
 */
export function seedRecentCaptains(qc: QueryClient, recent: RecentCaptain[]) {
  keepCaptainsInMemory(qc)
  notifyManager.batch(() => {
    for (const r of recent) {
      if (qc.getQueryData(keys.captainMessages(r.projectId)) === undefined) {
        qc.setQueryData(keys.captainMessages(r.projectId), r.messages)
        if (r.more) markCaptainTail(r.projectId)
      }
      if (qc.getQueryData(keys.captain(r.projectId)) === undefined) qc.setQueryData(keys.captain(r.projectId), r.state)
      if (qc.getQueryData(threadKeys.list(r.projectId)) === undefined) qc.setQueryData(threadKeys.list(r.projectId), r.threads)
    }
  })
}

/**
 * Parse the prefetched messages' Markdown while the browser is idle, as each Captain's chat will render it (in its
 * project's repo), so its first open only builds the DOM. Skipped before any Markdown is on screen.
 */
export function warmRecentCaptains(recent: RecentCaptain[]) {
  const index = currentEntityIndex()
  if (!index) return
  for (const r of recent) {
    const texts = r.messages.flatMap((m) => (m.role === "assistant" || m.role === "user" ? [m.content] : []))
    warmMarkdown(texts, index, resolveRepoScope(repoScopeKey({ projectId: r.projectId }), index))
  }
}

/**
 * Fetch every Captain's opening view (the page's own request, if it made one) and seed it. Failing is fine: a Captain
 * then loads when opened. Not at low priority: on a fresh launch its answer was then read late, between the first
 * frames, after a Captain tapped already.
 */
export async function prefetchRecentCaptains(qc: QueryClient): Promise<void> {
  const recent = await api<RecentCaptain[]>("/api/captains/recent").catch(() => null)
  if (!recent) return
  seedRecentCaptains(qc, recent)
  warmRecentCaptains(recent)
}

/**
 * Run `fn` after the next paint, once no query is fetching (the app's own first requests; at most SETTLE_MAX_MS), when
 * the browser is idle. Returns a cancel.
 */
export function whenSettled(qc: QueryClient, fn: () => void): () => void {
  let started = false
  let unsubscribe = () => {}
  let idleHandle: number | undefined
  const timers: ReturnType<typeof setTimeout>[] = []
  const go = () => {
    if (started) return
    started = true
    unsubscribe()
    // Safari has no requestIdleCallback.
    if (typeof requestIdleCallback === "function") idleHandle = requestIdleCallback(fn, { timeout: 2000 })
    else timers.push(setTimeout(fn, 100))
  }
  // A frame and a task later the first paint is on screen, and the queries its views started are fetching.
  const frame = requestAnimationFrame(() =>
    timers.push(
      setTimeout(() => {
        if (qc.isFetching() === 0) return go()
        unsubscribe = qc.getQueryCache().subscribe(() => {
          if (qc.isFetching() === 0) go()
        })
        timers.push(setTimeout(go, SETTLE_MAX_MS))
      }, 0),
    ),
  )
  return () => {
    started = true
    cancelAnimationFrame(frame)
    unsubscribe()
    for (const t of timers) clearTimeout(t)
    if (idleHandle !== undefined) cancelIdleCallback(idleHandle)
  }
}

/**
 * Run `fn` once the first paint is on screen (a frame and a task later) and the boot data is in (lib/boot.ts), not
 * when the browser is first idle: a fresh launch keeps a phone's main thread busy for a second or more, and a Captain
 * tapped in that time found nothing in memory and loaded with a blank chat. Returns a cancel.
 */
export function afterFirstPaint(fn: () => void): () => void {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const frame = requestAnimationFrame(() => {
    timer = setTimeout(() => afterBoot(() => void (cancelled || fn())))
  })
  return () => {
    cancelled = true
    cancelAnimationFrame(frame)
    clearTimeout(timer)
  }
}

/**
 * Mounted once (App), signed in: prefetch every Captain right after the app's first paint. The time formatters are
 * made while the browser is idle too: the first Captain opened was the first view with a time in it.
 */
export function usePrefetchCaptains(enabled: boolean) {
  const qc = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    return afterFirstPaint(() => {
      void prefetchRecentCaptains(qc)
      // Safari has no requestIdleCallback.
      if (typeof requestIdleCallback === "function") requestIdleCallback(() => warmTimeFormats(), { timeout: 2000 })
      else setTimeout(() => warmTimeFormats(), 100)
    })
  }, [enabled, qc])
}
