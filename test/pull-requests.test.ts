// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Project, Task } from "../shared/types"
import { PullRequestsButton } from "../web/src/components/PullRequests"
import { ConfirmHost } from "../web/src/components/ConfirmDialog"
import { keys } from "../web/src/lib/queries"
import { setChatProjectFilter } from "../web/src/lib/projectBar"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const url = "https://github.com/acme/box-yard/pull/12"
function task(over: Partial<Task> = {}): Task {
  return {
    id: "task_pr001", projectId: "prj_yard01", title: "Phone sign-in", prompt: "", status: "pr_ready",
    boxId: null, sessionId: "s", branch: "boxyard/phone", prUrl: url, prState: "open",
    prMergedAt: null, prMergedBy: null, previews: [], question: null, summary: "The phone preview is ready.",
    error: null, waitReason: null, turnCount: 1, pendingCount: 0, lastArchivedAt: null, scheduleId: null,
    outcome: null, contextTokens: null, contextWindow: null, compactPending: false, compacting: false,
    model: null, effort: null, claudeCostUsd: 0, claudeTokens: 0, routingRule: null, routingReason: null,
    mergeRequest: null, createdAt: 1, updatedAt: 1, ...over,
  }
}
const projects = [{ id: "prj_yard01", name: "box-yard", repo: "acme/box-yard" }, { id: "prj_site01", name: "portfolio", repo: "acme/portfolio" }] as Project[]

