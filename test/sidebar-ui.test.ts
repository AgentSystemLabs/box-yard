// @vitest-environment happy-dom
// The sidebar: the Coordinator and each project's row as top-level chats (the row is its Captain; only the
// chevron folds), tasks opening in the side panel, one selected row, "Waiting on you", pins, the top row's 🔍 (the
// palette), the rail beside an open panel, and the drawer on a phone.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { warmLazyParts } from "../web/src/components/LazyPart.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { keys } from "../web/src/lib/queries.js"
import { PINS_KEY, readPins, setChatProjectFilter } from "../web/src/lib/projectBar.js"
import { DOUBLE_TAP_MS, WAITING_FOLD, closeSidebarDrawer, setSidebarCollapsed, toggleSidebarFold, unfoldSidebarGroup } from "../web/src/lib/sidebar.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import { undoClose } from "../web/src/lib/inbox.js"
import { resetClosedTasks } from "../web/src/lib/closedTasks.js"
import { chatRef, resetColumns, setPinned } from "../web/src/lib/columns.js"
import type { Project, Task, TaskStatus } from "../shared/types"
import { APP_HOME } from "../web/src/lib/navigation.js"

// Settings, project settings and schedules are lazy chunks: load them up front, as the app does once it settles, so
// they open in the same render.
beforeAll(() => warmLazyParts())

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const project = (id: string, name: string) => ({ id, name, repo: null, description: "", notes: [], envKeys: [], baseBranch: "main", runner: "box", identityId: "idn_default", gpuMachine: { gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null }, docker: { image: null, dockerfile: null }, createdAt: now, color: null }) as unknown as Project
const task = (id: string, projectId: string, title: string, status: TaskStatus, extra: Partial<Task> = {}) =>
  ({ id, projectId, title, status, prompt: "", prUrl: null, prState: null, prMergedAt: null, previews: [], waitFor: [], question: null, error: null, scheduleId: null, outcome: null, createdAt: now - 60_000, updatedAt: now - 60_000, ...extra }) as unknown as Task

const YARD = project("prj_yard01", "box-yard")
const SITE = project("prj_site01", "marketing-site")
const QUIET = project("prj_quiet1", "photo-tools")
const ASK = task("task_ask001", YARD.id, "Check SSH into the bench", "needs_input")
const RUN = task("task_run001", YARD.id, "Three-pane layout", "working")
const PR = task("task_pr0001", SITE.id, "Refresh the portfolio", "pr_ready", { prUrl: "https://github.com/o/site/pull/19" })
const OLD = task("task_old001", QUIET.id, "Fix attachment previews", "done")

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

function render(path = APP_HOME, tasks: Task[] = [ASK, RUN, PR, OLD]) {
  history.replaceState(null, "", path)
  sessionStorage.setItem("box-yard:landed", "1")
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.agentSettings, { settings: DEFAULT_SETTINGS, sources: {}, defaults: DEFAULT_SETTINGS })
  qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.chat, [])
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, tasks)
  qc.setQueryData(keys.projects, [YARD, SITE, QUIET])
  qc.setQueryData(keys.captain(YARD.id), { projectId: YARD.id, busy: true, usage: { tokens: null, window: null, updatedAt: null } })
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
}

const nav = () => document.querySelector<HTMLElement>("nav[aria-label='Projects and tasks']")
const inline = () => document.querySelector<HTMLElement>("[data-testid=sidebar]")
const button = (within: ParentNode, name: string | RegExp) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find((b) => (typeof name === "string" ? b.textContent?.includes(name) || b.getAttribute("aria-label") === name : name.test(b.textContent ?? "")))!
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
const current = () => nav()!.querySelector("[aria-current=page]")?.textContent
// The chat on screen: the centre keeps the chats left last beside it, hidden (lib/keptChats.ts).
const title = () => [...document.querySelectorAll("[data-testid=chat-title]")].find((t) => t.checkVisibility())!.textContent
const section = (name: string) => nav()!.querySelector<HTMLElement>(`section[aria-label='${name}']`)

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

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  for (const t of currentToasts()) dismiss(t.id)
  act(() => {
    setChatProjectFilter(null)
    resetColumns()
    setSidebarCollapsed(false)
    closeSidebarDrawer()
    // The folds live in memory as well as in localStorage.
    for (const key of [YARD.id, SITE.id, QUIET.id, WAITING_FOLD]) unfoldSidebarGroup(key)
  })
  viewport(1024, 768)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** What a screen reader hears from an element: its text, each icon's name (role="img") in its place, nothing aria-hidden. */
const heard = (el: Node): string => {
  if (el.nodeType === Node.TEXT_NODE) return el.textContent ?? ""
  const e = el as Element
  if (e.getAttribute("aria-hidden") === "true") return ""
  if (e.getAttribute("role") === "img") return ` ${e.getAttribute("aria-label")} `
  return [...e.childNodes].map(heard).join("")
}
const spoken = (el: Element) => heard(el).replace(/\s+/g, " ").trim()

