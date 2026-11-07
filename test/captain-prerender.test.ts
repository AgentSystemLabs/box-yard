// @vitest-environment happy-dom
// A press on a Captain's sidebar row renders its chat hidden behind the centre's (lib/captainPrerender.ts), so the click
// only shows it. The pre-render has no side effects: it asks the server for nothing, takes no focus and writes nothing
// to web storage, because none of its effects mount until it's shown. A cancelled press, a scroll, a release off the
// row or a click that never comes throws it away.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { seedRecentCaptains } from "../web/src/lib/captainPrefetch.js"
import { CLICK_GRACE_MS, prerenderedCaptain } from "../web/src/lib/captainPrerender.js"
import { forgetCaptainTail, keys } from "../web/src/lib/queries.js"
import { setChatProjectFilter } from "../web/src/lib/projectBar.js"
import { HOVER_INTENT_MS } from "../web/src/lib/taskPrefetch.js"
import { resetScrollMemory } from "../web/src/lib/scrollMemory.js"
import type { CaptainMessage, CaptainState, ChatMessage, Project, Task } from "../shared/types"
import { APP_HOME } from "../web/src/lib/navigation.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const project = (id: string, name: string) => ({ id, name, repo: null, description: "", notes: [], envKeys: [], baseBranch: "main", runner: "box", identityId: "idn_default", gpuMachine: { gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null }, docker: { image: null, dockerfile: null }, createdAt: now, color: null }) as unknown as Project
const state = (projectId: string): CaptainState => ({ projectId, busy: false, usage: { tokens: 0, window: 1_000_000, updatedAt: now }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null })

const YARD = project("prj_yard01", "box-yard")
const SITE = project("prj_site01", "marketing-site")
// Never opened, nor prefetched: nothing of its conversation is in memory.
const COLD = project("prj_cold01", "cold-project")
// In marketing-site's conversation: none of it may reach web storage.
const SECRET = "sk-site-secret-71c2"
const SITE_CHAT: CaptainMessage[] = [{ id: "cm_site01", projectId: SITE.id, role: "assistant", content: `The launch plan uses ${SECRET}.`, meta: null, createdAt: now - 1000 }]
// A working task each, so every project has its own group in the sidebar.
const task = (id: string, projectId: string) =>
  ({ id, projectId, title: `Task ${id}`, status: "working", prompt: "Do it.", boxId: null, sessionId: "s", branch: null, prUrl: null, prState: null, prMergedAt: null, previews: [], waitFor: [], question: null, summary: null, error: null, waitReason: null, turnCount: 1, pendingCount: 0, scheduleId: null, outcome: null, contextTokens: null, contextWindow: null, model: null, effort: null, createdAt: now - 60_000, updatedAt: now - 60_000 }) as unknown as Task
const TASKS = [task("task_yard01", YARD.id), task("task_site01", SITE.id), task("task_cold01", COLD.id)]
const COORDINATOR: ChatMessage[] = [{ id: "msg_1", role: "assistant", content: "Morning.", meta: null, createdAt: now - 1000 }]

class FakeEventSource {
  onmessage: unknown = null
  onerror: unknown = null
  onopen: unknown = null
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

let root: Root
let host: HTMLElement
let requests: string[]

function render() {
  history.replaceState(null, "", APP_HOME)
  resetScrollMemory()
  sessionStorage.setItem("box-yard:landed", "1")
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.agentSettings, { settings: { ...DEFAULT_SETTINGS, ownerName: "Cody" }, sources: {}, defaults: DEFAULT_SETTINGS })
  qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.orchestrator, { busy: false, usage: { tokens: 1000, window: 1_000_000, updatedAt: now }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null })
  qc.setQueryData(keys.chat, COORDINATOR)
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, TASKS)
  qc.setQueryData(keys.projects, [YARD, SITE, COLD])
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications, keys.scheduleRuns]) qc.setQueryData(k, [])
  for (const p of [YARD, COLD]) qc.setQueryData(keys.captain(p.id), state(p.id))
  qc.setQueryData(keys.captainMessages(YARD.id), [])
  // marketing-site as the prefetch leaves it: its newest messages, with more to load once its chat is shown.
  seedRecentCaptains(qc, [{ projectId: SITE.id, state: state(SITE.id), messages: SITE_CHAT, more: true, threads: [] }])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
  return qc
}

