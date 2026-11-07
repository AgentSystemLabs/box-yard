// @vitest-environment happy-dom
// The columns on a desktop (lib/columns.ts, ColumnControls.tsx, Rails.tsx): clicking anything (the sidebar,
// search, a link, a crumb, a strip) shows just it and whatever is pinned; the unpinned panels close, and the chat hides
// unless it's pinned or it's what was clicked. Anything can be pinned, with no limit, and what shows is laid out in the
// tree's order. Every header has Pin, and Close while another column is in view. With the sidebar folded, the levels
// above the item opened are strips listing the level below. A sub-task opens alone; its crumbs lead up the tree, or Back
// to the parent it was opened from. In memory only. A phone keeps its own way.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { warmLazyParts } from "../web/src/components/LazyPart.js"
import { FOCUS_MAX, SHEET_HIDDEN } from "../web/src/components/OverlayHost.js"
import { CHAT_BAR, RAIL_COLUMN, SUBTASK_BAR } from "../web/src/components/Rails.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { keys } from "../web/src/lib/queries.js"
import { resetPanelWidths } from "../web/src/lib/panelWidths.js"
import { resetScrollMemory } from "../web/src/lib/scrollMemory.js"
import { chatProjectFilter, setChatProjectFilter } from "../web/src/lib/projectBar.js"
import { arrangement, chatRef, columnLayout, COORDINATOR_REF, hierarchyStrips, orderRefs, resetColumns, type ColumnsState } from "../web/src/lib/columns.js"
import { setSidebarCollapsed } from "../web/src/lib/sidebar.js"
import { navigateApp, openChat, taskSessionHref } from "../web/src/lib/navigation.js"
import type { Project, Task, TaskStatus } from "../shared/types"
import { sidebarGroup } from "./sidebarTree.js"

beforeAll(() => warmLazyParts())

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const project = (id: string, name: string) =>
  ({ id, name, repo: null, description: "", notes: [], envKeys: [], baseBranch: "main", runner: "box", identityId: "idn_default", gpuMachine: { gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null }, docker: { image: null, dockerfile: null }, createdAt: now, color: null }) as unknown as Project
const YARD = project("prj_yard01", "box-yard")
const COOK = project("prj_cook001", "recipes")
let made = 0
const task = (id: string, title: string, status: TaskStatus, parent?: Task, home: Project = YARD) =>
  ({
    id,
    projectId: home.id,
    title,
    status,
    prompt: "",
    prUrl: null,
    prState: null,
    prMergedAt: null,
    previews: [],
    waitFor: [],
    question: null,
    error: null,
    scheduleId: null,
    outcome: null,
    turnCount: 1,
    pendingCount: 0,
    parentTaskId: parent?.id ?? null,
    rootTaskId: parent ? parent.rootTaskId ?? parent.id : null,
    subtaskDepth: parent ? (parent.subtaskDepth ?? 0) + 1 : 0,
    createdAt: now - 600_000 + ++made * 1000,
    updatedAt: now - 60_000,
  }) as unknown as Task

const LOGO = task("task_logo01", "Box Yard logo exploration", "working")
const DESIGNER = task("task_desig1", "Logo designer 1/3", "working", LOGO)
const DESIGNER2 = task("task_desig2", "Logo designer 2/3", "needs_input", LOGO)
const DESIGNER3 = task("task_desig3", "Logo designer 3/3", "done", LOGO)
const RATER = task("task_rater1", "Rate the single-line marks", "working", DESIGNER)
const DOCS = task("task_docs01", "Write the pin docs", "pr_ready")
const MEAL = task("task_meal01", "Plan this week's meals", "working", undefined, COOK)
const TASKS = [LOGO, DESIGNER, DESIGNER2, DESIGNER3, RATER, DOCS, MEAL]
const YARD_CAPTAIN = chatRef(YARD.id)
/** The URL with these tasks open in panels, left to right. */
const opened = (...open: Task[]) => `/?session=${open[0]!.id}${open.length > 1 ? `&stack=${open.slice(1).map((t) => t.id).join(",")}` : ""}`

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
/** The window's width, for the sidebar's media queries. */
let viewport = 1600

/** The logo task's transcript links to its first designer, as a parent's report on its sub-tasks does. */
const notes = (t: Task) => (t.id === LOGO.id ? `Notes on ${t.title}. See [the first designer](${taskSessionHref(DESIGNER.id)}).` : `Notes on ${t.title}`)

/** The app's query client, as rendered last: a test can bring a task into the list after the page opened it. */
let qc: QueryClient

