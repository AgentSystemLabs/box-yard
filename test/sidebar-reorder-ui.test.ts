// @vitest-environment happy-dom
// Rearranging the sidebar (components/SidebarReorder.tsx): Alt+arrows, the Move menu, a mouse drag and a finger's
// hold-then-drag all save the same order on the server, the tree stays one tab stop, and a screen reader hears each move.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { warmLazyParts } from "../web/src/components/LazyPart.js"
import { HOLD_MS } from "../web/src/components/SidebarReorder.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { keys } from "../web/src/lib/queries.js"
import { setChatProjectFilter } from "../web/src/lib/projectBar.js"
import { WAITING_FOLD, captainKey, closeSidebarDrawer, coordinatorKey, openSidebarDrawer, setSidebarCollapsed, setTreeFolds, taskKey, unfoldSidebarGroup } from "../web/src/lib/sidebar.js"
import { resetColumns } from "../web/src/lib/columns.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import type { Project, Task, TaskStatus } from "../shared/types"
import { APP_HOME } from "../web/src/lib/navigation.js"
import { treeItems } from "./sidebarTree.js"
import { resetDrafts } from "../web/src/lib/composerDraft.js"

beforeAll(() => warmLazyParts())

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const project = (id: string, name: string) => ({ id, name, repo: null, description: "", notes: [], envKeys: [], baseBranch: "main", runner: "box", identityId: "idn_default", gpuMachine: { gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null }, docker: { image: null, dockerfile: null }, createdAt: now, color: null }) as unknown as Project
let order = 0
const task = (id: string, projectId: string, title: string, status: TaskStatus, parent?: Task, extra: Partial<Task> = {}) =>
  ({
    id, projectId, title, status, prompt: "", prUrl: null, prState: null, prMergedAt: null, previews: [], waitFor: [], question: null, error: null, scheduleId: null, outcome: null, turnCount: 1, pendingCount: 0,
    parentTaskId: parent?.id ?? null,
    rootTaskId: parent ? parent.rootTaskId ?? parent.id : null,
    subtaskDepth: parent ? (parent.subtaskDepth ?? 0) + 1 : 0,
    // Older ids are created later, so the automatic order (newest first) lists them as written below.
    createdAt: now - 60_000 - order++,
    updatedAt: now - 60_000,
    ...extra,
  }) as unknown as Task

const YARD = project("prj_yard01", "box-yard")
const SITE = project("prj_site01", "marketing-site")
const PHOTO = project("prj_photo1", "photo-tools")
const DOCS = project("prj_docs01", "docs")
const PROJECTS = [YARD, PHOTO, SITE, DOCS]
// box-yard's tasks, all working, so the automatic order is this one.
const API = task("task_api001", YARD.id, "Build the API", "working")
const PLAN = task("task_plan01", YARD.id, "Plan the launch", "working")
const TESTS = task("task_test01", YARD.id, "Write the tests", "working")
const ASK = task("task_ask001", YARD.id, "Check the bench", "needs_input", undefined, { createdAt: now - 90_000 })
// Sub-tasks list in spawn order: oldest first.
const POST = task("task_post01", YARD.id, "Write the post", "working", PLAN, { createdAt: now - 50_000 })
const IMAGES = task("task_imgs01", YARD.id, "Pick the images", "working", PLAN, { createdAt: now - 40_000 })
const VIDEO = task("task_vid001", YARD.id, "Cut the video", "working", PLAN, { createdAt: now - 30_000 })
const PR = task("task_pr0001", SITE.id, "Refresh the portfolio", "pr_ready", undefined, { prUrl: "https://github.com/acme/site/pull/19" })
const TASKS = [API, PLAN, TESTS, ASK, POST, IMAGES, VIDEO, PR]

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
let fetchMock: ReturnType<typeof vi.fn>
const viewport = (width: number, height = 900) => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height })

function render(tasks: Task[] = TASKS) {
  history.replaceState(null, "", APP_HOME)
  sessionStorage.setItem("box-yard:landed", "1")
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.agentSettings, { settings: DEFAULT_SETTINGS, sources: {}, defaults: DEFAULT_SETTINGS })
  qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.chat, [])
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, tasks)
  qc.setQueryData(keys.projects, PROJECTS)
  for (const t of tasks) qc.setQueryData(keys.taskMessages(t.id), [])
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications, keys.scheduleRuns]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
  return qc
}

