// @vitest-environment happy-dom
// Cursor in the web UI: Settings › Box agents' Cursor model (the list the server's cursor-agent gives, where it came
// from, and Refresh), the Cursor API key in Settings › Credentials, a project's Agent, the New task dialog's Cursor
// model, and the "Cursor" chip on tasks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SettingsDialog } from "../web/src/components/SettingsDialog.js"
import { NewTaskDialog } from "../web/src/components/NewTask.js"
import { AgentCliChip } from "../web/src/components/ui.js"
import { keys } from "../web/src/lib/queries.js"
import type { SettingsSection } from "../web/src/lib/settingsNav.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { CURSOR_FALLBACK_MODELS, type CursorModelList } from "../shared/agentCli.js"
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
  const credentials = { upstashBoxApiKey: saved, claudeOauthToken: saved, anthropicApiKey: unset, codexAuthJson: unset, codexApiKey: unset, cursorApiKey: unset, githubToken: unset, runpodApiKey: unset, ...creds }
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

const LIVE: CursorModelList = {
  models: [
    { id: "auto", label: "Auto" },
    { id: "composer-2.5", label: "Composer 2.5" },
    { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 1M High" },
    { id: "gpt-5.6-sol-high", label: "GPT-5.6 Sol 1M High" },
    { id: "gemini-4-argon-high", label: "Gemini 4 Argon High" },
    { id: "kimi-k3-high", label: "Kimi K3 High" },
  ],
  source: "cli",
  fetchedAt: Date.now() - 120_000,
  error: null,
}
const REFRESHED: CursorModelList = { ...LIVE, models: [...LIVE.models, { id: "composer-3", label: "Composer 3" }], fetchedAt: Date.now() }

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
    if (method === "GET" && url === "/api/cursor/models?refresh=1") return json(REFRESHED)
    if (method === "PUT" && url === "/api/agent-settings") return json(info(body as Partial<Settings>))
    if (method === "PUT" && url === "/api/setup/credentials") return json(setup({ cursorApiKey: saved }))
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

describe("Settings › Box agents › Cursor", () => {
  it("offers Cursor as an agent, lists its models from the server's CLI by family, and saves the pick without an Effort", async () => {
    settings("agents")
    const cli = $<HTMLSelectElement>("agent-cli")!
    expect([...cli.options].map((o) => o.textContent)).toEqual(["Claude Code", "Codex", "Cursor"])
    // Its list is only asked for once Cursor is picked.
    expect(sent("GET", "/api/cursor/models")).toEqual([])
    await choose(cli, "cursor")
    expect($("agent-model")).toBeNull()
    expect($("agent-effort")).toBeNull()
    const model = $<HTMLSelectElement>("agent-cursor-model")!
    expect(model.value).toBe("auto")
    expect(model.options[0]!.textContent).toBe("Cursor CLI default")
    expect(groups(model)).toEqual([
      ["Cursor", ["auto", "composer-2.5"]],
      ["Anthropic", ["claude-opus-5-5-high"]],
      ["OpenAI", ["gpt-5.6-sol-high"]],
      ["Google", ["gemini-4-argon-high"]],
      ["Other", ["kimi-k3-high"]],
    ])
    expect($("agent-cursor-model-source")!.textContent).toMatch(/^Listed by cursor-agent on the server .*· 6 models\. The id carries the effort/)

    // Refresh reads the list again.
    act(() => $("agent-cursor-model-refresh")!.click())
    await settle()
    expect(sent("GET", "/api/cursor/models?refresh=1")).toHaveLength(1)
    expect([...$<HTMLSelectElement>("agent-cursor-model")!.options].map((o) => o.value)).toContain("composer-3")

    await choose($<HTMLSelectElement>("agent-cursor-model")!, "gemini-4-argon-high")
    await saveSettings()
    expect(sent("PUT", "/api/agent-settings")[0]).toMatchObject({ agentCli: "cursor", agentCursorModel: "gemini-4-argon-high", agentEffort: DEFAULT_SETTINGS.agentEffort })
  })

  it("says when the list is Box Yard's snapshot, and keeps a saved id the list doesn't have", async () => {
    models = { models: [...CURSOR_FALLBACK_MODELS], source: "fallback", fetchedAt: null, error: "cursor-agent isn't installed on the server (cursor-agent wasn't found)" }
    qc.setQueryData(keys.agentSettings, info({ agentCli: "cursor", agentCursorModel: "composer-1-legacy" }))
    settings("agents")
    await settle()
    const model = $<HTMLSelectElement>("agent-cursor-model")!
    expect(model.value).toBe("composer-1-legacy")
    expect(model.options[1]!.textContent).toBe("composer-1-legacy (saved, not in Cursor's list)")
    expect($("agent-cursor-model-source")!.textContent).toContain("cursor-agent couldn't list them here (cursor-agent isn't installed on the server (cursor-agent wasn't found)), so this is Box Yard's snapshot")
  })

  it("holds its place while the list loads", async () => {
    models = new Promise<never>(() => {})
    qc.setQueryData(keys.agentSettings, info({ agentCli: "cursor" }))
    settings("agents")
    expect($("agent-cursor-model")).toBeNull()
    expect(document.querySelector("[role=status][data-loading]")).not.toBeNull()
  })
})

describe("Settings › Credentials › Cursor", () => {
  const field = () => document.querySelector<HTMLElement>("[data-credential=cursorApiKey]")!

  it("takes the Cursor API key in a password field, tests it unsaved, and saves it with the dialog", async () => {
    settings("credentials")
    expect($("cursor-credentials-intro")!.textContent).toContain("Only for agents set to run on Cursor")
    expect(document.body.textContent).toContain("Integrations › User API Keys")
    const input = field().querySelector("input")!
    expect(input.type).toBe("password")
    type(input, "key_cursor_0000")
    act(() => button("Test", field())!.click())
    await settle()
    expect(sent("POST", "/api/setup/test/cursorApiKey")).toEqual([{ value: "key_cursor_0000" }])
    expect(field().textContent).toContain("Cursor accepted the key")
    expect(sent("PUT", "/api/setup/credentials")).toEqual([])
    await saveSettings()
    expect(sent("PUT", "/api/setup/credentials")).toEqual([{ cursorApiKey: "key_cursor_0000" }])
    expect(field().querySelector("[data-key-masked]")).not.toBeNull()
  })
})

describe("New task › Cursor", () => {
  it("picks a Cursor model from its list and sends no effort", async () => {
    qc.setQueryData(keys.agentSettings, info({ agentCli: "cursor", agentCursorModel: "composer-2.5" }))
    qc.setQueryData(keys.projects, [{ id: "prj_1", name: "app", agentCli: null, runner: "box", envKeys: [], notes: [] }])
    show(createElement(NewTaskDialog, { projectId: "prj_1", onCancel: () => {}, onDone: () => {} }))
    await settle()
    const model = $<HTMLSelectElement>("new-task-model")!
    expect(model.options[0]!.textContent).toBe("Default (composer-2.5)")
    expect($("new-task-model-source")).toBeNull()
    expect(document.body.textContent).toContain("In the model id")
  })
})

describe("a task's agent chip", () => {
  it("says Cursor on a Cursor task, and nothing on Claude Code's", () => {
    show(createElement("div", null, createElement(AgentCliChip, { cli: "cursor" }), createElement(AgentCliChip, { cli: "claude" })))
    expect(host.textContent).toBe("Cursor")
  })
})
