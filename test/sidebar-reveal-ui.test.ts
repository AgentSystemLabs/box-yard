// @vitest-environment happy-dom
// The sidebar follows the task a link opens (a sub-task link in a transcript, the palette, a notice, Back, a page
// load): the task's project and the trees above it unfold, and its row scrolls just into view in the sidebar's own
// list, never the page or a panel, gliding unless Cody prefers reduced motion. The focus stays where it is, and the
// tree keeps its one tab stop. A row clicked in the sidebar is where the pointer is, so nothing moves. On a phone, or
// beside the rail, the list shows the row as soon as it opens.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { warmLazyParts } from "../web/src/components/LazyPart.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { keys } from "../web/src/lib/queries.js"
import { setChatProjectFilter } from "../web/src/lib/projectBar.js"
import { closeSidebarDrawer, openSidebarDrawer, setSidebarCollapsed, setTreeFolds, toggleSidebarFold, unfoldSidebarGroup } from "../web/src/lib/sidebar.js"
import { resetColumns } from "../web/src/lib/columns.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import { resetScrollMemory } from "../web/src/lib/scrollMemory.js"
import { APP_HOME, navigateApp, taskSessionHref } from "../web/src/lib/navigation.js"
import type { Project, Task, TaskMessage, TaskStatus } from "../shared/types"
import { sidebarGroup } from "./sidebarTree.js"

beforeAll(() => warmLazyParts())

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const project = (id: string, name: string) => ({ id, name, repo: null, description: "", notes: [], envKeys: [], baseBranch: "main", runner: "box", identityId: "idn_default", gpuMachine: { gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null }, docker: { image: null, dockerfile: null }, createdAt: now, color: null }) as unknown as Project
const task = (id: string, projectId: string, title: string, status: TaskStatus, createdAt: number, parent?: Task) =>
  ({
    id,
    projectId,
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
    createdAt,
    updatedAt: createdAt,
  }) as unknown as Task

const YARD = project("prj_yard01", "box-yard")
const SITE = project("prj_site01", "marketing-site")
// More rows than the list shows: box-yard's busy work, newest first, then marketing-site's tree at the bottom.
const BUSY = Array.from({ length: 20 }, (_, i) => task(`task_busy${String(i).padStart(2, "0")}`, YARD.id, `Busy work ${i + 1}`, "working", now - 60_000 - i * 1000))
const LAUNCH = task("task_launch", SITE.id, "Plan the launch", "waiting", now - 120_000)
const POST = task("task_post01", SITE.id, "Write the launch post", "waiting", now - 110_000, LAUNCH)
const TABLE = task("task_table1", SITE.id, "Make the price table", "working", now - 100_000, POST)
const TASKS = [...BUSY, LAUNCH, POST, TABLE]
/** The rows' order in the list: box-yard's head, its 20 tasks, marketing-site's head, then its tree. */
const ROW = { busy: (i: number) => 1 + i, launch: 22, post: 23, table: 24 }

const started = (parent: Task, kids: Task[]): TaskMessage =>
  ({ id: `tm_${parent.id}_spawn`, role: "event", content: `Started ${kids.length} sub-tasks.`, meta: { kind: "subtasks", subtasks: kids.map((k) => ({ id: k.id, title: k.title })) }, createdAt: now - 50_000 }) as unknown as TaskMessage

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
type HappyWindow = { happyDOM: { setViewport(v: { width: number; height: number }): void; settings: { device: { prefersReducedMotion: string } } } }
const happy = () => (window as unknown as HappyWindow).happyDOM
const viewport = (width: number, height = 900) => happy().setViewport({ width, height })

function render(path = APP_HOME) {
  history.replaceState(null, "", path)
  resetScrollMemory()
  sessionStorage.setItem("box-yard:landed", "1")
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.agentSettings, { settings: DEFAULT_SETTINGS, sources: {}, defaults: DEFAULT_SETTINGS })
  qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.chat, [])
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, TASKS)
  qc.setQueryData(keys.projects, [YARD, SITE])
  qc.setQueryData(keys.taskMessages(LAUNCH.id), [started(LAUNCH, [POST])])
  qc.setQueryData(keys.taskMessages(POST.id), [started(POST, [TABLE])])
  for (const t of [...BUSY, TABLE]) qc.setQueryData(keys.taskMessages(t.id), [{ id: `tm_${t.id}`, role: "assistant", content: `Notes on ${t.title}`, meta: null, createdAt: now }])
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications, keys.scheduleRuns]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
}

/** The sidebar's list: the column's, else the drawer's. */
const isList = (el: Element) => el.parentElement?.getAttribute("role") === "tree" && el.classList.contains("overflow-y-auto")
const nav = () => document.querySelector<HTMLElement>("nav[aria-label='Projects and tasks']")
const drawer = () => document.querySelector<HTMLElement>("[role=dialog][aria-label='Projects and tasks']")
const list = (within: ParentNode = nav()!) => within.querySelector<HTMLElement>("[role=tree] > .overflow-y-auto")!
const row = (t: Task, within: ParentNode = nav()!) => within.querySelector<HTMLElement>(`[data-open-task=${t.id}]`)?.closest<HTMLElement>("[role=treeitem]") ?? null
const expanded = (t: Task, within: ParentNode = nav()!) => row(t, within)!.getAttribute("aria-expanded")
const projectExpanded = (p: Project, within: ParentNode = nav()!) => sidebarGroup(within, p.name)!.querySelector("[role=treeitem]")!.getAttribute("aria-expanded")
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 })))
const open = (t: Task) => act(() => navigateApp(taskSessionHref(t.id)))
/** A tick for history's popstate, a smooth scroll's landing and the first paint (requestAnimationFrame). */
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))

