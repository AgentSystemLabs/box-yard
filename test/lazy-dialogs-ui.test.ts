// @vitest-environment happy-dom
// The command palette's list and the file preview's viewer are chunks of their own that the app doesn't warm
// (LazyPart.tsx `warm: false`). Opened before its chunk is in, each dialog already works: it takes the focus, Esc and
// Close dismiss it, and what was typed or focused carries over when the chunk lands. Each chunk here waits for the
// test to let it in.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { CommandPalette, openPalette } from "../web/src/components/CommandPalette.js"
import { FilePreviewHost } from "../web/src/components/FilePreviewHost.js"
import { openPreview } from "../web/src/lib/preview.js"
import { keys } from "../web/src/lib/queries.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const gates = vi.hoisted(() => {
  const gate = () => {
    let open!: () => void
    const ready = new Promise<void>((resolve) => (open = resolve))
    return { ready, open }
  }
  return { palette: gate(), preview: gate() }
})
vi.mock("../web/src/components/Palette.js", async (original) => {
  await gates.palette.ready
  return original()
})
vi.mock("../web/src/components/FilePreview.js", async (original) => {
  await gates.preview.ready
  return original()
})

let root: Root
let host: HTMLElement
let opener: HTMLButtonElement

beforeEach(() => {
  history.replaceState(null, "", "/")
  localStorage.clear()
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  opener = document.createElement("button")
  document.body.append(opener)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

function render(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  for (const key of [keys.tasks, keys.projects, keys.artifacts, keys.schedules, keys.boxes]) qc.setQueryData(key, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, node)))
}

/** Lets a gated chunk in, and the lazy part render it. */
const arrive = (gate: { open: () => void }, chunk: () => Promise<unknown>) =>
  act(async () => {
    gate.open()
    await chunk()
    await new Promise((r) => setTimeout(r, 0))
  })

const dialog = () => document.querySelector<HTMLElement>("[role=dialog]")
const escape = () => act(() => void (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))
const type = (field: HTMLInputElement, text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text)
    field.dispatchEvent(new Event("input", { bubbles: true }))
  })

describe("the command palette before its list is in", () => {
  it("opens with its field focused, and Esc closes it and gives the focus back", () => {
    render(createElement(CommandPalette))
    opener.focus()
    act(() => openPalette())
    expect(dialog()?.getAttribute("aria-label")).toBe("Command palette")
    expect(document.querySelector("input[role=combobox]"), "the list is in already").toBeNull()
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Search Box Yard")
    expect(dialog()!.querySelector('[role=status][data-loading]')).not.toBeNull()
    escape()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it("hands what was typed to the list, prefix and all, with the caret still in it", async () => {
    render(createElement(CommandPalette))
    opener.focus()
    act(() => openPalette())
    type(document.activeElement as HTMLInputElement, "> sett")
    await arrive(gates.palette, () => import("../web/src/components/Palette.js"))
    const input = document.querySelector<HTMLInputElement>("input[role=combobox]")!
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe("sett")
    expect(document.querySelector('[data-testid="palette-scope"]')?.textContent).toContain("Commands")
    // The list's keys are the dialog's now: Esc still closes it, and the focus goes back.
    escape()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(opener)
    // Opened again, it starts empty.
    act(() => openPalette())
    expect(document.querySelector<HTMLInputElement>("input[role=combobox]")!.value).toBe("")
  })
})

describe("the file preview before its viewer is in", () => {
  it("shows the file's name and Close, which has the focus, and Esc closes it", () => {
    render(createElement(FilePreviewHost))
    opener.focus()
    act(() => openPreview({ url: "/api/uploads/up_1/notes.md" }))
    expect(dialog()?.getAttribute("aria-label")).toBe("notes.md")
    expect(dialog()!.querySelector("h2")?.textContent).toBe("notes.md")
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close")
    escape()
    expect(dialog()).toBeNull()
    expect(new URL(location.href).searchParams.get("preview")).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it("moves the focus to the viewer's first control when it lands, and still gives it back on close", async () => {
    render(createElement(FilePreviewHost))
    opener.focus()
    act(() => openPreview({ url: "/api/uploads/up_1/notes.md" }))
    await arrive(gates.preview, () => import("../web/src/components/FilePreview.js"))
    const view = dialog()!
    // The viewer's controls are in (Raw for markdown), and the loading view's Close took the focus with it.
    expect(view.querySelector('[aria-label="Show raw"]')).not.toBeNull()
    expect(view.contains(document.activeElement) && document.activeElement !== view).toBe(true)
    expect(document.activeElement?.matches("button, a[href]")).toBe(true)
    escape()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
})
