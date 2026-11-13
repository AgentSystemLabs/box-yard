// @vitest-environment happy-dom
// The conversation panels (OverlayHost): beside the chat, a task's panel and its sub-tasks' each keep their own
// width, and every boundary drags (chat | task | sub-task | sub-sub-task), with one panel open or several. Before, a
// second panel took the only drag edge away (SideThreadPane drew it for one panel only) and the panels split one width.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { warmLazyParts } from "../web/src/components/LazyPart.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { keys } from "../web/src/lib/queries.js"
import { PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, THREAD_CHAT_ROOM, moveChatEdge, panelWidthCss, stripLayout, stripWidthCss } from "../web/src/lib/layout.js"
import { chatRoom, panelWidth, resetPanelWidths } from "../web/src/lib/panelWidths.js"
import { resetScrollMemory } from "../web/src/lib/scrollMemory.js"
import { COORDINATOR_REF, resetColumns, setPinned } from "../web/src/lib/columns.js"
import type { Project, Task, TaskStatus } from "../shared/types"
import { APP_HOME } from "../web/src/lib/navigation.js"

beforeAll(() => warmLazyParts())

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const YARD = { id: "prj_yard01", name: "box-yard", repo: null, description: "", notes: [], envKeys: [], baseBranch: "main", runner: "box", identityId: "idn_default", gpuMachine: { gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null }, docker: { image: null, dockerfile: null }, createdAt: now, color: null } as unknown as Project
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
    createdAt: now - 60_000,
    updatedAt: now - 60_000,
  }) as unknown as Task

const LOGO = task("task_logo01", "Box Yard logo exploration", "working")
const DESIGNER = task("task_desig1", "Logo designer 6/10", "working", LOGO)
const RATER = task("task_rater1", "Rate the single-line marks", "working", DESIGNER)
const TASKS = [LOGO, DESIGNER, RATER]
/** The URL with the first `n` of them open: the task, then its sub-task beside it, then that one's. */
const opened = (n: number) => `/?session=${LOGO.id}${n > 1 ? `&stack=${TASKS.slice(1, n).map((t) => t.id).join(",")}` : ""}`

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
/** The chat's section (the `coord` container) is this wide; the panels get all of it but the chat's room. */
let section = 2000

/**
 * Lays the strip out as a browser would (happy-dom lays nothing out): the panels side by side at their widths, the
 * strip as wide as they are up to the chat's room, flush right, and scrolled by its scrollLeft.
 */
function layout() {
  const real = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const box = (left: number, width: number) => ({ left, width, right: left + width, x: left, top: 0, y: 0, height: 800, bottom: 800, toJSON() {} }) as DOMRect
    if (this.dataset.testid === "chat-panel") return box(0, section)
    if (this.dataset.testid === "column") {
      const strip = this.parentElement!
      const all = [...strip.children]
      const { drawn, shown } = stripLayout(all.map((_, i) => panelWidth(i)), chatRoom(), section)
      const i = all.indexOf(this)
      const left = section - shown + drawn.slice(0, i).reduce((a, b) => a + b, 0) - strip.scrollLeft
      return box(left, drawn[i]!)
    }
    return real.call(this)
  })
}

function render(path: string) {
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
  for (const t of TASKS) qc.setQueryData(keys.taskMessages(t.id), [{ id: `tm_${t.id}`, role: "assistant", content: `Notes on ${t.title}`, meta: null, createdAt: now }])
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications, keys.scheduleRuns]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
const strip = () => document.querySelector<HTMLElement>("[data-testid=columns]")!
const aside = () => document.querySelector<HTMLElement>("[data-testid=side-thread]")!
const columns = () => [...document.querySelectorAll<HTMLElement>("[data-testid=column]")]
/** The chat's border (at the strip's left edge, whatever is scrolled into view): the first panel's left edge. */
const chatEdge = () => document.querySelector<HTMLElement>(`[role=separator][aria-label='Width of ${LOGO.title}']`)!
/** Each panel's left edge: the chat's border for the first, the border with the one before for the rest. */
const separators = () => [chatEdge(), ...columns().slice(1).map((c) => c.querySelector<HTMLElement>(":scope > [role=separator]")!)]
/** The panels' widths, as their separators say and their columns draw them. */
const shownWidths = () => separators().map((s, i) => {
  const width = Number(s.getAttribute("aria-valuenow"))
  expect(columns()[i]!.style.getPropertyValue("--panel-w")).toBe(panelWidthCss(width))
  return width
})
const pointer = (el: Element, type: string, clientX: number) =>
  act(() => void el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX })))
