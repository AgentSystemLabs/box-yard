// @vitest-environment happy-dom
// Every time in the UI shows exactly when on a tap, not only on hover (phones can't hover), keeps itself up to date,
// and leaves the tap to a link or button it sits in. A running task's thread says how long it has been working.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Elapsed, TimeAgo } from "../web/src/components/ui.js"
import { TaskThread } from "../web/src/components/TaskView.js"
import { keys } from "../web/src/lib/queries.js"
import { absoluteTime, shortDate } from "../web/src/lib/time.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.UTC(2026, 10, 3, 13, 5, 9)
let root: Root
let host: HTMLElement

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ["Date", "setInterval", "clearInterval"] })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const render = (el: ReturnType<typeof createElement>) => act(() => root.render(el))
const time = () => host.querySelector("time")!
const bubble = () => document.querySelector<HTMLElement>("[data-testid=time-bubble]")
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })))
const key = (el: Element, k: string) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })
  act(() => void el.dispatchEvent(e))
  return e
}

describe("TimeAgo", () => {
  it("shows the exact time in a bubble on a tap, and closes on a second tap", () => {
    const ts = now - 4 * 60_000
    render(createElement(TimeAgo, { ts }))
    const t = time()
    expect(t.textContent).toBe("4m ago")
    expect(t.getAttribute("datetime")).toBe(new Date(ts).toISOString())
    expect(t.getAttribute("title")).toBe(absoluteTime(ts))
    expect(t.getAttribute("role")).toBe("button")
    expect(t.getAttribute("aria-expanded")).toBe("false")
    expect(bubble()).toBeNull()

    click(t)
    expect(bubble()!.textContent).toBe(absoluteTime(ts))
    expect(bubble()!.getAttribute("role")).toBe("tooltip")
    expect(t.getAttribute("aria-expanded")).toBe("true")
    expect(t.getAttribute("aria-describedby")).toBe(bubble()!.id)
    // No native tooltip on top of the bubble.
    expect(t.hasAttribute("title")).toBe(false)

    click(t)
    expect(bubble()).toBeNull()
    expect(t.getAttribute("title")).toBe(absoluteTime(ts))
  })

  it("closes on a tap elsewhere, and on Escape without closing what it sits in", () => {
    const onKeyDown = vi.fn()
    render(createElement("div", { onKeyDown }, createElement(TimeAgo, { ts: now })))
    click(time())
    act(() => void document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })))
    expect(bubble()).toBeNull()

    expect(key(time(), "Enter").defaultPrevented).toBe(true)
    expect(bubble()).not.toBeNull()
    key(time(), "Escape")
    expect(bubble()).toBeNull()
    // Opened with a tap, focus stays where it was: Escape from there closes it too.
    click(time())
    key(document.body, "Escape")
    expect(bubble()).toBeNull()
    // The dialog around it (Modal closes on Escape) never heard that one.
    expect(onKeyDown).not.toHaveBeenCalled()
    // With the bubble closed, Escape is the dialog's again.
    key(time(), "Escape")
    expect(onKeyDown).toHaveBeenCalledTimes(1)
  })

  it("keeps a tap for the row it sits in from opening that row, or focusing it (that shows a message's toolbar)", () => {
    const onClick = vi.fn()
    render(createElement("div", { onClick }, createElement(TimeAgo, { ts: now })))
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    act(() => void time().dispatchEvent(down))
    expect(down.defaultPrevented).toBe(true)
    click(time())
    expect(bubble()).not.toBeNull()
    expect(onClick).not.toHaveBeenCalled()
  })

  it("inside a link or button is part of it: a tap goes to the control and the time keeps its tooltip", () => {
    const onClick = vi.fn((e: MouseEvent) => e.preventDefault())
    render(
      createElement("div", null,
        createElement("a", { href: "/tasks/t1", onClick }, "Task ", createElement(TimeAgo, { ts: now })),
        createElement("button", { type: "button" }, createElement("span", null, createElement(TimeAgo, { ts: now }))),
      ),
    )
    const [inLink, inButton] = host.querySelectorAll("time")
    for (const t of [inLink!, inButton!]) {
      expect(t.hasAttribute("role")).toBe(false)
      expect(t.hasAttribute("tabindex")).toBe(false)
      expect(t.getAttribute("title")).toBe(absoluteTime(now))
    }
    click(inLink!)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(bubble()).toBeNull()
  })

  it("counts up on the shared clock, and says the date past a week", () => {
    render(createElement("div", null, createElement(TimeAgo, { ts: now - 20_000 }), createElement(TimeAgo, { ts: now + 3 * 3600_000 })))
    const [past, ahead] = host.querySelectorAll("time")
    expect(past!.textContent).toBe("just now")
    expect(ahead!.textContent).toBe("in 3h")
    act(() => void vi.advanceTimersByTime(60_000))
    expect(past!.textContent).toBe("1m ago")
    act(() => void vi.advanceTimersByTime(7 * 24 * 3600_000))
    expect(past!.textContent).toBe(shortDate(now - 20_000))
  })
})

describe("Elapsed", () => {
  it("leads its exact time with what it measures", () => {
    const since = now - 65 * 60_000
    render(createElement(Elapsed, { since, title: "This turn started" }))
    expect(time().textContent).toBe("1h 5m")
    click(time())
    expect(bubble()!.textContent).toBe(`This turn started ${absoluteTime(since)}`)
  })
})

describe("a working task's thread", () => {
  const taskId = "task_time0001"
  let qc: QueryClient
  beforeEach(() => {
    vi.stubGlobal("fetch", () => new Promise(() => {}))
    vi.stubGlobal("requestAnimationFrame", () => 0)
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    for (const k of [keys.projects, keys.tasks, keys.schedules, keys.artifacts, keys.taskQueue(taskId), keys.taskMessages(taskId)]) qc.setQueryData(k, [])
  })
  afterEach(() => qc.clear())
  const thread = (working: string | null, workingSince: number | null) =>
    createElement(QueryClientProvider, { client: qc },
      createElement(TaskThread, { id: taskId, handle: null, working, workingSince, selectionSource: null, selectionAsk: null, onFollowUp: () => {} }),
    )

  it("says how long it has been working, live, with when it started on a tap", () => {
    const since = now - 12 * 60_000
    render(thread("Agent is working…", since))
    const line = host.querySelector<HTMLElement>("[data-testid=working-for]")!
    expect(line.parentElement!.textContent).toContain("Agent is working…")
    expect(line.textContent).toBe("· 12m")
    act(() => void vi.advanceTimersByTime(60_000))
    expect(line.textContent).toBe("· 13m")
    click(line.querySelector("time")!)
    expect(bubble()!.textContent).toBe(`Started ${absoluteTime(since)}`)
  })

  it("says nothing of the sort once it stops", () => {
    render(thread(null, null))
    expect(host.querySelector("[data-testid=working-for]")).toBeNull()
  })
})
