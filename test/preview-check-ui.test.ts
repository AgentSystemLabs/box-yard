// @vitest-environment happy-dom
// While a task's page shows a preview it asks the server, now and then, whether the preview's server still answers
// (usePreviewCheck, in TaskHeader); the server drops a stopped one with a task update. Only in view: a hidden tab asks
// nothing, coming back to it asks at once, and a task with no preview never asks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { PREVIEW_CHECK_EVERY_MS, usePreviewCheck } from "../web/src/lib/previewCheck.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let fetches: { url: string; method: string }[]
let visibility: DocumentVisibilityState

function Probe({ taskId, shows }: { taskId: string; shows: boolean }) {
  usePreviewCheck(taskId, shows)
  return null
}

const render = (taskId: string, shows: boolean) => act(() => root.render(createElement(Probe, { taskId, shows })))
const setVisibility = (v: DocumentVisibilityState) => {
  visibility = v
  act(() => void document.dispatchEvent(new Event("visibilitychange")))
}

beforeEach(() => {
  vi.useFakeTimers()
  fetches = []
  visibility = "visible"
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility)
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    fetches.push({ url, method: String(init.method) })
    return Promise.resolve(new Response('{"ok":true}', { status: 202 }))
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("usePreviewCheck", () => {
  it("asks when the page opens and once a minute while it's in view", () => {
    render("task_prev001", true)
    expect(fetches).toEqual([{ url: "/api/tasks/task_prev001/previews/check", method: "POST" }])
    act(() => void vi.advanceTimersByTime(PREVIEW_CHECK_EVERY_MS))
    expect(fetches).toHaveLength(2)
  })

  it("asks nothing for a task without a preview, and stops once its last one goes", () => {
    render("task_prev002", false)
    act(() => void vi.advanceTimersByTime(PREVIEW_CHECK_EVERY_MS * 3))
    setVisibility("visible")
    expect(fetches).toEqual([])
    render("task_prev002", true)
    expect(fetches).toHaveLength(1)
    render("task_prev002", false)
    act(() => void vi.advanceTimersByTime(PREVIEW_CHECK_EVERY_MS * 3))
    expect(fetches).toHaveLength(1)
  })

  it("asks nothing while the tab is hidden, and at once when it's back", () => {
    render("task_prev003", true)
    setVisibility("hidden")
    act(() => void vi.advanceTimersByTime(PREVIEW_CHECK_EVERY_MS * 2))
    expect(fetches).toHaveLength(1)
    setVisibility("visible")
    expect(fetches).toHaveLength(2)
  })

  it("stops asking once the page closes", () => {
    render("task_prev004", true)
    act(() => root.unmount())
    root = createRoot(host)
    act(() => void vi.advanceTimersByTime(PREVIEW_CHECK_EVERY_MS * 2))
    setVisibility("visible")
    expect(fetches).toHaveLength(1)
  })
})
