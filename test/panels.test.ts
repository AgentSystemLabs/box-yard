// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { warmLazyParts } from "../web/src/components/LazyPart.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { keys } from "../web/src/lib/queries.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import { currentConfirm, settleConfirm } from "../web/src/lib/confirm.js"
import { navigateApp, projectChatHref, taskCardHref, taskSessionHref, APP_HOME, appHref } from "../web/src/lib/navigation.js"
import { chatProjectFilter, setChatProjectFilter } from "../web/src/lib/projectBar.js"
import { COORDINATOR_CHAT, closeThread, openThread, threadKeys } from "../web/src/lib/threads.js"
import { resetScrollMemory } from "../web/src/lib/scrollMemory.js"
import { previewState } from "../web/src/lib/preview.js"
import { COORDINATOR_REF, resetColumns, setPinned } from "../web/src/lib/columns.js"
import type { ChatMessage, Project, Schedule, Task } from "../shared/types"

// Settings, project settings and schedules are lazy chunks: load them up front, as the app does once it settles, so
// they open in the same render.
beforeAll(() => warmLazyParts())

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const task = (id: string, title: string) =>
  ({
    id,
    projectId: "prj_demo01",
    title,
    prompt: "Do it.",
    status: "working",
    boxId: null,
    sessionId: "s",
    branch: null,
    prUrl: null,
    prState: null,
    prMergedAt: null,
    prMergedBy: null,
    previews: [],
    question: null,
    summary: null,
    error: null,
    waitReason: null,
    turnCount: 1,
    pendingCount: 0,
    lastArchivedAt: null,
    scheduleId: null,
    outcome: null,
    contextTokens: null,
    contextWindow: null,
    compactPending: false,
    compacting: false,
    model: null,
    effort: null,
    claudeCostUsd: 0,
    claudeTokens: 0,
    routingRule: null,
    routingReason: null,
    createdAt: now,
    updatedAt: now,
  }) as unknown as Task
const TASKS = [task("task_app001", "Write the docs"), task("task_app002", "Fix the build")]
const PROJECTS = [{ id: "prj_demo01", name: "box-yard", repo: "acme/box-yard", description: "", baseBranch: "main", envKeys: [], gpuMachine: { gpuTypes: [], cloud: null, minRamGb: null, minVcpus: null }, gpuMaxHourlyUsd: null, docker: { image: null, dockerfile: null }, notes: [], runner: "local", identityId: "default", updatedAt: now }] as unknown as Project[]
const REPLY = [
  "Links: [the docs](/tasks/task_app001), [the build](/tasks/task_app002), [the Captain](/projects/prj_demo01?tab=captain),",
  "[the project](/projects/prj_demo01), [boxes](/boxes), [schedule](/schedules#sch_abc123), [a report](/artifacts/art_report01/report.md),",
  "[GitHub](https://github.com/acme/box-yard).",
].join(" ")
// A reply to Cody, so the Cards view keeps it in the Coordinator card (an unprompted one goes on the cards it links).
const CHAT: ChatMessage[] = [
  { id: "msg_0", role: "user", content: "Where is everything?", meta: null, createdAt: now - 2000 },
  { id: "msg_1", role: "assistant", content: REPLY, meta: null, createdAt: now - 1000 },
]

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

function render(path: string = APP_HOME) {
  history.replaceState(null, "", path)
  resetScrollMemory()
  sessionStorage.setItem("box-yard:landed", "1")
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.agentSettings, { settings: { ...DEFAULT_SETTINGS, ownerName: "Cody", orchestratorAutoCompact: { enabled: true, unit: "tokens", value: 250_000 } }, sources: {}, defaults: {} })
  qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.orchestrator, { busy: false, usage: { tokens: 1000, window: 1_000_000, updatedAt: now }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null })
  qc.setQueryData(keys.chat, CHAT)
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, TASKS)
  qc.setQueryData(keys.projects, PROJECTS)
  qc.setQueryData(keys.taskMessages(TASKS[0]!.id), Array.from({ length: 100 }, (_, i) => ({ id: `tm_${i}`, role: "assistant", content: i === 0 ? "The first transcript message" : i === 99 ? `Transcript message 99. ${REPLY}` : `Transcript message ${i}`, meta: null, createdAt: now + i })))
  qc.setQueryData(keys.taskMessages(TASKS[1]!.id), [{ id: "tm_build", role: "assistant", content: `Build transcript. ${REPLY}`, meta: null, createdAt: now }])
  qc.setQueryData(keys.captainMessages("prj_demo01"), CHAT)
  qc.setQueryData(keys.captain("prj_demo01"), { busy: false, usage: { tokens: 0, window: 1000000, updatedAt: now }, compacting: false, compactQueued: false, error: null })
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications, keys.scheduleRuns]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
  return qc
}

