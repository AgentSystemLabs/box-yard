// @vitest-environment happy-dom
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import { api } from "../web/src/lib/api.js"
import { reconnectNow } from "../web/src/lib/connection.js"
import { LIVE_QUERY_DEFAULTS } from "../web/src/lib/liveQueries.js"
import { adoptEarlyStart, afterBoot, takeEarly, type EarlyStart } from "../web/src/lib/boot.js"
import { BOOT_KEYS, seedBoot } from "../web/src/lib/bootSeed.js"
import {
  keys, useAgentSettings, useArtifacts, useCaptainState, useChat, useChatBusy, useHealth, useNotifications, useProjects, useSchedules, useSettings, useTasks,
} from "../web/src/lib/queries.js"
import { useServerEvents } from "../web/src/lib/stream.js"
import { COORDINATOR_CHAT, useThreads } from "../web/src/lib/threads.js"
import { BOOT_PATHS, captainStatePath, isBootPath, type BootPayload } from "../shared/boot.js"
import type { BoxInfo, CaptainState, Project, Task } from "../shared/types.js"

// The app's first data: the page's own early requests (web/index.html), taken by the queries instead of asking again.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project = { id: "prj_boot01", name: "demo", description: "", repo: null, baseBranch: "main", envKeys: [], notes: [], createdAt: 0, updatedAt: 0 } as unknown as Project
const captain: CaptainState = {
  projectId: project.id, busy: false, usage: { tokens: null, window: null, updatedAt: null }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null,
}
const responses: Record<string, unknown> = {
  "/api/health": { ok: true, orchestratorBusy: true, problems: [] },
  "/api/projects": [project],
  "/api/tasks": [],
  "/api/chat": [{ id: "chat_1", role: "user", content: "hello", meta: null, createdAt: 1 }],
  "/api/threads": [],
  "/api/agent-settings": { values: {}, sources: {} },
  "/api/settings": { defaultTimezone: "UTC", scheduler: "local", maxUploadMb: 10 },
  "/api/notifications?limit=50": [],
  "/api/schedules": [],
  "/api/artifacts": [],
  "/api/boxes": [],
  [captainStatePath(project.id)]: captain,
}
const payload = (seq = 5, epoch = "run1"): BootPayload => ({ stream: { epoch, seq }, responses })

class FakeEventSource extends EventTarget {
  static all: FakeEventSource[] = []
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  readyState = FakeEventSource.CONNECTING
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  constructor(readonly url: string) {
    super()
    FakeEventSource.all.push(this)
  }
  open() {
    this.readyState = FakeEventSource.OPEN
    this.onopen?.()
  }
  hello(seq: number, epoch = "run1") {
    this.dispatchEvent(new MessageEvent("hello", { data: JSON.stringify({ epoch, seq }) }))
  }
  /** A snapshot was read here (server/hub.ts mark()). */
  mark(seq: number, epoch = "run1") {
    this.dispatchEvent(new MessageEvent("boot", { data: JSON.stringify({ epoch, seq }) }))
  }
  send(ev: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(ev) }))
  }
  delta(text: string) {
    this.send({ type: "chat.delta", text })
  }
  close() {
    this.readyState = FakeEventSource.CLOSED
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/** What web/index.html's inline script makes. */
function earlyStart(boot: Promise<BootPayload | null>, me: unknown = { authed: true, authRequired: false }): EarlyStart {
  const start = { stream: null, heard: [], failed: false, me: Promise.resolve(me), boot } as unknown as EarlyStart
  start.listen = (e) => void start.heard.push(e)
  const es = new FakeEventSource("/api/stream?patches=1")
  es.addEventListener("hello", start.listen as EventListener)
  es.addEventListener("boot", start.listen as EventListener)
  es.addEventListener("message", start.listen as EventListener)
  es.onerror = () => void (start.failed = true)
  start.stream = es as unknown as EventSource
  return start
}

let root: Root
let host: HTMLElement
let qc: QueryClient
let requests: string[]
const adopt = (start: EarlyStart | undefined) =>
  adoptEarlyStart({ me: (data) => qc.setQueryData(keys.me, data), boot: (p) => seedBoot(qc, p) }, start)
const settle = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))))

beforeEach(() => {
  requests = []
  FakeEventSource.all = []
  vi.stubGlobal("EventSource", FakeEventSource)
  vi.stubGlobal("fetch", (path: string) => {
    requests.push(path)
    return new Promise(() => {})
  })
  // As in web/src/main.tsx.
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, ...LIVE_QUERY_DEFAULTS } } })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  qc.clear()
  adopt(undefined)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The boxes list, as the entity index behind chat links asks for it (lib/entities.ts). */
const useBoxes = () => useQuery({ queryKey: keys.boxes, queryFn: () => api<BoxInfo[]>("/api/boxes") })

