// @vitest-environment happy-dom
// Screen readers hear what changes out of sight: toasts (including the ones the app keeps off screen) and the open
// task's state, through live regions that are in the page before their text; and the turn timing popover takes focus,
// so Esc closes it rather than the task panel around it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Toasts, spokenToast } from "../web/src/components/Toasts.js"
import { TaskStatusAnnouncer, taskStatusAnnouncement } from "../web/src/components/TaskStatusAnnouncer.js"
import { TurnTimingChip } from "../web/src/components/TurnTimingChip.js"
import { Modal } from "../web/src/components/Modal.js"
import { currentToasts, dismiss, toast } from "../web/src/lib/toast.js"
import type { Task } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    for (const t of currentToasts()) dismiss(t.id)
    root.unmount()
  })
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("spoken toasts", () => {
  const regions = () => document.querySelector("[data-testid=spoken-toasts]")!
  const polite = () => regions().querySelector('[aria-live="polite"]')!
  const assertive = () => regions().querySelector('[aria-live="assertive"]')!

  it("are in the page before any toast, so the first one is read", () => {
    act(() => root.render(createElement(Toasts, { quiet: true })))
    expect(regions().className).toBe("sr-only")
    expect(polite().textContent).toBe("")
    expect(assertive().textContent).toBe("")
  })

  it("say a task that needs Cody even though the app doesn't draw its toast", () => {
    act(() => root.render(createElement(Toasts, { quiet: true })))
    const region = polite()
    act(() => void toast.task({ title: "Add dark mode toggle", status: "needs_input", tone: "amber", context: "box-yard", body: "Blue or green?", href: "/?session=task_1" }))
    // Off screen in the app (only critical toasts show)…
    expect(document.querySelector("[data-toast]")).toBeNull()
    // …but heard, in the same region that was already there.
    expect(polite()).toBe(region)
    expect(region.textContent).toBe("Add dark mode toggle. Needs you. box-yard. Blue or green?")
    expect(assertive().textContent).toBe("")
  })

  it("interrupt for errors, and only the spoken copy is live", () => {
    act(() => root.render(createElement(Toasts, { quiet: true })))
    act(() => void toast.error("Couldn't send", "The server is unreachable."))
    expect(assertive().textContent).toBe("Couldn't send. The server is unreachable.")
    expect(polite().textContent).toBe("")
    // The visible stack shows the error without being a live region itself, so nothing is read twice.
    expect(document.body.textContent).toContain("The server is unreachable.")
    const live = [...document.querySelectorAll("[aria-live], [role=status], [role=alert]")]
    expect(live.every((el) => regions().contains(el))).toBe(true)
  })

  it("read a batch as its count, breakdown and task names", () => {
    expect(spokenToast({ id: 1, kind: "task", title: "3 tasks finished", context: "1 failed · 2 done", body: "A, B, C" })).toBe("3 tasks finished. 1 failed · 2 done. A, B, C")
    expect(spokenToast({ id: 2, kind: "task", title: "Fix login", status: "pr_ready", context: "box-yard" })).toBe("Fix login. PR ready. box-yard")
  })
})

describe("the open task's state", () => {
  const task = (over: Partial<Task> = {}) => ({ title: "Add dark mode toggle", status: "idle", prUrl: null, prState: null, ...over }) as Pick<Task, "title" | "status" | "prUrl" | "prState">
  const region = () => host.querySelector("[data-testid=task-status-announcer]")!
  const show = (t: ReturnType<typeof task>) => act(() => root.render(createElement(TaskStatusAnnouncer, { task: t })))

  it("is silent when the task opens, then says each change", () => {
    show(task())
    const el = region()
    expect(el.getAttribute("aria-live")).toBe("polite")
    expect(el.textContent).toBe("")
    show(task({ status: "starting" }))
    expect(el.textContent).toBe("")
    show(task({ status: "working" }))
    expect(el.textContent).toBe("Add dark mode toggle: Working")
    show(task({ status: "needs_input" }))
    expect(el.textContent).toBe("Add dark mode toggle: Needs you")
    show(task({ status: "done", prUrl: "https://github.com/o/r/pull/1", prState: "merged" }))
    expect(el.textContent).toBe("Add dark mode toggle: Merged")
    // Re-renders that don't change the state say nothing new.
    show(task({ status: "done", prUrl: "https://github.com/o/r/pull/1", prState: "merged", title: "Renamed" }))
    expect(el.textContent).toBe("Add dark mode toggle: Merged")
    expect(region()).toBe(el)
  })

  it("skips Starting, which Working follows at once", () => {
    expect(taskStatusAnnouncement("T", "starting")).toBe("")
    expect(taskStatusAnnouncement("T", "failed")).toBe("T: Failed")
    expect(taskStatusAnnouncement("T", "pr_ready")).toBe("T: PR ready")
  })
})

describe("turn timing popover focus", () => {
  it("takes focus once placed, and Esc closes only it, back to the chip", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "Not found" }), { status: 404 }))
    // Focus must not be asked of the popover while it's still hidden for placement: the browser ignores it there.
    const asked: string[] = []
    const focus = HTMLElement.prototype.focus
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, opts?: FocusOptions) {
      if (this.dataset.testid === "turn-timing-popover") asked.push(this.style.visibility)
      return focus.call(this, opts)
    })
    const onClose = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    act(() =>
      root.render(
        createElement(QueryClientProvider, { client: qc }, createElement(Modal, { label: "Task conversation", placement: "panel", onClose, children: createElement(TurnTimingChip, { id: "tim_gone", ms: 1200 }) })),
      ),
    )
    const chip = host.querySelector<HTMLButtonElement>("[data-testid=turn-timing]")!
    chip.focus()
    await act(async () => void chip.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))))
    const popover = document.querySelector<HTMLElement>("[data-testid=turn-timing-popover]")!
    expect(asked).toEqual([""])
    expect(document.activeElement).toBe(popover)

    await act(async () => void popover.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))
    expect(document.querySelector("[data-testid=turn-timing-popover]")).toBeNull()
    expect(document.activeElement).toBe(chip)
    expect(onClose).not.toHaveBeenCalled()
  })
})
