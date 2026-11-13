// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SettingsDialog } from "../web/src/components/SettingsDialog.js"
import { keys } from "../web/src/lib/queries.js"
import { formOf, inputOf, patchOf } from "../web/src/components/Connectors.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { DEFAULT_CONNECTOR_SCOPE, type Connector } from "../shared/connectors"
import { DEFAULT_IDENTITY_ID, type Identity } from "../shared/identities"
import type { Project, Settings, SettingsInfo } from "../shared/types"

// Settings › Connectors follows Settings' rule: nothing saves on change. A new connector, an edit, a pasted token or
// secret, Sign out and Remove are drafts the dialog's Save writes; Sign in and Test act at once, on what's saved, and
// wait while the card has unsaved changes. A secret goes out once, on Save, and never shows again.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PASTED = "ntn_pastedTokenValue0000000000000000"
const CLIENT_SECRET = "GOCSPX-pastedClientSecret000"

const connector = (id: string, name: string, extra: Partial<Connector> = {}): Connector => ({
  id,
  name,
  label: name,
  preset: null,
  kind: "http",
  url: `https://${name}.example/mcp`,
  command: null,
  args: [],
  env: {},
  auth: "token",
  header: { name: "Authorization", prefix: "Bearer " },
  tokenEnv: null,
  oauth: null,
  secrets: [],
  scope: DEFAULT_CONNECTOR_SCOPE,
  enabled: true,
  status: "untested",
  statusDetail: null,
  lastTest: null,
  sealedSkipped: [],
  createdAt: 1,
  updatedAt: 1,
  ...extra,
})

const linear = () =>
  connector("con_linear", "linear", {
    label: "Linear",
    status: "connected",
    secrets: [{ name: "token", fingerprint: "ab12cd34ef56", readable: true, expiresAt: null, savedAt: 1 }],
    scope: { sessions: ["coordinator", "captain"], projects: ["prj_app", "prj_vault"], runners: ["local"] },
    sealedSkipped: ["prj_vault"],
    lastTest: { at: Date.now() - 60_000, ok: true, tools: [{ name: "list_issues", description: "Issues" }, { name: "create_issue", description: "New issue" }], error: null },
  })
const notion = () =>
  connector("con_notion", "notion", {
    label: "Notion",
    auth: "oauth",
    status: "needs_auth",
    statusDetail: "Not signed in: press Sign in.",
    oauth: { clientKind: "dynamic", clientId: null, hasClientSecret: false, issuer: null, signInHost: "mcp.notion.com", scopes: [], grantedScopes: null, authParams: {}, refreshable: false, expiresAt: null, redirectUri: null, signedInAt: null },
  })

const identity = (id: string, coordinatorSees: Identity["coordinatorSees"]) => ({ id, name: id, coordinatorSees }) as unknown as Identity
const project = (id: string, name: string, identityId = DEFAULT_IDENTITY_ID) => ({ id, name, repo: `acme/${name}`, identityId }) as unknown as Project

const settingsInfo = (values: Partial<Settings> = {}): SettingsInfo => ({
  settings: { ...DEFAULT_SETTINGS, ...values },
  sources: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, "default"])) as SettingsInfo["sources"],
  defaults: DEFAULT_SETTINGS,
})

let root: Root
let host: HTMLElement
let qc: QueryClient
let requests: { method: string; url: string; body?: unknown }[]

function render() {
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(SettingsDialog, { section: "connectors", onSection: () => {}, onClose: () => {} }))))
}

beforeEach(() => {
  requests = []
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.agentSettings, settingsInfo())
  qc.setQueryData(keys.health, { provider: "local" })
  qc.setQueryData(keys.connectors, [linear(), notion()])
  qc.setQueryData(keys.identities, [identity(DEFAULT_IDENTITY_ID, "everything"), identity("idn_vault", "status")])
  qc.setQueryData(keys.projects, [project("prj_app", "app"), project("prj_vault", "vault", "idn_vault")])
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, url, body })
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })
    if (method === "POST" && url === "/api/connectors") return json(connector("con_new", body.name, body), 201)
    if (method === "PATCH" && url === "/api/connectors/con_linear") return json({ ...linear(), ...body })
    if (method === "PUT" && /^\/api\/connectors\/con_\w+\/(token|client-secret|env\/\w+)$/.test(url)) return json(linear())
    if (method === "POST" && url === "/api/connectors/con_linear/test") return json({ ...linear(), lastTest: { at: Date.now(), ok: false, tools: [], error: "401 Unauthorized" }, status: "needs_auth" })
    if (method === "POST" && /\/test$/.test(url)) return json(linear())
    if (method === "POST" && url === "/api/connectors/con_notion/oauth/start")
      return json({ authorizeUrl: "https://mcp.notion.com/authorize?state=s1", redirectUri: "http://127.0.0.1:3000/api/connectors/oauth/callback", mode: "paste", signInHost: "mcp.notion.com", note: null })
    if (method === "POST" && url === "/api/connectors/oauth/complete") return json({ ...notion(), status: "connected" })
    if (method === "DELETE" && url === "/api/connectors/con_linear") return json({ ok: true })
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
})

