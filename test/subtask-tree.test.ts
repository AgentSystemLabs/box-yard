// @vitest-environment happy-dom
// Sub-tasks: the sidebar nests a task's sub-tasks under it as a tree that folds (in memory) and counts what
// still runs. A sub-task opens like any task, from a link in the parent's transcript or from the tree: in the rightmost
// unpinned panel's place, so beside its parent once the parent is pinned (lib/columns.ts). The URL helpers behind
// it are tested on their own too.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { warmLazyParts } from "../web/src/components/LazyPart.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { keys } from "../web/src/lib/queries.js"
import { setChatProjectFilter } from "../web/src/lib/projectBar.js"
import { DOUBLE_TAP_MS, closeSidebarDrawer, openSidebarDrawer, setSidebarCollapsed, setTreeFolds, sidebarGroups, sidebarSelection, taskKey, treeHidden } from "../web/src/lib/sidebar.js"
import { panelsAt, panelsHref } from "../web/src/lib/panelStack.js"
import { placeRefs, resetColumns } from "../web/src/lib/columns.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import { SHEET_HIDDEN } from "../web/src/components/OverlayHost.js"
import { nestAt } from "../web/src/components/Sidebar.js"
import { resetScrollMemory } from "../web/src/lib/scrollMemory.js"
import type { Project, Task, TaskMessage, TaskStatus } from "../shared/types"
import { APP_HOME, openChat } from "../web/src/lib/navigation.js"
import { sidebarGroup } from "./sidebarTree.js"

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
const RATIOS = task("task_ratios", "Ingredients and ratios", "done", OMELETTE)
const PANS = task("task_pans01", "Pans and heat", "working", OMELETTE)
const CHEFS = task("task_chefs1", "Chef and expert methods", "needs_input", OMELETTE)
const FRENCH = task("task_french", "French rolled method", "working", CLASSIC)
const AMERICAN = task("task_americ", "American folded method", "done", CLASSIC)
const OTHER = task("task_other1", "Fix the build", "working")
const TASKS = [OMELETTE, CLASSIC, RATIOS, PANS, CHEFS, FRENCH, AMERICAN, OTHER]
// Six levels deep (a parent_task_id chain), with a sibling at the third.
const L1 = task("task_deep01", "Plan the launch", "working")
const L2 = task("task_deep02", "Write the launch post", "working", L1)
const L3 = task("task_deep03", "Draft the post's sections", "working", L2)
const L3B = task("task_deep3b", "Pick the post's images", "pr_ready", L2)
const L4 = task("task_deep04", "Draft the pricing section", "needs_input", L3)
const L5 = task("task_deep05", "Check the prices with the team", "working", L4)
const L6 = task("task_deep06", "Make the price table", "working", L5)
const DEEP = [L1, L2, L3, L3B, L4, L5, L6]

const started = (id: string, kids: Task[]): TaskMessage =>
  ({ id: `tm_${id}_spawn`, role: "event", content: `Started ${kids.length} sub-tasks.`, meta: { kind: "subtasks", subtasks: kids.map((k) => ({ id: k.id, title: k.title })) }, createdAt: now - 50_000 }) as unknown as TaskMessage
const report = (from: Task): TaskMessage =>
  ({ id: `tm_report_${from.id}`, role: "agent", content: "Whisk **3 eggs** with a pinch of salt.", meta: { from: from.id, fromTitle: from.title, subtaskReport: "done" }, createdAt: now - 40_000 }) as unknown as TaskMessage

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

function render(path = APP_HOME, tasks: Task[] = TASKS) {
  history.replaceState(null, "", path)
  resetScrollMemory()
  sessionStorage.setItem("box-yard:landed", "1")
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.agentSettings, { settings: DEFAULT_SETTINGS, sources: {}, defaults: DEFAULT_SETTINGS })
  qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.chat, [])
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, tasks)
  qc.setQueryData(keys.projects, [YARD])
  qc.setQueryData(keys.taskMessages(OMELETTE.id), [started(OMELETTE.id, [CLASSIC, RATIOS, PANS, CHEFS]), report(RATIOS)])
  qc.setQueryData(keys.taskMessages(CLASSIC.id), [started(CLASSIC.id, [FRENCH, AMERICAN])])
  for (const t of [RATIOS, PANS, CHEFS, FRENCH, AMERICAN, OTHER]) qc.setQueryData(keys.taskMessages(t.id), [{ id: `tm_${t.id}`, role: "assistant", content: `Notes on ${t.title}`, meta: null, createdAt: now }])
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications, keys.scheduleRuns]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
  return qc
}