describe("the sidebar", () => {
  const selected = () => [...nav()!.querySelectorAll("[aria-current]")].map((el) => [el.getAttribute("aria-current"), spoken(el)])
  const projectRow = (name: string) => button(section(name)!, new RegExp(`^${name}, Captain`))
  const chevron = (name: string) => section(name)!.querySelector<HTMLButtonElement>("button[aria-expanded]")!

  it("lists the Coordinator, what's waiting on Cody, and each busy project's row and live tasks; quiet ones fold away", () => {
    render()
    expect(inline()!.dataset.rail).toBeUndefined()
    expect(current()).toBe("Coordinator")
    // There's no Inbox mode to switch into: what waits on Cody is a section above the projects.
    expect(button(nav()!, "Inbox")).toBeUndefined()
    const waiting = section("Waiting on you")!
    expect(waiting.textContent).toContain("Check SSH into the bench")
    expect(waiting.textContent).toContain("Refresh the portfolio")
    expect(waiting.textContent).not.toContain("Three-pane layout")
    // Asking and PR ready: the count goes amber for the question.
    expect(waiting.querySelector(".bg-amber-400")!.textContent).toBe("2")
    const yard = section("box-yard")!
    expect([...yard.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? spoken(b))).toEqual([
      // The fold, the row that is the Captain, settings, the pin, then its tasks: asking first. No Captain row of its
      // own among the tasks. Screen readers hear each status (the task's icon names it, after its title; a meta that is
      // the same word stays quiet), and that the Captain is working.
      "Hide box-yard tasks",
      "box-yard, Captain, working",
      "box-yard project settings",
      "Pin box-yard",
      "Check SSH into the bench Needs you asks",
      "Three-pane layout Working",
    ])
    // No status dots: each task leads with its own icon, which pulses while it works and has a still dot when it asks.
    const icons = [...yard.querySelectorAll<HTMLElement>('[data-testid="task-status-icon"]')]
    expect(icons.map((i) => [i.dataset.status, i.getAttribute("aria-label")])).toEqual([["needs_input", "Needs you"], ["working", "Working"]])
    expect(icons[0]!.className).not.toContain("animate-pulse")
    expect(icons[0]!.querySelector("[data-cue]")!.getAttribute("data-cue")).toBe("asks")
    expect(icons[1]!.className).toContain("motion-safe:animate-pulse")
    expect(section("marketing-site")!.textContent).toContain("#19")
    expect(section("photo-tools")).toBeNull()
    const more = section("More projects")!
    click(button(more, "More projects"))
    expect(more.textContent).toContain("photo-tools")
  })

  it("a project's name makes its Captain the centre chat; the Coordinator row goes back", () => {
    render()
    click(projectRow("marketing-site"))
    expect(title()).toBe("marketing-site Captain")
    expect(current()).toBe("marketing-site, Captain")
    expect(readPins()).toEqual({ [SITE.id]: "pinned" })
    expect(document.querySelector<HTMLTextAreaElement>("textarea")!.placeholder).toBe("Message the marketing-site Captain…")
    click(button(nav()!, "Coordinator"))
    expect(title()).toContain("Coordinator")
    expect(current()).toBe("Coordinator")
  })

  it("only the chevron folds a project: it never opens the Captain, and a folded project counts its tasks", () => {
    render()
    const fold = chevron("box-yard")
    expect(fold.getAttribute("aria-controls")).toBe(`sidebar-tasks-${YARD.id}`)
    click(fold)
    expect(fold.getAttribute("aria-expanded")).toBe("false")
    expect(fold.getAttribute("aria-label")).toBe("Show box-yard tasks")
    expect(title()).toContain("Coordinator")
    expect(current()).toBe("Coordinator")
    expect(section("box-yard")!.textContent).not.toContain("Three-pane layout")
    // Folded, the row says how many tasks it holds, with an amber dot because one asks.
    expect(projectRow("box-yard").textContent).toBe("box-yard, Captain, working2 tasks, 1 asking you")
    expect(projectRow("box-yard").querySelector(".bg-amber-400")).not.toBeNull()
    expect(JSON.parse(localStorage.getItem("box-yard:sidebar-folds")!)).toEqual({ [YARD.id]: true })
    click(fold)
    expect(section("box-yard")!.textContent).toContain("Three-pane layout")
  })

  it("exactly one row looks selected: an open task takes it; a pinned chat beside it gets only a mark, a hidden one none", () => {
    render()
    click(projectRow("box-yard"))
    expect(selected()).toEqual([["page", "box-yard, Captain, working"]])
    click(button(section("box-yard")!, "Three-pane layout"))
    expect(new URLSearchParams(location.search).get("session")).toBe(RUN.id)
    expect(selected()).toEqual([["page", "Three-pane layout Working"]])
    // The Captain hid as the task opened: no mark.
    expect(projectRow("box-yard").textContent).not.toContain("open behind the panel")
    // Pinned, it stays beside the task: not filled, it says it's open behind the panel.
    click(projectRow("box-yard"))
    act(() => setPinned(chatRef(YARD.id), true))
    click(button(section("box-yard")!, "Three-pane layout"))
    expect(selected()).toEqual([["page", "Three-pane layout Working"]])
    expect(projectRow("box-yard").getAttribute("aria-current")).toBeNull()
    expect(projectRow("box-yard").textContent).toContain("open behind the panel")
    expect(projectRow("box-yard").closest(".bg-zinc-800")).toBeNull()
  })

  it("a task in Waiting on you and under its project: only the copy clicked is selected; folding it moves the mark", () => {
    render()
    click(button(section("Waiting on you")!, "Check SSH into the bench"))
    expect(new URLSearchParams(location.search).get("session")).toBe(ASK.id)
    expect(selected()).toEqual([["page", "Check SSH into the bench Needs you box-yardasks"]])
    expect(section("Waiting on you")!.querySelector("[aria-current=page]")).not.toBeNull()
    // Fold the section: the task's row under box-yard is the one on screen, so it takes the mark.
    click(button(section("Waiting on you")!, /^Waiting on you/))
    expect(section("box-yard")!.querySelector("[aria-current=page]")!.textContent).toMatch(/^Check SSH/)
    // Fold box-yard too: no row of it is on screen, so the folded group it was clicked in keeps a faint bar.
    click(chevron("box-yard"))
    expect(selected()).toEqual([])
    expect(button(section("Waiting on you")!, /^Waiting on you/).className).toContain("color-mix")
  })

  it("pins keep a quiet project; unpinning moves it to More projects", () => {
    render()
    click(button(section("More projects")!, "More projects"))
    click(button(section("More projects")!, "Pin photo-tools"))
    expect(readPins()).toEqual({ [QUIET.id]: "pinned" })
    expect(section("photo-tools")).not.toBeNull()
    const unpin = button(section("photo-tools")!, "Unpin photo-tools")
    expect(unpin.getAttribute("aria-pressed")).toBe("true")
    click(unpin)
    expect(JSON.parse(localStorage.getItem(PINS_KEY)!)).toEqual({ [QUIET.id]: "unpinned" })
    expect(section("photo-tools")).toBeNull()
  })

  it("search is the palette: the top row's 🔍 opens it, beside the fold, and the list has no search box", () => {
    render()
    expect(nav()!.querySelector("input")).toBeNull()
    const top = nav()!.firstElementChild!
    expect([...top.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Search tasks", "Fold the sidebar"])
    const search = button(top, "Search tasks")
    expect(search.title).toMatch(/^Search tasks \((⌘K|Ctrl\+K) or \/\)$/)
    click(search)
    expect(document.activeElement).toBe(document.querySelector('input[aria-label="Search Box Yard"]'))
    click(document.querySelector('[role="dialog"] button[aria-label="Close"]')!)
    expect(document.activeElement).toBe(search)
  })

  it("folds to a rail beside an open panel under 1280px, never over the chat; its expand opens the drawer", () => {
    viewport(1100)
    render()
    expect(inline()!.dataset.rail).toBeUndefined()
    click(button(section("box-yard")!, "Check SSH into the bench"))
    expect(inline()!.dataset.rail).toBe("true")
    // The rail lists no tasks, so nothing on it is selected; the Coordinator hid as the task opened, so it has no mark.
    expect(inline()!.querySelector("[aria-current]")).toBeNull()
    expect(inline()!.querySelector("button[aria-label='Coordinator']")).not.toBeNull()
    click(button(inline()!, "Show the sidebar"))
    expect(document.querySelector("[role=dialog][aria-label='Projects and tasks']")).not.toBeNull()
    act(() => closeSidebarDrawer())
    // Its swatches pick a Captain, which takes the whole width: the task closes (even beside its own Captain), and with
    // no panel needing the room the column comes back.
    click(inline()!.querySelector<HTMLButtonElement>("button[aria-label^='box-yard Captain']")!)
    expect(title()).toBe("box-yard Captain")
    expect(new URLSearchParams(location.search).get("session")).toBeNull()
    expect(inline()!.dataset.rail).toBeUndefined()
    expect(current()).toBe("box-yard, Captain, working")
  })

  it("the folded rail's Waiting on you shows its count and widens the sidebar on that section, unfolded and scrolled into view", () => {
    render()
    click(button(section("Waiting on you")!, /^Waiting on you/))
    click(button(nav()!, "Fold the sidebar"))
    expect(inline()!.dataset.rail).toBe("true")
    const waiting = inline()!.querySelector<HTMLButtonElement>("button[aria-label='Waiting on you, 2 tasks']")!
    // The count is on it as text, and its tooltip says what it counts.
    expect(waiting.textContent).toBe("2")
    expect(waiting.title).toBe("Waiting on you, 2 tasks")
    // The list shows 100–800px, and the section sits below that.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const own = (this as HTMLElement).dataset?.sidebarGroup === WAITING_FOLD ? [900, 1000] : this.classList.contains("overflow-y-auto") ? [100, 800] : [0, 0]
      return { top: own[0], bottom: own[1], y: own[0], height: own[1] - own[0], left: 0, right: 0, x: 0, width: 0, toJSON() {} } as DOMRect
    })
    click(waiting)
    // The column comes back, the same toggle as "Show the sidebar" (remembered), with no drawer over the chat.
    expect(inline()!.dataset.rail).toBeUndefined()
    expect(localStorage.getItem("box-yard:sidebar-collapsed")).toBe("false")
    expect(document.querySelector("[role=dialog]")).toBeNull()
    const head = section("Waiting on you")!.querySelector("button")!
    expect(head.getAttribute("aria-expanded")).toBe("true")
    const list = () => nav()!.querySelector<HTMLElement>(".overflow-y-auto")!
    // Scrolled just enough to show the whole section.
    expect(list().scrollTop).toBe(200)
    // A click leaves the focus where it was: no ring on the section after a mouse press.
    expect(document.activeElement).not.toBe(head)
    // Only that click scrolls there: folding and showing the sidebar again leaves the list alone.
    click(button(nav()!, "Fold the sidebar"))
    click(button(inline()!, "Show the sidebar"))
    list().scrollTop = 0
    click(button(nav()!, "Fold the sidebar"))
    click(button(inline()!, "Show the sidebar"))
    expect(list().scrollTop).toBe(0)
  })

  it("pressed from the keyboard, the rail's Waiting on you hands its focus to the section, since the button goes with the rail", () => {
    render()
    click(button(nav()!, "Fold the sidebar"))
    const waiting = inline()!.querySelector<HTMLButtonElement>("button[aria-label='Waiting on you, 2 tasks']")!
    act(() => waiting.focus())
    click(waiting)
    expect(inline()!.dataset.rail).toBeUndefined()
    expect(document.activeElement).toBe(section("Waiting on you")!.querySelector("button"))
  })

  it("beside an open panel, the rail's Waiting on you opens the drawer on that section; from the keyboard, the section takes the focus", () => {
    viewport(1100)
    render()
    click(button(section("Waiting on you")!, /^Waiting on you/))
    click(button(section("box-yard")!, "Check SSH into the bench"))
    expect(inline()!.dataset.rail).toBe("true")
    const waiting = inline()!.querySelector<HTMLButtonElement>("button[aria-label='Waiting on you, 2 tasks']")!
    act(() => waiting.focus())
    click(waiting)
    const drawer = document.querySelector<HTMLElement>("[role=dialog][aria-label='Projects and tasks']")!
    const head = drawer.querySelector<HTMLButtonElement>("section[aria-label='Waiting on you'] button")!
    expect(head.getAttribute("aria-expanded")).toBe("true")
    expect(document.activeElement).toBe(head)
    // The task stays open beside it, and the rail stays a rail.
    expect(new URLSearchParams(location.search).get("session")).toBe(ASK.id)
    expect(inline()!.dataset.rail).toBe("true")
  })

  it("with nothing waiting, the rail has no Waiting on you: there'd be no section to open", () => {
    render(APP_HOME, [RUN, OLD])
    expect(section("Waiting on you")).toBeNull()
    click(button(nav()!, "Fold the sidebar"))
    expect(inline()!.querySelector("button[aria-label^='Waiting on you']")).toBeNull()
    expect(inline()!.querySelector("button[aria-label='Coordinator']")).not.toBeNull()
  })

  it("Cody's fold sticks across reloads", () => {
    render()
    click(button(nav()!, "Fold the sidebar"))
    expect(inline()!.dataset.rail).toBe("true")
    expect(localStorage.getItem("box-yard:sidebar-collapsed")).toBe("true")
    click(button(inline()!, "Show the sidebar"))
    expect(inline()!.dataset.rail).toBeUndefined()
  })

  it("on a phone it's a drawer from the header's menu button, which a pick closes and a fold doesn't", () => {
    viewport(400, 800)
    render()
    expect(inline()).toBeNull()
    const menu = document.querySelector<HTMLButtonElement>("[data-testid=chat-panel] header button[aria-label^='Projects and tasks']")!
    expect(menu.getAttribute("aria-label")).toBe("Projects and tasks, 2 waiting on you")
    click(menu)
    const drawer = () => document.querySelector<HTMLElement>("[role=dialog][aria-label='Projects and tasks']")
    click(chevron("marketing-site"))
    expect(drawer()).not.toBeNull()
    click(button(drawer()!, "Three-pane layout"))
    expect(drawer()).toBeNull()
    expect(new URLSearchParams(location.search).get("session")).toBe(RUN.id)
  })
})

