// @vitest-environment happy-dom
// Mark done stops a task's running sub-tasks, at any depth, and marks its whole tree done (server: closeTask). So it
// asks first when any of them runs (lib/markDone.ts): how many, which (a few, then how many more), Cancel in the focus
// and a red "Stop and mark done". With none running it's done at once, as before; Cancel changes nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, Fragment } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TaskHeader } from "../web/src/components/TaskHeader.js"
import { ConfirmHost } from "../web/src/components/ConfirmDialog.js"
import { LISTED_SUBTASKS, markDoneConfirm, runningSubtasks } from "../web/src/lib/markDone.js"
import { keys } from "../web/src/lib/queries.js"
import { currentConfirm, settleConfirm } from "../web/src/lib/confirm.js"
import { undoClose } from "../web/src/lib/inbox.js"
import { resetClosedTasks } from "../web/src/lib/closedTasks.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import type { Project, Task, TaskStatus } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project: Project = { id: "prj_menu01", name: "menu", description: "", repo: null, baseBranch: "main", envKeys: [], notes: [], boxSize: null, createdAt: 0, updatedAt: 0 }
const now = Date.now()

function task(id: string, title: string, status: TaskStatus, parent?: Task): Task {
  return {
    id,
    projectId: project.id,
    title,
    prompt: "",
    status,
    boxId: null,
    sessionId: null,
    branch: null,
    prUrl: null,
    prState: null,
    prMergedAt: null,
    prMergedBy: null,
    previews: [],
    question: null,
    summary: null,
    error: null,
    waitReason: null,
    turnCount: 1,
    pendingCount: 0,
    lastArchivedAt: null,
    scheduleId: null,
    outcome: null,
    contextTokens: null,
    contextWindow: null,
    compactPending: false,
    compacting: false,
    model: null,
    effort: null,
    claudeCostUsd: 0,
    claudeTokens: 0,
    routingRule: null,
    routingReason: null,
    mergeRequest: null,
    parentTaskId: parent?.id ?? null,
    rootTaskId: parent ? (parent.rootTaskId ?? parent.id) : null,
    subtaskDepth: parent ? (parent.subtaskDepth ?? 0) + 1 : 0,
    createdAt: now,
    updatedAt: now,
  } as Task
}

const ROOT = task("task_root000001", "Plan the menu", "idle")
const STARTERS = task("task_starters01", "Starters", "idle", ROOT)
const SOUPS = task("task_soups00001", "Soups", "working", STARTERS)
const MAINS = task("task_mains00001", "Mains", "queued", ROOT)
const SIDES = task("task_sides00001", "Sides", "done", ROOT)
const SALAD = task("task_salad00001", "Salad", "starting", SIDES)
const OTHER = task("task_other00001", "Plan the drinks", "working")
const WINE = task("task_wine000001", "Wine", "working", OTHER)

describe("runningSubtasks and markDoneConfirm", () => {
  it("finds every running, queued or starting sub-task at any depth, under open or done ones, nearest first", () => {
    const all = [ROOT, STARTERS, SOUPS, MAINS, SIDES, SALAD, OTHER, WINE]
    expect(runningSubtasks(ROOT.id, all).map((t) => t.title)).toEqual(["Mains", "Soups", "Salad"])
    expect(runningSubtasks(STARTERS.id, all).map((t) => t.title)).toEqual(["Soups"])
    // Not another tree's, and not the task itself.
    expect(runningSubtasks(OTHER.id, all).map((t) => t.title)).toEqual(["Wine"])
    // A chain the list cuts (a parent it doesn't have) still counts under its own tree's top.
    expect(runningSubtasks(ROOT.id, [ROOT, SOUPS]).map((t) => t.title)).toEqual(["Soups"])
    expect(runningSubtasks(STARTERS.id, [STARTERS, SALAD])).toEqual([])
  })

  it("asks nothing when nothing would stop: resting sub-tasks are just marked done with it", () => {
    const resting = (["idle", "pr_ready", "needs_input", "failed", "done", "waiting"] as const).map((s, i) => task(`task_rest0000${i}`, s, s, ROOT))
    expect(markDoneConfirm(ROOT, [ROOT, ...resting])).toBeNull()
    expect(markDoneConfirm(ROOT, [ROOT])).toBeNull()
  })

  it("names how many sub-tasks run and which, warns they stop and the whole tree is marked done, with Cancel in the focus", () => {
    const ask = markDoneConfirm(ROOT, [ROOT, STARTERS, SOUPS, MAINS, SIDES, SALAD])!
    expect(ask).toMatchObject({ title: "Stop its 3 running sub-tasks?", confirmLabel: "Stop and mark done", danger: true, cancelFocus: true })
    expect(ask.body).toBe("Plan the menu has 3 sub-tasks still running. Mark done stops them, and marks the task and every sub-task under it done.")
    expect(ask.tasks!.shown.map((t) => t.title)).toEqual(["Mains", "Soups", "Salad"])
    expect(ask.tasks!.more).toBe(0)

    const one = markDoneConfirm(ROOT, [ROOT, STARTERS, SOUPS])!
    expect(one.title).toBe("Stop its running sub-task?")
    expect(one.body).toBe("Plan the menu has a sub-task still running. Mark done stops it, and marks the task and every sub-task under it done.")
    // Its own agent runs too: it says so.
    const both = markDoneConfirm({ ...ROOT, status: "working" }, [ROOT, STARTERS, SOUPS, MAINS])!
    expect(both.title).toBe("Stop it and its sub-tasks?")
    expect(both.body).toBe("Plan the menu is running, and so are 2 of its sub-tasks. Mark done stops them all, and marks the task and every sub-task under it done.")
    // Only its own agent: the confirm it always had, now with Cancel in the focus.
    expect(markDoneConfirm({ ...ROOT, status: "queued" }, [ROOT, STARTERS])).toMatchObject({ title: "Stop it and mark it done?", body: "Plan the menu is queued. Mark done stops it and closes it.", cancelFocus: true })
  })

  it("lists a few by name and says how many more", () => {
    const kids = (n: number) => Array.from({ length: n }, (_, i) => task(`task_kid0000${String(i).padStart(2, "0")}`, `Course ${i + 1}`, "working", ROOT))
    const at = (n: number) => markDoneConfirm(ROOT, [ROOT, ...kids(n)])!.tasks!
    expect(at(LISTED_SUBTASKS).shown).toHaveLength(LISTED_SUBTASKS)
    expect(at(LISTED_SUBTASKS).more).toBe(0)
    // Never "and 1 more" in place of a name: past the limit, one line goes to the count.
    expect(at(LISTED_SUBTASKS + 1).shown).toHaveLength(LISTED_SUBTASKS - 1)
    expect(at(LISTED_SUBTASKS + 1).more).toBe(2)
    expect(at(12).shown.map((t) => t.title)).toEqual(["Course 1", "Course 2", "Course 3", "Course 4"])
    expect(at(12).more).toBe(8)
    expect(markDoneConfirm(ROOT, [ROOT, ...kids(12)])!.title).toBe("Stop its 12 running sub-tasks?")
  })
})