const nav = () => document.querySelector<HTMLElement>("nav[aria-label='Projects and tasks']")!
const project = () => sidebarGroup(nav(), YARD.name)!
const node = (t: Task) => project().querySelector<HTMLElement>(`[data-tree-node=${t.id}]`)
const chevron = (t: Task) => node(t)!.querySelector<HTMLButtonElement>(":scope > [role=treeitem] [data-tree-toggle]")!
const open = (t: Task) => node(t)!.querySelector<HTMLButtonElement>(`:scope > [role=treeitem] [data-open-task=${t.id}]`)!
/** A task's row in the sidebar's tree: the treeitem around its open button. */
const item = (t: Task) => open(t).closest<HTMLElement>("[role=treeitem]")!
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
const columns = () => [...document.querySelectorAll<HTMLElement>("[data-testid=column]")]
/** Beside the chat every panel shows, the strip scrolling when they don't fit; on a sheet only these do. */
const onSheet = () => columns().filter((c) => !c.classList.contains(SHEET_HIDDEN)).map((c) => c.dataset.view)
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))

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
    // Deferred availability queries must reach the stub before fetch is restored.
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
    resetColumns()
  })
  viewport(1024, 768)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("the sidebar's sub-task tree", () => {
  it("nests sub-tasks under their parent, any depth, in the order they started; a chevron folds a node and counts what runs", () => {
    render()
    // The sub-tasks aren't rows of their own: they sit under the parent, which is the project's only tree.
    expect([...project().querySelectorAll(":scope [data-tree-node][data-depth='0']")].map((n) => (n as HTMLElement).dataset.treeNode)).toEqual([OMELETTE.id])
    const kids = [...node(OMELETTE)!.querySelectorAll<HTMLElement>("[data-depth='1']")].map((n) => n.dataset.treeNode)
    expect(kids).toEqual([CLASSIC.id, RATIOS.id, PANS.id, CHEFS.id])
    expect([...node(CLASSIC)!.querySelectorAll<HTMLElement>("[data-depth='2']")].map((n) => n.dataset.treeNode)).toEqual([FRENCH.id, AMERICAN.id])
    // A plain task stays a plain row.
    expect(project().querySelector(`[data-open-task=${OTHER.id}]`)!.closest("[data-tree-node]")).toBeNull()
    // Each node has a status dot, the title over its status, and leaves have no chevron.
    expect(open(PANS).textContent).toContain("Pans and heat")
    expect(open(PANS).querySelector(".rounded-full")).not.toBeNull()
    expect(chevron(PANS)).toBeNull()

    const top = chevron(OMELETTE)
    expect(top.getAttribute("aria-expanded")).toBe("true")
    expect(top.getAttribute("aria-label")).toBe(`Hide the sub-tasks of ${OMELETTE.title}`)
    expect(document.getElementById(top.getAttribute("aria-controls")!)).not.toBeNull()
    // No count while it's open: the rows say it themselves.
    expect(open(OMELETTE).textContent).not.toMatch(/\d+\/\d+/)

    click(top)
    expect(chevron(OMELETTE).getAttribute("aria-expanded")).toBe("false")
    expect(node(CLASSIC)).toBeNull()
    expect(node(FRENCH)).toBeNull()
    // Folded: 3 of its 6 sub-tasks (nested ones too) still run (waiting counts), and one asks.
    expect(open(OMELETTE).textContent).toContain("3/6")
    expect(open(OMELETTE).textContent).toContain("3 of 6 sub-tasks running, 1 asking you")

    click(chevron(OMELETTE))
    expect(node(CLASSIC)).not.toBeNull()
    // A nested node folds on its own and counts only what's below it.
    click(chevron(CLASSIC))
    expect(node(FRENCH)).toBeNull()
    expect(node(PANS)).not.toBeNull()
    expect(open(CLASSIC).textContent).toContain("1/2")
  })

  it("keeps a finished tree, ready for Cody's review, in the sidebar however long it rested, until Cody marks it done", async () => {
    // The agents called finish days ago: every task in the tree rests idle (only Cody marks a task done).
    const longAgo = now - 5 * 86_400_000
    const rested = TASKS.map((t) => ({ ...t, status: "idle", lastActiveAt: longAgo, updatedAt: longAgo }) as Task)
    const qc = render(APP_HOME, rested)
    expect(project()).not.toBeNull()
    expect([...project().querySelectorAll<HTMLElement>("[data-tree-node][data-depth='0']")].map((n) => n.dataset.treeNode)).toEqual([OMELETTE.id])
    expect([...node(OMELETTE)!.querySelectorAll<HTMLElement>("[data-tree-node]")].map((n) => n.dataset.treeNode)).toEqual([CLASSIC.id, FRENCH.id, AMERICAN.id, RATIOS.id, PANS.id, CHEFS.id])
    expect(project().querySelector(`[data-open-task=${OTHER.id}]`)).not.toBeNull()
    // Cody marks the tree done (its sub-tasks close with it): it leaves the list, and the quiet project folds away.
    act(() => void qc.setQueryData(keys.tasks, rested.map((t) => ({ ...t, status: "done" }) as Task)))
    await settle()
    expect(sidebarGroup(nav(), YARD.name)).toBeNull()
    expect(nav().querySelector(`[data-open-task=${OMELETTE.id}]`)).toBeNull()
  })

  it("keeps the folds in memory only: nothing about the tree goes to the browser's storage", () => {
    render()
    click(chevron(OMELETTE))
    expect(JSON.stringify({ ...localStorage })).not.toContain(OMELETTE.id)
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(OMELETTE.id)
  })

  it("nests a project's tasks one step in and each level of sub-tasks one more, each beside a still guide", () => {
    render()
    const list = document.getElementById(`sidebar-tasks-${YARD.id}`)!
    // The project's tasks: 20px in, beside a 1px guide in the border colour under the Captain's tile. It never moves.
    // Less a trim (`--nest-trim`) that a zoomed phone's narrow drawer sets, so titles keep their room there.
    expect(list.className).toContain("[--nest:calc(1.25rem_-_var(--nest-trim))]")
    expect(list.className).toContain("[--nest-trim:0rem]")
    expect(list.className).toContain("before:left-[calc(1.5rem+var(--nest)-0.625rem-0.5px)]")
    expect(list.className).toContain("before:w-px")
    expect(list.className).toContain("before:bg-zinc-800")
    expect(list.className).not.toMatch(/animate|transition/)
    // Drawn over the rows' fills, so a hover never breaks it; a chevron on it sits on top.
    expect(list.className).toContain("before:z-1")
    // How far deep levels step, by the sidebar's width (container queries).
    expect(list.className).toContain("[--tree-full:3]")
    expect(list.className).toContain("@min-[26rem]/side:[--tree-deep:1.25rem]")
    // A top task's sub-tasks: one step more, beside a guide under its icon; a deeper list one more again.
    const subtasks = document.getElementById(`sidebar-subtasks-${OMELETTE.id}`)!
    expect(subtasks.style.getPropertyValue("--nest")).toBe(nestAt(2))
    expect(subtasks.className).toContain("before:-top-3")
    expect(subtasks.className).toContain("before:left-[calc(1.5rem+var(--nest)-0.625rem-0.5px)]")
    expect(document.getElementById(`sidebar-subtasks-${CLASSIC.id}`)!.style.getPropertyValue("--nest")).toBe(nestAt(3))
    // A plain task's row keeps the list's full width and pads past the chevron's column (44px to a finger) and the
    // list's step. A tree row's box starts one step left of its icon, so a top task's spans the list and a sub-task's
    // moves in with it, and its content pads one step past the chevron's column from there.
    const plain = project().querySelector<HTMLElement>(`[data-open-task=${OTHER.id}]`)!
    expect(plain.className).toContain("pl-[calc(1.5rem+var(--nest,0rem))]")
    expect(plain.className).toContain("pointer-coarse:pl-[calc(2.75rem+var(--nest,0rem))]")
    for (const button of [open(OMELETTE), open(FRENCH)]) {
      // The one-line flex row owns the shared indent for the title and its separate PR link.
      expect(button.parentElement!.className).toContain("pl-[calc(2.75rem-var(--nest-trim,0rem))]")
      expect(button.parentElement!.className).toContain("pointer-coarse:pl-[calc(4rem-var(--nest-trim,0rem))]")
      expect(button.closest<HTMLElement>("[role=treeitem]")!.className).toContain("ml-[calc(var(--nest)-1.25rem+var(--nest-trim,0rem))]")
      expect(button.closest<HTMLElement>("[role=treeitem]")!.style.paddingLeft).toBe("")
      expect(button.closest<HTMLElement>("[role=treeitem]")!.style.marginLeft).toBe("")
    }
    // A plain task says its status through the icon; its title still truncates.
    expect(plain.textContent).not.toContain("working")
    expect(plain.querySelector("[data-task-row-title]")!.textContent).toBe(OTHER.title)
    for (const row of [plain, open(PANS), open(FRENCH)]) {
      expect(row.querySelector(".task-title-working")).toBeNull()
      expect(row.querySelector<HTMLElement>('[data-testid="task-status-icon"] svg')!.getAttribute("class")!).toContain("motion-safe:animate-pulse")
    }
    expect(open(FRENCH).querySelector(".col-start-2.row-start-1")!.className).toContain("truncate")
    // A chevron sits on its parent's guide, the guide broken behind it; it and the rows keep 44px to a finger.
    expect(chevron(OMELETTE).className).toContain("left-[calc(17px-var(--nest-trim,0rem))]")
    expect(chevron(CLASSIC).className).toContain("left-[calc(17px-var(--nest-trim,0rem))]")
    expect(chevron(CLASSIC).firstElementChild!.className).toContain("bg-zinc-950")
    expect(chevron(CLASSIC).className).toContain("z-2")
    expect(chevron(OMELETTE).className).toContain("pointer-coarse:w-11")
    // As tall as its row (inset-y-0), which is 44px to a finger.
    expect(chevron(OMELETTE).className).toContain("inset-y-0")
    expect(open(FRENCH).parentElement!.className).toContain("pointer-coarse:min-h-11")
  })

  it("keeps the rail's own steps and bounds their indent to reserve room for content and actions", async () => {
    render()
    act(() => setSidebarCollapsed(true))
    act(() => openChat(YARD.id))
    await settle()
    // The tree stands beside its strip, so it needs one with a width (happy-dom lays nothing out).
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 56, 900))
    click(document.querySelector("[data-testid=rail-tree-button]")!)
    await settle()
    const tree = document.querySelector<HTMLElement>("[data-testid=rail-tree]")!
    const french = tree.querySelector<HTMLElement>(`[data-open-task=${FRENCH.id}]`)!
    // The row's box moves in, so its fill and selected bar start at its level.
    const row = french.closest<HTMLElement>("[data-tree-node]")!.firstElementChild as HTMLElement
    expect(row.style.getPropertyValue("--rail-indent")).toBe("calc(2 * var(--tree-step))")
    expect(row.className).toContain("ml-[min(var(--rail-indent,0rem),max(0rem,calc(100cqw-12rem)))]")
    expect(french.className).not.toContain("--nest")
    expect(tree.querySelector("[class*='[--nest:'], [style*='--nest']")).toBeNull()
  })

  it("picking a nested sub-task opens just it, and marks its row; folded away, its tree's top row", async () => {
    render()
    click(open(FRENCH))
    await settle()
    expect(location.search).toBe(`?session=${FRENCH.id}`)
    expect(columns().map((c) => c.dataset.view)).toEqual([`session:${FRENCH.id}`])
    expect(item(FRENCH).getAttribute("aria-current")).toBe("page")
    expect(nav().querySelectorAll("[aria-current=page]")).toHaveLength(1)

    click(chevron(OMELETTE))
    expect(nav().querySelector("[aria-current=page]")).toBeNull()
    // The folded top row gets the faint bar instead.
    expect(item(OMELETTE).className).toContain("color-mix(in_oklab,var(--color-yard-400)_40%")
  })

  it("a plain task's row still opens just its panel", async () => {
    render()
    click(project().querySelector(`[data-open-task=${OTHER.id}]`)!)
    await settle()
    expect(location.search).toBe(`?session=${OTHER.id}`)
    expect(columns()).toHaveLength(1)
  })
})

