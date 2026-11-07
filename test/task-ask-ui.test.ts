// @vitest-environment happy-dom
// The task panel asks the Coordinator about its task on the side: the box's "Side question" swaps the transcript for
// the task's own side thread (kind "task"), which the agent never sees, and the header's one Back (or Esc) returns.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TaskSession } from "../web/src/components/TaskSession.js"
import { Modal } from "../web/src/components/Modal.js"
import { keys } from "../web/src/lib/queries.js"
import { COORDINATOR_CHAT, closeThread, openThreadId, threadKeys } from "../web/src/lib/threads.js"
import type { Project, SideThread, SideThreadMessage, Task, TaskMessage } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const taskId = "task_ask000001"
const now = Date.now()
const project = { id: "prj_ask001", name: "marketing-site", repo: "o/marketing-site", description: "", notes: [], envKeys: [], createdAt: now, color: null } as unknown as Project
const task = {
  id: taskId,
  projectId: project.id,
  title: "Refresh the portfolio introduction",
  status: "working",
  prompt: "",
  prUrl: null,
  prState: null,
  prMergedAt: null,
  previews: [],
  waitFor: [],
  question: null,
  error: null,
  scheduleId: null,
  outcome: null,
  pendingCount: 0,
  createdAt: now - 60_000,
  updatedAt: now - 60_000,
} as unknown as Task
const transcript: TaskMessage[] = [{ id: "tm_1", taskId, role: "assistant", content: "Rewriting the opening paragraph.", meta: null, createdAt: 2 }]
const thread = (patch: Partial<SideThread> = {}): SideThread => ({
  id: "thr_task01",
  projectId: null,
  anchorId: taskId,
  kind: "task",
  quote: task.title,
  context: null,
  busy: false,
  replies: 2,
  unread: false,
  resolvedAt: null,
  createdAt: 3,
  updatedAt: 4,
  ...patch,
})
const answer = (content: string): SideThreadMessage => ({ id: `thm_${content.length}`, threadId: "thr_task01", role: "assistant", content, meta: null, createdAt: 5 })

let root: Root
let host: HTMLElement
let qc: QueryClient
let calls: { url: string; method: string; body: Record<string, unknown> | null }[]

beforeEach(() => {
  calls = []
  // A wide window: the header's Back is the panel's way out (on a phone, the crumbs take its place: tree-nav-ui.test.ts).
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("min-width"), media: q, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal("requestAnimationFrame", () => 0)
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    if (method === "GET") return new Promise(() => {})
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    calls.push({ url, method, body })
    if (url === "/api/threads") {
      const t = thread({ id: String(body!.id), busy: true, replies: 1 })
      const m: SideThreadMessage = { id: String(body!.messageId), threadId: t.id, role: "user", content: String(body!.question), meta: null, createdAt: 6 }
      return new Response(JSON.stringify({ thread: t, message: m }), { status: 201 })
    }
    if (/^\/api\/threads\/[^/]+\/messages$/.test(url)) {
      const m: SideThreadMessage = { id: String(body!.id), threadId: url.split("/")[3]!, role: "user", content: String(body!.content), meta: null, createdAt: 7 }
      return new Response(JSON.stringify(m), { status: 201 })
    }
    return new Response("{}", { status: 200 })
  })
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(keys.tasks, [task])
  qc.setQueryData(keys.projects, [project])
  for (const key of [keys.artifacts, keys.schedules, keys.taskQueue(taskId)]) qc.setQueryData(key, [])
  qc.setQueryData(keys.taskMessages(taskId), transcript)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  qc.clear()
  host.remove()
  closeThread(COORDINATOR_CHAT)
  vi.unstubAllGlobals()
})

function render(threads: SideThread[] = [], messages: SideThreadMessage[] = [], onClose: () => void = () => {}) {
  qc.setQueryData(threadKeys.list(COORDINATOR_CHAT), threads)
  for (const t of threads) qc.setQueryData(threadKeys.messages(t.id), messages)
  // In the panel slot, as OverlayHost mounts it: the side questions are a level inside that Modal.
  const session = createElement(TaskSession, { id: taskId, onClose, scrollKey: "test" })
  const panel = createElement(Modal, { label: task.title, placement: "panel", onClose }, session)
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, panel)))
}

/** The header's Back: the one way out of the panel, or out of its side questions. */
const back = () => host.querySelector<HTMLButtonElement>('[data-testid="task-header"] [data-dismiss="back"]')!
const esc = () => act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })))
const textarea = () => host.querySelector("textarea")!
function type(text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
  act(() => {
    set.call(textarea(), text)
    textarea().dispatchEvent(new Event("input", { bubbles: true }))
  })
}
/**
 * A click as the browser dispatches it, outside act: when it returns, only what React did inside the handler has
 * happened. iOS brings up the keyboard only for a focus() inside the tap itself.
 */
