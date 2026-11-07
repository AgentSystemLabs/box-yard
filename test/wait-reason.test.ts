// @vitest-environment happy-dom
// A queued task's wait reason links the tasks holding it back (Task.waitFor): a real link in the task banner, and a
// button (no nested anchor) inside a task card or Boxes queue row, which are links themselves.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { PlacementCardChip } from "../web/src/components/PlacementChip.js"
import { WaitReason, waitReasonParts } from "../web/src/components/WaitReason.js"
import type { Task } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REASON = "Waiting for Merge PR #78: keep-the-castle allows 1 of its tasks at a time on this computer"
const BY = [{ taskId: "task_2a3b4c5d6e7f", title: "Merge PR #78" }]

const task = (over: Partial<Task> = {}) =>
  ({
    id: "task_6e7f8a9b0c1d",
    projectId: "prj_boxyard",
    title: "Perf lane 1",
    prompt: "",
    status: "queued",
    boxId: null,
    previews: [],
    question: null,
    summary: null,
    error: null,
    waitReason: REASON,
    waitBoxSize: null,
    waitFor: BY,
    turnCount: 0,
    pendingCount: 0,
    prUrl: null,
    prState: null,
    outcome: null,
    mergeRequest: null,
    claudeCostUsd: 0,
    claudeTokens: 0,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as unknown as Task

let root: Root
let host: HTMLElement
beforeEach(() => {
  history.replaceState(null, "", "/")
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
const render = (node: ReactNode) => act(() => root.render(createElement(QueryClientProvider, { client: new QueryClient() }, node)))

describe("waitReasonParts", () => {
  it("cuts the reason around each named task, in order", () => {
    expect(waitReasonParts(REASON, BY)).toEqual(["Waiting for ", BY[0], ": keep-the-castle allows 1 of its tasks at a time on this computer"])
    const two = [
      { taskId: "task_a", title: "A" },
      { taskId: "task_b", title: "B" },
    ]
    expect(waitReasonParts("waiting for A (p) and B (q) here", two)).toEqual(["waiting for ", two[0], " (p) and ", two[1], " (q) here"])
    // A title the text doesn't have (renamed since) is left out: the text stays whole.
    expect(waitReasonParts("waiting", [{ taskId: "task_c", title: "C" }])).toEqual(["waiting"])
  })
})

describe("WaitReason", () => {
  it("links the blocking task in the task banner", () => {
    render(createElement(WaitReason, { task: task() }))
    const link = host.querySelector<HTMLAnchorElement>("a[data-testid=wait-for-link]")!
    expect(link.getAttribute("href")).toBe("/?session=task_2a3b4c5d6e7f")
    expect(link.textContent).toBe("Merge PR #78")
    expect(host.textContent).toBe(REASON)
  })

  it("marks where a waiting task will go with a muted icon in the card's footer, pinned when it overrides its project", () => {
    render(createElement(PlacementCardChip, { task: task({ placement: { now: null, last: null, runner: "local", chosenBy: "task", projectRunner: "box" } }) }))
    const chip = host.querySelector<HTMLElement>("[data-testid=card-placement]")!
    // Only the icon (and the pin): the words are in the label and tooltip.
    expect(chip.textContent).toBe("")
    expect(chip.querySelectorAll("svg")).toHaveLength(2)
    expect(chip.getAttribute("aria-label")).toBe("Runs on: → This computer, pinned")
    expect(chip.dataset.state).toBe("next")
    expect(chip.title).toContain("This task's Runs on: this computer")
    render(createElement(PlacementCardChip, { task: task({ status: "working", boxId: "pure-lobster", placement: { now: { kind: "box", boxId: "pure-lobster", provider: "upstash", size: "small" }, last: null, runner: "box", chosenBy: "project", projectRunner: "box" } }) }))
    expect(host.querySelector<HTMLElement>("[data-testid=card-placement]")!.getAttribute("aria-label")).toBe("Runs on: Upstash · pure-lobster · small")
    expect(host.querySelector<HTMLElement>("[data-testid=card-placement]")!.title).toContain("Upstash · pure-lobster · small")
  })

  it("shows the plain reason when it names no task", () => {
    render(createElement(WaitReason, { task: task({ waitReason: "Waiting for disk cleanup on box-1", waitFor: [] }) }))
    expect(host.querySelector("[data-testid=wait-for-link]")).toBeNull()
    expect(host.textContent).toBe("Waiting for disk cleanup on box-1")
  })
})
