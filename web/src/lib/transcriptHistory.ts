import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { HISTORY_WINDOW_SIZE, type HistoryDates, type HistoryPage } from "../../../shared/transcriptHistory"
import { api, ApiError } from "./api"
import { dayKey } from "./calendarDay"
import type { ChatDay } from "./chatDays"
import { toast } from "./toast"

type Message = { id: string; createdAt: number; role?: string; meta?: Record<string, unknown> | null }

export type HistoryIndexState = { status: "loading" | "ready" | "error" | "unsupported"; retry: () => void }
class HistoryUnavailable extends Error {}

/** A missing route or incompatible response is not an empty, complete index: the live message cache
 * only covers the newest part of the conversation. Validate before presenting its dates as complete. */
async function historyDates(path: string): Promise<HistoryDates> {
  let data: HistoryDates
  try { data = await api<HistoryDates>(path) }
  catch (error) {
    if (error instanceof ApiError && error.status === 404) throw new HistoryUnavailable()
    throw error
  }
  if (!data || !Array.isArray(data.days) || !data.days.every((d) => d && Number.isSafeInteger(d.at) && typeof d.messageId === "string")
    || (data.oldestId !== null && typeof data.oldestId !== "string")) throw new HistoryUnavailable()
  return data
}

/** An independent, bounded reading window. SSE keeps the latest query current while the reader browses old
 * pages. Returning to latest is immediate; sparse date jumps never splice gaps into the live conversation. */
export function useTranscriptHistory<M extends Message>(path: string, live: M[]) {
  const [window, setWindow] = useState<{ path: string; page: HistoryPage<M> } | null>(null)
  const [loading, setLoading] = useState(false)
  const serial = useRef(0)
  const inFlight = useRef(false)
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const metadata = useQuery({
    queryKey: ["history-days", path, timeZone],
    queryFn: () => historyDates(`${path}?days=1&tz=${encodeURIComponent(timeZone)}`),
    staleTime: 60_000,
    retry: false,
  })
  const retryDates = useCallback(() => { void metadata.refetch() }, [metadata.refetch])
  const indexStatus = metadata.isPending || (metadata.isFetching && !metadata.data) ? "loading" : metadata.error instanceof HistoryUnavailable ? "unsupported"
    : metadata.isError ? "error" : "ready"
  const index = useMemo<HistoryIndexState>(() => ({ status: indexStatus, retry: retryDates }), [indexStatus, retryDates])
  const page = window?.path === path ? window.page : null
  const items = useMemo(() => {
    if (!page) return live
    const updates = new Map(live.map((m) => [m.id, m]))
    const firstAt = page.messages[0]?.createdAt ?? 0
    const lastAt = page.messages.at(-1)?.createdAt ?? 0
    let moved = false
    const merged = page.messages.flatMap((m) => {
      const update = updates.get(m.id)
      if (!update || update.createdAt === m.createdAt) return [update ?? m]
      moved = true
      // Delivery moves queued messages to the new turn. Do not pull that newer turn into an older window:
      // its timestamp would also make the next page skip the messages between the window and that turn.
      return update.createdAt < firstAt || update.createdAt > lastAt ? [] : [update]
    })
    return moved ? merged.sort((a, b) => a.createdAt - b.createdAt) : merged
  }, [page, live])
  const latest = useRef({ path, page, items })
  latest.current = { path, page, items }
  useEffect(() => {
    serial.current++
    inFlight.current = false
    setLoading(false)
    return () => { serial.current++ }
  }, [path])
  const request = useCallback(async (query: { before?: string; after?: string; around?: string }) => {
    if (!query.around && inFlight.current) return false
    const token = ++serial.current
    const { path, page, items } = latest.current
    inFlight.current = true
    setLoading(true)
    try {
      const answer = await api<HistoryPage<M>>(`${path}?${new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined))}`)
      if (token !== serial.current) return false
      let messages = answer.messages
      const previous = page?.messages ?? items
      const fresh = new Set(messages.map((m) => m.id))
      const kept = previous.filter((m) => !fresh.has(m.id))
      if (query.before) messages = [...messages, ...kept.slice(0, HISTORY_WINDOW_SIZE - messages.length)]
      if (query.after) messages = [...kept.slice(-(HISTORY_WINDOW_SIZE - messages.length)), ...messages]
      const seen = new Set<string>()
      messages = messages.filter((m) => !seen.has(m.id) && !!seen.add(m.id))
      setWindow({ path, page: { messages,
        positions: Object.fromEntries(messages.map((m) => [m.id, answer.positions?.[m.id] ?? page?.positions?.[m.id] ?? m.id])),
        before: query.after ? messages[0]?.id ?? null : answer.before,
        after: query.before ? messages.at(-1)?.id ?? null : answer.after,
      } })
      // An empty boundary page still closes that direction without dropping the reading window.
      if (!answer.messages.length) setWindow({ path, page: { messages: previous, positions: page?.positions, before: query.before ? null : page?.before ?? null, after: query.after ? null : page?.after ?? null } })
      return true
    } catch {
      if (token === serial.current) toast.error("Couldn't load history", "Try the date or history button again.")
      return false
    } finally {
      if (token === serial.current) { inFlight.current = false; setLoading(false) }
    }
  }, [])
  const ensure = useCallback(async (id: string) => {
    if (latest.current.items.some((m) => m.id === id)) return true
    return request({ around: id })
  }, [request])
  const earlier = useCallback(() => {
    const { page, items } = latest.current
    const id = (page?.messages ?? items)[0]?.id
    if (id) void request({ before: page?.positions?.[id] ?? id })
  }, [request])
  const later = useCallback(() => {
    const { page, items } = latest.current
    const id = (page?.messages ?? items).at(-1)?.id
    if (id) void request({ after: page?.positions?.[id] ?? id })
  }, [request])
  const toLatest = useCallback(() => {
    serial.current++
    inFlight.current = false
    setLoading(false)
    setWindow(null)
  }, [])
  const moreBefore = page ? !!page.before : !!items.length && (!metadata.data || metadata.data.oldestId !== items[0]?.id)
  const days = useMemo<ChatDay[] | undefined>(() => {
    if (!metadata.data?.days) return undefined
    const byDay = new Map<string, ChatDay>()
    for (const d of [...metadata.data.days, ...live.filter((m) => m.role !== "tool" && m.meta?.queued !== true && m.meta?.cancelled !== true).map((m) => ({ at: m.createdAt, messageId: m.id }))]) {
      const key = dayKey(d.at)
      const previous = byDay.get(key)
      if (!previous || previous.at > d.at) byDay.set(key, { ...d, key })
    }
    return [...byDay.values()].sort((a, b) => a.at - b.at)
  }, [metadata.data, live])
  return { items, days, index, ensure, earlier, later, toLatest, loading, browsing: page !== null, moreBefore, moreAfter: !!page?.after }
}