/** Drags `el` from x 1000 by `dx` (negative: left, which widens a panel) and lets go. */
function drag(el: Element, dx: number) {
  pointer(el, "pointerdown", 1000)
  pointer(el, "pointermove", 1000 + dx / 2)
  pointer(el, "pointermove", 1000 + dx)
  pointer(el, "pointerup", 1000 + dx)
}
const key = (el: Element, name: string, shiftKey = false) =>
  act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true })))

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  resetPanelWidths()
  // The Coordinator pinned (lib/columns.ts), so the panels open beside the chat rather than in its place.
  resetColumns()
  setPinned(COORDINATOR_REF, true)
  // Wide enough that the sidebar stays a column: no level strips beside the panels (lib/columns.ts).
  viewport(2400)
  section = 2000 // room for 1680px of panels, so three widened ones still fit
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
  vi.stubGlobal("EventSource", FakeEventSource)
  // happy-dom has no pointer capture.
  if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => {}
  layout()
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
  viewport(1024, 768)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("the conversation panels resize", () => {
  it.each([1, 2, 3])("with %i panel(s) open, every boundary drags its own panel and the others keep their widths", async (n) => {
    render(opened(n))
    await settle()
    expect(columns()).toHaveLength(n)
    expect(separators()).toHaveLength(n)
    expect(shownWidths()).toEqual(Array(n).fill(PANEL_DEFAULT))

    const expected = Array<number>(n).fill(PANEL_DEFAULT)
    for (let i = 0; i < n; i++) {
      // Left widens: panel i grows by as much as the pointer moved, the rest stay as they were.
      drag(separators()[i]!, -40 * (i + 1))
      expected[i] = PANEL_DEFAULT + 40 * (i + 1)
      expect(shownWidths()).toEqual(expected)
      expect(columns().map((c) => c.style.getPropertyValue("--panel-w"))).toEqual(expected.map(panelWidthCss))
      // The strip beside the chat is as wide as its panels, as far as the chat's room goes.
      expect(aside().style.getPropertyValue("--thread-w")).toBe(stripWidthCss(expected))
    }
    // And right narrows it again.
    drag(separators()[n - 1]!, 100)
    expected[n - 1]! -= 100
    expect(shownWidths()).toEqual(expected)
  })

  it("the task panel's edge by the chat still drags once sub-task panels open beside it (the bug), on a laptop too", async () => {
    section = 1256 // a 1512px window beside the sidebar: three panels never fit, so they scroll
    render(opened(3))
    await settle()
    drag(separators()[0]!, -120)
    expect(shownWidths()).toEqual([PANEL_DEFAULT + 120, PANEL_DEFAULT, PANEL_DEFAULT])
    drag(separators()[0]!, 200)
    expect(shownWidths()).toEqual([PANEL_DEFAULT - 80, PANEL_DEFAULT, PANEL_DEFAULT])
  })

  it("a focused separator resizes with the keyboard: arrows, Shift for bigger steps, Home and End, Enter resets", async () => {
    render(opened(2))
    await settle()
    // Tab reaches the edges left to right: the chat's border first.
    expect([...document.querySelectorAll<HTMLElement>("[role=separator]")].filter((s) => separators().includes(s))).toEqual(separators())
    const sep = separators()[1]!
    expect(sep.tabIndex).toBe(0)
    expect(sep.getAttribute("aria-orientation")).toBe("vertical")
    expect(sep.getAttribute("aria-label")).toBe(`Width of ${DESIGNER.title}`)
    // On a left edge the arrows move the border the way they point: ← widens.
    key(sep, "ArrowLeft")
    expect(shownWidths()).toEqual([PANEL_DEFAULT, PANEL_DEFAULT + 10])
    key(sep, "ArrowRight", true)
    expect(shownWidths()).toEqual([PANEL_DEFAULT, PANEL_DEFAULT - 40])
    key(sep, "Home")
    expect(shownWidths()).toEqual([PANEL_DEFAULT, PANEL_MIN])
    key(sep, "End")
    expect(shownWidths()).toEqual([PANEL_DEFAULT, PANEL_MAX])
    key(sep, "Enter")
    expect(shownWidths()).toEqual([PANEL_DEFAULT, PANEL_DEFAULT])
  })

  it("a drag stops at the panel's minimum and at the room beside the chat, never squeezing the others", async () => {
    section = 1000
    render(opened(3))
    await settle()
    const room = section - THREAD_CHAT_ROOM
    for (const s of separators()) {
      expect(s.getAttribute("aria-valuemin")).toBe(String(PANEL_MIN))
      expect(s.getAttribute("aria-valuemax")).toBe(String(room))
    }
    drag(separators()[1]!, 2000)
    expect(shownWidths()).toEqual([PANEL_DEFAULT, PANEL_MIN, PANEL_DEFAULT])
    drag(separators()[1]!, -2000)
    expect(shownWidths()).toEqual([PANEL_DEFAULT, room, PANEL_DEFAULT])
  })

  it("panels that don't fit scroll sideways, and a drag keeps the panel's right edge still so its left edge follows the pointer", async () => {
    section = 1600 // room for 1280px of panels: three at 416 fit, wider ones scroll
    render(opened(3))
    await settle()
    expect(strip().className).toContain("overflow-x-auto")
    drag(separators()[2]!, -100) // 416 + 416 + 516 = 1348: 68px past the room
    expect(strip().scrollLeft).toBe(68)
    const middle = columns()[1]!
    const before = middle.getBoundingClientRect()
    pointer(separators()[1]!, "pointerdown", before.left)
    pointer(separators()[1]!, "pointermove", before.left - 150)
    const after = middle.getBoundingClientRect()
    expect(after.width).toBe(PANEL_DEFAULT + 150)
    // The strip scrolled by what the panel grew: its right edge (and the panel past it) stayed, its left edge moved
    // with the pointer, and the panels left of it went out of view to the left.
    expect(after.right).toBe(before.right)
    expect(after.left).toBe(before.left - 150)
    pointer(separators()[1]!, "pointermove", before.left - 50)
    expect(middle.getBoundingClientRect().left).toBe(before.left - 50)
    expect(middle.getBoundingClientRect().right).toBe(before.right)
    pointer(separators()[1]!, "pointerup", before.left - 50)
    expect(shownWidths()).toEqual([PANEL_DEFAULT, PANEL_DEFAULT + 50, PANEL_DEFAULT + 100])
    // Never squeezed under their minimum: each panel is its own width, none shrinks to fit (flex-none).
    for (const c of columns()) expect(c.className).toContain("flex-none")
  })

  it("with panels scrolled out of view, the chat's edge sets the first panel's width and the chat's room moves with it", async () => {
    section = 1600
    render(opened(3))
    await settle()
    drag(separators()[1]!, -300) // 416 + 716 + 416 = 1548: the first panel is partly scrolled out of view
    expect(strip().scrollLeft).toBe(268)
    const edge = chatEdge()
    // Where the strip starts: the chat's border.
    const border = () => section - stripLayout(shownWidths(), chatRoom(), section).shown
    const right = () => columns()[2]!.getBoundingClientRect().right
    expect(border()).toBe(THREAD_CHAT_ROOM)

    // Right narrows the first panel, and the border follows the pointer: the chat gets the room.
    drag(edge, 100)
    expect(shownWidths()).toEqual([PANEL_DEFAULT - 100, PANEL_DEFAULT + 300, PANEL_DEFAULT])
    expect(chatRoom()).toBe(THREAD_CHAT_ROOM + 100)
    expect(border()).toBe(THREAD_CHAT_ROOM + 100)
    expect(aside().style.getPropertyValue("--thread-w")).toBe(stripWidthCss(shownWidths(), THREAD_CHAT_ROOM + 100))
    // The newest panel stays where it is: what moved is on the left.
    expect(right()).toBe(section)
    expect(strip().scrollLeft).toBe(268)

    // Left takes the room back, and past the chat's least room the panel still grows: the strip scrolls.
    drag(edge, -100)
    expect(shownWidths()).toEqual([PANEL_DEFAULT, PANEL_DEFAULT + 300, PANEL_DEFAULT])
    expect(chatRoom()).toBe(THREAD_CHAT_ROOM)
    drag(edge, -150)
    expect(shownWidths()).toEqual([PANEL_DEFAULT + 150, PANEL_DEFAULT + 300, PANEL_DEFAULT])
    expect(chatRoom()).toBe(THREAD_CHAT_ROOM)
    expect(right()).toBe(section)
    expect(strip().scrollLeft).toBe(268 + 150)

    // Scrolled back to the first panel, its left edge stays at the border while it grows (the rest move right) and
    // while it narrows.
    act(() => void (strip().scrollLeft = 0))
    drag(edge, -50)
    expect(shownWidths()).toEqual([PANEL_DEFAULT + 200, PANEL_DEFAULT + 300, PANEL_DEFAULT])
    expect(strip().scrollLeft).toBe(0)
    expect(columns()[0]!.getBoundingClientRect().left).toBe(THREAD_CHAT_ROOM)
    drag(edge, 150)
    expect(shownWidths()).toEqual([PANEL_DEFAULT + 50, PANEL_DEFAULT + 300, PANEL_DEFAULT])
    expect(strip().scrollLeft).toBe(0)
    expect(border()).toBe(THREAD_CHAT_ROOM + 150)
    expect(columns()[0]!.getBoundingClientRect().left).toBe(border())
    // Enter puts it back: the first panel at its default, the chat at its least room.
    key(edge, "Enter")
    expect(shownWidths()).toEqual([PANEL_DEFAULT, PANEL_DEFAULT + 300, PANEL_DEFAULT])
    expect(chatRoom()).toBe(THREAD_CHAT_ROOM)
  })

  it("keeps widths in memory only: nothing in web storage, and a panel closed and opened again keeps its width", async () => {
    const stored: string[] = []
    const realSetItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      stored.push(`${k}=${v}`)
      Reflect.apply(realSetItem, this, [k, v])
    })
    render(opened(3))
    await settle()
    drag(separators()[0]!, -30)
    drag(separators()[2]!, -70)
    key(separators()[1]!, "ArrowRight")
    expect(shownWidths()).toEqual([PANEL_DEFAULT + 30, PANEL_DEFAULT - 10, PANEL_DEFAULT + 70])
    expect(stored.filter((s) => /width|panel/i.test(s))).toEqual([])
    expect(stored.filter((s) => s.includes(String(PANEL_DEFAULT + 70)))).toEqual([])

    // Close the sub-sub-task's panel, then open it again: it comes back at its width, and the others keep theirs.
    act(() => history.replaceState(history.state, "", opened(2)))
    act(() => void window.dispatchEvent(new PopStateEvent("popstate")))
    await settle()
    expect(shownWidths()).toEqual([PANEL_DEFAULT + 30, PANEL_DEFAULT - 10])
    act(() => history.replaceState(history.state, "", opened(3)))
    act(() => void window.dispatchEvent(new PopStateEvent("popstate")))
    await settle()
    expect(shownWidths()).toEqual([PANEL_DEFAULT + 30, PANEL_DEFAULT - 10, PANEL_DEFAULT + 70])
    // Closing them all and opening the task again keeps the first panel's width too.
    act(() => history.replaceState(history.state, "", APP_HOME))
    act(() => void window.dispatchEvent(new PopStateEvent("popstate")))
    await settle()
    expect(columns()).toHaveLength(0)
    act(() => history.replaceState(history.state, "", opened(1)))
    act(() => void window.dispatchEvent(new PopStateEvent("popstate")))
    await settle()
    // Beside the chat, at the width it had.
    expect(shownWidths()).toEqual([PANEL_DEFAULT + 30])
    expect(stored.filter((s) => /width|panel/i.test(s))).toEqual([])
  })

  it("each separator is a 1px line with a 12px zone for a mouse and a 44px grip for a finger, off the header's Back button", async () => {
    render(opened(2))
    await settle()
    for (const sep of separators()) {
      // Only where the panels sit beside the chat (a container query); a sheet over the chat has no edge.
      expect(sep.className).toContain("hidden")
      expect(sep.className).toContain("@min-[35.5rem]/coord:block")
      expect(sep.className).not.toMatch(/(?:^|\s)(?:sm|md|lg|xl):/)
      // A 12px zone just inside the panel's left border (left of it is the neighbour's scrollbar), under the header.
      expect(sep.className).toContain("w-3")
      expect(sep.className).toContain("left-0")
      expect(sep.className).toContain("top-14")
      const line = sep.querySelector<HTMLElement>("span:not([data-testid])")!
      expect(line.className).toContain("w-px")
      // A finger gets a 44px-wide, 88px-tall grip halfway down.
      const grip = sep.querySelector<HTMLElement>("[data-testid=resize-grip]")!
      expect(grip.className).toContain("pointer-coarse:block")
      expect(grip.className).toContain("w-11")
      // No animations, while dragging or not.
      expect(sep.outerHTML).not.toMatch(/transition|duration-|ease-|animate-/)
    }
    pointer(separators()[1]!, "pointerdown", 1000)
    expect(separators()[1]!.outerHTML).not.toMatch(/transition|duration-|ease-|animate-/)
    expect(document.body.classList.contains("resizing")).toBe(true)
    pointer(separators()[1]!, "pointerup", 1000)
    expect(document.body.classList.contains("resizing")).toBe(false)
  })
})

