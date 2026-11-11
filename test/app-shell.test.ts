// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { openPalette } from "../web/src/components/CommandPalette.js"
import { keys } from "../web/src/lib/queries.js"
import { currentToasts, dismiss, isCritical, showsWhenQuiet, toast, type Toast } from "../web/src/lib/toast.js"
import { setChatProjectFilter } from "../web/src/lib/projectBar.js"
import type { ChatMessage, Project, Task } from "../shared/types"
import { APP_HOME } from "../web/src/lib/navigation.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const TASKS = [
  {
    id: "task_app001",
    projectId: "prj_demo01",
    title: "Write the docs",
    prompt: "Write the docs.",
    status: "working",
    boxId: null,
    sessionId: "s",
    branch: null,
    prUrl: null,
    prState: null,
    prMergedAt: null,
    prMergedBy: null,
    previews: [],
    question: null,
    summary: null,
    error: null,
    waitReason: null,
    turnCount: 1,
    pendingCount: 0,
    lastArchivedAt: null,
    scheduleId: null,
    outcome: null,
    contextTokens: null,
    contextWindow: null,
    compactPending: false,
    compacting: false,
    model: null,
    effort: null,
    claudeCostUsd: 0,
    claudeTokens: 0,
    routingRule: null,
    routingReason: null,
    createdAt: now,
    updatedAt: now,
  },
] as Task[]
const PROJECTS = [{ id: "prj_demo01", name: "box-yard", repo: "acme/box-yard", description: "", notes: [], updatedAt: now }] as unknown as Project[]
const CHAT: ChatMessage[] = [
  { id: "msg_1", role: "user", content: "What's everyone doing?", meta: null, createdAt: now - 2000 },
  { id: "msg_2", role: "assistant", content: "One agent is on [the docs](/tasks/task_app001).", meta: null, createdAt: now - 1000 },
]

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

/** Renders `path` as a reload of this tab (already landed), not a new tab's first load. */
function render(path = "/", tokens = 84_000, autoCompact = false, tasks = TASKS) {
  history.replaceState(null, "", path)
  sessionStorage.setItem("box-yard:landed", "1")
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  const orchestratorAutoCompact = { enabled: autoCompact, unit: "tokens", value: 250_000 }
  qc.setQueryData(keys.agentSettings, { settings: { ownerName: "Cody", orchestratorAutoCompact }, sources: {}, defaults: {} })
  qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.orchestrator, { busy: false, usage: { tokens, window: 1_000_000, updatedAt: now }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null })
  qc.setQueryData(keys.chat, CHAT)
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, tasks)
  qc.setQueryData(keys.projects, PROJECTS)
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
}

/** The centre chat: the Coordinator's, or the picked Captain's. */
const chat = () => document.querySelector<HTMLElement>("[data-testid=chat-panel], [data-testid=captain-chat][data-centre]")
const inApp = () => Boolean(document.querySelector("[data-app]"))
const sidebarOrPage = () => document.querySelector("main, aside, nav")
/** The old app's sidebar and pages; the app's own sidebar is the "Projects and tasks" nav. */
const LEGACY_CHROME = "aside, nav:not([aria-label='Projects and tasks']):not([aria-label^='Chat days'])"
/** A phone: no room for the sidebar, so the chat header keeps search (and a menu button opens the sidebar). */
const phone = () => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 400, height: 800 })
const keydown = (init: KeyboardEventInit, target: EventTarget = window) =>
  act(() => void target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })))