const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
const buttons = (label: string) => [...document.querySelectorAll("button")].filter((b) => b.textContent?.trim() === label)
const saveButton = () => {
  for (const f of document.querySelectorAll("form")) f.noValidate = true
  return buttons("Save")[0]!
}
const card = (name: string) => document.querySelector<HTMLElement>(`[data-connector-card="${name}"]`)!
const unsaved = () => document.querySelector("[data-testid=unsaved-count]")?.textContent ?? null
const writes = () => requests.filter((r) => r.method !== "GET")
const click = async (el: Element | null | undefined) => {
  act(() => (el as HTMLElement).click())
  await settle()
}
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value)
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
  })
  await settle()
}
const choose = async (el: HTMLSelectElement, value: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await settle()
}
const q = <T extends Element = HTMLInputElement>(el: ParentNode, testId: string) => el.querySelector<T>(`[data-testid=${testId}]`)!

describe("Settings › Connectors", () => {
  it("shows each connector's server, sign-in, who gets it and its last test, with fingerprints only", async () => {
    render()
    await settle()
    const text = card("linear").textContent!
    expect(text).toContain("https://linear.example/mcp")
    expect(text).toContain("ab12cd34ef56")
    expect(text).toContain("Coordinator, Captains · app, vault")
    expect(text).toContain("Not vault: it shows the Coordinator status only.")
    expect(text).toContain("2 tools")
    expect(text).toContain("list_issues")
    expect(card("notion").textContent).toContain("not signed in yet")
    expect(card("notion").querySelector("[data-connector-status=needs_auth]")).not.toBeNull()
  })

  it("a new connector and its token are a draft until Save, which creates it, sends the token once and tests it", async () => {
    render()
    await settle()
    await click(q(document, "connector-add"))
    const fresh = card("new")
    await type(q(fresh, "connector-label"), "My Docs")
    expect(q(fresh, "connector-name").value).toBe("my-docs")
    await type(q(fresh, "connector-url"), "https://docs.example/mcp")
    await choose(q<HTMLSelectElement>(fresh, "connector-auth"), "token")
    const token = q(card("new"), "connector-token")
    expect(token.matches("[data-secret]")).toBe(true)
    await type(token, PASTED)
    expect(writes()).toEqual([])
    expect(unsaved()).toBe("1 unsaved change")

    await click(saveButton())
    expect(writes()).toEqual([
      {
        method: "POST",
        url: "/api/connectors",
        body: { name: "my-docs", label: "My Docs", kind: "http", auth: "token", scope: DEFAULT_CONNECTOR_SCOPE, enabled: true, url: "https://docs.example/mcp", header: { name: "Authorization", prefix: "Bearer " } },
      },
      { method: "PUT", url: "/api/connectors/con_new/token", body: { value: PASTED } },
      { method: "POST", url: "/api/connectors/con_new/test", body: undefined },
    ])
    expect(unsaved()).toBeNull()
    expect(document.body.innerHTML).not.toContain(PASTED)
  })

  it("an edit holds Sign in and Test back until Save, then sends only what changed", async () => {
    render()
    await settle()
    await click(q(card("linear"), "connector-edit"))
    await click(q(card("linear"), "connector-session-agent"))
    expect(q<HTMLButtonElement>(card("linear"), "connector-test").disabled).toBe(true)
    expect(card("linear").textContent).toContain("unsaved")
    // The status-only project can't be added while the Coordinator gets it too.
    const vault = [...card("linear").querySelectorAll("label")].find((l) => l.textContent?.includes("vault"))!
    expect(vault.textContent).toContain("status only")
    expect(writes()).toEqual([])

    await click(saveButton())
    expect(writes()).toEqual([{ method: "PATCH", url: "/api/connectors/con_linear", body: { scope: { sessions: ["coordinator", "captain", "agent"], projects: ["prj_app", "prj_vault"], runners: ["local"] } } }])
    expect(q<HTMLButtonElement>(card("linear"), "connector-test").disabled).toBe(false)
  })

  it("Remove is a draft: Keep it undoes it, Save deletes it", async () => {
    render()
    await settle()
    await click(q(card("linear"), "connector-edit"))
    await click(q(card("linear"), "connector-remove"))
    expect(card("linear").textContent).toContain("Removed when you save")
    await click(buttons("Keep it")[0])
    expect(unsaved()).toBeNull()
    // Back to the open form it was removed from.
    await click(q(card("linear"), "connector-remove"))
    expect(writes()).toEqual([])
    await click(saveButton())
    expect(writes()).toEqual([{ method: "DELETE", url: "/api/connectors/con_linear", body: undefined }])
  })

  it("Sign in opens the provider's page and takes the address it lands on back (paste mode)", async () => {
    render()
    await settle()
    await click(q(card("notion"), "connector-sign-in"))
    await click(q(card("notion"), "connector-sign-in-start"))
    expect(writes()).toEqual([{ method: "POST", url: "/api/connectors/con_notion/oauth/start", body: { origin: window.location.origin } }])
    const open = q<HTMLAnchorElement>(card("notion"), "connector-sign-in-open")
    expect(open.href).toBe("https://mcp.notion.com/authorize?state=s1")
    expect(open.target).toBe("_blank")
    await type(q(card("notion"), "connector-sign-in-paste"), "http://127.0.0.1:3000/api/connectors/oauth/callback?code=c1&state=s1")
    await click(q(card("notion"), "connector-sign-in-finish"))
    expect(writes().at(-1)).toEqual({ method: "POST", url: "/api/connectors/oauth/complete", body: { url: "http://127.0.0.1:3000/api/connectors/oauth/callback?code=c1&state=s1" } })
  })

  it("Test runs at once and shows why it failed", async () => {
    render()
    await settle()
    await click(q(card("linear"), "connector-test"))
    expect(writes()).toEqual([{ method: "POST", url: "/api/connectors/con_linear/test", body: undefined }])
    expect(card("linear").textContent).toContain("401 Unauthorized")
  })

  it("an own OAuth client's secret is write-only and goes out once, on Save", async () => {
    render()
    await settle()
    await click(q(document, "connector-add"))
    await type(q(card("new"), "connector-label"), "Mail")
    await choose(q<HTMLSelectElement>(card("new"), "connector-kind"), "stdio")
    await type(q(card("new"), "connector-command"), "mail-mcp")
    await choose(q<HTMLSelectElement>(card("new"), "connector-auth"), "oauth")
    await choose(q<HTMLSelectElement>(card("new"), "connector-client-kind"), "desktop")
    await type(q(card("new"), "connector-client-id"), "123-abc.apps.googleusercontent.com")
    await type(q(card("new"), "connector-client-secret"), CLIENT_SECRET)
    expect(writes()).toEqual([])
    await click(saveButton())
    const [create, secret] = writes()
    expect(create.body).toMatchObject({ name: "mail", kind: "stdio", command: "mail-mcp", auth: "oauth", oauth: { clientKind: "desktop", clientId: "123-abc.apps.googleusercontent.com" } })
    expect(JSON.stringify(create.body)).not.toContain(CLIENT_SECRET)
    expect(secret).toEqual({ method: "PUT", url: "/api/connectors/con_new/client-secret", body: { value: CLIENT_SECRET } })
    expect(document.body.innerHTML).not.toContain(CLIENT_SECRET)
  })
})

describe("connector drafts", () => {
  it("send only the fields a kind and sign-in use, and a PATCH of what changed", () => {
    const saved = formOf(linear())
    expect(inputOf(saved)).not.toHaveProperty("command")
    expect(inputOf(saved)).not.toHaveProperty("oauth")
    expect(patchOf(saved, { ...saved, label: "Linear (work)" })).toEqual({ label: "Linear (work)" })
    // Switching away from OAuth clears it.
    const n = formOf(notion())
    expect(patchOf(n, { ...n, auth: "none" })).toEqual({ auth: "none", oauth: null })
    expect(() => inputOf({ ...formOf(null), kind: "stdio", env: "NOT A PAIR" })).toThrow(/NAME=value/)
  })
})
