// @vitest-environment happy-dom
// Lists the event stream keeps current aren't downloaded again when the tab comes back, the network returns or a
// view mounts (lib/liveQueries.ts); a stream gap still refetches them, and a message that arrives during a fetch of
// a message log isn't lost.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { focusManager, onlineManager, QueryClient, QueryClientProvider, QueryObserver, type QueryKey } from "@tanstack/react-query"
import { LIVE_QUERY_DEFAULTS, STALE_MS, fetchLog, liveMessage } from "../web/src/lib/liveQueries.js"
import { keys, useCreateTask, useTaskMessages } from "../web/src/lib/queries.js"
import { useServerEvents } from "../web/src/lib/stream.js"
import type { Task, TaskMessage } from "../shared/types.js"

vi.mock("../web/src/lib/sendSound.js", async (load) => ({ ...(await load<typeof import("../web/src/lib/sendSound.js")>()), playSendSound: () => true }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const msg = (id: string, content = id, createdAt = 1): TaskMessage => ({ id, taskId: "task_t1", role: "agent", content, meta: null, createdAt })

describe("the app's query defaults", () => {
  let qc: QueryClient
  let fetched: string[]
  let unsubs: (() => void)[]
  const observe = (...queryKeys: QueryKey[]) => {
    for (const queryKey of queryKeys) {
      const o = new QueryObserver(qc, { queryKey, queryFn: async () => (fetched.push(String(queryKey[0])), []) })
      unsubs.push(o.subscribe(() => {}))
    }
  }
  const unmountAll = () => unsubs.splice(0).forEach((u) => u())
  const settle = () => vi.advanceTimersByTimeAsync(0)

  beforeEach(() => {
    vi.useFakeTimers()
    qc = new QueryClient({ defaultOptions: { queries: { ...LIVE_QUERY_DEFAULTS, retry: false } } })
    // As QueryClientProvider does: it listens for focus and the network from here.
    qc.mount()
    fetched = []
    unsubs = []
  })
  afterEach(() => {
    unmountAll()
    qc.unmount()
    qc.clear()
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
    vi.useRealTimers()
  })

  it("doesn't refetch the lists the stream keeps current when the tab comes back or the network returns", async () => {
    observe(keys.tasks, keys.projects, keys.chat, keys.taskMessages("task_t1"), keys.boxes, keys.me)
    await settle()
    fetched = []
    vi.advanceTimersByTime(STALE_MS + 5000)
    focusManager.setFocused(false)
    focusManager.setFocused(true)
    await settle()
    // Only the query the stream doesn't feed.
    expect(fetched).toEqual(["me"])
    fetched = []
    vi.advanceTimersByTime(STALE_MS + 5000)
    onlineManager.setOnline(false)
    onlineManager.setOnline(true)
    await settle()
    expect(fetched).toEqual(["me"])
  })

  it("shows a cached task thread or Coordinator chat when it mounts again, and refetches other lists once stale", async () => {
    observe(keys.tasks, keys.chat, keys.taskMessages("task_t1"))
    await settle()
    unmountAll()
    fetched = []
    vi.advanceTimersByTime(STALE_MS + 5000)
    observe(keys.tasks, keys.chat, keys.taskMessages("task_t1"))
    await settle()
    expect(fetched).toEqual(["tasks"])
  })

  it("still refetches all of them after a gap in the stream (it invalidates every query)", async () => {
    observe(keys.tasks, keys.chat, keys.taskMessages("task_t1"))
    await settle()
    fetched = []
    await qc.invalidateQueries()
    expect(fetched.sort()).toEqual(["chat", "task-messages", "tasks"])
  })
})

describe("fetchLog", () => {
  const key = keys.taskMessages("task_t1")

  it("places the messages the stream brought while the request was out into its answer", async () => {
    let answer!: (list: TaskMessage[]) => void
    const out = fetchLog(key, () => new Promise<TaskMessage[]>((r) => (answer = r)))
    // Edited after the answer was read, a new one, and another task's.
    liveMessage(key, msg("tm_a", "edited"))
    liveMessage(key, msg("tm_c", "new", 3))
    liveMessage(keys.taskMessages("task_other"), msg("tm_x"))
    answer([msg("tm_a"), msg("tm_b", "b", 2)])
    expect((await out).map((m) => `${m.id}:${m.content}`)).toEqual(["tm_a:edited", "tm_b:b", "tm_c:new"])
    // Done fetching, it no longer collects.
    liveMessage(key, msg("tm_d"))
    expect(await fetchLog(key, async () => [])).toEqual([])
  })
})

class FakeEventSource {
  static all: FakeEventSource[] = []
  static OPEN = 1
  static CLOSED = 2
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
  close() {
    this.readyState = FakeEventSource.CLOSED
  }
}

describe("a task thread loading while its agent works", () => {
  let root: Root
  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ""
  })

  it("keeps a message the stream brought before the thread's answer, which predates it", async () => {
    vi.useFakeTimers()
    FakeEventSource.all = []
    vi.stubGlobal("EventSource", FakeEventSource)
    vi.stubGlobal("requestAnimationFrame", () => 1)
    vi.stubGlobal("cancelAnimationFrame", () => {})
    let answer!: (r: Response) => void
    // The thread's request waits; others (the voice settings the stream loads) never answer.
    vi.stubGlobal("fetch", vi.fn((url: string) => new Promise<Response>((r) => void (url.endsWith("/messages") && (answer = r)))))
    const qc = new QueryClient({ defaultOptions: { queries: { ...LIVE_QUERY_DEFAULTS, retry: false } } })
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    function Thread() {
      useServerEvents(true)
      useTaskMessages("task_t1")
      return null
    }
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Thread))))
    act(() => FakeEventSource.all[0]!.open())
    // The thread's request is out; the agent's next line arrives first (applied on the stream's fallback timer).
    act(() => FakeEventSource.all[0]!.onmessage?.({ data: JSON.stringify({ type: "task.message", message: msg("tm_new", "new", 2) }) }))
    await act(() => vi.advanceTimersByTimeAsync(300))
    await act(async () => {
      answer(new Response(JSON.stringify([msg("tm_old", "old", 1)])))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(qc.getQueryData<TaskMessage[]>(keys.taskMessages("task_t1"))?.map((m) => m.id)).toEqual(["tm_old", "tm_new"])
  })
})