describe("moveChatEdge: the chat's edge sets the first panel's width, and follows the pointer as far as the chat allows", () => {
  const SECTION = 1600 // room for 1280px of panels
  const fit = [PANEL_DEFAULT, PANEL_DEFAULT] // 832px: all in view
  const over = [PANEL_DEFAULT, 700, 400] // 1516px: scrolled
  /** Where the border is (the strip's width) once the first panel is `first` wide. */
  const shown = (widths: number[], { first, chatRoom: room }: { first: number; chatRoom: number }) => stripLayout([first, ...widths.slice(1)], room, SECTION).shown

  it("with the panels all in view, the strip grows and shrinks with the first panel", () => {
    expect(moveChatEdge(fit, THREAD_CHAT_ROOM, SECTION, 500)).toEqual({ first: 500, chatRoom: THREAD_CHAT_ROOM })
    expect(moveChatEdge(fit, THREAD_CHAT_ROOM, SECTION, 300)).toEqual({ first: 300, chatRoom: THREAD_CHAT_ROOM })
    // Room the chat was given shrinks as the strip reaches it.
    const wider = moveChatEdge(fit, 600, SECTION, 600)
    expect(wider).toEqual({ first: 600, chatRoom: SECTION - 600 - PANEL_DEFAULT })
    expect(shown(fit, wider)).toBe(600 + PANEL_DEFAULT)
  })

  it("with panels scrolled out of view, the chat's room moves with the edge", () => {
    const narrower = moveChatEdge(over, THREAD_CHAT_ROOM, SECTION, PANEL_DEFAULT - 100)
    expect(narrower).toEqual({ first: PANEL_DEFAULT - 100, chatRoom: THREAD_CHAT_ROOM + 100 })
    expect(shown(over, narrower)).toBe(SECTION - THREAD_CHAT_ROOM - 100)
    const back = moveChatEdge([narrower.first, ...over.slice(1)], narrower.chatRoom, SECTION, PANEL_DEFAULT)
    expect(back).toEqual({ first: PANEL_DEFAULT, chatRoom: THREAD_CHAT_ROOM })
  })

  it("past the chat's least room the first panel still grows, and the chat keeps its room", () => {
    expect(moveChatEdge(over, THREAD_CHAT_ROOM, SECTION, 600)).toEqual({ first: 600, chatRoom: THREAD_CHAT_ROOM })
    expect(moveChatEdge([PANEL_DEFAULT, 700], THREAD_CHAT_ROOM, SECTION, 700)).toEqual({ first: 700, chatRoom: THREAD_CHAT_ROOM })
  })

  it("never under PANEL_MIN or over the room beside the chat", () => {
    expect(moveChatEdge(fit, THREAD_CHAT_ROOM, SECTION, 100).first).toBe(PANEL_MIN)
    expect(moveChatEdge(fit, THREAD_CHAT_ROOM, SECTION, 5000).first).toBe(SECTION - THREAD_CHAT_ROOM)
  })

  it("standing still changes nothing", () => {
    for (const [widths, room] of [[fit, THREAD_CHAT_ROOM], [fit, 600], [over, THREAD_CHAT_ROOM], [over, 600]] as const)
      expect(moveChatEdge(widths, room, SECTION, widths[0])).toEqual({ first: widths[0], chatRoom: room })
  })
})
