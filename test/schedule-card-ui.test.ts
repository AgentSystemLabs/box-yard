// @vitest-environment happy-dom
// A schedule's card: when it runs in plain words, when it runs next, how the last run ended (with a link),
// and Run now / Pause / Resume that say what they did.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Router } from "wouter"
import { memoryLocation } from "wouter/memory-location"
import { ScheduleCard } from "../web/src/components/Schedules.js"
import { keys, useSchedules } from "../web/src/lib/queries.js"
import { currentConfirm, settleConfirm } from "../web/src/lib/confirm.js"
import { REVEAL_CHAT_EVENT } from "../web/src/lib/reveal.js"
import type { Schedule, ScheduleRun, Task } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Tuesday Nov 3 2026, 6:30 PM in Chicago.
const NOW = Date.parse("2026-11-04T00:30:00Z")
const HOUR = 3_600_000

const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  id: "sch_nightly1",
  target: "project",
  projectId: "prj_demo01",
  runsOn: null,
  name: "Nightly dependency check",
  cron: "0 2 * * *",
  timezone: "America/Chicago",
  prompt: "Bump safe minor versions.",
  enabled: true,
  catchUp: "once",
  allowOverlap: false,
  nextRunAt: Date.parse("2026-11-04T08:00:00Z"),
  lastRunAt: NOW - HOUR,
  lastTaskId: "task_done000001",
  lastSkipReason: null,
  runCount: 2,
  qstashId: null,
  createdAt: NOW - 48 * HOUR,
  updatedAt: NOW - HOUR,
  ...over,
})

const task = (over: Partial<Task>): Task =>
  ({
    id: "task_done000001",
    projectId: "prj_demo01",
    title: "Nightly dependency check · Nov 3, 17:30",
    status: "done",
    summary: "Bumped 3 packages, PR opened",
    error: null,
    prUrl: null,
    prState: null,
    previews: [],
    question: null,
    outcome: null,
    scheduleId: "sch_nightly1",
    createdAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    ...over,
  }) as Task

const chatRun = (over: Partial<ScheduleRun>): ScheduleRun => ({
  id: "run_aaaaaaaaaa",
  scheduleId: "sch_digest01",
  status: "done",
  reason: "scheduled",
  prompt: "[Scheduled: Open PR digest] Summarize open PRs.",
  dueAt: NOW - HOUR,
  chatMessageId: "chat_aaaaaaaaaa",
  error: null,
  createdAt: NOW - HOUR,
  startedAt: NOW - HOUR,
  finishedAt: NOW - HOUR,
  ...over,
})

