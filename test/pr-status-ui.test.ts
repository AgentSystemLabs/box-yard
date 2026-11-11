// @vitest-environment happy-dom
// The task header's PR chip says the one thing to know about the PR, and opens a sheet with checks, merge, review,
// files, the tasks that worked on it, Open on GitHub and Merge PR.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { PrStatusChip, type PrStatusTask } from "../web/src/components/PrStatus.js"
import { ConfirmHost } from "../web/src/components/ConfirmDialog.js"
import { checksLine, mergeLine, prSignal, reviewLine } from "../web/src/lib/prDetails.js"
import type { PrDetails, PrDetailsAnswer } from "../shared/prDetails.js"
import type { PrTasksAnswer } from "../shared/prTasks.js"
import type { Task } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const prUrl = "https://github.com/acme/site/pull/76"

const details = (over: Partial<PrDetails> = {}): PrDetails => ({
  url: prUrl,
  number: 76,
  title: "Retry webhooks with backoff",
  state: "open",
  mergedAt: null,
  mergedBy: null,
  base: "main",
  head: "webhook-retry",
  headSha: "abc",
  checks: { state: "passing", passed: 12, failed: 0, pending: 0, skipped: 0, list: [] },
  merge: "clean",
  review: "none",
  files: { changed: 8, additions: 120, deletions: 34 },
  ...over,
})

const failing = details({
  merge: "conflicts",
  review: "required",
  checks: {
    state: "failing",
    passed: 9,
    failed: 2,
    pending: 1,
    skipped: 0,
    list: [
      { name: "test", state: "failed", url: "https://ci.example/test" },
      { name: "lint", state: "failed", url: null },
      { name: "e2e", state: "pending", url: "https://ci.example/e2e" },
      { name: "build", state: "passed", url: "https://ci.example/build" },
    ],
  },
})

describe("the PR's signal and lines", () => {
  it("puts the most urgent thing first: conflicts, failing checks, changes requested, running, behind, blocked, passing", () => {
    expect(prSignal(failing)).toMatchObject({ kind: "conflicts", tone: "bad", label: "Conflicts with main" })
    expect(prSignal({ ...failing, merge: "clean" })).toMatchObject({ kind: "failing", label: "2 checks failing" })
    expect(prSignal(details({ review: "changes_requested", checks: { ...failing.checks, state: "pending", failed: 0 } }))!.kind).toBe("changes")
    expect(prSignal(details({ checks: { ...failing.checks, state: "pending", failed: 0 } }))).toMatchObject({ kind: "pending", tone: "wait" })
    expect(prSignal(details({ merge: "behind" }))!.label).toBe("Behind main")
    expect(prSignal(details({ merge: "blocked", review: "required" }))!.label).toBe("Review required")
    expect(prSignal(details())).toMatchObject({ kind: "passing", tone: "good" })
    // Nothing to say: no checks and GitHub still working out conflicts, or a PR that is over.
    expect(prSignal(details({ merge: "unknown", checks: { ...details().checks, state: "none", passed: 0 } }))).toBeNull()
    expect(prSignal(details({ state: "merged" }))).toBeNull()
    expect(prSignal(null)).toBeNull()
  })

  it("says the checks, merge and review in words", () => {
    expect(checksLine(failing.checks)).toEqual({ tone: "bad", text: "2 failing · 1 running · 9 passed" })
    expect(checksLine(details().checks)).toEqual({ tone: "good", text: "All 12 passed" })
    expect(checksLine({ ...details().checks, skipped: 2 }).text).toBe("12 passed · 2 skipped")
    expect(checksLine({ ...details().checks, state: "none", passed: 0 })).toEqual({ tone: "quiet", text: "No checks on its latest commit" })
    expect(mergeLine(failing)).toMatchObject({ tone: "bad", text: "Conflicts with main", hint: expect.stringContaining("merge main in") })
    expect(mergeLine(details()).text).toBe("No conflicts with main")
    expect(reviewLine("changes_requested")).toEqual({ tone: "bad", text: "Changes requested" })
    expect(reviewLine("none").tone).toBe("quiet")
  })
})

