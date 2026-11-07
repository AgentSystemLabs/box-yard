// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Activity, act, createElement, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { StickyScroll, createJumpStore, scrollIntoList, type JumpStore, type StickyScrollHandle } from "../web/src/components/StickyScroll.js"
import { firstPaintRows, holdTailGrowth, resetFirstPaintRows, useTail } from "../web/src/lib/tail.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// happy-dom has no layout, so this models one: rows stack by their data-h height inside a 400px
// viewport. Like a browser, writing scrollTop clamps it and fires one scroll event later (flush()),
// with whatever position it has by then.

const VIEW = 400
// The list's visible height: a growing composer below it takes some away.
let view = VIEW

class FakeResizeObserver {
  static all = new Set<FakeResizeObserver>()
  constructor(private cb: () => void) {
    FakeResizeObserver.all.add(this)
  }
  targets = new Set<Element>()
  observe(target: Element) { this.targets.add(target) }
  disconnect() {
    this.targets.clear()
    FakeResizeObserver.all.delete(this)
  }
}

class FakeMutationObserver {
  static all = new Set<FakeMutationObserver>()
  observe = vi.fn()
  constructor(readonly cb: MutationCallback) { FakeMutationObserver.all.add(this) }
  disconnect = vi.fn(() => { FakeMutationObserver.all.delete(this) })
  trigger() { this.cb([], this as unknown as MutationObserver) }
}

class FakeIntersectionObserver {
  static all = new Set<FakeIntersectionObserver>()
  constructor(readonly cb: IntersectionObserverCallback) { FakeIntersectionObserver.all.add(this) }
  observe() {}
  disconnect() { FakeIntersectionObserver.all.delete(this) }
}

let root: Root
let host: HTMLElement
let scroller: HTMLElement
let content: HTMLElement
let top = 0
let dispatched = 0

const rows = () => [...content.children] as HTMLElement[]
const height = (el: Element) => Number((el as HTMLElement).dataset.h ?? 0)
const contentHeight = () => rows().reduce((sum, r) => sum + height(r), 0)
const max = () => Math.max(0, contentHeight() - view)
const atBottom = () => top === max()
const jumpButton = () => [...host.querySelectorAll("button")].find((b) => /latest|new message/.test(b.textContent ?? ""))

function rowTop(el: Element) {
  let y = 0
  for (const r of rows()) {
    if (r === el) break
    y += height(r)
  }
  return y - top
}

function installLayout() {
  scroller = host.querySelector<HTMLElement>(".overflow-y-auto")!
  content = scroller.firstElementChild as HTMLElement
  Object.defineProperties(scroller, {
    clientHeight: { get: () => view },
    scrollHeight: { get: () => Math.max(view, contentHeight()) },
    scrollTop: {
      get: () => top,
      set: (v: number) => {
        top = Math.min(max(), Math.max(0, v))
      },
    },
  })
  scroller.scrollTo = ((opts: ScrollToOptions) => {
    scroller.scrollTop = opts.top ?? 0
  }) as typeof scroller.scrollTo
}

// The browser's frame: scroll events first, then resize observers.
const flush = () =>
  act(() => {
    if (top !== dispatched) {
      dispatched = top
      scroller.dispatchEvent(new Event("scroll"))
    }
  })
const observe = () => act(() => FakeResizeObserver.all.forEach((ro) => (ro as unknown as { cb: () => void }).cb()))
const frame = () => {
  flush()
  observe()
  flush()
}

// The user moves the list (wheel, drag, keys): the position changes, the event comes later.
const userScroll = (dy: number) => {
  scroller.scrollTop = top + dy
}

const handle = createRef<StickyScrollHandle>()
// Where "Jump to latest" goes when the caller shows it (the Coordinator chat's line over its box).
let jumpStore: JumpStore | undefined

function Thread({ heights }: { heights: number[] }) {
  return createElement(
    StickyScroll,
    { handle, count: heights.length, jumpStore, children: heights.map((h, i) => createElement("div", { key: i, "data-h": h }, `row ${i}`)) },
  )
}

let heights: number[]
const render = () => act(() => root.render(createElement(Thread, { heights: [...heights] })))

// One streamed chunk: the last row grows, then the frame runs.
function streamDelta(px = 30) {
  heights[heights.length - 1]! += px
  render()
  frame()
}

// requestAnimationFrame callbacks wait here until the test runs the next frame. The clock (performance.now) moves
// only with frames, 16ms each, so a glide's progress is the number of frames run.
let frames = new Map<number, FrameRequestCallback>()
let frameId = 0
let clock = 0
const FRAME_MS = 16
const nextFrame = () => act(() => {
  clock += FRAME_MS
  const callbacks = [...frames.values()]
  frames.clear()
  callbacks.forEach((cb) => cb(clock))
})
// Run frames for as long as a glide takes (and a little more), with the scroll events they cause.
const glideFrames = (ms = 400) => {
  for (let t = 0; t < ms; t += FRAME_MS) {
    nextFrame()
    flush()
  }
}
let viewport: EventTarget

