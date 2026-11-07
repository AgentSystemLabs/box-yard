// @vitest-environment happy-dom
import { afterPaint } from "../web/src/lib/afterPaint.js"
// The centre chat as tasks open. On a desktop it never follows a task: a task opening from any entry point (the
// sidebar, the palette, a link or notice in the chat, Back/Forward, a deep link) shows on its own and an unpinned chat
// hides, as it was, until the task closes or a chat is picked (test/pins.test.ts has the pins). On a phone a task
// panel covers the chat, and with a Captain in the centre a task brings its own project's Captain; another project's
// Captain closes the task. The Coordinator keeps whatever task opens beside it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { navigate } from "wouter/use-browser-location"
import { App } from "../web/src/App.js"
import { openPalette } from "../web/src/components/CommandPalette.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { keys } from "../web/src/lib/queries.js"
import { chatProjectFilter, setChatProjectFilter } from "../web/src/lib/projectBar.js"
import { COORDINATOR_CHAT, closeThread, openThread, threadKeys } from "../web/src/lib/threads.js"
import { closeSidebarDrawer, setSidebarCollapsed } from "../web/src/lib/sidebar.js"
import { centreCaptain } from "../web/src/lib/centreCaptain.js"
import { taskSessionHref, APP_HOME } from "../web/src/lib/navigation.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import { resetScrollMemory } from "../web/src/lib/scrollMemory.js"
import type { CaptainMessage, ChatMessage, Project, Task, TaskStatus } from "../shared/types"
import { sidebarGroup } from "./sidebarTree.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const project = (id: string, name: string) => ({ id, name, repo: null, description: "", notes: [], envKeys: [], baseBranch: "main", runner: "box", identityId: "idn_default", gpuMachine: { gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null }, docker: { image: null, dockerfile: null }, createdAt: now, color: null }) as unknown as Project
const task = (id: string, projectId: string, title: string, status: TaskStatus) =>
  ({ id, projectId, title, status, prompt: "Do it.", boxId: null, sessionId: "s", branch: null, prUrl: null, prState: null, prMergedAt: null, previews: [], waitFor: [], question: null, summary: null, error: null, waitReason: null, turnCount: 1, pendingCount: 0, scheduleId: null, outcome: null, contextTokens: null, contextWindow: null, model: null, effort: null, createdAt: now - 60_000, updatedAt: now - 60_000 }) as unknown as Task

const YARD = project("prj_yard01", "box-yard")
const SITE = project("prj_site01", "marketing-site")
const BUILD = task("task_yard01", YARD.id, "Fix the build", "working")
const DOCS = task("task_yard02", YARD.id, "Write the docs", "working")
const PORTFOLIO = task("task_site01", SITE.id, "Refresh the portfolio", "working")
// Asks Cody, so it's in Waiting on you as well as under marketing-site (added only where a test needs it).
const HERO = task("task_site02", SITE.id, "Pick the hero image", "needs_input")
const captainMessage = (id: string, content: string, meta: Record<string, unknown> | null = null, role: CaptainMessage["role"] = "assistant"): CaptainMessage => ({ id, projectId: YARD.id, role, content, meta, createdAt: now - 1000 })
// box-yard's Captain mentions the other project's task twice: in a reply, and in a task notice about it.
const YARD_CHAT = [
  captainMessage("cm_reply1", "See [the portfolio](/tasks/task_site01) on the other project."),
  captainMessage("cm_note01", "✅ **Refresh the portfolio** is done: ready for review", { taskId: PORTFOLIO.id }, "notice"),
]
const COORDINATOR: ChatMessage[] = [{ id: "msg_1", role: "assistant", content: "The [portfolio](/tasks/task_site01) is moving.", meta: null, createdAt: now - 1000 }]

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

const viewport = (width: number, height = 900) => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height })