// The task as the task list has it, for the sheet's "Worked on by".
const listed: Task = {
  id: "task_prchip0001", projectId: "prj_site01", title: "Retry webhooks", prompt: "", status: "pr_ready",
  boxId: null, sessionId: "s", branch: "webhook-retry", prUrl, prState: "open",
  prMergedAt: null, prMergedBy: null, previews: [], question: null, summary: null,
  error: null, waitReason: null, waitBoxSize: null, waitFor: [], turnCount: 1, pendingCount: 0, lastArchivedAt: null, scheduleId: null,
  outcome: null, contextTokens: null, contextWindow: null, compactPending: false, compacting: false, agentCli: "claude",
  model: null, effort: null, claudeCostUsd: 0, claudeTokens: 0, routingRule: null, routingReason: null, runsOn: null, machineLabel: null,
  mergeRequest: null, createdAt: 1, updatedAt: 1,
}
// Another task that pushed to the same PR.
const helper: Task = { ...listed, id: "task_prhelp0001", title: "Fix the retry backoff", prUrl: null, prState: null }
const agents: PrTasksAnswer = {
  url: prUrl,
  branch: "webhook-retry",
  tasks: [
    { taskId: listed.id, roles: ["opened"], model: "claude-opus-5-5", since: 1 },
    { taskId: helper.id, roles: ["pushed"], model: "claude-opus-5-5", since: 2 },
  ],
}

