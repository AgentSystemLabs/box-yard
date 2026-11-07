// @vitest-environment happy-dom
// The sidebar as a WAI-ARIA tree view (lib/treeView.ts): its roles and levels, one tab stop, and every key.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { warmLazyParts } from "../web/src/components/LazyPart.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { keys } from "../web/src/lib/queries.js"
import { setChatProjectFilter } from "../web/src/lib/projectBar.js"
import { WAITING_CAP, WAITING_FOLD, captainKey, closeSidebarDrawer, coordinatorKey, openSidebarDrawer, setSidebarCollapsed, setTreeFolds, taskKey, unfoldSidebarGroup } from "../web/src/lib/sidebar.js"
import { resetColumns } from "../web/src/lib/columns.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import type { Project, Task, TaskStatus } from "../shared/types"
import { APP_HOME } from "../web/src/lib/navigation.js"
import { itemName, treeItems } from "./sidebarTree.js"

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
    createdAt: now - 60_000 + order++,
    updatedAt: now - 60_000,
    ...extra,
  }) as unknown as Task

const YARD = project("prj_yard01", "box-yard")
const SITE = project("prj_site01", "marketing-site")
const QUIET = project("prj_quiet1", "photo-tools")
const ASK = task("task_ask001", YARD.id, "Check SSH into the bench", "needs_input")
const PLAN = task("task_plan01", YARD.id, "Plan the launch", "working")
const POST = task("task_post01", YARD.id, "Write the launch post", "working", PLAN)
const DRAFT = task("task_draft1", YARD.id, "Draft the pricing section", "working", POST)
const IMAGES = task("task_imgs01", YARD.id, "Pick the images", "working", PLAN)
const PR = task("task_pr0001", SITE.id, "Refresh the portfolio", "pr_ready", undefined, { prUrl: "https://github.com/o/site/pull/19" })
const OLD = task("task_old001", QUIET.id, "Fix attachment previews", "done")
const TASKS = [ASK, PLAN, POST, DRAFT, IMAGES, PR, OLD]

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
  sessionStorage.setItem("box-yard:landed", "1")
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.agentSettings, { settings: DEFAULT_SETTINGS, sources: {}, defaults: DEFAULT_SETTINGS })
  qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.chat, [])
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, tasks)
  qc.setQueryData(keys.projects, [YARD, SITE, QUIET])
  for (const t of tasks) qc.setQueryData(keys.taskMessages(t.id), [])
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications, keys.scheduleRuns]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
  return qc
}

const nav = () => document.querySelector<HTMLElement>("nav[aria-label='Projects and tasks']")!
const tree = () => nav().querySelector<HTMLElement>("[role=tree]")!
const items = () => treeItems(tree())
/** The tree as a screen reader lists it: each item's name, one indent a level, its fold, and its place in its list. */
const outline = () =>
  items().map((i) => {
    const fold = i.getAttribute("aria-expanded")
    return `${"  ".repeat(Number(i.getAttribute("aria-level")) - 1)}${itemName(i)}${fold ? (fold === "true" ? " ▾" : " ▸") : ""} (${i.getAttribute("aria-posinset")}/${i.getAttribute("aria-setsize")})`
  })
