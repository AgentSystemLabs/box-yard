// @vitest-environment happy-dom
// OpenCode settings draft/save and task creation regression coverage.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SettingsDialog } from "../web/src/components/SettingsDialog.js"
import { NewTaskDialog } from "../web/src/components/NewTask.js"
import { keys } from "../web/src/lib/queries.js"
import type { SettingsSection } from "../web/src/lib/settingsNav.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { type CursorModelList } from "../shared/agentCli.js"
import type { Settings, SettingsInfo } from "../shared/types"
import type { CredentialKey, CredentialStatus, SetupStatus } from "../shared/setup"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const info = (values: Partial<Settings> = {}): SettingsInfo => ({
  settings: { ...DEFAULT_SETTINGS, ...values },
  sources: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, "default"])) as SettingsInfo["sources"],
  defaults: DEFAULT_SETTINGS,
})

const unset: CredentialStatus = { state: "unset", source: null }
const saved: CredentialStatus = { state: "set", source: "saved" }
function setup(creds: Partial<Record<CredentialKey, CredentialStatus>> = {}): SetupStatus {
  const credentials = { opencodeAuthJson: unset, upstashBoxApiKey: saved, claudeOauthToken: saved, anthropicApiKey: unset, codexAuthJson: unset, codexApiKey: unset, cursorApiKey: unset, githubToken: unset, runpodApiKey: unset, ...creds }
  return {
    ready: true,
    missing: [],
    mock: false,
    credentials,
    boxes: { provider: "upstash", required: true },
    claude: { required: true, state: "set", using: "claudeOauthToken" },
    codex: { required: false, state: "unset", using: null },
    cursor: { state: credentials.cursorApiKey.state },
    github: { state: "unset" },
    owner: { name: "Cody", source: "default" },
    runner: { choice: "box", default: "box" },
    upstash: { available: true },
    local: null,
    restart: [],
  } as SetupStatus
}

const LIVE: CursorModelList = { models: [{ id: "auto", label: "Auto" }], source: "fallback", fetchedAt: null, error: null }

let root: Root
let host: HTMLElement
let qc: QueryClient
let requests: { method: string; url: string; body?: Record<string, unknown> }[]
let models: CursorModelList | Promise<never>

function show(el: ReturnType<typeof createElement>) {
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, el)))
}
function settings(s: SettingsSection) {
  show(createElement(SettingsDialog, { section: s, onSection: (next: SettingsSection) => settings(next), onClose: () => {} }))
}

beforeEach(() => {
  requests = []
  models = LIVE
  history.replaceState(null, "", "/")
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.agentSettings, info())
  qc.setQueryData(keys.health, { provider: "upstash" })
  qc.setQueryData(keys.settings, { defaultTimezone: "UTC", scheduler: "local", maxUploadMb: 20, localDir: "~/boxyard-workspaces" })
  qc.setQueryData(keys.setup, setup())
  qc.setQueryData(keys.tasks, [])
  for (const k of [keys.artifacts, keys.schedules, keys.boxes]) qc.setQueryData(k, [])
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    requests.push({ method, url, body })
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } })
    if (method === "GET" && url === "/api/cursor/models") return models instanceof Promise ? models : json(models)
    if (method === "GET" && url === "/api/cursor/models?refresh=1") return json(LIVE)
    if (method === "PUT" && url === "/api/agent-settings") return json(info(body as Partial<Settings>))
    if (method === "PUT" && url === "/api/setup/credentials") return json(setup({ opencodeAuthJson: saved }))
    if (method === "POST" && url.startsWith("/api/setup/test/")) return json({ ok: true, message: "Cursor accepted the key: 6 models available.", ms: 900 })
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
const button = (label: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)
const choose = async (el: HTMLSelectElement, value: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await settle()
}
const type = (el: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
const saveSettings = async () => {
  for (const f of document.querySelectorAll("form")) f.noValidate = true
  act(() => button("Save")!.click())
  await settle()
}
const sent = (method: string, url: string) => requests.filter((r) => r.method === method && r.url === url).map((r) => r.body)
const groups = (select: HTMLSelectElement) => [...select.querySelectorAll("optgroup")].map((g) => [g.label, [...g.querySelectorAll("option")].map((o) => o.value)])

describe("OpenCode across task settings and creation", () => {
  it("edits independent model defaults as drafts and saves them without changing other harness defaults", async () => {
    settings("agents")
    await choose($<HTMLSelectElement>("agent-cli")!, "opencode")
    type($<HTMLInputElement>("agent-opencode-model")!, "example/model#high")
    expect($("agent-effort")).toBeNull()
    expect(sent("PUT", "/api/agent-settings")).toEqual([])
    await saveSettings()
    expect(sent("PUT", "/api/agent-settings")[0]).toMatchObject({ agentCli: "opencode", agentOpencodeModel: "example/model#high", agentModel: DEFAULT_SETTINGS.agentModel, agentCodexModel: DEFAULT_SETTINGS.agentCodexModel, agentCursorModel: DEFAULT_SETTINGS.agentCursorModel })
  })

  it("holds API login JSON as a credential draft until Save and masks the saved value", async () => {
    settings("credentials")
    const field = document.querySelector<HTMLElement>("[data-credential=opencodeAuthJson]")!
    const input = field.querySelector("textarea")!
    const value = JSON.stringify({ example: { type: "api", key: "example-api-fixture" } })
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(sent("PUT", "/api/setup/credentials")).toEqual([])
    await saveSettings()
    expect(sent("PUT", "/api/setup/credentials")).toEqual([{ opencodeAuthJson: value }])
    expect(field.querySelector("[data-key-masked]")).not.toBeNull()
    expect(document.body.textContent).not.toContain("example-api-fixture")
  })

  it("creates a task with a provider model/variant and no generic effort", async () => {
    qc.setQueryData(keys.agentSettings, info({ agentCli: "opencode", agentOpencodeModel: "example/default" }))
    qc.setQueryData(keys.projects, [{ id: "prj_example", name: "example", agentCli: null, runner: "box", envKeys: [], notes: [] }])
    show(createElement(NewTaskDialog, { projectId: "prj_example", initialPrompt: "Implement a fixture", onCancel: () => {}, onDone: () => {} }))
    await settle()
    const model = $<HTMLInputElement>("new-task-model")!
    expect(model.placeholder).toBe("Default (example/default)")
    expect($<HTMLSelectElement>("new-task-effort")!.disabled).toBe(true)
    type(model, "example/model#high")
    act(() => button("Start task")!.click())
    await settle()
    expect(sent("POST", "/api/tasks")).toHaveLength(1)
    expect(sent("POST", "/api/tasks")[0]).toMatchObject({ model: "example/model#high" })
    expect(sent("POST", "/api/tasks")[0]).not.toHaveProperty("effort")
    expect(sent("GET", "/api/cursor/models")).toHaveLength(0)
  })
})
