// @vitest-environment happy-dom
// A phone's way up the tree (components/TreeNav.tsx, lib/treeNav.ts): a task's header leads with the sidebar's ☰, then
// the Coordinator, the Captain and the tasks above it as crumbs in Back's place, with the whole title on a row below.
// Up never adds a history entry; a chat crumb returns to the chat the task opened beside, or makes a trip (an entry of
// its own) to another, and Back shows each entry with its chat again. A chat's header names it plainly, after ☰, with
// 🔍 for the palette. A wide window keeps Back for a sheet and shows the crumbs after it (test/pins.test.ts has how
// they go there).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { warmLazyParts } from "../web/src/components/LazyPart.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { keys } from "../web/src/lib/queries.js"
import { chatProjectFilter, setChatProjectFilter } from "../web/src/lib/projectBar.js"
import { closeSidebarDrawer, setSidebarCollapsed, setTreeFolds } from "../web/src/lib/sidebar.js"
import { navigateApp, taskSessionHref, APP_HOME } from "../web/src/lib/navigation.js"
import { chainOf } from "../web/src/lib/treeNav.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import { resetScrollMemory } from "../web/src/lib/scrollMemory.js"
import type { Project, Task, TaskMessage, TaskStatus } from "../shared/types"

beforeAll(() => warmLazyParts())

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const YARD = { id: "prj_yard01", name: "box-yard", repo: null, description: "", notes: [], envKeys: [], baseBranch: "main", runner: "box", identityId: "idn_default", gpuMachine: { gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null }, docker: { image: null, dockerfile: null }, createdAt: now, color: null } as unknown as Project
let order = 0
const task = (id: string, title: string, status: TaskStatus, parent?: Task) =>
  ({
    id,
    projectId: YARD.id,
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
    createdAt: now - 60_000 + order++,
    updatedAt: now - 60_000,
  }) as unknown as Task

const OMELETTE = task("task_omelet", "Research the best way to cook an omelette", "waiting")
const CLASSIC = task("task_classc", "Classic technique", "waiting", OMELETTE)
const PANS = task("task_pans01", "Pans and heat", "working", OMELETTE)
const FRENCH = task("task_french", "French rolled method", "working", CLASSIC)
const AMERICAN = task("task_americ", "American folded method", "done", CLASSIC)
const TASKS = [OMELETTE, CLASSIC, PANS, FRENCH, AMERICAN]

const started = (id: string, kids: Task[]): TaskMessage =>
  ({ id: `tm_${id}_spawn`, role: "event", content: `Started ${kids.length} sub-tasks.`, meta: { kind: "subtasks", subtasks: kids.map((k) => ({ id: k.id, title: k.title })) }, createdAt: now - 50_000 }) as unknown as TaskMessage

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
  qc.setQueryData(keys.agentSettings, { settings: DEFAULT_SETTINGS, sources: {}, defaults: DEFAULT_SETTINGS })
  qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.chat, [])
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, TASKS)
  qc.setQueryData(keys.projects, [YARD])
  qc.setQueryData(keys.taskMessages(OMELETTE.id), [started(OMELETTE.id, [CLASSIC, PANS])])
  qc.setQueryData(keys.taskMessages(CLASSIC.id), [started(CLASSIC.id, [FRENCH, AMERICAN])])
  for (const t of [PANS, FRENCH, AMERICAN]) qc.setQueryData(keys.taskMessages(t.id), [{ id: `tm_${t.id}`, role: "assistant", content: `Notes on ${t.title}`, meta: null, createdAt: now }])
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications, keys.scheduleRuns]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
}

