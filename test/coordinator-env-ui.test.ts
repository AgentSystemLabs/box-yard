// @vitest-environment happy-dom
// Settings › Coordinator › Env vars: the Coordinator's own env vars, like a project's. Saved ones show by name only
// (their values never come back), a new one is a name and a masked value, and nothing is written until Save.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SettingsDialog } from "../web/src/components/SettingsDialog.js"
import { envClaudeLogin, envDraftChanges, envDraftProblem } from "../web/src/components/CoordinatorEnv.js"
import { keys } from "../web/src/lib/queries.js"
import { currentConfirm, settleConfirm } from "../web/src/lib/confirm.js"
import type { SettingsSection } from "../web/src/lib/settingsNav.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import type { CoordinatorEnvInfo, Settings, SettingsInfo } from "../shared/types"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settingsInfo = (values: Partial<Settings> = {}): SettingsInfo => ({
  settings: { ...DEFAULT_SETTINGS, ...values },
  sources: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, "default"])) as SettingsInfo["sources"],
  defaults: DEFAULT_SETTINGS,
})

let root: Root
let host: HTMLElement
let qc: QueryClient
let requests: { method: string; url: string; body?: unknown }[]
/** What the fake server holds: the browser only ever sees the names. */
let saved: Record<string, string>
let section: SettingsSection

const info = (): CoordinatorEnvInfo => {
  const names = Object.keys(saved).sort()
  return { keys: names, claudeLogin: (["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const).find((k) => names.includes(k)) ?? null }
}

function render(values: Partial<Settings> = {}) {
  qc.setQueryData(keys.agentSettings, settingsInfo(values))
  act(() =>
    root.render(
      createElement(QueryClientProvider, { client: qc }, createElement(SettingsDialog, { section, onSection: (s: SettingsSection) => void (section = s), onClose: () => {} })),
    ),
  )
}

beforeEach(() => {
  requests = []
  saved = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-saved", HTTPS_PROXY: "http://proxy.example.com" }
  section = "orchestrator"
  localStorage.clear()
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.health, { provider: "local" })
  qc.setQueryData(keys.settings, { defaultTimezone: "UTC", scheduler: "local", maxUploadMb: 20, localDir: "/tmp/agents" })
  qc.setQueryData(keys.coordinatorEnv, info())
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, url, body })
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })
    if (url === "/api/orchestrator/env" && method === "PATCH") {
      if (Object.keys(body.env ?? {}).some((k) => k === "REFUSED_BY_SERVER")) return json({ error: "The server said no" }, 400)
      for (const k of body.removeEnv ?? []) delete saved[k]
      Object.assign(saved, body.env ?? {})
      return json(info())
    }
    if (url === "/api/orchestrator/env") return json(info())
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
  vi.restoreAllMocks()
  while (currentConfirm()) settleConfirm(currentConfirm()!.id, false)
})

const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
const editor = () => document.querySelector<HTMLElement>("[data-testid=coordinator-env]")!
const nameField = () => document.querySelector<HTMLInputElement>("[data-testid=coordinator-env-name]")!
const valueField = () => document.querySelector<HTMLInputElement>("[data-testid=coordinator-env-value]")!
const listed = () => [...editor().querySelectorAll<HTMLElement>("[data-env-key]")].map((li) => li.dataset.envKey)
const loginLine = () => document.querySelector("[data-testid=coordinator-env-login]")!.textContent
const problem = () => document.querySelector("[data-testid=coordinator-env-problem]")?.textContent ?? null
const unsaved = () => document.querySelector("[data-testid=unsaved-count]")?.textContent ?? null
const writes = () => requests.filter((r) => r.method !== "GET")
const button = (label: string, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label)
const saveButton = () => {
  // happy-dom misreads a range input's step as a step mismatch, which would block the form's submit.
  for (const f of document.querySelectorAll("form")) f.noValidate = true
  return button("Save")!
}
const click = async (el: Element | null | undefined) => {
  act(() => (el as HTMLElement).click())
  await settle()
}
/** Types as a person does: SecretInput ignores a change with no inputType (what a browser's autofill sends). */
const type = async (el: HTMLInputElement, value: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value)
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
  })
  await settle()
}