function render(path: string) {
  history.replaceState(null, "", path)
  resetScrollMemory()
  sessionStorage.setItem("box-yard:landed", "1")
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.agentSettings, { settings: DEFAULT_SETTINGS, sources: {}, defaults: DEFAULT_SETTINGS })
  qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.chat, [])
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, TASKS)
  qc.setQueryData(keys.projects, [YARD, COOK])
  for (const p of [YARD, COOK]) qc.setQueryData(keys.captainMessages(p.id), [])
  for (const t of TASKS) qc.setQueryData(keys.taskMessages(t.id), [{ id: `tm_${t.id}`, role: "assistant", content: notes(t), meta: null, createdAt: now }])
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications, keys.scheduleRuns]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
const strip = () => document.querySelector<HTMLElement>("[data-testid=columns]")
/** The chat: "open", or "closed" with the panels taking its room; "open" too with no panels. */
const chat = () => strip()?.dataset.chat ?? "open"
const aside = () => document.querySelector<HTMLElement>("[data-testid=side-thread]")
const columns = () => [...document.querySelectorAll<HTMLElement>("[data-testid=column]")]
const column = (ref: string) => document.querySelector<HTMLElement>(`[data-testid=column][data-panel="${ref}"]`)!
const rails = () => [...document.querySelectorAll<HTMLElement>("[data-testid=rail]")]
/** The strips for the levels above the item opened (not the sub-task bar), by their level's ref. */
const levels = () => rails().filter((r) => !r.dataset.bar).map((r) => r.dataset.column)
const levelStrip = (ref: string) => rails().find((r) => !r.dataset.bar && r.dataset.column === ref)!
/** The bar of a Captain's chat showing, with the sidebar folded: beside the chat, not among the panels. */
const chatBar = () => rails().find((r) => r.dataset.bar && !r.closest("[data-centre-chat]")) ?? null
const folds = () => columns().map((c) => c.dataset.fold ?? "open")
const railItems = (rail: HTMLElement) => [...rail.querySelectorAll<HTMLButtonElement>("button[data-task]")]
const click = (el: Element) => act(() => void (el as HTMLElement).click())
const esc = () => act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))
const params = () => new URLSearchParams(location.search)
const nav = () => document.querySelector<HTMLElement>("nav[aria-label='Projects and tasks']")!
const sidebar = () => document.querySelector<HTMLElement>("[data-testid=sidebar]")
const go = (href: string) => act(() => navigateApp(href))
const pick = (projectId: string | null) => act(() => openChat(projectId))
/** A project's row in the sidebar: its Captain. */
const captainRow = (p: Project) => [...(sidebarGroup(nav(), p.name)?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent?.startsWith(`${p.name}, Captain`) || b.getAttribute("aria-label") === `${p.name}, Captain`)!
/** A task's row in the sidebar, as a click on it. */
const row = (t: Task) => click(nav().querySelector(`[data-open-task="${t.id}"]`)!)
/** Not inside a chat kept hidden beside the one shown (React's Activity hides it with display: none). */
const shown = (el: Element) => !el.parentElement?.closest<HTMLElement>("[style*='display: none']")
/** The centre chat's title. */
const centre = () => [...document.querySelectorAll("[data-testid=chat-title]")].find(shown)?.textContent
/** The chat's controls, in the header of the chat shown. */
const chatControls = () => [...document.querySelectorAll<HTMLElement>("[data-testid=column-controls]")].filter((c) => !c.closest("[data-testid=columns]")).find(shown)!
/** The controls of the panel showing `ref`, in its header. */
const panelControls = (ref: string) => column(ref).querySelector<HTMLElement>("[data-testid=column-controls]")!
const pinOf = (controls: HTMLElement) => controls.querySelector<HTMLButtonElement>("[data-testid=column-pin]")!
const closeOf = (controls: HTMLElement) => controls.querySelector<HTMLButtonElement>("[data-testid=column-close]")
const buttons = (controls: HTMLElement) => [...controls.querySelectorAll("button")].map((b) => b.dataset.testid)
const panelIds = () => [params().get("session") ?? (params().get("captain") ? chatRef(params().get("captain")) : null), ...(params().get("stack")?.split(",") ?? [])].filter(Boolean)
/** The crumbs in the header of the panel showing `ref`, by their labels. */
const crumbs = (ref: string) => [...column(ref).querySelectorAll<HTMLButtonElement>("[data-testid=task-crumbs] button")]
const crumb = (ref: string, label: string) => crumbs(ref).find((b) => b.getAttribute("aria-label") === label)!

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  resetPanelWidths()
  resetColumns()
  setChatProjectFilter(null)
  setSidebarCollapsed(false)
  viewport = 1600
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
  vi.stubGlobal("EventSource", FakeEventSource)
  vi.stubGlobal("matchMedia", (q: string) => {
    const min = /min-width:\s*(\d+)px/.exec(q)
    return { matches: min ? viewport >= Number(min[1]) : false, media: q, addEventListener() {}, removeEventListener() {} }
  })
  if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => {}
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  resetPanelWidths()
  resetColumns()
  setChatProjectFilter(null)
  setSidebarCollapsed(false)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Columns: every header has Pin, and Close beside another column", () => {
  it("a panel's controls: Pin alone, Pin and Close beside another column; 44px with labels, one set in its header, only beside the chat", async () => {
    render("/")
    await settle()
    await go(taskSessionHref(LOGO.id))
    await settle()
    // Alone in view (the unpinned chat hid), pinned or not: Pin only. Closing it would leave nothing to take its room.
    expect(chat()).toBe("closed")
    expect(buttons(panelControls(LOGO.id))).toEqual(["column-pin"])
    await click(pinOf(panelControls(LOGO.id)))
    expect(buttons(panelControls(LOGO.id))).toEqual(["column-pin"])
    // Beside another panel each has Close, pinned or not.
    await go(taskSessionHref(DOCS.id))
    await settle()
    expect(panelIds()).toEqual([LOGO.id, DOCS.id])
    expect(buttons(panelControls(DOCS.id))).toEqual(["column-pin", "column-close"])
    const panel = panelControls(LOGO.id)
    expect(buttons(panel)).toEqual(["column-pin", "column-close"])
    expect([...panel.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual([`Pin ${LOGO.title}`, `Close ${LOGO.title}`])
    for (const b of panel.querySelectorAll("button")) expect(b.className).toContain("h-11 w-11")
    expect(column(LOGO.id).querySelectorAll("[data-testid=column-controls]")).toHaveLength(1)
    expect(panel.closest("[data-testid=task-header]")).not.toBeNull()
    // No Collapse and no Focus anywhere: a column only shows or hides.
    expect(document.querySelector("[data-testid=column-collapse]")).toBeNull()
    // A sheet over the chat (a phone, a narrow window) shows one panel at a time: no controls, its Back is the way out.
    expect(panel.className.split(" ")).toEqual(expect.arrayContaining(["hidden", "@min-[35.5rem]/coord:flex"]))
  })

  it("beside a pinned Captain, the task opened has Pin and Close, pinned or not: pinning never moves Pin", async () => {
    render("/")
    await settle()
    await pick(YARD.id)
    await settle()
    await click(pinOf(chatControls()))
    await row(DOCS)
    await settle()
    expect(chat()).toBe("open")
    expect(buttons(panelControls(DOCS.id))).toEqual(["column-pin", "column-close"])
    expect(buttons(chatControls())).toEqual(["column-pin", "column-close"])
    // Pinning adds nothing and moves nothing, so a second click on Pin unpins it: it never lands on a Close.
    const pin = pinOf(panelControls(DOCS.id))
    await click(pin)
    expect(pin.getAttribute("aria-pressed")).toBe("true")
    expect(buttons(panelControls(DOCS.id))).toEqual(["column-pin", "column-close"])
    expect(pinOf(panelControls(DOCS.id))).toBe(pin)
    await click(pin)
    expect(pin.getAttribute("aria-pressed")).toBe("false")
    expect(panelIds()).toEqual([DOCS.id])
    // Its Close, Esc and the Captain's crumb in its own header (as its sidebar row) each show the Captain with just the pins.
    await click(closeOf(panelControls(DOCS.id))!)
    await settle()
    expect(columns()).toHaveLength(0)
    expect(centre()).toContain("box-yard")
    await row(DOCS)
    await settle()
    await esc()
    await settle()
    expect(columns()).toHaveLength(0)
    await row(DOCS)
    await settle()
    await click(crumb(DOCS.id, "box-yard Captain"))
    await settle()
    expect(columns()).toHaveLength(0)
    expect(chat()).toBe("open")
    // Pinned, Esc leaves it where it is. The chat unpinned beside it keeps its Close too.
    await row(DOCS)
    await settle()
    await click(pinOf(panelControls(DOCS.id)))
    await esc()
    await settle()
    expect(panelIds()).toEqual([DOCS.id])
    await click(pinOf(chatControls()))
    expect(chat()).toBe("open")
    expect(buttons(chatControls())).toEqual(["column-pin", "column-close"])
    expect(buttons(panelControls(DOCS.id))).toEqual(["column-pin", "column-close"])
  })

  it("a lone chat has Pin only, named for the chat", async () => {
    render("/")
    await settle()
    expect(buttons(chatControls())).toEqual(["column-pin"])
    expect(pinOf(chatControls()).getAttribute("aria-label")).toBe("Pin the Coordinator")
    await pick(YARD.id)
    await settle()
    expect(buttons(chatControls())).toEqual(["column-pin"])
    expect(pinOf(chatControls()).getAttribute("aria-label")).toBe("Pin the box-yard Captain")
  })

  it("Pin fills its icon and presses; pressed again it's off", async () => {
    render("/")
    await settle()
    await go(taskSessionHref(LOGO.id))
    await settle()
    const pin = () => pinOf(panelControls(LOGO.id))
    expect(pin().getAttribute("aria-pressed")).toBe("false")
    expect(pin().querySelector("svg")!.getAttribute("class")).not.toContain("fill-current")
    await click(pin())
    expect(pin().getAttribute("aria-pressed")).toBe("true")
    expect(pin().querySelector("svg")!.getAttribute("class")).toContain("fill-current")
    await click(pin())
    expect(pin().getAttribute("aria-pressed")).toBe("false")
  })
})

describe("Columns, rule 1: clicking anything shows just it and the pins", () => {
  it("a task row in the sidebar: just the task, filling the room the unpinned chat left; the next replaces it", async () => {
    render("/")
    await settle()
    await row(DOCS)
    await settle()
    expect(panelIds()).toEqual([DOCS.id])
    expect(chat()).toBe("closed")
    expect(folds()).toEqual(["fill"])
    // The panel fills from its own width up, its content at a reading width in the middle; no edge to drag.
    expect(columns()[0]!.className).toContain("flex-1")
    expect(columns()[0]!.querySelector(":scope > div")!.className).toContain(FOCUS_MAX)
    expect(document.querySelector("[role=separator][aria-label^='Width of']")).toBeNull()
    // The chat stays mounted under it, out of Tab's and screen readers' reach.
    expect(aside()!.dataset.covering).toBe("true")
    expect((aside()!.previousElementSibling as HTMLElement).hasAttribute("inert")).toBe(true)
    // With the sidebar open, it stays a full column and nothing is a strip.
    expect(sidebar()!.dataset.rail).toBeUndefined()
    expect(rails()).toHaveLength(0)

    await row(LOGO)
    await settle()
    expect(panelIds()).toEqual([LOGO.id])
    expect(columns()).toHaveLength(1)
  })

  it("a Captain or the Coordinator picked becomes the chat: the unpinned panels close, the pinned ones stay", async () => {
    render(opened(LOGO, DESIGNER, DOCS))
    await settle()
    await click(pinOf(panelControls(DOCS.id)))
    await click(captainRow(YARD))
    await settle()
    expect(chatProjectFilter()).toBe(YARD.id)
    expect(chat()).toBe("open")
    expect(panelIds()).toEqual([DOCS.id])
    expect(centre()).toContain("box-yard")
    await click(pinOf(panelControls(DOCS.id)))
    await pick(null)
    await settle()
    expect(chatProjectFilter()).toBeNull()
    expect(columns()).toHaveLength(0)
    expect(centre()).toContain("Coordinator")
  })

  it("a link in a chat, a search pick, a strip: each the same way", async () => {
    setChatProjectFilter(YARD.id)
    render("/")
    await settle()
    await go(taskSessionHref(MEAL.id))
    await settle()
    expect(panelIds()).toEqual([MEAL.id])
    expect(chat()).toBe("closed")
    // The chat never follows the task to its project's Captain: it's hidden, as it was.
    expect(chatProjectFilter()).toBe(YARD.id)
    await go(`/?session=${LOGO.id}&stack=${DESIGNER.id}`)
    await settle()
    // A URL naming several panels opens its last, alone.
    expect(panelIds()).toEqual([DESIGNER.id])
  })
})

describe("Columns, rule 2: a sub-task opens alone, and its crumbs lead up", () => {
  it("from the sidebar: only the sub-task; each crumb shows its level alone, a step of its own in history", async () => {
    render("/")
    await settle()
    await go(taskSessionHref(RATER.id))
    await settle()
    expect(panelIds()).toEqual([RATER.id])
    // No Coordinator crumb on a desktop: the sidebar has it (#376).
    expect(crumbs(RATER.id).map((b) => b.getAttribute("aria-label"))).toEqual(["box-yard Captain", LOGO.title, `Up to ${DESIGNER.title}`])
    for (const b of crumbs(RATER.id)) expect(b.className).toContain("h-11")

    await click(crumb(RATER.id, `Up to ${DESIGNER.title}`))
    await settle()
    expect(panelIds()).toEqual([DESIGNER.id])
    await click(crumb(DESIGNER.id, `Up to ${LOGO.title}`))
    await settle()
    expect(panelIds()).toEqual([LOGO.id])
    await click(crumb(LOGO.id, "box-yard Captain"))
    await settle()
    expect(columns()).toHaveLength(0)
    expect(chatProjectFilter()).toBe(YARD.id)
    expect(centre()).toContain("box-yard")
    // Back retraces them.
    act(() => history.back())
    await settle()
    expect(panelIds()).toEqual([LOGO.id])
    act(() => history.back())
    await settle()
    expect(panelIds()).toEqual([DESIGNER.id])

    // Two levels up at once.
    await go(taskSessionHref(RATER.id))
    await settle()
    await click(crumb(RATER.id, LOGO.title))
    await settle()
    expect(panelIds()).toEqual([LOGO.id])
  })

  it("from a link inside its parent: the parent closes, and its crumb, like browser Back, goes back to it", async () => {
    render("/")
    await settle()
    await go(taskSessionHref(LOGO.id))
    await settle()
    const link = () => [...column(LOGO.id).querySelectorAll<HTMLAnchorElement>(`a[href="${taskSessionHref(DESIGNER.id)}"]`)].find((a) => a.textContent === "the first designer")!
    await click(link())
    await settle()
    expect(panelIds()).toEqual([DESIGNER.id])
    await click(crumb(DESIGNER.id, `Up to ${LOGO.title}`))
    await settle()
    expect(panelIds()).toEqual([LOGO.id])
    // It went Back: Forward opens the sub-task again.
    act(() => history.forward())
    await settle()
    expect(panelIds()).toEqual([DESIGNER.id])
    act(() => history.back())
    await settle()
    expect(panelIds()).toEqual([LOGO.id])
    expect(chat()).toBe("closed")
  })

  it("its parent pinned: the sub-task opens beside it", async () => {
    render("/")
    await settle()
    await go(taskSessionHref(LOGO.id))
    await settle()
    await click(pinOf(panelControls(LOGO.id)))
    await go(taskSessionHref(RATER.id))
    await settle()
    expect(panelIds()).toEqual([LOGO.id, RATER.id])
    expect(folds()).toEqual(["open", "fill"])
  })
})

describe("Columns, rules 3 and 4: pin anything, in the tree's order, with no limit", () => {
  it("a pinned Captain: each task opens beside it, another project's too, and the chat stays that Captain", async () => {
    render("/")
    await settle()
    await pick(YARD.id)
    await settle()
    await click(pinOf(chatControls()))
    expect(pinOf(chatControls()).getAttribute("aria-pressed")).toBe("true")
    await row(DOCS)
    await settle()
    expect(panelIds()).toEqual([DOCS.id])
    expect(chat()).toBe("open")
    expect(folds()).toEqual(["open"])
    await go(taskSessionHref(MEAL.id))
    await settle()
    expect(panelIds()).toEqual([MEAL.id])
    expect(chat()).toBe("open")
    expect(chatProjectFilter()).toBe(YARD.id)
    expect(pinOf(chatControls()).getAttribute("aria-pressed")).toBe("true")
  })

  it("two pinned tasks and a sub-task opened: it goes in its tree, after its pinned ancestor; then a fourth, at the end", async () => {
    render("/")
    await settle()
    await go(taskSessionHref(LOGO.id))
    await settle()
    await click(pinOf(panelControls(LOGO.id)))
    await go(taskSessionHref(DOCS.id))
    await settle()
    await click(pinOf(panelControls(DOCS.id)))
    expect(panelIds()).toEqual([LOGO.id, DOCS.id])
    await go(taskSessionHref(RATER.id))
    await settle()
    expect(panelIds()).toEqual([LOGO.id, RATER.id, DOCS.id])
    // The unpinned one gives way to the next.
    await go(taskSessionHref(DESIGNER2.id))
    await settle()
    expect(panelIds()).toEqual([LOGO.id, DESIGNER2.id, DOCS.id])
    await click(pinOf(panelControls(DESIGNER2.id)))
    await go(taskSessionHref(MEAL.id))
    await settle()
    expect(panelIds()).toEqual([LOGO.id, DESIGNER2.id, DOCS.id, MEAL.id])
    expect(columns()).toHaveLength(4)
    // They scroll sideways when they don't fit.
    expect(strip()!.className).toContain("overflow-x-auto")
    // One already open is only shown, where it is.
    await go(taskSessionHref(DOCS.id))
    await settle()
    expect(panelIds()).toEqual([LOGO.id, DESIGNER2.id, DOCS.id])
  })

  it("a parent opened beside its pinned sub-task goes before it", async () => {
    render("/")
    await settle()
    await go(taskSessionHref(RATER.id))
    await settle()
    await click(pinOf(panelControls(RATER.id)))
    await go(taskSessionHref(LOGO.id))
    await settle()
    expect(panelIds()).toEqual([LOGO.id, RATER.id])
  })

  it("a Captain opened beside a pinned task of another project is a panel after it, and can be pinned too", async () => {
    render("/")
    await settle()
    await go(taskSessionHref(MEAL.id))
    await settle()
    await click(pinOf(panelControls(MEAL.id)))
    await pick(YARD.id)
    await settle()
    expect(panelIds()).toEqual([MEAL.id, YARD_CAPTAIN])
    expect(chat()).toBe("closed")
    expect(column(YARD_CAPTAIN).dataset.view).toBe(`captain:${YARD.id}`)
    await click(pinOf(panelControls(YARD_CAPTAIN)))
    await go(taskSessionHref(DOCS.id))
    await settle()
    expect(panelIds()).toEqual([MEAL.id, YARD_CAPTAIN, DOCS.id])
  })

  it("a pinned Coordinator stays the chat, first; a Captain opens beside it as a panel", async () => {
    render("/")
    await settle()
    await click(pinOf(chatControls()))
    await go(taskSessionHref(MEAL.id))
    await settle()
    expect(chat()).toBe("open")
    expect(panelIds()).toEqual([MEAL.id])
    await pick(YARD.id)
    await settle()
    expect(chat()).toBe("open")
    expect(chatProjectFilter()).toBeNull()
    expect(panelIds()).toEqual([YARD_CAPTAIN])
  })
})

describe("Columns: close", () => {
  it("Close on a panel closes only it, and forgets its pin", async () => {
    render("/")
    await settle()
    await go(taskSessionHref(LOGO.id))
    await settle()
    await click(pinOf(panelControls(LOGO.id)))
    await go(taskSessionHref(DOCS.id))
    await settle()
    await click(pinOf(panelControls(DOCS.id)))
    await click(closeOf(panelControls(LOGO.id))!)
    await settle()
    expect(panelIds()).toEqual([DOCS.id])
    await go(taskSessionHref(LOGO.id))
    await settle()
    expect(panelIds()).toEqual([DOCS.id, LOGO.id])
    expect(pinOf(panelControls(LOGO.id)).getAttribute("aria-pressed")).toBe("false")
  })

  it("Close on the chat hides it, unpinned: the panels take the room, until the last one closes", async () => {
    render("/")
    await settle()
    await pick(YARD.id)
    await settle()
    await click(pinOf(chatControls()))
    await row(DOCS)
    await settle()
    expect(buttons(chatControls())).toEqual(["column-pin", "column-close"])
    await click(closeOf(chatControls())!)
    expect(chat()).toBe("closed")
    expect(folds()).toEqual(["fill"])
    // Alone, the task has no Close; Esc closes it.
    expect(closeOf(panelControls(DOCS.id))).toBeNull()
    await esc()
    await settle()
    expect(columns()).toHaveLength(0)
    expect(aside()).toBeNull()
    expect(centre()).toContain("box-yard")
    expect(pinOf(chatControls()).getAttribute("aria-pressed")).toBe("false")
  })
})

describe("Columns, rules 5 and 6: strips only with the sidebar folded, for the levels above the item opened", () => {
  it("the sidebar open: no strips, whatever is open", async () => {
    render("/")
    await settle()
    await go(taskSessionHref(RATER.id))
    await settle()
    expect(rails()).toHaveLength(0)
  })

  it("folded: a strip per level above, each listing the level below with the way down marked; a pick shows just it", async () => {
    render("/")
    await settle()
    act(() => setSidebarCollapsed(true))
    await go(taskSessionHref(RATER.id))
    await settle()
    expect(levels()).toEqual([YARD_CAPTAIN, LOGO.id, DESIGNER.id])
    // Before the panel, top first.
    expect([...strip()!.children].map((c) => (c as HTMLElement).dataset.column ?? (c as HTMLElement).dataset.panel)).toEqual([YARD_CAPTAIN, LOGO.id, DESIGNER.id, RATER.id])
    for (const r of rails()) expect(r.className).toBe(RAIL_COLUMN)

    const captain = levelStrip(YARD_CAPTAIN)
    expect(captain.getAttribute("aria-label")).toBe("box-yard Captain")
    expect(railItems(captain).map((b) => b.dataset.task).sort()).toEqual([DOCS.id, LOGO.id].sort())
    expect(railItems(captain).find((b) => b.dataset.task === LOGO.id)!.getAttribute("aria-current")).toBe("page")
    expect(captain.querySelector("[data-testid=rail-tree-button]")).not.toBeNull()
    const logo = levelStrip(LOGO.id)
    expect(logo.getAttribute("aria-label")).toBe(`${LOGO.title}: its sub-tasks`)
    expect(railItems(logo).map((b) => b.dataset.task)).toEqual([DESIGNER.id, DESIGNER2.id, DESIGNER3.id])
    expect(railItems(logo)[0]!.getAttribute("aria-current")).toBe("page")
    expect(railItems(logo)[1]!.getAttribute("aria-label")).toBe(`${DESIGNER2.title}, Needs you`)
    for (const b of railItems(logo)) expect(b.className).toContain("h-11 w-11")
    // Each item is the task's own tile saying its state: pulsing while it works, a still dot when it asks.
    const tile = (b: HTMLElement) => b.querySelector<HTMLElement>("[data-testid=task-status-icon]")!
    expect(tile(railItems(logo)[0]!).className).toContain("motion-safe:animate-pulse")
    expect(tile(railItems(logo)[1]!).className).not.toContain("animate-pulse")
    expect(tile(railItems(logo)[1]!).querySelector("[data-cue]")!.getAttribute("data-cue")).toBe("asks")
    expect(railItems(levelStrip(DESIGNER.id)).map((b) => b.dataset.task)).toEqual([RATER.id])

    // A pick on a strip follows rule 1.
    await click(railItems(logo)[1]!)
    await settle()
    expect(panelIds()).toEqual([DESIGNER2.id])
    expect(levels()).toEqual([YARD_CAPTAIN, LOGO.id])
    // A level's name opens it, alone.
    await click(levelStrip(LOGO.id).querySelector("[data-testid=rail-open]")!)
    await settle()
    expect(panelIds()).toEqual([LOGO.id])
    expect(levels()).toEqual([YARD_CAPTAIN])
    await click(levelStrip(YARD_CAPTAIN).querySelector("[data-testid=rail-open]")!)
    await settle()
    expect(columns()).toHaveLength(0)
    expect(chatProjectFilter()).toBe(YARD.id)
    // Its strip turns into its chat's bar, in the same place.
    expect(rails()).toEqual([chatBar()])
  })

  it("a level that shows has no strip: the rest sit before the first panel below them", async () => {
    render("/")
    await settle()
    act(() => setSidebarCollapsed(true))
    await go(taskSessionHref(LOGO.id))
    await settle()
    await click(pinOf(panelControls(LOGO.id)))
    await go(taskSessionHref(RATER.id))
    await settle()
    expect([...strip()!.children].map((c) => (c as HTMLElement).dataset.column ?? (c as HTMLElement).dataset.panel)).toEqual([YARD_CAPTAIN, LOGO.id, DESIGNER.id, RATER.id])
    expect(levels()).toEqual([YARD_CAPTAIN, DESIGNER.id])
    // The Captain showing as the chat: no strip for it.
    resetColumns()
    await pick(YARD.id)
    await settle()
    await click(pinOf(chatControls()))
    await go(taskSessionHref(DESIGNER.id))
    await settle()
    expect(chat()).toBe("open")
    expect(levels()).toEqual([LOGO.id])
  })

  it("the task filling the room has its sub-tasks in a bar on its left", async () => {
    render("/")
    await settle()
    act(() => setSidebarCollapsed(true))
    await go(taskSessionHref(LOGO.id))
    await settle()
    const bar = rails().find((r) => r.dataset.bar)!
    expect(column(LOGO.id).firstElementChild).toBe(bar)
    expect(bar.className).toBe(SUBTASK_BAR)
    expect(bar.getAttribute("aria-label")).toBe(`Sub-tasks of ${LOGO.title}`)
    expect(railItems(bar).map((b) => b.dataset.task)).toEqual([DESIGNER.id, DESIGNER2.id, DESIGNER3.id])
    await click(railItems(bar)[0]!)
    await settle()
    expect(panelIds()).toEqual([DESIGNER.id])
  })

  it("a window too narrow for the full sidebar beside a panel counts as folded", async () => {
    viewport = 1200
    render("/")
    await settle()
    await go(taskSessionHref(DESIGNER.id))
    await settle()
    expect(sidebar()!.dataset.rail).toBe("true")
    expect(levels()).toEqual([YARD_CAPTAIN, LOGO.id])
  })

  it("the Coordinator opened: no strips, the sidebar's rail lists its projects", async () => {
    render("/")
    await settle()
    act(() => setSidebarCollapsed(true))
    await pick(YARD.id)
    await pick(null)
    await settle()
    expect(rails()).toHaveLength(0)
  })

  it("a Captain's chat showing has its tasks in a bar on its left, the way down to a task", async () => {
    render("/")
    await settle()
    act(() => setSidebarCollapsed(true))
    await pick(YARD.id)
    await settle()
    expect(levels()).toEqual([])
    const bar = chatBar()!
    expect(bar.className).toBe(CHAT_BAR)
    // Between the sidebar's rail and the chat.
    expect(bar.previousElementSibling).toBe(sidebar())
    expect(bar.nextElementSibling).toBe(document.querySelector("[data-centre-chat]"))
    expect(bar.getAttribute("aria-label")).toBe("box-yard tasks")
    expect(railItems(bar).map((b) => b.dataset.task).sort()).toEqual([DOCS.id, LOGO.id].sort())
    expect(railItems(bar).every((b) => !b.hasAttribute("aria-current"))).toBe(true)
    // Its tree button is where a strip's open button is: the chat is open already.
    expect(bar.querySelector("[data-testid=rail-open]")).toBeNull()
    expect(bar.querySelector("[data-testid=rail-tree-button]")).not.toBeNull()
    // A pick shows just the task: the chat hides and its strip takes the bar's place.
    await click(railItems(bar).find((b) => b.dataset.task === LOGO.id)!)
    await settle()
    expect(panelIds()).toEqual([LOGO.id])
    expect(chat()).toBe("closed")
    expect(chatBar()).toBeNull()
    expect(levels()).toEqual([YARD_CAPTAIN])
    // Pinned, the chat stays as tasks open beside it, and its bar marks them.
    await pick(YARD.id)
    await settle()
    await click(pinOf(chatControls()))
    await click(railItems(chatBar()!).find((b) => b.dataset.task === DOCS.id)!)
    await settle()
    expect(chat()).toBe("open")
    expect(railItems(chatBar()!).find((b) => b.dataset.task === DOCS.id)!.getAttribute("aria-current")).toBe("page")
    // The sidebar open: no bar.
    act(() => setSidebarCollapsed(false))
    await settle()
    expect(chatBar()).toBeNull()
  })

  it("a Captain with no tasks listed has no bar", async () => {
    render("/")
    await settle()
    act(() => setSidebarCollapsed(true))
    act(() => qc.setQueryData(keys.tasks, TASKS.filter((t) => t.projectId !== COOK.id)))
    await pick(COOK.id)
    await settle()
    expect(rails()).toHaveLength(0)
  })

  it("loaded with the sidebar folded: the strips are there from the first paint, never opening the sidebar", async () => {
    act(() => setSidebarCollapsed(true))
    render(opened(RATER))
    await settle()
    expect(sidebar()!.dataset.rail).toBe("true")
    expect(chat()).toBe("closed")
    expect(levels()).toEqual([YARD_CAPTAIN, LOGO.id, DESIGNER.id])
    // Reloaded on a task with sub-tasks: its strip and its bar.
    act(() => root.unmount())
    root = createRoot(host)
    resetColumns()
    render(opened(LOGO))
    await settle()
    expect(levels()).toEqual([YARD_CAPTAIN])
    expect(rails().filter((r) => r.dataset.bar).map((r) => r.dataset.column)).toEqual([LOGO.id])
    // Reloaded on a Captain's chat: its bar.
    act(() => root.unmount())
    root = createRoot(host)
    resetColumns()
    setChatProjectFilter(YARD.id)
    render("/")
    await settle()
    expect(chatBar()!.dataset.column).toBe(YARD_CAPTAIN)
  })

  it("navigated while folded: each step down from the Captain's chat has the strips above it", async () => {
    act(() => setSidebarCollapsed(true))
    render("/")
    await settle()
    // The rail's project icon: the Captain's chat, with its tasks beside it.
    await click(nav().querySelector(`button[aria-label^="${YARD.name} Captain"]`)!)
    await settle()
    expect(centre()).toContain(YARD.name)
    expect(railItems(chatBar()!).length).toBeGreaterThan(0)
    // Its task, from the bar: the Captain's strip, and the task's sub-tasks in its bar.
    await click(railItems(chatBar()!).find((b) => b.dataset.task === LOGO.id)!)
    await settle()
    expect(levels()).toEqual([YARD_CAPTAIN])
    // A sub-task, from that bar: the parent's strip too.
    await click(railItems(rails().find((r) => r.dataset.bar)!)[0]!)
    await settle()
    expect(panelIds()).toEqual([DESIGNER.id])
    expect(levels()).toEqual([YARD_CAPTAIN, LOGO.id])
    // A link, the palette or a notification to a deeper one: every level above.
    await go(taskSessionHref(RATER.id))
    await settle()
    expect(levels()).toEqual([YARD_CAPTAIN, LOGO.id, DESIGNER.id])
    // Another project's task: its own Captain.
    await go(taskSessionHref(MEAL.id))
    await settle()
    expect(levels()).toEqual([chatRef(COOK.id)])
  })

  it("a task opened before the list has it: its strips come as it loads", async () => {
    const SPAWNED = task("task_desig4", "Logo designer 4/4", "starting", LOGO)
    act(() => setSidebarCollapsed(true))
    render(opened(SPAWNED))
    await settle()
    expect(levels()).toEqual([])
    act(() => qc.setQueryData(keys.tasks, [...TASKS, SPAWNED]))
    await settle()
    expect(levels()).toEqual([YARD_CAPTAIN, LOGO.id])
    // Its parent's strip lists it, marked.
    expect(railItems(levelStrip(LOGO.id)).find((b) => b.dataset.task === SPAWNED.id)!.getAttribute("aria-current")).toBe("page")
  })
})

describe("Columns, rule 8: a hidden chat stays hidden", () => {
  it("as other tasks open, from any project, until it's picked again or the last panel closes", async () => {
    render("/")
    await settle()
    await pick(YARD.id)
    await settle()
    await row(DOCS)
    await settle()
    expect(chat()).toBe("closed")
    await row(LOGO)
    await settle()
    expect(chat()).toBe("closed")
    await go(taskSessionHref(MEAL.id))
    await settle()
    expect(chat()).toBe("closed")
    expect(chatProjectFilter()).toBe(YARD.id)
    expect(closeOf(panelControls(MEAL.id))).toBeNull()
    await esc()
    await settle()
    expect(columns()).toHaveLength(0)
    expect(centre()).toContain("box-yard")
  })

  it("a pinned chat stays as tasks open", async () => {
    render("/")
    await settle()
    await pick(YARD.id)
    await settle()
    await click(pinOf(chatControls()))
    for (const t of [DOCS, LOGO, MEAL]) {
      await go(taskSessionHref(t.id))
      await settle()
      expect(chat()).toBe("open")
      expect(panelIds()).toEqual([t.id])
    }
  })
})

describe("Columns: state", () => {
  it("lives in memory only: nothing in web storage", async () => {
    render("/")
    await settle()
    // The palette's list of what was opened lately and where each view was scrolled are their own.
    const columnsOnly = (store: Storage) => Object.fromEntries(Object.entries({ ...store }).filter(([k]) => k !== "box-yard:recent" && k !== "box-yard:scroll"))
    const before = { local: columnsOnly(localStorage), session: columnsOnly(sessionStorage) }
    await click(pinOf(chatControls()))
    await go(taskSessionHref(LOGO.id))
    await settle()
    await click(pinOf(panelControls(LOGO.id)))
    await go(taskSessionHref(RATER.id))
    await settle()
    await click(closeOf(chatControls())!)
    await click(closeOf(panelControls(RATER.id))!)
    await settle()
    expect(columnsOnly(localStorage)).toEqual(before.local)
    expect(columnsOnly(sessionStorage)).toEqual(before.session)
  })
})

describe("Columns: the order and the layout", () => {
  // A small tree: two Captains under the Coordinator; L's sub-tasks D and D2, D's R; S beside L; F in the other project.
  const tree: Record<string, string> = { "captain.y": COORDINATOR_REF, "captain.g": COORDINATOR_REF, L: "captain.y", D: "L", D2: "L", R: "D", S: "captain.y", F: "captain.g" }
  const parentOf = (ref: string) => tree[ref] ?? null

  it("orders by the tree, a tree going where its first pin is, and pin order among the rest", () => {
    expect(orderRefs(["L", "S", "R"], parentOf)).toEqual(["L", "R", "S"])
    expect(orderRefs(["R", "L"], parentOf)).toEqual(["L", "R"])
    expect(orderRefs(["D2", "D"], parentOf)).toEqual(["D2", "D"])
    expect(orderRefs(["F", "captain.y", "S"], parentOf)).toEqual(["F", "captain.y", "S"])
    expect(orderRefs(["S", "F", "captain.y"], parentOf)).toEqual(["captain.y", "S", "F"])
    // A loop in the data never hangs.
    expect(orderRefs(["a", "b"], (r) => (r === "a" ? "b" : "a")).sort()).toEqual(["a", "b"])
  })

  it("the chat is what leads, when it's the Coordinator or a Captain; else it hides", () => {
    expect(arrangement("L", [], parentOf)).toEqual({ chat: null, panels: ["L"] })
    expect(arrangement("captain.y", [], parentOf)).toEqual({ chat: "captain.y", panels: [] })
    expect(arrangement("R", ["captain.y", "L"], parentOf)).toEqual({ chat: "captain.y", panels: ["L", "R"] })
    expect(arrangement("captain.g", ["L"], parentOf)).toEqual({ chat: null, panels: ["L", "captain.g"] })
    expect(arrangement("L", ["F", COORDINATOR_REF], parentOf)).toEqual({ chat: COORDINATOR_REF, panels: ["F", "L"] })
    // The Coordinator leads even beside a task not loaded yet.
    expect(arrangement("unknown", [COORDINATOR_REF], parentOf)).toEqual({ chat: COORDINATOR_REF, panels: ["unknown"] })
  })

  it("strips: the levels above the item opened that aren't showing, each before its first panel below", () => {
    expect(hierarchyStrips("R", null, ["R"], parentOf)).toEqual([
      { ref: "captain.y", before: 0, below: "L" },
      { ref: "L", before: 0, below: "D" },
      { ref: "D", before: 0, below: "R" },
    ])
    expect(hierarchyStrips("R", "captain.y", ["L", "R"], parentOf)).toEqual([{ ref: "D", before: 1, below: "R" }])
    expect(hierarchyStrips("F", null, ["L", "F"], parentOf)).toEqual([{ ref: "captain.g", before: 1, below: "F" }])
    expect(hierarchyStrips("captain.y", "captain.y", [], parentOf)).toEqual([])
  })

  it("the layout: the rightmost fills the hidden chat's room; strips only with the sidebar folded", () => {
    const s = (over: Partial<ColumnsState>): ColumnsState => ({ pins: [], chatHidden: false, focus: null, rails: false, ...over })
    expect(columnLayout([], null, s({ chatHidden: true }), parentOf)).toEqual({ chat: "open", panels: [], strips: [] })
    expect(columnLayout(["L"], "captain.y", s({ focus: "L" }), parentOf)).toEqual({ chat: "open", panels: ["open"], strips: [] })
    expect(columnLayout(["L", "R"], "captain.y", s({ chatHidden: true, focus: "R" }), parentOf)).toEqual({ chat: "closed", panels: ["open", "fill"], strips: [] })
    expect(columnLayout(["L", "R"], "captain.y", s({ chatHidden: true, focus: "R", rails: true }), parentOf).strips).toEqual([
      { ref: "captain.y", before: 0, below: "L" },
      { ref: "D", before: 1, below: "R" },
    ])
    // The chat showing has no strip.
    expect(columnLayout(["R"], "captain.y", s({ focus: "R", rails: true }), parentOf).strips.map((x) => x.ref)).toEqual(["L", "D"])
  })
})

describe("Columns on a phone", () => {
  it("keeps its own way: an opening takes the last panel's place, and the chat follows the task's Captain", async () => {
    viewport = 400
    setChatProjectFilter(YARD.id)
    render(opened(DOCS))
    await settle()
    await go(taskSessionHref(MEAL.id))
    await settle()
    expect(panelIds()).toEqual([MEAL.id])
    expect(chat()).toBe("open")
    expect(chatProjectFilter()).toBe(COOK.id)
  })

  it("one panel at a time: strips, bars and every column but the newest hide there", async () => {
    viewport = 400
    render(opened(LOGO, DESIGNER))
    await settle()
    for (const look of [RAIL_COLUMN, SUBTASK_BAR]) expect(look).toContain("@max-[35.5rem]/coord:hidden")
    expect(columns()[0]!.className).toContain(SHEET_HIDDEN)
    const newest = columns().at(-1)!
    expect(newest.className).toContain("@max-[35.5rem]/coord:w-full")
    expect(newest.className).not.toContain(SHEET_HIDDEN)
  })
})