const nav = () => document.querySelector<HTMLElement>("nav[aria-label='Projects and tasks']")!
const captainRow = (p: Project) => nav().querySelector<HTMLElement>(`[data-open-captain='${p.id}']`)!
const chats = () => [...document.querySelectorAll<HTMLElement>("[data-testid=captain-chat]")]
/** The chat rendered ahead of its click: in the page, but hidden. */
const hiddenChat = () => chats().find((c) => c.style.display === "none")
/** The centre chat's title: "marketing-site Captain", or the Coordinator's. */
const centre = () => [...document.querySelectorAll<HTMLElement>("[data-testid=chat-title]")].find((t) => !t.closest<HTMLElement>("[style*='display: none']"))?.textContent
const siteRequests = () => requests.filter((r) => r.startsWith(`/api/projects/${SITE.id}/`))
const storage = () => JSON.stringify([{ ...localStorage }, { ...sessionStorage }])

const pointer = (el: Element, type: string, init: PointerEventInit = {}) =>
  act(() => void el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, pointerType: "touch", button: 0, ...init })))
const press = (el: Element, init?: PointerEventInit) => pointer(el, "pointerdown", init)
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
/** A finger's whole tap on a row: down, up, and the click the browser sends after. */
const tap = (el: Element) => {
  press(el)
  pointer(el, "pointerup")
  click(el)
}
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))))
/** A frame and a task later: when a shown chat asks for what it's missing (lib/afterPaint.ts). */
const afterFrame = () => act(async () => void (await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))))

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  ;(window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 1440, height: 900 })
  requests = []
  vi.stubGlobal("fetch", vi.fn((path: string) => {
    requests.push(path)
    return new Promise(() => {})
  }))
  vi.stubGlobal("EventSource", FakeEventSource)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  act(() => root.unmount())
  // A shown chat's requests wait for its first paint, and go on after it's gone: let them, before the next test.
  await afterFrame()
  host.remove()
  document.body.innerHTML = ""
  act(() => setChatProjectFilter(null))
  forgetCaptainTail(SITE.id)
  vi.unstubAllGlobals()
  localStorage.clear()
  sessionStorage.clear()
})