describe("a sub-task tree five and more levels deep", () => {
  const LEVELS = [L1, L2, L3, L4, L5, L6]
  /** A row's `--nest`: a top task's is its project's list's 20px (a class), a sub-task's its group's, set per level. */
  const nest = (t: Task) => (t === L1 ? "1.25rem" : node(t)!.parentElement!.style.getPropertyValue("--nest"))
  /**
   * A `--nest` in px, given the steps the sidebar's width sets: the first `full` levels 20px each, deeper ones `deep`px.
   * No `--nest-trim`: that's only a zoomed phone's narrow drawer.
   */
  const px = (css: string, full: number, deep: number) =>
    Function(`return ${css.replace(/var\(--nest-trim, 0rem\)/g, "0rem").replace(/var\(--tree-full\)/g, String(full)).replace(/var\(--tree-deep\)/g, String(deep)).replace(/100cqw/g, "1024").replace(/calc\(/g, "(").replace(/\b(min|max)\(/g, "Math.$1(").replace(/([\d.]+)rem/g, "($1 * 16)")}`)() as number
  const steps = (full: number, deep: number) => LEVELS.map((t) => px(nest(t), full, deep))

  it("nests each level one step in from its parent by its true depth, beside its own guide, deep steps shorter in a narrow sidebar", () => {
    render(APP_HOME, DEEP)
    LEVELS.forEach((t, i) => {
      expect(node(t)!.dataset.depth).toBe(String(i))
      // Every level in its parent's own group, one step in from it.
      if (i) {
        const group = node(t)!.parentElement!
        expect(group.id).toBe(`sidebar-subtasks-${LEVELS[i - 1].id}`)
        expect(nest(t)).toBe(nestAt(i + 1))
        expect(group.className).toContain("before:left-[calc(1.5rem+var(--nest)-0.625rem-0.5px)]")
        expect(group.className).toContain("before:-top-3")
      }
      // The row's box, so its fill and selected bar, starts one step left of its icon (the trim given back, as the step
      // is a whole one); the title has the rest.
      expect(item(t).className).toContain("ml-[calc(var(--nest)-1.25rem+var(--nest-trim,0rem))]")
      expect(open(t).className).toContain("min-w-0")
      expect(open(t).querySelector(".col-start-2.row-start-1")!.className).toContain("truncate")
      // A chevron on its parent's guide for every row with sub-tasks, at every level.
      if (t !== L6) expect(chevron(t).className).toContain("left-[calc(17px-var(--nest-trim,0rem))]")
    })
    expect(chevron(L6)).toBeNull()
    expect(node(L3B)!.parentElement).toBe(node(L3)!.parentElement)
    expect(nestAt(1)).toContain("min(1, var(--tree-full))")
    // The steps the sidebar's width sets on its project's list (container queries).
    const list = document.getElementById(`sidebar-tasks-${YARD.id}`)!
    for (const step of ["[--tree-full:3]", "[--tree-deep:0.625rem]", "@max-[16rem]/side:[--tree-deep:0.375rem]", "@min-[20rem]/side:[--tree-deep:0.875rem]", "@min-[26rem]/side:[--tree-deep:1.25rem]", "pointer-coarse:@max-[20rem]/side:[--tree-full:2]", "@max-[16rem]/side:[--tree-full:1]"])
      expect(list.className).toContain(step)
    // Wide (26rem up): every level a full 20px step. The default 320px sidebar: three, then 14px.
    expect(steps(3, 20)).toEqual([20, 40, 60, 80, 100, 120])
    expect(steps(3, 14)).toEqual([20, 40, 60, 74, 88, 102])
    // A phone's drawer (under 20rem): 10px past the third level, to a finger past the second (its chevron column is 44px).
    expect(steps(3, 10)).toEqual([20, 40, 60, 70, 80, 90])
    expect(steps(2, 10)).toEqual([20, 40, 50, 60, 70, 80])
    // A phone at 125% zoom (under 16rem): 6px past a project's tasks, so the sixth level's title still has room.
    expect(steps(1, 6)).toEqual([20, 26, 32, 38, 44, 50])
  })

  it("folds and unfolds each level on its own: only that row's sub-tasks hide, and it counts them", () => {
    render(APP_HOME, DEEP)
    click(chevron(L4))
    expect(chevron(L4).getAttribute("aria-expanded")).toBe("false")
    expect(node(L5)).toBeNull()
    expect(node(L6)).toBeNull()
    for (const t of [L1, L2, L3, L3B, L4]) expect(node(t)).not.toBeNull()
    expect(open(L4).textContent).toContain("2 of 2 sub-tasks running")
    // A level above folds everything below it, and keeps the fold under it for when it opens again.
    click(chevron(L2))
    for (const t of [L3, L3B, L4]) expect(node(t)).toBeNull()
    expect(open(L2).textContent).toContain("3 of 5 sub-tasks running, 1 asking you")
    click(chevron(L2))
    for (const t of [L3, L3B, L4]) expect(node(t)).not.toBeNull()
    expect(node(L5)).toBeNull()
    click(chevron(L4))
    expect(node(L6)).not.toBeNull()
    // The deepest fold: only the sixth level hides.
    click(chevron(L5))
    expect(node(L6)).toBeNull()
    expect(node(L5)).not.toBeNull()
    expect(open(L5).textContent).toContain("1 of 1 sub-tasks running")
    click(chevron(L5))
    expect(node(L6)!.dataset.depth).toBe("5")
    expect(nest(L6)).toBe(nestAt(6))
  })

  it("marks a deep row's own box, at its level, and the folded row above it when it's hidden", async () => {
    render(APP_HOME, DEEP)
    click(open(L5))
    await settle()
    expect(location.search).toBe(`?session=${L5.id}`)
    expect(item(L5).getAttribute("aria-current")).toBe("page")
    expect(nav().querySelectorAll("[aria-current=page]")).toHaveLength(1)
    // The fill and the bar are on the row's box, which starts at its level (its group's `--nest`).
    const box = item(L5)
    expect(box.className).toContain("shadow-[inset_3px_0_0_var(--color-yard-400)]")
    expect(box.className).toContain("ml-[calc(var(--nest)-1.25rem+var(--nest-trim,0rem))]")
    expect(nest(L5)).toBe(nestAt(5))
    click(chevron(L3))
    expect(item(L3).className).toContain("color-mix(in_oklab,var(--color-yard-400)_40%")
  })
})