const nav = () => document.querySelector<HTMLElement>("nav[aria-label='Projects and tasks']")!
const tree = () => nav().querySelector<HTMLElement>("[role=tree]")!
const items = () => treeItems(tree())
const at = (key: string) => tree().querySelector<HTMLElement>(`[data-tree-key="${key}"]`)!
const row = (t: Task, spot: "project" | "waiting" = "project") => at(taskKey(t.id, spot))
const head = (p: Project) => at(captainKey(p.id))
const focusedKey = () => document.activeElement?.getAttribute("data-tree-key") ?? null
const focus = (el: HTMLElement) => act(() => el.focus())
const stops = () => items().filter((i) => i.getAttribute("tabindex") === "0").map((i) => i.dataset.treeKey)
/** The task ids under a project, top to bottom, sub-tasks after their parent. */
const under = (p: Project) => [...at(captainKey(p.id)).parentElement!.querySelectorAll<HTMLElement>("[role=treeitem][data-tree-key^='task:']")].map((i) => i.dataset.treeKey!.slice(5, -8))
/** The projects' head rows, top to bottom: the shown ones, then More projects' once it's unfolded. */
const projects = () => items().filter((i) => i.dataset.treeKey!.startsWith("captain:")).map((i) => i.dataset.treeKey!.slice(8))
/** Let the cache tell the sidebar, and the sidebar draw. */
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
const press = async (key: string, init: KeyboardEventInit = {}, target: Element = document.activeElement ?? document.body) => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })
  act(() => void target.dispatchEvent(e))
  await settle()
  return e
}
const click = (el: Element) => {
  const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 })
  act(() => void el.dispatchEvent(e))
  return e
}
const session = () => new URLSearchParams(location.search).get("session")
/** What a screen reader was told last. */
const said = () => nav().querySelector("[role=status][aria-live=polite]")!.textContent
const menu = () => document.querySelector<HTMLElement>("[role=menu]")
const menuItems = () => [...(menu()?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])].map((i) => i.textContent)
const choose = async (label: string) => {
  click([...menu()!.querySelectorAll<HTMLElement>("[role=menuitem]")].find((i) => i.textContent === label)!)
  await settle()
}
const rightClick = (el: Element) => {
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })
  act(() => void el.dispatchEvent(e))
  return e
}
/** The order saves sent to the server: [path, body]. */
const saves = () =>
  fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith("/order") && init?.method === "PUT").map(([url, init]) => [String(url), JSON.parse(init.body as string)])

// happy-dom lays nothing out: every row is 40px tall, in the order the tree lists them, and a box spans its rows.
const ROW_H = 40
const rect = (top: number, bottom: number) => ({ top, bottom, left: 8, right: 248, width: 240, height: bottom - top, x: 8, y: top, toJSON: () => ({}) }) as DOMRect
function fakeLayout() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const all = items()
    const own = (this.matches("[role=treeitem]") ? [this] : treeItems(this)).map((i) => all.indexOf(i)).filter((i) => i >= 0)
    return own.length ? rect(Math.min(...own) * ROW_H, (Math.max(...own) + 1) * ROW_H) : rect(0, 0)
  })
}
/** The middle of a row, as a pointer's y. */
const middle = (el: HTMLElement) => (el.getBoundingClientRect().top + el.getBoundingClientRect().bottom) / 2
const pointer = (type: string, target: EventTarget, y: number, pointerType: "mouse" | "touch" = "mouse", extra: PointerEventInit = {}) => {
  const e = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType, button: 0, clientX: 100, clientY: y, ...extra })
  act(() => void target.dispatchEvent(e))
  return e
}
const mark = () => document.querySelector<HTMLElement>("[data-reorder-mark]")!
const line = () => document.querySelector<HTMLElement>("[data-reorder-line]")!
const frame = () => act(async () => new Promise<void>((r) => requestAnimationFrame(() => r())))
const wait = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)))

