// @vitest-environment happy-dom
// How a surface is left (docs/dismiss.md): one Back or one Close, never both; a level inside a Modal (useModalStep)
// is left before the Modal; and Esc closes only the topmost layer, a menu included.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, useState, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { DismissButton, Modal, ModalStep, modalDepth, useModalStep } from "../web/src/components/Modal.js"
import { usePopover } from "../web/src/components/TaskHeader.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
})

const render = (node: ReactNode) => act(() => root.render(node))
/** Esc from wherever focus is, bubbling through the document (menus listen there) to the window (Modals do). */
const esc = () => act(() => void (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })))
const dismissers = () => [...document.querySelectorAll<HTMLButtonElement>("[data-dismiss]")].map((b) => `${b.dataset.dismiss}:${b.getAttribute("aria-label")}`)
const byText = (text: string) => [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === text)!

describe("DismissButton", () => {
  it("is a named ‹ or ×, its tooltip names Esc, and it's 32px with a mouse and 44px to a finger", () => {
    const back = vi.fn()
    render(createElement("div", null, createElement(DismissButton, { kind: "back", onClick: back }), createElement(DismissButton, { kind: "close", onClick: () => {}, label: "Close thread", title: "Close (Esc). It stays." })))
    const [b, c] = [...host.querySelectorAll("button")]
    expect([b!.getAttribute("aria-label"), b!.title, b!.dataset.dismiss]).toEqual(["Back", "Back (Esc)", "back"])
    expect([c!.getAttribute("aria-label"), c!.title, c!.dataset.dismiss]).toEqual(["Close thread", "Close (Esc). It stays.", "close"])
    for (const el of [b!, c!]) expect(el.className.split(" ")).toEqual(expect.arrayContaining(["h-8", "w-8", "pointer-coarse:h-11", "pointer-coarse:w-11"]))
    click(b!)
    expect(back).toHaveBeenCalledOnce()
  })
})

describe("one way out per surface", () => {
  it("a dialog closes with ×, a panel goes Back, and neither shows both", () => {
    render(createElement(Modal, { title: "Settings", onClose: () => {} }, "body"))
    expect(dismissers()).toEqual(["close:Close"])
    act(() => root.unmount())
    root = createRoot(host)
    render(createElement(Modal, { title: "Schedules", placement: "panel", onClose: () => {} }, "body"))
    expect(dismissers()).toEqual(["back:Back"])
  })
})

/** A dialog with a list and a detail inside it, like Pull requests. */
function ListAndDetail({ onClose }: { onClose: () => void }) {
  const [item, setItem] = useState<string | null>(null)
  return createElement(
    Modal,
    { title: "Pull requests", onClose },
    createElement(ModalStep, { active: item !== null, back: () => setItem(null), label: "Back to pull requests" }),
    item ? createElement("p", null, `Detail of ${item}`) : createElement("button", { type: "button", onClick: () => setItem("#42") }, "#42"),
  )
}

describe("a level inside a Modal (useModalStep)", () => {
  it("swaps the dialog's × for Back while it's open, and Esc leaves it before the dialog", () => {
    const onClose = vi.fn()
    render(createElement(ListAndDetail, { onClose }))
    click(byText("#42"))
    expect(document.body.textContent).toContain("Detail of #42")
    expect(dismissers()).toEqual(["back:Back to pull requests"])

    esc()
    expect(document.body.textContent).not.toContain("Detail of #42")
    expect(onClose).not.toHaveBeenCalled()
    expect(dismissers()).toEqual(["close:Close"])

    click(byText("#42"))
    click(document.querySelector("[data-dismiss=back]")!)
    expect(document.body.textContent).not.toContain("Detail of #42")
    esc()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("does nothing outside a Modal", () => {
    const back = vi.fn()
    function Loose() {
      useModalStep(true, back)
      return createElement("p", null, "loose")
    }
    render(createElement(Loose))
    esc()
    expect(back).not.toHaveBeenCalled()
  })

  it("nested levels leave newest first", () => {
    const calls: string[] = []
    function Nested() {
      const [a, setA] = useState(true)
      const [b, setB] = useState(true)
      return createElement(
        Modal,
        { title: "Deep", onClose: () => calls.push("close") },
        createElement(ModalStep, { active: a, back: () => (calls.push("a"), setA(false)), label: "Back to A" }),
        createElement(ModalStep, { active: b, back: () => (calls.push("b"), setB(false)), label: "Back to B" }),
      )
    }
    render(createElement(Nested))
    expect(dismissers()).toEqual(["back:Back to B"])
    esc()
    expect(dismissers()).toEqual(["back:Back to A"])
    esc()
    esc()
    expect(calls).toEqual(["b", "a", "close"])
  })
})

/** A menu (usePopover) whose item opens a dialog while the menu stays open. */
function MenuWithDialog() {
  const { open, setOpen, root: menuRoot, trigger } = usePopover()
  const [dialog, setDialog] = useState(false)
  return createElement(
    "div",
    { ref: menuRoot },
    createElement("button", { ref: trigger, type: "button", onClick: () => setOpen(!open) }, "Menu"),
    open && createElement("div", { role: "menu" }, createElement("button", { type: "button", onClick: () => setDialog(true) }, "Rename…")),
    dialog && createElement(Modal, { title: "Rename", onClose: () => setDialog(false) }, createElement("input", { "aria-label": "Name" })),
  )
}

describe("Esc closes only the topmost layer", () => {
  it("a dialog opened from a menu closes first; the next Esc closes the menu and focuses its button", () => {
    render(createElement(MenuWithDialog))
    click(byText("Menu"))
    const before = modalDepth()
    // A real click focuses the item; happy-dom's doesn't.
    act(() => byText("Rename…").focus())
    click(byText("Rename…"))
    expect(modalDepth()).toBe(before + 1)
    expect(document.querySelector("[role=dialog]")!.contains(document.activeElement)).toBe(true)

    esc()
    expect(document.querySelector("[role=dialog]")).toBeNull()
    expect(document.querySelector("[role=menu]")).not.toBeNull()
    expect(document.activeElement?.textContent).toBe("Rename…")

    esc()
    expect(document.querySelector("[role=menu]")).toBeNull()
    expect(document.activeElement?.textContent).toBe("Menu")
  })

  it("a menu opened inside a dialog closes before the dialog", () => {
    const onClose = vi.fn()
    function MenuInDialog() {
      const { open, setOpen, root: menuRoot, trigger } = usePopover()
      return createElement(
        Modal,
        { title: "Captain", onClose },
        createElement("div", { ref: menuRoot }, createElement("button", { ref: trigger, type: "button", onClick: () => setOpen(!open) }, "Menu"), open && createElement("div", { role: "menu" }, "items")),
      )
    }
    render(createElement(MenuInDialog))
    click(byText("Menu"))
    esc()
    expect(document.querySelector("[role=menu]")).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    esc()
    expect(onClose).toHaveBeenCalledOnce()
  })
})