describe("a pick in the sidebar puts the caret in that chat's box", () => {
  const projectRow = (name: string) => button(section(name)!, new RegExp(`^${name}, Captain`))
  // The box focuses once the frame after it mounts is painted (lib/chatSwitch.ts useComposerFocus).
  const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0))))
  const centreBox = () => [...document.querySelectorAll<HTMLTextAreaElement>("[data-testid=chat-footer] textarea")].find((t) => t.checkVisibility())!
  const panel = (t: Task) => document.querySelector<HTMLElement>(`[role=dialog][aria-label='${t.title}']`)
  const panelBox = (t: Task) => panel(t)?.querySelector("textarea")
  const modClick = (el: Element, init: MouseEventInit) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })))

  it("a task's own box in the side panel, while its history still loads; the Coordinator's or a Captain's in the centre", async () => {
    render()
    click(button(section("box-yard")!, "Three-pane layout"))
    await frame()
    // Not the Coordinator's box behind it. fetch never answers here, so the transcript is still loading.
    expect(panelBox(RUN)).toBeTruthy()
    expect(document.activeElement).toBe(panelBox(RUN))
    // Another task, from Waiting on you: the panel swaps to it, and its box takes the caret.
    click(button(section("Waiting on you")!, "Check SSH into the bench"))
    await frame()
    expect(document.activeElement).toBe(panelBox(ASK))
    // The task's Captain takes the whole width, closing the task: the centre's box this time.
    click(projectRow("box-yard"))
    await frame()
    expect(title()).toBe("box-yard Captain")
    expect(panel(ASK)).toBeNull()
    expect(document.activeElement).toBe(centreBox())
    expect(centreBox().placeholder).toBe("Queue another message for the Captain…")
    // The Coordinator, picked with a task open beside the Captain: the task closes, and the caret is in its box.
    click(button(section("box-yard")!, "Three-pane layout"))
    await frame()
    expect(document.activeElement).toBe(panelBox(RUN))
    click(button(nav()!, "Coordinator"))
    await frame()
    expect(panel(RUN)).toBeNull()
    expect(document.activeElement).toBe(centreBox())
    expect(centreBox().placeholder).toBe("Ask the Coordinator…")
  })

  it("once the chat's first frame is painted, not in that frame: focusing restyles and lays out the page", async () => {
    render()
    click(projectRow("marketing-site"))
    // A frame's callbacks run before it's painted: the caret isn't in the box yet. Read in the frame itself, since an
    // async act() resolves a macrotask later, when the focus may have landed.
    let inFrame: Element | null = null
    await act(() => new Promise<void>((r) => requestAnimationFrame(() => r(void (inFrame = document.activeElement)))))
    expect(title()).toBe("marketing-site Captain")
    expect(inFrame).not.toBe(centreBox())
    await frame()
    expect(document.activeElement).toBe(centreBox())
  })

  it("a mouse press on the row leaves the focus where it is until then: the row taking it blurred the box on screen", async () => {
    render()
    click(projectRow("box-yard"))
    await frame()
    // Whether the press kept the browser from moving the focus to the row (happy-dom doesn't move it either way).
    const press = (el: Element, init: MouseEventInit = {}) => {
      const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...init })
      act(() => void el.dispatchEvent(e))
      return e.defaultPrevented
    }
    // A Captain, the Coordinator, a task: the box still has the caret until the picked chat's box takes it.
    expect(press(projectRow("marketing-site"))).toBe(true)
    expect(press(button(nav()!, "Coordinator"))).toBe(true)
    expect(press(button(section("box-yard")!, "Three-pane layout"))).toBe(true)
    expect(document.activeElement).toBe(centreBox())
    // A press whose pick focuses no box moves it as ever: with a modifier, or another button.
    expect(press(projectRow("marketing-site"), { ctrlKey: true })).toBe(false)
    expect(press(projectRow("marketing-site"), { button: 2 })).toBe(false)
    // Nor on a touch screen.
    const media = window.matchMedia.bind(window)
    vi.stubGlobal("matchMedia", (q: string) => (/coarse/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : media(q)))
    expect(press(projectRow("marketing-site"))).toBe(false)
  })

  it("not on a ⌘/Ctrl-click", async () => {
    render()
    modClick(projectRow("marketing-site"), { ctrlKey: true })
    await frame()
    expect(title()).toBe("marketing-site Captain")
    expect(document.activeElement).not.toBe(centreBox())
    modClick(button(section("marketing-site")!, "Refresh the portfolio"), { metaKey: true })
    await frame()
    expect(panelBox(PR)).toBeTruthy()
    expect(document.activeElement).not.toBe(panelBox(PR))
  })

  it("not once Cody presses somewhere else, say to select text in the transcript, before the box takes it", async () => {
    render()
    click(button(section("box-yard")!, "Three-pane layout"))
    act(() => void panel(RUN)!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })))
    await frame()
    expect(document.activeElement).not.toBe(panelBox(RUN))
  })

  it("not on a touch screen, where the keyboard would cover what was just opened", async () => {
    const media = window.matchMedia.bind(window)
    vi.stubGlobal("matchMedia", (q: string) => (/coarse/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : media(q)))
    render()
    click(projectRow("marketing-site"))
    await frame()
    expect(title()).toBe("marketing-site Captain")
    expect(document.activeElement).not.toBe(centreBox())
    click(button(section("marketing-site")!, "Refresh the portfolio"))
    await frame()
    expect(panelBox(PR)).toBeTruthy()
    expect(document.activeElement).not.toBe(panelBox(PR))
  })
})