/** An item by its key (lib/sidebar.ts keys): the Coordinator, a Captain, a task in a list. */
const at = (key: string) => tree().querySelector<HTMLElement>(`[data-tree-key="${key}"]`)!
const row = (t: Task, spot: "project" | "waiting" = "project") => at(taskKey(t.id, spot))
const focusedKey = () => document.activeElement?.getAttribute("data-tree-key") ?? null
const focus = (el: HTMLElement) => act(() => el.focus())
/** The one item Tab stops on. */
const stops = () => items().filter((i) => i.getAttribute("tabindex") === "0").map((i) => i.dataset.treeKey)
const press = (key: string, init: KeyboardEventInit & { at?: number } = {}, target: Element = document.activeElement ?? document.body) => {
  const { at: time, ...rest } = init
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...rest })
  if (time !== undefined) Object.defineProperty(e, "timeStamp", { value: time })
  act(() => void target.dispatchEvent(e))
  return e
}
/** Presses `key` until the focus stops moving, and the keys it went through. */
const walk = (key: string) => {
  const seen = [focusedKey()]
  for (let i = 0; i < 50; i++) {
    press(key)
    if (focusedKey() === seen.at(-1)) break
    seen.push(focusedKey())
  }
  return seen
}
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 })))
const session = () => new URLSearchParams(location.search).get("session")
const title = () => [...document.querySelectorAll("[data-testid=chat-title]")].find((t) => t.checkVisibility())?.textContent
/** A microtask later: what the tree's observer catches (a list that folds on its own). */
const flush = () => act(async () => {})
/** A live update to the task list, drawn: the query cache tells its observers a tick later. */
const update = async (qc: QueryClient, tasks: Task[]) => {
  act(() => void qc.setQueryData(keys.tasks, tasks))
  await act(async () => new Promise((r) => setTimeout(r, 20)))
}

const COORDINATOR = coordinatorKey
const WAITING = "group:waiting"
const MORE = "group:more"
/** Every item on screen at first, top to bottom. */
const ALL = [COORDINATOR, WAITING, taskKey(ASK.id, "waiting"), taskKey(PR.id, "waiting"), captainKey(YARD.id), taskKey(ASK.id, "project"), taskKey(PLAN.id, "project"), taskKey(POST.id, "project"), taskKey(DRAFT.id, "project"), taskKey(IMAGES.id, "project"), captainKey(SITE.id), taskKey(PR.id, "project"), MORE]

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
    resetColumns()
    setSidebarCollapsed(false)
    closeSidebarDrawer()
    setTreeFolds({})
    for (const key of [YARD.id, SITE.id, QUIET.id, WAITING_FOLD]) unfoldSidebarGroup(key)
  })
  viewport(1024, 768)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("the sidebar's tree: roles and attributes", () => {
  it("is one tree of treeitems with levels, folds and places; children sit in a group beside their parent", () => {
    render()
    expect(tree().getAttribute("aria-label")).toBe("Projects and tasks")
    expect(outline()).toEqual([
      "Coordinator (1/5)",
      "Waiting on you2 ▾ (2/5)",
      "  Check SSH into the benchbox-yardasks (1/2)",
      // The PR number has its own named link beside the button that names the treeitem.
      "  Refresh the portfoliomarketing-site (2/2)",
      "box-yard, Captain ▾ (3/5)",
      "  Check SSH into the benchasks (1/2)",
      "  Plan the launchworking ▾ (2/2)",
      "    Write the launch postLevel 2 · working ▾ (1/2)",
      "      Draft the pricing sectionLevel 3 · working (1/1)",
      "    Pick the imagesLevel 2 · working (2/2)",
      "marketing-site, Captain ▾ (4/5)",
      "  Refresh the portfolio (1/1)",
      "More projects1 ▸ (5/5)",
    ])
    expect(items().map((i) => i.dataset.treeKey)).toEqual(ALL)
    // The children of an unfolded item: a named group right after it, not inside it, so the item's name is its own.
    expect([...tree().querySelectorAll("[role=group]")].map((g) => [g.getAttribute("aria-label"), g.previousElementSibling?.matches("[role=treeitem]") || g.previousElementSibling?.querySelector("[role=treeitem]") !== null])).toEqual([
      ["Waiting on you", true],
      ["box-yard tasks", true],
      ["Plan the launch sub-tasks", true],
      ["Write the launch post sub-tasks", true],
      ["marketing-site tasks", true],
    ])
    // Nothing but plain divs and groups between the tree and an item: Chromium shows a treeitem under a section, say, as
    // a generic, so the groups' heads would drop out of the tree.
    for (const i of items()) for (let up = i.parentElement; up && up !== tree(); up = up.parentElement) expect(up.getAttribute("role") ?? up.tagName, i.dataset.treeKey).toMatch(/^(group|DIV)$/)
    for (const i of items()) {
      // Named by its own open button, which holds no other row.
      const name = document.getElementById(i.getAttribute("aria-labelledby")!)!
      expect(name.tagName).toBe("BUTTON")
      expect(i.contains(name)).toBe(true)
      expect(name.querySelector("[role=treeitem]")).toBeNull()
    }
    // Every item lives in the tree or a group.
    for (const i of items()) expect(i.parentElement!.closest("[role=group], [role=tree]")).not.toBeNull()
  })

  it("marks the page on screen with aria-current on its item, never on a button, and only the parents say they fold", () => {
    render(`${APP_HOME}?session=${DRAFT.id}`)
    expect(items().filter((i) => i.hasAttribute("aria-current")).map((i) => [i.dataset.treeKey, i.getAttribute("aria-current")])).toEqual([[taskKey(DRAFT.id, "project"), "page"]])
    expect(tree().querySelector("button[aria-current]")).toBeNull()
    expect(row(DRAFT).hasAttribute("aria-expanded")).toBe(false)
    expect(row(ASK).hasAttribute("aria-expanded")).toBe(false)
    expect(row(POST).getAttribute("aria-expanded")).toBe("true")
  })

  it("is one tab stop: the item for the page on screen, and no button inside the tree is in the Tab order", () => {
    render()
    expect(stops()).toEqual([COORDINATOR])
    const buttons = [...tree().querySelectorAll<HTMLButtonElement>("button")]
    expect(buttons.length).toBeGreaterThan(items().length)
    expect(buttons.filter((b) => b.tabIndex !== -1)).toEqual([])
    // The row's tools are still there for a mouse and a finger, with their names.
    expect(at(captainKey(YARD.id)).querySelector("button[aria-label='Pin box-yard']")).not.toBeNull()
    expect(at(captainKey(YARD.id)).querySelector("button[aria-label='box-yard project settings']")).not.toBeNull()
    expect(row(PR).querySelector("button[aria-label='Mark Refresh the portfolio done']")).not.toBeNull()
    // The footer's buttons are outside the tree, in the Tab order as before.
    expect(nav().querySelector<HTMLButtonElement>("button[aria-label='New project']")!.tabIndex).toBe(0)
  })
})

