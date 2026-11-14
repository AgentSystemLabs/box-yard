// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SettingsDialog } from "../web/src/components/SettingsDialog.js"
import { CaptainTab } from "../web/src/components/CaptainTab.js"
import { useServerEvents } from "../web/src/lib/stream.js"
import { keys } from "../web/src/lib/queries.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import type { CaptainMessage, CaptainState, Project, Settings, SettingSource, SettingsInfo, UiEvent } from "../shared/types.js"

// Settings › Coordinator › Warm Claude process, its idle time (a preset or custom minutes) and Stream Captain replies;
// the Captain chat's streamed reply; and the warm-up ping its chat box sends when it takes the focus.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project = { id: "prj_warm01", name: "warm", description: "", repo: null, baseBranch: "main", envKeys: [], notes: [], createdAt: 0, updatedAt: 0 } as unknown as Project
const idleState: CaptainState = { projectId: project.id, busy: false, usage: { tokens: null, window: null, updatedAt: null }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null }

function info(values: Partial<Settings> = {}): SettingsInfo {
  const sources = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, (k in values ? "ui" : "default") as SettingSource])) as SettingsInfo["sources"]
  return { settings: { ...DEFAULT_SETTINGS, ...values }, sources, defaults: DEFAULT_SETTINGS }
}

let root: Root
let host: HTMLElement
let qc: QueryClient
let requests: { method: string; url: string; body?: unknown }[]
let replies: Record<string, unknown>

beforeEach(() => {
  requests = []
  replies = {}
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    requests.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined })
    const reply = replies[`${method} ${url}`]
    if (!reply) return new Promise(() => {})
    return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } })
  })
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
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

const render = (node: ReactNode) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, node)))
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
const writes = () => requests.filter((r) => r.method !== "GET")
const $ = <T extends Element>(id: string) => document.querySelector<T>(`[data-testid=${id}]`)
const saveButton = () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Save")!

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string, event: "input" | "change") {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event(event, { bubbles: true }))
  })
}

function renderSettings(start: SettingsInfo) {
  qc.setQueryData(keys.agentSettings, start)
  qc.setQueryData(keys.health, { provider: "local" })
  qc.setQueryData(keys.settings, { defaultTimezone: "UTC", scheduler: "local", maxUploadMb: 20, localDir: "/tmp" })
  render(createElement(SettingsDialog, { section: "orchestrator", onSection: () => {}, onClose: () => {} }))
}

describe("Settings › Warm Claude process", () => {
  it("is on with a 30 minute idle time and streaming by default", () => {
    renderSettings(info())
    expect($<HTMLInputElement>("captain-warm-process")!.checked).toBe(true)
    expect($<HTMLSelectElement>("captain-warm-idle")!.value).toBe("30")
    expect([...$<HTMLSelectElement>("captain-warm-idle")!.options].map((o) => o.textContent)).toEqual(["5 minutes", "15 minutes", "30 minutes", "1 hour", "Custom…"])
    expect($("captain-warm-idle-minutes")).toBeNull()
    expect($<HTMLInputElement>("captain-stream-replies")!.checked).toBe(true)
  })

  it("saves a preset idle time on Save, not before", async () => {
    renderSettings(info())
    setValue($<HTMLSelectElement>("captain-warm-idle")!, "60", "change")
    await settle()
    expect(writes()).toEqual([])
    replies["PUT /api/agent-settings"] = info({ captainWarmIdleMinutes: 60 })
    act(() => saveButton().click())
    await settle()
    expect(writes()).toHaveLength(1)
    expect(writes()[0]!.body).toMatchObject({ captainWarmIdleMinutes: 60, captainWarmProcess: true })
  })

  it("takes custom minutes, and shows a saved one that isn't a preset as Custom", async () => {
    renderSettings(info())
    setValue($<HTMLSelectElement>("captain-warm-idle")!, "custom", "change")
    const minutes = $<HTMLInputElement>("captain-warm-idle-minutes")!
    expect(minutes.value).toBe("30")
    setValue(minutes, "45", "input")
    replies["PUT /api/agent-settings"] = info({ captainWarmIdleMinutes: 45 })
    act(() => saveButton().click())
    await settle()
    expect(writes()[0]!.body).toMatchObject({ captainWarmIdleMinutes: 45 })
    expect($<HTMLSelectElement>("captain-warm-idle")!.value).toBe("custom")
    expect($<HTMLInputElement>("captain-warm-idle-minutes")!.value).toBe("45")
  })

  it("greys out the idle time when off, and saves both switches", async () => {
    renderSettings(info())
    act(() => $<HTMLInputElement>("captain-warm-process")!.click())
    act(() => $<HTMLInputElement>("captain-stream-replies")!.click())
    expect($<HTMLSelectElement>("captain-warm-idle")!.disabled).toBe(true)
    replies["PUT /api/agent-settings"] = info({ captainWarmProcess: false, captainStreamReplies: false })
    act(() => saveButton().click())
    await settle()
    expect(writes()[0]!.body).toMatchObject({ captainWarmProcess: false, captainStreamReplies: false })
  })
})