describe("a Captain's chat rendered ahead of its click", () => {
  it("renders, hidden, while its row is pressed, from memory alone: no request, no focus, nothing in web storage", async () => {
    render()
    await afterFrame()
    const focused = document.activeElement
    const before = storage()
    requests = []

    press(captainRow(SITE))
    expect(prerenderedCaptain()).toBe(SITE.id)
    const chat = hiddenChat()!
    expect(chat.textContent).toContain(SECRET)
    // The Coordinator is still the one shown.
    expect(chats()).toHaveLength(1)
    expect(centre()).not.toBe("marketing-site Captain")

    await afterFrame()
    // A shown chat with only its newest messages asks for the rest after its first paint: this one isn't shown.
    expect(siteRequests()).toEqual([])
    expect(document.activeElement).toBe(focused)
    expect(chat.contains(document.activeElement)).toBe(false)
    expect(storage()).toBe(before)
    expect(storage()).not.toContain(SECRET)
  })

  it("the click shows that same chat, which only then starts: it asks for the rest of its conversation", async () => {
    render()
    await afterFrame()
    requests = []
    press(captainRow(SITE))
    const chat = hiddenChat()!

    pointer(captainRow(SITE), "pointerup")
    click(captainRow(SITE))
    expect(centre()).toBe("marketing-site Captain")
    // The very element built during the press, now shown: nothing was built again.
    expect(chats()).toEqual([chat])
    expect(chat.style.display).toBe("")
    expect(chat.textContent).toContain(SECRET)

    await afterFrame()
    expect(prerenderedCaptain()).toBeNull()
    expect(siteRequests()).toContain(`/api/projects/${SITE.id}/captain/messages`)
    expect(storage()).not.toContain(SECRET)
  })

  it("opens on the newest message, pinned to the bottom", async () => {
    // Every list is 400px tall, its rows 100px each, laid out as soon as they're in the page.
    const isList = (el: Element) => el.classList.contains("overflow-y-auto")
    const rows = (el: Element) => el.querySelectorAll("[data-chat-id]").length
    const tops = new WeakMap<Element, number>()
    const layout: Record<string, PropertyDescriptor> = {
      clientHeight: { get(this: Element) { return isList(this) ? 400 : 0 } },
      scrollHeight: { get(this: Element) { return isList(this) ? Math.max(400, rows(this) * 100 + 600) : 0 } },
      scrollTop: { get(this: Element) { return tops.get(this) ?? 0 }, set(this: Element, v: number) { tops.set(this, Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight))) } },
    }
    for (const [key, d] of Object.entries(layout)) Object.defineProperty(HTMLElement.prototype, key, { ...d, configurable: true })
    try {
      render()
      await afterFrame()
      press(captainRow(SITE))
      const list = hiddenChat()!.querySelector<HTMLElement>(".overflow-y-auto")!
      pointer(captainRow(SITE), "pointerup")
      click(captainRow(SITE))
      expect(list.isConnected).toBe(true)
      expect(list.scrollTop).toBe(list.scrollHeight - list.clientHeight)
      expect(list.scrollTop).toBeGreaterThan(0)
    } finally {
      for (const key of Object.keys(layout)) Reflect.deleteProperty(HTMLElement.prototype, key)
    }
  })

  it("is thrown away when the press is cancelled, turns into a scroll, or lets go off the row", async () => {
    render()
    await afterFrame()
    press(captainRow(SITE))
    expect(hiddenChat()).toBeDefined()
    pointer(captainRow(SITE), "pointercancel")
    expect(hiddenChat()).toBeUndefined()
    expect(prerenderedCaptain()).toBeNull()

    press(captainRow(SITE))
    expect(hiddenChat()).toBeDefined()
    // The sidebar's list scrolling under the finger.
    const list = captainRow(SITE).closest<HTMLElement>(".overflow-y-auto") ?? nav()
    act(() => void list.dispatchEvent(new Event("scroll")))
    expect(hiddenChat()).toBeUndefined()

    press(captainRow(SITE))
    expect(hiddenChat()).toBeDefined()
    pointer(document.body, "pointerup")
    expect(hiddenChat()).toBeUndefined()
    // None of it opened marketing-site, nor asked for anything.
    expect(centre()).not.toBe("marketing-site Captain")
    expect(siteRequests()).toEqual([])
  })

  it("is thrown away when the click never comes", async () => {
    render()
    await afterFrame()
    press(captainRow(SITE))
    pointer(captainRow(SITE), "pointerup")
    expect(hiddenChat()).toBeDefined()
    await wait(CLICK_GRACE_MS + 50)
    expect(hiddenChat()).toBeUndefined()
  })

  it("isn't rendered for a Captain with nothing in memory, nor for the one already shown", async () => {
    render()
    await afterFrame()
    press(captainRow(COLD))
    expect(prerenderedCaptain()).toBeNull()
    expect(hiddenChat()).toBeUndefined()
    expect(requests.filter((r) => r.includes(COLD.id))).toEqual([])
    pointer(document.body, "pointerup")

    tap(captainRow(SITE))
    expect(centre()).toBe("marketing-site Captain")
    press(captainRow(SITE))
    expect(prerenderedCaptain()).toBeNull()
    expect(chats()).toHaveLength(1)
  })

  it("starts for a mouse resting on the row too, and stops when it moves off; a finger passing over starts nothing", async () => {
    render()
    await afterFrame()
    pointer(captainRow(SITE), "pointerover", { pointerType: "touch" })
    await wait(HOVER_INTENT_MS + 20)
    expect(hiddenChat()).toBeUndefined()

    pointer(captainRow(SITE), "pointerover", { pointerType: "mouse" })
    expect(hiddenChat()).toBeUndefined()
    await wait(HOVER_INTENT_MS + 20)
    expect(hiddenChat()!.textContent).toContain(SECRET)
    pointer(document.body, "pointerover", { pointerType: "mouse" })
    expect(hiddenChat()).toBeUndefined()
    expect(siteRequests()).toEqual([])
  })

  it("leaves the Captain picker as it was: a tap with no press first opens the Captain as before", async () => {
    render()
    await afterFrame()
    click(captainRow(SITE))
    expect(centre()).toBe("marketing-site Captain")
    expect(chats()).toHaveLength(1)
    expect(chats()[0]!.textContent).toContain(SECRET)
  })
})