beforeEach(() => {
  resetDrafts()
  localStorage.clear()
  sessionStorage.clear()
  viewport(1440)
  fetchMock = vi.fn((url: unknown, init?: RequestInit) =>
    String(url).endsWith("/order") && init?.method === "PUT" ? Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })) : new Promise<Response>(() => {}),
  )
  vi.stubGlobal("fetch", fetchMock)
  vi.stubGlobal("EventSource", FakeEventSource)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
    // Deferred availability queries must reach the stub before fetch is restored.
    await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)))
  })
  host.remove()
  document.body.innerHTML = ""
  for (const t of currentToasts()) dismiss(t.id)
  act(() => {
    setChatProjectFilter(null)
    resetColumns()
    setSidebarCollapsed(false)
    closeSidebarDrawer()
    setTreeFolds({})
    for (const key of [YARD.id, SITE.id, PHOTO.id, DOCS.id, WAITING_FOLD]) unfoldSidebarGroup(key)
  })
  viewport(1024, 768)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("rearranging with the keyboard", () => {
  it("Alt+↓ moves a task one place down its project's list, saves it, keeps the focus on it and says where it is", async () => {
    render()
    expect(under(YARD)).toEqual([ASK.id, API.id, PLAN.id, POST.id, IMAGES.id, VIDEO.id, TESTS.id])
    focus(row(API))
    const e = await press("ArrowDown", { altKey: true })
    expect(e.defaultPrevented).toBe(true)
    expect(under(YARD)).toEqual([ASK.id, PLAN.id, POST.id, IMAGES.id, VIDEO.id, API.id, TESTS.id])
    expect(saves()).toEqual([[`/api/projects/${YARD.id}/tasks/order`, { parentTaskId: null, ids: [ASK.id, PLAN.id, API.id, TESTS.id] }]])
    expect(focusedKey()).toBe(taskKey(API.id, "project"))
    expect(said()).toBe("Build the API moved to 3 of 4")
    // Still one tab stop, on the row that moved, and its place in the list is the new one.
    expect(stops()).toEqual([taskKey(API.id, "project")])
    expect([row(API).getAttribute("aria-posinset"), row(API).getAttribute("aria-setsize")]).toEqual(["3", "4"])
  })

  it("Alt+Shift+↑ and ↓ go to the top and the bottom; at an end the row says so and nothing is saved", async () => {
    render()
    focus(row(TESTS))
    await press("ArrowUp", { altKey: true, shiftKey: true })
    expect(under(YARD).filter((id) => ![POST.id, IMAGES.id, VIDEO.id].includes(id))).toEqual([TESTS.id, ASK.id, API.id, PLAN.id])
    expect(said()).toBe("Write the tests moved to 1 of 4")
    expect(saves()).toHaveLength(1)

    const again = await press("ArrowUp", { altKey: true })
    expect(again.defaultPrevented).toBe(true)
    expect(said()).toBe("Write the tests is already first")
    expect(saves()).toHaveLength(1)

    await press("ArrowDown", { altKey: true, shiftKey: true })
    expect(saves().at(-1)).toEqual([`/api/projects/${YARD.id}/tasks/order`, { parentTaskId: null, ids: [ASK.id, API.id, PLAN.id, TESTS.id] }])
    expect(said()).toBe("Write the tests moved to 4 of 4")
    await press("ArrowDown", { altKey: true })
    expect(said()).toBe("Write the tests is already last")
    expect(focusedKey()).toBe(taskKey(TESTS.id, "project"))
  })

  it("a sub-task moves among its parent's sub-tasks, and the save names the parent", async () => {
    render()
    focus(row(VIDEO))
    await press("ArrowUp", { altKey: true })
    expect(under(YARD)).toEqual([ASK.id, API.id, PLAN.id, POST.id, VIDEO.id, IMAGES.id, TESTS.id])
    expect(saves()).toEqual([[`/api/projects/${YARD.id}/tasks/order`, { parentTaskId: PLAN.id, ids: [POST.id, VIDEO.id, IMAGES.id] }]])
    expect(said()).toBe("Cut the video moved to 2 of 3")
    // It can't leave its parent: at the top of the sub-tasks it stops.
    await press("ArrowUp", { altKey: true })
    await press("ArrowUp", { altKey: true })
    expect(said()).toBe("Cut the video is already first")
    expect(under(YARD)).toEqual([ASK.id, API.id, PLAN.id, VIDEO.id, POST.id, IMAGES.id, TESTS.id])
    expect(row(VIDEO).getAttribute("aria-level")).toBe("3")
  })

  it("a project moves among the projects shown, its tasks with it; More projects' stay where they are", async () => {
    render()
    expect(projects()).toEqual([YARD.id, SITE.id])
    focus(head(YARD))
    await press("ArrowDown", { altKey: true })
    expect(projects()).toEqual([SITE.id, YARD.id])
    // Every project goes to the server; photo-tools and docs keep their places between the two that swapped.
    expect(saves()).toEqual([["/api/projects/order", { ids: [SITE.id, PHOTO.id, YARD.id, DOCS.id] }]])
    expect(said()).toBe("box-yard moved to 2 of 2")
    expect(focusedKey()).toBe(captainKey(YARD.id))
    expect(under(YARD)).toHaveLength(7)
  })

  it("the projects under More projects rearrange among themselves", async () => {
    render()
    click(at("group:more").querySelector("button")!)
    expect(projects()).toEqual([YARD.id, SITE.id, PHOTO.id, DOCS.id])
    focus(head(DOCS))
    await press("ArrowUp", { altKey: true })
    expect(projects()).toEqual([YARD.id, SITE.id, DOCS.id, PHOTO.id])
    expect(saves()).toEqual([["/api/projects/order", { ids: [YARD.id, DOCS.id, SITE.id, PHOTO.id] }]])
  })

  it("rows that don't move ignore it, and the plain arrows still walk the tree", async () => {
    render()
    for (const el of [at(coordinatorKey), row(ASK, "waiting"), row(PR)]) {
      focus(el)
      const e = await press("ArrowDown", { altKey: true })
      expect(e.defaultPrevented).toBe(false)
      expect(document.activeElement).toBe(el)
    }
    expect(saves()).toEqual([])
    focus(row(API))
    await press("ArrowDown")
    expect(focusedKey()).toBe(taskKey(PLAN.id, "project"))
    expect(saves()).toEqual([])
  })

  it("an order that arrives from the server (another device's move) redraws the list", async () => {
    const qc = render()
    act(() => void qc.setQueryData(keys.tasks, TASKS.map((t) => (t.id === TESTS.id ? { ...t, sortOrder: 0 } : t.id === ASK.id ? { ...t, sortOrder: 1 } : t))))
    await settle()
    // The two placed ones, in that order, under the ones nobody placed.
    expect(under(YARD)).toEqual([API.id, PLAN.id, POST.id, IMAGES.id, VIDEO.id, TESTS.id, ASK.id])
  })
})

