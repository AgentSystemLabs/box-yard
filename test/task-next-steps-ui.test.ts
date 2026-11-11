// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TaskThread } from "../web/src/components/TaskView.js"
import { keys } from "../web/src/lib/queries.js"
import type { TaskMessage } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let qc: QueryClient
const followUp = vi.fn()
const taskId = "task_steps001"
const msg = (id: string, role: TaskMessage["role"], nextSteps?: string[]): TaskMessage => ({
  id, taskId, role, content: `Reply ${id}`, createdAt: 1, meta: nextSteps ? { nextSteps } : null,
})
const old = msg("old", "assistant", ["An earlier suggestion"])
const latest = msg("latest", "assistant", ["Open the phone preview", "Start a follow-up task"])
const steps = () => [...host.querySelectorAll('[aria-label="Recommended next steps"] button')].map((b) => b.textContent)
const render = (id = taskId) => act(() => root.render(createElement(QueryClientProvider, { client: qc },
  createElement(TaskThread, { id, handle: null, working: null, selectionSource: null, selectionAsk: null, onFollowUp: followUp }),
)))
const update = (messages: TaskMessage[]) => act(async () => {
  qc.setQueryData(keys.taskMessages(taskId), messages)
  await new Promise((resolve) => setTimeout(resolve, 0))
})

beforeEach(() => {
  followUp.mockClear()
  localStorage.clear()
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  vi.stubGlobal("requestAnimationFrame", () => 0)
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const key of [keys.projects, keys.tasks, keys.schedules, keys.artifacts, keys.taskQueue(taskId)]) qc.setQueryData(key, [])
  qc.setQueryData(keys.taskMessages(taskId), [old, msg("question", "user"), latest])
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  qc.clear()
  host.remove()
  vi.unstubAllGlobals()
})

describe("task transcript suggestions", () => {
  it("offers only the latest reply's suggestions while keeping earlier replies readable", () => {
    render()
    expect(host.textContent).toContain("Reply old")
    expect(steps()).toEqual(["Open the phone preview", "Start a follow-up task"])
    expect(host.querySelectorAll('[aria-label="Recommended next steps"]')).toHaveLength(1)
  })

  it("does not revive older suggestions when the latest answer has none", async () => {
    render()
    await update([old, latest, msg("plain", "assistant")])
    expect(steps()).toEqual([])
    expect(host.textContent).toContain("Reply old")
    expect(host.textContent).toContain("Reply plain")
  })

  it("keeps the latest suggestions after user, tool and event messages", async () => {
    render()
    await update([old, latest, msg("followup", "user"), msg("tool", "tool"), msg("event", "event")])
    expect(steps()).toEqual(["Open the phone preview", "Start a follow-up task"])
  })

  it("hides tool details even when an older saved preference enabled them", async () => {
    localStorage.setItem("boxyard:show-tool-calls", "1")
    render()
    await update([old, msg("private-command", "tool"), latest])
    expect(host.textContent).toContain("Reply latest")
    expect(host.textContent).not.toContain("Reply private-command")
  })

  it("moves suggestions to a new reply as it arrives", async () => {
    render()
    await update([old, latest, msg("new", "assistant", ["Review the new answer"])])
    expect(steps()).toEqual(["Review the new answer"])
    expect(host.textContent).toContain("Reply latest")
  })

  it("uses the selected task's latest reply when switching transcripts", () => {
    render()
    qc.setQueryData(keys.taskQueue("task_other001"), [])
    qc.setQueryData(keys.taskMessages("task_other001"), [{ ...msg("other", "assistant", ["Review the other task"]), taskId: "task_other001" }])
    render("task_other001")
    expect(steps()).toEqual(["Review the other task"])
  })

  it("sends the chosen suggestion once without opening a composer", () => {
    render()
    const button = host.querySelector<HTMLButtonElement>('[aria-label="Recommended next steps"] button')!
    button.focus()
    act(() => button.click())
    expect(followUp).toHaveBeenCalledExactlyOnceWith("Open the phone preview")
    expect(document.activeElement).toBe(button)
  })
})