describe("pull request journey", () => {
  let root: Root, host: HTMLElement, qc: QueryClient, fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    history.replaceState(null, "", "/")
    setChatProjectFilter(null)
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    qc.setQueryData(keys.tasks, [task(), task({ id: "task_pr002", title: "Finished attachment previews", prUrl: url + "0", prState: "merged", status: "done" })])
    qc.setQueryData(keys.projects, projects)
    fetchMock = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal("fetch", fetchMock)
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    qc.clear()
    host.remove()
    document.body.innerHTML = ""
    setChatProjectFilter(null)
    vi.unstubAllGlobals()
  })
  const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })) })
  const byLabel = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label='${label}']`)!
  const byText = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!
  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="pr-row"]')]
  const render = () => act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(PullRequestsButton), createElement(ConfirmHost))))
  const entry = () => document.querySelector<HTMLButtonElement>('[data-testid="pull-requests-button"]')!
  const open = async () => { render(); await click(entry()) }
  const choose = (title = "Phone sign-in") => click(byLabel(`View pull request: ${title}`))

  it("opens active work first, keeps completed PRs in History, and restores entry focus on close", async () => {
    await open()
    expect(rows()).toHaveLength(1)
    expect(document.body.textContent).toContain("All projects")
    expect(document.body.textContent).not.toContain("Finished attachment previews")
    await click(byLabel("History"))
    expect(rows()).toHaveLength(1)
    expect(rows()[0]!.textContent).toContain("Merged #120")
    expect(rows()[0]!.textContent).toContain("Finished attachment previews")
    await click(byLabel("Close"))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(entry())
  })

  it("respects the selected project and gives an empty scoped view", async () => {
    setChatProjectFilter("prj_site01")
    await open()
    expect(rows()).toHaveLength(0)
    expect(document.body.textContent).toContain("portfolio")
    expect(document.body.textContent).toContain("No open work here")
    expect(document.body.textContent).not.toContain("Phone sign-in")
  })

  it("shows linked task summaries and preview/GitHub links, then restores list position and focus", async () => {
    qc.setQueryData(keys.tasks, [task({ previews: [{ port: 4260, label: "Phone preview", url: "http://localhost:4260" }] }), task({ id: "task_pr002", title: "Follow-up task", summary: null })])
    await open()
    expect(rows()).toHaveLength(1)
    expect(rows()[0]!.textContent).toContain("2 tasks")
    const list = rows()[0]!.parentElement!.parentElement!
    list.scrollTop = 200
    await choose()
    expect(document.activeElement?.textContent).toBe("Task summaries")
    expect(document.body.textContent).toContain("The phone preview is ready.")
    expect(document.body.textContent).toContain("No task summary yet")
    expect(document.querySelector('a[href="http://localhost:4260"]')?.textContent).toContain("Phone preview")
    expect(document.querySelector(`a[href="${url}"]`)?.getAttribute("target")).toBe("_blank")
    expect(document.body.textContent).toContain("Last reported state")
    // The detail is a level inside the dialog: Back takes the ×'s place at the top, never both.
    const header = document.querySelector('[role="dialog"] header')!
    expect([...header.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Back to pull requests"])
    expect(byText("Back to pull requests")).toBeUndefined()
    await click(byLabel("Back to pull requests"))
    expect(list.scrollTop).toBe(200)
    expect(document.activeElement).toBe(byLabel("View pull request: Phone sign-in"))
    expect([...header.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Close"])
    expect(fetchMock.mock.calls.every(([, init]) => !(init as RequestInit | undefined)?.method || (init as RequestInit).method === "GET")).toBe(true)
  })

  it("Esc steps back from a PR to the list, and only the next Esc closes the dialog", async () => {
    await open()
    await choose()
    const esc = () => act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))
    await esc()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(rows()).toHaveLength(1)
    expect(document.activeElement).toBe(byLabel("View pull request: Phone sign-in"))
    await esc()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(entry())
  })

  it("returns directly to the task's conversation; the chat has no task cards to show", async () => {
    await open()
    await choose()
    expect(byText("Show task card")).toBeUndefined()
    await click(byLabel("Open task conversation: Phone sign-in"))
    expect(location.pathname + location.search).toBe("/?session=task_pr001")
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it("the entry counts the chat's open pull requests: the picked project's, or all of them", async () => {
    qc.setQueryData(keys.tasks, [task(), task({ id: "task_pr002", prUrl: url + "0", prState: "merged", status: "done" }), task({ id: "task_pr003", projectId: "prj_site01", prUrl: "https://github.com/acme/portfolio/pull/3" })])
    render()
    expect(entry().getAttribute("aria-label")).toBe("Pull requests, 2 open")
    expect(entry().textContent).toBe("2")
    act(() => setChatProjectFilter("prj_site01"))
    expect(entry().getAttribute("aria-label")).toBe("Pull requests, 1 open")
    qc.setQueryData(keys.tasks, [task({ prState: "merged" })])
    act(() => setChatProjectFilter(null))
    expect(entry().getAttribute("aria-label")).toBe("Pull requests")
    expect(entry().textContent).toBe("")
  })

  it.each(["draft", null, "conflict"] as const)("never offers merge for %s state", async (state) => {
    qc.setQueryData(keys.tasks, state === "conflict" ? [task(), task({ id: "task_pr002", prState: "merged" })] : [task({ prState: state })])
    await open()
    await choose()
    expect(document.querySelector("[data-merge-state]")).toBeNull()
    expect(document.body.textContent).toContain(state === "draft" ? "Draft #12" : "Status unconfirmed")
  })

  it("uses the standard merge confirmation without sending on entry or cancellation", async () => {
    await open()
    await choose()
    const before = fetchMock.mock.calls.length
    await click(document.querySelector('[data-merge-state="ready"]')!)
    expect(document.body.textContent).toContain("Merge PR #12?")
    expect(fetchMock).toHaveBeenCalledTimes(before)
    await click(byText("Cancel"))
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(before)
  })

  it("shows a pending merge on any linked task rather than offering a second request", async () => {
    qc.setQueryData(keys.tasks, [task({ updatedAt: 3 }), task({ id: "task_pr002", title: "Earlier task", mergeRequest: { prNumber: 12, prUrl: url, requestedAt: 1, deliveredAt: null } })])
    await open()
    await choose()
    expect(document.querySelector('[data-merge-state="ready"]')).toBeNull()
    expect(document.querySelector('[data-merge-state="queued"]')?.textContent).toContain("Merge queued")
  })

  it("holds rows still and marks merged work while updates stream in", async () => {
    await open()
    await act(async () => {
      qc.setQueryData(keys.tasks, [task({ prState: "merged" }), task({ id: "task_pr003", title: "New PR", prUrl: url + "3", updatedAt: 4 })])
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(rows()).toHaveLength(1)
    expect(rows()[0]!.className).toContain("border-dashed")
    expect(rows()[0]!.textContent).toContain("Merged #12")
    expect(document.body.textContent).toContain("1 new")
    expect(document.body.textContent).not.toContain("New PR")
  })
})
