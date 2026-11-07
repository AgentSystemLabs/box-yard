// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Project, Task } from "../shared/types"
import { ConfirmHost } from "../web/src/components/ConfirmDialog"
import { Sidebar } from "../web/src/components/Sidebar"
import { keys } from "../web/src/lib/queries"
import { currentConfirm, settleConfirm } from "../web/src/lib/confirm"
import { captainKey, taskKey, setTreeFolds, unfoldSidebarGroup } from "../web/src/lib/sidebar"
import { chatProjectFilter, setChatProjectFilter } from "../web/src/lib/projectBar"
import { resetColumns } from "../web/src/lib/columns"
import { currentToasts, dismiss } from "../web/src/lib/toast"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const project = { id: "prj_example", name: "Example project", repo: null, notes: [], color: null } as unknown as Project
const other = { ...project, id: "prj_other01", name: "Other project" }
const task = (id: string, title: string, extra: Partial<Task> = {}) => ({
  id, title, projectId: project.id, status: "idle", parentTaskId: null, prUrl: null, previews: [], waitFor: [],
  createdAt: 1, updatedAt: 1, turnStartedAt: null, ...extra,
}) as Task
const parent = task("task_parent1", "Example parent")
const child = task("task_child01", "Example child", { parentTaskId: parent.id })
const sibling = task("task_sibling", "Example sibling")
let root: Root
let host: HTMLElement
let qc: QueryClient
let fetchMock: ReturnType<typeof vi.fn>
const row = (key: string) => host.querySelector<HTMLElement>(`[data-tree-key="${key}"]`)!
const taskRow = (t: Task) => row(taskKey(t.id, "project"))
const openButton = (el: HTMLElement) => el.querySelector<HTMLElement>("[data-tree-open]")!
const action = (el: HTMLElement) => el.querySelector<HTMLButtonElement>("[data-sidebar-delete]")!
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 25)) })
function pointer(el: Element, type: string, x: number, y: number, init: PointerEventInit = {}) {
  const e = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, clientX: x, clientY: y, ...init })
  act(() => { el.dispatchEvent(e) })
  return e
}
function swipe(el: HTMLElement, dx = -70, dy = 0, type = "touch") {
  const button = openButton(el)
  pointer(button, "pointerdown", 200, 100, { pointerType: type })
  pointer(button, "pointermove", 200 + dx, 100 + dy, { pointerType: type })
  pointer(button, "pointerup", 200 + dx, 100 + dy, { pointerType: type })
}
function click(el: Element, detail = 1) {
  const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail })
  act(() => { el.dispatchEvent(e) })
  return e
}
function key(el: HTMLElement, name: string, shiftKey = false) {
  const e = new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true })
  act(() => { el.dispatchEvent(e) })
  return e
}
function render(tasks = [parent, child, sibling]) {
  qc.setQueryData(keys.tasks, tasks)
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Fragment, null, createElement(Sidebar), createElement(ConfirmHost)))))
}
function answer(ok: boolean) {
  const confirm = currentConfirm()!
  expect(confirm).toBeDefined()
  act(() => settleConfirm(confirm.id, ok))
}
beforeEach(() => {
  localStorage.clear()
  history.replaceState(null, "", "/")
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } } })
  qc.setQueryData(keys.projects, [project, other])
  qc.setQueryData(keys.chat, [])
  qc.setQueryData(keys.chatBusy, false)
  for (const p of [project, other]) qc.setQueryData(keys.captain(p.id), { projectId: p.id, busy: false })
  fetchMock = vi.fn(() => new Promise(() => {}))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(async () => {
  const confirm = currentConfirm()
  if (confirm) { answer(false); await flush() }
  act(() => root.unmount())
  host.remove()
  qc.clear()
  act(() => { setTreeFolds({}); unfoldSidebarGroup(project.id); unfoldSidebarGroup(other.id); setChatProjectFilter(null); resetColumns() })
  for (const t of currentToasts()) dismiss(t.id)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("sidebar reveal gestures", () => {
  it.each(["touch", "pen", "mouse"])("reveals Delete with %s, suppressing the following click without navigating or folding", (type) => {
    render()
    const el = taskRow(parent)
    el.setPointerCapture = vi.fn()
    swipe(el, -70, 0, type)
    expect(el.setPointerCapture).toHaveBeenCalledWith(1)
    expect(action(el).textContent).toBe("Delete")
    expect(el.dataset.deleteRevealed).toBe("true")
    expect(currentConfirm()).toBeUndefined()
    expect(click(openButton(el)).defaultPrevented).toBe(true)
    expect(location.search).toBe("")
    expect(taskRow(child)).not.toBeNull()
    expect(action(el)).not.toBeNull()
    expect(fetchMock.mock.calls.filter(([url, init]) => init?.method === "DELETE")).toEqual([])
  })

  it("keeps vertical and diagonal scrolling locked vertically, even if the pointer later moves sideways", () => {
    render()
    const el = taskRow(parent)
    const button = openButton(el)
    pointer(button, "pointerdown", 200, 100)
    expect(pointer(button, "pointermove", 190, 125).defaultPrevented).toBe(false)
    expect(pointer(button, "pointermove", 100, 130).defaultPrevented).toBe(false)
    pointer(button, "pointerup", 100, 130)
    expect(action(el)).toBeNull()
    swipe(el, -30, 25)
    expect(action(el)).toBeNull()
  })

  it("ignores small movements and right swipes on closed rows, and preserves normal navigation", () => {
    render()
    const el = taskRow(sibling)
    swipe(el, -8)
    expect(action(el)).toBeNull()
    click(openButton(el))
    expect(new URLSearchParams(location.search).get("session")).toBe(sibling.id)
    swipe(taskRow(parent), 70)
    expect(action(taskRow(parent))).toBeNull()
  })

  it("supports reversing, cancellation, lost capture and a right swipe to close", () => {
    render()
    const el = taskRow(parent)
    const b = openButton(el)
    pointer(b, "pointerdown", 200, 100)
    pointer(b, "pointermove", 130, 100)
    pointer(b, "pointermove", 195, 100)
    pointer(b, "pointerup", 195, 100)
    expect(action(el)).toBeNull()
    for (const end of ["pointercancel", "lostpointercapture"]) {
      pointer(b, "pointerdown", 200, 100)
      pointer(b, "pointermove", 130, 100)
      pointer(end === "lostpointercapture" ? el : b, end, 130, 100)
      expect(action(el)).toBeNull()
    }
    swipe(el)
    swipe(el, 70)
    expect(action(el)).toBeNull()
  })

  it("has only one revealed row across nested rows, waiting copies and projects; outside presses and scrolling close it", () => {
    render([parent, child, { ...sibling, status: "failed" }])
    const first = taskRow(child)
    swipe(first)
    const waiting = row(taskKey(sibling.id, "waiting"))
    swipe(waiting)
    expect(action(first)).toBeNull()
    expect(host.querySelectorAll("[data-sidebar-delete]")).toHaveLength(1)
    swipe(row(captainKey(project.id)))
    expect(action(waiting)).toBeNull()
    act(() => document.dispatchEvent(new Event("scroll", { bubbles: false })))
    expect(host.querySelectorAll("[data-sidebar-delete]")).toHaveLength(0)
    swipe(first)
    pointer(document.body, "pointerdown", 0, 0)
    expect(action(first)).toBeNull()
  })

  it("ignores implicit capture transfer from the hit child and unrelated chat scrolls", () => {
    render()
    const el = taskRow(parent)
    const b = openButton(el)
    pointer(b, "pointerdown", 200, 100)
    pointer(b, "pointermove", 170, 100)
    pointer(b, "lostpointercapture", 170, 100)
    pointer(el, "pointermove", 130, 100)
    pointer(el, "pointerup", 130, 100)
    expect(action(el)).not.toBeNull()
    const unrelated = document.createElement("div")
    document.body.append(unrelated)
    act(() => unrelated.dispatchEvent(new Event("scroll")))
    expect(action(el)).not.toBeNull()
    unrelated.remove()
  })

  it("leaves fixed navigation, chevrons, pins and nested action buttons alone", () => {
    render()
    expect(row("coordinator").getAttribute("aria-keyshortcuts")).toBeNull()
    const el = taskRow(parent)
    const chevron = el.querySelector<HTMLElement>("[data-tree-toggle]")!
    pointer(chevron, "pointerdown", 200, 100)
    pointer(chevron, "pointermove", 100, 100)
    pointer(chevron, "pointerup", 100, 100)
    expect(action(el)).toBeNull()
    click(chevron)
    expect(taskRow(child)).toBeNull()
    expect(el.getAttribute("aria-expanded")).toBe("false")
    click(chevron)
    const prj = row(captainKey(project.id))
    const pin = prj.querySelector<HTMLElement>("button[aria-label^=Pin]")!
    swipe(el)
    pointer(pin, "pointerdown", 200, 100)
    pointer(pin, "pointermove", 100, 100)
    pointer(pin, "pointerup", 100, 100)
    expect(action(prj)).toBeNull()
  })

  it("context menu and Shift+F10 focus Delete; Escape restores the row and arrows still navigate the tree", async () => {
    render()
    const el = taskRow(parent)
    act(() => el.focus())
    expect(key(el, "F10", true).defaultPrevented).toBe(true)
    await act(async () => { await new Promise(requestAnimationFrame) })
    expect(document.activeElement).toBe(action(el))
    expect(action(el).tabIndex).toBe(0)
    expect(key(action(el), "Escape").defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(el)
    expect(action(el)).toBeNull()
    key(el, "ArrowRight")
    expect(document.activeElement).toBe(taskRow(child))
    const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
    act(() => openButton(taskRow(child)).dispatchEvent(e))
    expect(e.defaultPrevented).toBe(true)
    expect(action(taskRow(child))).not.toBeNull()
  })
})

describe("sidebar deletion semantics", () => {
  it.each(["queued", "starting", "working"] as const)("blocks %s tasks, their parents and projects", (status) => {
    render([parent, { ...child, status }, sibling])
    for (const el of [taskRow(child), taskRow(parent), row(captainKey(project.id))]) {
      swipe(el)
      expect(action(el).disabled).toBe(true)
      expect(action(el).title).toContain("Stop")
    }
  })

  it("blocks an active turn even in a resting status, and a busy Captain", () => {
    qc.setQueryData(keys.captain(project.id), { projectId: project.id, busy: true })
    render([parent, { ...child, status: "needs_input", turnStartedAt: 100 }])
    swipe(taskRow(parent))
    expect(action(taskRow(parent)).disabled).toBe(true)
    swipe(row(captainKey(project.id)))
    expect(action(row(captainKey(project.id))).title).toContain("Captain")
  })

  it("blocks pending messages and compaction without changing completion semantics", () => {
    render([parent, { ...child, pendingCount: 1, compacting: true }])
    key(taskRow(parent), "ContextMenu")
    expect(action(taskRow(parent)).disabled).toBe(true)
    expect(taskRow(parent).querySelector("[data-testid=sidebar-mark-done]")).not.toBeNull()
  })

  it("cancel does not call DELETE and closes the reveal", async () => {
    render()
    const el = taskRow(child)
    key(el, "ContextMenu")
    click(action(el), 0)
    expect(currentConfirm()).toMatchObject({ title: "Delete task?", danger: true, body: "Delete this task, its workspace and its archive?" })
    answer(false)
    await flush()
    expect(action(el)).toBeNull()
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toEqual([])
  })

  it("Escape cancels the shared confirmation, and repeated Delete presses cannot queue another", async () => {
    render()
    key(taskRow(child), "ContextMenu")
    const del = action(taskRow(child))
    click(del, 0)
    const first = currentConfirm()!.id
    expect(del.disabled).toBe(true)
    click(del, 0)
    expect(currentConfirm()!.id).toBe(first)
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!
    key(dialog, "Escape")
    await flush()
    expect(currentConfirm()).toBeUndefined()
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toEqual([])
  })

  it("keeps a reveal on its row through a re-sort and preserves the selected item", async () => {
    render()
    const el = taskRow(sibling)
    key(el, "ContextMenu")
    act(() => qc.setQueryData(keys.tasks, [{ ...sibling, updatedAt: Date.now() }, parent, child]))
    await flush()
    expect(taskRow(sibling)).toBe(el)
    expect(action(el)).not.toBeNull()
    expect(row("coordinator").getAttribute("aria-current")).toBe("page")
  })

  it("includes hidden/done descendants when protecting a parent from active work", () => {
    render([parent, { ...child, status: "done", turnStartedAt: 123 }])
    key(taskRow(parent), "ContextMenu")
    expect(action(taskRow(parent)).disabled).toBe(true)
  })

  it("rechecks running descendants after confirmation before sending DELETE", async () => {
    render()
    const el = taskRow(parent)
    key(el, "ContextMenu")
    click(action(el), 0)
    act(() => qc.setQueryData(keys.tasks, [parent, { ...child, status: "working" }, sibling]))
    answer(true)
    await flush()
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toEqual([])
  })

  it("deletes a confirmed parent using the existing API, removes descendants and safely closes the current child", async () => {
    render()
    history.replaceState(null, "", `/?session=${child.id}`)
    fetchMock.mockImplementation(async (_url, init) => init?.method === "DELETE" ? new Response('{"ok":true}', { status: 200 }) : new Promise(() => {}))
    key(taskRow(parent), "ContextMenu")
    click(action(taskRow(parent)), 0)
    expect(currentConfirm()?.body).toContain("1 sub-task, their workspaces and archives")
    answer(true)
    await flush()
    expect(fetchMock).toHaveBeenCalledWith(`/api/tasks/${parent.id}?ifResting=1`, expect.objectContaining({ method: "DELETE" }))
    expect(qc.getQueryData<Task[]>(keys.tasks)?.map((t) => t.id)).toEqual([sibling.id])
    expect(new URLSearchParams(location.search).get("session")).toBeNull()
    expect(currentToasts().filter((t) => t.kind === "error")).toEqual([])
  })

  it("confirms a project cascade and returns its current Captain to the Coordinator", async () => {
    render()
    act(() => setChatProjectFilter(project.id))
    fetchMock.mockImplementation(async (_url, init) => init?.method === "DELETE" ? new Response('{"ok":true}', { status: 200 }) : new Promise(() => {}))
    const el = row(captainKey(project.id))
    key(el, "ContextMenu")
    click(action(el), 0)
    expect(currentConfirm()).toMatchObject({ title: "Delete project?", body: `Delete ${project.name} and all its tasks? This can't be undone.` })
    answer(true)
    await flush()
    expect(fetchMock).toHaveBeenCalledWith(`/api/projects/${project.id}?ifResting=1`, expect.objectContaining({ method: "DELETE" }))
    expect(qc.getQueryData<Project[]>(keys.projects)).toEqual([other])
    expect(chatProjectFilter()).toBeNull()
  })

  it("deleting an inactive task preserves the current task and its selection", async () => {
    render()
    history.replaceState(null, "", `/?session=${sibling.id}`)
    fetchMock.mockImplementation(async (_url, init) => init?.method === "DELETE" ? new Response('{"ok":true}', { status: 200 }) : new Promise(() => {}))
    key(taskRow(child), "ContextMenu")
    click(action(taskRow(child)), 0)
    answer(true)
    await flush()
    expect(new URLSearchParams(location.search).get("session")).toBe(sibling.id)
    expect(taskRow(sibling).getAttribute("aria-current")).toBe("page")
  })

  it("restores optimistic rows and reports errors without navigating away", async () => {
    render()
    history.replaceState(null, "", `/?session=${child.id}`)
    let finish!: (response: Response) => void
    fetchMock.mockImplementation((_url, init) => init?.method === "DELETE" ? new Promise<Response>((r) => { finish = r }) : new Promise(() => {}))
    key(taskRow(child), "ContextMenu")
    click(action(taskRow(child)), 0)
    answer(true)
    await flush()
    expect(taskRow(child)).toBeNull()
    expect(new URLSearchParams(location.search).get("session")).toBe(child.id)
    await act(async () => finish(new Response('{"error":"Example refusal"}', { status: 409 })))
    await flush()
    expect(taskRow(child)).not.toBeNull()
    expect(new URLSearchParams(location.search).get("session")).toBe(child.id)
    expect(currentToasts().some((t) => t.title.includes("Couldn't delete"))).toBe(true)
  })
})
