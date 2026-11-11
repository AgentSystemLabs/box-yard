// @vitest-environment happy-dom
// The keyboard shortcuts sheet and the composer jump, in the whole app: "?" and its other ways in (the palette's
// command, the sidebar's button), and ⌥⇧C between the chat's composer and the side panel's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { keys } from "../web/src/lib/queries.js"
import { setChatProjectFilter } from "../web/src/lib/projectBar.js"
import { captainHref } from "../web/src/components/ChatSwitcher.js"
import { openPalette } from "../web/src/components/CommandPalette.js"
import { closeShortcuts } from "../web/src/components/ShortcutsHelp.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import type { Project } from "../shared/types"
import { APP_HOME } from "../web/src/lib/navigation.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const PROJECTS = [{ id: "prj_alpha1", name: "alpha", repo: "acme/alpha", description: "", notes: [], updatedAt: now }] as unknown as Project[]

class FakeEventSource {
  onmessage: unknown = null
  onerror: unknown = null
  onopen: unknown = null
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

let root: Root
let host: HTMLElement

function render(path: string = APP_HOME) {
  history.replaceState(null, "", path)
  sessionStorage.setItem("box-yard:landed", "1")
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.agentSettings, { settings: { ownerName: "Cody", orchestratorAutoCompact: { enabled: true, unit: "tokens", value: 250_000 } }, sources: {}, defaults: {} })
  qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.orchestrator, { busy: false, usage: { tokens: 1000, window: 1_000_000, updatedAt: now }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null })
  qc.setQueryData(keys.chat, [])
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, [])
  qc.setQueryData(keys.projects, PROJECTS)
  qc.setQueryData(keys.captain("prj_alpha1"), { projectId: "prj_alpha1", busy: false, compacting: false, compactQueued: false, error: null, usage: { tokens: null, window: null, updatedAt: null } })
  qc.setQueryData(keys.captainMessages("prj_alpha1"), [])
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
}

const key = (k: string, target: Element = document.activeElement ?? document.body, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })
  act(() => void target.dispatchEvent(e))
  return e
}
const jump = (target?: Element) => key("Ç", target, { code: "KeyC", altKey: true, shiftKey: true })
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
const sheet = () => [...document.querySelectorAll<HTMLElement>("[role=dialog]")].find((d) => d.textContent?.startsWith("Keyboard shortcuts")) ?? null
const shortcut = (id: string) => sheet()?.querySelector<HTMLElement>(`[data-shortcut="${id}"]`) ?? null
const chatBox = () => document.querySelector<HTMLTextAreaElement>("[data-testid=chat-footer] textarea")!
const panel = () => document.querySelector<HTMLElement>("aside[data-testid=side-thread]")
const panelBox = () => panel()!.querySelector<HTMLTextAreaElement>("textarea")!
const paletteInput = () => document.querySelector<HTMLInputElement>("[aria-label='Command palette'] input[role=combobox]")
const typeInPalette = (text: string) =>
  act(() => {
    const input = paletteInput()!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
  vi.stubGlobal("EventSource", FakeEventSource)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => closeShortcuts())
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  for (const t of currentToasts()) dismiss(t.id)
  setChatProjectFilter(null)
  vi.unstubAllGlobals()
})

describe("the keyboard shortcuts sheet", () => {
  it('"?" opens it from the page, grouped, with every hotkey; "?" again or Esc closes it', () => {
    render()
    expect(sheet()).toBeNull()
    expect(key("?", document.body, { shiftKey: true }).defaultPrevented).toBe(true)
    expect(sheet()).not.toBeNull()
    expect([...sheet()!.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["Anywhere", "Sidebar", "Composer", "Command palette", "New task dialog", "File preview", "Settings"])
    for (const id of ["palette", "switch", "composer", "voice", "close", "help", "send", "newline", "history", "move", "new-tab", "step", "zoom", "find", "new-task", "start-task"]) expect(shortcut(id), id).not.toBeNull()
    // Each row says its keys for a screen reader, the caps themselves are hidden from it.
    expect(shortcut("composer")!.querySelector(".sr-only")!.textContent).toMatch(/^(Option\+Shift\+C|Alt\+Shift\+C)$/)
    expect(shortcut("palette")!.querySelectorAll("kbd")).toHaveLength(3)
    key("?", document.activeElement!, { shiftKey: true })
    expect(sheet()).toBeNull()
    key("?", document.body, { shiftKey: true })
    key("Escape")
    expect(sheet()).toBeNull()
  })

  it("leaves dictation out when this browser can't dictate", () => {
    render()
    key("?", document.body)
    expect(shortcut("dictate")).toBeNull()
  })

  it('"?" types in a field, and never opens over another dialog', () => {
    render()
    expect(key("?", chatBox()).defaultPrevented).toBe(false)
    expect(sheet()).toBeNull()
    act(() => openPalette())
    expect(key("?", document.body).defaultPrevented).toBe(false)
    expect(sheet()).toBeNull()
    key("Escape")
  })

  it("opens beside the side panel, and Esc closes the sheet before the panel", () => {
    render("/projects/prj_alpha1?tab=captain")
    expect(panel()).not.toBeNull()
    key("?", document.body)
    expect(sheet()).not.toBeNull()
    key("Escape")
    expect(sheet()).toBeNull()
    expect(panel()).not.toBeNull()
  })

  it("the palette finds it as a command, shows its ? key, and Enter opens it", () => {
    render()
    act(() => openPalette())
    typeInPalette("shortcuts")
    const option = document.querySelector<HTMLElement>('[role=option][data-key="action:shortcuts"]')!
    expect(option.textContent).toContain("Keyboard shortcuts")
    expect(option.querySelector("kbd")!.textContent).toBe("?")
    typeInPalette("hotkeys")
    expect(document.querySelector('[role=option][data-key="action:shortcuts"]')).not.toBeNull()
    key("Enter", paletteInput()!)
    expect(paletteInput()).toBeNull()
    expect(sheet()).not.toBeNull()
  })

  it("the sidebar's keyboard button opens it, and names its key", () => {
    render()
    const button = document.querySelector<HTMLButtonElement>('nav button[aria-label="Keyboard shortcuts"]')!
    expect(button.title).toBe("Keyboard shortcuts (?)")
    expect(button.getAttribute("aria-keyshortcuts")).toBe("?")
    click(button)
    expect(sheet()).not.toBeNull()
  })
})

describe("the composer jump (⌥⇧C)", () => {
  it("lands in the chat's composer from the page, even mid-typing elsewhere, and keeps a Mac from typing Ç", () => {
    render()
    const e = jump(document.body)
    expect(e.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(chatBox())
    // Already there with no panel: it stays.
    jump()
    expect(document.activeElement).toBe(chatBox())
  })

  it("hops between the chat's composer and the side panel's", () => {
    render("/projects/prj_alpha1?tab=captain")
    // The panel took focus when it opened, so the first press lands in its composer.
    expect(panel()!.contains(document.activeElement)).toBe(true)
    jump()
    expect(document.activeElement).toBe(panelBox())
    jump()
    expect(document.activeElement).toBe(chatBox())
    jump()
    expect(document.activeElement).toBe(panelBox())
  })

  it("does nothing while a dialog is open, so focus stays in it", () => {
    render(captainHref("prj_alpha1"))
    act(() => openPalette())
    const input = paletteInput()!
    expect(jump(input).defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(input)
    key("Escape")
  })
})
