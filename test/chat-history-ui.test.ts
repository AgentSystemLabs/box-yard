// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Fragment, act, createElement as h, memo, useMemo } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ChatHistory, DayBoundary } from "../web/src/components/ChatHistory"
import { chatDays } from "../web/src/lib/chatDays"
import { useTail } from "../web/src/lib/tail"
import type { StickyScrollHandle } from "../web/src/components/StickyScroll"
import { keys } from "../web/src/lib/queries"
import type { ChatMessage, Task } from "../shared/types"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const at = (day: number) => +new Date(2026, 10, day, 12)
const messages: ChatMessage[] = Array.from({ length: 90 }, (_, i) => ({
  id: `message-${i}`, role: "assistant", content: `Reply ${i}`, meta: null, createdAt: at(1 + Math.floor(i / 30)),
}))
const task = (projectId = "project-a", title = "Fix login") => ({
  id: `task-${projectId}`, projectId, title, createdAt: at(1), prState: "open", prMergedAt: null,
}) as Task
let root: Root
let host: HTMLElement
let qc: QueryClient
let renders = 0
const scrollToEnd = vi.fn()
const scrollHandle = { current: { scrollToEnd } as StickyScrollHandle }
const Transcript = memo(function Transcript({ visible }: { visible: ChatMessage[] }) {
  renders++
  return h("div", { "data-scroller": true }, visible.map((m, i) => h(Fragment, { key: m.id },
    h(DayBoundary, { at: m.createdAt, previousAt: visible[i - 1]?.createdAt, messageId: m.id }),
    h("p", { "data-chat-id": m.id }, m.content),
  )))
})
function History({ projectId = "project-a", list = messages }: { projectId?: string; list?: ChatMessage[] }) {
  const days = useMemo(() => chatDays(list), [list])
  const tail = useTail(list, projectId, { initial: 5 })
  return h(ChatHistory, { days, messages: list, reveal: tail.reveal, scrollHandle, projectId, children: h(Transcript, { visible: tail.visible }) })
}
const click = (button: Element) => act(() => { button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })) })
const action = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label)!
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })
const railButtons = (index = 0) => host.querySelectorAll<HTMLElement>("nav")[index]!.querySelectorAll<HTMLButtonElement>("button")

