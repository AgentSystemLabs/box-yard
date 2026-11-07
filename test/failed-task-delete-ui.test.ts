// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Task } from "../shared/types"
import { ConfirmHost } from "../web/src/components/ConfirmDialog"
import { DeleteFailedTaskButton } from "../web/src/components/DeleteFailedTaskButton"
import { keys } from "../web/src/lib/queries"
import { currentConfirm, settleConfirm } from "../web/src/lib/confirm"
import { resetColumns } from "../web/src/lib/columns"
import { currentToasts, dismiss } from "../web/src/lib/toast"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const failed = { id: "task_example1", projectId: "prj_example1", title: "Example failed task", status: "failed", pendingCount: 5 } as Task
const child = { ...failed, id: "task_example2", title: "Example child", status: "idle", pendingCount: 0, parentTaskId: failed.id } as Task
let root: Root
let host: HTMLElement
let qc: QueryClient
let fetchMock: ReturnType<typeof vi.fn>
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 25)) })
const click = () => act(() => host.querySelector<HTMLButtonElement>('[data-delete-task]')!.click())
const answer = async (ok: boolean) => {
  await act(async () => settleConfirm(currentConfirm()!.id, ok))
  await flush()
}
function render(tasks = [failed, child]) {
  qc.setQueryData(keys.tasks, tasks)
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Fragment, null,
    createElement(DeleteFailedTaskButton, { task: failed }), createElement(ConfirmHost)))))
}
const deletes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")
beforeEach(() => {
  history.replaceState(null, "", `/?session=${failed.id}`)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } } })
  fetchMock = vi.fn(() => new Promise(() => {}))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(async () => {
  if (currentConfirm()) await answer(false)
  act(() => root.unmount())
  host.remove()
  qc.clear()
  act(() => resetColumns())
  for (const t of currentToasts()) dismiss(t.id)
  vi.unstubAllGlobals()
})

describe("failed-task header deletion safeguards", () => {
  it("Escape cancels confirmation and repeated clicks cannot queue another", async () => {
    render()
    click()
    const id = currentConfirm()!.id
    click()
    expect(currentConfirm()!.id).toBe(id)
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    act(() => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })) })
    await flush()
    expect(currentConfirm()).toBeUndefined()
    expect(deletes()).toEqual([])
    expect(qc.getQueryData(keys.tasks)).toEqual([failed, child])
  })

  it("keeps late queued messages and asks for fresh consent", async () => {
    render()
    click()
    act(() => qc.setQueryData(keys.tasks, [{ ...failed, pendingCount: 6 }, child]))
    await answer(true)
    expect(currentConfirm()?.body).toBe("Queued messages changed. Review them and confirm deletion again.")
    expect(deletes()).toEqual([])
  })

  it.each(["working", "done"] as const)("blocks an active %s descendant with visible guidance", (status) => {
    render([failed, { ...child, status, turnStartedAt: 123 }])
    click()
    expect(currentConfirm()).toMatchObject({ title: "Can't delete task", body: "Stop queued or running tasks before deleting." })
    expect(deletes()).toEqual([])
  })

  it("rechecks work started during confirmation", async () => {
    render()
    click()
    act(() => qc.setQueryData(keys.tasks, [failed, { ...child, status: "working" }]))
    await answer(true)
    expect(currentConfirm()?.body).toBe("Stop queued or running tasks before deleting.")
    expect(deletes()).toEqual([])
  })

  it("removes a confirmed subtree and closes its current child after success", async () => {
    render()
    history.replaceState(null, "", `/?session=${child.id}`)
    fetchMock.mockImplementation(async () => new Response('{"ok":true}', { status: 200 }))
    click()
    expect(currentConfirm()?.body).toContain("1 sub-task, their workspaces and archives")
    await answer(true)
    expect(deletes()).toEqual([[`/api/tasks/${failed.id}?ifResting=1&discardQueued=5`, expect.objectContaining({ method: "DELETE" })]])
    expect(qc.getQueryData(keys.tasks)).toEqual([])
    expect(new URLSearchParams(location.search).get("session")).toBeNull()
  })

  it("restores rows and keeps the current task when the server blocks deletion", async () => {
    render()
    fetchMock.mockImplementation(async () => new Response('{"error":"Stop the active turn, then try again."}', { status: 409 }))
    click()
    await answer(true)
    expect(qc.getQueryData(keys.tasks)).toEqual([failed, child])
    expect(new URLSearchParams(location.search).get("session")).toBe(failed.id)
    expect(currentConfirm()).toMatchObject({ title: "Can't delete task", body: "Stop the active turn, then try again." })
  })
})
