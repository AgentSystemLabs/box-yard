// @vitest-environment happy-dom
// Stop and Merge PR show their result in the tasks cache from the click, before the server answers (and, for Stop,
// before the turn ends), and a failure takes it back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fetchTasks, keys, useRequestMerge, useSendTaskMessage, useStopTask } from "../web/src/lib/queries.js"
import { useServerEvents } from "../web/src/lib/stream.js"
import { resetStoppedTasks, staleAfterStop } from "../web/src/lib/stoppedTasks.js"
import type { Task } from "../shared/types"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ID = "task_abc123"
const STARTED = 1_000
const PR = "https://github.com/o/r/pull/7"
const task = (patch: Partial<Task> = {}) =>
  ({ id: ID, projectId: "prj_demo01", title: "Login form", status: "working", turnStartedAt: STARTED, turnCount: 3, pendingCount: 0, prUrl: null, prState: null, mergeRequest: null, updatedAt: 1, ...patch }) as Task

let root: Root
let host: HTMLElement
let qc: QueryClient
/** Pending answers by "METHOD url", resolved by the test. */
let pending: Map<string, (status: number, body: unknown) => void>

beforeEach(() => {
  resetStoppedTasks()
  pending = new Map()
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? "GET"} ${url}`
    return new Promise<Response>((resolve) => {
      pending.set(key, (status, body) => resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })))
    })
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } } })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

const settle = () => act(async () => new Promise((r) => setTimeout(r, 10)))
async function answer(key: string, status: number, body: unknown) {
  await vi.waitFor(() => expect([...pending.keys()]).toContain(key))
  const reply = pending.get(key)!
  pending.delete(key)
  await act(async () => reply(status, body))
  await settle()
}
const cached = () => qc.getQueryData<Task[]>(keys.tasks)!.find((t) => t.id === ID)!

/** Renders `use` and returns its mutate. */
function hook<T>(use: () => { mutate: (v: T) => void }): (v: T) => void {
  let mutate!: (v: T) => void
  function Harness() {
    mutate = use().mutate
    return null
  }
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Harness))))
  return (v) => act(() => mutate(v))
}

describe("Stop", () => {
  it("rests a working task at the click and keeps it stopped while the server still reports the turn", async () => {
    qc.setQueryData(keys.tasks, [task()])
    const stop = hook(useStopTask)
    stop(ID)
    // Before any answer.
    expect(cached()).toMatchObject({ status: "idle", turnStartedAt: null })
    // The POST answers while the box is still stopping it.
    await answer(`POST /api/tasks/${ID}/stop`, 200, task())
    expect(cached().status).toBe("idle")
    // A refetch (a reconnect) that still has the turn running.
    const refetch = qc.fetchQuery({ queryKey: keys.tasks, queryFn: fetchTasks, staleTime: 0 })
    await answer("GET /api/tasks", 200, [task({ pendingCount: 1 })])
    await act(async () => void (await refetch))
    expect(cached().status).toBe("idle")
    // SSE (lib/stream.ts) drops copies the hold calls stale; the turn's end goes through.
    expect(staleAfterStop(task())).toBe(true)
    expect(staleAfterStop(task({ status: "idle", turnStartedAt: null }))).toBe(false)
  })

  it("rests a task with an open PR as PR ready", async () => {
    qc.setQueryData(keys.tasks, [task({ prUrl: PR })])
    hook(useStopTask)(ID)
    expect(cached().status).toBe("pr_ready")
  })

  it("puts the task back as it was when the stop fails", async () => {
    qc.setQueryData(keys.tasks, [task()])
    hook(useStopTask)(ID)
    expect(cached().status).toBe("idle")
    await answer(`POST /api/tasks/${ID}/stop`, 500, { error: "box unreachable" })
    expect(cached()).toMatchObject({ status: "working", turnStartedAt: STARTED })
    // Nothing is held any more: the server's word counts again.
    expect(staleAfterStop(task())).toBe(false)
  })

  it("a message sent right after Stop doesn't bring back the turn being stopped", async () => {
    qc.setQueryData(keys.tasks, [task()])
    qc.setQueryData(keys.taskQueue(ID), [])
    let stop!: (id: string) => void
    let send!: (v: { content: string }) => void
    function Harness() {
      const s = useStopTask()
      const m = useSendTaskMessage(ID)
      stop = s.mutate
      send = m.mutate
      return null
    }
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Harness))))
    act(() => stop(ID))
    act(() => send({ content: "and then this" }))
    // Sending a message does not invent a task state; the old stopped turn cannot return via HTTP.
    expect(cached().status).toBe("idle")
    await answer(`POST /api/tasks/${ID}/messages`, 200, task({ pendingCount: 1 }))
    expect(cached().status).toBe("idle")
  })
})

/** EventSource stand-in: the test delivers server events. */
class FakeEventSource {
  static last: FakeEventSource | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: unknown = null
  onopen: unknown = null
  constructor() {
    FakeEventSource.last = this
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

describe("Stop against the live stream", () => {
  let answerStop: (res: Response) => void
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
    vi.stubGlobal("EventSource", FakeEventSource)
    vi.stubGlobal("fetch", (url: string) => (url.endsWith("/stop") ? new Promise<Response>((r) => (answerStop = r)) : new Promise(() => {})))
  })
  afterEach(() => vi.useRealTimers())

  const sse = (t: Task) =>
    act(async () => {
      FakeEventSource.last!.onmessage!({ data: JSON.stringify({ type: "task", task: t }) })
      await vi.advanceTimersByTimeAsync(300)
    })

  it("drops the stopped turn's updates, and stays stopped when the POST's answer lands after the turn's end", async () => {
    qc.setQueryData(keys.tasks, [task()])
    let stop!: (id: string) => void
    function Live() {
      useServerEvents(true)
      stop = useStopTask().mutate
      return null
    }
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Live))))
    act(() => stop(ID))
    expect(cached().status).toBe("idle")
    // The box is still stopping it: the turn's updates keep coming.
    await sse(task({ pendingCount: 1, updatedAt: 2 }))
    expect(cached().status).toBe("idle")
    // The turn ended.
    await sse(task({ status: "idle", turnStartedAt: null, summary: "Stopped.", updatedAt: 3 }))
    expect(cached()).toMatchObject({ status: "idle", summary: "Stopped." })
    // On a slow link the POST's answer, written while the turn still ran, can land after that update.
    await act(async () => {
      answerStop(json(task({ updatedAt: 2 })))
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(cached()).toMatchObject({ status: "idle", summary: "Stopped." })
    // A new turn goes through.
    await sse(task({ status: "starting", turnStartedAt: STARTED + 9_000, updatedAt: 4 }))
    expect(cached().status).toBe("starting")
  })
})

describe("Merge PR", () => {
  it("shows the request queued at the click, as the server's answer has it", async () => {
    qc.setQueryData(keys.tasks, [task({ status: "pr_ready", turnStartedAt: null, prUrl: PR })])
    hook(useRequestMerge)(ID)
    expect(cached().mergeRequest).toMatchObject({ prNumber: 7, prUrl: PR, deliveredAt: null })
    const server = task({ status: "pr_ready", turnStartedAt: null, prUrl: PR, mergeRequest: { prNumber: 7, prUrl: PR, requestedAt: 5, deliveredAt: null, requestedBy: null } })
    await answer(`POST /api/tasks/${ID}/merge`, 200, { task: server, delivery: "now" })
    expect(cached().mergeRequest).toEqual(server.mergeRequest)
  })

  it("takes the request back when the server refuses it", async () => {
    qc.setQueryData(keys.tasks, [task({ status: "pr_ready", turnStartedAt: null, prUrl: PR })])
    hook(useRequestMerge)(ID)
    expect(cached().mergeRequest).not.toBeNull()
    await answer(`POST /api/tasks/${ID}/merge`, 400, { error: "PR #7 is a draft, so there is nothing to merge." })
    expect(cached().mergeRequest).toBeNull()
  })
})
