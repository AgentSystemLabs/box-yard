// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SettingsDialog } from "../web/src/components/SettingsDialog.js"
import { keys } from "../web/src/lib/queries.js"
import { editCount, parseOwners } from "../web/src/components/Identities.js"
import { currentConfirm, settleConfirm } from "../web/src/lib/confirm.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { DEFAULT_IDENTITY_ID, type Identity, type IdentityDetection } from "../shared/identities"
import type { SettingsSection } from "../web/src/lib/settingsNav"
import type { Project, Settings, SettingsInfo } from "../shared/types"

// Settings › Identities follows Settings' rule: nothing saves on change. Edits, a pasted token, Add, Delete and the
// imports a detection proposes are drafts the dialog's Save writes; Detect and Test only read. A pasted token goes
// out once, on Save, and never shows again.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PASTED = "ghp_pastedTokenValue000000000000000000"

const identity = (id: string, name: string, extra: Partial<Identity> = {}): Identity => ({
  id,
  name,
  color: "sky",
  isDefault: id === DEFAULT_IDENTITY_ID,
  githubLogin: null,
  githubId: null,
  owners: [],
  tokens: [],
  author: null,
  signing: null,
  claude: null,
  runners: null,
  coordinatorSees: "everything",
  projectIds: [],
  lastCheck: null,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
})
const acme = () =>
  identity("idn_acme", "Acme", {
    githubLogin: "octo-acme",
    owners: ["acme-corp"],
    projectIds: ["prj_app"],
    tokens: [{ owner: "", fingerprint: "100da730fa2f", login: "octo-acme", scopes: ["repo"], expiresAt: null, source: "gh:github.com:octo-acme", readable: true, savedAt: 1 }],
    author: { name: "Acme Octo", email: "octo@acme.dev", emailCheck: "verified" },
  })
const project = (id: string, name: string, identityId = DEFAULT_IDENTITY_ID) => ({ id, name, repo: `acme-corp/${name}`, identityId }) as unknown as Project

const detection: IdentityDetection = {
  at: Date.now(),
  online: true,
  accounts: [],
  authors: [],
  sshHosts: [],
  credentialHelpers: [],
  proposals: [
    {
      name: "octocat",
      login: "octocat",
      host: "github.com",
      tokenRef: "gh:github.com:octocat",
      owners: ["octocat"],
      author: { name: "Octo Cat", email: "octocat@example.com", from: "~/.gitconfig" },
      signing: null,
      projects: [
        { id: "prj_site", name: "site", repo: "octocat/site", why: "octocat owns it and can push", currentIdentity: "Default" },
        { id: "prj_blog", name: "blog", repo: "octocat/blog", why: "octocat owns it and can push", currentIdentity: "Default" },
      ],
      isDefaultToday: false,
      existing: null,
      evidence: ["gh is signed in to octocat (its active account)"],
    },
  ],
  unmatched: [],
  notes: [],
}

const settingsInfo = (values: Partial<Settings> = {}): SettingsInfo => ({
  settings: { ...DEFAULT_SETTINGS, ...values },
  sources: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, "default"])) as SettingsInfo["sources"],
  defaults: DEFAULT_SETTINGS,
})

let root: Root
let host: HTMLElement
let qc: QueryClient
let section: SettingsSection
let rejectWrite: ((url: string, method: string) => { error: string; fields?: { path: string; message: string }[] } | undefined) | undefined
let requests: { method: string; url: string; body?: unknown }[]

function render() {
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(SettingsDialog, { section, onSection: (next) => { section = next; render() }, onClose: () => {} }))))
}

