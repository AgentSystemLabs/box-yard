// @vitest-environment happy-dom
// Loading states wait LOADING_DELAY_MS before they show (lib/loading.ts): a quick response goes straight to the content.
// A slow one gets a still skeleton (components/Loading.tsx) that held its space, invisibly, from the first frame.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { LOADING_DELAY_MS, useDelayedFlag } from "../web/src/lib/loading.js"
import { Loading, type LoadingKind } from "../web/src/components/Loading.js"
import { TaskThread } from "../web/src/components/TaskView.js"
import { RunnerSettings } from "../web/src/components/RunnerSettings.js"
import { keys } from "../web/src/lib/queries.js"
import type { TaskMessage } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let qc: QueryClient
/** Requests in flight by path; answer them with `respond`. */
let pending: Map<string, (body: unknown) => void>

beforeEach(() => {
  vi.useFakeTimers()
  pending = new Map()
  vi.stubGlobal("fetch", (path: string) => new Promise((resolve) => {
    pending.set(path, (body) => resolve({ ok: true, status: 200, text: async () => JSON.stringify(body) }))
  }))
  vi.stubGlobal("requestAnimationFrame", () => 0)
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  qc.clear()
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const render = (el: ReturnType<typeof createElement>) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, el)))
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
const respond = (path: string, body: unknown) => act(async () => {
  pending.get(path)!(body)
  await vi.advanceTimersByTimeAsync(0)
})
const status = () => host.querySelector<HTMLElement>("[data-loading]")

describe("useDelayedFlag", () => {
  const Probe = ({ active }: { active: boolean }) => createElement("i", null, String(useDelayedFlag(active)))

  it("stays false through a quick load and turns true once the load is slow", async () => {
    render(createElement(Probe, { active: true }))
    expect(host.textContent).toBe("false")
    await wait(LOADING_DELAY_MS - 1)
    expect(host.textContent).toBe("false")
    await wait(1)
    expect(host.textContent).toBe("true")
  })

  it("turns false the moment the load ends, and waits the full delay again for the next one", async () => {
    render(createElement(Probe, { active: true }))
    await wait(LOADING_DELAY_MS)
    render(createElement(Probe, { active: false }))
    expect(host.textContent).toBe("false")
    render(createElement(Probe, { active: true }))
    expect(host.textContent).toBe("false")
    await wait(LOADING_DELAY_MS - 1)
    expect(host.textContent).toBe("false")
    await wait(1)
    expect(host.textContent).toBe("true")
  })
})

describe("Loading", () => {
  it.each<LoadingKind>(["chat", "rows", "field", "line"])("%s: holds its space invisibly, then shows and says what's loading", async (kind) => {
    render(createElement(Loading, { kind, label: "Loading the transcript" }))
    const el = status()!
    expect(el.getAttribute("role")).toBe("status")
    expect(el.dataset.loading).toBe("waiting")
    expect(el.className).toContain("invisible")
    expect(el.textContent).toBe("")

    await wait(LOADING_DELAY_MS)
    expect(el.dataset.loading).toBe("shown")
    expect(el.className).not.toContain("invisible")
    expect(el.textContent).toBe("Loading the transcript…")
    // Still: no spinner and no shimmer.
    expect(host.querySelector("svg, .animate-spin, .animate-pulse")).toBeNull()
  })

  it("draws as many paragraphs or rows as asked, hidden from screen readers", () => {
    render(createElement("div", null, createElement(Loading, { kind: "chat", count: 2 }), createElement(Loading, { kind: "rows", count: 4 })))
    const [chat, rows] = host.querySelectorAll("[data-loading]")
    expect(chat!.querySelectorAll(":scope > [aria-hidden]")).toHaveLength(2)
    expect(rows!.querySelectorAll(":scope > [aria-hidden]")).toHaveLength(4)
  })

  it("puts the label after the rows, so the first row keeps its first-child styling when it appears", async () => {
    render(createElement(Loading, { kind: "rows", label: "Loading hooks" }))
    await wait(LOADING_DELAY_MS)
    expect(status()!.lastElementChild!.textContent).toBe("Loading hooks…")
    expect(status()!.firstElementChild!.getAttribute("aria-hidden")).toBe("true")
  })
})

describe("a task transcript loading", () => {
  const taskId = "task_load0001"
  const path = `/api/tasks/${taskId}/messages`
  const reply: TaskMessage = { id: "m1", taskId, role: "assistant", content: "All done.", meta: null, createdAt: 1 }
  beforeEach(() => {
    qc.setQueryData(keys.taskQueue(taskId), [])
    // This fixture isolates transcript loading; date-index loading has its own independent state/tests.
    qc.setQueryData(["history-days", `/api/tasks/${taskId}/history`, Intl.DateTimeFormat().resolvedOptions().timeZone], { days: [], oldestId: null })
    render(createElement(TaskThread, { id: taskId, handle: null, working: null, selectionSource: null, selectionAsk: null, onFollowUp: () => {} }))
  })

  it("goes straight to the messages when they come back quickly, never showing a loading state", async () => {
    expect(status()?.dataset.loading).toBe("waiting")
    await wait(LOADING_DELAY_MS / 2)
    expect(status()!.dataset.loading).toBe("waiting")
    await respond(path, [reply])
    expect(status()).toBeNull()
    expect(host.textContent).toContain("All done.")
    expect(host.textContent).not.toContain("Loading")
  })

  it("shows the skeleton once the load is slow, then swaps it for the messages", async () => {
    await wait(LOADING_DELAY_MS)
    expect(status()!.dataset.loading).toBe("shown")
    expect(status()!.textContent).toBe("Loading the transcript…")
    await respond(path, [reply])
    expect(status()).toBeNull()
    expect(host.textContent).toContain("All done.")
  })
})

describe("Settings › Box providers loading", () => {
  it("keeps every runner card's status line, as a bar, until its status is known", async () => {
    render(createElement(RunnerSettings, { fid: (k: string) => k, onSection: () => {}, dirtySections: new Set(), active: true, settings: null }))
    const lines = () => [...host.querySelectorAll<HTMLElement>("[data-runner-section] [data-loading]")]
    expect(lines().length).toBeGreaterThan(3)
    expect(host.textContent).not.toContain("Loading…")
    await wait(LOADING_DELAY_MS)
    expect(lines().every((l) => l.dataset.loading === "shown")).toBe(true)
  })
})
