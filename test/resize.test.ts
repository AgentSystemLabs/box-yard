// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { ResizeHandle, useResizable } from "../web/src/lib/resize.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KEY = "test:panel-width"
let root: Root
let host: HTMLElement
let width: number

function Panel({ edge = "right", enabled = true, limit = 480 }: { edge?: "left" | "right"; enabled?: boolean; limit?: number }) {
  const size = useResizable({ key: KEY, defaultWidth: 256, min: 200, max: 480, edge, enabled, limit })
  width = size.width
  return createElement(ResizeHandle, { ...size.handle, className: "block", label: "Sidebar width" })
}
const mount = (props: Parameters<typeof Panel>[0] = {}) => act(() => root.render(createElement(Panel, props)))
const handle = () => host.querySelector<HTMLElement>("[role=separator]")!
const key = (name: string, shiftKey = false) => act(() => void handle().dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true })))
const pointer = (type: string, clientX: number) => act(() => void handle().dispatchEvent(new PointerEvent(type, { button: 0, pointerId: 1, clientX, bubbles: true, cancelable: true })))

beforeEach(() => {
  localStorage.clear()
  if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => {}
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

it("exposes a focusable named separator with live bounds and keyboard resizing/reset", () => {
  mount({ limit: 400 })
  expect(handle().tabIndex).toBe(0)
  expect(handle().getAttribute("aria-label")).toBe("Sidebar width")
  expect(handle().getAttribute("aria-valuemin")).toBe("200")
  expect(handle().getAttribute("aria-valuemax")).toBe("400")
  key("ArrowRight")
  expect(width).toBe(266)
  key("ArrowRight", true)
  expect(width).toBe(316)
  expect(localStorage.getItem(KEY)).toBe("316")
  key("Home")
  key("ArrowLeft")
  expect(width).toBe(200)
  key("End")
  key("ArrowRight")
  expect(width).toBe(400)
  expect(handle().getAttribute("aria-valuenow")).toBe("400")
  key("Enter")
  expect(width).toBe(256)
  expect(localStorage.getItem(KEY)).toBeNull()
})

it("left-edge arrow keys move the border in the same direction as dragging", () => {
  mount({ edge: "left" })
  key("ArrowLeft")
  expect(width).toBe(266)
  key("ArrowRight", true)
  expect(width).toBe(216)
})

it("keyboard changes start at the displayed cap without overwriting a larger preference on resize", () => {
  localStorage.setItem(KEY, "480")
  mount({ limit: 350 })
  expect(width).toBe(480)
  expect(handle().getAttribute("aria-valuenow")).toBe("350")
  expect(localStorage.getItem(KEY)).toBe("480")
  key("ArrowLeft")
  expect(width).toBe(340)
  expect(localStorage.getItem(KEY)).toBe("340")
})

it("stops pointer resizing when the panel folds during a drag", () => {
  mount()
  pointer("pointerdown", 256)
  pointer("pointermove", 350)
  expect(document.body.classList.contains("resizing")).toBe(true)
  mount({ enabled: false })
  expect(document.body.classList.contains("resizing")).toBe(false)
  mount()
  pointer("pointermove", 400)
  expect(width).toBe(350)
  expect(localStorage.getItem(KEY)).toBeNull()
})

it("falls back to the default width when storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage denied") })
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage denied") })
  mount()
  expect(width).toBe(256)
  key("ArrowRight")
  expect(width).toBe(266)
})
