// @vitest-environment happy-dom
import { act, createElement as h } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useTranscriptHistory } from "../web/src/lib/transcriptHistory"
import { useTail } from "../web/src/lib/tail"
import { api } from "../web/src/lib/api"
import { ChatHistory, DayBoundary } from "../web/src/components/ChatHistory"

vi.mock("../web/src/lib/api", async (original) => ({ ...await original<typeof import("../web/src/lib/api")>(), api: vi.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const item = (i: number) => ({ id: `m-${i}`, createdAt: Date.UTC(2026, 0, 1) + i * 86400_000, role: "assistant", content: "Example reply" })
const live = Array.from({ length: 500 }, (_, i) => item(i + 1000))
let state: ReturnType<typeof useTranscriptHistory<(typeof live)[number]>>
let tail: ReturnType<typeof useTail<(typeof live)[number]>>
let root: Root, host: HTMLElement, qc: QueryClient
function History({ path = "/api/chat/history", list = live }) {
  state = useTranscriptHistory(path, list)
  tail = useTail(state.items, path, { max: 200 })
  return h(ChatHistory, { days: state.days ?? [], messages: state.items, ensure: state.ensure, reveal: tail.reveal,
    children: h("div", { "data-scroller": true }, tail.visible.map((m) => h("div", { key: m.id, "data-chat-id": m.id }, h(DayBoundary, { at: m.createdAt, messageId: m.id }), m.content))) })
}
const render = (path?: string, list = live) => act(() => root.render(h(QueryClientProvider, { client: qc }, h(History, { path, list }))))
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host)
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  vi.mocked(api).mockImplementation(async (path) => {
    if (String(path).includes("days=1")) return [{ at: item(0).createdAt, messageId: "m-0" }] as never
    if (String(path).includes("around=m-0")) return { messages: Array.from({ length: 80 }, (_, i) => item(i)), before: null, after: "m-79" } as never
    if (String(path).includes("before=")) return { messages: Array.from({ length: 100 }, (_, i) => item(i + 900)), before: "m-900", after: "m-999" } as never
    return { messages: Array.from({ length: 100 }, (_, i) => item(i + 80)), before: "m-80", after: "m-179" } as never
  })
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(performance.now()), 1))
  vi.stubGlobal("cancelAnimationFrame", clearTimeout)
  vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(() => {})
})
afterEach(() => { act(() => root.unmount()); host.remove(); qc.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe("bounded retained history", () => {
  it("loads a date older than the initial API cap, focuses it, and keeps the live cache separate", async () => {
    render(); await settle()
    const button = host.querySelector<HTMLButtonElement>('nav button')!
    act(() => button.click()); await settle(); await settle()
    expect(api).toHaveBeenCalledWith("/api/chat/history?around=m-0")
    expect(document.activeElement?.getAttribute("data-day-start")).toBe("m-0")
    expect(state.items[0]?.id).toBe("m-0")
    expect(state.moreBefore).toBe(false)
    expect(state.moreAfter).toBe(true)
    expect(live[0]?.id).toBe("m-1000")
    act(() => state.toLatest())
    expect(state.items).toBe(live)
  })

  it("keeps pages ordered and bounded while moving backward and forward", async () => {
    render(); await settle()
    act(() => state.earlier()); await settle()
    expect(state.items).toHaveLength(200)
    expect(state.items.map((m) => m.id)).toEqual(Array.from({ length: 200 }, (_, i) => `m-${i + 900}`))
    expect(new Set(state.items.map((m) => m.id)).size).toBe(200)
    act(() => { void state.ensure("m-0") }); await settle()
    act(() => state.later()); await settle()
    expect(state.items.map((m) => m.id)).toEqual(Array.from({ length: 180 }, (_, i) => `m-${i}`))
  })

  it("ignores a late page after switching chats and after returning to latest", async () => {
    render(); await settle()
    let resolve!: (page: unknown) => void
    vi.mocked(api).mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    act(() => { void state.ensure("m-0") })
    render("/api/projects/prj_example/captain/history"); await settle()
    await act(async () => resolve({ messages: [item(0)], before: null, after: null }))
    expect(state.items).toBe(live)
    vi.mocked(api).mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    act(() => { void state.ensure("m-0") }); act(() => state.toLatest())
    await act(async () => resolve({ messages: [item(0)], before: null, after: null }))
    expect(state.items).toBe(live)
  })

  it("bounds rendered messages when revealing very old loaded rows and can move forward again", async () => {
    render(); await settle()
    act(() => { tail.reveal("m-1000") })
    expect(tail.visible).toHaveLength(200)
    expect(tail.later).toBe(300)
    act(() => tail.loadLater())
    expect(tail.visible).toHaveLength(200)
    expect(tail.visible[0]?.id).toBe("m-1050")
  })

  it("adds a newly streamed date to the complete rail without another transcript request", async () => {
    render(); await settle()
    const count = vi.mocked(api).mock.calls.length
    render(undefined, [...live, item(1600)])
    expect(state.days?.at(-1)?.messageId).toBe("m-1600")
    expect(vi.mocked(api).mock.calls).toHaveLength(count)
    expect(host.querySelectorAll('nav button').length).toBeLessThanOrEqual(80)
  })
})
