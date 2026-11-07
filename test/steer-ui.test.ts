// @vitest-environment happy-dom
// Steer on the task page's Queued rows: one tap while a Claude turn runs (nothing stops, so nothing asks), no Steer
// without a turn to steer into or on a Codex agent (its rows say why), the Steering rows, and the transcript's mark.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TaskQueue } from "../web/src/components/QueuedMessages.js"
import { Line } from "../web/src/components/TaskView.js"
import { keys } from "../web/src/lib/queries.js"
import { currentToasts as toasts } from "../web/src/lib/toast.js"
import type { QueuedMessage, Task, TaskMessage } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let qc: QueryClient
let calls: { method: string; url: string; body: unknown }[]
let queue: QueuedMessage[]
let steerReply: { status: number; data: unknown }

const TASK = "task_steer01"
const msg = (id: string, text: string): QueuedMessage => ({
  id,
  taskId: TASK,
  source: "cody",
  kind: "owner",
  sender: "Cody",
  text,
  attachments: [],
  status: "queued",
  version: 1,
  createdAt: Date.parse("2026-10-26T10:00:00Z") + Number(id.slice(-1)) * 1000,
  updatedAt: 0,
})

const json = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }))

beforeEach(() => {
  calls = []
  steerReply = { status: 200, data: { task: { id: TASK }, delivery: "steering", queued: 2 } }
  queue = [msg("in_bbbbbb1", "use blue"), msg("in_bbbbbb2", "add a footer")]
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url === `/api/tasks/${TASK}/queue/steer` && method === "POST") return json(steerReply.data, steerReply.status)
    if (url === `/api/tasks/${TASK}/queue` && method === "GET") return json(queue)
    return new Promise(() => {})
  })
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const seed = (task: Partial<Task>) => qc.setQueryData<Partial<Task>[]>(keys.tasks, [{ id: TASK, pendingCount: 2, queueRev: "1", compacting: false, mergeRequest: null, agentCli: "claude", ...task }])
const render = () => act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(TaskQueue, { taskId: TASK }))))
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))))
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
const rows = () => [...host.querySelectorAll("[data-testid=queued-message]")]
const steerButton = (row: Element) => row.querySelector('button[aria-label="Steer the queued messages into the running turn"]')
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)
const posts = () => calls.filter((c) => c.method === "POST")

describe("Steer on Queued rows", () => {
  it("sits next to Edit and Cancel while a turn runs, and steers the whole queue in one tap", async () => {
    seed({ status: "working" })
    render()
    await settle()
    const labels = [...rows()[1]!.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))
    expect(labels).toEqual(["Steer the queued messages into the running turn", "Edit queued message", "Cancel queued message"])
    const steer = steerButton(rows()[1]!)!
    // Its name shows, not only an icon, and its title says what it does.
    expect(steer.textContent?.trim()).toBe("Steer")
    expect(steer.getAttribute("title")).toBe("Steer: the agent reads the queued messages at its next step, without stopping")
    // 44px to a finger, 24px from sm.
    expect(steer.className).toMatch(/\bh-11\b/)
    expect(steer.className).toMatch(/\bsm:h-6\b/)
    expect(rows()[0]!.textContent).toContain("Delivered when the current turn ends, or at the agent's next step with Steer.")

    // On the second row it still steers the whole queue, at once: nothing stops, so nothing asks.
    click(steer)
    expect(host.querySelector("[role=alertdialog]")).toBeNull()
    await settle()
    expect(posts()).toEqual([{ method: "POST", url: `/api/tasks/${TASK}/queue/steer`, body: {} }])
    expect(toasts().some((t) => t.title === "Steering" && t.body === "The agent reads all 2 queued messages at its next step, without stopping.")).toBe(true)
  })

  it("steers a turn that is merging a PR like any other: nothing is stopped midway", async () => {
    seed({ status: "working", mergeRequest: { prNumber: 12, prUrl: "https://github.com/a/b/pull/12", requestedAt: 1, deliveredAt: 2, inputId: "in_x", requestedBy: null } })
    render()
    await settle()
    click(steerButton(rows()[0]!)!)
    expect(host.querySelector("[role=alertdialog]")).toBeNull()
    await settle()
    expect(posts()).toHaveLength(1)
  })

  it("has no Steer without a running turn to steer into, or on a Codex agent, and says when the message goes", async () => {
    seed({ status: "queued" })
    render()
    await settle()
    expect(steerButton(rows()[0]!)).toBeNull()
    expect(rows()[0]!.textContent).toContain("Delivered when the agent's next turn starts.")

    act(() => seed({ status: "working", compacting: true }))
    await settle()
    expect(steerButton(rows()[0]!)).toBeNull()
    expect(rows()[0]!.textContent).toContain("Delivered once the agent has compacted its context.")

    act(() => seed({ status: "working", agentCli: "codex" }))
    await settle()
    expect(steerButton(rows()[0]!)).toBeNull()
    expect(rows()[0]!.textContent).toContain("Delivered when the current turn ends: Codex can't take a message mid-turn.")
  })

  it("shows a steer on its way as a locked Steering row, without a spinner", async () => {
    queue = [{ ...msg("in_bbbbbb1", "use blue"), status: "steering" }, msg("in_bbbbbb2", "add a footer")]
    seed({ status: "working" })
    render()
    await settle()
    const [steering, queued] = rows()
    expect(steering!.textContent).toContain("Steering")
    expect(steering!.textContent).toContain("On its way into the running turn: the agent reads it at its next step.")
    expect(steering!.querySelectorAll("button")).toHaveLength(0)
    expect(steering!.querySelector(".animate-spin")).toBeNull()
    expect(steerButton(queued!)).not.toBeNull()
  })

  it("says when the turn can't be steered, and shows the server's error", async () => {
    seed({ status: "working" })
    steerReply = { status: 200, data: { task: { id: TASK }, delivery: "after_turn", queued: 2, note: "the box couldn't be reached (timeout)" } }
    render()
    await settle()
    click(steerButton(rows()[0]!)!)
    await settle()
    expect(toasts().some((t) => t.title === "Couldn't steer" && t.body === "The box couldn't be reached (timeout): all 2 queued messages go in when the turn ends.")).toBe(true)

    steerReply = { status: 404, data: { error: "Task not found" } }
    click(steerButton(rows()[0]!)!)
    await settle()
    expect(toasts().some((t) => t.kind === "error" && t.title === "Couldn't steer" && /Task not found/.test(t.body ?? ""))).toBe(true)
  })
})

describe("A steered message in the transcript", () => {
  const line = (meta: Record<string, unknown>): TaskMessage => ({ id: "msg_1", taskId: TASK, role: "user", content: "use blue", meta: { source: "cody", ...meta }, createdAt: 1 }) as TaskMessage
  const show = (m: TaskMessage) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Line, { m, onFollowUp: () => {} }))))

  it("says it was steered where it landed", () => {
    show(line({ steered: true, queuedAt: 0 }))
    const mark = [...host.querySelectorAll("span")].find((s) => s.textContent === "Steered")
    expect(mark).toBeDefined()
    expect(mark!.getAttribute("title")).toBe("Steered into the running turn: the agent read it at its next step")
    // Its sender's label stays.
    expect(host.textContent).toContain("Cody")
  })

  it("has no mark on a message a turn started with", () => {
    show(line({ queuedAt: 0 }))
    expect(host.textContent).not.toContain("Steered")
  })
})
