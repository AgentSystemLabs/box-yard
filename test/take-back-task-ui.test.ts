// @vitest-environment happy-dom
// Taking back a message sent to a task's agent: Stop in the box ends the turn that's running, and Cancel on a queued
// message (one waiting for the agent's next turn, or for a slot) puts its text back in the box to edit.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TaskComposer } from "../web/src/components/CaptainForward.js"
import { TaskQueue } from "../web/src/components/QueuedMessages.js"
import { keys } from "../web/src/lib/queries.js"
import { currentToasts as toasts, dismiss } from "../web/src/lib/toast.js"
import type { Project, QueuedMessage, Task } from "../shared/types.js"
import { resetDrafts } from "../web/src/lib/composerDraft.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TASK = "task_takeback1"
const project = { id: "prj_demo01", name: "demo" } as Project
const task = (patch: Partial<Task> = {}) =>
  ({ id: TASK, projectId: project.id, title: "Login form", status: "working", pendingCount: 1, queueRev: "1.1.0.1", turnStartedAt: 1000, prUrl: null, ...patch }) as Task
const queued = (text: string, extra: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id: "in_takeback1",
  taskId: TASK,
  source: "cody",
  kind: "owner",
  sender: "Cody",
  text,
  attachments: [],
  status: "queued",
  version: 1,
  createdAt: 1,
  updatedAt: 0,
  ...extra,
})

let root: Root
let host: HTMLElement
let qc: QueryClient
let server: QueuedMessage[]
let calls: { method: string; url: string }[]
/** The DELETE's answer: 200, or 409 when a turn took the message first. */
let deleteStatus = 200

const json = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }))

beforeEach(() => {
  localStorage.clear()
  resetDrafts()
  for (const t of toasts()) dismiss(t.id)
  server = [queued("use the blue button")]
  calls = []
  deleteStatus = 200
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q }))
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    calls.push({ method, url })
    if (url === `/api/tasks/${TASK}/stop`) return json(task({ status: "idle", turnStartedAt: null }))
    const m = url.match(/^\/api\/tasks\/[^/]+\/queue(?:\/([^/]+))?(\/restore)?$/)
    if (!m) return new Promise(() => {})
    if (method === "GET") return json(server)
    if (method === "DELETE") {
      if (deleteStatus !== 200) return json({ error: "That message was already delivered to the agent (or the task was stopped), so it can't be changed." }, deleteStatus)
      const found = server.find((x) => x.id === m[1])
      server = server.filter((x) => x !== found)
      return json(found)
    }
    return json(server[0] ?? queued("use the blue button"))
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

/** The task page's thread: its Queued rows, then its box, in one panel. */
function render(t: Task, o: { asking?: boolean } = {}) {
  qc.setQueryData(keys.tasks, [t])
  const panel = createRef<HTMLElement>()
  const ask = o.asking ? { on: true, busy: false, unread: false, toggle: () => {}, submit: async () => {} } : undefined
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement("section", { ref: panel }, createElement(TaskQueue, { taskId: TASK }), createElement(TaskComposer, { task: t, project, panelRef: panel, onSubmit: async () => {}, ask })),
      ),
    ),
  )
}
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))))
const box = () => host.querySelector<HTMLTextAreaElement>('textarea:not([aria-label="Queued message"])')!
const byLabel = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const byText = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!
const click = async (el: Element | null) => {
  expect(el).toBeTruthy()
  act(() => (el as HTMLElement).click())
  await settle()
}
function type(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box(), text)
    box().dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("Task chat: Stop in the box", () => {
  it("shows Stop before Send while the agent's turn runs, and Stop ends it at once", async () => {
    render(task())
    const stop = byLabel("Stop the agent's turn")!
    expect(stop).not.toBeNull()
    // Right before Send, a 44px target.
    expect(stop.nextElementSibling?.getAttribute("aria-label")).toBe("Send")
    expect(stop.className).toContain("h-11 w-11")
    await click(stop)
    expect(calls).toContainEqual({ method: "POST", url: `/api/tasks/${TASK}/stop` })
    // The click's result shows at once: the task rests (PR #304's optimistic Stop), so the box has no Stop.
    const now = qc.getQueryData<Task[]>(keys.tasks)!.find((t) => t.id === TASK)!
    expect(now.status).toBe("idle")
    render(now)
    expect(byLabel("Stop the agent's turn")).toBeNull()
  })

  it("has no Stop while the task rests, waits for a slot, or the box asks the Coordinator aside", () => {
    for (const status of ["idle", "needs_input", "pr_ready", "queued"] as const) {
      render(task({ status }))
      expect(byLabel("Stop the agent's turn")).toBeNull()
    }
    render(task(), { asking: true })
    expect(byLabel("Stop the agent's turn")).toBeNull()
  })
})

describe("Task chat: Cancel a queued message", () => {
  it("puts its text back in the box, ahead of the draft; Undo queues it again and takes it out", async () => {
    render(task())
    await settle()
    type("and the footer")
    await click(byLabel("Cancel queued message"))
    expect(calls).toContainEqual({ method: "DELETE", url: `/api/tasks/${TASK}/queue/in_takeback1` })
    expect(box().value).toBe("use the blue button\n\nand the footer")
    expect(document.activeElement).toBe(box())
    expect(box().selectionStart).toBe("use the blue button".length)
    expect(host.querySelector("[data-testid=queued-message]")).toBeNull()
    expect(host.querySelector("[data-testid=queued-deleted]")!.textContent).toContain("Cancelled · back in the message box")

    server = [queued("use the blue button")]
    await click(byText("Undo"))
    expect(calls).toContainEqual({ method: "POST", url: `/api/tasks/${TASK}/queue/in_takeback1/restore` })
    expect(box().value).toBe("and the footer")
    expect(host.querySelectorAll("[data-testid=queued-message]")).toHaveLength(1)
  })

  it("takes back a message waiting for a slot (the task hasn't started it) the same way", async () => {
    render(task({ status: "queued" }))
    await settle()
    await click(byLabel("Cancel queued message"))
    expect(box().value).toBe("use the blue button")
    expect(calls.some((c) => c.method === "DELETE")).toBe(true)
  })

  it("Undo leaves the box alone once it was edited", async () => {
    render(task())
    await settle()
    await click(byLabel("Cancel queued message"))
    type("use the green button")
    server = [queued("use the blue button")]
    await click(byText("Undo"))
    expect(box().value).toBe("use the green button")
  })

  it("a cancel the server refuses (already delivered) keeps the message queued and takes the text out of the box", async () => {
    deleteStatus = 409
    render(task())
    await settle()
    type("draft")
    await click(byLabel("Cancel queued message"))
    await settle()
    expect(box().value).toBe("draft")
    expect(toasts().find((t) => t.title === "Couldn't cancel the message")?.body).toMatch(/already delivered/)
    expect(host.querySelector("[data-testid=queued-deleted]")).toBeNull()
  })
})
