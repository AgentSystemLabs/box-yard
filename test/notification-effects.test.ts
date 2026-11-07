// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, Fragment } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TASK_STATUSES, type AppNotification, type Task } from "../shared/types.js"
import { NotificationEffects } from "../web/src/components/NotificationEffects.js"
import { SidebarMenuButton } from "../web/src/components/Sidebar.js"
import { deferClose, undoClose } from "../web/src/lib/inbox.js"
import { keys, patchTask } from "../web/src/lib/queries.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const task = (id: string, status: Task["status"], extra: Partial<Task> = {}) =>
  ({ id, projectId: "prj_example", title: id, status, scheduleId: null, outcome: null, prUrl: null, previews: [], error: null, question: null, ...extra }) as Task
const notification = (id: string): AppNotification => ({
  id, taskId: "task_finished", projectId: "prj_example", title: "Finished task", projectName: "Example",
  status: "done", summary: null, createdAt: 1, readAt: null,
})

let root: Root
let host: HTMLElement
let qc: QueryClient

beforeEach(() => {
  history.replaceState(null, "", "/")
  document.title = "Box Yard"
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.notifications, [])
})

afterEach(() => {
  act(() => root.unmount())
  qc.clear()
  host.remove()
  document.title = ""
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function render(tasks?: Task[]) {
  if (tasks) qc.setQueryData(keys.tasks, tasks)
  act(() => root.render(createElement(QueryClientProvider, { client: qc },
    createElement(Fragment, null, createElement(NotificationEffects), createElement(SidebarMenuButton)),
  )))
}

function expectCount(count: number) {
  expect(document.title).toBe(count ? `(${count}) Box Yard` : "Box Yard")
  expect(host.querySelector("button")!.getAttribute("aria-label")).toBe(
    count ? `Projects and tasks, ${count} waiting on you` : "Projects and tasks",
  )
}

// React Query notifies observers on a timer, just as after an SSE cache update.
async function update(change: () => void) {
  await act(async () => {
    change()
    await new Promise((r) => setTimeout(r, 20))
  })
}

describe("Waiting on you in the browser title", () => {
  it("counts tasks needing input, failed or PR-ready across projects, independently of unread history", async () => {
    qc.setQueryData(keys.notifications, Array.from({ length: 44 }, (_, i) => notification(`note_${i}`)))
    render(TASK_STATUSES.map((status, i) => task(`task_${status}`, status, { projectId: `prj_example${i}` })))
    expectCount(3)

    await update(() => qc.setQueryData<AppNotification[]>(keys.notifications, (list) => list!.map((n) => ({ ...n, readAt: 2 }))))
    expectCount(3)
  })

  it("follows live task statuses in a background tab and drops the prefix when nothing waits", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
    render([task("task_live", "working")])
    expectCount(0)

    for (const status of ["needs_input", "failed", "pr_ready"] as const) {
      await update(() => patchTask(qc, "task_live", { status }))
      expectCount(1)
      await update(() => patchTask(qc, "task_live", { status: "working" }))
      expectCount(0)
    }
    await update(() => patchTask(qc, "task_live", { status: "pr_ready" }))
    expectCount(1)
    await update(() => patchTask(qc, "task_live", { status: "done" }))
    expectCount(0)
  })

  it("tracks Mark done and Undo immediately, before a close reaches the server", () => {
    render([task("task_close", "needs_input")])
    expectCount(1)
    const commit = vi.fn(async () => {})
    try {
      act(() => { deferClose("task_close", commit) })
      expectCount(0)
      expect(commit).not.toHaveBeenCalled()
      act(() => { undoClose("task_close") })
      expectCount(1)
    } finally {
      act(() => { undoClose("task_close") })
    }
  })

  it("keeps the app name while loading and counts the full list beyond the sidebar's row cap", async () => {
    render()
    expectCount(0)
    await update(() => qc.setQueryData(keys.tasks, Array.from({ length: 8 }, (_, i) => task(`task_ask${i}`, "needs_input"))))
    expectCount(8)
    await update(() => qc.setQueryData(keys.tasks, []))
    expectCount(0)
  })
})