describe("the Coordinator or a Captain picked in the sidebar takes the whole width: the task beside it closes", () => {
  const projectRow = (name: string) => button(section(name)!, new RegExp(`^${name}, Captain`))
  const shown = () => new URLSearchParams(location.search).get("session")
  const panel = (t: Task) => document.querySelector<HTMLElement>(`[role=dialog][aria-label='${t.title}']`)
  const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))

  it("its own project's Captain, already in the centre: the task closes, and Back opens it again", async () => {
    render()
    click(projectRow("box-yard"))
    click(button(section("box-yard")!, "Three-pane layout"))
    expect(shown()).toBe(RUN.id)
    expect(title()).toBe("box-yard Captain")
    click(projectRow("box-yard"))
    expect(shown()).toBeNull()
    expect(panel(RUN)).toBeNull()
    expect(document.querySelector("[data-testid=side-thread]")).toBeNull()
    expect(title()).toBe("box-yard Captain")
    expect(current()).toBe("box-yard, Captain, working")
    // A step in history of its own: Back brings the task back beside its Captain, and Forward closes it again.
    act(() => history.back())
    await settle()
    expect(shown()).toBe(RUN.id)
    expect(panel(RUN)).not.toBeNull()
    expect(title()).toBe("box-yard Captain")
    act(() => history.forward())
    await settle()
    expect(shown()).toBeNull()
    expect(panel(RUN)).toBeNull()
  })

  it("another project's Captain, and the Coordinator; a task row still opens or switches the task", () => {
    render()
    click(button(section("box-yard")!, "Three-pane layout"))
    expect(title()).toContain("Coordinator")
    click(projectRow("marketing-site"))
    expect(shown()).toBeNull()
    expect(title()).toBe("marketing-site Captain")
    // Task rows open just the task, and switch it; the chat they hid stays as it was.
    click(button(section("marketing-site")!, "Refresh the portfolio"))
    expect(shown()).toBe(PR.id)
    click(button(section("box-yard")!, "Three-pane layout"))
    expect(shown()).toBe(RUN.id)
    expect(new URLSearchParams(location.search).get("stack")).toBeNull()
    expect(document.querySelector<HTMLElement>("[data-testid=columns]")!.dataset.chat).toBe("closed")
    expect(title()).toBe("marketing-site Captain")
    click(button(nav()!, "Coordinator"))
    expect(shown()).toBeNull()
    expect(panel(RUN)).toBeNull()
    expect(title()).toContain("Coordinator")
    expect(current()).toBe("Coordinator")
  })

  it("a Captain under More projects too, the task's own", () => {
    // A finished task of a quiet project, opened from a link (or the palette).
    render(`${APP_HOME}?session=${OLD.id}`)
    expect(shown()).toBe(OLD.id)
    click(button(section("More projects")!, "More projects"))
    click(button(section("More projects")!, /^photo-tools/))
    expect(shown()).toBeNull()
    expect(title()).toBe("photo-tools Captain")
  })

  it("from the drawer, where the sidebar isn't a column: the drawer and the task both close", () => {
    // Too narrow for the sidebar beside the chat, wide enough for the task beside it rather than over it.
    viewport(700)
    render()
    const menu = () => document.querySelector<HTMLButtonElement>("[data-testid=chat-panel] header button[aria-label^='Projects and tasks']")!
    const drawer = () => document.querySelector<HTMLElement>("[role=dialog][aria-label='Projects and tasks']")
    click(menu())
    click(button(drawer()!, "Three-pane layout"))
    expect(drawer()).toBeNull()
    expect(shown()).toBe(RUN.id)
    click(menu())
    click(button(drawer()!, /^box-yard, Captain/))
    expect(drawer()).toBeNull()
    expect(shown()).toBeNull()
    expect(title()).toBe("box-yard Captain")
  })
})

