// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SettingsDialog } from "../web/src/components/SettingsDialog.js"
import { keys } from "../web/src/lib/queries.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import type { Settings, SettingSource, SettingsInfo } from "../shared/types"

// Settings › Box providers › Upstash boxes: agents and task folders per box show the size defaults while nothing
// overrides them, a value saved here gets "Use size default" (which forgets only that key), and an env value says
// how to remove it. Settings › Boxes & limits keeps this computer's and SSH machines' cleanup.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function info(values: Partial<Settings> = {}, from: Partial<Record<keyof Settings, SettingSource>> = {}): SettingsInfo {
  const sources = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, from[k as keyof Settings] ?? "default"])) as SettingsInfo["sources"]
  return { settings: { ...DEFAULT_SETTINGS, ...values }, sources, defaults: DEFAULT_SETTINGS }
}

let root: Root
let host: HTMLElement
let requests: { method: string; url: string; body?: unknown }[]
let replies: Record<string, SettingsInfo>

function render(start: SettingsInfo, section: "limits" | "upstash" = "upstash") {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.agentSettings, start)
  qc.setQueryData(keys.health, { provider: "local" })
  qc.setQueryData(keys.settings, { defaultTimezone: "UTC", scheduler: "local", maxUploadMb: 20, localDir: "/Volumes/fast/agents" })
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(SettingsDialog, { section, onSection: () => {}, onClose: () => {} }))))
}

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

const field = (k: string) => document.querySelector<HTMLInputElement>(`[data-testid=limit-${k}]`)!
const button = (k: string) => document.querySelector<HTMLButtonElement>(`[data-testid=use-size-default-${k}]`)
const envNote = (k: string) => document.querySelector(`[data-testid=env-note-${k}]`)
// Upstash boxes also reads the key's status (GET /api/setup): only writes count here.
const MODELS_ONLY = [{ method: "GET", url: "/api/models", body: undefined }]
const writes = () => requests.filter((r) => r.method !== "GET")
const saveButton = () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Save")!

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))