const link = (href: string) => [...document.querySelectorAll("a")].find((a) => a.getAttribute("href") === href)!
/** The centre chat: the Coordinator's, or the picked Captain's. */
const chat = () => document.querySelector<HTMLElement>("[data-testid=chat-panel], [data-testid=captain-chat][data-centre]")!
/**
 * Clicks `el`. The links stop propagation, so read `defaultPrevented` off the event. A click the app leaves alone is
 * followed by happy-dom itself (it moves the location), as a new tab would leave this one where it is: put it back.
 */
const click = (el: Element, init: MouseEventInit = {}) => {
  const at = location.pathname + location.search
  const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })
  act(() => void el.dispatchEvent(e))
  if (!e.defaultPrevented && el instanceof HTMLAnchorElement) history.replaceState(history.state, "", at)
  return e
}
const esc = () => act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
  vi.stubGlobal("EventSource", FakeEventSource)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  for (const t of currentToasts()) dismiss(t.id)
  setChatProjectFilter(null)
  resetColumns()
  closeThread(COORDINATOR_CHAT)
  vi.unstubAllGlobals()
})

describe("navigation", () => {
  it.each(["/", "/inbox", "/boxes", "/usage", "/compactions", "/anything-else"])("direct %s lands in the app without mounting a legacy page", (path) => {
    render(path)
    expect(location.pathname).toBe(APP_HOME)
    expect(document.querySelector("[data-app]")).not.toBeNull()
    expect(document.querySelector("nav:not([aria-label='Projects and tasks']):not([aria-label^='Chat days']), aside, [aria-label='Open navigation']")).toBeNull()
    expect(document.querySelectorAll("main")).toHaveLength(1)
  })

  it("turns same-origin task and project URLs into in-app destinations, leaving files and other sites alone", () => {
    expect(appHref("http://yard.test/tasks/task_abc123", "http://yard.test")).toBe(taskSessionHref("task_abc123"))
    expect(appHref("/projects/prj_abc123?tab=schedules#sch_abc123")).toBe("/?schedule=sch_abc123")
    expect(appHref("/settings/machines")).toBe("/?settings=machines")
    expect(appHref("/?settings=credentials")).toBe("/?settings=credentials")
    expect(appHref("/?usage=90")).toBe("/?usage=90")
    expect(appHref("/schedules#sch_abc123")).toBe("/?schedule=sch_abc123")
    expect(appHref("/projects/prj_abc123?tab=captain")).toBe("/?captain=prj_abc123")
    expect(appHref("/artifacts/art_report01/report.md")).toBe("/artifacts/art_report01/report.md")
    expect(appHref("https://other.test/tasks/task_abc123")).toBe("https://other.test/tasks/task_abc123")
    expect(() => appHref("/tasks/%xx")).not.toThrow()
  })

  it("a link from when the app lived under /zen opens the same page without it, query kept", async () => {
    expect(appHref("/zen")).toBe("/")
    expect(appHref("/zen?session=task_abc123&stack=task_def456#queue")).toBe("/?session=task_abc123&stack=task_def456#queue")
    expect(appHref("/zen?project=prj_abc123")).toBe("/?project=prj_abc123")
    expect(appHref("/zen/tasks/task_abc123")).toBe(taskSessionHref("task_abc123"))
    expect(appHref("http://yard.test/zen?captain=prj_abc123", "http://yard.test")).toBe("/?captain=prj_abc123")
    render("/zen?session=task_app002")
    await act(async () => new Promise((r) => setTimeout(r, 30)))
    expect(location.pathname + location.search).toBe(taskSessionHref("task_app002"))
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Fix the build")
  })

  it("an old card link (?task=) opens the task beside the chat, even a long-finished one: the chat has no cards", async () => {
    const qc = render()
    await act(async () => { qc.setQueryData(keys.tasks, TASKS.map((t) => ({ ...t, status: "done", createdAt: now - 10 * 86_400_000, updatedAt: now - 10 * 86_400_000 }))); await new Promise((r) => setTimeout(r, 20)) })
    act(() => navigateApp(taskCardHref("task_app001")))
    await act(async () => new Promise((r) => setTimeout(r, 30)))
    expect(location.pathname + location.search).toBe(taskSessionHref("task_app001"))
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Write the docs")
    expect(document.getElementById("card-task_app001")).toBeNull()
  })

  it("direct task links open their conversation even with no Coordinator history", async () => {
    const qc = render("/tasks/task_app002")
    await act(async () => qc.setQueryData(keys.chat, []))
    await act(async () => new Promise((r) => setTimeout(r, 30)))
    expect(location.pathname).toBe(APP_HOME)
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Fix the build")
  })

  it("a Captain's markdown link shows just that Captain, as the chat; beside a pinned Coordinator, as a panel", () => {
    render()
    click(link("/?captain=prj_demo01"))
    expect(chatProjectFilter()).toBe("prj_demo01")
    expect(new URLSearchParams(location.search).get("captain")).toBeNull()
    expect(document.querySelector("[data-testid=columns]")).toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    setChatProjectFilter(null)
    setPinned(COORDINATOR_REF, true)
    render()
    click(link("/?captain=prj_demo01"))
    expect(chatProjectFilter()).toBeNull()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("box-yard Captain")
  })

  it("an unavailable route renders as text, a schedule stays an in-app link; artifacts still preview", () => {
    render()
    expect([...chat().querySelectorAll("a")].some((a) => a.textContent === "boxes")).toBe(false)
    expect(chat().textContent).toContain("boxes")
    expect(chat().querySelector('a[href="/?schedule=sch_abc123"]')?.textContent).toBe("schedule")
    click(link("/artifacts/art_report01/report.md"))
    expect(previewState()?.items[0]?.url).toBe("/artifacts/art_report01/report.md")
  })

  it("modified task clicks keep native new-tab behavior with an in-app href", () => {
    render()
    const a = link(taskSessionHref("task_app001"))
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) expect(click(a, modifier).defaultPrevented).toBe(false)
    expect(a.getAttribute("href")).toBe(taskSessionHref("task_app001"))
  })

  it.each(["coordinator", "picked Captain"])("opens a markdown task link above the %s chat and restores its exact scroll container", async (source) => {
    render(source === "picked Captain" ? projectChatHref("prj_demo01") : APP_HOME)
    const sourceRoot = chat()
    const anchor = sourceRoot.querySelector<HTMLAnchorElement>('a[href="/?session=task_app002"]')!
    const scroller = anchor.closest<HTMLElement>(".overflow-y-auto")!
    // happy-dom has no layout; model a long thread and a user scrolling away from its bottom.
    Object.defineProperties(scroller, { scrollHeight: { configurable: true, value: 5000 }, clientHeight: { configurable: true, value: 500 } })
    await act(async () => new Promise((r) => setTimeout(r, 30)))
    act(() => {
      // Mount happened before the fake layout existed; deliver its initial bottom scroll first.
      scroller.scrollTop = 4500
      scroller.dispatchEvent(new Event("scroll"))
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }))
      scroller.scrollTop = 1370
      scroller.dispatchEvent(new Event("scroll"))
    })
    await act(async () => new Promise((r) => setTimeout(r, 40)))
    expect(scroller.scrollTop).toBe(1370)
    const draft = sourceRoot.querySelector("textarea")!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(draft, "Keep this draft")
      draft.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(click(anchor).defaultPrevented).toBe(true)
    expect(location.pathname).toBe(APP_HOME)
    expect(document.querySelectorAll('[role="dialog"]').length).toBe(1)
    expect([...document.querySelectorAll('[role="dialog"]')].at(-1)?.getAttribute("aria-label")).toBe("Fix the build")
    expect(sourceRoot.isConnected).toBe(true)
    act(() => history.back())
    await act(async () => new Promise((r) => setTimeout(r, 20)))
    expect(sourceRoot.querySelector("textarea")).toBe(draft)
    expect(draft.value).toBe("Keep this draft")
    expect(chatProjectFilter()).toBe(source === "picked Captain" ? "prj_demo01" : null)
    expect(anchor.closest(".overflow-y-auto")).toBe(scroller)
    expect(scroller.scrollTop).toBe(1370)
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0)
    act(() => history.forward())
    await act(async () => new Promise((r) => setTimeout(r, 20)))
    expect([...document.querySelectorAll('[role="dialog"]')].at(-1)?.getAttribute("aria-label")).toBe("Fix the build")
    esc()
    await act(async () => new Promise((r) => setTimeout(r, 20)))
    expect(draft.isConnected).toBe(true)
    expect(scroller.scrollTop).toBe(1370)
  })

  it("replaces conversations in one question-panel slot, traverses history and closes back to the source focus", async () => {
    render()
    const opener = chat().querySelector<HTMLAnchorElement>('a[href="/?session=task_app001"]')!
    opener.focus()
    click(opener)
    const panel = document.querySelector('[data-testid="side-thread"]')!
    const dialog = panel.querySelector('[role="dialog"]')!
    const oldComposer = dialog.querySelector("textarea")!
    click(dialog.querySelector('a[href="/?session=task_app002"]')!)
    expect(document.querySelectorAll('[data-testid="side-thread"]')).toHaveLength(1)
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(document.querySelector('[data-testid="side-thread"]')).toBe(panel)
    expect(oldComposer.isConnected).toBe(false)
    expect(dialog.textContent).toContain("Fix the build")
    expect(dialog.textContent).not.toContain("Transcript message 99")
    act(() => history.back())
    await act(async () => new Promise((r) => setTimeout(r, 20)))
    expect(dialog.textContent).toContain("Transcript message 99")
    expect(dialog.querySelector("textarea")).not.toBe(oldComposer)
    expect(dialog.contains(document.activeElement)).toBe(true)
    act(() => history.forward())
    await act(async () => new Promise((r) => setTimeout(r, 20)))
    expect(dialog.textContent).toContain("Fix the build")
    esc()
    await act(async () => new Promise((r) => setTimeout(r, 20)))
    expect(location.search).toBe("")
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it.each(["session", "captain"])("swipe Back closes the %s through its existing history action, preserving source focus, scroll and draft", async (kind) => {
    vi.stubGlobal("innerWidth", 400)
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query.includes("coarse"), addEventListener() {}, removeEventListener() {} })))
    render()
    const source = chat()
    const opener = source.querySelector<HTMLAnchorElement>(`a[href="/?${kind}=${kind === "session" ? "task_app002" : "prj_demo01"}"]`)!
    const scroller = opener.closest<HTMLElement>(".overflow-y-auto")!
    Object.defineProperties(scroller, { scrollHeight: { configurable: true, value: 5000 }, clientHeight: { configurable: true, value: 500 } })
    await act(async () => new Promise((r) => setTimeout(r, 30)))
    act(() => {
      scroller.scrollTop = 4500
      scroller.dispatchEvent(new Event("scroll"))
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }))
      scroller.scrollTop = 1370
      scroller.dispatchEvent(new Event("scroll"))
    })
    await act(async () => new Promise((r) => setTimeout(r, 40)))
    const draft = source.querySelector("textarea")!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(draft, "Keep my source draft")
      draft.dispatchEvent(new Event("input", { bubbles: true }))
      opener.focus()
    })
    click(opener)
    const panel = document.querySelector<HTMLElement>('[data-testid="side-thread"]')!
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({ width: 400, left: 0 } as DOMRect)
    vi.spyOn(panel.parentElement!, "getBoundingClientRect").mockReturnValue({ width: 400, left: 0 } as DOMRect)
    const header = panel.querySelector("header")!
    const go = vi.spyOn(history, "go")
    const touch = (type: string, x: number) => {
      const p = { clientX: x, clientY: 100, identifier: 1 }
      const e = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperties(e, { touches: { value: type === "touchend" ? [] : [p] }, changedTouches: { value: [p] } })
      act(() => void header.dispatchEvent(e))
      return e
    }
    touch("touchstart", 100)
    expect(touch("touchmove", 260).defaultPrevented).toBe(true)
    expect(panel.style.translate).toBe("160px 0")
    touch("touchend", 260)
    // Closed on the release itself: no settle animation to wait for.
    expect(go).toHaveBeenCalledExactlyOnceWith(-1)
    expect(panel.style.translate).toBe("")
    await act(async () => new Promise((r) => setTimeout(r, 30)))
    expect(go).toHaveBeenCalledOnce()
    expect(location.pathname + location.search).toBe("/")
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(chat()).toBe(source)
    expect(source.querySelector("textarea")).toBe(draft)
    expect(draft.value).toBe("Keep my source draft")
    expect(scroller.scrollTop).toBe(1370)
    expect(document.activeElement).toBe(opener)
    go.mockRestore()
    vi.restoreAllMocks()
  })

  it("replaces a directly visited Captain and safely closes to the chat with composer focus", () => {
    render("/?captain=prj_demo01")
    const captainComposer = document.querySelector('[role="dialog"] textarea')!
    click(document.querySelector('[role="dialog"] a[href="/?session=task_app002"]')!)
    expect(captainComposer.isConnected).toBe(false)
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    click(document.querySelector('[role="dialog"] button[aria-label="Back"]')!)
    expect(location.pathname + location.search).toBe("/")
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(document.querySelector('[data-testid="chat-footer"] textarea'))
  })

  it("uses one slot when switching between questions and conversation links", async () => {
    const qc = render()
    const id = "thr_app001"
    await act(async () => {
      qc.setQueryData(threadKeys.list(COORDINATOR_CHAT), [{ id, projectId: null, anchorId: "msg_1", kind: "ask", quote: "Question source", busy: false, replies: 1, unread: false, resolvedAt: null, createdAt: now, updatedAt: now }])
      qc.setQueryData(threadKeys.messages(id), [{ id: "thm_app001", threadId: id, role: "assistant", content: "[Read task](/tasks/task_app001)", createdAt: now }])
      openThread(COORDINATOR_CHAT, id)
      await new Promise((r) => setTimeout(r, 20))
    })
    const panel = document.querySelector('[data-testid="side-thread"]')!
    click(panel.querySelector('a[href="/?session=task_app001"]')!)
    expect(document.querySelectorAll('[data-testid="side-thread"]')).toHaveLength(1)
    expect(document.querySelector('[data-testid="side-thread"]')).toBe(panel)
    expect(panel.querySelector('[data-testid="task-header"]')).not.toBeNull()
    await act(async () => {
      openThread(COORDINATOR_CHAT, id)
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(location.search).toBe("")
    expect(document.querySelectorAll('[data-testid="side-thread"]')).toHaveLength(1)
    expect(panel.querySelector('[role="dialog"]')).toBeNull()
    expect(panel.textContent).toContain("Question source")
  })

  it("replaces a task with schedule detail and history; browser Back restores the task", async () => {
    const qc = render(taskSessionHref("task_app001"))
    await act(async () => {
      qc.setQueryData(keys.schedules, [{ id: "sch_abc123", name: "Daily check", target: "project", projectId: "prj_demo01", cron: "0 9 * * *", timezone: "UTC", enabled: true, prompt: "Check builds", runCount: 0 }] as Schedule[])
      await new Promise((r) => setTimeout(r, 20))
    })
    const source = document.querySelector('[role="dialog"]')!
    click(source.querySelector('a[href="/?schedule=sch_abc123"]')!)
    const schedule = [...document.querySelectorAll('[role="dialog"]')].at(-1)!
    expect(schedule.textContent).toContain("Daily check")
    expect(schedule.textContent).toContain("Check builds")
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(document.querySelector('[data-testid="task-header"]')).toBeNull()
    act(() => history.back())
    await act(async () => new Promise((r) => setTimeout(r, 20)))
    expect(document.querySelector('[role="dialog"]')).toBe(source)
    expect(document.querySelector('[data-testid="task-header"]')).not.toBeNull()
    expect(location.search).toBe("?session=task_app001")
  })

  it("keeps only the topmost sheet responsive to Esc, including a file preview over a linked task", async () => {
    render()
    click(link(taskSessionHref("task_app001")))
    const task = document.querySelector('[role="dialog"]')!
    click(task.querySelector('a[href="/artifacts/art_report01/report.md"]')!)
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2)
    esc()
    await act(async () => new Promise((r) => setTimeout(r, 20)))
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(document.querySelector('[role="dialog"]')).toBe(task)
    expect(location.search).toBe("?session=task_app001")
    esc()
    await act(async () => new Promise((r) => setTimeout(r, 20)))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it("a task link opens the shared side panel with a reply composer and paged transcript; Esc returns to the chat", async () => {
    render()
    const arrow = chat().querySelector('a[href="/?session=task_app001"]')!
    click(arrow)
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).not.toContain("Full task transcript")
    // Its own header, with ⓘ (Stop lives in there) and no Stop beside the state.
    expect(dialog.querySelector('button[aria-label="Task details and more actions"]')).not.toBeNull()
    expect(dialog.querySelector('button[aria-label="Stop task"]')).toBeNull()
    expect(dialog.querySelector('[data-testid="task-meta"]')).not.toBeNull()
    expect(dialog.textContent).toContain("Transcript message 99")
    // The task is working, so the reply queues for after its turn.
    expect(dialog.querySelector('textarea[aria-label="Message this task"]')?.getAttribute("placeholder")).toBe("Queue a message…")
    expect(dialog.textContent).not.toContain("The first transcript message")
    const earlier = [...dialog.querySelectorAll("button")].find((b) => b.textContent?.includes("earlier message"))!
    click(earlier)
    expect(dialog.textContent).toContain("The first transcript message")
    esc()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(location.pathname).toBe(APP_HOME)
    esc()
    expect(location.pathname).toBe(APP_HOME)
  })

  it("goes back to the chat from a Back button at the panel's top left, with no × and no footer button", () => {
    render(taskSessionHref("task_app001"))
    const dialog = document.querySelector('[role="dialog"]')!
    const header = dialog.querySelector('[data-testid="task-header"]')!
    const back = header.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!
    // First in the header, before the title: the top left.
    expect(header.querySelector("button")).toBe(back)
    expect(back.compareDocumentPosition(header.querySelector("h2")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(dialog.querySelector('button[aria-label="Close"]')).toBeNull()
    expect([...dialog.querySelectorAll("button")].some((b) => b.textContent === "Back to card")).toBe(false)
    expect(dialog.getAttribute("aria-label")).toBe(TASKS.find((t) => t.id === "task_app001")!.title)
    click(back)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(location.pathname).toBe(APP_HOME)
    expect(location.search).not.toContain("session")
  })

  it("sends a follow-up from the full conversation to that task's session", async () => {
    render(taskSessionHref("task_app001"))
    const dialog = document.querySelector('[role="dialog"]')!
    const draft = dialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message this task"][placeholder="Queue a message…"]')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
    await act(async () => {
      setValue.call(draft, "Please check the preview again")
      draft.dispatchEvent(new Event("input", { bubbles: true }))
    })
    const send = dialog.querySelector<HTMLButtonElement>('button[aria-label="Queue message"]')!
    expect(send.disabled).toBe(false)
    await act(async () => { click(send); await new Promise((r) => setTimeout(r, 0)) })
    const request = vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/tasks/task_app001/messages")
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      id: expect.stringMatching(/^chat_[a-f0-9]{12}$/), content: "Please check the preview again", attachments: [],
    })
  })

  it("keeps an idle task's popup title and status muted with Mark done still available", async () => {
    const qc = render(taskSessionHref("task_app001"))
    await act(async () => {
      qc.setQueryData(keys.tasks, TASKS.map((t) => ({ ...t, status: "idle" })))
      await new Promise((r) => setTimeout(r, 20))
    })
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.querySelector("h2")!.classList.contains("text-zinc-400")).toBe(true)
    // Its icon (the header's status) goes neutral with the title.
    expect(dialog.querySelector<HTMLElement>('[data-testid="task-status-icon"][data-status="idle"]')!.style.getPropertyValue("--pc")).toBe("#a1a1aa")
    click(dialog.querySelector('button[aria-label="Task details and more actions"]')!)
    expect([...document.querySelectorAll('[role="dialog"]')].find((d) => d.textContent?.includes("Task details"))?.textContent).toContain("Mark done")
  })

  it("consumes link picks so opening Settings cannot restore an earlier project filter", () => {
    render(projectChatHref("prj_demo01"))
    expect(chatProjectFilter()).toBe("prj_demo01")
    expect(location.search).toBe("")
    act(() => setChatProjectFilter(null))
    click(document.querySelector('button[aria-label="Settings"]')!)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(chatProjectFilter()).toBeNull()
  })

  it("keeps queued tasks' limit controls reachable in the transcript", async () => {
    const qc = render(taskSessionHref("task_app001"))
    await act(async () => {
      qc.setQueryData(keys.tasks, TASKS.map((t) => t.id === "task_app001" ? { ...t, status: "queued", waitReason: "Waiting for the cloud limit", waitFix: "cloud-settings" } : t))
      await new Promise((r) => setTimeout(r, 20))
    })
    const fix = document.querySelector('[data-testid="wait-fix"]')!
    expect(fix.textContent).toBe("Cloud limits")
    click(fix)
    expect(location.search).toContain("settings=costs")
    expect(location.pathname).toBe(APP_HOME)
  })

  it("closing Settings preserves the Captain selected in the project bar", () => {
    render(projectChatHref("prj_demo01"))
    click(document.querySelector('button[aria-label="Settings"]')!)
    esc()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(chatProjectFilter()).toBe("prj_demo01")
    expect(location.pathname).toBe(APP_HOME)
  })

  it("project settings with a clean draft closes on Esc at once; a dirty one asks first", async () => {
    render("/?projectSettings=prj_demo01")
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    // Synchronous act: no awaited confirm stands between Esc and the URL update.
    esc()
    expect(location.search).not.toContain("projectSettings")
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    render("/?projectSettings=prj_demo01")
    const name = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    act(() => { setValue.call(name, "Updated name"); name.dispatchEvent(new Event("input", { bubbles: true })) })
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })) })
    expect(location.search).toContain("projectSettings=prj_demo01")
    expect(currentConfirm()?.title).toBe("Discard unsaved changes?")
    await act(async () => settleConfirm(currentConfirm()!.id, false))
  })

  it("project configuration stays reachable in Settings without opening the project page", () => {
    render("/?settings=projects")
    // Settings' Projects list: a row per project opens its settings.
    const configure = document.querySelector('[data-testid="project-settings-list"] button[title="box-yard settings"]')!
    click(configure)
    expect(location.pathname).toBe(APP_HOME)
    expect(location.search).toContain("projectSettings=prj_demo01")
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2)
    const project = [...document.querySelectorAll('[role="dialog"]')].at(-1)!
    expect(project.textContent).toContain("box-yard settings")
    expect(project.textContent).toContain("Env vars")
    expect(project.querySelector('[data-testid="project-identity"]')).not.toBeNull()
    expect(project.querySelector<HTMLButtonElement>('[data-testid="project-settings-save"]')?.disabled).toBe(true)
    const name = project.querySelector<HTMLInputElement>("input")!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    act(() => { setValue.call(name, "Updated name"); name.dispatchEvent(new Event("input", { bubbles: true })) })
    expect(project.querySelector<HTMLButtonElement>('[data-testid="project-settings-save"]')?.disabled).toBe(false)
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false)
    act(() => { setValue.call(name, "box-yard"); name.dispatchEvent(new Event("input", { bubbles: true })) })
    expect(document.querySelector('[data-testid="project-tabs"]')).toBeNull()
    esc()
    expect(location.search).toBe("?settings=projects")
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  })

  it("Back to a retired URL is guarded again", async () => {
    render()
    history.pushState(null, "", "/usage")
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")))
    expect(location.pathname).toBe(APP_HOME)
    expect(document.querySelector("nav:not([aria-label='Projects and tasks']):not([aria-label^='Chat days']), aside")).toBeNull()
    act(() => navigateApp("/schedules"))
    expect(location.pathname).toBe(APP_HOME)
  })
})