describe("PrStatusChip", () => {
  let root: Root
  let host: HTMLElement
  let calls: string[]
  let answer: PrDetailsAnswer

  beforeEach(() => {
    calls = []
    answer = { details: failing, error: null, checkedAt: Date.now() - 30_000 }
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`)
      if (url.endsWith("/pr")) return new Response(JSON.stringify(answer))
      if (url === "/api/tasks") return new Response(JSON.stringify([listed, helper]))
      if (url === "/api/projects") return new Response(JSON.stringify([]))
      if (url.startsWith("/api/prs/")) return new Response(JSON.stringify(agents))
      return new Response(JSON.stringify({ task: {}, delivery: "now" }))
    })
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    document.body.innerHTML = ""
    vi.unstubAllGlobals()
  })

  const task = (over: Partial<PrStatusTask> = {}): PrStatusTask => ({
    id: "task_prchip0001",
    title: "Retry webhooks",
    status: "pr_ready",
    prUrl,
    prState: "open",
    prMergedAt: null,
    prMergedBy: null,
    mergeRequest: null,
    ...over,
  })
  const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))))
  /** The query's answer lands over a few timers (fetch, then React Query's notify), more under load: wait for what it shows. */
  const until = (check: () => unknown) =>
    act(async () => {
      await vi.waitFor(() => {
        if (!check()) throw new Error("not yet")
      }, { timeout: 3000, interval: 5 })
    })
  const facts = () => document.querySelector('[data-testid="pr-facts"]')
  const render = async (t: PrStatusTask) => {
    act(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
          createElement("header", { className: "@container/head" }, createElement(PrStatusChip, { task: t })),
          createElement(ConfirmHost),
        ),
      ),
    )
    await flush()
  }
  const chip = () => document.querySelector<HTMLButtonElement>("[data-pr-state]")!
  const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]')
  const open = async () => {
    await act(async () => void chip().click())
    await until(() => facts() || document.querySelector('[data-testid="pr-error"]'))
  }

  it("carries the PR's most urgent signal: a glyph beside its number, folded too, and in words", async () => {
    await render(task())
    await until(() => chip().getAttribute("data-pr-signal"))
    expect(calls).toEqual(["GET /api/tasks/task_prchip0001/pr"])
    expect(chip().getAttribute("data-pr-signal")).toBe("conflicts")
    expect(chip().textContent).toContain("PR #76")
    expect(chip().textContent).toContain(", Conflicts with main")
    expect(chip().title).toContain("PR #76: Conflicts with main")
    // Folded, "PR" goes but "#76" and the glyph after it stay: which PR, and its signal.
    const word = [...chip().querySelectorAll("span")].find((s) => s.textContent === "PR ")!
    expect(word.className).toContain("@max-[36rem]/head:sr-only")
    expect(word.parentElement!.className).not.toContain("sr-only")
    expect(word.parentElement!.textContent).toBe("PR #76")
    expect(chip().querySelector('[data-testid="pr-signal"]')!.getAttribute("class")).not.toMatch(/hidden|sr-only/)
    expect(chip().querySelector('[data-testid="pr-signal-badge"]')).toBeNull()
    // Green stays the open PR's, and purple is only ever Merged's.
    expect(chip().outerHTML).not.toContain("merged")
  })

  it("opens the sheet: failing checks link to their logs, conflicts say what Merge PR does, then review and files", async () => {
    await render(task())
    await open()
    expect(chip().getAttribute("aria-expanded")).toBe("true")
    const s = sheet()!
    expect(s.querySelector("h2")!.textContent).toContain("PR #76 · Open")
    expect(s.textContent).toContain("webhook-retry → main")
    expect(s.querySelector('[data-testid="pr-title"]')!.textContent).toBe("Retry webhooks with backoff")
    const checks = s.querySelector<HTMLElement>('[data-testid="pr-checks"]')!
    expect(checks.textContent).toContain("2 failing · 1 running · 9 passed")
    // Only what needs a look is listed (failing, then running); passing ones stay on GitHub.
    const links = [...checks.querySelectorAll<HTMLAnchorElement>("a")].map((a) => [a.textContent!.trim(), a.getAttribute("href")])
    expect(links).toEqual([
      ["test", "https://ci.example/test"],
      ["e2e", "https://ci.example/e2e"],
      ["All checks on GitHub", `${prUrl}/checks`],
    ])
    expect(checks.textContent).toContain("lint")
    expect(checks.textContent).not.toContain("build")
    const merge = s.querySelector<HTMLElement>('[data-testid="pr-merge"]')!
    expect(merge.textContent).toContain("Conflicts with main")
    expect(merge.textContent).toContain("Merge PR asks the agent to merge main in")
    expect(s.querySelector('[data-testid="pr-review"]')!.textContent).toBe("Review required")
    const files = s.querySelector<HTMLElement>('[data-testid="pr-files"]')!
    expect(files.textContent).toContain("8 files changed")
    expect(files.textContent).toContain("+120 −34")
    expect(files.querySelector("a")!.getAttribute("href")).toBe(`${prUrl}/files`)
    expect(s.textContent).toContain("From GitHub")
  })

  it("says which tasks worked on the PR, and a row closes the sheet and opens that task", async () => {
    history.replaceState(null, "", "/?session=task_other0001")
    await render(task())
    await open()
    await until(() => sheet()!.querySelector('[data-testid="pr-agent"]'))
    expect(calls).toContain("GET /api/prs/acme/site/76/tasks")
    const section = sheet()!.querySelector<HTMLElement>('[data-testid="pr-agents"]')!
    expect(section.querySelector("h2")!.textContent).toContain("Worked on by")
    await until(() => section.querySelectorAll('[data-testid="pr-agent"]').length === 2)
    const [here, row] = [...section.querySelectorAll<HTMLElement>('[data-testid="pr-agent"]')]
    // The task the sheet is in reads "This task" and links nowhere.
    expect(here!.textContent).toContain("This task")
    expect(here!.textContent).toContain("Opened it")
    expect(here!.tagName).not.toBe("A")
    expect(row!.tagName).toBe("A")
    expect(row!.textContent).toContain("Fix the retry backoff")
    await act(async () => void row!.click())
    expect(sheet()).toBeNull()
    expect(new URLSearchParams(location.search).get("session")).toBe("task_prhelp0001")
  })

  it("acts from the sheet: Open on GitHub, and Merge PR through the shared confirm", async () => {
    await render(task())
    await open()
    const github = sheet()!.querySelector<HTMLAnchorElement>('[data-testid="pr-open-github"]')!
    expect(github.getAttribute("href")).toBe(prUrl)
    expect(github.target).toBe("_blank")
    const merge = sheet()!.querySelector<HTMLButtonElement>('[data-merge-state="ready"]')!
    expect(merge.textContent).toContain("Merge PR…")
    await act(async () => void merge.click())
    const confirm = [...document.querySelectorAll('[role="dialog"]')].at(-1)!
    expect(confirm.textContent).toContain("Merge PR #76?")
    await act(async () => void [...confirm.querySelectorAll("button")].find((b) => b.textContent === "Send merge request")!.click())
    await until(() => calls.includes("POST /api/tasks/task_prchip0001/merge"))
    expect(calls).toContain("POST /api/tasks/task_prchip0001/merge")
    // The PR sheet is still open underneath.
    expect(document.querySelector('[data-testid="pr-facts"]')).not.toBeNull()
  })

  it("folds a pending merge into the chip instead of the signal, and the sheet's Merge PR waits", async () => {
    await render(task({ mergeRequest: { prNumber: 76, prUrl, requestedAt: 1, deliveredAt: 2 } }))
    expect(chip().textContent).toContain("merging…")
    expect(chip().querySelector('[data-testid="pr-signal"]')).toBeNull()
    expect(chip().querySelector('[data-testid="pr-signal-badge"]')).toBeNull()
    await open()
    const merge = sheet()!.querySelector<HTMLButtonElement>("[data-merge-state]")!
    expect(merge.disabled).toBe(true)
    expect(merge.textContent).toContain("Merge requested…")
  })

  it("asks about a merged PR only when the sheet opens, and has no Merge PR or merge row for it", async () => {
    answer = { details: details({ state: "merged", mergedAt: Date.now() - 3_600_000, mergedBy: "cody" }), error: null, checkedAt: Date.now() }
    await render(task({ prState: "merged", status: "done" }))
    expect(calls).toEqual([])
    expect(chip().className).toContain("border-merged")
    expect(chip().getAttribute("data-pr-signal")).toBeNull()
    await open()
    expect(calls.filter((c) => c.endsWith("/pr"))).toEqual(["GET /api/tasks/task_prchip0001/pr"])
    const s = sheet()!
    expect(s.querySelector("h2")!.textContent).toContain("PR #76 · Merged")
    expect(s.textContent).toContain("Into main by cody")
    expect(s.querySelector('[data-testid="pr-merge"]')).toBeNull()
    expect(s.querySelector("[data-merge-state]")).toBeNull()
    expect(s.querySelector('[data-testid="pr-open-github"]')).not.toBeNull()
  })

  it("says why there are no details, still offers Open on GitHub, and tries again", async () => {
    answer = { details: null, error: "This project has no GitHub token, so its PR's checks can't be read.", checkedAt: null }
    await render(task())
    await until(() => calls.length)
    expect(chip().getAttribute("data-pr-signal")).toBeNull()
    await open()
    const s = sheet()!
    expect(s.querySelector('[data-testid="pr-error"]')!.textContent).toContain("Can't show its checks, review or files: This project has no GitHub token")
    expect(s.querySelector('[data-testid="pr-title"]')!.textContent).toBe("Retry webhooks")
    expect(s.querySelector('[data-testid="pr-open-github"]')).not.toBeNull()
    answer = { details: details(), error: null, checkedAt: Date.now() }
    await act(async () => void [...s.querySelectorAll("button")].find((b) => b.textContent === "Try again")!.click())
    await until(facts)
    expect(sheet()!.querySelector('[data-testid="pr-checks"]')!.textContent).toContain("All 12 passed")
    expect(chip().getAttribute("data-pr-signal")).toBe("passing")
  })
})