describe("a new task's page", () => {
  let root: Root
  afterEach(() => {
    act(() => root.unmount())
    vi.unstubAllGlobals()
    document.body.innerHTML = ""
  })

  it("loads its thread again once the server has the task: the page opened first, and the prompt isn't streamed", async () => {
    const pending = new Map<string, (body: unknown) => void>()
    vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => new Promise<Response>((r) => void pending.set(`${init.method ?? "GET"} ${url}`, (body) => r(new Response(JSON.stringify(body))))))
    const answer = async (key: string, body: unknown) => {
      await vi.waitFor(() => expect([...pending.keys()]).toContain(key))
      const reply = pending.get(key)!
      pending.delete(key)
      await act(async () => {
        reply(body)
        await new Promise((r) => setTimeout(r, 10))
      })
    }
    const qc = new QueryClient({ defaultOptions: { queries: { ...LIVE_QUERY_DEFAULTS, retry: false }, mutations: { retry: false } } })
    qc.setQueryData(keys.tasks, [])
    let create!: ReturnType<typeof useCreateTask>
    function Page() {
      create = useCreateTask()
      useTaskMessages("task_new001")
      return null
    }
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Page))))
    act(() => create.mutate({ id: "task_new001", projectId: "prj_demo01", title: "t", prompt: "do it" }))
    // The thread's request was answered before the task existed.
    await answer("GET /api/tasks/task_new001/messages", [])
    await answer("POST /api/tasks", { id: "task_new001", projectId: "prj_demo01", title: "t", prompt: "do it", status: "queued" } as Partial<Task>)
    await answer("GET /api/tasks/task_new001/messages", [msg("tm_prompt", "do it")])
    expect(qc.getQueryData<TaskMessage[]>(keys.taskMessages("task_new001"))?.map((m) => m.content)).toEqual(["do it"])
  })
})