const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
const panel = (t: Task) => document.querySelector<HTMLElement>(`[data-testid=column][data-view='session:${t.id}']`)!
const header = (t: Task) => panel(t).querySelector<HTMLElement>("[data-testid=task-header]")!
const crumbs = (t: Task) => [...header(t).querySelectorAll<HTMLButtonElement>("[data-testid=task-crumbs] button")]
const crumb = (t: Task, label: string) => crumbs(t).find((b) => b.getAttribute("aria-label") === label)!
const labels = (within: ParentNode) => [...within.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))
const search = () => new URLSearchParams(location.search)

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  viewport(400)
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
    setSidebarCollapsed(false)
    closeSidebarDrawer()
    setTreeFolds({})
  })
  viewport(1024, 768)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("a task's header on a phone", () => {
  it("shows the way up in Back's place: the Coordinator, the Captain, then each task above, the parent last", async () => {
    render(`/?session=${OMELETTE.id}&stack=${CLASSIC.id},${FRENCH.id}`)
    await settle()
    expect(crumbs(FRENCH).map((b) => b.getAttribute("aria-label"))).toEqual(["Coordinator", "box-yard Captain", OMELETTE.title, `Up to ${CLASSIC.title}`])
    expect(header(FRENCH).querySelector("[data-dismiss=back]")).toBeNull()
    // A top task's way up is the chats alone.
    expect(chainOf(TASKS, OMELETTE.id).map((t) => t.id)).toEqual([OMELETTE.id])
    expect(chainOf(TASKS, FRENCH.id).map((t) => t.id)).toEqual([OMELETTE.id, CLASSIC.id, FRENCH.id])
  })

  it("Up never adds an entry: it steps back over the panel's own, or turns this entry into the parent", async () => {
    render(`/?session=${OMELETTE.id}`)
    await settle()
    click(panel(OMELETTE).querySelector(`[data-testid=subtasks-line] a[href$='${CLASSIC.id}']`)!)
    await settle()
    const length = history.length
    expect(search().get("stack")).toBe(CLASSIC.id)
    click(crumb(CLASSIC, `Up to ${OMELETTE.title}`))
    await settle()
    expect(location.search).toBe(`?session=${OMELETTE.id}`)
    expect(history.length).toBe(length)

    // A link straight to a sub-sub-task: its parents were never open, so Up shows them in this entry.
    act(() => root.unmount())
    root = createRoot(host)
    render(`/?session=${FRENCH.id}`)
    await settle()
    const before = history.length
    click(crumb(FRENCH, `Up to ${CLASSIC.title}`))
    await settle()
    expect(location.search).toBe(`?session=${OMELETTE.id}&stack=${CLASSIC.id}`)
    expect(history.length).toBe(before)
    click(crumb(CLASSIC, `Up to ${OMELETTE.title}`))
    await settle()
    expect(location.search).toBe(`?session=${OMELETTE.id}`)
    expect(history.length).toBe(before)
  })

  it("a chat crumb returns to the chat the task opened beside, and makes a trip to any other that Back undoes", async () => {
    render()
    await settle()
    act(() => setChatProjectFilter(YARD.id))
    act(() => navigateApp(taskSessionHref(OMELETTE.id)))
    await settle()
    const length = history.length

    // The Coordinator: a trip. Back brings the task back, beside its Captain again.
    click(crumb(OMELETTE, "Coordinator"))
    await settle()
    expect(search().get("session")).toBeNull()
    expect(chatProjectFilter()).toBeNull()
    expect(history.length).toBe(length + 1)
    act(() => history.back())
    await settle()
    expect(search().get("session")).toBe(OMELETTE.id)
    expect(chatProjectFilter()).toBe(YARD.id)

    // The Captain it opened beside: a return, back over the task's entry.
    click(crumb(OMELETTE, "box-yard Captain"))
    await settle()
    expect(search().get("session")).toBeNull()
    expect(chatProjectFilter()).toBe(YARD.id)
    act(() => history.forward())
    await settle()
    expect(search().get("session")).toBe(OMELETTE.id)
  })

  it("row 1 is ☰, the crumbs and ⓘ; row 2 is the task's icon (its state) and whole title, which opens the details; no 🔍, no menu", async () => {
    render(`/?session=${OMELETTE.id}&stack=${CLASSIC.id}`)
    await settle()
    const nav = header(CLASSIC).querySelector<HTMLElement>("[data-testid=task-nav]")!
    // Nothing here waits on Cody, so ☰ has no count. Pin and Close, after ⓘ, show only beside a chat (CSS).
    expect(labels(nav).slice(0, 5)).toEqual(["Projects and tasks", "Coordinator", "box-yard Captain", `Up to ${OMELETTE.title}`, "Task details and more actions"])
    // No state word: the task's icon, before its title, names it.
    expect(nav.textContent).not.toContain("Waiting on agent")
    expect(header(CLASSIC).querySelector("button[aria-label='Search tasks']")).toBeNull()
    const title = header(CLASSIC).querySelector<HTMLElement>("[data-testid=task-meta]")!.querySelector<HTMLButtonElement>("[data-testid=task-title]")!
    expect(title.textContent).toContain(CLASSIC.title)
    expect(title.querySelector("[data-testid=task-status-icon]")!.getAttribute("aria-label")).toBe("Waiting on agent")
    expect(title.getAttribute("aria-haspopup")).toBe("dialog")
    click(title)
    await settle()
    expect(document.querySelector("[role=dialog][aria-label='Task details'], [role=dialog][aria-labelledby]")?.textContent).toContain("Task details")
  })

  it("a task ready for review has Mark done in row 1, in place of its state; a done one has Reopen there", async () => {
    render(`/?session=${AMERICAN.id}`)
    await settle()
    expect(header(AMERICAN).querySelector("[data-testid=task-mark-done]")).toBeNull()
    const doneNav = header(AMERICAN).querySelector<HTMLElement>("[data-testid=task-nav]")!
    expect(doneNav.querySelector("[data-testid=task-reopen]")?.textContent).toBe("Reopen")
    act(() => root.unmount())
    root = createRoot(host)
    const ready = { ...PANS, status: "idle" as const }
    TASKS.splice(TASKS.indexOf(PANS), 1, ready)
    try {
      render(`/?session=${PANS.id}`)
      await settle()
      const nav = header(PANS).querySelector<HTMLElement>("[data-testid=task-nav]")!
      expect(nav.querySelector("[data-testid=task-mark-done]")).not.toBeNull()
      expect(nav.querySelector("[data-testid=task-reopen]")).toBeNull()
      expect(nav.textContent).not.toContain("Idle")
      expect(header(PANS).querySelector("[data-testid=task-meta] [data-testid=task-chips]")).not.toBeNull()
    } finally {
      TASKS.splice(TASKS.indexOf(ready), 1, PANS)
    }
  })

  it("a side question keeps its Back to the task, and the crumbs come back after it", async () => {
    render(`/?session=${PANS.id}`)
    await settle()
    click(panel(PANS).querySelector("[data-testid=task-ask-toggle]")!)
    await settle()
    expect(header(PANS).querySelector("[data-dismiss=back]")?.getAttribute("aria-label")).toBe("Back to the task")
    expect(header(PANS).querySelector("[data-testid=task-crumbs]")).toBeNull()
    click(header(PANS).querySelector("[data-dismiss=back]")!)
    await settle()
    expect(crumbs(PANS).map((b) => b.getAttribute("aria-label"))).toEqual(["Coordinator", "box-yard Captain", `Up to ${OMELETTE.title}`])
  })
})