describe("the sidebar's tree: keys", () => {
  it("keeps the real parent, level and single tab stop through twelve child levels", async () => {
    const deep: Task[] = []
    for (let i = 0; i < 13; i++) deep.push(task(`task_level${i}`, YARD.id, `Example task ${i + 1}`, "idle", deep.at(-1)))
    render(APP_HOME, deep)
    const leaf = deep.at(-1)!
    const parent = deep.at(-2)!
    const item = row(leaf)
    expect(item.getAttribute("aria-level")).toBe("14")
    expect(item.getAttribute("aria-posinset")).toBe("1")
    expect(item.getAttribute("aria-setsize")).toBe("1")
    expect(item.textContent).toContain("Level 13")
    expect(item.querySelector("[data-testid=sidebar-mark-done]")?.getAttribute("tabindex")).toBe("-1")
    focus(item)
    press("ArrowLeft")
    expect(focusedKey()).toBe(taskKey(parent.id, "project"))
    press(" ")
    await flush()
    expect(row(leaf)).toBeNull()
    expect(stops()).toEqual([taskKey(parent.id, "project")])
    press("ArrowRight")
    await flush()
    press("ArrowRight")
    expect(focusedKey()).toBe(taskKey(leaf.id, "project"))
    expect(stops()).toEqual([taskKey(leaf.id, "project")])
  })

  it("↓ and ↑ move through the items on screen, top to bottom, and stop at the ends", () => {
    render()
    focus(at(COORDINATOR))
    expect(walk("ArrowDown")).toEqual(ALL)
    // At the end ↓ stays put, and is still the tree's: nothing else scrolls.
    expect(press("ArrowDown").defaultPrevented).toBe(true)
    expect(focusedKey()).toBe(MORE)
    expect(walk("ArrowUp")).toEqual([...ALL].reverse())
    expect(press("ArrowUp").defaultPrevented).toBe(true)
    // Moving doesn't open anything: only Enter does.
    expect(session()).toBeNull()
    expect(at(COORDINATOR).getAttribute("aria-current")).toBe("page")
  })

  it("skips a folded item's children, at any depth", () => {
    render()
    click(row(PLAN).querySelector("button[aria-expanded]")!)
    focus(row(ASK))
    expect(walk("ArrowDown")).toEqual([taskKey(ASK.id, "project"), taskKey(PLAN.id, "project"), captainKey(SITE.id), taskKey(PR.id, "project"), MORE])
    click(at(captainKey(YARD.id)).querySelector("button[aria-expanded]")!)
    focus(at(taskKey(PR.id, "waiting")))
    expect(walk("ArrowDown")).toEqual([taskKey(PR.id, "waiting"), captainKey(YARD.id), captainKey(SITE.id), taskKey(PR.id, "project"), MORE])
  })

  it("→ unfolds a folded item, then steps into its first child; on a leaf it does nothing", () => {
    render()
    const yard = at(captainKey(YARD.id))
    const chevron = yard.querySelector<HTMLButtonElement>("button[aria-expanded]")!
    focus(yard)
    press("ArrowLeft")
    expect(yard.getAttribute("aria-expanded")).toBe("false")
    // The same fold as the chevron's: its state, its label, and what's remembered.
    expect(chevron.getAttribute("aria-expanded")).toBe("false")
    expect(chevron.getAttribute("aria-label")).toBe("Show box-yard tasks")
    expect(JSON.parse(localStorage.getItem("box-yard:sidebar-folds")!)).toEqual({ [YARD.id]: true })
    expect(row(ASK)).toBeNull()
    expect(press("ArrowRight").defaultPrevented).toBe(true)
    expect(yard.getAttribute("aria-expanded")).toBe("true")
    expect(chevron.getAttribute("aria-label")).toBe("Hide box-yard tasks")
    expect(document.activeElement).toBe(yard)
    press("ArrowRight")
    expect(focusedKey()).toBe(taskKey(ASK.id, "project"))
    // A leaf: → stays, and changes nothing.
    expect(press("ArrowRight").defaultPrevented).toBe(true)
    expect(focusedKey()).toBe(taskKey(ASK.id, "project"))
    expect(session()).toBeNull()
  })

  it("← folds an unfolded item, else steps out to its parent; a top item's ← stays", () => {
    render()
    focus(row(DRAFT))
    press("ArrowLeft")
    expect(focusedKey()).toBe(taskKey(POST.id, "project"))
    press("ArrowLeft")
    // Folded, the sub-task is gone, and the chevron says so as a click would have.
    expect(row(POST).getAttribute("aria-expanded")).toBe("false")
    expect(row(DRAFT)).toBeNull()
    expect(row(POST).querySelector("button[aria-expanded]")!.getAttribute("aria-label")).toBe("Show the sub-tasks of Write the launch post")
    expect(focusedKey()).toBe(taskKey(POST.id, "project"))
    press("ArrowLeft")
    expect(focusedKey()).toBe(taskKey(PLAN.id, "project"))
    press("ArrowLeft")
    expect(row(PLAN).getAttribute("aria-expanded")).toBe("false")
    press("ArrowLeft")
    expect(focusedKey()).toBe(captainKey(YARD.id))
    focus(at(COORDINATOR))
    expect(press("ArrowLeft").defaultPrevented).toBe(true)
    expect(focusedKey()).toBe(COORDINATOR)
    // → walks back in, unfolding as it goes.
    focus(row(PLAN))
    press("ArrowRight")
    press("ArrowRight")
    press("ArrowRight")
    press("ArrowRight")
    expect(focusedKey()).toBe(taskKey(DRAFT.id, "project"))
    expect(row(DRAFT).getAttribute("aria-level")).toBe("4")
  })

  it("Space folds and unfolds a parent, and opens a leaf as Enter does", () => {
    render()
    const yard = at(captainKey(YARD.id))
    focus(yard)
    expect(press(" ").defaultPrevented).toBe(true)
    expect(yard.getAttribute("aria-expanded")).toBe("false")
    // Not the Captain: Space on a parent only folds.
    expect(title()).toContain("Coordinator")
    press(" ")
    expect(yard.getAttribute("aria-expanded")).toBe("true")
    expect(document.activeElement).toBe(yard)
    focus(row(PLAN))
    press(" ")
    expect(row(PLAN).getAttribute("aria-expanded")).toBe("false")
    expect(session()).toBeNull()
    press(" ")
    focus(row(DRAFT))
    press(" ")
    expect(session()).toBe(DRAFT.id)
    expect(row(DRAFT).getAttribute("aria-current")).toBe("page")
  })

  it("Enter opens the item as a click does: a task in the panel, a project's Captain, the Coordinator", () => {
    render()
    focus(row(PLAN))
    expect(press("Enter").defaultPrevented).toBe(true)
    expect(session()).toBe(PLAN.id)
    // A parent opens; it doesn't fold.
    expect(row(PLAN).getAttribute("aria-expanded")).toBe("true")
    expect(row(PLAN).getAttribute("aria-current")).toBe("page")
    focus(at(captainKey(SITE.id)))
    press("Enter")
    expect(title()).toBe("marketing-site Captain")
    expect(session()).toBeNull()
    expect(at(captainKey(SITE.id)).getAttribute("aria-current")).toBe("page")
    focus(at(COORDINATOR))
    press("Enter")
    expect(title()).toContain("Coordinator")
    // A head that only folds (Waiting on you, More projects): Enter folds it, as its click does.
    focus(at(WAITING))
    press("Enter")
    expect(at(WAITING).getAttribute("aria-expanded")).toBe("false")
  })

  it("Home and End go to the first and the last item", () => {
    render()
    focus(row(POST))
    expect(press("End").defaultPrevented).toBe(true)
    expect(focusedKey()).toBe(MORE)
    press("Home")
    expect(focusedKey()).toBe(COORDINATOR)
  })

  it("a letter jumps to the next item whose name starts with it; letters typed together spell a name", () => {
    render()
    focus(at(COORDINATOR))
    expect(press("p", { at: 1000 }).defaultPrevented).toBe(true)
    expect(focusedKey()).toBe(taskKey(PLAN.id, "project"))
    press("p", { at: 2000 })
    expect(focusedKey()).toBe(taskKey(IMAGES.id, "project"))
    // Round to the top.
    press("p", { at: 3000 })
    expect(focusedKey()).toBe(taskKey(PLAN.id, "project"))
    // "w", then "r" and "i" in quick succession: "wri" stays on the post, where "w" alone went.
    press("w", { at: 4000 })
    expect(focusedKey()).toBe(taskKey(POST.id, "project"))
    press("R", { at: 4100 })
    press("i", { at: 4200 })
    expect(focusedKey()).toBe(taskKey(POST.id, "project"))
    press("m", { at: 5000 })
    expect(focusedKey()).toBe(captainKey(SITE.id))
    // No match: the focus stays.
    press("z", { at: 6000 })
    expect(focusedKey()).toBe(captainKey(SITE.id))
    expect(session()).toBeNull()
  })

  it("leaves modified keys alone", () => {
    render()
    focus(at(COORDINATOR))
    for (const init of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
      expect(press("ArrowDown", init).defaultPrevented).toBe(false)
      expect(focusedKey()).toBe(COORDINATOR)
    }
  })

  it("a screen reader's click on the item itself opens it, as Enter does", () => {
    render()
    act(() => void row(IMAGES).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 0 })))
    expect(session()).toBe(IMAGES.id)
  })
})