describe("the logo at the top left goes to the Coordinator", () => {
  const projectRow = (name: string) => button(section(name)!, new RegExp(`^${name}, Captain`))
  const logo = (within: ParentNode = nav()!) => within.querySelector<HTMLAnchorElement>("a[aria-label='Box Yard: go to Coordinator']")!
  const shown = () => new URLSearchParams(location.search).get("session")
  const modClick = (el: Element, init: MouseEventInit) => {
    const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })
    act(() => void el.dispatchEvent(e))
    return e
  }

  it("is a link to the app's home that picks the Coordinator, as its row does: the task beside the chat closes", () => {
    render()
    click(projectRow("marketing-site"))
    click(button(section("box-yard")!, "Three-pane layout"))
    expect(title()).toBe("marketing-site Captain")
    expect(shown()).toBe(RUN.id)
    expect(logo().getAttribute("href")).toBe(APP_HOME)
    expect(logo().textContent).toContain("Box Yard")
    click(logo())
    expect(shown()).toBeNull()
    expect(title()).toContain("Coordinator")
    expect(current()).toBe("Coordinator")
  })

  it("on a phone the drawer has it too, and it closes the drawer", () => {
    viewport(400, 800)
    render()
    const menu = () => document.querySelector<HTMLButtonElement>("[data-testid=chat-panel] header button[aria-label^='Projects and tasks']")!
    const drawer = () => document.querySelector<HTMLElement>("[role=dialog][aria-label='Projects and tasks']")
    click(menu())
    click(button(drawer()!, /^marketing-site, Captain/))
    expect(drawer()).toBeNull()
    expect(title()).toBe("marketing-site Captain")
    click(menu())
    click(logo(drawer()!))
    expect(drawer()).toBeNull()
    expect(title()).toContain("Coordinator")
  })

  it("a ⌘/Ctrl, Shift or middle click is left to the browser (a new tab), and the chat here stays", () => {
    render()
    click(projectRow("marketing-site"))
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }]) expect(modClick(logo(), init).defaultPrevented).toBe(false)
    expect(title()).toBe("marketing-site Captain")
  })
})

