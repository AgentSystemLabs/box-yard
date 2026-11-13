// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { CAPTAIN_GROW_ROWS, CaptainTab } from "../web/src/components/CaptainTab.js"
import { afterFirstPaint, prefetchRecentCaptains, seedRecentCaptains, whenSettled } from "../web/src/lib/captainPrefetch.js"
import { adoptEarlyStart, type EarlyStart } from "../web/src/lib/boot.js"
import { forgetCaptainTail, isCaptainTail, keys, shareById } from "../web/src/lib/queries.js"
import { useCountFromFirst } from "../web/src/lib/tail.js"
import { threadKeys } from "../web/src/lib/threads.js"
import type { CaptainMessage, CaptainState, Project, RecentCaptain } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project = { id: "prj_prefetch01", name: "demo", description: "", repo: null, baseBranch: "main", envKeys: [], notes: [], createdAt: 0, updatedAt: 0 } as unknown as Project
const other = { ...project, id: "prj_prefetch02", name: "other" } as Project
// In every prefetched message: none of it may reach web storage.
const SECRET = "sk-captain-secret-4f9a"

const state = (projectId: string): CaptainState => ({
  projectId, busy: false, usage: { tokens: null, window: null, updatedAt: null }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null,
})
const msg = (projectId: string, i: number, role: CaptainMessage["role"] = i % 2 ? "assistant" : "user"): CaptainMessage => ({
  id: `cap_${projectId}_${String(i).padStart(4, "0")}`, projectId, role, content: `Message ${i} about ${SECRET}`, meta: role === "user" ? { source: "cody" } : null, createdAt: 1_000 + i,
})
const history = (projectId: string, n: number) => Array.from({ length: n }, (_, i) => msg(projectId, i))
const recent = (projectId: string, messages: CaptainMessage[], more = false): RecentCaptain => ({ projectId, state: state(projectId), messages, more, threads: [] })

let root: Root
let host: HTMLElement
let qc: QueryClient
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
// Routes the app requests; anything else stays pending. Each call is recorded.
let routes: Record<string, () => Promise<Response>>
let requests: { path: string; priority?: string }[]

beforeEach(() => {
  routes = {}
  requests = []
  vi.stubGlobal("fetch", (path: string, init?: { priority?: string }) => {
    requests.push({ path, priority: init?.priority })
    return routes[path]?.() ?? new Promise(() => {})
  })
  // As in web/src/main.tsx.
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } })
  for (const k of [keys.tasks, keys.schedules, keys.artifacts, keys.boxes]) qc.setQueryData(k, [])
  qc.setQueryData(keys.projects, [project, other])
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  qc.clear()
  for (const p of [project, other]) forgetCaptainTail(p.id)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  Reflect.deleteProperty(navigator, "serviceWorker")
  localStorage.clear()
  sessionStorage.clear()
})

const render = (node: ReactNode) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, node)))
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))))
/** A frame and a task later: when what waits for the paint (lib/afterPaint.ts) goes. */
const afterFrame = () => act(async () => void (await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))))