describe("a chat's header on a phone", () => {
  const chatHeader = () => [...document.querySelectorAll<HTMLElement>("[data-testid=chat-title]")].find((t) => t.checkVisibility())!.closest("header")!

  it("the Coordinator's: ☰, its name as plain text (no switcher), then 🔍 for the palette", async () => {
    render()
    await settle()
    const head = chatHeader()
    expect(labels(head)[0]).toBe("Projects and tasks")
    expect(head.querySelector("[data-testid=chat-switcher]")).toBeNull()
    // "Box Yard " is for a wider screen (CSS).
    expect(head.querySelector("h1")!.textContent).toMatch(/Coordinator$/)
    const search = head.querySelector<HTMLButtonElement>("button[aria-label='Search tasks']")!
    click(search)
    expect(document.activeElement).toBe(document.querySelector('input[aria-label="Search Box Yard"]'))
    click(document.querySelector('[role="dialog"] button[aria-label="Close"]')!)
  })

  it("a Captain's: ☰, the Coordinator's crumb, its bot in its project's colour and its name as plain text, then 🔍", async () => {
    render()
    await settle()
    act(() => setChatProjectFilter(YARD.id))
    await settle()
    const head = chatHeader()
    expect(labels(head).slice(0, 2)).toEqual(["Projects and tasks", "Coordinator"])
    expect(head.querySelector("[data-testid=chat-switcher]")).toBeNull()
    expect(head.querySelector("h1")!.textContent).toBe("box-yard Captain")
    expect(head.querySelector("button[aria-label='Search tasks']")).not.toBeNull()
    const bot = head.querySelector("[data-testid=agent-icon]")!
    expect(bot.getAttribute("class")).toContain("text-(--pc)")
    expect((bot.parentElement as HTMLElement).style.getPropertyValue("--pc")).not.toBe("")
  })

  it("☰ opens the sidebar as a drawer, with its Close and no search of its own", async () => {
    render()
    await settle()
    click(chatHeader().querySelector("button[aria-label^='Projects and tasks']")!)
    const drawer = document.querySelector<HTMLElement>("[role=dialog][aria-label='Projects and tasks']")!
    expect(drawer.querySelector("[data-dismiss=close]")).not.toBeNull()
    expect(drawer.querySelector("button[aria-label='Search tasks']")).toBeNull()
    expect(drawer.querySelector("input")).toBeNull()
  })
})

describe("elsewhere", () => {
  it("a Captain's header on a phone has the Coordinator's crumb: a trip, so Back shows the Captain again", async () => {
    render()
    await settle()
    act(() => setChatProjectFilter(YARD.id))
    await settle()
    const length = history.length
    const tower = [...document.querySelectorAll<HTMLButtonElement>("header button[aria-label=Coordinator]")].find((b) => b.closest("header")?.querySelector("[data-testid=chat-title]"))!
    click(tower)
    await settle()
    expect(chatProjectFilter()).toBeNull()
    expect(history.length).toBe(length + 1)
    act(() => history.back())
    await settle()
    expect(chatProjectFilter()).toBe(YARD.id)
  })

  it("a wide window keeps the header's Back (for a sheet) and the title's details, with the crumbs after Back", async () => {
    viewport(1440)
    render(`/?session=${OMELETTE.id}&stack=${CLASSIC.id}`)
    await settle()
    // No Coordinator crumb on a desktop: the sidebar has it (#376).
    expect(crumbs(CLASSIC).map((b) => b.getAttribute("aria-label"))).toEqual(["box-yard Captain", `Up to ${OMELETTE.title}`])
    expect(header(CLASSIC).querySelector("[data-dismiss=back]")).not.toBeNull()
    expect(header(CLASSIC).querySelector("[data-testid=task-title]")!.getAttribute("aria-haspopup")).toBe("dialog")
    expect(crumbs(OMELETTE).map((b) => b.getAttribute("aria-label"))).toEqual(["box-yard Captain"])
  })
})