describe("Project settings from the sidebar and the Captain's ⋯", () => {
  const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
  const dialog = (heading: string) => dialogs().find((d) => d.querySelector("h2")?.textContent === heading)
  const esc = () => act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))
  const settingsParam = () => new URLSearchParams(location.search).get("projectSettings")
  const openDrawer = () => click(document.querySelector("button[aria-label^='Projects and tasks']")!)

  it.each([400, 1440])("a project row's settings button opens them over the chat at %ipx", (width) => {
    viewport(width)
    render()
    if (width < 1000) openDrawer()
    const gear = button(section("box-yard")!, "box-yard project settings")
    gear.focus()
    click(gear)
    const settings = dialog("box-yard settings")!
    expect(settings.querySelector("[data-testid=project-identity-section]")!.textContent).toContain("Identity / Claude login")
    expect(settingsParam()).toBe(YARD.id)
    click(button(settings, "Close"))
    expect(settingsParam()).toBeNull()
    expect(dialog("box-yard settings")).toBeUndefined()
    // The chat underneath never changed; on a phone the drawer is still there, with focus back on the button.
    expect(title()).toContain("Coordinator")
    expect(document.activeElement).toBe(gear)
  })

  it("More projects rows have one too", () => {
    render()
    click(button(section("More projects")!, "More projects"))
    click(button(section("More projects")!, "photo-tools project settings"))
    expect(dialog("photo-tools settings")).toBeDefined()
    expect(settingsParam()).toBe(QUIET.id)
  })

  it.each([400, 1440])("the centre Captain's ⋯ opens (not clipped by its header) and reaches Project settings at %ipx", (width) => {
    viewport(width)
    render(`${APP_HOME}?project=${YARD.id}`)
    const chat = document.querySelector<HTMLElement>("[data-testid=captain-chat][data-centre]")!
    const trigger = button(chat, "Captain menu")
    trigger.focus()
    click(trigger)
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    const actions = dialog("Captain actions")!
    // A sheet on the body, outside the header whose overflow clipped the old popover.
    expect(chat.contains(actions)).toBe(false)
    click(button(actions, "Project settings"))
    expect(dialog("Captain actions")).toBeUndefined()
    expect(dialog("box-yard settings")).toBeDefined()
    expect(settingsParam()).toBe(YARD.id)
    esc()
    expect(settingsParam()).toBeNull()
    expect(document.querySelector("[data-testid=captain-chat][data-centre]")).toBe(chat)
    expect(document.activeElement).toBe(trigger)
  })

  it.each([400, 1440])("the Captain panel's ⋯ reaches Project settings, and Esc leaves settings first at %ipx", (width) => {
    viewport(width)
    render(`${APP_HOME}?captain=${YARD.id}`)
    const captain = document.querySelector<HTMLElement>("[data-testid=captain-chat]:not([data-centre])")!
    const trigger = button(captain, "Captain menu")
    trigger.focus()
    click(trigger)
    click(button(dialog("Captain actions")!, "Project settings"))
    expect(dialog("box-yard settings")).toBeDefined()
    const params = new URLSearchParams(location.search)
    expect([params.get("captain"), params.get("projectSettings")]).toEqual([YARD.id, YARD.id])
    esc()
    expect(settingsParam()).toBeNull()
    expect(new URLSearchParams(location.search).get("captain")).toBe(YARD.id)
    expect(document.querySelector("[data-testid=captain-chat]:not([data-centre])")).toBe(captain)
    expect(document.activeElement).toBe(trigger)
  })
})

