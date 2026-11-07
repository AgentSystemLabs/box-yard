// @vitest-environment happy-dom
// Opening a task or a Captain paints its newest rows first (useTail's `first`, `fill`), and a press, a resting hover or focus on a task's
// row or link loads its conversation before the click (lib/taskPrefetch.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, useDeferredValue } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useTail } from "../web/src/lib/tail.js"
import { firstPaintCount } from "../web/src/components/TaskView.js"
import { HOVER_INTENT_MS, openingMarkdown, taskToOpen, useWarmTaskOnIntent } from "../web/src/lib/taskPrefetch.js"
import { keys } from "../web/src/lib/queries.js"
import type { TaskMessage } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const msg = (i: number, role: TaskMessage["role"] = "assistant", meta: TaskMessage["meta"] = null): TaskMessage => ({
  id: `tm_${String(i).padStart(4, "0")}`, taskId: "task_open01", role, content: `Reply ${i}`, meta, createdAt: 1_000 + i,
})
const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `m${from + i}` }))

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("firstPaintCount", () => {
  it("covers the newest 20 rows that take room, counting the events folded between them", () => {
    expect(firstPaintCount(Array.from({ length: 100 }, (_, i) => msg(i)))).toBe(20)
    const withEvents = Array.from({ length: 100 }, (_, i) => msg(i, i % 2 ? "event" : "assistant"))
    expect(firstPaintCount(withEvents)).toBe(40)
  })

  it("is the whole list when it's shorter", () => {
    expect(firstPaintCount(Array.from({ length: 12 }, (_, i) => msg(i)))).toBe(12)
    expect(firstPaintCount([])).toBe(0)
  })
})