describe("a double click on a tree row with sub-tasks folds or unfolds its tree", () => {
  /** A click (a tap, with pointerType "touch") at `at` ms: what makes it a double click is the time between two. */
  const clickAt = (el: Element, at: number, init: PointerEventInit = {}) => {
    const e = new PointerEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1, pointerType: "mouse", ...init })
    Object.defineProperty(e, "timeStamp", { value: at })
    act(() => void el.dispatchEvent(e))
    return e
  }
  const at = (type: "mousedown" | "dblclick", el: Element, time: number) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, detail: type === "dblclick" ? 2 : 1 })
    Object.defineProperty(e, "timeStamp", { value: time })
    act(() => void el.dispatchEvent(e))
    return e
  }
  /** Two clicks on `el` and the dblclick a mouse fires after them. */
  const doubleClick = (el: Element, time: number) => {
    clickAt(el, time)
    clickAt(el, time + 150)
    return at("dblclick", el, time + 150)
  }
  const expanded = (t: Task, within: ParentNode = nav()) =>
    within.querySelector(`[data-tree-node=${t.id}] > [role=treeitem] [data-tree-toggle]`)!.getAttribute("aria-expanded")
  const drawer = () => document.querySelector<HTMLElement>("[role=dialog][aria-label='Projects and tasks']")
  /** The rects that matter, the rest as they are: the panels' row (`panels` wide), the drawer's list, and a tree node. */
  function layout(panels: number, node?: { id: string; top: number; bottom: number }) {
    const real = HTMLElement.prototype.getBoundingClientRect
    const rect = (top: number, bottom: number, width = 300) => ({ top, bottom, y: top, height: bottom - top, left: 0, right: width, x: 0, width, toJSON() {} }) as DOMRect
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === "columns") return rect(0, 800, panels)
      if (node && this.dataset.treeNode === node.id) return rect(node.top, node.bottom)
      if (this.parentElement?.getAttribute("role") === "tree" && this.classList.contains("overflow-y-auto")) return rect(100, 800)
      return real.call(this)
    })
  }

  it("a single click opens the task and leaves its tree as it was; the tooltip says what a double click does", async () => {
    render()
    expect(open(OMELETTE).title).toBe(`${OMELETTE.title} · Waiting on agent (double-click to collapse)`)
    clickAt(open(OMELETTE), 1000)
    await settle()
    expect(location.search).toBe(`?session=${OMELETTE.id}`)
    expect(expanded(OMELETTE)).toBe("true")
    expect(node(CLASSIC)).not.toBeNull()
    // A second click long after is another single click.
    clickAt(open(OMELETTE), 3000)
    expect(expanded(OMELETTE)).toBe("true")
  })

  it("a double click opens the task and folds its tree, another unfolds it; a nested row works the same, in memory only", async () => {
    render()
    doubleClick(open(OMELETTE), 1000)
    await settle()
    expect(location.search).toBe(`?session=${OMELETTE.id}`)
    expect(expanded(OMELETTE)).toBe("false")
    expect(node(CLASSIC)).toBeNull()
    expect(open(OMELETTE).textContent).toContain("3/6")
    expect(open(OMELETTE).title).toBe(`${OMELETTE.title} · Waiting on agent (double-click to expand)`)
    // The chevron still says so, and still folds it: it's the keyboard's way.
    expect(chevron(OMELETTE).getAttribute("aria-label")).toBe(`Show the sub-tasks of ${OMELETTE.title}`)

    doubleClick(open(OMELETTE), 2000)
    expect(expanded(OMELETTE)).toBe("true")
    expect(node(FRENCH)).not.toBeNull()

    doubleClick(open(CLASSIC), 3000)
    await settle()
    expect(location.search).toBe(`?session=${CLASSIC.id}`)
    expect(expanded(CLASSIC)).toBe("false")
    expect(node(FRENCH)).toBeNull()
    expect(expanded(OMELETTE)).toBe("true")
    expect(node(PANS)).not.toBeNull()
    // The folds aren't kept anywhere (the palette's recent picks list the task it opened, as for any task).
    const { "box-yard:recent": _recent, ...kept } = { ...localStorage, ...sessionStorage }
    expect(JSON.stringify(kept)).not.toContain(CLASSIC.id)
  })

  it("a row with no sub-tasks folds nothing, nor does a plain task's row", async () => {
    const qc = render()
    expect(open(PANS).title).toBe(`${PANS.title} · Working`)
    doubleClick(open(PANS), 1000)
    await settle()
    expect(location.search).toBe(`?session=${PANS.id}`)
    expect(chevron(PANS)).toBeNull()
    const plain = project().querySelector(`[data-open-task=${OTHER.id}]`)!
    doubleClick(plain, 2000)
    expect(project().querySelectorAll("[data-tree-toggle][aria-expanded=false]")).toHaveLength(0)
    expect(node(FRENCH)).not.toBeNull()
    // Once a sub-task starts under it, its tree shows open: the double click didn't fold it ahead of time.
    act(() => void qc.setQueryData(keys.tasks, [...TASKS, task("task_wokpan", "Carbon steel or nonstick", "working", PANS)]))
    await settle()
    expect(expanded(PANS)).toBe("true")
  })

  it("to a finger, two taps on one row within 350ms are a double tap; the first still opens the task at once", () => {
    render()
    const tap = (t: Task, time: number) => clickAt(open(t), time, { pointerType: "touch" })
    tap(OMELETTE, 1000)
    expect(location.search).toBe(`?session=${OMELETTE.id}`)
    expect(expanded(OMELETTE)).toBe("true")
    // Too far apart, or on two rows: single taps.
    tap(OMELETTE, 1000 + DOUBLE_TAP_MS + 50)
    tap(CLASSIC, 1500)
    expect(location.search).toBe(`?session=${CLASSIC.id}`)
    tap(OMELETTE, 2000)
    expect(expanded(OMELETTE)).toBe("true")
    expect(expanded(CLASSIC)).toBe("true")
    tap(OMELETTE, 2000 + DOUBLE_TAP_MS)
    expect(expanded(OMELETTE)).toBe("false")
    // A browser that fires dblclick after the two taps doesn't fold it back, and a third tap isn't another double.
    at("dblclick", open(OMELETTE), 2000 + DOUBLE_TAP_MS)
    tap(OMELETTE, 2100 + DOUBLE_TAP_MS)
    expect(expanded(OMELETTE)).toBe("false")
  })

  it("on a phone the first tap closes the drawer on the task; the second, landing behind it, folds the tree and opens the drawer on it, in view", async () => {
    viewport(400)
    layout(400, { id: OMELETTE.id, top: 900, bottom: 1000 })
    render()
    act(() => openSidebarDrawer())
    clickAt(open(OMELETTE), 1000, { pointerType: "touch" })
    expect(drawer()).toBeNull()
    await settle()
    expect(location.search).toBe(`?session=${OMELETTE.id}`)
    // The second tap lands on the task's panel, where the row was: it doesn't act there, nor take the focus.
    const behind = document.querySelector<HTMLElement>(`[data-testid=column] button`)!
    expect(at("mousedown", behind, 1200).defaultPrevented).toBe(true)
    expect(clickAt(behind, 1200, { pointerType: "touch" }).defaultPrevented).toBe(true)
    expect(location.search).toBe(`?session=${OMELETTE.id}`)
    expect(drawer()).not.toBeNull()
    expect(expanded(OMELETTE, drawer()!)).toBe("false")
    // Scrolled just enough to show the row.
    expect(drawer()!.querySelector<HTMLElement>("[role=tree] > .overflow-y-auto")!.scrollTop).toBe(200)
    // A tap after that is a tap.
    clickAt(open(OMELETTE), 3000, { pointerType: "touch" })
    expect(drawer()).toBeNull()
    expect(clickAt(document.body, 3100, { pointerType: "touch" }).defaultPrevented).toBe(true)
    expect(expanded(OMELETTE, drawer()!)).toBe("true")
  })

  it("when the first click gives the column's room to the panel it opened, the second only folds the tree, in the drawer", () => {
    viewport(1100)
    layout(800)
    render()
    const rail = () => document.querySelector<HTMLElement>("[data-testid=sidebar]")!
    clickAt(open(OMELETTE), 1000)
    expect(rail().dataset.rail).toBe("true")
    // The second click lands on the rail's Coordinator, which would close the task; its dblclick on a project's icon,
    // which would expand the sidebar on that project.
    const coordinator = rail().querySelector<HTMLElement>("button[aria-label^=Coordinator]")!
    expect(at("mousedown", coordinator, 1150).defaultPrevented).toBe(true)
    expect(clickAt(coordinator, 1150).defaultPrevented).toBe(true)
    expect(at("dblclick", rail().querySelector("button[aria-label^='box-yard Captain']")!, 1150).defaultPrevented).toBe(true)
    expect(location.search).toBe(`?session=${OMELETTE.id}`)
    expect(expanded(OMELETTE, drawer()!)).toBe("false")
    // A click after that is a click.
    act(() => closeSidebarDrawer())
    clickAt(coordinator, 2000)
    expect(location.search).not.toContain(OMELETTE.id)
  })
})