/**
 * The list shows 100–800px (700px tall); each of its rows is 40px, top to bottom, moved up by the list's scroll. Every
 * scroll of an element is recorded: `scrolls` the list's, `intoView` any scrollIntoView, `window` the page's.
 */
function layout() {
  const real = HTMLElement.prototype.getBoundingClientRect
  const rect = (top: number, bottom: number) => ({ top, bottom, y: top, height: bottom - top, left: 0, right: 240, x: 0, width: 240, toJSON() {} }) as DOMRect
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (isList(this)) return rect(100, 800)
    const box = this.getAttribute("role") === "treeitem" ? this.closest<HTMLElement>(".overflow-y-auto") : null
    if (box && isList(box)) {
      const top = 100 + [...box.querySelectorAll("[role=treeitem]")].indexOf(this) * 40 - box.scrollTop
      return rect(top, top + 40)
    }
    return real.call(this)
  })
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return isList(this) ? 700 : 0
  })
  const scrollTo = vi.spyOn(HTMLElement.prototype, "scrollTo")
  const intoView = vi.spyOn(Element.prototype, "scrollIntoView")
  const page = vi.spyOn(window, "scrollTo").mockImplementation(() => {})
  return {
    /** The list's scrolls: where to, and how. */
    scrolls: () => scrollTo.mock.calls.flatMap((args, i) => (isList(scrollTo.mock.contexts[i] as HTMLElement) ? [args[0] as ScrollToOptions] : [])),
    /** Elements in the sidebar that scrolled themselves into view, moving whatever holds them. */
    intoView: () => intoView.mock.contexts.filter((el) => (el as Element).closest("nav")),
    page: () => page.mock.calls.length,
    reset: () => [scrollTo, intoView, page].forEach((s) => s.mockClear()),
  }
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  viewport(1440)
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
  vi.stubGlobal("EventSource", FakeEventSource)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
    await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)))
  })
  host.remove()
  document.body.innerHTML = ""
  for (const t of currentToasts()) dismiss(t.id)
  act(() => {
    setChatProjectFilter(null)
    setSidebarCollapsed(false)
    closeSidebarDrawer()
    setTreeFolds({})
    for (const key of [YARD.id, SITE.id]) unfoldSidebarGroup(key)
    resetColumns()
  })
  happy().settings.device.prefersReducedMotion = "no-preference"
  viewport(1024, 768)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("the sidebar follows the task a link opens", () => {
  it("a sub-task link in a transcript scrolls only the sidebar's list, just enough to show its row, gliding", async () => {
    const scroll = layout()
    render(`/?session=${POST.id}`)
    // A page load shows the open task's row at once: the list has nothing on screen yet to glide from.
    expect(scroll.scrolls()).toEqual([{ top: (ROW.post + 1) * 40 - 700, behavior: "auto" }])
    await settle()
    scroll.reset()

    const panel = document.querySelector<HTMLElement>(`[data-testid=column][data-view='session:${POST.id}']`)!
    click(panel.querySelector<HTMLAnchorElement>(`[data-testid=subtasks-line] a[href$='${TABLE.id}']`)!)
    await settle()
    expect(location.search).toBe(`?session=${TABLE.id}`)
    expect(row(TABLE)!.getAttribute("aria-current")).toBe("page")
    // Its row's bottom at the list's: 40px further, not to the top, and smoothly.
    expect(scroll.scrolls()).toEqual([{ top: (ROW.table + 1) * 40 - 700, behavior: "smooth" }])
    expect(list().scrollTop).toBe((ROW.table + 1) * 40 - 700)
    // Nothing else moved: no scrollIntoView (it scrolls every ancestor too), and not the page.
    expect(scroll.intoView()).toEqual([])
    expect(scroll.page()).toBe(0)
  })

  it("takes no focus: the panel opened keeps it, and the tree's one tab stop is the open task's row", async () => {
    layout()
    render()
    await settle()
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    open(TABLE)
    expect(focus.mock.contexts.filter((el) => nav()!.contains(el as Node))).toEqual([])
    expect(nav()!.contains(document.activeElement)).toBe(false)
    const stops = nav()!.querySelectorAll("[role=tree] [tabindex='0']")
    expect([...stops]).toEqual([row(TABLE)])
  })

  it("unfolds the task's project and every folded tree above it, so its row is there to show", async () => {
    const scroll = layout()
    act(() => {
      toggleSidebarFold(SITE.id)
      setTreeFolds({ [LAUNCH.id]: true, [POST.id]: true })
    })
    render()
    await settle()
    expect(projectExpanded(SITE)).toBe("false")
    expect(row(TABLE)).toBeNull()

    open(TABLE)
    expect(projectExpanded(SITE)).toBe("true")
    expect(expanded(LAUNCH)).toBe("true")
    expect(expanded(POST)).toBe("true")
    expect(row(TABLE)!.getAttribute("aria-current")).toBe("page")
    expect(scroll.scrolls()).toEqual([{ top: (ROW.table + 1) * 40 - 700, behavior: "smooth" }])
    // The project's unfold sticks, as the chevron's would; the other project is as it was.
    expect(localStorage.getItem("box-yard:sidebar-folds")).toBe("{}")
    expect(projectExpanded(YARD)).toBe("true")
  })

  it("a row already in view stays where it is; one above the view scrolls down to its top", async () => {
    const scroll = layout()
    render()
    await settle()
    open(BUSY[3]!)
    expect(scroll.scrolls()).toEqual([])

    act(() => void (list().scrollTop = 400))
    open(BUSY[0]!)
    expect(scroll.scrolls()).toEqual([{ top: ROW.busy(0) * 40, behavior: "smooth" }])
  })

  it("a row clicked in the sidebar is where the pointer is: the list doesn't move, even for one half in view", async () => {
    const scroll = layout()
    render()
    await settle()
    // Its row runs from 680px to 720px down the list, which shows 700px.
    const half = BUSY[16]!
    expect([ROW.busy(16) * 40, (ROW.busy(16) + 1) * 40]).toEqual([680, 720])
    click(nav()!.querySelector(`[data-open-task=${half.id}]`)!)
    await settle()
    expect(location.search).toBe(`?session=${half.id}`)
    expect(scroll.scrolls()).toEqual([])

    // The click leaves nothing behind: the next task a link opens scrolls as ever.
    open(TABLE)
    expect(scroll.scrolls()).toEqual([{ top: (ROW.table + 1) * 40 - 700, behavior: "smooth" }])
  })

  it("Back and Forward bring the row back into view", async () => {
    const scroll = layout()
    render()
    await settle()
    open(TABLE)
    await settle()
    open(BUSY[0]!)
    await settle()
    expect(list().scrollTop).toBe(ROW.busy(0) * 40)
    scroll.reset()

    act(() => history.back())
    await settle()
    expect(location.search).toBe(`?session=${TABLE.id}`)
    expect(scroll.scrolls()).toEqual([{ top: (ROW.table + 1) * 40 - 700, behavior: "smooth" }])
    act(() => history.forward())
    await settle()
    expect(location.search).toBe(`?session=${BUSY[0]!.id}`)
    expect(scroll.scrolls().at(-1)).toEqual({ top: ROW.busy(0) * 40, behavior: "smooth" })
  })

  it("under prefers-reduced-motion the row is just there, without a glide", async () => {
    happy().settings.device.prefersReducedMotion = "reduce"
    const scroll = layout()
    render()
    await settle()
    open(TABLE)
    expect(scroll.scrolls()).toEqual([{ top: (ROW.table + 1) * 40 - 700, behavior: "auto" }])
    expect(list().scrollTop).toBe((ROW.table + 1) * 40 - 700)
  })

  it("on a phone the drawer opens on the task a link opened, unfolded, and on the open task each time after", async () => {
    viewport(400)
    const scroll = layout()
    act(() => {
      toggleSidebarFold(SITE.id)
      setTreeFolds({ [POST.id]: true })
    })
    render()
    await settle()
    expect(nav()).toBeNull()
    open(TABLE)
    await settle()
    act(() => openSidebarDrawer())
    expect(projectExpanded(SITE, drawer()!)).toBe("true")
    expect(expanded(POST, drawer()!)).toBe("true")
    expect(row(TABLE, drawer()!)!.getAttribute("aria-current")).toBe("page")
    expect(list(drawer()!).scrollTop).toBe((ROW.table + 1) * 40 - 700)
    expect(scroll.scrolls().at(-1)!.behavior).toBe("auto")

    // A pick there closes it; opened again, it starts at the top and shows the open task's row again.
    click(drawer()!.querySelector(`[data-open-task=${BUSY[19]!.id}]`)!)
    expect(drawer()).toBeNull()
    act(() => openSidebarDrawer())
    expect(list(drawer()!).scrollTop).toBe((ROW.busy(19) + 1) * 40 - 700)
  })

  it("beside a panel that keeps the sidebar a rail, the list shows the row once it widens", async () => {
    viewport(1100)
    const scroll = layout()
    render()
    await settle()
    open(TABLE)
    const inline = document.querySelector<HTMLElement>("[data-testid=sidebar]")!
    expect(inline.dataset.rail).toBe("true")
    expect(scroll.scrolls()).toEqual([])
    click(inline.querySelector<HTMLButtonElement>("button[aria-label='Show the sidebar']")!)
    expect(row(TABLE, drawer()!)!.getAttribute("aria-current")).toBe("page")
    expect(list(drawer()!).scrollTop).toBe((ROW.table + 1) * 40 - 700)
  })
})