beforeEach(() => {
  vi.stubGlobal("__APP_VERSION__", "test")
  vi.stubGlobal("__APP_COMMIT__", "")
  requests = []
  section = "identities"
  rejectWrite = undefined
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.agentSettings, settingsInfo())
  qc.setQueryData(keys.health, { provider: "local", claude: { available: false } })
  qc.setQueryData(keys.identities, [identity(DEFAULT_IDENTITY_ID, "Default", { color: "slate" }), acme()])
  qc.setQueryData(keys.projects, [project("prj_app", "app", "idn_acme"), project("prj_site", "site"), project("prj_blog", "blog")])
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, url, body })
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })
    const failure = rejectWrite?.(url, method)
    if (failure) return json(failure, 400)
    if (method === "POST" && url === "/api/identities/detect") return json(detection)
    if (method === "POST" && url === "/api/identities/import") return json({ identity: identity("idn_cat", "octocat"), created: true, lines: ["Made the octocat identity for octocat.", "site: now uses the octocat identity."] }, 201)
    if (method === "POST" && url === "/api/identities") return json(identity("idn_new", body.name, body), 201)
    if (method === "PATCH" && url === "/api/identities/idn_acme") return json({ ...acme(), ...body })
    if (method === "PATCH" && url === "/api/identities/idn_example") return json(identity("idn_example", "Example Git", body))
    if (method === "PUT" && url === "/api/identities/idn_example/tokens") return json(identity("idn_example", "Example Git"))
    if (method === "PUT" && url === "/api/identities/idn_acme/signing") return json(acme())
    if (method === "PUT" && url === "/api/identities/idn_acme/tokens") return json(acme())
    if (method === "PUT" && url === "/api/identities/idn_acme/claude") return json(acme())
    if (method === "DELETE" && url.startsWith("/api/identities/idn_acme")) return json({ movedProjectIds: ["prj_app"] })
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
const buttons = (label: string) => [...document.querySelectorAll("button")].filter((b) => b.textContent?.trim() === label)
const saveButton = () => {
  for (const f of document.querySelectorAll("form")) f.noValidate = true
  return buttons("Save")[0]!
}
const card = (name: string) => document.querySelector<HTMLElement>(`[data-identity-card="${name}"]`)!
const unsaved = () => document.querySelector("[data-testid=unsaved-count]")?.textContent ?? null
const writes = () => requests.filter((r) => r.method !== "GET")
const click = async (el: Element | null | undefined) => {
  act(() => (el as HTMLElement).click())
  await settle()
}
/** Set a controlled input's value and dispatch `event`, the way React hears it. */
const fill = async (el: HTMLInputElement, value: string, event: Event) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value)
    el.dispatchEvent(event)
  })
  await settle()
}
/** Type (or paste) into a field as a person does: an input event with the inputType a keyboard or paste gives. */
const type = (el: HTMLInputElement, value: string, inputType = "insertText") => fill(el, value, new InputEvent("input", { bubbles: true, inputType, data: value }))
/** A browser's or password manager's autofill: the value changes with an event no person made. */
const autofill = fill

const choose = async (el: HTMLSelectElement, value: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await settle()
}