beforeEach(() => {
  renders = 0
  scrollToEnd.mockClear()
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(keys.tasks, [task(), task("project-b", "Other project's secret task")])
  qc.setQueryData(keys.projects, [{ id: "project-a", repo: "team/alpha" }, { id: "project-b", repo: "team/beta" }])
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(performance.now()), 1))
  vi.stubGlobal("cancelAnimationFrame", clearTimeout)
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {})
  vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(() => {})
})
afterEach(() => {
  act(() => root.unmount())
  qc.clear()
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const render = (children = h(History)) => act(() => root.render(h(QueryClientProvider, { client: qc }, children)))

describe("chat day navigation", () => {
  it("reveals an unrendered day's first message, releases the bottom first, and scopes the jump to one history", async () => {
    render(h(Fragment, null, h(History), h(History)))
    expect(host.querySelector('[data-day-start="message-0"]')).toBeNull()
    const leaveBottom = vi.fn()
    host.querySelector("[data-scroller]")!.addEventListener("boxyard:leave-bottom", leaveBottom)
    click(railButtons()[0]!)
    expect(leaveBottom).not.toHaveBeenCalled()
    click(action("Jump to day"))
    expect(leaveBottom).toHaveBeenCalled()
    await settle()
    expect(host.querySelectorAll('[data-day-start="message-0"]')).toHaveLength(1)
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" })
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled()
    expect(document.activeElement?.getAttribute("data-day-start")).toBe("message-0")
  })

  it.each(["mouse", "touch", "pen"])("repeated %s activations only preview; an explicit day jump navigates", async (pointerType) => {
    render()
    const button = railButtons()[0]!
    const tap = () => {
      act(() => { button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType })) })
      act(() => button.focus())
      click(button)
    }
    tap()
    expect(host.querySelector('[data-day-start="message-0"]')).toBeNull()
    expect(host.querySelector('[role="region"]')?.textContent).toContain("Started: Fix login")
    expect(host.querySelector('[role="region"]')?.textContent).not.toContain("Other project's secret task")
    tap()
    await settle()
    expect(host.querySelector('[data-day-start="message-0"]')).toBeNull()
    expect(host.querySelector('[role="region"]')).not.toBeNull()
    click(action("Jump to day"))
    await settle()
    expect(host.querySelector('[data-day-start="message-0"]')).not.toBeNull()
    expect(host.querySelector('[role="region"]')).toBeNull()
  })


  it.each([0, 2])("keeps the preview open without jumping on a repeated click with detail %s", async (detail) => {
    render()
    const leaveBottom = vi.fn()
    host.querySelector("[data-scroller]")!.addEventListener("boxyard:leave-bottom", leaveBottom)
    const button = railButtons()[0]!
    click(button)
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }))
      button.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }))
    })
    await settle()
    expect(host.querySelector('[role="region"]')).not.toBeNull()
    expect(host.querySelector('[data-day-start="message-0"]')).toBeNull()
    expect(leaveBottom).not.toHaveBeenCalled()
    expect(HTMLElement.prototype.scrollTo).not.toHaveBeenCalled()
    expect(scrollToEnd).not.toHaveBeenCalled()
    expect(host.querySelector("nav")?.getAttribute("aria-label")).not.toContain("again")
  })

  it("jumps to the oldest day from any day's preview and delegates end navigation to StickyScroll", async () => {
    render()
    click(railButtons()[2]!)
    const group = host.querySelector('[role="group"][aria-label="Transcript navigation"]')!
    expect([...group.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Jump to start", "Jump to end"])
    click(action("Jump to start"))
    await settle()
    expect(document.activeElement?.getAttribute("data-day-start")).toBe("message-0")
    click(railButtons()[0]!)
    click(action("Jump to end"))
    expect(scrollToEnd).toHaveBeenCalledOnce()
    expect(host.querySelector('[role="region"]')).toBeNull()
  })

  it("ignores hover and focus, opens on activation, and restores focus without reopening on dismissal", () => {
    render()
    const button = railButtons()[0]!
    act(() => { button.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })) })
    act(() => button.focus())
    expect(host.querySelector('[role="region"]')).toBeNull()
    expect(button.getAttribute("aria-expanded")).toBe("false")
    // Native keyboard activation dispatches click with detail 0 (Enter/Space are also checked in browsers).
    act(() => { button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })) })
    expect(button.getAttribute("aria-expanded")).toBe("true")
    expect(button.getAttribute("aria-controls")).toBe(host.querySelector('[role="region"]')?.id)
    const close = host.querySelector<HTMLButtonElement>('[aria-label="Close day summary"]')!
    act(() => close.focus())
    act(() => { close.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })) })
    expect(host.querySelector('[role="region"]')).toBeNull()
    expect(document.activeElement).toBe(button)
    act(() => button.blur())
    act(() => button.focus())
    expect(host.querySelector('[role="region"]')).toBeNull()
    click(button)
    click(host.querySelector('[aria-label="Close day summary"]')!)
    expect(host.querySelector('[role="region"]')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it("keeps an open day unchanged while hovering or focusing another, switching only on click", () => {
    render()
    const [first, second] = railButtons()
    click(first!)
    const label = host.querySelector('[role="region"]')!.getAttribute("aria-label")
    act(() => { second!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })) })
    act(() => second!.focus())
    expect(host.querySelector('[role="region"]')!.getAttribute("aria-label")).toBe(label)
    expect(first!.getAttribute("aria-expanded")).toBe("true")
    click(second!)
    expect(first!.getAttribute("aria-expanded")).toBe("false")
    expect(second!.getAttribute("aria-expanded")).toBe("true")
    expect(host.querySelector('[role="region"]')!.getAttribute("aria-label")).not.toBe(label)
    act(() => { host.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })) })
    expect(host.querySelector('[role="region"]')).toBeNull()
  })

  it("updates recorded task milestones without rendering the transcript again", async () => {
    render()
    click(railButtons()[0]!)
    const before = renders
    await act(async () => {
      qc.setQueryData(keys.tasks, [{ ...task(), prState: "merged", prMergedAt: at(1) }])
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(host.querySelector('[role="region"]')?.textContent).toContain("PR merged: Fix login")
    expect(renders).toBe(before)
  })

  it("opens highlighted summary references in new tabs without jumping or bubbling", async () => {
    qc.setQueryData(keys.tasks, [{ ...task(), title: "Fix #12 and other/repo#9; https://github.com/team/alpha/pull/42" }])
    const parentClick = vi.fn()
    render(h("div", { onClick: parentClick }, h(History)))
    click(railButtons()[0]!)
    parentClick.mockClear()
    const popup = host.querySelector('[role="region"]')!
    const links = [...popup.querySelectorAll<HTMLAnchorElement>("a")]
    expect(links.map((a) => a.href)).toEqual([
      "https://github.com/team/alpha/issues/12",
      "https://github.com/other/repo/issues/9",
      "https://github.com/team/alpha/pull/42",
    ])
    for (const link of links) {
      expect(link.target).toBe("_blank")
      expect(link.rel).toBe("noopener noreferrer")
      expect(link.className).toContain("min-h-11")
      expect(link.className).toContain("min-w-11")
      click(link)
    }
    await settle()
    expect(parentClick).not.toHaveBeenCalled()
    expect(host.querySelector('[data-day-start="message-0"]')).toBeNull()
    expect(host.querySelector('[role="region"]')).not.toBeNull()
    expect(qc.isFetching()).toBe(0)
  })

  it("updates repo context from cache without rendering the transcript or fetching", async () => {
    qc.setQueryData(keys.tasks, [{ ...task(), title: "Fix #12" }])
    qc.setQueryData(keys.projects, [])
    render()
    click(railButtons()[0]!)
    expect(host.querySelector('[role="region"] a')).toBeNull()
    const before = renders
    await act(async () => {
      qc.setQueryData(keys.projects, [{ id: "project-a", repo: "team/alpha" }])
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(host.querySelector('a')?.getAttribute("href")).toBe("https://github.com/team/alpha/issues/12")
    expect(renders).toBe(before)
    expect(qc.isFetching()).toBe(0)
  })
  it.each(["click", "Enter", " "])("jumps a summary body with %s to an unrendered source and marks it until the next interaction", async (action) => {
    const list = messages.map((m, i) => i === 10 ? { ...m, role: "notice" as const, content: "✅ **Fix login** is done: Fixed.", meta: { taskId: task().id } } : m)
    render(h(Fragment, null, h(History, { list }), h(History, { list })))
    click(railButtons()[0]!)
    const bullet = host.querySelector<HTMLElement>("[data-summary-jump]")!
    expect(bullet.textContent).toContain("Jump to message")
    expect(bullet.className).toContain("min-h-11")
    expect(bullet.getAttribute("role")).toBe("link")
    if (action === "click") click(bullet)
    else act(() => { bullet.dispatchEvent(new KeyboardEvent("keydown", { key: action, bubbles: true })) })
    await settle()
    const source = host.querySelector<HTMLElement>('[data-chat-highlight]')!
    expect(source?.getAttribute("data-chat-id")).toBe("message-10")
    expect(host.querySelectorAll('[data-chat-id="message-10"]')).toHaveLength(1)
    expect(document.activeElement).toBe(source)
    expect(host.querySelector('[role="region"]')).toBeNull()
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" })
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled()
    const interaction = action === "click" ? new PointerEvent("pointerdown", { bubbles: true }) : action === "Enter" ? new KeyboardEvent("keydown", { key: "Tab", bubbles: true }) : new WheelEvent("wheel", { bubbles: true })
    act(() => { document.dispatchEvent(interaction) })
    expect(source.hasAttribute("data-chat-highlight")).toBe(false)
    expect(source.hasAttribute("tabindex")).toBe(false)
  })

  it("falls back to the day's first message when the milestone has no source", async () => {
    render()
    click(railButtons()[0]!)
    const bullet = host.querySelector<HTMLElement>("[data-summary-jump]")!
    expect(bullet.textContent).toContain("Jump to day")
    click(bullet)
    await settle()
    expect(host.querySelector('[data-chat-highlight]')?.getAttribute("data-day-start")).toBe("message-0")
  })

  it("does not treat a nested GitHub link's keyboard event as a summary jump", async () => {
    qc.setQueryData(keys.tasks, [{ ...task(), title: "Fix #12" }])
    render()
    click(railButtons()[0]!)
    const link = host.querySelector("[data-summary-jump] a")!
    act(() => { link.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })) })
    click(link)
    await settle()
    expect(host.querySelector('[role="region"]')).not.toBeNull()
    expect(host.querySelector('[data-chat-highlight]')).toBeNull()
    expect(host.querySelector('[data-day-start="message-0"]')).toBeNull()
  })

})