describe("the sidebar's tree: lists that change", () => {
  it("More projects unfolds from the keyboard, and its projects take their places one level in", async () => {
    render()
    focus(at(MORE))
    press("ArrowRight")
    await flush()
    expect(outline().slice(-2)).toEqual(["More projects1 ▾ (5/5)", "  photo-tools, Captain".replace(", Captain", "") + " (1/1)"])
    press("ArrowRight")
    expect(focusedKey()).toBe(captainKey(QUIET.id))
    press("Enter")
    expect(title()).toBe("photo-tools Captain")
  })

  it("Show n more is an item too: Enter shows the rest, and the focus stays on it", () => {
    const many = Array.from({ length: WAITING_CAP + 2 }, (_, i) => task(`task_many0${i}`, YARD.id, `Question ${i + 1}`, "needs_input"))
    render(APP_HOME, many)
    const more = at("waiting:more")
    expect(itemName(more)).toBe("Show 2 more")
    expect(more.getAttribute("aria-level")).toBe("2")
    focus(more)
    press("Enter")
    expect(itemName(at("waiting:more"))).toBe("Show fewer")
    expect(focusedKey()).toBe("waiting:more")
    expect(at(WAITING).nextElementSibling!.querySelectorAll("[role=treeitem]")).toHaveLength(WAITING_CAP + 3)
  })

  it("Tab comes back to the item focused last; another page opened from elsewhere takes the stop", () => {
    render()
    focus(at(COORDINATOR))
    press("ArrowDown")
    press("ArrowDown")
    expect(stops()).toEqual([taskKey(ASK.id, "waiting")])
    // Focus leaves the tree: the stop stays where it was.
    act(() => (document.activeElement as HTMLElement).blur())
    expect(stops()).toEqual([taskKey(ASK.id, "waiting")])
    // A task opened from outside the tree (a link, the palette): Tab now enters on it.
    click(row(IMAGES).querySelector("button[data-open-task]")!)
    expect(stops()).toEqual([taskKey(IMAGES.id, "project")])
    // Folded away, its tree's top row holds it, and takes the stop.
    click(row(PLAN).querySelector("button[aria-expanded]")!)
    expect(stops()).toEqual([taskKey(PLAN.id, "project")])
  })

  it("the focus stays on its item through a live re-sort", async () => {
    const qc = render()
    const ask = row(ASK)
    focus(ask)
    // Another task starts asking, more recently: it sorts above the focused one, whose row moves below it.
    await update(qc, TASKS.map((t) => (t.id === PLAN.id ? { ...t, status: "needs_input", updatedAt: now } : t)))
    const yard = at(captainKey(YARD.id)).parentElement!.querySelector("[role=group]")!
    expect([...yard.querySelectorAll(":scope > * > [role=treeitem], :scope > [role=treeitem]")].map((i) => i.getAttribute("data-tree-key"))).toEqual([taskKey(PLAN.id, "project"), taskKey(ASK.id, "project")])
    expect(row(ASK)).toBe(ask)
    expect(document.activeElement).toBe(ask)
    expect(stops()).toEqual([taskKey(ASK.id, "project")])
    expect(outline()[1]).toBe("Waiting on you3 ▾ (2/5)")
  })

  it("when the focused item goes (marked done, gone from the list), the item below it takes the focus", async () => {
    const qc = render()
    focus(row(ASK))
    await update(qc, TASKS.map((t) => (t.id === ASK.id ? { ...t, status: "done" } : t)))
    expect(row(ASK)).toBeNull()
    expect(focusedKey()).toBe(taskKey(PLAN.id, "project"))
    expect(stops()).toEqual([taskKey(PLAN.id, "project")])
    // The last of a list: the one above it.
    focus(at(MORE))
    act(() => void qc.setQueryData(keys.projects, [YARD, SITE]))
    await update(qc, TASKS.filter((t) => t.id !== OLD.id && t.id !== ASK.id))
    expect(focusedKey()).toBe(taskKey(PR.id, "project"))
  })
})