class FakeEventSource {
  static all: FakeEventSource[] = []
  static OPEN = 1
  readyState = 0
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  addEventListener() {}
  constructor(public url: string) {
    FakeEventSource.all.push(this)
  }
  close() {}
}

describe("a Captain's streamed reply", () => {
  function Live() {
    useServerEvents(true)
    return null
  }
  // Each event is applied on its own: the stream applies what came in on the next frame.
  const send = async (ev: UiEvent) => {
    act(() => FakeEventSource.all.at(-1)!.onmessage?.({ data: JSON.stringify(ev) }))
    await settle()
  }
  const streaming = () => $("captain-streaming")

  it("shows in the chat as it's written, starts over on a reset, and gives way to the stored reply", async () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0))
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id))
    for (const k of [keys.tasks, keys.schedules, keys.artifacts, keys.boxes]) qc.setQueryData(k, [])
    qc.setQueryData(keys.projects, [project])
    qc.setQueryData<CaptainMessage[]>(keys.captainMessages(project.id), [])
    qc.setQueryData<CaptainState>(keys.captain(project.id), { ...idleState, busy: true })
    qc.setQueryData(keys.captainCompactions(project.id), [])
    render(createElement("div", null, createElement(Live), createElement(CaptainTab, { project })))
    act(() => {
      FakeEventSource.all.at(-1)!.readyState = 1
      FakeEventSource.all.at(-1)!.onopen?.()
    })

    await send({ type: "captain.delta", projectId: project.id, text: "Looking at", reset: true })
    await send({ type: "captain.delta", projectId: project.id, text: " **the PR**" })
    expect(streaming()!.textContent).toBe("Looking at the PR")
    expect(streaming()!.querySelector("strong")!.textContent).toBe("the PR")
    // Another Captain's text stays in its own chat.
    await send({ type: "captain.delta", projectId: "prj_other1", text: "Elsewhere", reset: true })
    expect(streaming()!.textContent).toBe("Looking at the PR")
    // A new block of text replaces it.
    await send({ type: "captain.delta", projectId: project.id, text: "It's merged.", reset: true })
    expect(streaming()!.textContent).toBe("It's merged.")
    // The stored reply lands: the live text goes.
    await send({ type: "captain.message", message: { id: "cap_reply00001", projectId: project.id, role: "assistant", content: "It's merged.", meta: null, createdAt: Date.now() } })
    expect(streaming()).toBeNull()
    expect(host.textContent).toContain("It's merged.")
  })
})

describe("the Captain's chat box", () => {
  it("asks for its warm process when it takes the focus, at most once a minute", () => {
    for (const k of [keys.tasks, keys.schedules, keys.artifacts, keys.boxes]) qc.setQueryData(k, [])
    qc.setQueryData(keys.projects, [project])
    qc.setQueryData<CaptainMessage[]>(keys.captainMessages(project.id), [])
    qc.setQueryData<CaptainState>(keys.captain(project.id), idleState)
    qc.setQueryData(keys.captainCompactions(project.id), [])
    render(createElement(CaptainTab, { project }))
    const box = host.querySelector("textarea")!
    const pings = () => requests.filter((r) => r.method === "POST" && r.url === `/api/projects/${project.id}/captain/warm`)
    act(() => box.dispatchEvent(new FocusEvent("focus")))
    expect(pings()).toHaveLength(1)
    act(() => box.dispatchEvent(new Event("input", { bubbles: true })))
    act(() => box.dispatchEvent(new FocusEvent("focus")))
    expect(pings()).toHaveLength(1)
  })
})
