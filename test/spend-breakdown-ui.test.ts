// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SpendButton, SpendDetail, spendUrl, type SpendScope } from "../web/src/components/SpendBreakdown.js"
import { buildSpend, type SpendRow, type SpendTask } from "../server/spendBreakdown.js"
import type { SpendBreakdown } from "../shared/spendBreakdown.js"
import { taskSessionHref } from "../web/src/lib/navigation.js"

// The $ in a task's and a Captain's header: it asks for the breakdown only when opened, and the sheet shows every
// figure as text (totals, tokens, models with their harness, subtasks apart, runs newest first) and says plainly
// which costs are estimated and which are unknown.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const T0 = Date.UTC(2026, 10, 2, 9)
const M = 60_000

function row(r: Partial<SpendRow>): SpendRow {
  return {
    id: `use_${Math.random().toString(36).slice(2)}`,
    source: "task",
    runKind: "turn",
    projectId: "prj_a",
    taskId: "tsk_1",
    sessionId: "ses_1",
    model: "claude-opus-5-5",
    loginId: null,
    startedAt: T0,
    costUsd: 1,
    reportedUsd: 1,
    prevReportedUsd: null,
    costEstimated: false,
    inputTokens: 1_000,
    cacheCreationInputTokens: 2_000,
    cacheReadInputTokens: 30_000,
    outputTokens: 400,
    harness: "claude",
    turnId: null,
    durationMs: 90_000,
    ...r,
  }
}

const TASKS: SpendTask[] = [
  { id: "tsk_1", title: "Example parent task", agentCli: "claude" },
  { id: "tsk_2", title: "Example Codex subtask", agentCli: "codex" },
  { id: "tsk_3", title: "Example idle subtask", agentCli: "claude" },
]

/** A task on Opus then Sonnet (a compaction between), with a Codex subtask and one that hasn't run. */
const taskSpend = (): SpendBreakdown =>
  buildSpend({
    scope: "task",
    tasks: TASKS,
    turnIndex: new Map([["trn_1", 1], ["trn_2", 2]]),
    sessionRates: new Map(),
    rows: [
      row({ turnId: "trn_1", costUsd: 1.2, reportedUsd: 1.2 }),
      row({ runKind: "compact", startedAt: T0 + 10 * M, costUsd: 0.1, reportedUsd: 1.3, prevReportedUsd: 1.2, durationMs: 0 }),
      row({ turnId: "trn_2", startedAt: T0 + 20 * M, model: "claude-sonnet-5-5", costUsd: 0.25, reportedUsd: 0.25, costEstimated: true }),
      row({ taskId: "tsk_2", harness: "codex", model: "gpt-5.5", startedAt: T0 + 5 * M, costUsd: 0, reportedUsd: 0, outputTokens: 900 }),
    ],
  })

const captainSpend = (): SpendBreakdown =>
  buildSpend({
    scope: "captain",
    sessionRates: new Map(),
    rows: [row({ source: "captain", taskId: null, harness: "codex", model: "gpt-5.5", costUsd: 0, reportedUsd: 0 })],
  })

let root: Root
let host: HTMLDivElement
let requests: string[]
let answers: Record<string, SpendBreakdown | "fail">

beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  requests = []
  answers = {}
  vi.stubGlobal("fetch", async (url: string) => {
    requests.push(url)
    const answer = answers[url]
    if (!answer || answer === "fail") return new Response(JSON.stringify({ error: "Example failure" }), { status: 500 })
    return new Response(JSON.stringify(answer))
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)))
const all = (testid: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`)]
/** What it reads as: a space between elements, none inside a run of text. */
function words(node: Node): string {
  let out = ""
  for (const child of node.childNodes) out += child.nodeType === 1 ? ` ${words(child)} ` : (child.textContent ?? "")
  return out
}
const text = (el: Element | null | undefined) => (el ? words(el) : "").replace(/\s+/g, " ").trim()
const section = (name: string) => document.querySelector<HTMLElement>(`section[aria-label="${name}"]`)

function show(node: ReturnType<typeof createElement>) {
  act(() => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, node)))
}

describe("SpendDetail", () => {
  it("shows a task's own spend, its subtasks' apart and both together, each as text", () => {
    show(createElement(SpendDetail, { data: taskSpend() }))
    const stats = section("Totals")!
    expect([...stats.querySelectorAll("div > span:first-child")].map(text).slice(0, 3)).toEqual(["This task", "Subtasks (2)", "Together"])
    // Own: $1.20 + $0.10 + $0.25 (estimated); subtasks: one Codex run with no cost; together the same dollars.
    expect(all("spend-total").map(text)).toEqual(["$1.55", "Unknown", "$1.55"])
    expect(text(stats)).toContain("3 runs · 100k tokens")
    // The task's own tokens by kind, each with its label.
    const tokens = stats.querySelector('dl[aria-label="This task\'s tokens"]')!
    expect([...tokens.querySelectorAll("dt")].map(text)).toEqual(["Input", "Output", "Cache read", "Cache write"])
    expect([...tokens.querySelectorAll("dd")].map(text)).toEqual(["3k", "1k", "90k", "6k"])
    // The estimated part is said out loud.
    expect(text(all("spend-notes")[0])).toContain("≈$0.25 of it is estimated from tokens")
  })

  it("lists each model under the harness that ran it, priced as that run's model, most costly first", () => {
    show(createElement(SpendDetail, { data: taskSpend() }))
    const models = [...section("By model")!.querySelectorAll('[data-testid="spend-model"]')].map(text)
    expect(models).toHaveLength(2)
    expect(models[0]).toMatch(/^claude-opus-5-5 Claude Code · 2 runs \$1\.30 · 84% in 2k out 800 cache read 60k cache write 4k$/)
    expect(models[1]).toMatch(/^claude-sonnet-5-5 Claude Code · 1 run \$0\.25 \(≈\$0\.25 est\.\) · 16%/)
  })

  it("links each subtask with its own runs, and shows its cost as unknown when its CLI reported none", () => {
    const onLeave = vi.fn()
    show(createElement(SpendDetail, { data: taskSpend(), onLeave }))
    const subs = section("Subtasks (2)")!
    const links = [...subs.querySelectorAll<HTMLAnchorElement>("li a")]
    expect(links.map(text)).toEqual(["Example Codex subtask", "Example idle subtask"])
    expect(links[0]!.getAttribute("href")).toBe(taskSessionHref("tsk_2"))
    const items = [...subs.querySelectorAll(":scope > ul > li")].map(text)
    expect(items[0]).toContain("1 run cost unknown")
    expect(items[1]).toContain("no runs yet $0.00")
    expect(text(subs)).toContain("Subtasks by model")
    expect(text(subs)).toContain("gpt-5.5 Codex · 1 run cost unknown")
    // Following one steps the sheet aside.
    act(() => links[0]!.click())
    expect(onLeave).toHaveBeenCalledOnce()
    // The footnote names the harness that reported no cost.
    expect(text(document.querySelector('[data-testid="spend-detail"]'))).toContain('Codex reported tokens without a cost, so those runs show "cost unknown" and add $0 to the totals.')
  })

  it("lists the task's own runs newest first: its turn number, compaction, model, harness, time taken and tokens", () => {
    show(createElement(SpendDetail, { data: taskSpend() }))
    const runs = all("spend-run")
    expect(runs.map((r) => text(r.querySelector("span")))).toEqual(["Turn 2", "Compaction", "Turn 1"])
    expect(text(runs[0])).toContain("≈$0.25 est.")
    expect(text(runs[0])).toContain("claude-sonnet-5-5 · Claude Code · 1 min 30 s")
    expect(text(runs[1])).toContain("$0.10")
    // A compaction has no duration logged, so none shows.
    expect(text(runs[1])).toContain("claude-opus-5-5 · Claude Code in 1k")
    expect(runs[2]!.querySelector("time")!.getAttribute("dateTime")).toBe(new Date(T0).toISOString())
    // The subtask's run is in its own breakdown, not here.
    expect(runs.map(text).join(" ")).not.toContain("gpt-5.5")
    expect(text(section("Runs"))).toContain("newest first")
  })

  it("calls a Captain's spend unknown when its only runs reported tokens but no cost, never $0", () => {
    show(createElement(SpendDetail, { data: captainSpend() }))
    expect(all("spend-total").map(text)).toEqual(["Unknown"])
    expect(text(section("Totals"))).toContain("This Captain")
    expect(text(all("spend-notes")[0])).toBe("1 run reported tokens but no cost, so the total leaves it out.")
    expect(text(all("spend-model")[0])).toContain("gpt-5.5 Codex · 1 run cost unknown")
    expect(text(all("spend-run")[0])).toContain("cost unknown")
  })

  it("says so when nothing has run yet", () => {
    show(createElement(SpendDetail, { data: buildSpend({ scope: "captain", rows: [], sessionRates: new Map() }) }))
    expect(all("spend-total").map(text)).toEqual(["$0.00"])
    expect(text(section("By model"))).toContain("No usage recorded for this Captain yet.")
    expect(section("Runs")).toBeNull()
    expect(all("spend-notes")).toEqual([])
  })
})

describe("SpendButton", () => {
  const task: SpendScope = { kind: "task", id: "tsk_1", title: "Example parent task", version: "1.55:100000" }
  const captain: SpendScope = { kind: "captain", projectId: "prj_a", name: "Example project" }

  it("is a named 44px-to-a-finger button that asks for nothing until it opens", async () => {
    answers[spendUrl(task)] = taskSpend()
    show(createElement(SpendButton, { scope: task }))
    const button = document.querySelector<HTMLButtonElement>('[data-testid="spend-button"]')!
    expect(button.getAttribute("aria-label")).toBe("Cost breakdown")
    expect(button.getAttribute("aria-haspopup")).toBe("dialog")
    expect(button.getAttribute("aria-expanded")).toBe("false")
    expect(button.className).toContain("pointer-coarse:h-11 pointer-coarse:w-11")
    expect(button.querySelector("svg")!.getAttribute("class")).toContain("lucide-circle-dollar-sign")
    await settle()
    expect(requests).toEqual([])

    await act(async () => void button.click())
    await settle()
    expect(requests).toEqual(["/api/tasks/tsk_1/usage"])
    expect(button.getAttribute("aria-expanded")).toBe("true")
    const dialog = document.querySelector('[role="dialog"]')!
    expect(text(dialog)).toContain("Cost breakdown")
    expect(text(dialog)).toContain("Example parent task")
    expect(all("spend-total").map(text)).toEqual(["$1.55", "Unknown", "$1.55"])

    // A second click closes it.
    await act(async () => void button.click())
    expect(document.querySelector('[data-testid="spend-detail"]')).toBeNull()
  })

  it("opens the Captain's breakdown from its project", async () => {
    answers[spendUrl(captain)] = captainSpend()
    show(createElement(SpendButton, { scope: captain }))
    await act(async () => void document.querySelector<HTMLButtonElement>('[data-testid="spend-button"]')!.click())
    await settle()
    expect(requests).toEqual(["/api/projects/prj_a/captain/usage"])
    expect(text(document.querySelector('[role="dialog"]'))).toContain("Example project Captain")
    expect(all("spend-total").map(text)).toEqual(["Unknown"])
  })

  it("says when the breakdown couldn't load", async () => {
    answers[spendUrl(task)] = "fail"
    show(createElement(SpendButton, { scope: task }))
    await act(async () => void document.querySelector<HTMLButtonElement>('[data-testid="spend-button"]')!.click())
    await settle()
    expect(text(document.querySelector('[role="dialog"]'))).toContain("Couldn't load the cost breakdown.")
  })
})
