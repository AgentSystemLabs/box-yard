// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { SIDEBAR_WIDTH, SidebarPane, sidebarLimit, sidebarWidthCss } from "../web/src/components/SidebarPane.js"
import { keys } from "../web/src/lib/queries.js"
import { closeSidebarDrawer, setSidebarCollapsed } from "../web/src/lib/sidebar.js"
import { openThread, closeThread, COORDINATOR_CHAT } from "../web/src/lib/threads.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let container: number
let resized: () => void
const viewport = (width: number) => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height: 900 })
const pane = () => host.querySelector<HTMLElement>("[data-testid=sidebar]")!
const handle = () => pane()?.querySelector<HTMLElement>("[role=separator]")
const widthCss = () => pane().style.getPropertyValue("--sidebar-w")
const pointer = (type: string, clientX: number) => act(() => void handle()!.dispatchEvent(new PointerEvent(type, { button: 0, pointerId: 1, clientX, bubbles: true, cancelable: true })))
function drag(from: number, to: number) {
  pointer("pointerdown", from)
  pointer("pointermove", to)
  pointer("pointerup", to)
}
const mount = (rail = false) => act(() => root.render(createElement(SidebarPane, { rail })))

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  container = 1440
  viewport(container)
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: container }) as DOMRect)
  vi.stubGlobal("ResizeObserver", class {
    constructor(cb: () => void) { resized = cb }
    observe() {}
    disconnect() {}
  })
  if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => {}
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  act(() => {
    setSidebarCollapsed(false)
    closeSidebarDrawer()
    closeThread(COORDINATOR_CHAT)
  })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it("drags the sidebar's right edge within its limits and restores the saved width on remount", () => {
  mount()
  expect(widthCss()).toBe(sidebarWidthCss(256))
  drag(256, 350)
  expect(widthCss()).toBe(sidebarWidthCss(350))
  expect(localStorage.getItem(SIDEBAR_WIDTH.key)).toBe("350")
  act(() => root.unmount())
  root = createRoot(host)
  mount()
  expect(widthCss()).toBe(sidebarWidthCss(350))
  drag(350, 2000)
  expect(widthCss()).toBe(sidebarWidthCss(480))
  drag(480, -1000)
  expect(widthCss()).toBe(sidebarWidthCss(200))
})

it("clamps invalid saved widths and resets the preference on double-click", () => {
  localStorage.setItem(SIDEBAR_WIDTH.key, "5000")
  mount()
  expect(widthCss()).toBe(sidebarWidthCss(480))
  act(() => void handle()!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })))
  expect(widthCss()).toBe(sidebarWidthCss(256))
  expect(localStorage.getItem(SIDEBAR_WIDTH.key)).toBeNull()
})

it("caps the display and the next drag to leave room for the centre without losing the preference on window resize", () => {
  localStorage.setItem(SIDEBAR_WIDTH.key, "480")
  mount()
  container = 768
  act(() => resized())
  expect(handle()!.getAttribute("aria-valuemax")).toBe("448")
  expect(handle()!.getAttribute("aria-valuenow")).toBe("448")
  expect(widthCss()).toBe(sidebarWidthCss(480)) // CSS caps the displayed width; the saved preference survives.
  expect(localStorage.getItem(SIDEBAR_WIDTH.key)).toBe("480")
  container = 1440
  act(() => resized())
  expect(handle()!.getAttribute("aria-valuenow")).toBe("480")
  container = 768
  act(() => resized())
  drag(448, 400)
  expect(widthCss()).toBe(sidebarWidthCss(400))
  expect(localStorage.getItem(SIDEBAR_WIDTH.key)).toBe("400")
  expect(sidebarLimit(0)).toBe(200)
})

it("keeps the folded rail fixed, with no handle, and restores the expanded width", () => {
  localStorage.setItem(SIDEBAR_WIDTH.key, "360")
  mount()
  mount(true)
  expect(pane().classList.contains("w-14")).toBe(true)
  expect(handle()).toBeNull()
  mount()
  expect(widthCss()).toBe(sidebarWidthCss(360))
  expect(handle()).not.toBeNull()
})

it("doesn't re-render or remount its children on drag", () => {
  let renders = 0
  function Content() {
    renders++
    return createElement("div", null, createElement("input", { defaultValue: "Sidebar search" }))
  }
  act(() => root.render(createElement(SidebarPane, { rail: false }, createElement(Content))))
  const input = pane().querySelector("input")!
  input.value = "Keep this search"
  pane().firstElementChild!.scrollTop = 42
  const before = renders
  drag(256, 350)
  expect(renders).toBe(before)
  expect(pane().querySelector("input")).toBe(input)
  expect(input.value).toBe("Keep this search")
  expect(pane().firstElementChild!.scrollTop).toBe(42)
})

function renderApp() {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
  vi.stubGlobal("EventSource", class { addEventListener() {} removeEventListener() {} close() {} })
  history.replaceState(null, "", "/")
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.agentSettings, { settings: { ownerName: "Cody" }, sources: {}, defaults: {} })
  qc.setQueryData(keys.health, { mock: true, problems: [], pool: {} })
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.orchestrator, { busy: false, usage: { tokens: 0, window: 1_000_000 }, compacting: false, compactQueued: false })
  for (const k of [keys.chat, keys.tasks, keys.projects, keys.artifacts, keys.schedules, keys.boxes, keys.notifications]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
}

it("mounts a handle only for the desktop column, keeps the centre draft, and folds beside a panel below 1280px", () => {
  viewport(1100)
  renderApp()
  const draft = host.querySelector("textarea")!
  draft.value = "Keep the centre draft"
  const path = location.href
  drag(256, 360)
  expect(host.querySelector("textarea")).toBe(draft)
  expect(draft.value).toBe("Keep the centre draft")
  expect(location.href).toBe(path)
  act(() => openThread(COORDINATOR_CHAT, "thr_sidebar01"))
  expect(pane().dataset.rail).toBe("true")
  expect(handle()).toBeNull()
  act(() => closeThread(COORDINATOR_CHAT))
  expect(widthCss()).toBe(sidebarWidthCss(360))
})

it("leaves the phone drawer without a drag handle", () => {
  viewport(400)
  renderApp()
  expect(pane()).toBeNull()
  const menu = host.querySelector("button[aria-label='Projects and tasks']")!
  act(() => void menu.dispatchEvent(new MouseEvent("click", { bubbles: true })))
  const drawer = document.querySelector("[role=dialog][aria-label='Projects and tasks']")!
  expect(drawer).not.toBeNull()
  expect(drawer.querySelector("[role=separator]")).toBeNull()
})