beforeEach(() => {
  jumpStore = undefined
  frames = new Map()
  frameId = 0
  clock = 1000
  vi.spyOn(performance, "now").mockImplementation(() => clock)
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.set(++frameId, cb)
    return frameId
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
  vi.stubGlobal("MutationObserver", FakeMutationObserver)
  viewport = new EventTarget()
  vi.stubGlobal("visualViewport", viewport)
  vi.stubGlobal("ResizeObserver", FakeResizeObserver)
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const y = this === scroller ? 0 : rowTop(this)
    const h = this === scroller ? view : height(this)
    return { top: y, bottom: y + h, left: 0, right: 0, width: 0, height: h, x: 0, y, toJSON() {} } as DOMRect
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  top = 0
  dispatched = 0
  view = VIEW
  heights = Array.from({ length: 20 }, () => 100)
  render()
  installLayout()
  // Mounting scrolled before the fake layout existed; start pinned at the bottom.
  scroller.scrollTop = max()
  frame()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  FakeResizeObserver.all.clear()
  FakeMutationObserver.all.clear()
  FakeIntersectionObserver.all.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("StickyScroll", () => {
  it("follows streamed text while pinned to the bottom", () => {
    for (let i = 0; i < 5; i++) streamDelta()
    expect(atBottom()).toBe(true)
    expect(jumpButton()).toBeUndefined()
  })

  it.each([0.5, 1, 10, 40, 100])("immediately unpins on a %ipx upward wheel intent before its scroll event", (px) => {
    const before = top
    act(() => void scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -px, bubbles: true })))
    expect(jumpButton()).toBeDefined()
    // Growth can beat the wheel's compositor scroll by several frames.
    for (let i = 0; i < 3; i++) { streamDelta(); nextFrame() }
    expect(top).toBe(before)
    userScroll(-px)
    flush()
    for (let i = 0; i < 10; i++) streamDelta()
    expect(top).toBe(before - px)
    expect(jumpButton()).toBeDefined()
  })

  it("lets slow incremental upward scrolling escape streamed growth", () => {
    const before = top
    for (let i = 0; i < 20; i++) {
      act(() => void scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -2, bubbles: true })))
      streamDelta(30) // Streaming used to restore the bottom between these small inputs.
      userScroll(-2)
      flush()
      nextFrame()
      streamDelta(30)
      expect(top).toBe(before - (i + 1) * 2)
      expect(jumpButton()).toBeDefined()
    }
  })

  it.each([0.5, 1, 10, 41, 100])("an actual %ipx upward scroll without an input event unpins", (px) => {
    userScroll(-px)
    flush()
    const reading = top
    for (let i = 0; i < 10; i++) streamDelta()
    expect(top).toBe(reading)
    expect(jumpButton()).toBeDefined()
  })

  it("an observer cannot overwrite an upward scrollbar movement before its scroll event", () => {
    act(() => void scroller.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })))
    const before = top
    userScroll(-1)
    heights[heights.length - 1]! += 50
    render()
    observe() // Resize arrives before scroll; there was no wheel/touch/key intent.
    expect(top).toBe(before - 1)
    flush()
    streamDelta()
    expect(top).toBe(before - 1)
    expect(jumpButton()).toBeDefined()
  })

  it("scrollIntoList lets go of the bottom first, so growth before its scroll lands can't pull the view back down", () => {
    // A card far up, revealed by a search pick.
    const target = rows()[5]!
    // A smooth scroll that hasn't moved the list yet.
    const scrolled = vi.fn()
    scroller.scrollTo = scrolled
    act(() => scrollIntoList(target, { block: "nearest", behavior: "smooth" }))
    expect(scrolled).toHaveBeenCalledWith({ top: 500, behavior: "smooth" })
    const before = top
    // The card opens (or a reply streams) before the smooth scroll's first frame: the view waits for it.
    streamDelta()
    expect(top).toBe(before)
    expect(jumpButton()).toBeDefined()
    // The scroll lands, and stays.
    scroller.scrollTop = 500
    frame()
    streamDelta()
    expect(top).toBe(500)
  })

  it("scrollIntoList holds what's in view already as it grows, instead of following the bottom; the bottom re-pins", () => {
    // Already in full view at the bottom: nothing scrolls, and the card opening below its head doesn't push it up.
    const target = rows().at(-1)!
    const scrolled = vi.spyOn(scroller, "scrollTo")
    act(() => scrollIntoList(target, { block: "nearest" }))
    expect(scrolled).not.toHaveBeenCalled()
    const before = top
    streamDelta()
    expect(top).toBe(before)
    expect(jumpButton()).toBeDefined()
    // Scrolling back to the very bottom follows again.
    userScroll(max() - top)
    frame()
    streamDelta()
    expect(atBottom()).toBe(true)
  })

  it("recognizes compositor movement already applied before the passive wheel listener", () => {
    userScroll(-100)
    act(() => void scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })))
    nextFrame()
    flush()
    const reading = top
    streamDelta()
    expect(top).toBe(reading)
    expect(jumpButton()).toBeDefined()
  })

  it("holds indefinitely when the compositor scroll arrives after several layout frames", () => {
    act(() => void scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })))
    streamDelta(80)
    const before = top
    for (let i = 0; i < 5; i++) { nextFrame(); streamDelta() }
    expect(top).toBe(before)
    userScroll(-100)
    flush()
    nextFrame()
    streamDelta()
    expect(top).toBe(before - 100)
    expect(jumpButton()).toBeDefined()
  })

  it("PageUp, ↑ and Home unpin before the scroll they cause arrives", () => {
    for (const key of ["PageUp", "ArrowUp", "Home", " "]) {
      act(() => void scroller.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })))
      // Focus stays on <body> after clicking text in the list.
      act(() => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: key === " ", bubbles: true })))
      const before = top
      heights[heights.length - 1]! += 30
      render()
      observe()
      expect(top, key).toBe(before)
      expect(jumpButton(), key).toBeDefined()
      userScroll(-1)
      flush()
      nextFrame()
      expect(jumpButton(), key).toBeDefined()
      // Back to the bottom re-pins for the next key.
      scroller.scrollTop = max()
      frame()
      expect(jumpButton(), key).toBeUndefined()
    }
  })

  it("ignores scroll keys typed in the composer or after clicking elsewhere", () => {
    const textarea = document.createElement("textarea")
    document.body.append(textarea)
    act(() => void textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true })))
    act(() => void document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })))
    act(() => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })))
    streamDelta()
    expect(atBottom()).toBe(true)
  })

  it("a finger dragging down unpins on touch", () => {
    const touch = (type: string, y: number) => {
      const e = new Event(type, { bubbles: true })
      Object.defineProperty(e, "touches", { value: [{ clientX: 100, clientY: y }] })
      act(() => void scroller.dispatchEvent(e))
    }
    touch("touchstart", 200)
    touch("touchmove", 201)
    expect(jumpButton()).toBeDefined()
    const before = top
    heights[heights.length - 1]! += 30
    render()
    observe()
    expect(top).toBe(before)
    userScroll(-1)
    flush()
    nextFrame()
    streamDelta()
    expect(top).toBe(before - 1)
    expect(jumpButton()).toBeDefined()
  })

  it("our own scrollTop writes never count as the user scrolling", () => {
    // Every follow write fires a scroll event; none of them unpin.
    for (let i = 0; i < 5; i++) streamDelta()
    expect(jumpButton()).toBeUndefined()

  })

  it("a queued own-write scroll event cannot re-pin after an upward input", () => {
    heights[heights.length - 1]! += 30
    render()
    observe() // Follow write, its event still queued.
    const before = top
    act(() => void scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -0.5, bubbles: true })))
    act(() => void scroller.dispatchEvent(new Event("scroll")))
    dispatched = top
    nextFrame()
    streamDelta()
    expect(top).toBe(before)
    expect(jumpButton()).toBeDefined()
  })

  it("stays pinned when the list gets shorter and the browser pulls scrollTop down", () => {
    heights.pop()
    render()
    scroller.scrollTop = top // the browser clamps to the new bottom
    frame()
    expect(jumpButton()).toBeUndefined()
    streamDelta()
    expect(atBottom()).toBe(true)
  })

  it("re-pins only when the user returns to the very bottom", () => {
    userScroll(-200)
    frame()
    expect(jumpButton()).toBeDefined()
    for (const gap of [40, 10, 1]) {
      userScroll(max() - top - gap)
      frame()
      expect(jumpButton(), `${gap}px short is still away`).toBeDefined()
    }
    const before = top
    streamDelta()
    expect(top).toBe(before)
    userScroll(max() - top)
    frame()
    expect(jumpButton()).toBeUndefined()
    streamDelta()
    expect(atBottom()).toBe(true)
  })

  // The compositor scrolls against the layout it has, a frame or so behind the main thread: while a reply streams, a
  // wheel or flick down stops on the bottom from before the last chunk, short of the bottom by that chunk (#266).
  describe("reaching the bottom while a reply streams", () => {
    // A chunk lays out, then the user's scroll lands where the compositor still thinks the bottom is.
    const growThenScrollTo = (land: (oldBottom: number) => number, px = 50, laterMs = FRAME_MS) => {
      const oldBottom = max()
      heights[heights.length - 1]! += px
      render()
      observe()
      clock += laterMs
      top = land(oldBottom)
      flush()
    }
    const away = () => {
      userScroll(-300)
      frame()
      expect(jumpButton()).toBeDefined()
    }

    it("re-pins when a scroll lands on the bottom from a frame ago", () => {
      away()
      growThenScrollTo((oldBottom) => oldBottom)
      expect(jumpButton()).toBeUndefined()
      expect(atBottom()).toBe(true)
      streamDelta()
      expect(atBottom()).toBe(true)
    })

    it("a reader wheeling down through a reply streaming every frame reaches the bottom and stays there", () => {
      userScroll(-600)
      frame()
      const path = [top]
      for (let i = 0; i < 12; i++) {
        growThenScrollTo((oldBottom) => Math.max(top, Math.min(oldBottom, top + 120)), 30)
        path.push(top)
      }
      expect(jumpButton()).toBeUndefined()
      expect(atBottom()).toBe(true)
      // Never pulled back up on the way down.
      expect(path.every((y, i) => i === 0 || y >= path[i - 1]!)).toBe(true)
    })

    it("stays away when the scroll stops short of the old bottom too", () => {
      away()
      growThenScrollTo((oldBottom) => oldBottom - 10)
      expect(jumpButton()).toBeDefined()
      const reading = top
      streamDelta()
      expect(top).toBe(reading)
    })

    it("stays away when the old bottom is from long ago", () => {
      away()
      growThenScrollTo((oldBottom) => oldBottom, 50, 300)
      expect(jumpButton()).toBeDefined()
    })

    it("stays away when the old bottom is more than a screen behind", () => {
      away()
      growThenScrollTo((oldBottom) => oldBottom, VIEW + 50)
      expect(jumpButton()).toBeDefined()
    })
  })

  it("stays pinned when a taller list clamps to a fractional bottom (DPR 2)", () => {
    // The composer shrinks after a send: the list gets taller and the browser clamps half a pixel off the bottom.
    view += 36
    top = max() - 0.5
    flush()
    observe()
    expect(jumpButton()).toBeUndefined()
    streamDelta()
    expect(atBottom()).toBe(true)
  })

  it("stays pinned when a rubber band settles back from past the end (Safari)", () => {
    top = max() + 40
    flush()
    top = max()
    flush()
    expect(jumpButton()).toBeUndefined()
    streamDelta()
    expect(atBottom()).toBe(true)
  })

  it("Jump to latest re-pins and follows", () => {
    userScroll(-300)
    frame()
    streamDelta()
    act(() => jumpButton()!.click())
    glideFrames()
    expect(atBottom()).toBe(true)
    streamDelta()
    expect(atBottom()).toBe(true)
  })

  it("Jump to latest gets no room under the last row, so showing and hiding it never moves the list", () => {
    userScroll(-300)
    frame()
    const jump = jumpButton()!
    expect(jump.parentElement!.matches("[data-overlay]")).toBe(true)
    // The room shows only for an overlay child that isn't the jump (see the overlay tests).
    expect(host.querySelector("[data-testid=overlay-room]")!.classList).toContain("hidden")
  })

  it("with a jumpStore, says it's away and how much is new instead of floating its button; the store's jump re-pins", () => {
    const store = (jumpStore = createJumpStore())
    render()
    expect(store.get()).toEqual({ away: false, unread: 0 })
    userScroll(-300)
    frame()
    expect(jumpButton()).toBeUndefined()
    expect(store.get().away).toBe(true)
    heights.push(100)
    render()
    frame()
    expect(store.get()).toEqual({ away: true, unread: 1 })
    act(() => store.jump())
    glideFrames()
    expect(atBottom()).toBe(true)
    expect(store.get()).toEqual({ away: false, unread: 0 })
  })

  it("starts pinned when loading history first supplies layout", () => {
    act(() => root.render(null))
    render()
    installLayout()
    top = dispatched = 0
    observe()
    flush()
    expect(atBottom()).toBe(true)
    expect(jumpButton()).toBeUndefined()
  })

  it("a new list resets a pending gesture and starts pinned", () => {
    userScroll(-200)
    flush()
    act(() => void scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })))
    act(() => root.render(createElement(StickyScroll, {
      count: heights.length, resetKey: "new-task", handle,
      children: heights.map((h, i) => createElement("div", { key: i, "data-h": h }, `row ${i}`)),
    })))
    installLayout()
    observe()
    nextFrame()
    expect(atBottom()).toBe(true)
    expect(jumpButton()).toBeUndefined()
  })

  it("observes the actual scroll viewport and its growing content, including nested mutations", () => {
    expect([...FakeResizeObserver.all][0]!.targets).toEqual(new Set([content, scroller]))
    const mo = [...FakeMutationObserver.all][0]!
    expect(mo.observe).toHaveBeenCalledWith(content, expect.objectContaining({ subtree: true, characterData: true, childList: true }))
  })

  it("follows a nested streamed text update without a new item or parent render", () => {
    const last = rows().at(-1)!
    const count = rows().length
    for (let i = 0; i < 5; i++) {
      last.textContent += " next streamed token"
      last.dataset.h = String(height(last) + 60)
      observe()
      flush()
      expect(atBottom()).toBe(true)
    }
    expect(rows()).toHaveLength(count)
  })

  it("coalesces nested DOM mutations and follows layout not reflected by a resize notification", () => {
    const mo = [...FakeMutationObserver.all][0]!
    const last = rows().at(-1)!
    last.dataset.h = String(height(last) + 120)
    act(() => { mo.trigger(); mo.trigger(); mo.trigger() })
    expect(frames.size).toBe(1)
    expect(atBottom()).toBe(false)
    nextFrame()
    flush()
    expect(atBottom()).toBe(true)
    expect(frames.size).toBe(0)
  })

  it("follows expanding/loading nested content while pinned and holds while away", () => {
    const grow = () => {
      const last = rows().at(-1)!
      const details = document.createElement("details")
      details.open = true
      details.textContent = "Expanded output"
      const image = document.createElement("img")
      last.append(details, image)
      last.dataset.h = String(height(last) + 180)
      image.dispatchEvent(new Event("load"))
      observe()
      flush()
    }
    grow()
    expect(atBottom()).toBe(true)
    userScroll(-200)
    flush()
    const reading = top
    grow()
    expect(top).toBe(reading)
    expect(jumpButton()).toBeDefined()
  })

  it("does not re-pin when shrinking content clamps an unpinned list to the bottom", () => {
    userScroll(-300)
    flush()
    const reading = top
    heights.splice(-3)
    render()
    scroller.scrollTop = reading
    frame()
    expect(jumpButton()).toBeDefined()
    const clamped = top
    streamDelta(150)
    expect(top).toBe(clamped)
  })

  it("follows viewport resize only while pinned", () => {
    view -= 100
    act(() => window.dispatchEvent(new Event("resize")))
    flush()
    expect(atBottom()).toBe(true)
    userScroll(-300)
    flush()
    const reading = top
    view -= 60
    act(() => window.dispatchEvent(new Event("resize")))
    act(() => viewport.dispatchEvent(new Event("resize")))
    observe()
    expect(top).toBe(reading)
    expect(jumpButton()).toBeDefined()
  })

  it("disconnects observers, viewport listeners, store and queued frames on unmount", () => {
    const store = (jumpStore = createJumpStore())
    render()
    const ro = [...FakeResizeObserver.all][0]!
    const mo = [...FakeMutationObserver.all][0]!
    act(() => { mo.trigger(); handle.current!.scrollToEnd() })
    expect(frames.size).toBeGreaterThan(0)
    act(() => root.render(null))
    expect(ro.targets.size).toBe(0)
    expect(mo.disconnect).toHaveBeenCalledOnce()
    expect(FakeMutationObserver.all.size).toBe(0)
    expect(frames.size).toBe(0)
    expect(store.run).toBeNull()
    const after = top
    act(() => { viewport.dispatchEvent(new Event("resize")); window.dispatchEvent(new Event("resize")) })
    nextFrame()
    expect(top).toBe(after)
  })

  it("holds the row being read still when content above it grows", () => {
    userScroll(-600)
    frame()
    const reading = rows().find((r) => rowTop(r) + height(r) > 0)!
    const offset = rowTop(reading)
    // A row above the view expands (a browser without scroll anchoring wouldn't compensate).
    heights[2]! += 120
    render()
    frame()
    expect(rowTop(reading)).toBe(offset)
    expect(jumpButton()).toBeDefined()
  })

  it("a wheel inside a nested scroller that can still scroll up leaves the list pinned", () => {
    const inner = rows()[rows().length - 1]!
    Object.defineProperties(inner, {
      scrollTop: { value: 50 },
      scrollHeight: { value: 300 },
      clientHeight: { value: 100 },
    })
    inner.style.overflowY = "auto"
    act(() => void inner.dispatchEvent(new WheelEvent("wheel", { deltaY: -20, bubbles: true })))
    streamDelta()
    expect(atBottom()).toBe(true)
  })

  describe("after a send (scrollToEnd)", () => {
    // Reading history far up, unpinned.
    const readHistory = () => {
      act(() => void scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })))
      userScroll(-1200)
      frame()
      expect(jumpButton()).toBeDefined()
    }
    // The composer sends: the sent message renders a moment later (React Query notifies on a timer).
    const send = () => act(() => handle.current!.scrollToEnd())
    // "Jump to latest" glides there instead.
    const jumpToLatest = () => act(() => jumpButton()!.click())
    const messageRenders = (h = 80) => {
      heights.push(h)
      render()
      frame()
    }

    it("a send jumps straight to the bottom, even from far up, with no glide", () => {
      const scrollTo = vi.fn()
      scroller.scrollTo = scrollTo
      readHistory()
      send()
      expect(atBottom()).toBe(true)
      expect(jumpButton()).toBeUndefined()
      expect(scrollTo).not.toHaveBeenCalled()
      expect(frames.size).toBe(0)
    })

    // WebKit moves scrollTop up by itself when the list grows and loses a row above the end in the same layout: a reply
    // arrives and the next-step chips leave the reply before it. That read as the reader scrolling up, and let go of
    // the bottom with the new message cut off under "Jump to latest".
    const replyArrivesInWebKit = (h = 316, chips = 36) => {
      heights[heights.length - 1]! -= chips
      heights.push(h)
      render()
      top -= chips
      flush()
      observe()
      flush()
    }

    it.each(["at the bottom", "far up"])("from %s, a send stays on the true bottom through late layout, WebKit's own moves and the composer shrinking", (from) => {
      if (from === "far up") readHistory()
      // A click in the list (a next-step chip that sends) is over before the reply comes.
      act(() => void rows().at(-1)!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })))
      act(() => void document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })))
      send()
      messageRenders()
      // The sent message lays out taller a moment later (markdown, an attachment).
      heights[heights.length - 1]! += 120
      render()
      frame()
      expect(atBottom()).toBe(true)
      replyArrivesInWebKit()
      expect(atBottom()).toBe(true)
      expect(jumpButton()).toBeUndefined()
      // The composer, emptied by the send, gives the list back its height: the browser clamps scrollTop to the end.
      view += 48
      scroller.scrollTop = top
      frame()
      expect(atBottom()).toBe(true)
      expect(jumpButton()).toBeUndefined()
      // And stays attached as the reply streams in and the next one comes.
      for (let i = 0; i < 5; i++) streamDelta()
      replyArrivesInWebKit(200)
      expect(atBottom()).toBe(true)
      expect(rowTop(rows().at(-1)!) + height(rows().at(-1)!)).toBe(view)
      expect(jumpButton()).toBeUndefined()
    })

    it("WebKit's move mid-glide doesn't stop Jump to latest", () => {
      readHistory()
      jumpToLatest()
      nextFrame()
      flush()
      replyArrivesInWebKit()
      glideFrames()
      expect(atBottom()).toBe(true)
      expect(jumpButton()).toBeUndefined()
    })

    it("a scrollbar drag up as the list grows still lets go", () => {
      send()
      messageRenders()
      act(() => void scroller.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })))
      heights.push(200)
      render()
      userScroll(-36)
      flush()
      observe()
      const reading = top
      for (let i = 0; i < 5; i++) streamDelta()
      expect(top).toBe(reading)
      expect(jumpButton()).toBeDefined()
    })

    it("an upward scroll with no input and nothing laid out still lets go", () => {
      send()
      messageRenders()
      userScroll(-36)
      flush()
      const reading = top
      for (let i = 0; i < 5; i++) streamDelta()
      expect(top).toBe(reading)
      expect(jumpButton()).toBeDefined()
    })

    it("Jump to latest glides: from a screen above the bottom, easing down to it, and jumps instead under prefers-reduced-motion", () => {
      readHistory()
      jumpToLatest()
      flush()
      // Far up, it starts a screen short of the bottom rather than scrolling through the whole history.
      expect(max() - top).toBe(VIEW)
      const path = [top]
      for (let i = 0; i < 25; i++) {
        nextFrame()
        flush()
        path.push(top)
      }
      expect(path.every((y, i) => i === 0 || y >= path[i - 1]!)).toBe(true)
      expect(path.filter((y) => y > path[0]! && y < max()).length).toBeGreaterThan(5)
      expect(atBottom()).toBe(true)

      vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(prefers-reduced-motion: reduce)", media: q }))
      readHistory()
      jumpToLatest()
      flush()
      expect(atBottom()).toBe(true)
    })

    it("never hands the glide to a native smooth scroll, which aims at a bottom that streaming has moved", () => {
      const scrollTo = vi.fn()
      scroller.scrollTo = scrollTo
      readHistory()
      jumpToLatest()
      glideFrames()
      expect(scrollTo).not.toHaveBeenCalled()
      expect(atBottom()).toBe(true)
    })

    it("lands on the bottom while a reply streams in every frame of the glide", () => {
      readHistory()
      send()
      for (let t = 0; t < 400; t += FRAME_MS) {
        nextFrame()
        streamDelta(25)
      }
      expect(atBottom()).toBe(true)
      expect(jumpButton()).toBeUndefined()
      for (let i = 0; i < 5; i++) streamDelta()
      expect(atBottom()).toBe(true)
    })

    it("lands on the sent message when it renders after the glide", () => {
      readHistory()
      send()
      glideFrames()
      messageRenders()
      expect(atBottom()).toBe(true)
      expect(rowTop(rows().at(-1)!) + height(rows().at(-1)!)).toBe(VIEW)
    })

    it("lands on the sent message when it renders before the first frame", () => {
      readHistory()
      send()
      messageRenders()
      glideFrames()
      expect(atBottom()).toBe(true)
    })

    it("lands on the true bottom when the sent message renders mid-glide", () => {
      readHistory()
      send()
      nextFrame()
      nextFrame()
      messageRenders(120)
      glideFrames()
      expect(atBottom()).toBe(true)
      expect(rowTop(rows().at(-1)!) + height(rows().at(-1)!)).toBe(view)
      expect(jumpButton()).toBeUndefined()
    })

    it("lands on the true bottom when the composer grows after the send", () => {
      readHistory()
      send()
      nextFrame()
      // An attachment row or the auto-sized textarea takes 60px off the list's height mid-glide.
      view -= 60
      frame()
      glideFrames()
      expect(atBottom()).toBe(true)
      expect(jumpButton()).toBeUndefined()
    })

    it("stays pinned while the reply streams in", () => {
      readHistory()
      send()
      glideFrames()
      messageRenders()
      messageRenders(40)
      for (let i = 0; i < 5; i++) streamDelta()
      expect(atBottom()).toBe(true)
    })

    it("a streaming reply doesn't pull the view back down after scrolling up again", () => {
      readHistory()
      send()
      glideFrames()
      messageRenders()
      messageRenders(40)
      act(() => void scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })))
      userScroll(-300)
      frame()
      const reading = top
      for (let i = 0; i < 10; i++) streamDelta()
      expect(top).toBe(reading)
      expect(jumpButton()).toBeDefined()
    })

    it("a tiny upward scroll mid-glide cancels follow without a preceding input event", () => {
      readHistory()
      jumpToLatest()
      nextFrame()
      flush()
      const before = top
      userScroll(-0.5)
      flush()
      for (let i = 0; i < 25; i++) { nextFrame(); streamDelta() }
      expect(top).toBe(before - 0.5)
      expect(jumpButton()).toBeDefined()
    })

    it("a queued native scroll event cannot re-pin after upward intent", () => {
      readHistory()
      jumpToLatest()
      nextFrame()
      flush()
      // A native scroll reaches the bottom before its scroll event is delivered.
      scroller.scrollTop = max()
      const before = top
      act(() => void scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true })))
      flush() // A positive movement from before the upward intent, not the user returning.
      streamDelta()
      expect(top).toBe(before)
      expect(jumpButton()).toBeDefined()
      userScroll(-1)
      frame()
      streamDelta()
      expect(top).toBe(before - 1)
    })

    it("upward intent stops the glide where it is", () => {
      readHistory()
      jumpToLatest()
      nextFrame()
      flush()
      const before = top
      expect(atBottom()).toBe(false)
      act(() => void scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true })))
      for (let i = 0; i < 25; i++) { nextFrame(); streamDelta() }
      expect(top).toBe(before)
      expect(jumpButton()).toBeDefined()
    })

    it("scrolling up before the first frame cancels the glide", () => {
      readHistory()
      jumpToLatest()
      act(() => void scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })))
      userScroll(-100)
      frame()
      const reading = top
      glideFrames()
      messageRenders()
      expect(top).toBe(reading)
    })

    it("never pulls back up a reader who scrolls down faster than the glide", () => {
      readHistory()
      jumpToLatest()
      nextFrame()
      flush()
      userScroll(max() - top - 5)
      const path: number[] = []
      for (let i = 0; i < 25; i++) {
        nextFrame()
        flush()
        path.push(top)
      }
      expect(path.every((y, i) => y >= (path[i - 1] ?? max() - 5))).toBe(true)
      expect(atBottom()).toBe(true)
    })

    it("stays pinned when trimmed rows clamp the list upward right after a send", () => {
      send()
      nextFrame()
      nextFrame()
      flush()
      // Rows trimmed above the view: the browser clamps to the new bottom.
      heights.splice(0, 2)
      render()
      scroller.scrollTop = top
      flush()
      glideFrames()
      expect(atBottom()).toBe(true)
      expect(jumpButton()).toBeUndefined()
    })

    it("a scrollbar drag up mid-glide still unpins", () => {
      readHistory()
      jumpToLatest()
      nextFrame()
      nextFrame()
      flush()
      act(() => void scroller.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })))
      userScroll(-1)
      // The glide's next frame reads the drag before it writes.
      nextFrame()
      const reading = top
      flush()
      glideFrames()
      messageRenders()
      expect(top).toBe(reading)
      expect(jumpButton()).toBeDefined()
    })

    it("follows the visual viewport (an iOS keyboard closing) back to the bottom", () => {
      send()
      glideFrames()
      // Keyboard opens: the shorter viewport leaves the old scrollTop short of the bottom.
      view -= 200
      act(() => void viewport.dispatchEvent(new Event("resize")))
      flush()
      expect(atBottom()).toBe(true)
      // Keyboard closes: the browser clamps scrollTop as the viewport grows again.
      view += 200
      scroller.scrollTop = top
      act(() => void viewport.dispatchEvent(new Event("resize")))
      flush()
      expect(atBottom()).toBe(true)
    })
  })

  // A phone's home-screen app stays open for days: a thread that kept every message that arrived ended up
  // rendering hundreds of them, and every layout (keyboard, rotation, a dialog) froze the app for seconds.
  describe("with useTail, as the chats use it", () => {
    let items: { id: string }[]

    function TailThread({ items }: { items: { id: string }[] }) {
      const tail = useTail(items, "chat")
      return createElement(StickyScroll, {
        handle,
        count: items.length,
        hidden: tail.hidden,
        onLoadEarlier: tail.loadEarlier,
        onTrim: tail.trim,
        children: tail.visible.map((m) => createElement("div", { key: m.id, "data-h": 100 }, m.id)),
      })
    }
    const renderTail = () => act(() => root.render(createElement(TailThread, { items: [...items] })))
    // The rendered messages (the list also holds the "load earlier" sentinel).
    const messages = () => rows().filter((r) => r.dataset.h)
    const arrive = () => {
      items.push({ id: `m${items.length}` })
      renderTail()
      frame()
    }

    beforeEach(() => {
      act(() => root.render(null))
      items = Array.from({ length: 200 }, (_, i) => ({ id: `m${i}` }))
      renderTail()
      installLayout()
      scroller.scrollTop = max()
      frame()
    })

    it("starts with the newest 60", () => {
      expect(messages()).toHaveLength(60)
      expect(messages().at(-1)!.textContent).toBe("m199")
    })

    it("stays at most twice that while new messages arrive at the bottom", () => {
      for (let i = 0; i < 300; i++) arrive()
      expect(messages().length).toBeLessThanOrEqual(120)
      expect(messages().at(-1)!.textContent).toBe("m499")
      expect(atBottom()).toBe(true)
    })

    it("keeps the visible row in place when Show earlier prepends history", () => {
      userScroll(-5500)
      flush()
      const row = messages().find((r) => rowTop(r) >= 0)!
      const offset = rowTop(row)
      const text = row.textContent
      const earlier = [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Show "))!
      act(() => earlier.click())
      frame()
      expect(messages().length).toBeGreaterThan(60)
      const same = messages().find((r) => r.textContent === text)!
      expect(rowTop(same)).toBe(offset)
      expect(jumpButton()).toBeDefined()
    })

    it("a scroll that stops where the bottom was before Show earlier added rows above doesn't re-pin", () => {
      act(() => root.render(null))
      items = Array.from({ length: 62 }, (_, i) => ({ id: `m${i}` }))
      renderTail()
      installLayout()
      scroller.scrollTop = max()
      frame()
      const oldBottom = max()
      userScroll(-300)
      flush()
      act(() => [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Show "))!.click())
      frame()
      expect(max()).toBe(oldBottom + 200)
      clock += FRAME_MS
      top = oldBottom
      flush()
      expect(jumpButton()).toBeDefined()
      expect(top).toBe(oldBottom)
    })

    it("keeps every row while scrolled up reading, so nothing moves", () => {
      userScroll(-1000)
      flush()
      const reading = messages().find((r) => rowTop(r) >= 0)!.textContent
      for (let i = 0; i < 100; i++) arrive()
      expect(messages()).toHaveLength(160)
      expect(messages().find((r) => rowTop(r) >= 0)!.textContent).toBe(reading)
    })
  })

  // A Captain's chat opens on its newest few rows (useTail's `first`) and fills the view before the first paint.
  describe("opening on a few rows (onFill), as a Captain's chat does", () => {
    // Laid out from the first commit, as a chat that mounts with its messages already in memory is: every list here is
    // measured the way installLayout measures `scroller`.
    const own = (el: Element) => {
      if (!el.classList.contains("overflow-y-auto")) return false
      scroller = el as HTMLElement
      content = el.firstElementChild as HTMLElement
      return true
    }
    const layout: [object, string, PropertyDescriptor][] = [
      [HTMLElement.prototype, "clientHeight", { get(this: Element) { return own(this) ? view : 0 } }],
      [HTMLElement.prototype, "scrollHeight", { get(this: Element) { return own(this) ? Math.max(view, contentHeight()) : 0 } }],
      [HTMLElement.prototype, "scrollTop", { get(this: Element) { return own(this) ? top : 0 }, set(this: Element, v: number) { if (own(this)) top = Math.min(max(), Math.max(0, v)) } }],
      [HTMLElement.prototype, "scrollTo", { value(this: Element, opts: ScrollToOptions) { (this as HTMLElement).scrollTop = opts.top ?? 0 } }],
    ]
    let renders = 0

    // `chat` given: one of several Captains, whose first paint starts from the rows it took to fill the view (firstPaintRows).
    function CaptainThread({ items, h, grow, chat }: { items: { id: string }[]; h: number; grow?: number; chat?: string }) {
      renders++
      const tail = useTail(items, chat ?? "captain", { first: chat ? firstPaintRows(chat, 4) : 4, grow })
      return createElement(StickyScroll, {
        handle,
        count: items.length,
        resetKey: chat ?? "captain",
        hidden: tail.hidden,
        onLoadEarlier: tail.loadEarlier,
        onTrim: tail.trim,
        onFill: tail.fill,
        onFilled: tail.filled,
        growing: tail.growing,
        children: tail.visible.map((m) => createElement("div", { key: m.id, "data-h": h }, m.id)),
      })
    }
    const open = (items: { id: string }[], h: number, grow?: number) => act(() => root.render(createElement(CaptainThread, { items, h, grow })))
    const switchTo = (chat: string, h: number) => {
      renders = 0
      act(() => root.render(createElement(CaptainThread, { items: history(200), h, chat })))
    }
    const messages = () => rows().filter((r) => r.dataset.h)
    const history = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}` }))
    // useTail renders the rest of the newest 60 a frame and a task after the first paint.
    const afterPaint = async () => {
      nextFrame()
      await act(() => new Promise((r) => setTimeout(r, 0)))
      frame()
    }

    beforeEach(() => {
      act(() => root.render(null))
      for (const [proto, key, d] of layout) Object.defineProperty(proto, key, { ...d, configurable: true })
      top = 0
      renders = 0
      resetFirstPaintRows()
    })
    afterEach(() => {
      for (const [proto, key] of layout) Reflect.deleteProperty(proto, key)
    })

    it("renders more short rows before the first paint, until they reach past the view, pinned to the bottom", async () => {
      open(history(200), 30)
      // No frame has run: this is what the first paint shows. 4 rows are 120px of a 400px view; 16 are past it.
      expect(messages()).toHaveLength(16)
      expect(contentHeight()).toBeGreaterThan(view)
      expect(messages().at(-1)!.textContent).toBe("m199")
      expect(atBottom()).toBe(true)
      await afterPaint()
      expect(messages()).toHaveLength(60)
      expect(atBottom()).toBe(true)
    })

    it("holds the rest back while a press is about to open another chat, and grows once the press is over", async () => {
      // A Captain's row pressed (lib/captainPrerender.ts): each step would start that Captain's hidden pre-render over.
      holdTailGrowth(true)
      try {
        open(history(200), 30)
        expect(messages()).toHaveLength(16)
        await afterPaint()
        await afterPaint()
        expect(messages()).toHaveLength(16)
      } finally {
        act(() => holdTailGrowth(false))
      }
      expect(messages()).toHaveLength(60)
      frame()
      expect(atBottom()).toBe(true)
    })

    it("hidden (a chat kept for going back), drops back to the first paint's rows, and grows again once shown", async () => {
      const kept = (mode: "visible" | "hidden") => act(() => root.render(createElement(Activity, { mode }, createElement(CaptainThread, { items: history(200), h: 30 }))))
      kept("visible")
      await afterPaint()
      expect(messages()).toHaveLength(60)
      // Shown again whole, all 60 rows lay out and start before the paint, which made going back slower than a first open.
      kept("hidden")
      expect(messages()).toHaveLength(4)
      kept("visible")
      expect(messages()).toHaveLength(16)
      expect(messages().at(-1)!.textContent).toBe("m199")
      expect(atBottom()).toBe(true)
      await afterPaint()
      expect(messages()).toHaveLength(60)
      expect(atBottom()).toBe(true)
    })

    it("paints just the first few when they already fill the view", () => {
      open(history(200), 200)
      expect(messages()).toHaveLength(4)
      expect(renders).toBe(1)
      expect(atBottom()).toBe(true)
    })

    it("fills when the messages land, for a chat that opened still loading", () => {
      open([], 30)
      expect(messages()).toHaveLength(0)
      open(history(200), 30)
      expect(messages()).toHaveLength(16)
      expect(atBottom()).toBe(true)
    })

    it("doesn't load earlier ahead of the reader while the rest of the newest 60 come in a few a frame", async () => {
      open(history(200), 100, 8)
      // 4 rows only just fill the 400px view, so it fills to 8. The sentinel is just above them: watching it now loaded
      // 50 more than the newest 60 in one go, right after the first paint.
      expect(messages()).toHaveLength(8)
      expect(FakeIntersectionObserver.all.size).toBe(0)
      const grown = [messages().length]
      while (messages().length < 60 && grown.length < 20) {
        await afterPaint()
        grown.push(messages().length)
        expect(atBottom()).toBe(true)
      }
      expect(grown).toEqual([8, 16, 24, 32, 40, 48, 56, 60])
      // All there: it watches the sentinel again, and loads earlier when the reader nears it.
      expect(FakeIntersectionObserver.all.size).toBe(1)
      act(() => [...FakeIntersectionObserver.all][0]!.cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
      frame()
      expect(messages()).toHaveLength(110)
    })

    it("opens the next chat on about as many rows as the last one took to fill the view, in one render", () => {
      switchTo("a", 30)
      expect(messages()).toHaveLength(16)
      expect(renders).toBe(3)
      // The 400px view showed 401px of a's 480: 14 of its 16 rows, and one more. Without filling up in a second render
      // and layout, which held a switch's first paint back ~10 ms with the CPU slowed 4×.
      switchTo("b", 30)
      expect(messages()).toHaveLength(15)
      expect(renders).toBe(1)
      expect(contentHeight()).toBeGreaterThan(view)
      expect(messages().at(-1)!.textContent).toBe("m199")
      expect(atBottom()).toBe(true)
    })

    it("goes back to a chat on the rows it took itself, whatever the chat before it took", () => {
      switchTo("a", 30)
      // 15 of b's tall rows reach far past the view: it keeps the 5 the view showed, and one more.
      switchTo("b", 100)
      expect(messages()).toHaveLength(15)
      expect(renders).toBe(1)
      switchTo("a", 30)
      expect(messages()).toHaveLength(15)
      expect(renders).toBe(1)
      switchTo("b", 100)
      expect(messages()).toHaveLength(6)
      expect(renders).toBe(1)
      expect(atBottom()).toBe(true)
    })

    it("doesn't open every chat after one of one-liners on dozens of rows", () => {
      switchTo("a", 8)
      expect(messages()).toHaveLength(60)
      // Another chat's count is a guess: no more than 4 times the 4 rows.
      switchTo("b", 100)
      expect(messages()).toHaveLength(16)
      switchTo("a", 8)
      expect(messages()).toHaveLength(52)
      expect(renders).toBe(1)
    })

    it("learns nothing from a view it couldn't fill", () => {
      // 60 rows of 5px are 300px: the newest 60 all render, short of the top.
      switchTo("a", 5)
      expect(messages()).toHaveLength(60)
      switchTo("b", 200)
      expect(messages()).toHaveLength(4)
      expect(renders).toBe(1)
    })

    it("stops at the newest 60 however short they are", () => {
      open(history(200), 5)
      expect(messages()).toHaveLength(60)
      expect(host.textContent).toContain("Show ")
    })
  })
})

describe("overlay", () => {
  // happy-dom has no stacking, so this checks the structure that keeps the overlay on top: the list is its own
  // stacking context (relative z-0), so a card's sticky z-20 header inside it can't paint over the overlay (z-10)
  // that comes after it.
  function renderWithOverlay(pill: boolean) {
    act(() =>
      root.render(
        createElement(StickyScroll, {
          count: 1,
          overlay: pill ? createElement("button", { "data-testid": "pill" }, "↓ 3 new") : null,
          children: createElement("div", { "data-h": 100 }, createElement("header", { className: "sticky top-0 z-20" }, "Coordinator")),
        }),
      ),
    )
  }

  it("floats above the list's sticky headers", () => {
    renderWithOverlay(true)
    const pill = host.querySelector("[data-testid=pill]")!
    const header = host.querySelector("header")!
    const list = host.querySelector<HTMLElement>(".overflow-y-auto")!
    const overlay = pill.closest<HTMLElement>("[data-overlay]")!
    expect(list.contains(header)).toBe(true)
    expect(list.classList).toContain("relative")
    expect(list.classList).toContain("z-0")
    expect(overlay.classList).toContain("absolute")
    expect(overlay.classList).toContain("z-10")
    expect(list.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Only the pill takes clicks; the strip around it lets them through to the list.
    expect(overlay.classList).toContain("pointer-events-none")
  })

  it("leaves room under the last row for it, outside the measured rows", () => {
    renderWithOverlay(true)
    const room = host.querySelector<HTMLElement>("[data-testid=overlay-room]")!
    expect(room.parentElement).toBe(host.querySelector(".overflow-y-auto"))
    expect(room.classList).not.toContain("hidden")
  })

  it("leaves no room while the overlay renders nothing, and makes it when something shows up later", () => {
    function Later({ show }: { show: boolean }) {
      return show ? createElement("button", { "data-testid": "pill" }, "↓ 3 new") : null
    }
    const draw = (show: boolean) =>
      act(() => root.render(createElement(StickyScroll, { count: 1, overlay: createElement(Later, { show }), children: createElement("div", { "data-h": 100 }) })))
    draw(false)
    const room = () => host.querySelector<HTMLElement>("[data-testid=overlay-room]")!
    expect(room().classList).toContain("hidden")
    draw(true)
    // The overlay's own children changed, not the list's: its observer sees it.
    const mo = [...FakeMutationObserver.all].find((o) => o.observe.mock.calls.some(([el]) => (el as Element).matches("[data-overlay]")))!
    act(() => mo.trigger())
    expect(room().classList).not.toContain("hidden")
  })

  // A :has() anchored on the list (the room's old group-has rule) matched any element added anywhere in it, so every
  // new message or streamed paragraph restyled every rendered row: ~50ms a message in a long Coordinator chat.
  it("puts no :has() rule on the list or around it", () => {
    renderWithOverlay(true)
    const own = [host.firstElementChild!, ...host.querySelectorAll(".overflow-y-auto, .overflow-y-auto > *, [data-overlay]")]
    for (const el of own) expect(el.className).not.toMatch(/has-/)
  })
})
