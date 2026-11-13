// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SettingsDialog } from "../web/src/components/SettingsDialog.js"
import { keys } from "../web/src/lib/queries.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { DEFAULT_CONNECTOR_SCOPE, type Connector } from "../shared/connectors"
import { GMAIL_COMMAND, GMAIL_SCOPES } from "../shared/connectorPresets"
import { DEFAULT_IDENTITY_ID, type Identity } from "../shared/identities"
import type { Project, Settings, SettingsInfo } from "../shared/types"

// Settings › Connectors' Gmail preset: Add Gmail opens a card with the Google Cloud steps, the user's own client goes in
// by file, paste or typing, and Save creates the preset's connector and sends the client secret once. Box Yard's own
// server runs on this computer only, so its agents can't be put on another runner.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

const CLIENT_FILE = JSON.stringify({ installed: { client_id: "987-desk.apps.googleusercontent.com", project_id: "my-mail", client_secret: CLIENT_SECRET, redirect_uris: ["http://localhost"] } })

/** Pick a file in a file input, the way a browser reports it. */
const pickFile = async (input: HTMLInputElement, name: string, text: string) => {
  const file = new File([text], name, { type: "application/json" })
  Object.defineProperty(input, "files", { value: [file], configurable: true })
  act(() => void input.dispatchEvent(new Event("change", { bubbles: true })))
  await settle()
}

describe("Settings › Connectors › Gmail", () => {
  it("Add Gmail shows the Google setup steps, and Save creates the preset's connector with the user's own client", async () => {
    render()
    await settle()
    await click(q(document, "connector-add-gmail"))
    const fresh = card("new")
    const guide = fresh.querySelector<HTMLDetailsElement>("[data-gmail-guide]")!
    expect(guide.open).toBe(true)
    const steps = guide.textContent!
    for (const step of ["Gmail API", "External", `can't contain "Google" or "Gmail"`, "privacy policy", "Publish app", "In production", "expires the sign-in after 7 days", "Desktop app", "Download JSON"]) expect(steps).toContain(step)
    expect(steps).not.toMatch(/Cody/)
    // No Kind, command or sign-in server to fill in: the preset's.
    expect(fresh.querySelector("[data-testid=connector-kind]")).toBeNull()
    expect(fresh.querySelector("[data-testid=connector-command]")).toBeNull()

    await pickFile(q(fresh, "gmail-client-file"), "client_secret_987-desk.apps.googleusercontent.com.json", CLIENT_FILE)
    expect(q(card("new"), "connector-client-id").value).toBe("987-desk.apps.googleusercontent.com")
    expect(q(card("new"), "gmail-client-picked").textContent).toContain("sent when you save")
    expect(writes()).toEqual([])
    // The secret waits in the masked secret field, unsent and unshown, until Save.
    const secretField = q(card("new"), "connector-client-secret")
    expect([secretField.matches("[data-secret]"), secretField.value]).toEqual([true, CLIENT_SECRET])
    expect(card("new").textContent).not.toContain(CLIENT_SECRET)

    await click(saveButton())
    const [create, secret] = writes()
    expect(create).toEqual({
      method: "POST",
      url: "/api/connectors",
      body: {
        preset: "gmail",
        name: "gmail",
        label: "Gmail",
        kind: "stdio",
        auth: "oauth",
        scope: DEFAULT_CONNECTOR_SCOPE,
        enabled: true,
        command: GMAIL_COMMAND,
        args: [],
        env: {},
        tokenEnv: "GOOGLE_ACCESS_TOKEN",
        oauth: { clientKind: "desktop", clientId: "987-desk.apps.googleusercontent.com", issuer: "https://accounts.google.com", scopes: [...GMAIL_SCOPES], authParams: { access_type: "offline", prompt: "consent" } },
      },
    })
    expect(secret).toEqual({ method: "PUT", url: "/api/connectors/con_new/client-secret", body: { value: CLIENT_SECRET } })
    expect(document.body.innerHTML).not.toContain(CLIENT_SECRET)
  })

  it("takes the client file pasted too, and says when it isn't one", async () => {
    render()
    await settle()
    await click(q(document, "connector-add-gmail"))
    await click(buttons("paste its contents")[0])
    await type(q<HTMLTextAreaElement>(card("new"), "gmail-client-paste"), '{"type":"service_account"}')
    await click(q(card("new"), "gmail-client-paste-use"))
    expect(card("new").textContent).toContain("isn't a Google OAuth client file")
    await type(q<HTMLTextAreaElement>(card("new"), "gmail-client-paste"), CLIENT_FILE)
    await click(q(card("new"), "gmail-client-paste-use"))
    expect(q(card("new"), "connector-client-id").value).toBe("987-desk.apps.googleusercontent.com")
    // Read only: no drafts scope.
    await click(q(card("new"), "gmail-drafts"))
    await click(saveButton())
    expect((writes()[0]!.body as { oauth: { scopes: string[] } }).oauth.scopes).toEqual(["https://www.googleapis.com/auth/gmail.readonly"])
  })

  it("keeps a Gmail connector's agents on this computer, and a second Gmail gets its own name", async () => {
    qc.setQueryData(keys.connectors, [connector("con_gmail", "gmail", { label: "Gmail", preset: "gmail", kind: "stdio", url: null, command: GMAIL_COMMAND, auth: "oauth", tokenEnv: "GOOGLE_ACCESS_TOKEN" })])
    render()
    await settle()
    expect(card("gmail").textContent).toContain("Box Yard's own Gmail server, on this computer")
    await click(q(card("gmail"), "connector-edit"))
    await click(q(card("gmail"), "connector-session-agent"))
    expect(q(card("gmail"), "connector-runner-local").disabled).toBe(false)
    expect(q(card("gmail"), "connector-runner-box").disabled).toBe(true)
    expect(q(card("gmail"), "connector-runner-docker").disabled).toBe(true)
    await click(q(document, "connector-add-gmail"))
    expect(q(card("new"), "connector-name").value).toBe("gmail-2")
  })
})