describe("useTail's first paint", () => {
  // requestAnimationFrame callbacks wait here until the test runs the frame (the browser paints after it).
  let frames: FrameRequestCallback[]
  let painted: string[][]
  const paint = () =>
    act(() => {
      const run = frames
      frames = []
      run.forEach((cb) => cb(0))
    })
  const afterPaint = () => act(() => void vi.advanceTimersByTime(0))

  function List({ items, resetKey, first, grow }: { items: { id: string }[]; resetKey: string; first?: number; grow?: number }) {
    const tail = useTail(items, resetKey, { first, grow })
    painted.push(tail.visible.map((m) => m.id))
    return createElement("div", { "data-hidden": tail.hidden }, tail.visible.map((m) => createElement("p", { key: m.id }, m.id)))
  }
  const render = (items: { id: string }[], resetKey = "task_a", first?: number, grow?: number) =>
    act(() => root.render(createElement(List, { items, resetKey, first, grow })))
  const shown = () => painted.at(-1)!

  beforeEach(() => {
    vi.useFakeTimers()
    frames = []
    painted = []
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb))
    vi.stubGlobal("cancelAnimationFrame", () => {})
  })

  it("paints only the newest `first` items, then the rest of the newest 60 once that frame is on screen", () => {
    const items = ids(200)
    render(items, "task_a", 20)
    expect(shown()).toEqual(items.slice(180).map((m) => m.id))
    // The frame runs: still the short list on screen.
    paint()
    expect(shown()).toHaveLength(20)
    afterPaint()
    expect(shown()).toEqual(items.slice(140).map((m) => m.id))
    expect(Number(host.firstElementChild!.getAttribute("data-hidden"))).toBe(140)
  })

  it("with `grow`, adds that many older items a frame after the first paint, so nothing waits behind all of them", () => {
    const items = ids(200)
    render(items, "captain_a", 4, 8)
    const grown = [shown().length]
    while (frames.length) {
      paint()
      afterPaint()
      grown.push(shown().length)
    }
    expect(grown).toEqual([4, 12, 20, 28, 36, 44, 52, 60])
    expect(shown()).toEqual(items.slice(140).map((m) => m.id))
  })

  it("renders each step as a transition, which a tap goes ahead of instead of waiting for it", () => {
    // A transition's render has a deferred value's newest at once; an urgent one (as a tap's) renders the last one first.
    const seen: [number, number][] = []
    function Probe({ items }: { items: { id: string }[] }) {
      const tail = useTail(items, "captain_a", { first: 4, grow: 8 })
      seen.push([tail.visible.length, useDeferredValue(tail.visible.length)])
      return null
    }
    act(() => root.render(createElement(Probe, { items: ids(200) })))
    paint()
    afterPaint()
    paint()
    afterPaint()
    expect(seen.at(-1)).toEqual([20, 20])
    expect(seen.filter(([shown, deferred]) => shown !== deferred)).toEqual([])
  })

  it("keeps growing a frame at a time past a message that arrives, and stops for a reader who loads earlier", () => {
    let loadEarlier = () => {}
    function Probe({ items }: { items: { id: string }[] }) {
      const tail = useTail(items, "captain_a", { first: 4, grow: 8 })
      loadEarlier = tail.loadEarlier
      painted.push(tail.visible.map((m) => m.id))
      return null
    }
    const items = ids(200)
    act(() => root.render(createElement(Probe, { items })))
    paint()
    afterPaint()
    act(() => root.render(createElement(Probe, { items: [...items, ...ids(1, 200)] })))
    expect(shown()).toHaveLength(13)
    expect(shown().at(-1)).toBe("m200")
    paint()
    afterPaint()
    expect(shown()).toHaveLength(21)
    act(() => loadEarlier())
    expect(shown()).toHaveLength(110)
    paint()
    afterPaint()
    expect(shown()).toHaveLength(110)
  })

  it("keeps messages that arrive meanwhile, and starts over for the next task", () => {
    const items = ids(200)
    render(items, "task_a", 20)
    const more = [...items, ...ids(3, 200)]
    render(more, "task_a", 20)
    expect(shown().at(-1)).toBe("m202")
    paint()
    afterPaint()
    expect(shown()).toHaveLength(60)
    expect(shown().at(-1)).toBe("m202")
    render(ids(100, 1000), "task_b", 20)
    expect(shown()).toHaveLength(20)
    paint()
    afterPaint()
    expect(shown()).toHaveLength(60)
  })

  it("waits for the transcript: a list that's empty at first gets its short first paint when the messages land", () => {
    render([], "task_a", 20)
    expect(frames).toHaveLength(0)
    render(ids(200), "task_a", 20)
    expect(shown()).toHaveLength(20)
    paint()
    afterPaint()
    expect(shown()).toHaveLength(60)
  })

  it("loads earlier from the newest 60, even before the rest of them have rendered", () => {
    let loadEarlier = () => {}
    function Probe({ items }: { items: { id: string }[] }) {
      const tail = useTail(items, "task_a", { first: 20 })
      loadEarlier = tail.loadEarlier
      painted.push(tail.visible.map((m) => m.id))
      return null
    }
    act(() => root.render(createElement(Probe, { items: ids(200) })))
    expect(shown()).toHaveLength(20)
    act(() => loadEarlier())
    expect(shown()).toHaveLength(110)
    paint()
    afterPaint()
    expect(shown()).toHaveLength(110)
  })

  it("renders the newest 60 at once without `first`, as the chats do", () => {
    render(ids(200))
    expect(shown()).toHaveLength(60)
    expect(frames).toHaveLength(0)
  })

  it("fills a first paint short of the view in the same render, doubling up to the newest 60 (a Captain's chat)", () => {
    let fill = () => false
    function Probe({ items }: { items: { id: string }[] }) {
      const tail = useTail(items, "captain_a", { first: 4 })
      fill = tail.fill
      painted.push(tail.visible.map((m) => m.id))
      return null
    }
    const items = ids(200)
    act(() => root.render(createElement(Probe, { items })))
    expect(shown()).toEqual(items.slice(196).map((m) => m.id))
    const grown: number[] = []
    for (let i = 0; i < 4; i++) {
      act(() => void expect(fill()).toBe(true))
      grown.push(shown().length)
    }
    expect(grown).toEqual([8, 16, 32, 60])
    expect(shown()).toEqual(items.slice(140).map((m) => m.id))
    // The rest is for scrolling up (loadEarlier), not filling.
    expect(fill()).toBe(false)
    paint()
    afterPaint()
    expect(shown()).toHaveLength(60)
  })
})