function tap(el: HTMLElement) {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  env.IS_REACT_ACT_ENVIRONMENT = false
  try {
    el.click()
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = true
  }
}
/** Lets the mutation's optimistic update and the stubbed response land. */
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))))
const submit = async () => {
  act(() => void textarea().closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
  await settle()
}

describe("a task's side questions in the task panel", () => {
  it("swaps the transcript for the side questions and back, and the box asks instead of messaging the agent", () => {
    render()
    const toggle = q("task-ask-toggle")!
    expect(toggle.textContent).toBe("Side question")
    expect(toggle.getAttribute("aria-pressed")).toBe("false")
    expect(host.textContent).toContain("Rewriting the opening paragraph.")
    expect(host.querySelector('[title="Attach files"]')).not.toBeNull()

    click(toggle)
    expect(toggle.getAttribute("aria-pressed")).toBe("true")
    expect(q("task-ask")).not.toBeNull()
    expect(host.textContent).not.toContain("Rewriting the opening paragraph.")
    expect(q("task-ask-intro")!.textContent).toContain("the agent doesn't see your questions")
    expect([...q("task-ask-intro")!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Where is it up to?", "What's left before it's done?", "Is anything blocking it?"])
    expect(textarea().placeholder).toBe("Ask about this task…")
    expect(q("task-ask-note")!.textContent).toBe("To the Coordinator, aside. The agent doesn't see it.")
    // Side threads are text only.
    expect(host.querySelector('[title="Attach files"]')).toBeNull()

    // One Back, now leading to the transcript; nothing in the view adds a second.
    expect(host.querySelectorAll('[data-dismiss]')).toHaveLength(1)
    expect(back().getAttribute("aria-label")).toBe("Back to the task")
    click(back())
    expect(q("task-ask")).toBeNull()
    expect(back().getAttribute("aria-label")).toBe("Back")
    expect(toggle.getAttribute("aria-pressed")).toBe("false")
    expect(host.textContent).toContain("Rewriting the opening paragraph.")
    expect(textarea().placeholder).not.toBe("Ask about this task…")
  })

  it("the Side question button puts the caret in the box inside the press, ready to type; the panel opening doesn't", async () => {
    render()
    expect(document.activeElement).not.toBe(textarea())

    tap(q("task-ask-toggle")!)
    expect(document.activeElement).toBe(textarea())
    await settle()
    expect(q("task-ask")).not.toBeNull()
    expect(textarea().placeholder).toBe("Ask about this task…")
    expect(document.activeElement).toBe(textarea())

    // Turning it off leaves the focus where it is.
    act(() => q("task-ask-toggle")!.focus())
    click(q("task-ask-toggle")!)
    expect(q("task-ask")).toBeNull()
    expect(document.activeElement).toBe(q("task-ask-toggle"))
  })

  it("Esc and Back leave the side questions first, and only then the panel", () => {
    const onClose = vi.fn()
    render([], [], onClose)
    click(q("task-ask-toggle")!)
    esc()
    expect(q("task-ask")).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    esc()
    expect(onClose).toHaveBeenCalledTimes(1)

    click(q("task-ask-toggle")!)
    click(back())
    expect(q("task-ask")).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
    click(back())
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it("starts the task's thread with the first question, without opening the Coordinator's side panel", async () => {
    render()
    click(q("task-ask-toggle")!)
    type("Why a serif font?")
    await submit()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ url: "/api/threads", method: "POST", body: { kind: "task", anchorId: taskId, projectId: null, question: "Why a serif font?" } })
    expect(openThreadId(COORDINATOR_CHAT)).toBeNull()
    expect(q("task-ask")!.textContent).toContain("Why a serif font?")
    expect(q("task-ask-intro")).toBeNull()
  })

  it("a starter question asks it as if typed", async () => {
    render()
    click(q("task-ask-toggle")!)
    click(q("task-ask-intro")!.querySelector("button")!)
    await settle()
    expect(calls[0]).toMatchObject({ url: "/api/threads", body: { kind: "task", anchorId: taskId, question: "Where is it up to?" } })
  })

  it("goes on in the thread the task has, and marks its answers read once shown", async () => {
    render([thread({ unread: true })], [answer("It's rewriting the opening paragraph.")])
    expect(q("task-ask-dot")!.getAttribute("aria-label")).toBe("A new answer")

    click(q("task-ask-toggle")!)
    expect(q("task-ask-dot")).toBeNull()
    expect(q("task-ask")!.textContent).toContain("It's rewriting the opening paragraph.")
    expect(calls).toContainEqual({ url: "/api/threads/thr_task01/seen", method: "POST", body: {} })

    type("And the headline?")
    await submit()
    expect(calls.at(-1)).toMatchObject({ url: "/api/threads/thr_task01/messages", method: "POST", body: { content: "And the headline?" } })
    expect(calls.some((c) => c.url === "/api/threads")).toBe(false)
  })

  it("says an answer is on its way while the box is on the task", () => {
    render([thread({ busy: true })])
    expect(q("task-ask-dot")!.getAttribute("aria-label")).toBe("An answer is on its way")
  })
})