describe("the Move menu", () => {
  it("a right click on a row opens it with the moves that row has; picking one moves it and the focus returns", async () => {
    render()
    const e = rightClick(row(API).querySelector("button")!)
    expect(e.defaultPrevented).toBe(true)
    expect(menu()!.getAttribute("aria-label")).toBe("Move Build the API")
    expect(menuItems()).toEqual(["Move up", "Move down", "Move to top", "Move to bottom"])
    expect(document.activeElement?.textContent).toBe("Move up")

    await choose("Move to bottom")
    expect(menu()).toBeNull()
    expect(under(YARD).at(-1)).toBe(API.id)
    expect(saves()).toEqual([[`/api/projects/${YARD.id}/tasks/order`, { parentTaskId: null, ids: [ASK.id, PLAN.id, TESTS.id, API.id] }]])
    expect(focusedKey()).toBe(taskKey(API.id, "project"))
    expect(said()).toBe("Build the API moved to 4 of 4")
  })

  it("offers only the moves there are: none up for the first row, none down for the last", () => {
    render()
    rightClick(row(ASK))
    expect(menuItems()).toEqual(["Move down", "Move to bottom"])
    rightClick(row(VIDEO))
    expect(menu()!.getAttribute("aria-label")).toBe("Move Cut the video")
    expect(menuItems()).toEqual(["Move up", "Move to top"])
    rightClick(head(SITE))
    expect(menuItems()).toEqual(["Move up", "Move to top"])
  })

  it("Shift+F10 and the Menu key open it from the keyboard; Escape closes it, back on the row", async () => {
    render()
    focus(row(PLAN))
    const e = await press("F10", { shiftKey: true })
    expect(e.defaultPrevented).toBe(true)
    expect(menuItems()).toEqual(["Move up", "Move down", "Move to top", "Move to bottom"])
    await press("Escape")
    expect(menu()).toBeNull()
    expect(focusedKey()).toBe(taskKey(PLAN.id, "project"))
    await press("ContextMenu")
    expect(menu()).not.toBeNull()
    await choose("Move up")
    expect(under(YARD).slice(0, 2)).toEqual([ASK.id, PLAN.id])
    expect(focusedKey()).toBe(taskKey(PLAN.id, "project"))
  })

  it("Back to automatic order shows once a list has places, and clears them", async () => {
    // "Check the bench" was put last: without its place it's first, as the one that needs an answer.
    render(TASKS.map((t) => (t.id === ASK.id ? { ...t, sortOrder: 0 } : t)))
    expect(under(YARD).filter((id) => ![POST.id, IMAGES.id, VIDEO.id].includes(id))).toEqual([API.id, PLAN.id, TESTS.id, ASK.id])
    rightClick(row(PLAN))
    expect(menuItems()).toEqual(["Move up", "Move down", "Move to top", "Move to bottom", "Back to automatic order"])
    await choose("Back to automatic order")
    expect(saves()).toEqual([[`/api/projects/${YARD.id}/tasks/order`, { parentTaskId: null, ids: [API.id, PLAN.id, TESTS.id, ASK.id], auto: true }]])
    expect(under(YARD).filter((id) => ![POST.id, IMAGES.id, VIDEO.id].includes(id))).toEqual([ASK.id, API.id, PLAN.id, TESTS.id])
    expect(said()).toBe("Tasks back in automatic order")
    expect(focusedKey()).toBe(taskKey(PLAN.id, "project"))
    // With no places left there is nothing to go back to, and sub-tasks nobody placed never had any.
    rightClick(row(PLAN))
    expect(menuItems()).toEqual(["Move up", "Move down", "Move to top", "Move to bottom"])
    rightClick(row(IMAGES))
    expect(menuItems()).toEqual(["Move up", "Move down", "Move to top", "Move to bottom"])
  })

  it("rows that don't move keep the browser's own menu: the Coordinator, Waiting on you, a list of one, a PR's link", () => {
    render()
    for (const el of [at(coordinatorKey), row(ASK, "waiting"), row(PR), at("group:more")]) {
      expect(rightClick(el).defaultPrevented).toBe(false)
      expect(menu()).toBeNull()
    }
    click(at("group:more").querySelector("button")!)
    expect(rightClick(head(PHOTO)).defaultPrevented).toBe(true)
    expect(menuItems()).toEqual(["Move down", "Move to bottom"])
  })

  it("in the phone's drawer, Escape closes the menu and leaves the drawer open", async () => {
    viewport(400)
    render()
    act(() => openSidebarDrawer())
    const drawer = () => document.querySelector<HTMLElement>("[role=dialog][aria-label='Projects and tasks']")
    const inDrawer = (key: string) => drawer()!.querySelector<HTMLElement>(`[data-tree-key="${key}"]`)!
    rightClick(inDrawer(taskKey(API.id, "project")))
    expect(menuItems()).toEqual(["Move up", "Move down", "Move to top", "Move to bottom"])
    await press("Escape")
    expect(menu()).toBeNull()
    expect(drawer()).not.toBeNull()
    expect(document.activeElement).toBe(inDrawer(taskKey(API.id, "project")))
  })
})

