// The entity index behind chat deep links, kept cheap for long threads: components re-render only when an entity
// is added, removed or renamed (not on every status update), and hover hints are read from the cache on demand.
import { useSyncExternalStore } from "react"
import { QueryObserver, notifyManager, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { api } from "./api"
import { keys } from "./queries"
import { buildEntityIndex, refForHref, type EntityIndex } from "./linkify"
import type { Artifact, BoxInfo, Project, Schedule, Task, TaskStatus } from "../../../shared/types"

type Entity = { id: string }
const sources = [
  { key: keys.tasks, url: "/api/tasks", sig: (t: Entity) => `${t.id}\t${(t as Task).title}` },
  { key: keys.projects, url: "/api/projects", sig: (p: Entity) => `${p.id}\t${(p as Project).name}\t${(p as Project).repo ?? ""}` },
  { key: keys.schedules, url: "/api/schedules", sig: (s: Entity) => `${s.id}\t${(s as Schedule).name}` },
  { key: keys.artifacts, url: "/api/artifacts", sig: (a: Entity) => `${a.id}\t${(a as Artifact).url}` },
  { key: keys.boxes, url: "/api/boxes", sig: (b: Entity) => b.id },
] as const
// Each list's signature, worked out once per version of the list.
const sigs = sources.map(() => new WeakMap<Entity[], string>())
function signature(i: number, list: Entity[] | undefined): string {
  if (!list) return ""
  let sig = sigs[i]!.get(list)
  if (sig === undefined) sigs[i]!.set(list, (sig = list.map(sources[i]!.sig).join("\n")))
  return sig
}

function cached(qc: QueryClient) {
  const [tasks, projects, schedules, artifacts, boxes] = sources.map((s) => qc.getQueryData<Entity[]>(s.key))
  return { tasks, projects, schedules, artifacts, boxes } as {
    tasks?: Task[]
    projects?: Project[]
    schedules?: Schedule[]
    artifacts?: Artifact[]
    boxes?: BoxInfo[]
  }
}

let shared: { sig: string; index: EntityIndex } | null = null

/** The index for what's in the cache now: the same object while no entity is added, removed or renamed. */
function indexOf(qc: QueryClient): EntityIndex {
  const sig = sources.map((s, i) => signature(i, qc.getQueryData<Entity[]>(s.key))).join("\u0000")
  if (!shared || shared.sig !== sig) shared = { sig, index: buildEntityIndex(cached(qc)) }
  return shared.index
}

/**
 * The five lists behind the index, watched once for the whole app (they load if they haven't). Every <Markdown> and
 * tool line reads the index: with a useQuery per list in each, a long chat made and dropped five query observers per
 * row, which was most of the cost of switching chats on a phone. Watching stops a moment after the last reader goes
 * (not in between one chat's rows unmounting and the next one's mounting).
 */
type IndexStore = { subscribe: (l: () => void) => () => void; get: () => EntityIndex }
const stores = new WeakMap<QueryClient, IndexStore>()

function indexStore(qc: QueryClient): IndexStore {
  const known = stores.get(qc)
  if (known) return known
  const observers = sources.map((s) => new QueryObserver<Entity[]>(qc, { queryKey: s.key, queryFn: () => api<Entity[]>(s.url), notifyOnChangeProps: ["data"] }))
  const listeners = new Set<() => void>()
  let stop: (() => void)[] = []
  let release: ReturnType<typeof setTimeout> | undefined
  // While watched, the index readers have; else read from the cache.
  let current: EntityIndex | null = null
  // Readers re-render only when the index itself changes.
  const changed = notifyManager.batchCalls(() => {
    const index = indexOf(qc)
    if (index === current) return
    current = index
    listeners.forEach((l) => l())
  })
  const store: IndexStore = {
    get: () => current ?? indexOf(qc),
    subscribe: (l) => {
      clearTimeout(release)
      listeners.add(l)
      if (!stop.length) {
        current = indexOf(qc)
        stop = observers.map((o) => o.subscribe(changed))
      }
      return () => {
        listeners.delete(l)
        if (listeners.size) return
        release = setTimeout(() => {
          if (listeners.size) return
          stop.forEach((s) => s())
          stop = []
          current = null
        }, 1000)
      }
    },
  }
  stores.set(qc, store)
  return store
}

/**
 * One index for every message on screen; the same object until an entity is added, removed or renamed.
 * Its hints may be stale (status changes don't rebuild it), so show hintForHref instead.
 */
export function useEntityIndex(): EntityIndex {
  const store = indexStore(useQueryClient())
  return useSyncExternalStore(store.subscribe, store.get)
}

/** The index the messages on screen link with, outside React (null before any has rendered). */
export const currentEntityIndex = (): EntityIndex | null => shared?.index ?? null

let fresh: { inputs: unknown[]; index: EntityIndex } | null = null

/** The hover hint for an in-app href, from what is in the cache right now (e.g. the task's current status). */
export function hintForHref(qc: QueryClient, href: string, statusLabel: (s: TaskStatus) => string): string | null {
  const data = cached(qc)
  const inputs = Object.values(data)
  if (!fresh || inputs.some((v, i) => v !== fresh!.inputs[i])) fresh = { inputs, index: buildEntityIndex(data, statusLabel) }
  const ref = refForHref(href, fresh.index)
  return ref ? `${ref.hint}\n${ref.id}` : null
}
