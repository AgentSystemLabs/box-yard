// @vitest-environment happy-dom
// Per-keystroke work in the Composer: one commit per key, and the box's height is only measured from scratch when
// the text may need fewer lines (scripts/perf/composer-typing.mjs measures the latency in a real browser).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, createRef, Profiler } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Composer } from "../web/src/components/Composer.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const commits = vi.fn()
const onSubmit = vi.fn()

// happy-dom has no layout: the box lays its text out in 40-character lines of 20px, with 12px of padding.
const LINE = 20
const PAD = 12
const lines = (text: string) => text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 40)), 0)
const content = (el: HTMLTextAreaElement) => PAD + LINE * lines(el.value)
const client = (el: HTMLTextAreaElement) => (el.style.height && el.style.height !== "auto" ? parseFloat(el.style.height) : content(el))

function mount(runTargets = false) {
  const panel = createRef<HTMLElement>()
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(
          Profiler,
          { id: "composer", onRender: commits },
          createElement("section", { ref: panel }, createElement(Composer, { onSubmit, placeholder: "Ask", panelRef: panel, runTargets })),
        ),
      ),
    ),
  )
}

beforeEach(() => {
  commits.mockClear()
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q }))
  vi.spyOn(HTMLTextAreaElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLTextAreaElement) {
    return client(this)
  })
  vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLTextAreaElement) {
    return Math.max(content(this), client(this))
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const textarea = () => document.querySelector("textarea")!
const height = () => textarea().style.height
const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!

/** Puts `text` in the box as a keystroke would: the input event, then the select event its key-up brings. */
async function key(text: string) {
  await act(async () => {
    setValue.call(textarea(), text)
    textarea().setSelectionRange(text.length, text.length)
    textarea().dispatchEvent(new Event("input", { bubbles: true }))
  })
  await act(async () => {
    textarea().dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }))
    document.dispatchEvent(new Event("selectionchange"))
    // React Query and passive effects notify on timers: a sync act would pass even when a second commit is coming.
    await new Promise((r) => setTimeout(r, 20))
  })
}

/** Every style write to the box and its row, from here on. */
function styleWrites() {
  const writes: string[] = []
  const observer = new MutationObserver((list) => list.forEach((m) => writes.push(`${(m.target as HTMLElement).tagName}: ${(m.target as HTMLElement).getAttribute("style")}`)))
  observer.observe(textarea(), { attributes: true, attributeFilter: ["style"] })
  observer.observe(textarea().parentElement!, { attributes: true, attributeFilter: ["style"] })
  return { writes, flush: () => [...writes, ...observer.takeRecords().map((m) => (m.target as HTMLElement).tagName)] }
}

describe("Composer keystrokes", () => {
  for (const runTargets of [false, true]) {
    it(`commit once per key${runTargets ? " with the @ and ! lists" : ""}: the select event after it doesn't render the box again`, async () => {
      mount(runTargets)
      textarea().focus()
      await key("h")
      commits.mockClear()
      for (const text of ["he", "hel", "hell", "hello"]) await key(text)
      expect(commits).toHaveBeenCalledTimes(4)
    })
  }

  it("typing at the end writes no height while the text fits, and grows the box when a line is added", async () => {
    mount()
    expect(height()).toBe(`${PAD + LINE}px`)
    textarea().focus()
    const watch = styleWrites()
    for (const text of ["d", "de", "dep", "deploy it"]) await key(text)
    expect(watch.flush()).toEqual([])
    await key("deploy it\nthen")
    expect(height()).toBe(`${PAD + 2 * LINE}px`)
    // Long enough to wrap onto a third line.
    await key(`deploy it\nthen ${"x".repeat(40)}`)
    expect(height()).toBe(`${PAD + 3 * LINE}px`)
  })

  it("a deletion that takes a line away measures again and shrinks the box", async () => {
    mount()
    textarea().focus()
    await key("one\ntwo\nthree")
    expect(height()).toBe(`${PAD + 3 * LINE}px`)
    await key("one\ntwo")
    expect(height()).toBe(`${PAD + 2 * LINE}px`)
    // An edit in the middle (not at the end) is measured too.
    await key("o\ntwo")
    expect(height()).toBe(`${PAD + 2 * LINE}px`)
    await key("otwo")
    expect(height()).toBe(`${PAD + LINE}px`)
  })

  it("Backspace in a one-line box writes nothing: it's already as short as it gets", async () => {
    mount()
    textarea().focus()
    await key("hello")
    const watch = styleWrites()
    for (const text of ["hell", "hel", "he", ""]) await key(text)
    expect(watch.flush()).toEqual([])
    expect(height()).toBe(`${PAD + LINE}px`)
  })

  it("past the cap the box scrolls, and more typing leaves its height alone", async () => {
    mount()
    textarea().focus()
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")
    await key(long)
    const capped = height()
    expect(parseFloat(capped)).toBeLessThan(PAD + 40 * LINE)
    expect(textarea().style.overflowY).toBe("auto")
    expect(document.querySelector('[aria-label="Expand editor"]')).not.toBeNull()
    const watch = styleWrites()
    await key(`${long}\nmore`)
    await act(async () => void (textarea().scrollTop = 0))
    await key(`${long}\nmore and more`)
    expect(watch.flush()).toEqual([])
    // Typing at the end keeps the end in view.
    expect(textarea().scrollTop).toBe(textarea().scrollHeight)
    // Emptied (sent), it goes back to one line.
    await key("")
    expect(height()).toBe(`${PAD + LINE}px`)
    expect(textarea().style.overflowY).toBe("hidden")
  })
})
