// @vitest-environment happy-dom
// The web app's side of task patches (server/hub.ts, shared/taskPatch.ts): it asks for them, and turns each one back
// into the whole task before it reaches the tasks cache.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Task, UiEvent } from "../shared/types.js"
import type { TaskPatchEvent } from "../shared/taskPatch.js"
import { useServerEvents } from "../web/src/lib/stream.js"
import { keys } from "../web/src/lib/queries.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakeEventSource {
  static all: FakeEventSource[] = []
  static OPEN = 1
  readyState = 0
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  addEventListener() {}
  constructor(public url: string) {
    FakeEventSource.all.push(this)
  }
  open() {
    this.readyState = FakeEventSource.OPEN
    this.onopen?.()
  }
  close() {}
}

const task = (over: Partial<Task> = {}) =>
  ({ id: "task_patch01", projectId: "prj_patch01", title: "Speed up the stream", prompt: "A long brief.", status: "working", summary: null, contextTokens: 1000, updatedAt: 1, ...over }) as unknown as Task

describe("task patches in the web app", () => {
  let root: Root
  let qc: QueryClient
  const latest = () => FakeEventSource.all.at(-1)!
  const cached = () => qc.getQueryData<Task[]>(keys.tasks)!
  /** The server sends these, and the batch they land in is applied. */
  const send = (...events: (UiEvent | TaskPatchEvent)[]) =>
    act(async () => {
      for (const ev of events) latest().onmessage?.({ data: JSON.stringify(ev) })
      await vi.advanceTimersByTimeAsync(300)
    })

  beforeEach(() => {
    vi.useFakeTimers()
    FakeEventSource.all = []
    vi.stubGlobal("EventSource", FakeEventSource)
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
    vi.stubGlobal("requestAnimationFrame", () => 1)
    vi.stubGlobal("cancelAnimationFrame", () => {})
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData<Task[]>(keys.tasks, [task({ id: "task_other01", title: "Another task" }), task({ status: "queued" })])
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    function Live() {
      useServerEvents(true)
      return null
    }
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Live))))
    act(() => latest().open())
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("asks for patches and caches each one as the whole task", async () => {
    expect(latest().url).toBe("/api/stream?patches=1")
    await send({ type: "task", task: task({ activity: "Bash ls" }) })
    await send({ type: "task.patch", id: "task_patch01", patch: { contextTokens: 5000, updatedAt: 2 } })
    expect(cached()[1]).toStrictEqual(task({ activity: "Bash ls", contextTokens: 5000, updatedAt: 2 }))
    await send({ type: "task.patch", id: "task_patch01", patch: { summary: "Done.", status: "done" }, unset: ["activity"] })
    expect(cached()[1]).toStrictEqual(task({ contextTokens: 5000, updatedAt: 2, summary: "Done.", status: "done" }))
    // The other task is untouched.
    expect(cached()[0]).toStrictEqual(task({ id: "task_other01", title: "Another task" }))
  })

  it("rebuilds from what the stream sent, not from the cache, which a refetch or an optimistic edit may have changed", async () => {
    await send({ type: "task", task: task({ status: "working" }) })
    act(() => qc.setQueryData<Task[]>(keys.tasks, (list) => list!.map((t) => (t.id === "task_patch01" ? { ...t, status: "queued", title: "Stale copy" } : t))))
    await send({ type: "task.patch", id: "task_patch01", patch: { contextTokens: 9000 } })
    expect(cached()[1]).toStrictEqual(task({ status: "working", contextTokens: 9000 }))
  })

  it("forgets what an earlier connection sent: a new one patches only after sending the task whole again", async () => {
    await send({ type: "task", task: task() })
    act(() => latest().open())
    await send({ type: "task.patch", id: "task_patch01", patch: { contextTokens: 7000 } })
    // Not applied on top of the old connection's copy; the list is reloaded instead.
    expect(cached()[1]).toStrictEqual(task())
    expect(qc.getQueryState(keys.tasks)?.isInvalidated).toBe(true)
    await send({ type: "task", task: task({ contextTokens: 7000 }) }, { type: "task.patch", id: "task_patch01", patch: { updatedAt: 3 } })
    expect(cached()[1]).toStrictEqual(task({ contextTokens: 7000, updatedAt: 3 }))
  })

  it("forgets a deleted task", async () => {
    await send({ type: "task", task: task() }, { type: "task.deleted", taskId: "task_patch01" })
    expect(cached().map((t) => t.id)).toEqual(["task_other01"])
    await send({ type: "task.patch", id: "task_patch01", patch: { updatedAt: 4 } })
    expect(cached().map((t) => t.id)).toEqual(["task_other01"])
  })
})
