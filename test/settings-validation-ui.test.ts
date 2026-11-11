// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SettingsDialog } from "../web/src/components/SettingsDialog.js"
import { keys } from "../web/src/lib/queries.js"
import { currentConfirm, settleConfirm } from "../web/src/lib/confirm.js"
import type { SettingsSection } from "../web/src/lib/settingsNav.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import type { Settings, SettingsInfo } from "../shared/types"

// Settings are drafts until Save. A value the server would refuse says what fits right under its field, and Save
// goes to it (whichever section it's in) instead of failing, or doing nothing while the browser's own check balks.
// Leaving the page with drafts asks first.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settingsInfo = (values: Partial<Settings> = {}): SettingsInfo => ({
  settings: { ...DEFAULT_SETTINGS, ...values },
  sources: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, "default"])) as SettingsInfo["sources"],
  defaults: DEFAULT_SETTINGS,
})

let root: Root
let host: HTMLElement
let requests: { method: string; url: string; body?: Record<string, unknown> }[]
let section: SettingsSection

function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.agentSettings, settingsInfo())
  qc.setQueryData(keys.health, { provider: "local" })
  qc.setQueryData(keys.settings, { defaultTimezone: "UTC", scheduler: "local", maxUploadMb: 20, localDir: "/tmp/agents" })
  const draw = () =>
    act(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(SettingsDialog, {
            section,
            onSection: (s: SettingsSection) => {
              section = s
              draw()
            },
            onClose: () => {},
          }),
        ),
      ),
    )
  draw()
}

beforeEach(() => {
  requests = []
  section = "limits"
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, url, body })
    if (method === "PUT" && url === "/api/agent-settings") return new Response(JSON.stringify(settingsInfo(body)), { status: 200, headers: { "Content-Type": "application/json" } })
    return new Promise(() => {})
  })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
  while (currentConfirm()) settleConfirm(currentConfirm()!.id, false)
})

const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
const input = (path: string) => document.querySelector<HTMLInputElement>(`[data-setting="${path}"]`)!
const saveButton = () => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save")!
const problems = () => document.querySelector("[data-testid=settings-problems]")?.textContent ?? null
const errorId = (el: HTMLElement) =>
  (el.getAttribute("aria-describedby") ?? "").split(/\s+/).find((id) => /(^|-)error(-|$)/.test(id)) ?? null
const errorOf = (el: HTMLElement) => {
  // aria-describedby may list several ids (help, then error); the error id carries "error".
  const id = errorId(el)
  return id ? document.getElementById(id)?.textContent ?? null : null
}
const puts = () => requests.filter((r) => r.method === "PUT")
const navMark = (s: SettingsSection) => document.querySelector(`[data-section=${s}] [title]`)?.getAttribute("title") ?? null

function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
const click = async (el: HTMLElement) => {
  act(() => el.click())
  await settle()
}

