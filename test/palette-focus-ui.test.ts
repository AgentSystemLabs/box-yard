// @vitest-environment happy-dom
// A pick in the command palette that opens a chat puts the caret in its box, after the draft, once the chat is on
// screen and the palette has given the focus back (lib/chatSwitch.ts focusComposer): a Captain, the Coordinator, a task
// or sub-task, a PR's task. Only the palette's pick: a page load, a link and Back leave the focus where it is, and on a
// touch screen the keyboard stays down.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { openPalette } from "../web/src/components/CommandPalette.js"
import { warmLazyParts } from "../web/src/components/LazyPart.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { keys } from "../web/src/lib/queries.js"
import { setChatProjectFilter } from "../web/src/lib/projectBar.js"
import { closeSidebarDrawer, setSidebarCollapsed } from "../web/src/lib/sidebar.js"
import { resetColumns } from "../web/src/lib/columns.js"
import { resetDrafts, setDraftText } from "../web/src/lib/composerDraft.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import { APP_HOME, navigateApp, taskSessionHref } from "../web/src/lib/navigation.js"
import type { Project, Task, TaskStatus } from "../shared/types"

// "New project…" and Settings open in the same render, as once the app has settled.
beforeAll(() => warmLazyParts())

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const project = (id: string, name: string) => ({ id, name, repo: null, description: "", notes: [], envKeys: [], baseBranch: "main", runner: "box", identityId: "idn_default", gpuMachine: { gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null }, docker: { image: null, dockerfile: null }, createdAt: now, color: null }) as unknown as Project
const task = (id: string, projectId: string, title: string, status: TaskStatus, extra: Partial<Task> = {}) =>
  ({ id, projectId, title, status, prompt: "", prUrl: null, prState: null, prMergedAt: null, previews: [], waitFor: [], question: null, error: null, scheduleId: null, outcome: null, createdAt: now - 60_000, updatedAt: now - 60_000, ...extra }) as unknown as Task

const YARD = project("prj_yard01", "box-yard")
const SITE = project("prj_site01", "marketing-site")
const RUN = task("task_run001", YARD.id, "Three-pane layout", "working")
const KID = task("task_kid001", YARD.id, "Rail icons for the panes", "idle", { parentTaskId: RUN.id, rootTaskId: RUN.id })
const ASK = task("task_ask001", YARD.id, "Check SSH into the bench", "needs_input")
const PR = task("task_pr0001", SITE.id, "Refresh the portfolio", "pr_ready", { prUrl: "https://github.com/o/site/pull/19" })

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

function render(path = APP_HOME) {
  history.replaceState(null, "", path)
  sessionStorage.setItem("box-yard:landed", "1")
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.agentSettings, { settings: DEFAULT_SETTINGS, sources: {}, defaults: DEFAULT_SETTINGS })
  qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.chat, [])
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, [RUN, KID, ASK, PR])
  qc.setQueryData(keys.projects, [YARD, SITE])
  for (const p of [YARD, SITE]) qc.setQueryData(keys.captain(p.id), { projectId: p.id, busy: false, usage: { tokens: null, window: null, updatedAt: null } })
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  resetDrafts()
  ;(window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 1440, height: 900 })
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
  })
  resetDrafts()
  vi.unstubAllGlobals()
})

// The box takes the focus once the frame after the pick is painted (lib/chatSwitch.ts useComposerFocus).
const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0))))
const palette = () => document.querySelector<HTMLElement>("[role=dialog][aria-label='Command palette']")
const input = () => document.querySelector<HTMLInputElement>("input[role=combobox]")!
const selected = () => document.querySelector("[role=option][aria-selected=true]")
const option = (key: string) => document.querySelector<HTMLElement>(`[role=option][data-key='${key}']`)!
const centreBox = () => [...document.querySelectorAll<HTMLTextAreaElement>("[data-testid=chat-footer] textarea")].find((t) => t.checkVisibility())!
const panelBox = (t: Task) => document.querySelector<HTMLTextAreaElement>(`[role=dialog][aria-label='${t.title}'] textarea`)
const title = () => [...document.querySelectorAll("[data-testid=chat-title]")].find((t) => t.checkVisibility())!.textContent
const caret = (el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]
const press = (key: string, init: KeyboardEventInit = {}) => act(() => void input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })))
const type = (text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text)
    input().dispatchEvent(new Event("input", { bubbles: true }))
  })