describe("ScheduleCard", () => {
  let root: Root
  let host: HTMLElement
  let qc: QueryClient
  let requests: { url: string; method: string; body: any }[]
  /** Answers POST /run; tests that look at "Starting…" hold it open. */
  let runResponse: () => Promise<unknown>

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(NOW)
    requests = []
    runResponse = async () => task({ id: "task_new0000001", status: "queued", summary: null, createdAt: Date.now() })
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET"
      const body = init.body ? JSON.parse(String(init.body)) : null
      requests.push({ url, method, body })
      let out: unknown = []
      const current = qc.getQueryData<Schedule[]>(keys.schedules)?.find((s) => url.includes(s.id))
      if (method === "PATCH") out = { ...current, ...body, nextRunAt: body.enabled ? Date.parse("2026-11-04T08:00:00Z") : null }
      else if (method === "POST" && url.endsWith("/run")) out = await runResponse()
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } })
    })
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    qc.setQueryData(keys.tasks, [])
    qc.setQueryData(keys.scheduleRuns, [])
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    while (currentConfirm()) settleConfirm(currentConfirm()!.id, false)
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  // The card reads its schedule from the cache, as the list does, so optimistic updates show.
  const Live = () => {
    const s = useSchedules().data?.[0]
    return s ? createElement(ScheduleCard, { schedule: s }) : null
  }
  const render = (s: Schedule) => {
    qc.setQueryData(keys.schedules, [s])
    const location = memoryLocation({ path: "/schedules" })
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Router, { hook: location.hook }, createElement(Live)))))
  }
  const text = (testId: string) => host.querySelector(`[data-testid="${testId}"]`)?.textContent?.replace(/\s+/g, " ").trim()
  const button = (label: string | RegExp) =>
    [...host.querySelectorAll("button")].find((b) => (typeof label === "string" ? b.textContent?.trim() === label : label.test(b.textContent ?? "")))
  const click = (el: Element | null | undefined) => act(() => void el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
  const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))))
  const said = () => host.querySelector('[role="status"]')?.textContent

  it("says when it runs in plain words, when it runs next, and how the last run ended with a link to it", () => {
    qc.setQueryData(keys.tasks, [task({}), task({ id: "task_old0000001", status: "failed", createdAt: NOW - 25 * HOUR })])
    render(schedule())
    expect(text("schedule-when")).toBe("Every day at 2:00 AM Chicago")
    expect(text("schedule-next")).toMatch(/^Tomorrow 2:00 AM( Chicago)? · in 8h$/)
    const last = host.querySelector<HTMLAnchorElement>('[data-testid="schedule-last"] a')!
    expect(last.getAttribute("href")).toBe("/tasks/task_done000001")
    expect(last.textContent).toContain("Done")
    expect(last.textContent).toContain("Bumped 3 packages, PR opened")
    expect(last.textContent).toContain("1h ago")
    // The raw cron and zone are one tap away, not on the card's face.
    expect(host.textContent).not.toContain("0 2 * * *")
    click(button(/Show prompt and 2 runs/))
    expect(host.textContent).toContain("Cron 0 2 * * * in America/Chicago")
  })

  it("puts a failed run's reason in a line", () => {
    qc.setQueryData(keys.tasks, [task({ status: "failed", summary: null, error: "Couldn't start the agent: the box ran out of disk" })])
    render(schedule())
    expect(text("schedule-last")).toMatch(/^Failed\s*1h ago\s*The agent couldn't start$/)
  })

  it("keeps the last finished run in view while a new one is going", () => {
    qc.setQueryData(keys.tasks, [task({ id: "task_live000001", status: "working", summary: null, createdAt: NOW - 60_000 }), task({})])
    render(schedule())
    expect(host.textContent).toContain("Running now")
    expect(host.querySelector('[data-testid="schedule-last"] a')!.getAttribute("href")).toBe("/tasks/task_done000001")
  })

  it("says so when there are no runs yet", () => {
    render(schedule({ runCount: 0, lastRunAt: null, lastTaskId: null }))
    expect(text("schedule-last")).toBe("No runs yet")
    expect(button(/Show prompt and runs/)).toBeTruthy()
  })

  it("Pause and Resume are labelled buttons that say what they did", async () => {
    render(schedule())
    click(button("Pause"))
    expect(said()).toBe("Paused. Nothing runs until you resume it.")
    await settle()
    expect(requests.at(-1)).toMatchObject({ url: "/api/schedules/sch_nightly1", method: "PATCH", body: { enabled: false } })
    expect(text("schedule-next")).toBe("Paused. Nothing runs until you resume it.")
    expect(host.querySelector("h3")?.parentElement?.textContent).toContain("Paused")

    click(button("Resume"))
    expect(said()).toMatch(/^Resumed\. Next run Tomorrow 2:00 AM( Chicago)? · in 8h\.$/)
    await settle()
    expect(requests.at(-1)).toMatchObject({ method: "PATCH", body: { enabled: true } })
    expect(text("schedule-next")).toMatch(/^Tomorrow 2:00 AM/)
    expect(button("Pause")).toBeTruthy()
  })

  it("a resumed schedule shows its next run before the server has planned it", async () => {
    render(schedule({ enabled: false, nextRunAt: null }))
    expect(text("schedule-next")).toBe("Paused. Nothing runs until you resume it.")
    act(() => void qc.setQueryData<Schedule[]>(keys.schedules, (list) => list!.map((s) => ({ ...s, enabled: true }))))
    await settle()
    expect(text("schedule-next")).toMatch(/^Tomorrow 2:00 AM( Chicago)? · in 8h$/)
  })

  it("Run now says Starting… until the server answers, then Started, and the run shows as live", async () => {
    let answer!: (t: Task) => void
    runResponse = () => new Promise((resolve) => (answer = resolve))
    render(schedule())
    click(button("Run now"))
    await settle()
    expect(requests.at(-1)).toMatchObject({ url: "/api/schedules/sch_nightly1/run", method: "POST" })
    expect(button("Starting…")?.disabled).toBe(true)

    await act(async () => answer(task({ id: "task_new0000001", status: "queued", summary: null, createdAt: Date.now() })))
    await settle()
    expect(button("Started")).toBeTruthy()
    expect(said()).toBe("Run started.")
    expect(host.textContent).toContain("Running now")
  })

  it("Run now asks first when a run is already going", async () => {
    qc.setQueryData(keys.tasks, [task({ id: "task_live000001", status: "working", summary: null })])
    render(schedule())
    click(button("Run now"))
    await settle()
    expect(currentConfirm()?.title).toBe("Start another run?")
    act(() => settleConfirm(currentConfirm()!.id, false))
    await settle()
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0)

    click(button("Run now"))
    await settle()
    act(() => settleConfirm(currentConfirm()!.id, true))
    await settle()
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1)
  })

  it("a Coordinator schedule's last run opens its chat message, and Run now says Sent", async () => {
    const s = schedule({ id: "sch_digest01", target: "orchestrator", projectId: null, name: "Open PR digest", cron: "0 8 * * *" })
    qc.setQueryData(keys.scheduleRuns, [chatRun({})])
    runResponse = async () => chatRun({ id: "run_bbbbbbbbbb", status: "queued", chatMessageId: null, createdAt: Date.now() })
    render(s)
    expect(text("schedule-when")).toBe("Every day at 8:00 AM Chicago")
    expect(text("schedule-last")).toMatch(/^Done\s*1h ago\s*View in chat$/)
    const revealed: string[] = []
    const onReveal = (e: Event) => revealed.push((e as CustomEvent<string>).detail)
    window.addEventListener(REVEAL_CHAT_EVENT, onReveal)
    click(button("View in chat"))
    window.removeEventListener(REVEAL_CHAT_EVENT, onReveal)
    expect(revealed).toEqual(["chat_aaaaaaaaaa"])

    click(button("Run now"))
    await settle()
    await settle()
    expect(button("Sent")).toBeTruthy()
    expect(said()).toBe("Sent to the Coordinator. It runs when the chat is free.")
    expect(host.textContent).toContain("Queued in chat")
  })
})