/** Every query the app's first screen makes, with what each has. */
function LoadQueries({ out }: { out: Record<string, unknown> }) {
  out["/api/health"] = useHealth().data
  out["/api/projects"] = useProjects().data
  out["/api/tasks"] = useTasks().data
  out["/api/chat"] = useChat().data
  out["/api/threads"] = useThreads(COORDINATOR_CHAT).data
  out["/api/agent-settings"] = useAgentSettings().data
  out["/api/settings"] = useSettings().data
  out["/api/notifications?limit=50"] = useNotifications().data
  out["/api/schedules"] = useSchedules().data
  out["/api/artifacts"] = useArtifacts().data
  out["/api/boxes"] = useBoxes().data
  out[captainStatePath(project.id)] = useCaptainState(project.id).data
  out.busy = useChatBusy().data
  return null
}
const mount = (out: Record<string, unknown>) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(LoadQueries, { out }))))

describe("boot data", () => {
  it("names, for each path, the query that GETs it", async () => {
    adopt(undefined)
    mount({})
    await settle()
    // Each boot path is asked for by its query (and /api/health once more, by the Coordinator's busy flag).
    expect([...new Set(requests)].sort()).toEqual([...BOOT_PATHS, captainStatePath(project.id)].sort())
    for (const key of Object.values(BOOT_KEYS)) expect(qc.getQueryCache().find({ queryKey: key, exact: true }), String(key)).toBeDefined()
  })

  it("answers the load's queries without a request of their own, the Coordinator's chat a frame after the rest", async () => {
    const boot = deferred<BootPayload | null>()
    adopt(earlyStart(boot.promise))
    const out: Record<string, unknown> = {}
    mount(out)
    await settle()
    // They wait for it instead of asking.
    expect(requests).toEqual([])
    expect(out["/api/tasks"]).toBeUndefined()

    let rest!: () => void
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => ((rest = fn), 1))
    boot.resolve(payload())
    await settle(10)
    expect(out["/api/tasks"]).toEqual([])
    expect(out["/api/projects"]).toEqual([project])
    expect(out[captainStatePath(project.id)]).toEqual(captain)
    expect(out.busy).toBe(true)
    expect(out["/api/chat"]).toBeUndefined()

    await act(async () => rest())
    await settle(10)
    for (const [path, data] of Object.entries(responses)) expect(out[path], path).toEqual(data)
    expect(requests).toEqual([])

    // From then on a refetch is a request like any other.
    await act(() => void qc.invalidateQueries({ queryKey: keys.tasks }))
    expect(requests).toEqual(["/api/tasks"])
  })

  it("lands the Coordinator's chat anyway when no frame comes", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1)
    const done = seedBoot(qc, payload())
    expect(qc.getQueryData(keys.tasks)).toEqual([])
    expect(qc.getQueryData(keys.chat)).toBeUndefined()
    await done
    expect(qc.getQueryData(keys.chat)).toEqual(responses["/api/chat"])
  })

  it("never overwrites what a query already has", async () => {
    const mine = [{ id: "tsk_mine" }]
    qc.setQueryData(keys.tasks, mine)
    await seedBoot(qc, payload())
    expect(qc.getQueryData(keys.tasks)).toBe(mine)
    expect(qc.getQueryData(keys.boxes)).toEqual([])
  })

  it("leaves each query to ask for itself when the boot request failed", async () => {
    const boot = deferred<BootPayload | null>()
    adopt(earlyStart(boot.promise))
    mount({})
    await settle()
    expect(requests).toEqual([])
    await act(async () => boot.resolve(null))
    await settle()
    expect([...new Set(requests)].sort()).toEqual([...BOOT_PATHS, captainStatePath(project.id)].sort())
  })

  it("hands out /api/me once, and only answers GETs", async () => {
    adopt(earlyStart(new Promise(() => {})))
    await settle()
    // Seeded as it arrived, so the app's first render is signed in.
    expect(qc.getQueryData(keys.me)).toEqual({ authed: true, authRequired: false })
    await expect(api("/api/me")).resolves.toEqual({ authed: true, authRequired: false })
    void api("/api/me")
    void api("/api/tasks", { method: "POST", body: {} })
    void api("/api/orchestrator")
    await settle()
    expect(requests).toEqual(["/api/me", "/api/tasks", "/api/orchestrator"])
    // A signed-out answer isn't seeded or handed out: the query asks, and hears the 401 itself.
    qc.clear()
    adopt(earlyStart(new Promise(() => {}), null))
    await settle()
    expect(qc.getQueryData(keys.me)).toBeUndefined()
    await expect(takeEarly("/api/me")).resolves.toBeUndefined()
    expect(takeEarly("/api/me")).toBeUndefined()
  })

  it("runs what waits for it once it's in, or at once without it", async () => {
    const order: string[] = []
    adopt(undefined)
    afterBoot(() => order.push("now"))
    const boot = deferred<BootPayload | null>()
    adopt(earlyStart(boot.promise))
    afterBoot(() => order.push("after"))
    await settle()
    expect(order).toEqual(["now"])
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => (fn(), 1))
    boot.resolve(payload())
    await settle(10)
    expect(order).toEqual(["now", "after"])
  })

  it("starts as the page loads: the patch stream first, keeping what it hears, then /api/me and the boot data", () => {
    const html = readFileSync(join(__dirname, "../web/index.html"), "utf8")
    const inline = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!
    new Function(inline)()
    const start = window.__boxYardEarly!
    delete window.__boxYardEarly
    const page = FakeEventSource.all[0]!
    expect(FakeEventSource.all).toHaveLength(1)
    expect(start.stream).toBe(page)
    // The stream the app takes over must be the one it would open itself (lib/stream.ts).
    expect(page.url).toBe("/api/stream?patches=1")
    expect(requests).toEqual(["/api/me", "/api/boot"])
    page.hello(1)
    page.delta("a")
    page.mark(2)
    expect(start.heard.map((e) => e.type)).toEqual(["hello", "message", "boot"])
    expect(start.failed).toBe(false)
    page.onerror?.()
    expect(start.failed).toBe(true)
  })

  it("asks for every Captain's newest messages once the boot data is in, and not when it failed (signed out)", async () => {
    const html = readFileSync(join(__dirname, "../web/index.html"), "utf8")
    const inline = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!
    for (const signedIn of [true, false]) {
      requests = []
      let answer!: (r: Response) => void
      vi.stubGlobal("fetch", (path: string) => {
        requests.push(path)
        if (path === "/api/boot") return new Promise<Response>((r) => (answer = r))
        return new Promise(() => {})
      })
      new Function(inline)()
      const start = window.__boxYardEarly!
      delete window.__boxYardEarly
      // Not beside the boot data: it slowed the first paint.
      expect(requests).toEqual(["/api/me", "/api/boot"])
      answer(signedIn ? new Response(JSON.stringify(payload())) : new Response("{}", { status: 401 }))
      await start.boot
      await settle()
      expect(requests).toEqual(signedIn ? ["/api/me", "/api/boot", "/api/captains/recent"] : ["/api/me", "/api/boot"])
      start.stream?.close()
    }
  })

  it("hands the page's Captain prefetch out once, and leaves it to the app when it found nothing", async () => {
    const start = earlyStart(new Promise(() => {}))
    start.recent = Promise.resolve([{ projectId: project.id }])
    adopt(start)
    await expect(api("/api/captains/recent")).resolves.toEqual([{ projectId: project.id }])
    expect(requests).toEqual([])
    void api("/api/captains/recent")
    await settle()
    expect(requests).toEqual(["/api/captains/recent"])

    requests = []
    const failed = earlyStart(new Promise(() => {}))
    failed.recent = Promise.resolve(null)
    adopt(failed)
    void api("/api/captains/recent")
    await settle()
    expect(requests).toEqual(["/api/captains/recent"])
  })

  it("keeps the boot data in memory only", () => {
    const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
    const html = readFileSync(join(__dirname, "../web/index.html"), "utf8")
    for (const file of ["../web/src/lib/boot.ts", "../web/src/lib/bootSeed.ts"]) {
      expect(strip(readFileSync(join(__dirname, file), "utf8"))).not.toMatch(/localStorage|sessionStorage|indexedDB|caches\.|serviceWorker|persist/i)
    }
    // Only the theme bootstrap may read its single preference key; boot/conversation data
    // still cannot touch storage. The bootstrap never writes or consumes API responses.
    const theme = /<script id="theme-init">([\s\S]*?)<\/script>/.exec(html)!
    expect(theme).not.toBeNull()
    expect(strip(theme[1]!).replace('localStorage.getItem("boxyard:theme")', "")).not.toMatch(/localStorage|sessionStorage|indexedDB|caches\.|serviceWorker|persist|fetch\(/i)
    expect(strip(html.replace(theme[0], ""))).not.toMatch(/localStorage|sessionStorage|indexedDB|caches\.|serviceWorker|persist/i)
  })
})