function render(path = APP_HOME) {
  history.replaceState(null, "", path)
  resetScrollMemory()
  sessionStorage.setItem("box-yard:landed", "1")
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.agentSettings, { settings: { ...DEFAULT_SETTINGS, ownerName: "Cody" }, sources: {}, defaults: DEFAULT_SETTINGS })
  qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.orchestrator, { busy: false, usage: { tokens: 1000, window: 1_000_000, updatedAt: now }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null })
  qc.setQueryData(keys.chat, COORDINATOR)
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, [BUILD, DOCS, PORTFOLIO])
  qc.setQueryData(keys.projects, [YARD, SITE])
  for (const p of [YARD, SITE]) {
    qc.setQueryData(keys.captain(p.id), { projectId: p.id, busy: false, usage: { tokens: 0, window: 1_000_000, updatedAt: now }, compacting: false, compactQueued: false, error: null })
    qc.setQueryData(keys.captainMessages(p.id), p === YARD ? YARD_CHAT : [])
  }
  for (const t of [BUILD, DOCS, PORTFOLIO]) qc.setQueryData(keys.taskMessages(t.id), [{ id: `tm_${t.id}`, role: "assistant", content: `${t.title} transcript.`, meta: null, createdAt: now }])
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications, keys.scheduleRuns]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
  return qc
}

const nav = () => document.querySelector<HTMLElement>("nav[aria-label='Projects and tasks']")!
const section = (name: string) => sidebarGroup(nav(), name)!
const button = (within: ParentNode, name: string) => [...within.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.startsWith(name) || b.getAttribute("aria-label") === name)!
/** The links stop propagation, so read `defaultPrevented` off the event; a click the app leaves alone goes nowhere. */
const click = (el: Element) => {
  const at = location.pathname + location.search
  const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
  act(() => void el.dispatchEvent(e))
  if (!e.defaultPrevented && el instanceof HTMLAnchorElement) history.replaceState(history.state, "", at)
}
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
/** The centre chat's title: "box-yard Captain", or the Coordinator's. */
// The chat on screen: the centre keeps the chats left last beside it, hidden (lib/keptChats.ts).
const centre = () => [...document.querySelectorAll("[data-testid=chat-title]")].find((t) => t.checkVisibility())!.textContent
/** The task the side panel shows, by its URL. */
const shownTask = () => new URLSearchParams(location.search).get("session")
/** The sidebar's one selected row: the task in the panel when one is open, else the centre's chat. */
const marked = () => nav().querySelector("[aria-current=page]")?.textContent
/** The chat the sidebar marks as still open in the centre, behind the panel. */
const behind = () => [...nav().querySelectorAll("button")].find((b) => b.textContent?.endsWith(", open behind the panel"))?.textContent
/** The task view in the panel, by its title. */
const panelTitle = () => document.querySelector("[data-testid=task-header]")?.textContent ?? ""

const pickCaptain = (p: Project) => click(button(section(p.name), `${p.name}, Captain`))

/** box-yard's Captain in the centre with its own task beside it: the state every switch starts from. */
function startOnYardTask() {
  render()
  pickCaptain(YARD)
  click(button(section(YARD.name), BUILD.title))
  expect(centre()).toBe("box-yard Captain")
  expect(shownTask()).toBe(BUILD.id)
}

/** marketing-site's Captain in the centre, its task in the panel, and the sidebar agreeing. */
function expectSiteCaptainWithPortfolio() {
  expect(shownTask()).toBe(PORTFOLIO.id)
  expect(centre()).toBe("marketing-site Captain")
  expect(chatProjectFilter()).toBe(SITE.id)
  expect(marked()).toMatch(/^Refresh the portfolio/)
  expect(behind()).toMatch(/^marketing-site, Captain/)
  expect(panelTitle()).toContain(PORTFOLIO.title)
  expect(document.querySelector("[data-testid=captain-chat][data-centre]")!.textContent).not.toContain("See the portfolio")
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  // Wide: the sidebar is a column beside the chat and the panel.
  viewport(1440)
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
  vi.stubGlobal("EventSource", FakeEventSource)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  act(() => root.unmount())
  // Let deferred chat queries start while fetch is still mocked, before restoring the environment.
  await act(async () => { await afterPaint() })
  host.remove()
  document.body.innerHTML = ""
  for (const t of currentToasts()) dismiss(t.id)
  act(() => {
    setChatProjectFilter(null)
    setSidebarCollapsed(false)
    closeSidebarDrawer()
    for (const chat of [COORDINATOR_CHAT, YARD.id, SITE.id]) closeThread(chat)
  })
  viewport(1024, 768)
  vi.unstubAllGlobals()
})