describe("dragging", () => {
  beforeEach(fakeLayout)

  it("a mouse drags a task to a gap: a line shows where it lands, the drop saves it, and its click opens nothing", async () => {
    render()
    const from = row(API).querySelector<HTMLElement>("[data-open-task]")!
    pointer("pointerdown", from, middle(row(API)))
    // A few pixels are still a click.
    pointer("pointermove", window, middle(row(API)) + 3)
    await frame()
    expect(line().style.display).not.toBe("block")
    // Past the last row of the list.
    pointer("pointermove", window, middle(row(TESTS)) + 15)
    await frame()
    expect(mark().style.display).toBe("block")
    expect(mark().style.top).toBe(`${row(API).getBoundingClientRect().top}px`)
    expect(line().style.display).toBe("block")
    expect(line().style.top).toBe(`${row(TESTS).getBoundingClientRect().bottom - 1}px`)
    // The rows it passes don't light up as if a click would open them.
    expect(tree().style.pointerEvents).toBe("none")
    expect(document.documentElement.style.cursor).toBe("grabbing")
    expect(saves()).toEqual([])

    pointer("pointerup", window, middle(row(TESTS)) + 15)
    const opened = click(from)
    await settle()
    expect(opened.defaultPrevented).toBe(true)
    expect(session()).toBeNull()
    expect(mark().style.display).toBe("none")
    expect(line().style.display).toBe("none")
    expect([tree().style.pointerEvents, document.documentElement.style.cursor]).toEqual(["", ""])
    expect(under(YARD).at(-1)).toBe(API.id)
    expect(saves()).toEqual([[`/api/projects/${YARD.id}/tasks/order`, { parentTaskId: null, ids: [ASK.id, PLAN.id, TESTS.id, API.id] }]])
    expect(said()).toBe("Build the API moved to 4 of 4")

    // The next click is an ordinary one.
    click(row(API).querySelector<HTMLElement>("[data-open-task]")!)
    expect(session()).toBe(API.id)
  })

  it("a task with sub-tasks is one block: a drop over them counts as below it, and they come along", async () => {
    render()
    const from = row(ASK).querySelector<HTMLElement>("[data-open-task]")!
    pointer("pointerdown", from, middle(row(ASK)))
    // Over the last sub-task of "Plan the launch": past the middle of its block.
    pointer("pointermove", window, middle(row(VIDEO)))
    pointer("pointerup", window, middle(row(VIDEO)))
    await settle()
    expect(under(YARD)).toEqual([API.id, PLAN.id, POST.id, IMAGES.id, VIDEO.id, ASK.id, TESTS.id])
    expect(saves()).toEqual([[`/api/projects/${YARD.id}/tasks/order`, { parentTaskId: null, ids: [API.id, PLAN.id, ASK.id, TESTS.id] }]])
  })

  it("a sub-task dragged past its siblings stops at their end: it never leaves its parent", async () => {
    render()
    pointer("pointerdown", row(POST), middle(row(POST)))
    pointer("pointermove", window, middle(head(SITE)))
    pointer("pointerup", window, middle(head(SITE)))
    await settle()
    expect(under(YARD)).toEqual([ASK.id, API.id, PLAN.id, IMAGES.id, VIDEO.id, POST.id, TESTS.id])
    expect(saves()).toEqual([[`/api/projects/${YARD.id}/tasks/order`, { parentTaskId: PLAN.id, ids: [IMAGES.id, VIDEO.id, POST.id] }]])
    expect(under(SITE)).toEqual([PR.id])
  })

  it("a project drags with its tasks, above or below the other projects", async () => {
    render()
    pointer("pointerdown", head(SITE).querySelector<HTMLElement>("[data-open-captain]")!, middle(head(SITE)))
    pointer("pointermove", window, middle(head(YARD)) - 10)
    await frame()
    expect(line().style.top).toBe(`${head(YARD).getBoundingClientRect().top - 1}px`)
    pointer("pointerup", window, middle(head(YARD)) - 10)
    await settle()
    expect(projects()).toEqual([SITE.id, YARD.id])
    expect(saves()).toEqual([["/api/projects/order", { ids: [SITE.id, PHOTO.id, YARD.id, DOCS.id] }]])
  })

  it("a drop where the row already is, or Escape, changes nothing", async () => {
    render()
    pointer("pointerdown", row(PLAN), middle(row(PLAN)))
    pointer("pointermove", window, middle(row(PLAN)) + 12)
    await frame()
    expect(mark().style.display).toBe("block")
    expect(line().style.display).toBe("none")
    pointer("pointerup", window, middle(row(PLAN)) + 12)
    await settle()
    expect(saves()).toEqual([])

    pointer("pointerdown", row(API), middle(row(API)))
    pointer("pointermove", window, middle(row(TESTS)) + 15)
    await frame()
    expect(line().style.display).toBe("block")
    const esc = await press("Escape", {}, document.body)
    expect(esc.defaultPrevented).toBe(true)
    expect(mark().style.display).toBe("none")
    pointer("pointerup", window, middle(row(TESTS)) + 15)
    await settle()
    expect(saves()).toEqual([])
    expect(under(YARD)[1]).toBe(API.id)
  })

  it("the right button, a PR's link and rows that don't move start no drag", async () => {
    render()
    const tries: [Element, PointerEventInit][] = [[row(API), { button: 2 }], [row(PR).querySelector("a[href]")!, {}], [row(ASK, "waiting"), {}], [at(coordinatorKey), {}]]
    for (const [el, extra] of tries) {
      pointer("pointerdown", el, 20, "mouse", extra)
      pointer("pointermove", window, 300)
      await frame()
      expect(mark().style.display).not.toBe("block")
      pointer("pointerup", window, 300)
    }
    await settle()
    expect(saves()).toEqual([])
  })
})