describe("the Coordinator's env vars in Settings", () => {
  it("lists the saved names, never a value, and says which one logs it in", () => {
    render()
    expect(listed()).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "HTTPS_PROXY"])
    expect(editor().querySelector("[data-env-key=CLAUDE_CODE_OAUTH_TOKEN]")!.textContent).toContain("Claude login")
    expect(editor().querySelector("[data-env-key=HTTPS_PROXY]")!.textContent).not.toContain("Claude login")
    expect(document.body.innerHTML).not.toContain("sk-ant-oat01-saved")
    expect(loginLine()).toContain("It logs in with CLAUDE_CODE_OAUTH_TOKEN from here, from its next run.")
    // The new value's field is a masked text field, never type=password (which browsers fill with a saved password).
    expect(valueField().matches("[data-secret]")).toBe(true)
    expect(valueField().type).not.toBe("password")
    expect(nameField().getAttribute("autocomplete")).toBe("off")
    // Its row's label points at the name field.
    expect(document.querySelector<HTMLLabelElement>(`label[for="${nameField().id}"]`)?.textContent).toContain("Env vars")
  })

  it("adds a Claude token as a draft, and Save sends the name and value once; the value is gone after", async () => {
    saved = { HTTPS_PROXY: "http://proxy.example.com" }
    qc.setQueryData(keys.coordinatorEnv, info())
    render()
    expect(loginLine()).toContain("No Claude token here: it logs in with a rotation login or Settings › Credentials")
    await type(nameField(), "ANTHROPIC_API_KEY")
    await type(valueField(), "  sk-ant-api03-new  ")
    expect(writes()).toEqual([])
    expect(unsaved()).toBe("1 unsaved change")
    expect(loginLine()).toContain("Once saved, it logs in with ANTHROPIC_API_KEY")
    await click(saveButton())
    expect(writes()).toEqual([{ method: "PATCH", url: "/api/orchestrator/env", body: { env: { ANTHROPIC_API_KEY: "sk-ant-api03-new" } } }])
    expect(listed()).toEqual(["ANTHROPIC_API_KEY", "HTTPS_PROXY"])
    expect(nameField().value).toBe("")
    expect(valueField().value).toBe("")
    expect(document.body.innerHTML).not.toContain("sk-ant-api03-new")
    expect(unsaved()).toBeNull()
    expect(loginLine()).toContain("It logs in with ANTHROPIC_API_KEY")
  })

  it("Remove marks a saved var for Save, Keep takes it back, and Save removes it", async () => {
    render()
    await click(button("Remove CLAUDE_CODE_OAUTH_TOKEN", editor()))
    expect(editor().querySelector("[data-env-key=CLAUDE_CODE_OAUTH_TOKEN]")!.textContent).toContain("removed on Save")
    expect(unsaved()).toBe("1 unsaved change")
    expect(loginLine()).toContain("Once saved, no Claude token here")
    await click(button("Keep CLAUDE_CODE_OAUTH_TOKEN", editor()))
    expect(unsaved()).toBeNull()
    await click(button("Remove CLAUDE_CODE_OAUTH_TOKEN", editor()))
    await click(saveButton())
    expect(writes()).toEqual([{ method: "PATCH", url: "/api/orchestrator/env", body: { removeEnv: ["CLAUDE_CODE_OAUTH_TOKEN"] } }])
    expect(listed()).toEqual(["HTTPS_PROXY"])
    expect(loginLine()).toContain("No Claude token here")
  })

  it("won't save a half-typed var or a BOXYARD_* one, and says why", async () => {
    render()
    await type(nameField(), "BOXYARD_SECRET_KEY")
    expect(problem()).toContain("BOXYARD_* vars are Box Yard's own")
    await click(saveButton())
    expect(writes()).toEqual([])
    await type(nameField(), "MY-VAR")
    expect(problem()).toContain("Env var names must be like MY_VAR")
    await type(nameField(), "MY_VAR")
    expect(problem()).toContain("Give MY_VAR a value")
    expect(valueField().getAttribute("aria-invalid")).toBe("true")
    await click(saveButton())
    expect(writes()).toEqual([])
    await type(valueField(), "my-value-1")
    expect(problem()).toBeNull()
    await click(saveButton())
    expect(writes()).toEqual([{ method: "PATCH", url: "/api/orchestrator/env", body: { env: { MY_VAR: "my-value-1" } } }])
  })

  it("names a replaced var, and keeps the draft when the server refuses it", async () => {
    render()
    await type(nameField(), "HTTPS_PROXY")
    expect(valueField().placeholder).toBe("New value for HTTPS_PROXY")
    expect(editor().textContent).toContain("Save replaces the saved HTTPS_PROXY.")
    await type(nameField(), "REFUSED_BY_SERVER")
    await type(valueField(), "anything-1")
    await click(saveButton())
    expect(document.body.textContent).toContain("The server said no")
    expect(nameField().value).toBe("REFUSED_BY_SERVER")
    expect(listed()).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "HTTPS_PROXY"])
  })

  it("says Codex runs don't get them when the Coordinator runs on Codex", () => {
    render({ orchestratorCli: "codex" })
    expect(loginLine()).toContain("It runs on Codex now, which doesn’t get these.")
  })

  it("shows a skeleton while they load", () => {
    qc.removeQueries({ queryKey: keys.coordinatorEnv })
    render()
    expect(editor()).toBeNull()
    // The row is there (its label and help); only its control waits, as a still field-shaped skeleton.
    const label = [...document.querySelectorAll("label")].find((l) => l.textContent === "Env vars")!
    expect(label.closest(".grid")!.querySelector("[role=status][data-loading]")).not.toBeNull()
  })
})

describe("the env var draft", () => {
  const draft = (name = "", value = "", remove: string[] = []) => ({ name, value, remove })

  it("counts each removal and the new var", () => {
    expect(envDraftChanges(draft())).toBe(0)
    expect(envDraftChanges(draft("A"))).toBe(1)
    expect(envDraftChanges(draft("A", "b", ["X", "Y"]))).toBe(3)
  })

  it("has no problem when untouched", () => {
    expect(envDraftProblem(draft())).toBeNull()
    expect(envDraftProblem(draft("", "value"))).toMatchObject({ field: "name" })
    expect(envDraftProblem(draft("boxyard_x", "v"))).toMatchObject({ field: "name" })
  })

  it("picks the login as the server does: the strongest Claude var left", () => {
    expect(envClaudeLogin(["CLAUDE_CODE_OAUTH_TOKEN"], draft("ANTHROPIC_API_KEY", "k"))).toBe("ANTHROPIC_API_KEY")
    expect(envClaudeLogin(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"], draft("", "", ["ANTHROPIC_API_KEY"]))).toBe("CLAUDE_CODE_OAUTH_TOKEN")
    expect(envClaudeLogin(["CLAUDE_CODE_OAUTH_TOKEN"], draft("ANTHROPIC_API_KEY", ""))).toBe("CLAUDE_CODE_OAUTH_TOKEN")
    expect(envClaudeLogin([], draft())).toBeNull()
  })
})