describe("the sidebar's tree and the app's other keys", () => {
  it("keeps its keys from the app's shortcuts, but / still opens the palette", () => {
    render()
    focus(row(PLAN))
    // P is the chat switcher's elsewhere; here it's type-ahead, and the switcher stays shut.
    expect(press("p").defaultPrevented).toBe(true)
    expect(document.querySelector("[aria-label='Switch chat'][role=menu], [data-testid=chat-switcher-filter]")).toBeNull()
    press("/")
    expect(document.querySelector('input[aria-label="Search Box Yard"]')).not.toBeNull()
  })

  it("the composer keeps its arrow keys", () => {
    render()
    const box = document.querySelector<HTMLTextAreaElement>("textarea")!
    focus(box)
    press("ArrowUp")
    press("ArrowDown")
    expect(document.activeElement).toBe(box)
  })

  it("works the same in the phone's drawer, which Enter closes on the task it opens", () => {
    viewport(400)
    render()
    act(() => openSidebarDrawer())
    const drawer = document.querySelector<HTMLElement>("[role=dialog][aria-label='Projects and tasks']")!
    const tree = drawer.querySelector<HTMLElement>("[role=tree]")!
    const item = (key: string) => tree.querySelector<HTMLElement>(`[data-tree-key="${key}"]`)!
    focus(item(captainKey(YARD.id)))
    press("ArrowDown")
    press("ArrowDown")
    expect(focusedKey()).toBe(taskKey(PLAN.id, "project"))
    press("Enter")
    expect(session()).toBe(PLAN.id)
    expect(document.querySelector("[role=dialog][aria-label='Projects and tasks']")).toBeNull()
  })
})