describe("a finger", () => {
  beforeEach(fakeLayout)

  it("that moves right away is scrolling: nothing is picked up", async () => {
    render()
    pointer("pointerdown", row(API), middle(row(API)), "touch")
    pointer("pointermove", window, middle(row(API)) + 30, "touch")
    await wait(HOLD_MS + 50)
    pointer("pointermove", window, middle(row(TESTS)) + 15, "touch")
    await frame()
    expect(mark().style.display).not.toBe("block")
    pointer("pointerup", window, middle(row(TESTS)) + 15, "touch")
    await settle()
    expect(saves()).toEqual([])
    expect(menu()).toBeNull()
  })

  it("that holds a row picks it up, then drags it; the list doesn't scroll under it", async () => {
    render()
    const moveOf = () => {
      const e = new Event("touchmove", { bubbles: true, cancelable: true })
      row(API).dispatchEvent(e)
      return e.defaultPrevented
    }
    pointer("pointerdown", row(API), middle(row(API)), "touch")
    // Until the hold, a move is the list's to scroll.
    expect(moveOf()).toBe(false)
    await wait(HOLD_MS + 50)
    expect(mark().style.display).toBe("block")
    expect(line().style.display).not.toBe("block")
    expect(moveOf()).toBe(true)
    pointer("pointermove", window, middle(row(ASK)) - 10, "touch")
    await frame()
    expect(line().style.display).toBe("block")
    pointer("pointerup", window, middle(row(ASK)) - 10, "touch")
    await settle()
    expect(under(YARD)[0]).toBe(API.id)
    expect(saves()).toEqual([[`/api/projects/${YARD.id}/tasks/order`, { parentTaskId: null, ids: [API.id, ASK.id, PLAN.id, TESTS.id] }]])
    expect(moveOf()).toBe(false)
  })

  it("that holds a row and lets go opens the Move menu, and the tap opens nothing", async () => {
    render()
    const button = row(API).querySelector<HTMLElement>("[data-open-task]")!
    pointer("pointerdown", button, middle(row(API)), "touch")
    await wait(HOLD_MS + 50)
    // Android asks for its own menu on a long press.
    const native = new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
    act(() => void button.dispatchEvent(native))
    expect(native.defaultPrevented).toBe(true)
    expect(menu()).toBeNull()
    pointer("pointerup", window, middle(row(API)), "touch")
    expect(click(button).defaultPrevented).toBe(true)
    expect(session()).toBeNull()
    expect(menuItems()).toEqual(["Move up", "Move down", "Move to top", "Move to bottom"])
    // The row keeps its frame while its menu is open, so it's plain which one moves.
    expect([mark().style.display, mark().style.top]).toEqual(["block", `${row(API).getBoundingClientRect().top}px`])
    await choose("Move up")
    expect(mark().style.display).toBe("none")
    expect(under(YARD)[0]).toBe(API.id)
  })

  it("that only taps opens the task as before", async () => {
    render()
    const button = row(API).querySelector<HTMLElement>("[data-open-task]")!
    pointer("pointerdown", button, middle(row(API)), "touch")
    pointer("pointerup", window, middle(row(API)), "touch")
    expect(click(button).defaultPrevented).toBe(false)
    await wait(HOLD_MS + 50)
    expect(session()).toBe(API.id)
    expect(mark().style.display).not.toBe("block")
    expect(menu()).toBeNull()
  })
})
