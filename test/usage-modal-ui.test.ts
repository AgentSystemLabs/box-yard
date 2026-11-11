// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { UsageModal } from "../web/src/components/UsageModal.js"
import { buildUsageLedger, type LedgerClaudeRow } from "../server/usageLedger.js"
import type { LimitsReport, LimitWindow } from "../shared/loginLimits.js"
import type { UsageRangeDays } from "../shared/usageLedger.js"

// The Usage modal: totals, both charts and the breakdown add up; a legend item, a breakdown row or a filter chip
// narrows or widens everything; the range buttons ask for another range.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const H = 3_600_000

function claudeRow(r: Partial<LedgerClaudeRow>): LedgerClaudeRow {
  return {
    source: "task",
    runKind: "turn",
    projectId: "prj_a",
    taskId: "tsk_1",
    sessionId: null,
    model: "claude-opus-5-5",
    loginId: null,
    startedAt: 0,
    costUsd: 1,
    reportedUsd: 0,
    prevReportedUsd: null,
    costEstimated: false,
    inputTokens: 100,
    cacheCreationInputTokens: 200,
    cacheReadInputTokens: 3000,
    outputTokens: 40,
    ...r,
  }
}

/** What the server would answer for these day starts: two projects, two models, an Upstash box. */
function ledgerFor(days: number[]) {
  const last = days.at(-1)!
  const prev = days.at(-2)!
  return buildUsageLedger({
    from: days[0]!,
    to: last + 24 * H,
    days,
    claude: [
      claudeRow({ startedAt: prev + H, costUsd: 4 }),
      claudeRow({ startedAt: last + H, costUsd: 2, model: "claude-sonnet-5-5", projectId: "prj_b", taskId: "tsk_2" }),
      claudeRow({ startedAt: last + 2 * H, costUsd: 0.5, source: "orchestrator", projectId: null, taskId: null }),
    ],
    sessionRates: new Map(),
    intervals: [{ boxId: "pure-lobster", provider: "upstash", startedAt: prev, endedAt: prev + 4 * H, costUsd: 0.8, source: "measured" }],
    pods: [],
    turns: [{ taskId: "tsk_1", projectId: "prj_a", boxId: "pure-lobster", startedAt: prev, endedAt: prev + 2 * H }],
    names: { projects: { prj_a: "Alpha", prj_b: "Beta" }, tasks: { tsk_1: { title: "Task one", projectId: "prj_a" }, tsk_2: { title: "Task two", projectId: "prj_b" } }, boxes: {}, logins: {} },
    rates: { upstashCpuHourUsd: { small: 0.1, medium: 0.2, large: 0.4 }, daytona: { vcpuHour: 0.0504, memoryGibHour: 0.0162 } },
  })
}
const TOTAL = 4 + 2 + 0.5 + 0.8

let root: Root
let host: HTMLElement
let requests: string[]
let limits: LimitsReport
let failed: Set<string>
let emptyUsage: boolean

function allowance(windows: Partial<LimitWindow>[] = [{}]): LimitsReport {
  const now = Date.now()
  return {
    now,
    logins: [{
      loginId: "lgn_example-claude", harness: "claude", kind: "oauth_token", source: "Acme subscription",
      scope: "settings", fingerprint: "aaaaaaaaaaaa", plan: null, asOf: now,
      windows: windows.map((w) => ({ window: "seven_day", label: "Weekly", minutes: 10_080, usedPct: 83, resetsAt: now + 72 * H, status: "warning", asOf: now, ...w })),
      state: { atLimit: false, usedPct: 83, resetsAt: now + 72 * H, asOf: now },
    }],
  }
}