describe("a double click on a project's rail icon also expands the sidebar on its tasks", () => {
  afterEach(() => void vi.restoreAllMocks())
  const railIcon = (name: string) => inline()!.querySelector<HTMLButtonElement>(`button[aria-label^='${name} Captain']`)!
  const chevron = (name: string) => section(name)!.querySelector<HTMLButtonElement>("button[aria-expanded]")!
  const drawer = () => document.querySelector<HTMLElement>("[role=dialog][aria-label='Projects and tasks']")
  /** A click (a tap, with pointerType "touch") at `at` ms: what makes it a double click is the time between two. */
  const clickAt = (el: Element, at: number, init: PointerEventInit = {}) => {
    const e = new PointerEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1, pointerType: "mouse", ...init })
    Object.defineProperty(e, "timeStamp", { value: at })
    act(() => void el.dispatchEvent(e))
  }
  const dblclick = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, button: 0, detail: 2 })))
  /** Cody folded box-yard's tasks, then the sidebar to its rail. */
  const folded = () => {
    render()
    click(chevron("box-yard"))
    click(button(nav()!, "Fold the sidebar"))
    expect(inline()!.dataset.rail).toBe("true")
  }

  it("a single click opens the Captain and leaves the rail folded; the tooltip says what a double click does", () => {
    folded()
    expect(railIcon("box-yard").title).toBe("box-yard Captain, 1 asking (double-click to expand)")
    clickAt(railIcon("box-yard"), 1000)
    expect(title()).toBe("box-yard Captain")
    expect(inline()!.dataset.rail).toBe("true")
    expect(localStorage.getItem("box-yard:sidebar-collapsed")).toBe("true")
  })

  it("a double click opens it, then expands the sidebar with that project's tasks unfolded and scrolled into view", () => {
    folded()
    // The list shows 100–800px, and box-yard's group sits below that.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const own = (this as HTMLElement).dataset?.sidebarGroup === YARD.id ? [900, 1000] : this.classList.contains("overflow-y-auto") ? [100, 800] : [0, 0]
      return { top: own[0], bottom: own[1], y: own[0], height: own[1] - own[0], left: 0, right: 0, x: 0, width: 0, toJSON() {} } as DOMRect
    })
    const icon = railIcon("box-yard")
    clickAt(icon, 1000)
    // The first click opened the Captain at once, without waiting to see if a second followed.
    expect(title()).toBe("box-yard Captain")
    clickAt(icon, 1150)
    expect(inline()!.dataset.rail).toBe("true")
    dblclick(icon)
    expect(inline()!.dataset.rail).toBeUndefined()
    expect(localStorage.getItem("box-yard:sidebar-collapsed")).toBe("false")
    expect(title()).toBe("box-yard Captain")
    expect(current()).toBe("box-yard, Captain, working")
    expect(chevron("box-yard").getAttribute("aria-expanded")).toBe("true")
    expect(section("box-yard")!.textContent).toContain("Three-pane layout")
    // Scrolled just enough to show the whole group.
    expect(nav()!.querySelector<HTMLElement>(".overflow-y-auto")!.scrollTop).toBe(200)
  })

  it("to a finger, two taps on one icon within 350ms are a double tap; the first tap still opens the Captain at once", () => {
    folded()
    const tap = (name: string, at: number) => clickAt(railIcon(name), at, { pointerType: "touch" })
    tap("box-yard", 1000)
    expect(title()).toBe("box-yard Captain")
    // Too far apart, or on two icons: single taps.
    tap("box-yard", 1000 + DOUBLE_TAP_MS + 50)
    tap("marketing-site", 1500)
    tap("box-yard", 1600)
    expect(inline()!.dataset.rail).toBe("true")
    expect(title()).toBe("box-yard Captain")
    tap("box-yard", 1600 + DOUBLE_TAP_MS)
    expect(inline()!.dataset.rail).toBeUndefined()
    expect(chevron("box-yard").getAttribute("aria-expanded")).toBe("true")
  })

  it("beside a panel that keeps the rail, it opens the drawer on the project", () => {
    viewport(1100)
    act(() => toggleSidebarFold(YARD.id))
    render(`${APP_HOME}?captain=${SITE.id}`)
    expect(inline()!.dataset.rail).toBe("true")
    dblclick(railIcon("box-yard"))
    const fold = drawer()!.querySelector<HTMLButtonElement>("section[aria-label='box-yard'] button[aria-expanded]")!
    expect(fold.getAttribute("aria-expanded")).toBe("true")
  })

  it("when the first click takes the rail away (it closed the task that needed the room), the second only brings the project into view", () => {
    viewport(1100)
    render()
    click(chevron("box-yard"))
    click(button(section("marketing-site")!, "Refresh the portfolio"))
    expect(inline()!.dataset.rail).toBe("true")
    clickAt(railIcon("box-yard"), 1000)
    expect(inline()!.dataset.rail).toBeUndefined()
    expect(title()).toBe("box-yard Captain")
    // The second click lands on whatever row is there now, the Coordinator's say: it doesn't pick it.
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 })
    Object.defineProperty(press, "timeStamp", { value: 1150 })
    act(() => void button(nav()!, "Coordinator").dispatchEvent(press))
    expect(press.defaultPrevented).toBe(true)
    clickAt(button(nav()!, "Coordinator"), 1200)
    expect(title()).toBe("box-yard Captain")
    expect(chevron("box-yard").getAttribute("aria-expanded")).toBe("true")
    // A click after that is a click.
    clickAt(button(nav()!, "Coordinator"), 2000)
    expect(title()).toContain("Coordinator")
  })
})