describe("sub-task panels", () => {
  const panel = (t: Task) => document.querySelector<HTMLElement>(`[data-testid=column][data-view='session:${t.id}']`)!
  const link = (within: Element, t: Task) => within.querySelector<HTMLAnchorElement>(`[data-testid=subtasks-line] a[href$='${t.id}']`)!

  const pin = (t: Task) => click(panel(t).querySelector<HTMLButtonElement>("[data-testid=column-pin]")!)

  it("a sub-task link opens it in its parent's place; pinned, the parent stays and each sub-task opens to its right; Close closes only it", async () => {
    render(`/?session=${OMELETTE.id}`)
    await settle()
    const parent = panel(OMELETTE).querySelector('[role="dialog"]')!
    // The transcript lists the sub-tasks it started, with their live status, and a report.
    const listed = [...parent.querySelectorAll("[data-testid=subtasks-line] a")].map((a) => [a.querySelector(".truncate")!.textContent, a.querySelector("[data-subtask-status]")?.textContent])
    expect(listed).toEqual([CLASSIC, RATIOS, PANS, CHEFS].map((t) => [t.title, expect.any(String)]))
    expect(new Set(listed.map(([, status]) => status)).size).toBe(4)
    expect(parent.querySelector("[data-testid=subtask-report]")!.textContent).toMatch(new RegExp(`^Report${RATIOS.title}`))
    expect(parent.querySelector("[data-testid=subtask-report] strong")!.textContent).toBe("3 eggs")

    // Unpinned, the parent is the rightmost unpinned panel: the sub-task takes its place. Back brings it back.
    click(link(parent, CLASSIC))
    await settle()
    expect(location.search).toBe(`?session=${CLASSIC.id}`)
    act(() => history.back())
    await settle()
    expect(location.search).toBe(`?session=${OMELETTE.id}`)

    // Pinned, it stays where it is, as it was, and the sub-task opens beside it.
    pin(OMELETTE)
    const kept = panel(OMELETTE).querySelector('[role="dialog"]')!
    click(link(kept, CLASSIC))
    await settle()
    expect(location.search).toBe(`?session=${OMELETTE.id}&stack=${CLASSIC.id}`)
    expect(columns().map((c) => c.dataset.view)).toEqual([`session:${OMELETTE.id}`, `session:${CLASSIC.id}`])
    expect(panel(OMELETTE).querySelector('[role="dialog"]')).toBe(kept)

    // A deeper one replaces the unpinned sub-task; another link in the parent replaces that.
    click(link(panel(CLASSIC), FRENCH))
    await settle()
    expect(location.search).toBe(`?session=${OMELETTE.id}&stack=${FRENCH.id}`)
    click(link(kept, PANS))
    await settle()
    expect(location.search).toBe(`?session=${OMELETTE.id}&stack=${PANS.id}`)
    expect(columns().map((c) => c.dataset.view)).toEqual([`session:${OMELETTE.id}`, `session:${PANS.id}`])

    // Its Close closes it alone, back over the history entry that opened it.
    click(panel(PANS).querySelector<HTMLButtonElement>(`button[aria-label='Close ${PANS.title}']`)!)
    await settle()
    expect(location.search).toBe(`?session=${OMELETTE.id}`)
    expect(columns()).toHaveLength(1)
  })

  it("keeps transcript sub-task titles plain and pulses their task icons with a reduced-motion cue", async () => {
    const failed = { ...CHEFS, status: "failed" as const }
    render(`/?session=${OMELETTE.id}`, TASKS.map((t) => t.id === failed.id ? failed : t))
    await settle()
    const parent = panel(OMELETTE)
    const working = link(parent, PANS)
    const icon = working.querySelector<HTMLElement>('[data-testid="task-status-icon"]')!
    expect(icon.querySelector("svg")!.getAttribute("class")).toContain("motion-safe:animate-pulse")
    expect(icon.dataset.status).toBe("working")
    expect(icon.querySelector('[data-cue="working"]')!.className).not.toMatch(/hidden|motion-reduce|animate/)
    expect(icon.className).not.toContain("animate-pulse")
    expect(working.querySelector(".task-title-working")).toBeNull()
    expect(working.querySelector("[data-task-row-title]")!.textContent).toBe(PANS.title)
    expect(working.querySelector("[data-subtask-status]")!.className).toContain("sr-only")
    expect(link(parent, failed).querySelector(".task-title-failed")!.textContent).toBe(failed.title)
    expect(link(parent, failed).querySelector('[data-cue="failed"]')).not.toBeNull()
    expect(link(parent, failed).querySelector<HTMLElement>('[data-testid="task-status-icon"]')!.className).not.toContain("animate-pulse")
  })

  it("on a sheet over the chat, only the newest shows and its parent's crumb steps to the one before", async () => {
    viewport(400)
    render(`/?session=${OMELETTE.id}&stack=${CLASSIC.id},${FRENCH.id}`)
    await settle()
    expect(onSheet()).toEqual([`session:${FRENCH.id}`])
    click(panel(FRENCH).querySelector<HTMLButtonElement>(`button[aria-label='Up to ${CLASSIC.title}']`)!)
    await settle()
    expect(location.search).toBe(`?session=${OMELETTE.id}&stack=${CLASSIC.id}`)
    expect(onSheet()).toEqual([`session:${CLASSIC.id}`])
  })

  it("Esc closes the rightmost panel first, and leaves a pinned one where it is", async () => {
    render(`/?session=${OMELETTE.id}`)
    await settle()
    pin(OMELETTE)
    click(link(panel(OMELETTE).querySelector('[role="dialog"]')!, CLASSIC))
    await settle()
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    await settle()
    expect(location.search).toBe(`?session=${OMELETTE.id}`)
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    await settle()
    expect(location.search).toBe(`?session=${OMELETTE.id}`)
  })

  it("picking the Captain in the sidebar closes the whole stack, and Back opens it again (#328)", async () => {
    render(`/?session=${OMELETTE.id}&stack=${CLASSIC.id},${FRENCH.id}`)
    await settle()
    expect(columns()).toHaveLength(3)
    click([...project().querySelectorAll("button")].find((b) => /^box-yard, Captain/.test(b.textContent ?? ""))!)
    await settle()
    expect(new URLSearchParams(location.search).get("session")).toBeNull()
    expect(new URLSearchParams(location.search).get("stack")).toBeNull()
    expect(columns()).toHaveLength(0)
    act(() => history.back())
    await settle()
    expect(location.search).toBe(`?session=${OMELETTE.id}&stack=${CLASSIC.id},${FRENCH.id}`)
    expect(columns()).toHaveLength(3)
  })
})