describe("centreCaptain", () => {
  it("is the picked Captain, or the open task's when a Captain is picked; the Coordinator stays", () => {
    expect(centreCaptain(YARD.id, SITE.id)).toBe(SITE.id)
    expect(centreCaptain(YARD.id, YARD.id)).toBe(YARD.id)
    expect(centreCaptain(YARD.id, null)).toBe(YARD.id)
    expect(centreCaptain(null, SITE.id)).toBeNull()
    expect(centreCaptain(null, null)).toBeNull()
  })
})

describe("On a desktop the chat never follows a task: an unpinned one hides as the task opens, as it was", () => {
  /** The chat hidden: the panels cover it, and the rightmost fills the room. */
  const chatHidden = () => document.querySelector<HTMLElement>("[data-testid=columns]")?.dataset.chat === "closed"

  it("a task row from another project in the sidebar shows just the task, and closing it shows the same Captain again", () => {
    startOnYardTask()
    expect(chatHidden()).toBe(true)
    click(button(section(SITE.name), PORTFOLIO.title))
    expect(shownTask()).toBe(PORTFOLIO.id)
    expect(chatHidden()).toBe(true)
    expect(chatProjectFilter()).toBe(YARD.id)
    expect(marked()).toMatch(/^Refresh the portfolio/)
    expect(behind()).toBeUndefined()
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))
    expect(shownTask()).toBeNull()
    expect(centre()).toBe("box-yard Captain")
    expect(marked()).toMatch(/^box-yard, Captain/)
  })

  it("a task picked in the palette shows just the task", () => {
    startOnYardTask()
    act(() => openPalette())
    const input = document.querySelector<HTMLInputElement>("input[role=combobox]")!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "portfolio")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    act(() => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })))
    expect(shownTask()).toBe(PORTFOLIO.id)
    expect(new URLSearchParams(location.search).get("stack")).toBeNull()
    expect(chatHidden()).toBe(true)
  })

  it("a link to another project's task in the Captain's chat, or a notice's title, shows just the task", () => {
    render()
    pickCaptain(YARD)
    const chat = document.querySelector("[data-testid=captain-chat][data-centre]")!
    click([...chat.querySelectorAll(`a[href="${taskSessionHref(PORTFOLIO.id)}"]`)].find((a) => a.textContent === "the portfolio")!)
    expect(shownTask()).toBe(PORTFOLIO.id)
    expect(chatHidden()).toBe(true)
    expect(chatProjectFilter()).toBe(YARD.id)
    act(() => history.back())
    expect(shownTask()).toBeNull()
    expect(centre()).toBe("box-yard Captain")
    click(document.querySelector("#captain-cm_note01 [data-testid=notice-title] a")!)
    expect(shownTask()).toBe(PORTFOLIO.id)
    expect(chatHidden()).toBe(true)
  })

  it("Back and Forward show each entry as it was: the chat, and whether it was hidden", async () => {
    startOnYardTask()
    click(button(section(SITE.name), PORTFOLIO.title))
    act(() => history.back())
    await settle()
    expect(shownTask()).toBe(BUILD.id)
    expect(chatHidden()).toBe(true)
    act(() => history.back())
    await settle()
    expect(shownTask()).toBeNull()
    expect(centre()).toBe("box-yard Captain")
    act(() => history.forward())
    await settle()
    expect(shownTask()).toBe(BUILD.id)
    expect(chatHidden()).toBe(true)
  })

  it("a deep link to a task, old-style or current, shows just the task", () => {
    startOnYardTask()
    act(() => navigate(`/tasks/${PORTFOLIO.id}`))
    expect(location.pathname).toBe(APP_HOME)
    expect(shownTask()).toBe(PORTFOLIO.id)
    expect(chatHidden()).toBe(true)
    act(() => root.unmount())
    root = createRoot(host)
    act(() => setChatProjectFilter(YARD.id))
    render(taskSessionHref(PORTFOLIO.id))
    expect(shownTask()).toBe(PORTFOLIO.id)
    expect(chatHidden()).toBe(true)
  })

  it("a project row's name shows just its Captain: the task closes, its own project's too", async () => {
    const qc = render()
    act(() => void qc.setQueryData(keys.tasks, [BUILD, DOCS, PORTFOLIO, HERO]))
    await settle()
    click(button(section("Waiting on you"), HERO.title))
    expect(shownTask()).toBe(HERO.id)
    pickCaptain(SITE)
    expect(shownTask()).toBeNull()
    expect(centre()).toBe("marketing-site Captain")
    expect(marked()).toMatch(/^marketing-site, Captain/)
    click(button(section("Waiting on you"), HERO.title))
    const selected = nav().querySelectorAll("[aria-current=page]")
    expect(selected).toHaveLength(1)
    expect(section("Waiting on you").contains(selected[0])).toBe(true)
    pickCaptain(YARD)
    expect(shownTask()).toBeNull()
    expect(centre()).toBe("box-yard Captain")
  })

  it("the chat switcher changes the chat in place: a task beside a pinned chat stays", () => {
    render()
    click(button(section(SITE.name), PORTFOLIO.title))
    expect(chatHidden()).toBe(true)
    act(() => setChatProjectFilter(YARD.id))
    expect(shownTask()).toBe(PORTFOLIO.id)
    expect(chatHidden()).toBe(true)
  })

  it("opening a task closes a side question left open in its Captain's chat, instead of the question closing the task", async () => {
    const qc = render()
    const id = "thr_yard01"
    await act(async () => {
      qc.setQueryData(threadKeys.list(YARD.id), [{ id, projectId: YARD.id, anchorId: "cm_x", kind: "ask", quote: "An old question", busy: false, replies: 0, unread: false, resolvedAt: null, createdAt: now, updatedAt: now }])
      qc.setQueryData(threadKeys.messages(id), [])
      openThread(YARD.id, id)
    })
    pickCaptain(YARD)
    click(button(section(YARD.name), BUILD.title))
    await settle()
    expect(shownTask()).toBe(BUILD.id)
    expect(panelTitle()).toContain(BUILD.title)
    // A question opening afterwards still takes the slot back.
    await act(async () => {
      openThread(YARD.id, id)
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(shownTask()).toBeNull()
  })
})

