// @vitest-environment happy-dom
// While a turn runs, the thread's live line wears a small spinner left of "Turn running", so it's plain the session
// works. It's decoration (the words are its label), spins only where motion is welcome, and sits out of the flow in
// the icons' column so the words never move.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TaskThread, workingLabel } from "../web/src/components/TaskView.js"
import { keys } from "../web/src/lib/queries.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const taskId = "task_spin0001"
let root: Root
let host: HTMLElement
let qc: QueryClient

beforeEach(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  vi.stubGlobal("requestAnimationFrame", () => 0)
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const k of [keys.projects, keys.tasks, keys.schedules, keys.artifacts, keys.taskQueue(taskId), keys.taskMessages(taskId)]) qc.setQueryData(k, [])
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  qc.clear()
  vi.unstubAllGlobals()
})

const render = (working: string | null, workingSince: number | null = Date.now() - 60_000) =>
  act(() =>
    root.render(
      createElement(QueryClientProvider, { client: qc },
        createElement(TaskThread, { id: taskId, handle: null, working, workingSince, selectionSource: null, selectionAsk: null, onFollowUp: () => {} }),
      ),
    ),
  )
const spinner = () => host.querySelector<HTMLElement>("[data-testid=working-spinner]")

describe("the live line's spinner", () => {
  it("sits immediately left of \"Turn running\"", () => {
    render(workingLabel("working"))
    const spin = spinner()!
    expect(spin).not.toBeNull()
    const label = spin.nextElementSibling as HTMLElement
    expect(label.textContent).toBe("Turn running")
    expect(host.querySelector("[data-testid=working-line]")!.contains(spin)).toBe(true)
  })

  it("shows while the workspace is prepared too", () => {
    render(workingLabel("starting"))
    expect(spinner()!.nextElementSibling!.textContent).toBe("Preparing the workspace")
  })

  it("is hidden from screen readers and adds no words, so the line still reads as its label", () => {
    render(workingLabel("working"), null)
    const spin = spinner()!
    expect(spin.getAttribute("aria-hidden")).toBe("true")
    expect(spin.textContent).toBe("")
    expect(host.querySelector("[data-testid=working-line]")!.textContent).toBe("Turn running")
  })

  it("spins only without prefers-reduced-motion, and stands still otherwise", () => {
    render(workingLabel("working"))
    const glyph = spinner()!.querySelector("svg")!
    const classes = glyph.getAttribute("class")!.split(/\s+/)
    expect(classes).toContain("motion-safe:animate-spin")
    expect(classes).not.toContain("animate-spin")
  })

  it("hangs out of the flow in the icons' column, so the words keep their place", () => {
    render(workingLabel("working"))
    const spin = spinner()!
    const classes = spin.className.split(/\s+/)
    // Positioned against the words' own span, in the 24px gutter (pl-6) the events leave for icons.
    expect(classes).toEqual(expect.arrayContaining(["absolute", "-left-6", "w-4", "inset-y-0"]))
    expect(spin.parentElement!.className.split(/\s+/)).toContain("relative")
    expect(host.querySelector("[data-testid=working-line]")!.className.split(/\s+/)).toContain("pl-6")
  })

  it("is gone once the turn ends", () => {
    render(workingLabel("working"))
    expect(spinner()).not.toBeNull()
    render(null, null)
    expect(spinner()).toBeNull()
    expect(host.querySelector("[data-testid=working-line]")).toBeNull()
  })
})
