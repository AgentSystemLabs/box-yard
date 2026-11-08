// How long cached data counts as fresh, given the event stream (lib/stream.ts) writes changes straight into the cache.
// While the stream is connected, a list it keeps current can't be behind: refetching it when the tab comes back, the
// network returns or a view mounts downloads what's already there (the task thread and the Coordinator chat are
// hundreds of KB each). A stream that may have missed events (it reconnected, or the page was away STALE_STREAM_MS)
// invalidates every query itself, so they refetch then, and only then.
import { hashKey, type Query, type QueryKey, type QueryClient } from "@tanstack/react-query"
import { placeMessage } from "./queued"

/** First key segments of the lists stream.ts keeps current. */
const STREAMED = new Set(["tasks", "projects", "chat", "task-messages", "task-queue", "captain-messages", "artifacts", "boxes", "schedules", "schedule-runs"])
/**
 * Message logs among them: the server broadcasts every message it writes or changes, so the cached copy doesn't go
 * stale on a timer either, and reopening a task (or the Coordinator after a Captain) shows it without a refetch.
 * Their fetches go through fetchLog, so a message that arrives during one isn't lost.
 */
const LOGS = new Set(["chat", "task-messages"])

/** Everything else: refetched on mount, focus or reconnect once it's older than this. */
export const STALE_MS = 60_000

const head = (q: Query) => String(q.queryKey[0])
/** The stream's own reconnect covers the lists it keeps current. */
const refetchUnlessStreamed = (q: Query) => !STREAMED.has(head(q))

/** The app's query defaults for freshness (main.tsx); a query's own options still win. */
export const LIVE_QUERY_DEFAULTS = {
  staleTime: (q: Query) => (LOGS.has(head(q)) ? Infinity : STALE_MS),
  refetchOnWindowFocus: refetchUnlessStreamed,
  refetchOnReconnect: refetchUnlessStreamed,
}

type Message = { id: string; createdAt: number; meta?: Record<string, unknown> | null }
const collectors = new Map<string, Set<(m: Message) => void>>()

/**
 * Fetch a message log without losing a message the stream brings while the request is out: the answer may predate
 * it, and it either found no cached list to go into or went into the one the answer replaces. Those messages are
 * placed into the answer, as stream.ts places them into the cache.
 */
export async function fetchLog<T extends Message>(key: QueryKey, fetch: () => Promise<T[]>, current?: () => T[] | undefined): Promise<T[]> {
  const hash = hashKey(key)
  const arrived: T[] = []
  const collect = (m: Message) => void arrived.push(m as T)
  const set = collectors.get(hash) ?? new Set()
  collectors.set(hash, set.add(collect))
  try {
    const list = await fetch()
    const merged = arrived.reduce((out, m) => placeMessage(out, m), list)
    const ids = new Set(merged.flatMap((m) => [m.id, m.meta?.clientMessageId]))
    // A reconnect/refetch must not erase a submission whose POST or agent startup is still pending.
    const cached = current?.() ?? []
    for (const [i, m] of cached.entries()) {
      if (!m.meta?.pending || ids.has(m.id)) continue
      // Retain its place before any later cached row the fetch knows about, even with a slow POST.
      const following = cached.slice(i + 1).find((next) => ids.has(next.id))
      const at = following ? merged.findIndex((next) => next.id === following.id || next.meta?.clientMessageId === following.id) : -1
      merged.splice(at < 0 ? merged.length : at, 0, m)
      ids.add(m.id)
    }
    return merged
  } finally {
    set.delete(collect)
    if (!set.size) collectors.delete(hash)
  }
}

/** stream.ts: a message for the log under `key` arrived. */
export function liveMessage(key: QueryKey, m: Message) {
  collectors.get(hashKey(key))?.forEach((collect) => collect(m))
}

/** A busy/state GET can predate an SSE update even when its response arrives later. Count writes rather
 * than compare values: busy -> idle -> busy may end at the value we started with. */
export async function fetchLiveState<T>(client: QueryClient, key: QueryKey, fetch: () => Promise<T>): Promise<T> {
  const writes = client.getQueryState(key)?.dataUpdateCount
  const answer = await fetch()
  const current = client.getQueryState<T>(key)
  return current?.data !== undefined && current.dataUpdateCount !== writes ? current.data : answer
}
