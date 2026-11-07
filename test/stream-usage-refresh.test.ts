// @vitest-environment happy-dom
// Live task and box events refresh the usage queries (the Usage modal's ledger and limits) at most once every
// USAGE_REFRESH_MS, the last event included, so a busy yard doesn't rebuild its spend for each one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Task, UiEvent } from "../shared/types.js"
import { USAGE_REFRESH_MS, useServerEvents } from "../web/src/lib/stream.js"
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

const task = (n: number) => ({ id: "task_usage01", projectId: "prj_usage01", title: "Busy", status: "working", updatedAt: n }) as unknown as Task

describe("usage refreshes from live events", () => {
  let root: Root
  let qc: QueryClient
  let refreshes: number
  const latest = () => FakeEventSource.all.at(-1)!
  const send = (ev: UiEvent) => act(async () => latest().onmessage?.({ data: JSON.stringify(ev) }))
  const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

  beforeEach(() => {
    vi.useFakeTimers()
    FakeEventSource.all = []
    vi.stubGlobal("EventSource", FakeEventSource)
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
    vi.stubGlobal("requestAnimationFrame", () => 1)
    vi.stubGlobal("cancelAnimationFrame", () => {})
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData<Task[]>(keys.tasks, [task(0)])
    refreshes = 0
    const invalidate = qc.invalidateQueries.bind(qc)
    vi.spyOn(qc, "invalidateQueries").mockImplementation((filters, opts) => {
      if (JSON.stringify(filters?.queryKey) === JSON.stringify(keys.usage)) refreshes++
      return invalidate(filters, opts)
    })
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

  it("refreshes at once after a quiet spell, then once more for a burst, after it", async () => {
    await send({ type: "task", task: task(1) })
    await wait(300)
    expect(refreshes).toBe(1)
    for (let i = 2; i < 30; i++) {
      await send(i % 3 ? { type: "task", task: task(i) } : { type: "boxes", boxes: [] })
      await wait(100)
    }
    expect(refreshes).toBe(1)
    await wait(USAGE_REFRESH_MS)
    expect(refreshes).toBe(2)
    // Nothing since: no more.
    await wait(3 * USAGE_REFRESH_MS)
    expect(refreshes).toBe(2)
    await send({ type: "task.deleted", taskId: "task_usage01" })
    await wait(300)
    expect(refreshes).toBe(3)
  })

  it("a settings change (rates, limits) refreshes at once", async () => {
    await send({ type: "task", task: task(1) })
    await wait(300)
    await send({ type: "settings", info: {} } as unknown as UiEvent)
    await wait(300)
    expect(refreshes).toBe(2)
  })
})