const oldToggleKey = () => keydown({ key: "Ω", code: "KeyZ", altKey: true, shiftKey: true })
/** history.back() lands asynchronously (popstate), like in a browser. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)))

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
  vi.stubGlobal("EventSource", FakeEventSource)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  ;(window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 1024, height: 768 })
  host.remove()
  document.body.innerHTML = ""
  for (const t of currentToasts()) dismiss(t.id)
  act(() => setChatProjectFilter(null))
  vi.unstubAllGlobals()
})

describe("the app shell", () => {
  it("opens task search from a phone's header without a keyboard and returns focus when closed", () => {
    phone()
    render(APP_HOME)
    const search = chat()!.querySelector<HTMLButtonElement>('header button[aria-label="Search and commands"]')!
    expect(search).not.toBeNull()
    act(() => search.click())
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search Box Yard"]')!
    expect(document.activeElement).toBe(input)
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Write the docs")
    act(() => document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')!.click())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(search)
  })

  it("finds a hidden done task by touch and opens it beside the chat", async () => {
    const done = { ...TASKS[0]!, id: "task_old001", title: "Fix attachment previews", status: "done" as const }
    phone()
    render(APP_HOME, 84_000, true, [...TASKS, done])
    expect(chat()!.querySelector('[data-card="task_old001"]')).toBeNull()
    act(() => chat()!.querySelector<HTMLButtonElement>('button[aria-label="Search and commands"]')!.click())
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search Box Yard"]')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "attachment")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    const result = document.querySelector<HTMLElement>('[role="option"][data-key="task:task_old001"]')!
    // Its state is the status icon's name, not a word on the row.
    expect(result.querySelector('[aria-label="Done"]')).not.toBeNull()
    act(() => result.click())
    await settle()
    expect(document.querySelector('input[aria-label="Search Box Yard"]')).toBeNull()
    expect(inApp()).toBe(true)
    expect(new URLSearchParams(location.search).get("session")).toBe("task_old001")
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Fix attachment previews")
  })

  it("/ renders the Coordinator chat beside the sidebar: no legacy sidebar, page or app header", () => {
    render(APP_HOME)
    expect(inApp()).toBe(true)
    expect(chat()).not.toBeNull()
    expect(document.querySelector(LEGACY_CHROME)).toBeNull()
    expect(document.querySelector("[data-testid=sidebar] nav[aria-label='Projects and tasks']")).not.toBeNull()
    expect(document.querySelector("[aria-label='Open navigation']")).toBeNull()
    // The same transcript and composer, with no context-management controls.
    expect(chat()!.textContent).toContain("One agent is on")
    expect([...chat()!.querySelectorAll("button")].some((b) => b.textContent?.includes("Compact"))).toBe(false)
    expect([...chat()!.querySelectorAll("button")].some((b) => /clear|reset/i.test(b.textContent ?? ""))).toBe(false)
    expect(chat()!.querySelector("textarea")).not.toBeNull()
    expect(chat()!.querySelector("header")!.textContent).toContain("Box Yard Coordinator")
    // Every row pads in to the one centered column: the header, the thread, the composer and the line floating over
    // it. Projects are picked in the sidebar, so there's no project bar.
    expect(chat()!.querySelectorAll(".chat-column").length).toBe(4)
    expect(chat()!.querySelector('[data-testid="filter-bar"]')).toBeNull()
  })

  it.each([false, true])("keeps manual context controls out of Coordinator and Captain chat (auto-compact=%s)", (autoCompact) => {
    for (const path of [APP_HOME, `${APP_HOME}?project=prj_demo01`, "/"]) {
      render(path, 900_000, autoCompact)
      expect(chat()!.querySelector("[data-testid=context-meter], [data-testid=context-mini], [data-testid=context-menu-button]")).toBeNull()
      expect([...chat()!.querySelectorAll("button")].some((b) => /compact|clear|reset/i.test(`${b.textContent} ${b.getAttribute("aria-label")}`))).toBe(false)
      // Settings and search (the palette's 🔍) sit in the sidebar beside it.
      expect(document.querySelector("nav[aria-label='Projects and tasks'] [aria-label=Settings]")).not.toBeNull()
      expect(document.querySelector("nav[aria-label='Projects and tasks'] button[aria-label='Search and commands']")).not.toBeNull()
      expect(chat()!.querySelector("textarea")).not.toBeNull()
    }
  })

  it("Esc closes an open modal (the palette) first and stays in the app", () => {
    render(APP_HOME)
    act(() => openPalette())
    expect(document.querySelector("[role=dialog]")).not.toBeNull()
    keydown({ key: "Escape" })
    expect(document.querySelector("[role=dialog]")).toBeNull()
    expect(location.pathname).toBe(APP_HOME)
    expect(inApp()).toBe(true)
    keydown({ key: "Escape" })
    expect(inApp()).toBe(true)
  })

  it("Esc that something else already claimed doesn't leave", () => {
    render(APP_HOME)
    const claim = (e: KeyboardEvent) => e.preventDefault()
    document.addEventListener("keydown", claim)
    keydown({ key: "Escape" }, chat()!.querySelector("textarea")!)
    document.removeEventListener("keydown", claim)
    expect(inApp()).toBe(true)
  })


  it("the old layout toggle shortcut (Alt+Shift+Z) and Esc change nothing", () => {
    render("/inbox")
    oldToggleKey()
    keydown({ key: "Escape" })
    expect(location.pathname).toBe(APP_HOME)
    expect(inApp()).toBe(true)
    expect(document.querySelector(LEGACY_CHROME)).toBeNull()
  })

  it("shows only critical toasts and Undo ones, at the top, clear of the composer", () => {
    render(APP_HOME)
    act(() => {
      toast.info("Saved")
      toast.task({ title: "Docs PR ready", href: "/tasks/task_app001", tone: "green", status: "pr_ready" })
      toast.task({ title: "Build broke", href: "/tasks/task_app001", tone: "red", status: "failed" })
    })
    const stack = () => document.querySelector<HTMLElement>("[data-quiet]")!
    expect(stack()).not.toBeNull()
    expect(stack().className).toContain("top-")
    expect(stack().className).not.toContain("bottom-")
    expect(stack().textContent).toContain("Build broke")
    expect(stack().textContent).not.toContain("Saved")
    expect(stack().textContent).not.toContain("Docs PR ready")
    // Screen readers still hear the ones the stack doesn't draw, from the spoken copy; the stack itself isn't live.
    expect(stack().getAttribute("aria-live")).toBeNull()
    expect(document.querySelector("[data-testid=spoken-toasts]")!.textContent).toContain("Docs PR ready. PR ready")
    act(() => {
      toast.error("Couldn't send")
      toast.info("Marked done", "Fix login", { action: { label: "Undo", onClick: () => {} } })
    })
    expect(stack().textContent).toContain("Couldn't send")
    // An Undo answers what Cody just did: one that never shows can't be used.
    expect(stack().textContent).toContain("Marked done")
    expect(stack().textContent).toContain("Undo")
  })

  it("isCritical keeps errors and failed tasks only; the quiet stack also shows a toast with an action", () => {
    const t = (x: Partial<Toast>) => ({ id: 1, kind: "info", title: "", ...x }) as Toast
    expect(isCritical(t({ kind: "error" }))).toBe(true)
    expect(isCritical(t({ kind: "task", tone: "red" }))).toBe(true)
    expect(isCritical(t({ kind: "task", tone: "amber" }))).toBe(false)
    expect(isCritical(t({ kind: "info", progress: true }))).toBe(false)
    const undo = t({ kind: "info", action: { label: "Undo", onClick: () => {} } })
    expect(isCritical(undo)).toBe(false)
    expect(showsWhenQuiet(undo)).toBe(true)
    expect(showsWhenQuiet(t({ kind: "info" }))).toBe(false)
    expect(showsWhenQuiet(t({ kind: "error" }))).toBe(true)
  })
})