describe("Settings validation", () => {
  it("says what fits under the field, marks it, and holds Save", async () => {
    render()
    type(input("maxBoxes"), "500")
    expect(input("maxBoxes").getAttribute("aria-invalid")).toBe("true")
    expect(errorOf(input("maxBoxes"))).toBe("Enter a whole number from 1 to 100.")
    // Search indexes a field's label and help, not its problem.
    expect(document.getElementById(errorId(input("maxBoxes"))!)!.hasAttribute("data-settings-search-ignore")).toBe(true)
    expect(problems()).toBe("Fix 1 field to save")
    expect(navMark("limits")).toBe("Needs a fix")
    // The phone's category picker says it too.
    expect([...document.querySelectorAll("option")].some((o) => o.textContent === "Boxes & limits · needs a fix")).toBe(true)

    await click(saveButton())
    expect(puts()).toEqual([])

    type(input("maxBoxes"), "40")
    expect(input("maxBoxes").hasAttribute("aria-invalid")).toBe(false)
    expect(problems()).toBeNull()
    expect(navMark("limits")).toBe("Unsaved changes")
    await click(saveButton())
    expect(puts()).toHaveLength(1)
    expect(puts()[0]!.body).toMatchObject({ maxBoxes: 40 })
  })

  it("Save goes to a problem in another section, opening Advanced and focusing it", async () => {
    render()
    const advanced = document.querySelector<HTMLDetailsElement>("[data-testid=limits-advanced]")!
    expect(advanced.open).toBe(false)
    type(input("maxBoxes"), "0")
    act(() => (document.querySelector("[data-section=orchestrator]") as HTMLElement).click())
    expect(section).toBe("orchestrator")

    await click(saveButton())
    expect(section).toBe("limits")
    expect(advanced.open).toBe(true)
    expect(document.activeElement).toBe(input("maxBoxes"))
    expect(puts()).toEqual([])
  })

  it("keeps an emptied number field empty and asks for a number, instead of saving 0", async () => {
    render()
    type(input("boxIdleDeleteMinutes"), "")
    expect(input("boxIdleDeleteMinutes").value).toBe("")
    expect(errorOf(input("boxIdleDeleteMinutes"))).toBe("Enter a whole number from 0 to 43,200.")
    await click(saveButton())
    expect(puts()).toEqual([])
    expect(document.activeElement).toBe(input("boxIdleDeleteMinutes"))

    type(input("boxIdleDeleteMinutes"), "45")
    await click(saveButton())
    expect(puts()[0]!.body).toMatchObject({ boxIdleDeleteMinutes: 45 })
  })

  it("saves a number between the spinner's steps, like the dependency cache's 2048 MB default", async () => {
    render()
    await click(document.querySelector<HTMLInputElement>("[data-testid=dep-cache]")!)
    expect(input("depCacheMaxMb").disabled).toBe(false)
    type(input("diskMinFreeMb"), "1000")
    await click(saveButton())
    expect(puts()).toHaveLength(1)
    expect(puts()[0]!.body).toMatchObject({ depCacheEnabled: true, depCacheMaxMb: 2048, diskMinFreeMb: 1000 })
  })

  it("keeps a box limit typed out of range, so it says what fits instead of snapping back", async () => {
    // Tasks per box is an Upstash setting: Settings › Box providers › Upstash boxes.
    section = "upstash"
    render()
    type(input("slotsPerBox"), "50")
    act(() => input("slotsPerBox").dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
    expect(input("slotsPerBox").value).toBe("50")
    expect(errorOf(input("slotsPerBox"))).toBe("Enter a whole number from 1 to 20.")
    await click(saveButton())
    expect(puts()).toEqual([])
  })

  it("checks names and custom model IDs, and says which size's rate is off", async () => {
    section = "agents"
    render()
    type(input("ownerName"), "  ")
    expect(errorOf(input("ownerName"))).toBe("Enter a name.")

    act(() => (document.querySelector("[data-section=costs]") as HTMLElement).click())
    type(input("costRates.boxActiveCpuHourlyUsd.medium"), "-1")
    expect(errorOf(input("costRates.boxActiveCpuHourlyUsd.medium"))).toBe("Medium: Enter an amount from 0 to 1,000,000.")
    expect(problems()).toBe("Fix 2 fields to save")
    expect(navMark("agents")).toBe("Needs a fix")

    // Save starts with the section on screen.
    await click(saveButton())
    expect(section).toBe("costs")
    expect(document.activeElement).toBe(input("costRates.boxActiveCpuHourlyUsd.medium"))
    expect(puts()).toEqual([])
  })

  it("asks before a reload or tab close drops unsaved drafts", async () => {
    render()
    const leave = () => {
      const e = new Event("beforeunload", { cancelable: true })
      window.dispatchEvent(e)
      return e.defaultPrevented
    }
    expect(leave()).toBe(false)
    type(input("maxBoxes"), "40")
    expect(leave()).toBe(true)
    await click(saveButton())
    expect(puts()).toHaveLength(1)
    expect(leave()).toBe(false)
  })
})