describe("PR numbers below a task title in the project tree", () => {
  const audit = task("task_audit01", YARD.id, "Security audit", "pr_ready", undefined, { prUrl: "https://github.com/acme/example-app/pull/18", prState: "open" })
  const child = task("task_audit02", YARD.id, "Review dependencies", "done", audit, { prUrl: "https://github.com/acme/example-app/pull/17", prState: "merged", prMergedAt: now })

  it.each([1440, 400])("opens the parent PR independently in the %ipx sidebar/drawer, expanded or folded", (width) => {
    viewport(width)
    render(APP_HOME, [audit, child])
    if (width === 400) act(() => openSidebarDrawer())
    const surface = width === 400 ? document.querySelector<HTMLElement>("[role=dialog][aria-label='Projects and tasks']")! : nav()
    const auditRow = () => surface.querySelector<HTMLElement>(`[data-tree-key="${taskKey(audit.id, "project")}"]`)!
    const open = () => auditRow().querySelector<HTMLButtonElement>("[data-open-task]")!
    const link = () => auditRow().querySelector<HTMLAnchorElement>("a")!
    const toggle = () => auditRow().querySelector<HTMLButtonElement>("[data-tree-toggle]")!
    expect(link()).not.toBeNull()
    expect(link().closest("button")).toBeNull()
    expect(link().href).toBe(audit.prUrl)
    expect(link().target).toBe("_blank")
    expect(link().rel).toBe("noopener noreferrer")
    expect(link().getAttribute("aria-label")).toBe("PR #18 on GitHub (opens in a new tab)")
    expect(link().className).toContain("text-emerald-400")
    expect(link().tabIndex).toBe(0)

    for (const folded of [false, true]) {
      if (folded) click(toggle())
      focus(link())
      expect(press("Enter").defaultPrevented).toBe(false)
      for (const init of [{}, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
        const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1, ...init })
        act(() => {
          link().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }))
          link().dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1 }))
          link().dispatchEvent(e)
        })
        expect(e.defaultPrevented).toBe(false)
        expect(session()).toBeNull()
        expect(auditRow().getAttribute("aria-expanded")).toBe(String(!folded))
        expect(auditRow().hasAttribute("aria-current")).toBe(false)
        expect(surface.querySelector("[data-sidebar-delete]")).toBeNull()
        if (width === 400) expect(surface.isConnected).toBe(true)
      }
    }
    click(open())
    expect(session()).toBe(audit.id)
    if (width === 400) expect(surface.isConnected).toBe(false)
  })

  it("links a merged sub-task's PR while leaving a working task's status intact", () => {
    render(APP_HOME, [{ ...audit, status: "working" }, child])
    expect(row(audit).querySelector("a")).toBeNull()
    expect(itemName(row(audit))).toContain("working")
    const link = row(child).querySelector<HTMLAnchorElement>("a")!
    expect(link).not.toBeNull()
    expect(link.getAttribute("aria-label")).toBe("Merged #17 on GitHub (opens in a new tab)")
    expect(link.className).toContain("text-merged-fg")
    click(link)
    expect(session()).toBeNull()
    expect(row(audit).getAttribute("aria-expanded")).toBe("true")
    click(row(child).querySelector("[data-open-task]")!)
    expect(session()).toBe(child.id)
  })
})