describe("taskToOpen", () => {
  const el = (html: string) => {
    host.innerHTML = html
    return host.querySelector("[data-target]") ?? host.firstElementChild!
  }

  it("reads a sidebar row's task, and a link's or notice's to the task's conversation", () => {
    expect(taskToOpen(el(`<button data-open-task="task_row01"><span data-target>Title</span></button>`))).toBe("task_row01")
    expect(taskToOpen(el(`<a href="/?session=task_link01">Open</a>`))).toBe("task_link01")
    expect(taskToOpen(el(`<a href="/tasks/task_legacy1"><b data-target>Old link</b></a>`))).toBe("task_legacy1")
    expect(taskToOpen(el(`<div role="link" data-href="/?session=task_note01"><p data-target>Done</p></div>`))).toBe("task_note01")
  })

  it("ignores everything else", () => {
    expect(taskToOpen(el(`<a href="/?captain=prj_demo01">Captain</a>`))).toBeNull()
    expect(taskToOpen(el(`<a href="https://github.com/?session=task_link01">GitHub</a>`))).toBeNull()
    expect(taskToOpen(el(`<button data-href="https://github.com/o/r/pull/1">PR</button>`))).toBeNull()
    expect(taskToOpen(el(`<p>Text</p>`))).toBeNull()
    expect(taskToOpen(null)).toBeNull()
  })
})

describe("openingMarkdown", () => {
  it("is the Markdown among the newest 60 rows the task opens on: replies and hook events, not tool calls or plain lines", () => {
    const list = [
      ...Array.from({ length: 100 }, (_, i) => msg(i)),
      ...Array.from({ length: 100 }, (_, i) => msg(100 + i, "tool")),
      msg(200, "user"),
      msg(201, "event", { kind: "hook", status: "fired" }),
      msg(202, "event"),
      msg(203),
    ]
    const texts = openingMarkdown(list)
    expect(texts).toHaveLength(58)
    expect(texts[0]).toBe("Reply 44")
    expect(texts.slice(-2)).toEqual(["Reply 201", "Reply 203"])
  })
})

describe("useWarmTaskOnIntent", () => {
  let qc: QueryClient
  let requests: string[]

  beforeEach(() => {
    vi.useFakeTimers()
    requests = []
    vi.stubGlobal("fetch", (path: string) => {
      requests.push(path)
      return Promise.resolve(new Response(JSON.stringify([msg(1)]), { status: 200, headers: { "Content-Type": "application/json" } }))
    })
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } })
    function Host({ enabled }: { enabled: boolean }) {
      useWarmTaskOnIntent(enabled)
      return createElement(
        "nav",
        null,
        createElement("button", { "data-open-task": "task_row01" }, createElement("span", null, "First")),
        createElement("button", { "data-open-task": "task_row02" }, "Second"),
        createElement("a", { href: "/?session=task_link01" }, "A link"),
        createElement("button", null, "Settings"),
      )
    }
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Host, { enabled: true }))))
  })

  afterEach(() => qc.clear())

  const target = (text: string) => [...host.querySelectorAll("button, a, span")].find((e) => e.textContent === text)!
  const pointer = (type: string, text: string, pointerType = "mouse") =>
    act(() => void target(text).dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { pointerType })))
  const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

  it("loads a task's messages on a press, into the cache its page reads", async () => {
    pointer("pointerdown", "Second", "touch")
    await wait(0)
    expect(requests).toEqual(["/api/tasks/task_row02/messages"])
    expect(qc.getQueryData(keys.taskMessages("task_row02"))).toEqual([msg(1)])
  })

  it("loads on a hover that rests on a task, not on one the pointer sweeps across", async () => {
    pointer("pointerover", "First")
    await wait(HOVER_INTENT_MS - 10)
    pointer("pointerover", "A link")
    await wait(HOVER_INTENT_MS - 10)
    expect(requests).toEqual([])
    // Moving inside the same link isn't a new hover.
    pointer("pointerover", "A link")
    await wait(10)
    expect(requests).toEqual(["/api/tasks/task_link01/messages"])
    pointer("pointerover", "Settings")
    await wait(HOVER_INTENT_MS)
    expect(requests).toHaveLength(1)
  })

  it("ignores a finger passing over (a scroll), and doesn't load a task again while its messages are fresh", async () => {
    pointer("pointerover", "First", "touch")
    await wait(HOVER_INTENT_MS)
    expect(requests).toEqual([])
    pointer("pointerdown", "First")
    await wait(0)
    pointer("pointerover", "Second")
    pointer("pointerdown", "First")
    await wait(HOVER_INTENT_MS)
    expect(requests).toEqual(["/api/tasks/task_row01/messages"])
  })
})
