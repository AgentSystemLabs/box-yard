// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SettingsDialog } from "../web/src/components/SettingsDialog.js"
import { keys } from "../web/src/lib/queries.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import type { Settings, SettingsInfo } from "../shared/types"

// Settings › Coordinator › Quick questions: the model and effort side threads run on. Unset, each shows (and runs on)
// its chat's own; like every Settings control, a pick is a draft until Save.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settingsInfo = (values: Partial<Settings> = {}): SettingsInfo => ({
  settings: { ...DEFAULT_SETTINGS, ...values },
  sources: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, k in values ? "ui" : "default"])) as SettingsInfo["sources"],
  defaults: DEFAULT_SETTINGS,
})

let root: Root
let host: HTMLElement
let requests: { method: string; url: string; body?: unknown }[]

function render(info: SettingsInfo) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.agentSettings, info)
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(SettingsDialog, { section: "orchestrator", onSection: () => {}, onClose: () => {} }))))
}

beforeEach(() => {
  requests = []
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
})

const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
const $ = <T extends Element = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid=${id}]`)
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)
const writes = () => requests.filter((r) => r.method !== "GET")
const choose = async (el: HTMLSelectElement, value: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await settle()
}
const model = () => $<HTMLSelectElement>("quick-question-model")!
const effort = () => $<HTMLSelectElement>("quick-question-effort")!
const selectedText = (el: HTMLSelectElement) => el.selectedOptions[0]?.textContent?.trim()

describe("Settings › Coordinator › Quick questions", () => {
  it("default to each chat's own model and effort, and offer Haiku", () => {
    render(settingsInfo())
    expect(model().value).toBe("")
    expect(selectedText(model())).toBe("Same as chat")
    // Which model "Same as chat" is sits in a hint beside the picker.
    expect($("quick-question-model-resolved")!.textContent).toBe("Uses Opus 5.5.")
    expect(DEFAULT_SETTINGS.orchestratorModel).toBe("claude-opus-5-5")
    expect([...model().options].map((o) => o.value)).toContain("claude-haiku-5-5")
    expect(effort().value).toBe("")
    expect(selectedText(effort())).toBe("Same as chat (High)")
    // "Same as its chat" is the only "" option: no "(saved, unverified)" copy of it.
    expect([...effort().options].filter((o) => o.value === "")).toHaveLength(1)
    expect(effort().textContent).not.toContain("unverified")
    // Phone-first: 44px tall on a phone, like the other Settings pickers.
    expect(model().className).toContain("min-h-11")
    expect(effort().className).toContain("min-h-11")
  })

  it("say 'Same as chat' alone when the Coordinator and the Captains differ", () => {
    render(settingsInfo({ captainModel: "claude-sonnet-5-5", captainEffort: "medium" }))
    expect(selectedText(model())).toBe("Same as chat")
    expect($("quick-question-model-resolved")!.textContent).toBe("Uses Opus 5.5 for the Coordinator, Sonnet 5.5 for Captains.")
    expect(selectedText(effort())).toBe("Same as chat")
  })

  it("are a draft until Save, which sends the model and effort picked", async () => {
    render(settingsInfo())
    await choose(model(), "claude-haiku-5-5")
    await choose(effort(), "low")
    expect(model().value).toBe("claude-haiku-5-5")
    expect(effort().value).toBe("low")
    expect(writes()).toEqual([])
    for (const f of document.querySelectorAll("form")) f.noValidate = true
    act(() => button("Save")!.click())
    await settle()
    expect(writes()).toHaveLength(1)
    expect(writes()[0]).toMatchObject({ method: "PUT", url: "/api/agent-settings", body: { quickQuestionModel: "claude-haiku-5-5", quickQuestionEffort: "low" } })
  })

  it("show a saved pick, and go back to the chat's own with Same as its chat", async () => {
    render(settingsInfo({ quickQuestionModel: "claude-haiku-5-5", quickQuestionEffort: "low" }))
    expect(model().value).toBe("claude-haiku-5-5")
    expect(effort().value).toBe("low")
    await choose(model(), "")
    await choose(effort(), "")
    for (const f of document.querySelectorAll("form")) f.noValidate = true
    act(() => button("Save")!.click())
    await settle()
    expect(writes()[0]).toMatchObject({ body: { quickQuestionModel: "", quickQuestionEffort: "" } })
  })
})