describe("On a phone the Captain follows the open task's project", () => {
  beforeEach(() => viewport(400))

  it("a link to another project's task in the Captain's chat brings that project's Captain, and Back the first one", async () => {
    render()
    act(() => setChatProjectFilter(YARD.id))
    await settle()
    const chat = document.querySelector("[data-testid=captain-chat][data-centre]")!
    click([...chat.querySelectorAll(`a[href="${taskSessionHref(PORTFOLIO.id)}"]`)].find((a) => a.textContent === "the portfolio")!)
    await settle()
    expect(shownTask()).toBe(PORTFOLIO.id)
    expect(chatProjectFilter()).toBe(SITE.id)
    act(() => history.back())
    await settle()
    expect(shownTask()).toBeNull()
  })

  it("a deep link to another project's task brings its Captain from the first frame", () => {
    act(() => setChatProjectFilter(YARD.id))
    render(taskSessionHref(PORTFOLIO.id))
    expect(shownTask()).toBe(PORTFOLIO.id)
    expect(chatProjectFilter()).toBe(SITE.id)
  })

  it("the Coordinator stays whichever project's task opens", () => {
    render()
    click(document.querySelector(`[data-testid=chat-panel] a[href="${taskSessionHref(PORTFOLIO.id)}"]`)!)
    expect(shownTask()).toBe(PORTFOLIO.id)
    expect(chatProjectFilter()).toBeNull()
  })

  it("another project's Captain picked outside the sidebar closes the task; its own and the Coordinator keep it", () => {
    render(taskSessionHref(PORTFOLIO.id))
    act(() => setChatProjectFilter(SITE.id))
    expect(shownTask()).toBe(PORTFOLIO.id)
    act(() => setChatProjectFilter(null))
    expect(shownTask()).toBe(PORTFOLIO.id)
    act(() => setChatProjectFilter(YARD.id))
    expect(shownTask()).toBeNull()
  })
})
