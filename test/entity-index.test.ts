// @vitest-environment happy-dom
// Every <Markdown> and tool line reads the entity index (lib/entities.ts). It watches the five lists behind it once for
// the whole app: a useQuery per list in each row made switching chats slow on a phone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useEntityIndex } from "../web/src/lib/entities.js"
import { keys } from "../web/src/lib/queries.js"
import type { EntityIndex } from "../web/src/lib/linkify.js"
import type { Task } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const task = (id: string, title: string, status = "running") => ({ id, title, status }) as unknown as Task

let root: Root
let host: HTMLElement
let qc: QueryClient
let requests: string[]
let seen: EntityIndex[]

function Row() {
  seen.push(useEntityIndex())
  return null
}
const rows = (n: number) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, Array.from({ length: n }, (_, i) => createElement(Row, { key: i })))))
// React Query tells its observers a moment later.
const update = (tasks: Task[]) =>
  act(() => {
    qc.setQueryData(keys.tasks, tasks)
    vi.advanceTimersByTime(0)
  })
const watching = () => qc.getQueryCache().find({ queryKey: keys.tasks })!.getObserversCount()

beforeEach(() => {
  vi.useFakeTimers()
  requests = []
  vi.stubGlobal("fetch", (path: string) => {
    requests.push(path)
    return new Promise(() => {})
  })
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } })
  for (const k of [keys.projects, keys.schedules, keys.artifacts, keys.boxes]) qc.setQueryData(k, [])
  qc.setQueryData(keys.tasks, [task("task_index01", "Ship the fix")])
  seen = []
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  qc.clear()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("useEntityIndex", () => {
  it("watches each list once for the whole app, however many rows read it", () => {
    rows(200)
    expect(watching()).toBe(1)
    expect(new Set(seen).size).toBe(1)
    expect(seen[0]!.byId.has("task_index01")).toBe(true)
  })

  it("re-renders its readers only when an entity is added, removed or renamed", () => {
    rows(3)
    const first = seen.at(-1)!
    seen = []
    update([task("task_index01", "Ship the fix", "done")])
    expect(seen).toHaveLength(0)
    update([task("task_index01", "Ship the real fix")])
    expect(seen).toHaveLength(3)
    expect(seen[0]).not.toBe(first)
    expect(seen[0]!.byTitle.has("Ship the real fix")).toBe(true)
  })

  it("keeps watching from one chat's rows to the next's, and lets go a moment after the last reader goes", () => {
    rows(5)
    rows(0)
    rows(5)
    expect(watching()).toBe(1)
    rows(0)
    act(() => void vi.advanceTimersByTime(1000))
    expect(watching()).toBe(0)
    expect(requests).toEqual([])
  })

  it("reads what's in the cache now when it starts watching again", () => {
    rows(1)
    rows(0)
    act(() => void vi.advanceTimersByTime(1000))
    qc.setQueryData(keys.tasks, [task("task_index02", "A new task")])
    rows(1)
    expect(seen.at(-1)!.byId.has("task_index02")).toBe(true)
  })

  it("loads a list nothing has loaded yet", () => {
    qc.removeQueries({ queryKey: keys.boxes })
    rows(1)
    expect(requests).toEqual(["/api/boxes"])
  })
})
