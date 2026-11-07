// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Project, Task } from "../shared/types"
import type { PrTasksAnswer } from "../shared/prTasks"
import { PullRequestsButton } from "../web/src/components/PullRequests"
import { PrAgents } from "../web/src/components/PrAgents"
import { keys } from "../web/src/lib/queries"
import { setChatProjectFilter } from "../web/src/lib/projectBar"
import { prAgentRows, prTasksPath } from "../web/src/lib/prTasks"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const url = "https://github.com/acme/box-yard/pull/12"
function task(over: Partial<Task> = {}): Task {
  return {
    id: "task_pr001", projectId: "prj_yard01", title: "Phone sign-in", prompt: "", status: "pr_ready",
    boxId: null, sessionId: "s", branch: "phone-sign-in", prUrl: url, prState: "open",
    prMergedAt: null, prMergedBy: null, previews: [], question: null, summary: null,
    error: null, waitReason: null, waitBoxSize: null, waitFor: [], turnCount: 1, pendingCount: 0, lastArchivedAt: null, scheduleId: null,
    outcome: null, contextTokens: null, contextWindow: null, compactPending: false, compacting: false, agentCli: "claude",
    model: null, effort: null, claudeCostUsd: 0, claudeTokens: 0, routingRule: null, routingReason: null, runsOn: null, machineLabel: null,
    mergeRequest: null, createdAt: 1, updatedAt: 1, ...over,
  }
}
const projects = [{ id: "prj_yard01", name: "box-yard", repo: "acme/box-yard", runner: "box" }] as Project[]
const owner = task({ boxId: "box-pure-lobster", placement: { now: { kind: "box", boxId: "pure-lobster", size: "small" }, last: null, runner: "box", chosenBy: "project", projectRunner: "box" } })
const fixup = task({ id: "task_fix001", title: "Fix the flaky sign-in test on phones", prUrl: null, prState: null, status: "working", agentCli: "codex", runsOn: "local", branch: "fix-flaky" })
const answer: PrTasksAnswer = {
  url,
  branch: "phone-sign-in",
  tasks: [
    { taskId: "task_pr001", roles: ["opened", "merge"], model: "claude-opus-5-5", since: 1 },
    { taskId: "task_fix001", roles: ["branch"], model: "gpt-6.1-sol", since: 2 },
  ],
}

describe("a PR's details say which tasks worked on it", () => {
  let root: Root, host: HTMLElement, qc: QueryClient, reply: (r: Response) => void, fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    history.replaceState(null, "", "/")
    setChatProjectFilter(null)
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    qc.setQueryData(keys.tasks, [owner, fixup, task({ id: "task_other1", title: "Unrelated", prUrl: url + "0", branch: "x" })])
    qc.setQueryData(keys.projects, projects)
    fetchMock = vi.fn((path: string) => (path.startsWith("/api/prs/") ? new Promise<Response>((r) => (reply = r)) : new Promise(() => {})))
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
    vi.unstubAllGlobals()
  })
  const click = (el: Element, init: MouseEventInit = {}) => act(async () => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })))
  const agents = () => [...document.querySelectorAll<HTMLAnchorElement>('[data-testid="pr-agent"]')]
  const section = () => document.querySelector<HTMLElement>('[data-testid="pr-agents"]')!
  const openDetail = async () => {
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(PullRequestsButton))))
    await click(document.querySelector('[data-testid="pull-requests-button"]')!)
    await click(document.querySelector("button[aria-label='View pull request: Phone sign-in']")!)
  }
  // React Query tells its observers on a timer, so wait one inside act.
  const answerWith = (status: number, body: unknown) =>
    act(async () => {
      reply(new Response(JSON.stringify(body), { status }))
      await new Promise((r) => setTimeout(r, 20))
    })

  it("lists the linked task at once, then every task the server found, with what it did, harness, model, runner and status", async () => {
    await openDetail()
    expect(fetchMock).toHaveBeenCalledWith("/api/prs/acme/box-yard/12/tasks", expect.anything())
    expect(agents().map((a) => a.textContent)).toEqual([expect.stringContaining("Phone sign-in")])
    await answerWith(200, answer)
    const [first, second] = agents()
    expect(section().querySelector("h2")!.textContent).toBe("Worked on by 2")
    expect(first!.getAttribute("href")).toBe("/?session=task_pr001")
    expect(first!.textContent).toContain("Opened it · Asked to merge it")
    expect(first!.textContent).toContain("Claude Code · claude-opus-5-5")
    expect(first!.textContent).toContain("Upstash · small")
    expect(first!.textContent).toContain("PR ready")
    // Found by its branch: the dialog's own grouping by PR URL never had it.
    expect(second!.textContent).toContain("Fix the flaky sign-in test on phones")
    expect(second!.textContent).toContain("Worked on its branch")
    expect(second!.textContent).toContain("Codex · gpt-6.1-sol")
    expect(second!.textContent).toContain("This computer")
    expect(second!.textContent).toContain("Working")
    // The title has the row to itself; the facts are on the line below.
    const title = first!.querySelector(".font-medium")!
    expect(title.textContent).toBe("Phone sign-in")
    expect(title.nextElementSibling!.textContent).toContain("Opened it")
  })

  it("a plain click closes the dialog and opens the task; a modified click is left to the browser", async () => {
    await openDetail()
    await answerWith(200, answer)
    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true })
    act(() => void agents()[1]!.dispatchEvent(modified))
    expect(modified.defaultPrevented).toBe(false)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    await click(agents()[1]!)
    expect(location.pathname + location.search).toBe("/?session=task_fix001")
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it("keeps the linked tasks and says so when the server can't answer", async () => {
    await openDetail()
    await answerWith(500, { error: "boom" })
    expect(agents()).toHaveLength(1)
    expect(section().textContent).toContain("Couldn't check for other tasks on its branch")
  })

  it("holds a still skeleton while no task is linked yet, then says when none worked on it", async () => {
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(PrAgents, { prUrl: url + "99" }))))
    expect(section().querySelector('[role="status"]')!.getAttribute("data-loading")).toBe("waiting")
    await answerWith(200, { url: url + "99", branch: null, tasks: [] })
    expect(section().querySelector('[role="status"]')).toBeNull()
    expect(section().textContent).toContain("No task in Box Yard opened it")
  })

  it("joins the answer with the live task list", () => {
    expect(prTasksPath("https://github.com/a/b.c/pull/7#x")).toBe("/api/prs/a/b.c/7/tasks")
    expect(prTasksPath("https://github.com/a/b/issues/7")).toBeNull()
    // A deleted task is left out; a task that linked the PR after the answer is added after its rows.
    const late = task({ id: "task_late01", prUrl: url + "/", createdAt: 5 })
    const rows = prAgentRows(url, { ...answer, tasks: [...answer.tasks, { taskId: "task_gone01", roles: ["pushed"], model: null, since: 3 }] }, [owner, fixup, late])
    expect(rows.map((r) => [r.task.id, r.roles])).toEqual([["task_pr001", ["opened", "merge"]], ["task_fix001", ["branch"]], ["task_late01", ["pushed"]]])
    // Before an answer: the tasks linked to it now, oldest first, with no roles yet.
    expect(prAgentRows(url, undefined, [late, owner, fixup]).map((r) => [r.task.id, r.roles])).toEqual([["task_pr001", []], ["task_late01", []]])
  })
})