describe("Mark done in the task header, with sub-tasks", () => {
  let root: Root
  let host: HTMLElement
  let qc: QueryClient
  let posts: string[]
  const markDone = () => document.querySelector<HTMLButtonElement>('[data-testid="task-mark-done"]')!
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
  const buttonIn = (el: HTMLElement, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === text)!
  const cached = (id: string) => qc.getQueryData<Task[]>(keys.tasks)!.find((t) => t.id === id)!
  const render = (tasks: Task[]) => {
    qc.setQueryData(keys.tasks, tasks)
    act(() =>
      root.render(createElement(QueryClientProvider, { client: qc }, createElement(Fragment, null, createElement(TaskHeader, { task: tasks[0]!, project, schedule: null, files: [] }), createElement(ConfirmHost)))),
    )
  }

  beforeEach(() => {
    localStorage.clear()
    qc = new QueryClient()
    posts = []
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push(url)
      return new Promise(() => {})
    })
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => {
      undoClose(ROOT.id)
      for (const t of currentToasts()) dismiss(t.id)
      const open = currentConfirm()
      if (open) settleConfirm(open.id, false)
    })
    act(() => root.unmount())
    host.remove()
    resetClosedTasks()
    vi.unstubAllGlobals()
  })

  it("is done at once when no sub-task runs, as before", async () => {
    render([ROOT, STARTERS, { ...SOUPS, status: "pr_ready" }])
    await act(async () => void markDone().click())
    expect(currentConfirm()).toBeUndefined()
    expect(dialog()).toBeNull()
    expect(cached(ROOT.id).status).toBe("done")
    expect(currentToasts().map((t) => [t.title, t.action?.label])).toEqual([["Marked done", "Undo"]])
    expect(posts).toEqual([])
  })

  it("asks first when one runs, naming them; Cancel (in the focus) changes nothing", async () => {
    render([ROOT, STARTERS, SOUPS, MAINS, SIDES, SALAD])
    await act(async () => void markDone().click())
    const open = dialog()!
    expect(open.querySelector("h2")!.textContent).toBe("Stop its 3 running sub-tasks?")
    expect(open.textContent).toContain("Mark done stops them, and marks the task and every sub-task under it done.")
    const listed = [...open.querySelectorAll("[data-testid=confirm-tasks] li")]
    expect(listed.map((li) => li.textContent)).toEqual(["Mains", "Soups", "Salad"])
    // Each with its state's icon, named for a screen reader; titles cut to their line keep the whole one as a tooltip.
    expect(listed.map((li) => li.querySelector("[data-testid=task-status-icon]")!.getAttribute("aria-label"))).toEqual(["Queued", "Working", "Starting"])
    expect(listed[1]!.querySelector("span.truncate")!.getAttribute("title")).toBe("Soups")
    expect(document.activeElement).toBe(buttonIn(open, "Cancel"))
    expect(buttonIn(open, "Stop and mark done").className).toContain("text-red-300")

    await act(async () => void buttonIn(open, "Cancel").click())
    expect(dialog()).toBeNull()
    expect([ROOT, SOUPS, MAINS].map((t) => cached(t.id).status)).toEqual(["idle", "working", "queued"])
    expect(currentToasts()).toEqual([])
    expect(posts).toEqual([])
    // Esc, or the ×, is a Cancel too.
    await act(async () => void markDone().click())
    await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    expect(dialog()).toBeNull()
    expect(cached(ROOT.id).status).toBe("idle")
    expect(posts).toEqual([])
  })

  it("Stop and mark done marks it done, with Undo, and sends the close once the undo window is over", async () => {
    render([ROOT, STARTERS, SOUPS])
    await act(async () => void markDone().click())
    await act(async () => void buttonIn(dialog()!, "Stop and mark done").click())
    expect(dialog()).toBeNull()
    expect(cached(ROOT.id).status).toBe("done")
    expect(currentToasts().map((t) => [t.title, t.action?.label])).toEqual([["Marked done", "Undo"]])
    // The server stops and closes the sub-tasks when the close goes out (TaskManager.closeTask), not before.
    expect(posts).toEqual([])
    expect(cached(SOUPS.id).status).toBe("working")
  })
})
