// @vitest-environment happy-dom
// A task's transcript folds Box Yard's back-to-back bookkeeping events ("Waiting for…", "Cloned…", "Turn 1 finished")
// under the newest one, so the agent's replies aren't buried; anything notable or acted on stays its own line.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TaskThread } from "../web/src/components/TaskView.js"
import { keys } from "../web/src/lib/queries.js"
import { isHousekeeping, threadRuns } from "../web/src/lib/taskThread.js"
import type { TaskMessage } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const taskId = "task_house001"
let n = 0
const msg = (role: TaskMessage["role"], content: string, meta: Record<string, unknown> | null = null): TaskMessage => ({ id: `m${++n}`, taskId, role, content, meta, createdAt: n })
const event = (content: string, meta: Record<string, unknown> | null = null) => msg("event", content, meta)
const shape = (messages: TaskMessage[]) => threadRuns(messages).map((r) => (r.kind === "line" ? r.m.content : `${r.kind}:${r.messages.length}`))

describe("threadRuns", () => {
  it("folds back-to-back housekeeping events and leaves a lone one a plain line", () => {
    const rows = shape([
      msg("user", "Refresh it"),
      event("Waiting for A and B: this computer runs 2 tasks at a time."),
      event("Waiting for B and C: this computer runs 2 tasks at a time."),
      event("Workspace ready on this computer."),
      msg("assistant", "Looking."),
      event("Turn 1 finished · $0.01.", { timingId: "tim_1", timingMs: 900 }),
      msg("assistant", "Done."),
    ])
    expect(rows).toEqual(["Refresh it", "housekeeping:3", "Looking.", "Turn 1 finished · $0.01.", "Done."])
  })

  it("never folds what Cody acts on or what went wrong", () => {
    for (const keep of [
      event("Preview on port 4100: http://localhost:4100", { kind: "preview", url: "http://localhost:4100", port: 4100 }),
      event("Opened pull request: https://github.com/o/r/pull/1", { kind: "pr", url: "https://github.com/o/r/pull/1" }),
      event("Asked Cody: which size?", { kind: "question" }),
      event("Couldn't start the agent: no credentials"),
      event("Turn 2 failed."),
      event("Turn interrupted (box lost); retrying."),
      event("Stopped by Cody."),
    ]) expect(isHousekeeping(keep), keep.content).toBe(false)
    expect(shape([event("Cloned o/r on box-1."), event("Couldn't fetch artifact a.md: 404"), event("Workspace ready on this computer.")])).toEqual([
      "Cloned o/r on box-1.",
      "Couldn't fetch artifact a.md: 404",
      "Workspace ready on this computer.",
    ])
  })

  it("keeps back-to-back published files as one row of chips", () => {
    const file = (name: string) => event(`Published artifact: ${name}`, { kind: "artifact", url: `/artifacts/art_1/${name}`, artifactId: "art_1" })
    expect(shape([file("a.md"), file("b.md"), event("Cloned o/r."), event("Workspace ready.")])).toEqual(["published:2", "housekeeping:2"])
  })
})

let root: Root
let host: HTMLElement
let qc: QueryClient

beforeEach(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  vi.stubGlobal("requestAnimationFrame", () => 0)
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const key of [keys.projects, keys.tasks, keys.schedules, keys.artifacts, keys.taskQueue(taskId)]) qc.setQueryData(key, [])
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  qc.clear()
  host.remove()
  vi.unstubAllGlobals()
})

const render = (messages: TaskMessage[]) => {
  qc.setQueryData(keys.taskMessages(taskId), messages)
  act(() => root.render(createElement(QueryClientProvider, { client: qc },
    createElement(TaskThread, { id: taskId, handle: null, working: null, selectionSource: null, selectionAsk: null, onFollowUp: () => {} }),
  )))
}
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })))

describe("a task transcript's housekeeping", () => {
  it("shows the newest event with \"N earlier\", and unfolds the rest above it in order", () => {
    render([
      msg("user", "Refresh it"),
      event("Waiting for Captain header cleanup."),
      event("Waiting for Three-pane layout build."),
      event("Workspace ready on this computer."),
      msg("assistant", "Looking at the task."),
    ])
    const fold = host.querySelector<HTMLElement>("[data-testid=housekeeping]")!
    expect(fold.textContent).toContain("Workspace ready on this computer.")
    expect(host.textContent).not.toContain("Waiting for")
    expect(host.textContent).toContain("Looking at the task.")
    const toggle = fold.querySelector("button")!
    expect(toggle.textContent).toBe("2 earlier")
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(toggle.getAttribute("aria-label")).toBe("Show 2 earlier events")

    click(toggle)
    const lines = [...fold.children].map((c) => c.textContent?.match(/^[^.]+\./)?.[0])
    expect(lines).toEqual(["Waiting for Captain header cleanup.", "Waiting for Three-pane layout build.", "Workspace ready on this computer."])
    expect(fold.dataset.open).toBe("true")
    expect(toggle.textContent).toBe("Show less")
    expect(toggle.getAttribute("aria-expanded")).toBe("true")

    click(toggle)
    expect(host.textContent).not.toContain("Waiting for")
  })

  it("stays open while new events join it", () => {
    const first = [event("Cloned o/r on box-1."), event("Restored node_modules.")]
    render(first)
    click(host.querySelector("[data-testid=housekeeping] button")!)
    render([...first, event("Workspace ready on box-1.")])
    const fold = host.querySelector<HTMLElement>("[data-testid=housekeeping]")!
    expect(fold.dataset.open).toBe("true")
    expect(fold.children).toHaveLength(3)
  })
})
