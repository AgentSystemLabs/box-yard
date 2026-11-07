// @vitest-environment happy-dom
// An Undo toast in the app: it shows (the app hides other info toasts), its Undo is finger-sized, and a tap beside the
// button doesn't throw the Undo away. A toast without an action still goes on a click. Every toast has a ✕ that only
// dismisses it, takes the stack's one width, and wraps its text instead of cutting it off.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { Toasts } from "../web/src/components/Toasts.js"
import { TAP_AREA } from "../web/src/components/ui.js"
import { currentToasts, dismiss, toast } from "../web/src/lib/toast.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe("Undo toasts", () => {
  let root: Root
  let host: HTMLElement

  beforeEach(() => {
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    act(() => root.render(createElement(Toasts, { quiet: true })))
  })

  afterEach(() => {
    act(() => {
      for (const t of currentToasts()) dismiss(t.id)
      root.unmount()
    })
    host.remove()
  })

  const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })))
  const shown = () => [...host.querySelectorAll<HTMLElement>("[data-toast]")]

  it("shows in the app, with a finger-sized Undo that undoes and goes", () => {
    let undone = 0
    act(() => void toast.info("Marked done", "Fix login", { action: { label: "Undo", onClick: () => undone++ } }))
    expect(shown()).toHaveLength(1)
    const undo = shown()[0]!.querySelector("button")!
    expect(undo.textContent).toBe("Undo")
    for (const c of TAP_AREA.split(" ")) expect(undo.className).toContain(c)
    click(undo)
    expect(undone).toBe(1)
    expect(shown()).toHaveLength(0)
  })

  it("stays up on a tap beside Undo; a toast with no action goes on a click", () => {
    act(() => void toast.info("Queued message deleted", undefined, { action: { label: "Undo", onClick: () => {} } }))
    click(shown()[0]!.querySelector(".font-medium")!)
    expect(shown()).toHaveLength(1)
    expect(shown()[0]!.className).not.toContain("cursor-pointer")
    act(() => void toast.error("Couldn't send"))
    const error = shown().find((el) => el.textContent!.includes("Couldn't send"))!
    expect(error.className).toContain("cursor-pointer")
    click(error)
    expect(shown().map((el) => el.textContent)).toEqual(["Queued message deletedUndo"])
  })

  const dismissOf = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!

  it("✕ dismisses a toast without running its Undo", () => {
    let undone = 0
    act(() => void toast.info("Marked done", "Fix login", { action: { label: "Undo", onClick: () => undone++ } }))
    const x = dismissOf(shown()[0]!)
    // A 44px target with a ring on keyboard focus.
    expect(x.className).toContain("h-11")
    expect(x.className).toContain("w-11")
    expect(x.innerHTML).toContain("group-focus-visible:ring-2")
    click(x)
    expect(shown()).toHaveLength(0)
    expect(currentToasts()).toHaveLength(0)
    expect(undone).toBe(0)
  })

  it("✕ dismisses a task toast without opening the task", () => {
    let opened = 0
    act(() => void toast.task({ title: "Fix login", status: "failed", tone: "red", context: "box-yard", href: "/?session=task_abcdef", onOpen: () => opened++ }))
    const before = location.href
    click(dismissOf(shown()[0]!))
    expect(shown()).toHaveLength(0)
    expect(opened).toBe(0)
    expect(location.href).toBe(before)
  })

  it("every toast has a ✕, takes the stack's width and wraps its text", () => {
    const long = "Outfit remake: Mine Foreman (Blender, on Dale's base body) with the new walker rig and retargeted animations"
    act(() => {
      toast.task({ title: long, body: "Exited with code 1", status: "failed", tone: "red", context: "box-yard", href: "/?session=task_abcdef" })
      toast.error("Couldn't send", "The server is unreachable.")
      toast.info("Marked done", long, { action: { label: "Undo", onClick: () => {} } })
    })
    expect(shown().map((el) => el.dataset.toast)).toEqual(["task", "error", "info"])
    for (const el of shown()) {
      expect(dismissOf(el)).not.toBeNull()
      expect(el.className).toContain("w-full")
      expect(el.querySelector(".truncate")).toBeNull()
      expect(el.querySelector(".font-medium")!.className).toContain("wrap-anywhere")
    }
    expect(shown()[0]!.parentElement!.className).toContain("w-[25rem]")
  })
})