describe("Settings › Identities", () => {
  it("shows each identity's account, owners, author and token fingerprint, never a token", async () => {
    render()
    await settle()
    const text = card("Acme").textContent!
    expect(text).toContain("octo-acme")
    expect(text).toContain("acme-corp")
    expect(text).toContain("Acme Octo <octo@acme.dev>")
    expect(text).toContain("verified on octo-acme")
    expect(text).toContain("100da730fa2f")
    expect(card("Default").textContent).toContain("Settings › Credentials")
  })

  it("an edit and a pasted token are a draft until Save, which sends the token once and never shows it", async () => {
    render()
    await settle()
    await click(card("Acme").querySelector("[data-testid=identity-edit]"))
    await type(card("Acme").querySelector<HTMLInputElement>("input[placeholder=Acme]")!, "Acme Corp")
    const token = card("Acme").querySelector<HTMLInputElement>("[data-testid=identity-token]")!
    expect(token.className).not.toContain("text-security") // the placeholder reads
    await type(token, PASTED)
    expect(token.className).toContain("[-webkit-text-security:disc]") // masked, like a password
    expect(writes()).toEqual([])
    expect(unsaved()).toBe("2 unsaved changes")
    expect(document.querySelector('[data-section=identities] [title="Unsaved changes"]')).not.toBeNull()

    await click(saveButton())
    expect(writes()).toEqual([
      { method: "PATCH", url: "/api/identities/idn_acme", body: { name: "Acme Corp" } },
      { method: "PUT", url: "/api/identities/idn_acme/tokens", body: { owner: "", token: PASTED } },
    ])
    expect(unsaved()).toBeNull()
    expect(document.body.innerHTML).not.toContain(PASTED)
  })

  it("an autofilled GitHub token never reaches the draft, so a pasted Claude token saves alone", async () => {
    render()
    await settle()
    await click(card("Acme").querySelector("[data-testid=identity-edit]"))
    const token = card("Acme").querySelector<HTMLInputElement>("[data-testid=identity-token]")!
    // Not a password field, so browsers neither fill a saved password in nor offer to save a pasted token as one.
    expect(token.type).toBe("text")
    expect(token.autocomplete).toBe("off")
    expect(token.dataset).toMatchObject({ "1pIgnore": "true", lpignore: "true", bwignore: "true", formType: "other" })
    expect(document.querySelector("input[type=password]")).toBeNull()

    // Chrome and Safari fill with a plain input event, Firefox with insertReplacementText; neither is the user's.
    await autofill(token, "saved-site-password", new Event("input", { bubbles: true }))
    expect(token.value).toBe("")
    await autofill(token, "saved-site-password", new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }))
    expect(token.value).toBe("")
    expect(unsaved()).toBeNull()

    const claude = card("Acme").querySelector<HTMLInputElement>("input[aria-label='Claude login']")!
    await type(claude, "sk-ant-oat01-pastedClaudeToken000000", "insertFromPaste")
    expect(unsaved()).toBe("1 unsaved change")
    await click(saveButton())
    expect(writes()).toEqual([{ method: "PUT", url: "/api/identities/idn_acme/claude", body: { kind: "oauth_token", value: "sk-ant-oat01-pastedClaudeToken000000" } }])
    expect(card("Acme").querySelector("[data-identity-field=token][aria-invalid]")).toBeNull()
    expect(unsaved()).toBeNull()
  })

  it("GPG key ids stay a draft until Save, with local-runner and headless warnings", async () => {
    render()
    await settle()
    await click(card("Acme").querySelector("[data-testid=identity-edit]"))
    const label = [...card("Acme").querySelectorAll("label")].find((l) => l.textContent?.trim() === "GPG keyring (this computer)")!
    await click(label.querySelector("input"))
    expect(writes()).toEqual([])
    const input = card("Acme").querySelector<HTMLInputElement>('[aria-label="GPG key id or fingerprint"]')!
    await type(input, "-----BEGIN PGP PRIVATE KEY BLOCK-----")
    await click(saveButton())
    expect(writes()).toEqual([])
    await type(input, "0123456789ABCDEF")
    expect(writes()).toEqual([])
    expect(card("Acme").textContent).toContain("Never paste a private key or passphrase")
    expect(card("Acme").textContent).toContain("Requires the local runner")
    await click(saveButton())
    expect(writes()).toEqual([{ method: "PUT", url: "/api/identities/idn_acme/signing", body: { kind: "gpg", keyId: "0123456789ABCDEF" } }])
  })

  it("typing a field back to its saved value leaves nothing to save", async () => {
    render()
    await settle()
    await click(card("Acme").querySelector("[data-testid=identity-edit]"))
    const owners = card("Acme").querySelector<HTMLInputElement>("input[placeholder='acme-corp, octo-acme']")!
    await type(owners, "acme-corp, octo-acme")
    expect(unsaved()).toBe("1 unsaved change")
    await type(owners, "Acme-Corp")
    expect(unsaved()).toBeNull()
  })

  it("Detect only reads; a ticked proposal is imported on Save, with the projects left ticked", async () => {
    render()
    await settle()
    await click(document.querySelector("[data-testid=identity-detect]"))
    expect(writes()).toEqual([{ method: "POST", url: "/api/identities/detect", body: { online: true } }])
    const proposal = document.querySelector<HTMLElement>('[data-proposal="octocat"]')!
    expect(proposal.textContent).toContain("Octo Cat <octocat@example.com>")
    expect(proposal.textContent).toContain("a new identity")

    await click(proposal.querySelector("[data-testid=import-octocat]"))
    expect(unsaved()).toBe("1 unsaved change")
    // Leave blog where it is.
    await click([...proposal.querySelectorAll("label")].find((l) => l.textContent?.includes("blog"))!.querySelector("input"))
    expect(writes()).toHaveLength(1)

    await click(saveButton())
    expect(writes().at(-1)).toEqual({ method: "POST", url: "/api/identities/import", body: { login: "octocat", projects: ["prj_site"] } })
    expect(document.querySelector("[data-testid=identity-import-log]")!.textContent).toContain("site: now uses the octocat identity.")
    expect(unsaved()).toBeNull()
  })

  it("Delete waits for Save and says where its projects go; Add makes one on Save", async () => {
    render()
    await settle()
    await click(card("Acme").querySelector("[data-testid=identity-edit]"))
    await click(card("Acme").querySelector("[data-testid=identity-delete]"))
    expect(card("Acme").textContent).toContain("Deleted when you save; app moves to Default.")
    await click(document.querySelector("[data-testid=identity-add]"))
    await type(card("new").querySelector<HTMLInputElement>("input[placeholder=Acme]")!, "Personal")
    expect(writes()).toEqual([])
    expect(unsaved()).toBe("2 unsaved changes")

    await click(saveButton())
    expect(writes()).toEqual(
      expect.arrayContaining([
        { method: "DELETE", url: "/api/identities/idn_acme?moveProjects=1" },
        { method: "POST", url: "/api/identities", body: { name: "Personal", color: expect.any(String) } },
      ]),
    )
    expect(document.querySelector('[data-identity-card="new"]')).toBeNull()
  })

  it("Coordinator sees is a draft: Status only goes in the PATCH on Save, and a sealed card says so", async () => {
    qc.setQueryData(keys.identities, [identity(DEFAULT_IDENTITY_ID, "Default", { color: "slate" }), acme(), identity("idn_private", "Private", { coordinatorSees: "status" })])
    render()
    await settle()
    expect(card("Private").textContent).toContain("Coordinator seesstatus only: its Captains see the rest")
    expect(card("Acme").textContent).toContain("Coordinator seeseverything")
    await click(card("Acme").querySelector("[data-testid=identity-edit]"))
    const sees = card("Acme").querySelector<HTMLSelectElement>("[data-testid=identity-coordinator-sees]")!
    expect(sees.value).toBe("everything")
    expect([...sees.options].map((o) => o.textContent)).toEqual(["Everything", "Status only"])
    await choose(sees, "status")
    expect(unsaved()).toBe("1 unsaved change")
    await choose(sees, "everything")
    expect(unsaved()).toBeNull()
    await choose(sees, "status")
    expect(writes()).toEqual([])

    await click(saveButton())
    expect(writes()).toEqual([{ method: "PATCH", url: "/api/identities/idn_acme", body: { coordinatorSees: "status" } }])
    expect(unsaved()).toBeNull()
  })

  it("reveals another identity's collapsed token owner, preserves raw drafts, and preflights before any writes", async () => {
    qc.setQueryData(keys.identities, [acme(), identity("idn_example", "Example Git", { owners: ["acme-example-daily"] })])
    render()
    await settle()
    await click(card("Example Git").querySelector("[data-testid=identity-edit]"))
    await type(card("Example Git").querySelector<HTMLInputElement>("[data-identity-field=token]")!, PASTED)
    const rawOwner = " https://github.com/acme-example/app "
    await type(card("Example Git").querySelector<HTMLInputElement>("[data-identity-field=tokenOwner]")!, rawOwner)
    await click(card("Example Git").querySelector("[data-testid=identity-edit]")) // Done collapses the offending field.
    await click(card("Acme").querySelector("[data-testid=identity-edit]"))
    await type(card("Acme").querySelector<HTMLInputElement>("[data-identity-field=owners]")!, "acme-corp, acme-example-daily")
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!
    await type(search, "git author") // Search hides the token-owner row, then another category hides all identities.
    act(() => { section = "orchestrator"; render() })
    await click(saveButton())
    expect(writes()).toEqual([])
    expect(section).toBe("identities")
    expect(search.value).toBe("")
    const owner = card("Example Git").querySelector<HTMLInputElement>("[data-identity-field=tokenOwner]")!
    expect(owner.closest("[hidden]")).toBeNull()
    expect(document.activeElement).toBe(owner)
    expect(owner.value).toBe(rawOwner)
    expect(owner.getAttribute("aria-invalid")).toBe("true")
    expect(document.getElementById(owner.getAttribute("aria-describedby")!)?.textContent).toContain("one GitHub user or org")
    expect(document.querySelector('[role=alert]')?.textContent).toContain("Example Git: Token owner")
    expect(card("Example Git").querySelector<HTMLInputElement>("[data-identity-field=token]")!.value).toBe(PASTED)
    expect(card("Acme").querySelector<HTMLInputElement>("[data-identity-field=owners]")!.value).toBe("acme-corp, acme-example-daily")
    expect(card("Acme").querySelector("[aria-invalid=true]")).toBeNull()
    await type(owner, " Acme-Example ")
    expect(owner.hasAttribute("aria-invalid")).toBe(false)
    await click(saveButton())
    expect(writes()).toEqual(expect.arrayContaining([
      { method: "PATCH", url: "/api/identities/idn_acme", body: { owners: ["acme-corp", "acme-example-daily"] } },
      { method: "PUT", url: "/api/identities/idn_example/tokens", body: { owner: "acme-example", token: PASTED } },
    ]))
    expect(unsaved()).toBeNull()
  })

  it("preserves an owner entered before the token, and accepts a blank every-owner token", async () => {
    render()
    await settle()
    await click(card("Acme").querySelector("[data-testid=identity-edit]"))
    const owner = card("Acme").querySelector<HTMLInputElement>("[data-identity-field=tokenOwner]")!
    await type(owner, " Acme-Example ")
    expect(owner.value).toBe(" Acme-Example ")
    await click(saveButton())
    expect(writes()).toEqual([])
    const token = card("Acme").querySelector<HTMLInputElement>("[data-identity-field=token]")!
    expect(document.activeElement).toBe(token)
    await type(token, PASTED)
    await click(saveButton())
    expect(writes()[0]?.body).toEqual({ owner: "acme-example", token: PASTED })
    await type(token, PASTED)
    await type(owner, "   ")
    await click(saveButton())
    expect(writes().at(-1)?.body).toEqual({ owner: "", token: PASTED })
  })

  it.each([
    ["token", "owner", "tokenOwner", "Token owner"],
    ["fields", "owners.0", "owners", "Owners"],
    ["fields", "author.email", "authorEmail", "Author email"],
  ])("routes a server %s error for %s to the right hidden field without losing rejected input", async (operation, path, field, label) => {
    qc.setQueryData(keys.identities, [acme(), identity("idn_example", "Example Git")])
    let release!: () => void
    const original = globalThis.fetch
    const gate = new Promise<void>((resolve) => { release = resolve })
    rejectWrite = (url, method) => url.startsWith("/api/identities/idn_example") && method !== "GET" ? { error: `${path}: rejected`, fields: [{ path, message: "Check this example field." }] } : undefined
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      if (url.startsWith("/api/identities/idn_example") && init.method !== "GET") await gate
      return original(url, init)
    })
    render()
    await settle()
    await click(card("Example Git").querySelector("[data-testid=identity-edit]"))
    if (operation === "token") {
      await type(card("Example Git").querySelector<HTMLInputElement>("[data-identity-field=tokenOwner]")!, " acme-example ")
      await type(card("Example Git").querySelector<HTMLInputElement>("[data-identity-field=token]")!, PASTED)
    } else if (field === "owners") {
      await type(card("Example Git").querySelector<HTMLInputElement>("[data-identity-field=owners]")!, " Acme-Example ")
    } else {
      await type(card("Example Git").querySelector<HTMLInputElement>("[data-identity-field=author]")!, "Example Agent")
      await type(card("Example Git").querySelector<HTMLInputElement>("[data-identity-field=authorEmail]")!, "agent@example.com")
    }
    await click(saveButton())
    await click(card("Example Git").querySelector("[data-testid=identity-edit]"))
    act(() => { section = "orchestrator"; render() })
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 30)) })
    expect(section).toBe("identities")
    const offending = card("Example Git").querySelector<HTMLInputElement>(`[data-identity-field=${field}]`)!
    expect(document.activeElement).toBe(offending)
    expect(offending.closest("[hidden]")).toBeNull()
    expect(offending.getAttribute("aria-invalid")).toBe("true")
    expect(offending.value).toBe(field === "authorEmail" ? "agent@example.com" : field === "owners" ? " Acme-Example " : " acme-example ")
    expect(document.querySelector('[role=alert]')?.textContent).toContain(`Example Git: ${label}:`)
    expect(card("Acme").querySelector("[aria-invalid=true]")).toBeNull()
    expect(buttons("Discard")).toHaveLength(1)
    rejectWrite = undefined
    await type(offending, field === "authorEmail" ? "new@example.com" : "acme-other")
    expect(offending.hasAttribute("aria-invalid")).toBe(false)
    await click(saveButton())
    expect(unsaved()).toBeNull()
  })

  it("keeps a token after a successful field PATCH and routes an unstructured token rejection to its own field", async () => {
    rejectWrite = (url, method) => method === "PUT" && url.endsWith("/tokens") ? { error: "GitHub rejected this token (401)." } : undefined
    render()
    await settle()
    await click(card("Acme").querySelector("[data-testid=identity-edit]"))
    await type(card("Acme").querySelector<HTMLInputElement>("[data-identity-field=name]")!, "Example Renamed")
    const token = card("Acme").querySelector<HTMLInputElement>("[data-identity-field=token]")!
    await type(token, PASTED)
    await click(saveButton())
    expect(writes().map((w) => w.method)).toEqual(["PATCH", "PUT"])
    expect(token.value).toBe(PASTED)
    expect(document.activeElement).toBe(token)
    expect(token.getAttribute("aria-invalid")).toBe("true")
    expect(document.querySelector('[role=alert]')?.textContent).toContain("Example Renamed: GitHub token: GitHub rejected")
    expect(buttons("Discard")).toHaveLength(1)
    rejectWrite = undefined
    await click(saveButton())
    expect(writes().map((w) => w.method)).toEqual(["PATCH", "PUT", "PUT"])
    expect(unsaved()).toBeNull()
    expect(token.value).toBe("")
  })

  it("finds an invalid new identity before creating any cards and preserves all new-card drafts", async () => {
    render()
    await settle()
    await click(document.querySelector("[data-testid=identity-add]"))
    await type(card("new").querySelector<HTMLInputElement>("[data-identity-field=name]")!, "Example New")
    await type(card("new").querySelector<HTMLInputElement>("[data-identity-field=token]")!, PASTED)
    await type(card("new").querySelector<HTMLInputElement>("[data-identity-field=tokenOwner]")!, "acme/app")
    await click(saveButton())
    expect(writes()).toEqual([])
    const owner = card("new").querySelector<HTMLInputElement>("[data-identity-field=tokenOwner]")!
    expect(document.activeElement).toBe(owner)
    expect(owner.value).toBe("acme/app")
    expect(card("new").querySelector<HTMLInputElement>("[data-identity-field=name]")!.value).toBe("Example New")
    expect(card("new").querySelector<HTMLInputElement>("[data-identity-field=token]")!.value).toBe(PASTED)
  })

  it("ignores unchanged saved identities while saving a different card's draft", async () => {
    qc.setQueryData(keys.identities, [acme(), identity("idn_example", "Example Legacy", { owners: ["legacy/shape"] })])
    render()
    await settle()
    await click(card("Acme").querySelector("[data-testid=identity-edit]"))
    await type(card("Acme").querySelector<HTMLInputElement>("[data-identity-field=name]")!, "Acme Updated")
    await click(saveButton())
    expect(writes()).toEqual([{ method: "PATCH", url: "/api/identities/idn_acme", body: { name: "Acme Updated" } }])
    expect(document.querySelector('[role=alert]')).toBeNull()
    expect(unsaved()).toBeNull()
  })

  it("routes a new identity's server name rejection to that card and keeps its token draft", async () => {
    rejectWrite = (url, method) => method === "POST" && url === "/api/identities" ? { error: "Name already exists.", fields: [{ path: "name", message: "Choose a different name." }] } : undefined
    render()
    await settle()
    await click(document.querySelector("[data-testid=identity-add]"))
    await type(card("new").querySelector<HTMLInputElement>("[data-identity-field=name]")!, "Example New")
    await type(card("new").querySelector<HTMLInputElement>("[data-identity-field=token]")!, PASTED)
    await click(saveButton())
    const name = card("new").querySelector<HTMLInputElement>("[data-identity-field=name]")!
    expect(document.activeElement).toBe(name)
    expect(name.getAttribute("aria-invalid")).toBe("true")
    expect(document.getElementById(name.getAttribute("aria-describedby")!)?.textContent).toBe("Choose a different name.")
    expect(name.value).toBe("Example New")
    expect(card("new").querySelector<HTMLInputElement>("[data-identity-field=token]")!.value).toBe(PASTED)
    expect(writes()).toHaveLength(1)
  })

  it("counts a draft's changes and reads owners as GitHub does", () => {
    expect(editCount({ name: "x", removeTokens: ["a", "b"], token: { owner: "", value: "t" } })).toBe(4)
    expect(editCount({})).toBe(0)
    expect(parseOwners("Acme-Corp,  octo-acme acme-corp")).toEqual(["acme-corp", "octo-acme"])
  })
})