describe("Mark done from the sidebar: a ✓ on every row ready for review", () => {
  const IDLE = task("task_idle01", YARD.id, "Write the changelog", "idle", { lastActiveAt: now - 3 * 24 * 3_600_000 })
  const LOGO = task("task_logo01", SITE.id, "Design the logo", "idle")
  const kid = (n: number, status: TaskStatus = "idle") =>
    task(`task_logod${n}`, SITE.id, `Logo designer ${n}`, status, { parentTaskId: LOGO.id, rootTaskId: LOGO.id, createdAt: now - 50_000 + n })
  const checks = (within: ParentNode) => [...within.querySelectorAll<HTMLButtonElement>("[data-testid=sidebar-mark-done]")]
  const labels = (within: ParentNode) => checks(within).map((b) => b.getAttribute("aria-label"))
  const posts = () => vi.mocked(fetch).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")

  afterEach(() => {
    act(() => {
      for (const id of [IDLE.id, LOGO.id, PR.id]) undoClose(id)
    })
    resetClosedTasks()
  })

  it("idle and PR-ready rows end with a ✓ that is always drawn, 44px to a finger; running and asking rows have none", () => {
    render(APP_HOME, [ASK, RUN, PR, IDLE, LOGO, kid(1), kid(2)])
    expect(labels(section("box-yard")!)).toEqual(["Mark Write the changelog done"])
    // A tree's row names what it closes with it.
    expect(labels(section("marketing-site")!)).toEqual([
      "Mark Refresh the portfolio done",
      "Mark Design the logo and its 2 sub-tasks done",
      "Mark Logo designer 1 done",
      "Mark Logo designer 2 done",
    ])
    expect(labels(section("Waiting on you")!)).toEqual(["Mark Refresh the portfolio done"])
    for (const b of checks(nav()!)) {
      // Not a hover reveal and not in a menu: there to press.
      expect(b.className).not.toMatch(/opacity-0|hidden/)
      expect(b.className).toContain("pointer-coarse:h-11")
      expect(b.closest("[role=menu], [role=dialog]")).toBeNull()
    }
  })

  it("a ✓ marks the task done at once, with Undo, and sends nothing in the undo window", () => {
    render(APP_HOME, [ASK, RUN, IDLE])
    click(checks(section("box-yard")!)[0]!)
    expect(section("box-yard")!.textContent).not.toContain("Write the changelog")
    expect(currentToasts().map((t) => [t.title, t.body, t.action?.label])).toEqual([["Marked done", "Write the changelog", "Undo"]])
    expect(posts()).toEqual([])
    act(() => currentToasts()[0]!.action!.onClick())
    expect(section("box-yard")!.textContent).toContain("Write the changelog")
  })

  it("a tree's ✓ closes the whole tree, which leaves together; while a sub-task runs or asks, the tree has none", () => {
    render(APP_HOME, [ASK, RUN, LOGO, kid(1), kid(2)])
    const site = () => section("marketing-site")
    click(checks(site()!)[0]!)
    // Its sub-tasks don't stay behind as rows of their own while the close is on its way.
    expect(site()?.textContent ?? "").not.toMatch(/Design the logo|Logo designer/)
    act(() => currentToasts()[0]!.action!.onClick())
    expect(site()!.textContent).toContain("Logo designer 2")

    for (const status of ["working", "needs_input"] as const) {
      act(() => root.unmount())
      root = createRoot(host)
      render(APP_HOME, [ASK, RUN, LOGO, kid(1), kid(2, status)])
      expect(labels(site()!), status).toEqual(["Mark Logo designer 1 done"])
    }
  })
})