describe("box limit fields", () => {
  it("show every size's default and no button while nothing overrides them", () => {
    render(info())
    expect(field("slotsPerBox").value).toBe("")
    expect(field("slotsPerBox").placeholder).toBe("small 1 · medium 2 · large 4")
    expect(field("maxResidentPerBox").placeholder).toBe("small 3 · medium 8 · large 18")
    expect(button("slotsPerBox")).toBeNull()
    expect(envNote("slotsPerBox")).toBeNull()
  })

  it("offer \"Use size default\" for a saved value, which resets only that key on Save", async () => {
    render(info({ slotsPerBox: 2, maxResidentPerBox: 6 }, { slotsPerBox: "ui", maxResidentPerBox: "ui" }))
    expect(field("slotsPerBox").value).toBe("2")
    expect(button("slotsPerBox")).not.toBeNull()
    expect(button("maxResidentPerBox")).not.toBeNull()

    replies["DELETE /api/agent-settings?keys=slotsPerBox"] = info({ maxResidentPerBox: 6 }, { maxResidentPerBox: "ui" })
    act(() => button("slotsPerBox")!.click())
    await settle()
    // A draft like any other change: the size defaults show, marked unsaved, and nothing is sent yet.
    expect(writes()).toEqual([])
    expect(field("slotsPerBox").value).toBe("")
    expect(field("slotsPerBox").placeholder).toBe("small 1 · medium 2 · large 4")
    expect(saveButton().disabled).toBe(false)
    act(() => saveButton().click())
    await settle()
    expect(writes().map((r) => `${r.method} ${r.url}`)).toEqual(["DELETE /api/agent-settings?keys=slotsPerBox"])
    expect(saveButton().disabled).toBe(true)
    expect(button("slotsPerBox")).toBeNull()
    expect(field("slotsPerBox").value).toBe("")
    expect(field("slotsPerBox").placeholder).toBe("small 1 · medium 2 · large 4")
    // The other saved limit is untouched.
    expect(field("maxResidentPerBox").value).toBe("6")
    expect(button("maxResidentPerBox")).not.toBeNull()
  })

  it("hide the button while the value is being edited", () => {
    render(info({ slotsPerBox: 2 }, { slotsPerBox: "ui" }))
    type(field("slotsPerBox"), "3")
    expect(button("slotsPerBox")).toBeNull()
  })

  it("explain how to remove an env override instead of offering a button", () => {
    render(info({ slotsPerBox: 2 }, { slotsPerBox: "env" }))
    expect(field("slotsPerBox").value).toBe("2")
    expect(button("slotsPerBox")).toBeNull()
    expect(envNote("slotsPerBox")!.textContent).toContain("remove BOX_SLOTS from .env (and from the shell or deploy env) and restart")
    expect(envNote("maxResidentPerBox")).toBeNull()
  })

  it("save a number typed over the size default, even one that matches it", async () => {
    render(info())
    type(field("slotsPerBox"), "1")
    expect(field("slotsPerBox").value).toBe("1")
    replies["PUT /api/agent-settings"] = info({ slotsPerBox: 1 }, { slotsPerBox: "ui" })
    act(() => saveButton().click())
    await settle()
    const put = requests.find((r) => r.method === "PUT")!
    expect(put.body).toMatchObject({ slotsPerBox: 1 })
    expect(put.body).not.toHaveProperty("maxResidentPerBox")
  })

  it("drop the edit when the field is emptied", () => {
    render(info())
    type(field("slotsPerBox"), "3")
    type(field("slotsPerBox"), "")
    act(() => field("slotsPerBox").dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
    expect(field("slotsPerBox").value).toBe("")
    expect(saveButton().disabled).toBe(true)
  })

  it("say where local tasks work, from the server (BOXYARD_LOCAL_DIR)", () => {
    render(info(), "limits")
    expect(document.body.textContent).toContain("Each task works in its own folder in /Volumes/fast/agents (BOXYARD_LOCAL_DIR).")
    // The only request is the model list the dialog reads to name models in its hints ("Uses Opus 5.5."): nothing is written.
    expect(requests).toEqual(MODELS_ONLY)
  })
})

describe("this computer's cleanup fields", () => {
  const input = (id: string) => document.querySelector<HTMLInputElement>(`[data-testid=${id}]`)!

  it("show the laptop defaults under their own heading", () => {
    render(info(), "limits")
    expect(document.querySelector("[data-testid=limits-own-computers]")!.textContent).toContain("This computer and SSH machines")
    expect(input("local-folders-kept").value).toBe("10")
    expect(input("local-build-cleanup").checked).toBe(true)
    // A task that isn't done never loses its build output on a timer, so there's no idle-hours field.
    expect(document.querySelector("[data-testid=local-build-cleanup-hours]")).toBeNull()
    expect(input("local-disk-min-free").value).toBe("30")
    expect(document.body.textContent).toContain("Most task folders in /Volumes/fast/agents")
  })

  it("are drafts until Save, which sends only what changed", async () => {
    render(info(), "limits")
    type(input("local-folders-kept"), "4")
    type(input("local-disk-min-free"), "50")
    act(() => input("local-build-cleanup").click())
    await settle()
    // The only request is the model list the dialog reads to name models in its hints ("Uses Opus 5.5."): nothing is written.
    expect(requests).toEqual(MODELS_ONLY)
    replies["PUT /api/agent-settings"] = info({ localFoldersKept: 4, localDiskMinFreeGb: 50, localBuildCleanup: false }, { localFoldersKept: "ui", localDiskMinFreeGb: "ui", localBuildCleanup: "ui" })
    act(() => saveButton().click())
    await settle()
    const put = requests.find((r) => r.method === "PUT")!
    expect(put.body).toMatchObject({ localFoldersKept: 4, localDiskMinFreeGb: 50, localBuildCleanup: false })
    expect(put.body).not.toHaveProperty("localBuildCleanupIdleHours")
  })
})

describe("Upstash box size", () => {
  it("is a card per size on Upstash boxes, a draft until Save", async () => {
    render(info())
    const card = (z: string) => document.querySelector<HTMLButtonElement>(`[data-size="upstash:${z}"]`)!
    expect(card("small").getAttribute("aria-checked")).toBe("true")
    expect(card("medium").textContent).toContain("4 vCPU · 8 GB RAM · 20 GB disk")
    act(() => card("medium").click())
    expect(card("medium").getAttribute("aria-checked")).toBe("true")
    expect(writes()).toEqual([])
    replies["PUT /api/agent-settings"] = info({ workerSize: "medium" }, { workerSize: "ui" })
    act(() => saveButton().click())
    await settle()
    expect(requests.find((r) => r.method === "PUT")!.body).toMatchObject({ workerSize: "medium" })
  })

  it("is no longer on Boxes & limits", () => {
    render(info(), "limits")
    expect(document.querySelector("[data-size^=upstash]")).toBeNull()
    expect(document.querySelector("[data-testid=limit-slotsPerBox]")).toBeNull()
    expect(document.querySelector("[data-testid=max-boxes]")).not.toBeNull()
  })
})
