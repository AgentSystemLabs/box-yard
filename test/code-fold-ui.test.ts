// @vitest-environment happy-dom
// Long fenced code blocks in chat fold to their first lines behind a "Show all N lines" row (CodeBlock in ui.tsx),
// so one pasted log or file doesn't take a phone's whole screen. Copy still copies all of it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { CODE_FOLD_LINES, Markdown, codeLineCount } from "../web/src/components/ui.js"
import { keys } from "../web/src/lib/queries.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let qc: QueryClient
let written: string[]

beforeEach(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  written = []
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async (t: string) => void written.push(t) } })
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const k of [keys.tasks, keys.projects, keys.schedules, keys.artifacts, keys.boxes]) qc.setQueryData(k, [])
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

const render = (node: ReactNode) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, node)))
const md = (text: string) => render(createElement(Markdown, null, text))
const code = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n")
const fence = (body: string) => "```ts\n" + body + "\n```"
const block = () => host.querySelector<HTMLElement>(".code-block")!
const toggle = () => host.querySelector<HTMLButtonElement>(".code-fold")
const press = async (b: HTMLButtonElement) => {
  await act(async () => {
    b.click()
  })
}

describe("codeLineCount", () => {
  const pre = (text: string) => ({ type: "element", children: [{ type: "element", children: [{ type: "text", value: text }] }] })

  it("counts the code's lines, not markdown's newline after the last", () => {
    expect(codeLineCount(pre("one\n"))).toBe(1)
    expect(codeLineCount(pre("one\ntwo\nthree\n"))).toBe(3)
  })

  it("counts blank lines, and a trailing blank line of the code's own", () => {
    expect(codeLineCount(pre("a\n\nb\n"))).toBe(3)
    expect(codeLineCount(pre("a\n\n"))).toBe(2)
  })

  it("reads text split across nodes, and a missing node as one empty line", () => {
    expect(codeLineCount({ type: "element", children: [{ type: "text", value: "a\nb" }, { type: "element", children: [{ type: "text", value: "\nc\n" }] }] })).toBe(3)
    expect(codeLineCount(undefined)).toBe(1)
  })
})

describe("long code blocks fold", () => {
  it(`leaves a block of ${CODE_FOLD_LINES} lines whole`, () => {
    md(fence(code(CODE_FOLD_LINES)))
    expect(block().dataset.folded).toBeUndefined()
    expect(toggle()).toBeNull()
  })

  it("folds a longer one, saying how many lines it has", () => {
    md(fence(code(72)))
    expect(block().dataset.folded).toBe("true")
    const t = toggle()!
    expect(t.type).toBe("button")
    expect(t.textContent).toBe("Show all 72 lines")
    expect(t.getAttribute("aria-expanded")).toBe("false")
    // Under the code, in the block, not inside the scrolling <pre>.
    expect(t.parentElement).toBe(block())
    expect(host.querySelector("pre")!.contains(t)).toBe(false)
    // A finger-sized row on touch screens.
    expect(t.className).toContain("pointer-coarse:min-h-11")
  })

  it("opens and folds again, bringing the block's top back into view", async () => {
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {})
    md(fence(code(30)))
    await press(toggle()!)
    expect(block().dataset.folded).toBeUndefined()
    expect(toggle()!.textContent).toBe("Show less")
    expect(toggle()!.getAttribute("aria-expanded")).toBe("true")
    // Opening leaves the reader where they are.
    expect(scrolled).not.toHaveBeenCalled()
    await press(toggle()!)
    expect(block().dataset.folded).toBe("true")
    expect(toggle()!.textContent).toBe("Show all 30 lines")
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(scrolled.mock.contexts[0]).toBe(block())
    expect(scrolled).toHaveBeenCalledWith({ block: "nearest" })
  })

  it("copies the whole block while it's folded", async () => {
    md(fence(code(40)))
    expect(block().dataset.folded).toBe("true")
    await press(host.querySelector<HTMLButtonElement>("button[aria-label='Copy code']")!)
    expect(written).toEqual([code(40)])
  })

  it("folds each long block on its own", async () => {
    md(`${fence(code(25))}\n\nand\n\n${fence(code(3))}\n\nand\n\n${fence(code(50))}`)
    const blocks = [...host.querySelectorAll<HTMLElement>(".code-block")]
    expect(blocks.map((b) => b.dataset.folded ?? null)).toEqual(["true", null, "true"])
    await press(blocks[2]!.querySelector<HTMLButtonElement>(".code-fold")!)
    expect(blocks.map((b) => b.dataset.folded ?? null)).toEqual(["true", null, null])
  })
})