describe("Captain prefetch", () => {
  it("keeps every prefetched conversation in memory only: nothing goes to web storage, IndexedDB, the Cache API or a service worker", async () => {
    const stored: string[] = []
    const realSetItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      stored.push(`${key}=${value}`)
      Reflect.apply(realSetItem, this, [key, value])
    })
    const idb = { open: vi.fn(), deleteDatabase: vi.fn() }
    const cacheApi = { open: vi.fn(), match: vi.fn(), has: vi.fn(), keys: vi.fn(), delete: vi.fn() }
    const serviceWorker = { register: vi.fn(), ready: new Promise(() => {}), controller: null }
    vi.stubGlobal("indexedDB", idb)
    vi.stubGlobal("caches", cacheApi)
    Object.defineProperty(navigator, "serviceWorker", { value: serviceWorker, configurable: true })
    routes["/api/captains/recent"] = async () => json([recent(project.id, history(project.id, 6)), recent(other.id, history(other.id, 4))])
    // The view then opens with what's cached; its own refetches never answer here.

    await act(() => prefetchRecentCaptains(qc))
    // At the normal priority: on a fresh launch a low one's answer was read late, between the first frames, and a
    // Captain tapped meanwhile found nothing in memory.
    expect(requests.find((r) => r.path === "/api/captains/recent")).toEqual({ path: "/api/captains/recent", priority: undefined })
    // In React Query's cache (memory).
    expect(qc.getQueryData<CaptainMessage[]>(keys.captainMessages(project.id))).toHaveLength(6)
    expect(qc.getQueryData<CaptainMessage[]>(keys.captainMessages(other.id))).toHaveLength(4)
    expect(qc.getQueryData(keys.captain(other.id))).toEqual(state(other.id))
    expect(qc.getQueryData(threadKeys.list(other.id))).toEqual([])

    // Opening a Captain renders it, and its chat writes what it keeps (scroll spots, drafts) as it always has.
    render(createElement(CaptainTab, { project, centre: true }))
    await settle()
    expect(host.textContent).toContain(`Message 5 about ${SECRET}`)

    const webStorage = [localStorage, sessionStorage].flatMap((s) => Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i)!)}`))
    expect(stored.filter((w) => w.includes(SECRET))).toEqual([])
    expect(webStorage.filter((w) => w.includes(SECRET))).toEqual([])
    expect(document.cookie).not.toContain(SECRET)
    expect(idb.open).not.toHaveBeenCalled()
    expect(cacheApi.open).not.toHaveBeenCalled()
    expect(serviceWorker.register).not.toHaveBeenCalled()
  })

  it("keeps the web app free of query persisters, IndexedDB, the Cache API and caching service workers", () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|tsx)$/.test(name)) files.push(path)
      }
    }
    walk(join(__dirname, "../web/src"))
    const banned = /\bindexedDB\b|\bcaches\.(open|match)|serviceWorker\.register|persistQueryClient|PersistQueryClientProvider|create(Sync|Async)StoragePersister|createQueryPersister/
    // The one worker is browser notifications' (phones show them only through one), checked below to keep nothing.
    const source = (f: string) => {
      const text = readFileSync(f, "utf8")
      return f.endsWith("browserNotifications.ts") ? text.replace("serviceWorker.register(WORKER_URL)", "") : text
    }
    const hits = files.filter((f) => !f.endsWith("captainPrefetch.ts") && banned.test(source(f)))
    expect(hits).toEqual([])
    const worker = readFileSync(join(__dirname, "../web/public/sw.js"), "utf8").replace(/^\s*\/\/.*$/gm, "")
    expect(worker).not.toMatch(/["']fetch["']|onfetch|\bcaches\b|indexedDB|localStorage|sessionStorage|importScripts|\bfetch\(/)
    // The prefetch's own file only names them in its comment.
    const own = readFileSync(join(__dirname, "../web/src/lib/captainPrefetch.ts"), "utf8").replace(/^\/\/.*$/gm, "")
    expect(own).not.toMatch(/localStorage|sessionStorage|indexedDB|caches\.|serviceWorker|persist/i)
    // Unsent drafts (text and files) are conversation data too: memory only, so a reload starts them empty.
    for (const drafts of ["composerDraft.ts", "newTask.ts"]) {
      const code = readFileSync(join(__dirname, "../web/src/lib", drafts), "utf8").replace(/^\/\/.*$/gm, "")
      expect(code, drafts).not.toMatch(/localStorage|sessionStorage|indexedDB|caches\.|serviceWorker|persist/i)
    }
  })

  it("never overwrites a Captain already in the cache", () => {
    const live = history(project.id, 3)
    qc.setQueryData(keys.captainMessages(project.id), live)
    const busy = { ...state(project.id), busy: true }
    qc.setQueryData(keys.captain(project.id), busy)
    seedRecentCaptains(qc, [recent(project.id, history(project.id, 2), true), recent(other.id, history(other.id, 2), true)])
    expect(qc.getQueryData(keys.captainMessages(project.id))).toBe(live)
    expect(qc.getQueryData(keys.captain(project.id))).toBe(busy)
    expect(isCaptainTail(project.id)).toBe(false)
    expect(qc.getQueryData<CaptainMessage[]>(keys.captainMessages(other.id))).toHaveLength(2)
    expect(isCaptainTail(other.id)).toBe(true)
  })

  it("keeps prefetched Captains past React Query's five minutes without a view", async () => {
    vi.useFakeTimers()
    seedRecentCaptains(qc, [recent(project.id, history(project.id, 2))])
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(qc.getQueryData<CaptainMessage[]>(keys.captainMessages(project.id))).toHaveLength(2)
    expect(qc.getQueryData(keys.captain(project.id))).toEqual(state(project.id))
  })

  it("shows a prefetched tail at once, then loads the whole history in above it without a blank or a new-message count", async () => {
    const all = history(project.id, 10)
    let answer!: (r: Response) => void
    routes[`/api/projects/${project.id}/captain/messages`] = () => new Promise((r) => (answer = r))
    seedRecentCaptains(qc, [recent(project.id, all.slice(-3), true)])
    const tail = qc.getQueryData<CaptainMessage[]>(keys.captainMessages(project.id))!

    render(createElement(CaptainTab, { project, centre: true }))
    // The newest messages are on screen before any answer. The whole history is asked for even though the tail is
    // fresh, once that frame is painted: not in the tap that opened it.
    expect(host.textContent).toContain("Message 9 about")
    expect(host.textContent).not.toContain("Message 0 about")
    // Nor are the compactions behind its ⋯ menu.
    for (const path of ["captain/messages", "captain/compactions"]) expect(requests.map((r) => r.path)).not.toContain(`/api/projects/${project.id}/${path}`)
    await afterFrame()
    for (const path of ["captain/messages", "captain/compactions"]) expect(requests.map((r) => r.path)).toContain(`/api/projects/${project.id}/${path}`)

    await act(async () => answer(json(all)))
    await settle()
    const list = qc.getQueryData<CaptainMessage[]>(keys.captainMessages(project.id))!
    expect(list).toHaveLength(10)
    // The tail's messages are the same objects, so their rows don't re-render.
    expect(list.slice(-3)).toEqual(tail)
    for (const [i, m] of tail.entries()) expect(list[7 + i]).toBe(m)
    expect(isCaptainTail(project.id)).toBe(false)
    expect(host.textContent).toContain("Message 9 about")
  })

  it("opens a Captain whose whole conversation was prefetched without asking again", async () => {
    seedRecentCaptains(qc, [recent(project.id, history(project.id, 4))])
    render(createElement(CaptainTab, { project, centre: true }))
    await settle()
    expect(host.textContent).toContain("Message 3 about")
    expect(requests.map((r) => r.path)).not.toContain(`/api/projects/${project.id}/captain/messages`)
  })

  it("switches to a Captain in memory on just the rows that fill the view, then the rest of the newest 60 a few a frame", async () => {
    // A phone-sized chat: a 400px list of 100px messages. Building the newest 60 before the first paint took half a
    // second on a phone, so switching to a Captain already in memory still stalled; building the rest all at once
    // right after it held the next click or scroll for a quarter of a second.
    const isList = (el: Element) => el.classList.contains("overflow-y-auto")
    const shown = (el: Element = host) => new Set([...el.querySelectorAll("[data-chat-id]")].map((r) => r.getAttribute("data-chat-id"))).size
    // The rows on screen after each frame, until the newest 60 are.
    const grown = async () => {
      const counts = [shown()]
      for (let i = 0; i < 100 && counts.at(-1)! < 60; i++) {
        await act(() => new Promise((r) => setTimeout(r, 5)))
        if (shown() !== counts.at(-1)) counts.push(shown())
      }
      return counts
    }
    const layout: Record<string, PropertyDescriptor> = {
      clientHeight: { get(this: Element) { return isList(this) ? 400 : 0 } },
      scrollHeight: { get(this: Element) { return isList(this) ? Math.max(400, shown(this) * 100) : 0 } },
    }
    for (const [key, d] of Object.entries(layout)) Object.defineProperty(HTMLElement.prototype, key, { ...d, configurable: true })
    try {
      seedRecentCaptains(qc, [recent(project.id, history(project.id, 200)), recent(other.id, history(other.id, 200))])
      render(createElement(CaptainTab, { key: project.id, project, centre: true }))
      expect((await grown()).at(-1)).toBe(60)

      render(createElement(CaptainTab, { key: other.id, project: other, centre: true }))
      // The first paint: the newest messages, enough to fill the view, and no more.
      expect(host.textContent).toContain("Message 199 about")
      expect(shown()).toBeGreaterThanOrEqual(4)
      expect(shown()).toBeLessThanOrEqual(8)
      const counts = await grown()
      expect(counts.at(-1)).toBe(60)
      for (const [i, n] of counts.slice(1).entries()) expect(n - counts[i]!).toBeLessThanOrEqual(CAPTAIN_GROW_ROWS)
      expect(requests.map((r) => r.path)).not.toContain(`/api/projects/${other.id}/captain/messages`)
    } finally {
      for (const key of Object.keys(layout)) Reflect.deleteProperty(HTMLElement.prototype, key)
    }
  })

  it("seeds what the page asked for as it loaded, without asking again", async () => {
    // web/index.html asks once the boot data is in, so on a fresh launch it's here by the time a Captain can be tapped.
    const start = { me: Promise.resolve(null), boot: Promise.resolve(null), stream: null, heard: [], failed: true, listen: () => {} } as EarlyStart
    start.recent = Promise.resolve([recent(project.id, history(project.id, 6))])
    adoptEarlyStart({ me: () => {}, boot: () => {} }, start)
    try {
      await act(() => prefetchRecentCaptains(qc))
      expect(requests).toEqual([])
      expect(qc.getQueryData<CaptainMessage[]>(keys.captainMessages(project.id))).toHaveLength(6)
    } finally {
      adoptEarlyStart({ me: () => {}, boot: () => {} }, undefined)
    }
  })

  it("gives up quietly when the prefetch fails, so a Captain loads when opened as before", async () => {
    routes["/api/captains/recent"] = async () => new Response("nope", { status: 500 })
    await expect(prefetchRecentCaptains(qc)).resolves.toBeUndefined()
    expect(qc.getQueryData(keys.captainMessages(project.id))).toBeUndefined()
  })
})

describe("whenSettled", () => {
  beforeEach(() => vi.useFakeTimers())

  it("waits for the first paint and the app's own requests, then for an idle moment", async () => {
    const fn = vi.fn()
    let idle: (() => void) | undefined
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => ((idle = cb), 1))
    vi.stubGlobal("cancelIdleCallback", () => {})
    let finish!: (v: string) => void
    void qc.fetchQuery({ queryKey: ["first-load"], queryFn: () => new Promise<string>((r) => (finish = r)) }).catch(() => {})
    whenSettled(qc, fn)
    await vi.advanceTimersByTimeAsync(100)
    expect(idle).toBeUndefined()
    finish("done")
    await vi.advanceTimersByTimeAsync(0)
    expect(idle).toBeDefined()
    expect(fn).not.toHaveBeenCalled()
    idle!()
    expect(fn).toHaveBeenCalledOnce()
  })

  it("goes anyway when a request never settles, and not at all once cancelled", async () => {
    vi.stubGlobal("requestIdleCallback", undefined)
    void qc.fetchQuery({ queryKey: ["stuck"], queryFn: () => new Promise(() => {}) }).catch(() => {})
    const fn = vi.fn()
    whenSettled(qc, fn)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fn).toHaveBeenCalledOnce()

    const never = vi.fn()
    const cancel = whenSettled(qc, never)
    cancel()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(never).not.toHaveBeenCalled()
  })
})

describe("afterFirstPaint", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => adoptEarlyStart({ me: () => {}, boot: () => {} }, undefined))

  // The page's early start (lib/boot.ts) with its boot data still on the way.
  const bootOnTheWay = () => {
    let arrive!: () => void
    const boot = new Promise<null>((r) => (arrive = () => r(null)))
    adoptEarlyStart({ me: () => {}, boot: () => {} }, { me: Promise.resolve(null), boot, stream: null, heard: [], failed: true, listen: () => {} } as EarlyStart)
    return arrive
  }

  it("goes a frame and a task after the first paint, once the boot data is in, without waiting for idle or the app's requests", async () => {
    // A fresh launch keeps a phone busy for a second or more: no idle moment comes, and the app's requests still run.
    vi.stubGlobal("requestIdleCallback", () => 1)
    vi.stubGlobal("cancelIdleCallback", () => {})
    void qc.fetchQuery({ queryKey: ["first-load"], queryFn: () => new Promise(() => {}) }).catch(() => {})
    const arrive = bootOnTheWay()
    const fn = vi.fn()
    afterFirstPaint(fn)
    await vi.advanceTimersByTimeAsync(100)
    expect(fn).not.toHaveBeenCalled()
    arrive()
    await vi.advanceTimersByTimeAsync(0)
    expect(fn).toHaveBeenCalledOnce()

    const next = vi.fn()
    afterFirstPaint(next)
    expect(next).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(20)
    expect(next).toHaveBeenCalledOnce()
  })

  it("doesn't go once cancelled, before or after the frame", async () => {
    const before = vi.fn()
    afterFirstPaint(before)()
    const arrive = bootOnTheWay()
    const after = vi.fn()
    const cancel = afterFirstPaint(after)
    await vi.advanceTimersByTimeAsync(50)
    cancel()
    arrive()
    await vi.advanceTimersByTimeAsync(50)
    expect(before).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })
})

describe("shareById", () => {
  it("keeps the messages already there as the same objects when older ones load in above them", () => {
    const a = history(project.id, 5)
    const tail = a.slice(-2).map((m) => ({ ...m }))
    const out = shareById(tail, a.map((m) => ({ ...m }))) as CaptainMessage[]
    expect(out).toHaveLength(5)
    expect(out[3]).toBe(tail[0])
    expect(out[4]).toBe(tail[1])
    expect(shareById(tail, tail.map((m) => ({ ...m })))).toBe(tail)
    const edited = shareById(tail, [tail[0], { ...tail[1]!, content: "edited" }]) as CaptainMessage[]
    expect(edited[0]).toBe(tail[0])
    expect(edited[1]!.content).toBe("edited")
    expect(shareById(undefined, a)).toBe(a)
  })
})

describe("useCountFromFirst", () => {
  it("counts from the first item it opened with, so history loading in above doesn't count as new", () => {
    const seen: number[] = []
    const Probe = ({ items, k }: { items: { id: string }[]; k: string }) => {
      seen.push(useCountFromFirst(items, k))
      return null
    }
    const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => ({ id: `m${from + i}` }))
    render(createElement(Probe, { items: ids(7, 10), k: "a" }))
    render(createElement(Probe, { items: ids(0, 10), k: "a" }))
    render(createElement(Probe, { items: ids(0, 12), k: "a" }))
    // Another chat counts from its own start.
    render(createElement(Probe, { items: ids(0, 4), k: "b" }))
    // A list that opened empty counts from its first item.
    render(createElement(Probe, { items: [], k: "c" }))
    render(createElement(Probe, { items: ids(5, 7), k: "c" }))
    expect(seen).toEqual([3, 3, 5, 4, 0, 2])
  })
})