describe("the live stream after the boot data", () => {
  function Live() {
    useServerEvents(true)
    return null
  }
  const live = () => act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Live))))
  const streamed = () => qc.getQueryData<string>(keys.chatStream)

  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => setTimeout(fn, 0))
  })

  it("takes over the page's stream and drops the events the snapshot already includes", async () => {
    const boot = deferred<BootPayload | null>()
    const start = earlyStart(boot.promise)
    adopt(start)
    const page = FakeEventSource.all[0]!
    page.open()
    page.hello(3)
    page.delta("a") // event 4: in the snapshot
    live()
    await settle()
    // Nothing applies before the data it updates is in.
    expect(streamed()).toBeUndefined()
    expect(page.onmessage).toBeNull()

    await act(async () => boot.resolve(payload(5)))
    await settle(20)
    expect(FakeEventSource.all).toHaveLength(1)
    page.delta("b") // event 5: in the snapshot
    page.delta("c") // event 6: after it
    page.delta("d")
    await settle(20)
    expect(streamed()).toBe("cd")
  })

  it("stops dropping at the snapshot's mark: an update that changed nothing sent nothing", async () => {
    const boot = deferred<BootPayload | null>()
    adopt(earlyStart(boot.promise))
    const page = FakeEventSource.all[0]!
    page.open()
    page.hello(3)
    page.delta("a") // event 4: in the snapshot
    // Event 5, a task update that changed nothing, sent this patch stream nothing.
    page.mark(6) // the snapshot, read after event 6...
    page.delta("b") // ...which this is: kept, though only one message came before the mark, not three
    live()
    await act(async () => boot.resolve(payload(6)))
    await settle(20)
    page.delta("c")
    await settle(20)
    expect(streamed()).toBe("bc")
  })

  it("still patches a task from an update the snapshot already includes", async () => {
    const task = { id: "task_boot01", projectId: project.id, title: "Old title", status: "working", updatedAt: 1 } as unknown as Task
    const boot = deferred<BootPayload | null>()
    adopt(earlyStart(boot.promise))
    const page = FakeEventSource.all[0]!
    page.open()
    page.hello(4)
    page.send({ type: "task", task }) // event 5: in the snapshot, not applied again
    page.mark(5)
    live()
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    await act(async () => boot.resolve(payload(5)))
    await settle(20)
    expect(qc.getQueryData<Task[]>(keys.tasks)).toEqual([])
    // The server sent the task whole on this connection, so the next update is a patch on that copy.
    page.send({ type: "task.patch", id: task.id, patch: { title: "New title" } })
    await settle(20)
    expect(qc.getQueryData<Task[]>(keys.tasks)).toEqual([{ ...task, title: "New title" }])
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: keys.tasks })
  })

  it("refetches everything when the stream started after the snapshot was read", async () => {
    const boot = deferred<BootPayload | null>()
    adopt(earlyStart(boot.promise))
    const page = FakeEventSource.all[0]!
    page.open()
    page.hello(7)
    page.delta("x") // event 8: the snapshot (at 5) lacks 6 and 7
    live()
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    await act(async () => boot.resolve(payload(5)))
    await settle(20)
    expect(invalidate).toHaveBeenCalled()
    expect(streamed()).toBe("x")
  })

  it("refetches everything when the server restarted in between", async () => {
    const boot = deferred<BootPayload | null>()
    adopt(earlyStart(boot.promise))
    const page = FakeEventSource.all[0]!
    page.open()
    page.hello(1, "run2")
    live()
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    await act(async () => boot.resolve(payload(5, "run1")))
    await settle(20)
    expect(invalidate).toHaveBeenCalled()
  })

  it("opens one stream when Retry is pressed before the boot data is in", async () => {
    const boot = deferred<BootPayload | null>()
    adopt(earlyStart(boot.promise))
    const page = FakeEventSource.all[0]!
    page.open()
    page.hello(5)
    live()
    act(() => reconnectNow())
    await act(async () => boot.resolve(payload(5)))
    await settle(20)
    expect(FakeEventSource.all).toHaveLength(1)
    page.delta("once")
    await settle(20)
    expect(streamed()).toBe("once")
  })

  it("opens its own stream when the page's failed", async () => {
    const boot = deferred<BootPayload | null>()
    adopt(earlyStart(boot.promise))
    const page = FakeEventSource.all[0]!
    page.onerror?.()
    live()
    await act(async () => boot.resolve(payload(5)))
    await settle(20)
    expect(FakeEventSource.all).toHaveLength(2)
    expect(page.readyState).toBe(FakeEventSource.CLOSED)
    // A stream with no snapshot to line up with applies everything it hears.
    const own = FakeEventSource.all[1]!
    own.open()
    own.hello(9)
    own.delta("z")
    await settle(20)
    expect(streamed()).toBe("z")
  })
})

describe("isBootPath", () => {
  it("matches the boot paths and each Captain's state only", () => {
    for (const path of BOOT_PATHS) expect(isBootPath(path)).toBe(true)
    expect(isBootPath(captainStatePath("prj_abc"))).toBe(true)
    expect(isBootPath("/api/tasks?projectId=prj_abc")).toBe(false)
    expect(isBootPath("/api/notifications?limit=10")).toBe(false)
    expect(isBootPath("/api/projects/prj_abc/captain/messages")).toBe(false)
    expect(isBootPath("/api/me")).toBe(false)
  })
})