describe("the tree and panel helpers", () => {
  it("sidebarGroups nests sub-tasks, keeps a finished parent while anything below it runs, and counts the tree", () => {
    const doneTop = { ...OMELETTE, status: "done" } as Task
    const { shown } = sidebarGroups([YARD], [doneTop, CLASSIC, RATIOS, PANS, CHEFS, FRENCH, AMERICAN], {}, { now })
    const rows = shown[0]!.rows
    expect(rows.map((r) => r.task.id)).toEqual([OMELETTE.id])
    expect(rows[0]!.tree).toEqual({ running: 3, total: 6, asks: 1 })
    expect(rows[0]!.kids!.map((r) => [r.task.id, r.dim])).toEqual([
      [CLASSIC.id, false],
      [RATIOS.id, true],
      [PANS.id, false],
      [CHEFS.id, false],
    ])
    // Once nothing below it runs, a finished tree leaves the list like any finished task.
    const settled = [doneTop, ...[CLASSIC, RATIOS, PANS, CHEFS, FRENCH, AMERICAN].map((t) => ({ ...t, status: "done" }) as Task)]
    expect(sidebarGroups([YARD], settled, {}, { now }).others[0]!.rows).toEqual([])
  })

  it("a sub-task whose parent isn't shown is a top row of its own", () => {
    const quietTop = { ...OMELETTE, status: "done", updatedAt: now - 10 * 86_400_000 } as Task
    const lone = { ...CLASSIC, status: "working" } as Task
    const { shown } = sidebarGroups([YARD], [lone], {}, { now })
    expect(shown[0]!.rows.map((r) => r.task.id)).toEqual([CLASSIC.id])
    // With its parent listed, it nests again (a running sub-task keeps its parent in view).
    expect(sidebarGroups([YARD], [quietTop, lone], {}, { now }).shown[0]!.rows.map((r) => r.task.id)).toEqual([OMELETTE.id])
  })

  it("treeHidden and sidebarSelection mark a folded tree's top row when a hidden sub-task is open", () => {
    const { shown } = sidebarGroups([YARD], TASKS, {}, { now })
    const hiddenIn = treeHidden(shown, { [OMELETTE.id]: true, [CLASSIC.id]: true })
    expect(hiddenIn.get(FRENCH.id)).toBe(OMELETTE.id)
    expect(hiddenIn.get(CLASSIC.id)).toBe(OMELETTE.id)
    expect(hiddenIn.has(OMELETTE.id)).toBe(false)
    const projectOf = new Map(TASKS.map((t) => [t.id, YARD.id]))
    const base = { centre: null, picked: null, waiting: new Set<string>(), projectOf, folds: {}, hiddenIn }
    expect(sidebarSelection({ ...base, panel: { kind: "session", id: FRENCH.id } })).toEqual({ selected: null, behind: "coordinator", inside: taskKey(OMELETTE.id, "project") })
    expect(sidebarSelection({ ...base, panel: { kind: "session", id: OMELETTE.id } }).selected).toBe(taskKey(OMELETTE.id, "project"))
  })

  it("panelsAt reads every panel of any kind; panelsHref writes them; placeRefs puts an opening in the rightmost unpinned one's place", () => {
    const href = `/?session=${OMELETTE.id}&stack=${CLASSIC.id},${FRENCH.id}`
    expect(panelsAt(href)).toEqual([OMELETTE.id, CLASSIC.id, FRENCH.id])
    expect(panelsAt(`/?captain=${YARD.id}&stack=${CLASSIC.id}`)).toEqual([`captain.${YARD.id}`, CLASSIC.id])
    expect(panelsAt("/")).toEqual([])
    expect(panelsHref(href, [`captain.${YARD.id}`, CLASSIC.id])).toBe(`/?captain=${YARD.id}&stack=${CLASSIC.id}`)
    expect(panelsHref(href, [PANS.id])).toBe(`/?session=${PANS.id}`)
    expect(panelsHref(href, [])).toBe("/")

    const none = () => false
    expect(placeRefs([OMELETTE.id, CLASSIC.id], PANS.id, none)).toEqual([OMELETTE.id, PANS.id])
    expect(placeRefs([OMELETTE.id, CLASSIC.id], PANS.id, (r) => r === CLASSIC.id)).toEqual([PANS.id, CLASSIC.id])
    expect(placeRefs([OMELETTE.id, CLASSIC.id], PANS.id, () => true)).toEqual([OMELETTE.id, CLASSIC.id, PANS.id])
    expect(placeRefs([OMELETTE.id, CLASSIC.id], OMELETTE.id, none)).toEqual([OMELETTE.id, CLASSIC.id])
    expect(placeRefs([], PANS.id, none)).toEqual([PANS.id])
  })
})