/** Search the palette for `query` and open the row `key`: with the arrows and Enter, or a click on it. */
function pick(query: string, key: string, how: "enter" | "click" = "enter") {
  act(() => openPalette())
  type(query)
  if (how === "click") return act(() => void option(key).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
  for (let i = 0; selected()?.getAttribute("data-key") !== key; i++) {
    if (i > 20) throw new Error(`no ${key} row for "${query}"`)
    press("ArrowDown")
  }
  press("Enter")
}

describe("a palette pick that opens a chat puts the caret in its box", () => {
  it("a Captain, picked with Enter: its box, the caret after the draft", async () => {
    render()
    setDraftText(`captain:${SITE.id}`, "Swap the hero image")
    pick("marketing", `project:${SITE.id}`)
    await frame()
    expect(palette()).toBeNull()
    expect(title()).toBe("marketing-site Captain")
    expect(document.activeElement).toBe(centreBox())
    expect(centreBox().value).toBe("Swap the hero image")
    expect(caret(centreBox())).toEqual([19, 19])
  })

  it("the Coordinator, from a Captain", async () => {
    render()
    pick("box-yard", `project:${YARD.id}`)
    await frame()
    expect(title()).toBe("box-yard Captain")
    setDraftText("coordinator", "What's left for Friday?")
    pick("coordinator", "page:coordinator")
    await frame()
    expect(centreBox().placeholder).toBe("Ask the Coordinator…")
    expect(document.activeElement).toBe(centreBox())
    expect(caret(centreBox())).toEqual([23, 23])
  })

  it("a task, a sub-task and a PR's task: the box in its panel, while its history still loads", async () => {
    render()
    setDraftText(`task:${RUN.id}`, "Also the rail")
    pick("three-pane", `task:${RUN.id}`)
    await frame()
    expect(document.activeElement).toBe(panelBox(RUN))
    expect(caret(panelBox(RUN)!)).toEqual([13, 13])
    pick("rail icons", `task:${KID.id}`)
    await frame()
    expect(document.activeElement).toBe(panelBox(KID))
    pick("#19", `pr:${PR.id}`)
    await frame()
    expect(document.activeElement).toBe(panelBox(PR))
  })

  it("a click or tap on the row, as Enter", async () => {
    render()
    pick("box-yard", `project:${YARD.id}`, "click")
    await frame()
    expect(palette()).toBeNull()
    expect(title()).toBe("box-yard Captain")
    expect(document.activeElement).toBe(centreBox())
  })

  it("a box already on screen takes it from where the palette gave it back, with the caret moved to the end", async () => {
    render()
    // Opened by a link, so nothing focused it.
    act(() => navigateApp(taskSessionHref(RUN.id)))
    await frame()
    act(() => setDraftText(`task:${RUN.id}`, "Also the rail"))
    const box = panelBox(RUN)!
    expect(document.activeElement).not.toBe(box)
    // Cody was typing to the Coordinator, the caret at the start of the task's draft from before.
    box.setSelectionRange(0, 0)
    act(() => centreBox().focus())
    expect(caret(box)).toEqual([0, 0])
    pick("three-pane", `task:${RUN.id}`)
    await frame()
    expect(panelBox(RUN)).toBe(box)
    expect(document.activeElement).toBe(box)
    expect(caret(box)).toEqual([13, 13])
  })

  it("not in the frame the chat first paints: focusing restyles and lays out the page", async () => {
    render()
    pick("marketing", `project:${SITE.id}`)
    let inFrame: Element | null = null
    await act(() => new Promise<void>((r) => requestAnimationFrame(() => r(void (inFrame = document.activeElement)))))
    expect(title()).toBe("marketing-site Captain")
    expect(inFrame).not.toBe(centreBox())
    await frame()
    expect(document.activeElement).toBe(centreBox())
  })
})

describe("only the palette's pick, and not everywhere", () => {
  it("a page load, a link and Back leave the focus as they did: the panel's own, not its box", async () => {
    render(taskSessionHref(RUN.id))
    await frame()
    expect(panelBox(RUN)).toBeTruthy()
    expect(document.activeElement).not.toBe(panelBox(RUN))
    act(() => navigateApp(taskSessionHref(ASK.id)))
    await frame()
    expect(panelBox(ASK)).toBeTruthy()
    expect(document.activeElement).not.toBe(panelBox(ASK))
    act(() => {
      history.replaceState(null, "", taskSessionHref(RUN.id))
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }))
    })
    await frame()
    expect(panelBox(RUN)).toBeTruthy()
    expect(document.activeElement).not.toBe(panelBox(RUN))
    // The Coordinator's box, behind it, neither.
    expect(document.activeElement).not.toBe(centreBox())
  })

  it("a pick's request is taken once: going back to that chat later by a link doesn't focus it again", async () => {
    render()
    pick("three-pane", `task:${RUN.id}`)
    await frame()
    expect(document.activeElement).toBe(panelBox(RUN))
    act(() => panelBox(RUN)!.blur())
    act(() => navigateApp(taskSessionHref(ASK.id)))
    await frame()
    act(() => navigateApp(taskSessionHref(RUN.id)))
    await frame()
    expect(panelBox(RUN)).toBeTruthy()
    expect(document.activeElement).not.toBe(panelBox(RUN))
  })

  it("on a touch screen the keyboard stays down: no focus", async () => {
    const media = window.matchMedia.bind(window)
    vi.stubGlobal("matchMedia", (q: string) => (/coarse/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : media(q)))
    render()
    pick("marketing", `project:${SITE.id}`)
    await frame()
    await frame()
    expect(title()).toBe("marketing-site Captain")
    expect(document.activeElement).not.toBe(centreBox())
  })

  it("a palette opened again before the box takes the focus keeps it, and the request goes", async () => {
    render()
    pick("marketing", `project:${SITE.id}`)
    act(() => openPalette())
    await frame()
    expect(document.activeElement).toBe(input())
    press("Escape")
    await frame()
    expect(palette()).toBeNull()
    expect(document.activeElement).not.toBe(centreBox())
  })

  it("a dialog's own field still takes the focus: New project…'s name, Settings' search", async () => {
    render()
    pick("new project", "action:new-project")
    await frame()
    expect(document.activeElement).toBe(document.querySelector("[role=dialog] input[placeholder='marketing-site']"))
    act(() => root.unmount())
    root = createRoot(host)
    render()
    pick("voice", "setting:voice")
    await frame()
    expect(document.activeElement).toBe(document.querySelector("input[aria-label='Search settings']"))
  })
})