beforeEach(() => {
  requests = []
  limits = { now: Date.now(), logins: [] }
  failed = new Set()
  emptyUsage = false
  vi.stubGlobal("fetch", async (url: string) => {
    requests.push(url)
    const path = url.split("?")[0]!
    if (failed.has(path)) return new Response(JSON.stringify({ error: "Example service unavailable" }), { status: 503 })
    if (url === "/api/limits") return new Response(JSON.stringify(limits))
    if (url === "/api/usage/budget") return new Response(JSON.stringify({
      daily: { usedUsd: 3, limitUsd: 10, warning: false, exceeded: false },
      monthly: { usedUsd: 40, limitUsd: 100, warning: false, exceeded: false },
    }))
    const m = /^\/api\/usage\/daily\?days=([\d,]+)$/.exec(url)
    if (!m) return new Promise(() => {})
    const body = ledgerFor(m[1]!.split(",").map(Number))
    if (emptyUsage) { body.llm = []; body.compute = [] }
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
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

const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)))
const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid=${id}]`)
const $$ = (id: string, within: ParentNode = document) => [...within.querySelectorAll<HTMLElement>(`[data-testid=${id}]`)]
const dollars = (s: string | null | undefined) => Number(/\$([\d,.]+)/.exec(s ?? "")![1]!.replace(/,/g, ""))
const buttonByText = (within: ParentNode, text: string) => [...within.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!
const click = (el: HTMLElement) => act(() => el.click())
/** A breakdown row's own total: its last money figure (to the cent, so the share column after it isn't read in). */
const rowTotal = (r: HTMLElement) => dollars([...(r.textContent ?? "").matchAll(/\$[\d,]+\.\d{2}/g)].at(-1)![0])

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })

async function render(days: UsageRangeDays = 7, onDays = vi.fn(), client = newClient()) {
  act(() => root.render(createElement(QueryClientProvider, { client }, createElement(UsageModal, { days, onDays, onClose: () => {} }))))
  await settle()
  return onDays
}

describe("the usage modal", () => {
  it("asks for the range's local midnights and shows totals that the breakdown adds up to", async () => {
    await render(7)
    const req = requests.find((u) => u.startsWith("/api/usage/daily"))!
    const days = /days=([\d,]+)/.exec(req)![1]!.split(",").map(Number)
    expect(days).toHaveLength(7)
    for (const d of days) expect(new Date(d).getHours()).toBe(0)
    expect(dollars($("usage-total")!.textContent)).toBeCloseTo(TOTAL, 2)
    expect(rowTotal($("usage-total-row")!)).toBeCloseTo(TOTAL, 2)
    const rows = $$("usage-row", $("usage-breakdown")!)
    expect(rows.map((r) => r.textContent?.match(/Alpha|Beta|No project/)?.[0])).toEqual(["Alpha", "Beta", "No project"])
    expect(rows.reduce((a, r) => a + rowTotal(r), 0)).toBeCloseTo(TOTAL, 2)
    // Every day is a bar slot, and the cost chart stacks models and the box provider.
    expect($$("usage-day", $("usage-cost-chart")!)).toHaveLength(7)
    const series = new Set([...$("usage-cost-chart")!.querySelectorAll("[data-series]")].map((e) => e.getAttribute("data-series")))
    expect(series).toEqual(new Set(["model:claude-opus-5-5", "model:claude-sonnet-5-5", "provider:upstash"]))
  })

  it("narrows to a model from the legend, and widens again from its chip", async () => {
    await render()
    const legend = $("usage-cost-chart")!.querySelector("[aria-label=Legend]")!
    const sonnet = [...legend.querySelectorAll("button")].find((b) => /Sonnet/.test(b.textContent ?? ""))!
    click(sonnet)
    expect($("usage-filters")!.textContent).toMatch(/Model.*Sonnet/)
    expect(dollars($("usage-total")!.textContent)).toBeCloseTo(2, 2)
    click(buttonByText($("usage-filters")!, "Sonnet"))
    expect($("usage-filters")).toBeNull()
    expect(dollars($("usage-total")!.textContent)).toBeCloseTo(TOTAL, 2)
  })

  it("drills from a project to its tasks, with the box's share on the task that ran on it", async () => {
    await render()
    click(buttonByText($("usage-breakdown")!, "Alpha"))
    expect($("usage-filters")!.textContent).toMatch(/Project.*Alpha/)
    expect(($("usage-breakdown")!.querySelector("select") as HTMLSelectElement).value).toBe("task")
    const rows = $$("usage-row", $("usage-breakdown")!)
    const one = rows.find((r) => r.textContent?.includes("Task one"))!
    // The box was up 4 hours and the task's turn took 2: half its $0.80 is the task's. The other half is idle time on
    // a box no project is named after, so it stays under No project.
    expect(rowTotal(one)).toBeCloseTo(4.4, 2)
    expect(rows.some((r) => r.textContent?.includes("Idle box time"))).toBe(false)
    expect(dollars($("usage-total")!.textContent)).toBeCloseTo(4.4, 2)
  })

  it("asks for another range from its buttons", async () => {
    const onDays = await render(7)
    const range = document.querySelector("[aria-label=Range]")!
    expect(range.querySelector("[aria-pressed=true]")!.getAttribute("aria-label")).toBe("Last 7 days")
    click(range.querySelector<HTMLElement>("[aria-label='Last 90 days']")!)
    expect(onDays).toHaveBeenCalledWith(90)
  })

  it("starts fetching a range as a pointer comes to its button, and doesn't fetch it again once picked", async () => {
    const client = newClient()
    await render(7, vi.fn(), client)
    const ninety = () => requests.filter((u) => /days=/.test(u) && u.split(",").length === 90)
    expect(ninety()).toHaveLength(0)
    act(() => void document.querySelector("[aria-label='Last 90 days']")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })))
    await settle()
    expect(ninety()).toHaveLength(1)
    // The range showing isn't fetched again for a pointer on its own button.
    const seven = requests.length
    act(() => void document.querySelector("[aria-label='Last 7 days']")!.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })))
    await settle()
    expect(requests).toHaveLength(seven)
    await render(90, vi.fn(), client)
    expect(ninety()).toHaveLength(1)
    expect($$("usage-day", $("usage-cost-chart")!)).toHaveLength(90)
  })

  it("reads out a day picked from the keyboard, as text", async () => {
    await render()
    const chart = $("usage-cost-chart")!.querySelector<HTMLElement>("[role=group]")!
    expect($$("usage-readout")[0]!.textContent).toContain("All 7 days")
    act(() => chart.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })))
    const readout = $$("usage-readout")[0]!.textContent!
    expect(readout).not.toContain("All 7 days")
    expect(dollars(readout)).toBeCloseTo(2.5, 2)
  })

  it("shows its token chart and how its estimates are made", async () => {
    await render()
    const tokens = $("usage-token-chart")!
    expect([...tokens.querySelectorAll("[aria-label=Legend] button")].map((b) => b.textContent?.replace(/[\d.]+[KM]?$/, "").trim())).toEqual(["Input", "Cache write", "Cache read", "Output"])
    // A kind alone, on its own scale, and back to all four.
    click(buttonByText(tokens, "Output"))
    expect(new Set([...tokens.querySelectorAll("[data-series]")].map((e) => e.getAttribute("data-series")))).toEqual(new Set(["output"]))
    click(buttonByText(tokens, "Output"))
    expect(new Set([...tokens.querySelectorAll("[data-series]")].map((e) => e.getAttribute("data-series"))).size).toBe(4)
    expect($("usage-estimates")!.textContent).toMatch(/≈/)
  })
  it("shows per-login weekly used and remaining separately from cost, without filtering allowances", async () => {
    limits = allowance()
    await render()
    const allowances = $("subscription-limits")!
    expect(allowances.textContent).toMatch(/Claude.*Acme subscription.*Weekly.*83% used.*17% remaining.*resets/)
    expect(allowances.querySelector("[role=meter]")?.getAttribute("aria-valuenow")).toBe("83")
    expect(allowances.textContent).not.toContain("$")
    const before = allowances.textContent
    click(buttonByText($("usage-breakdown")!, "Alpha"))
    expect(dollars($("usage-total")!.textContent)).toBeCloseTo(4.4, 2)
    expect(allowances.textContent).toBe(before)
    const dialog = document.querySelector("[role=dialog]")!
    expect(dialog.textContent).toContain("not your subscription bill")
    const boxes = dialog.querySelector('[aria-label="Boxes against your cloud limits"]')!
    expect(boxes.textContent).toMatch(/Box spending limits.*Model costs and subscription allowances do not count/)
    expect(boxes.querySelector('[role=meter]')?.getAttribute("aria-valuenow")).toBe("3")
  })

  it("shows zero as measured, and does not invent percentages for unknown, rejected or reset readings", async () => {
    limits = allowance([
      { window: "zero", usedPct: 0 },
      { window: "unknown", usedPct: null, status: null, resetsAt: null },
      { window: "rejected", usedPct: null, status: "rejected" },
      { window: "expired", resetsAt: Date.now() - H },
      { window: "over", usedPct: 102 },
      { window: "near", usedPct: 99.6 },
    ])
    await render()
    const windows = $$("limits-window")
    expect(windows[0]!.textContent).toContain("0% used100% remaining")
    expect(windows[0]!.querySelector('[role=meter]')?.getAttribute("aria-valuenow")).toBe("0")
    expect(windows[1]!.textContent).toContain("Usage not reported")
    expect(windows[1]!.textContent).toContain("Reset time not reported")
    expect(windows[2]!.textContent).toContain("at the limit")
    expect(windows[3]!.textContent).toContain("reset since")
    for (const w of windows.slice(1, 4)) {
      expect(w.querySelector('[role=meter]')).toBeNull()
      expect(w.textContent).not.toContain("remaining")
    }
    expect(windows[4]!.textContent).toContain("102% used0% remaining")
    expect(windows[4]!.querySelector('[role=meter]')?.getAttribute("aria-valuenow")).toBe("100")
    expect(windows[5]!.textContent).toContain("99.6% used<1% remaining")
  })

  it("explains the absence of subscription readings and empty usage independently", async () => {
    emptyUsage = true
    await render()
    expect($("limits-empty")!.textContent).toContain("No readings yet")
    expect($("limits-empty")!.textContent).toContain("API keys pay per token")
    expect($("usage-empty")!.textContent).toBe("No recorded usage in this range.")
    expect(dollars($("usage-total")!.textContent)).toBe(0)
    expect(document.querySelector('[aria-label="Boxes against your cloud limits"]')).not.toBeNull()
  })

  it("keeps allowances and box limits usable if the cost ledger fails, and retries costs", async () => {
    limits = allowance()
    failed.add("/api/usage/daily")
    await render()
    expect($("subscription-limits")!.textContent).toContain("17% remaining")
    expect(document.querySelector('[aria-label="Boxes against your cloud limits"]')?.textContent).toContain("$3.00")
    expect(document.body.textContent).toContain("Couldn't load usage")
    failed.clear()
    click(buttonByText(document, "Retry costs"))
    await settle()
    expect(dollars($("usage-total")!.textContent)).toBeCloseTo(TOTAL, 2)
  })

  it("keeps the cost report if allowance and box readings fail, with separate retries", async () => {
    failed.add("/api/limits").add("/api/usage/budget")
    await render()
    expect($("subscription-limits")!.textContent).toContain("Subscription readings are unavailable")
    expect(document.body.textContent).toContain("Box spending limits are unavailable")
    expect(dollars($("usage-total")!.textContent)).toBeCloseTo(TOTAL, 2)
    limits = allowance()
    failed.clear()
    click(buttonByText(document, "Retry allowances"))
    click(buttonByText(document, "Retry box limits"))
    await settle()
    expect($("subscription-limits")!.textContent).toContain("17% remaining")
    expect(document.body.textContent).not.toContain("are unavailable")
  })

})
