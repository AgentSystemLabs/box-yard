// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ProjectSettings } from "../web/src/components/ProjectView.js"
import { keys } from "../web/src/lib/queries.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { DEFAULT_IDENTITY_ID, type Identity } from "../shared/identities"
import type { Project, SettingsInfo, Task } from "../shared/types"

// Project › Settings › Identity: who the project acts as, saved with the rest of the form. The picker says (and Save
// waits) when the identity can't run on the project's runner, or a turn is running and would switch accounts halfway.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const identity = (id: string, name: string, extra: Partial<Identity> = {}) =>
  ({ id, name, color: "sky", isDefault: id === DEFAULT_IDENTITY_ID, githubLogin: null, owners: [], tokens: [], author: null, signing: null, claude: null, runners: null, projectIds: [], lastCheck: null, ...extra }) as unknown as Identity
const IDENTITIES = [identity(DEFAULT_IDENTITY_ID, "Default", { color: "slate", githubLogin: "octocat" }), identity("idn_acme", "Acme", { githubLogin: "octo-acme", coordinatorSees: "status" }), identity("idn_here", "Signed here", { githubLogin: "octo-here", runners: ["local"] })]

const project = (over: Partial<Project> = {}) =>
  ({
    id: "prj_app",
    name: "app",
    description: "",
    repo: "acme-corp/app",
    baseBranch: "main",
    envKeys: [],
    notes: [],
    runner: "box",
    identityId: DEFAULT_IDENTITY_ID,
    boxSize: null,
    gpuMachine: { gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null },
    gpuProvider: null,
    docker: { image: null, dockerfile: null },
    createdAt: now,
    updatedAt: now,
    ...over,
  }) as unknown as Project

const info = (): SettingsInfo => ({
  settings: DEFAULT_SETTINGS,
  sources: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, "default"])) as SettingsInfo["sources"],
  defaults: DEFAULT_SETTINGS,
})

let root: Root
let host: HTMLElement
let requests: { method: string; url: string; body?: Record<string, unknown> }[]

function render(p: Project, tasks: Partial<Task>[] = [], identities = IDENTITIES) {
  history.replaceState(null, "", `/?projectSettings=${p.id}`)
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.projects, [p])
  qc.setQueryData(keys.tasks, tasks)
  qc.setQueryData(keys.identities, identities)
  qc.setQueryData(keys.agentSettings, info())
  qc.setQueryData(keys.settings, { defaultTimezone: "UTC", scheduler: "local", maxUploadMb: 20, localDir: "~/boxyard-workspaces" })
  qc.setQueryData(keys.health, { provider: "upstash" })
  for (const k of [keys.artifacts, keys.schedules, keys.boxes]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ProjectSettings, { project: p, onDone: () => {} }))))
}

beforeEach(() => {
  requests = []
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    requests.push({ method, url, body })
    if (method === "PATCH") return new Response(JSON.stringify({ ...project(), ...body }), { status: 200, headers: { "Content-Type": "application/json" } })
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
  for (const t of currentToasts()) dismiss(t.id)
  vi.unstubAllGlobals()
})

const $ = <T extends Element = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid=${id}]`)
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
const pick = (value: string) => {
  const select = $<HTMLSelectElement>("project-identity")!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value)
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
}
const save = () => $<HTMLButtonElement>("project-settings-save")!
const submit = async () => {
  act(() => void save().closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
  await settle()
}
/** Save stays on with a field to fix, but sends nothing: it shows the Identity field instead. */
const saveWaits = async () => {
  expect($("project-settings-problem")).not.toBeNull()
  await submit()
  expect(requests.some((r) => r.method === "PATCH")).toBe(false)
  expect(document.activeElement).toBe($("project-identity"))
}

describe("Project › Settings › Identity", () => {
  it("lists every identity with its account, and sends identityId only when it changed", async () => {
    render(project())
    const options = [...$<HTMLSelectElement>("project-identity")!.options].map((o) => o.textContent)
    expect(options).toEqual(["Default · octocat", "Acme · octo-acme", "Signed here · octo-here (not on Upstash box)"])
    expect(save().disabled).toBe(true)

    pick("idn_acme")
    expect(document.querySelector('[data-identity="Acme"]')).not.toBeNull()
    expect(save().disabled).toBe(false)
    await submit()
    expect(requests.find((r) => r.method === "PATCH")!.body).toMatchObject({ identityId: "idn_acme" })
  })

  it("leaves identityId out of a save that didn't touch it", async () => {
    render(project({ identityId: "idn_acme" }))
    const description = document.querySelector<HTMLTextAreaElement>("textarea")!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(description, "d")
      description.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await submit()
    expect(requests.find((r) => r.method === "PATCH")!.body).not.toHaveProperty("identityId")
  })

  it("an identity that can't run on the project's runner says so, and Save waits", async () => {
    render(project())
    pick("idn_here")
    expect($("identity-misfit")!.textContent).toBe("The Signed here identity runs only on this computer: pick another runner or identity.")
    await saveWaits()
    pick(DEFAULT_IDENTITY_ID)
    expect($("identity-misfit")).toBeNull()
  })

  it("a GPG identity requires the local runner even when its runner list allows every runner", async () => {
    const gpg = identity("idn_gpg", "GPG", { signing: { kind: "gpg", format: "openpgp", publicKey: "0123456789ABCDEF0123456789ABCDEF01234567", fingerprint: "0123456789ABCDEF0123456789ABCDEF01234567", program: null, requireSigned: false, readable: true } })
    render(project(), [], [...IDENTITIES, gpg])
    pick("idn_gpg")
    expect($("identity-misfit")!.textContent).toContain("requires the local runner")
    await saveWaits()
  })

  it("an identity that shows the Coordinator status only says so", () => {
    render(project())
    expect($("identity-status-only")).toBeNull()
    pick("idn_acme")
    expect($("identity-status-only")!.textContent).toBe("The Acme identity shows the Coordinator this project's status only (titles, states, PRs). Its Captain sees everything.")
    expect(save().disabled).toBe(false)
  })

  it("a running turn keeps the identity until it rests", async () => {
    render(project(), [{ id: "task_1", projectId: "prj_app", title: "busy", status: "working" }])
    expect($("identity-busy")).toBeNull()
    pick("idn_acme")
    expect($("identity-busy")!.textContent).toContain('"busy" is running.')
    await saveWaits()
  })
})

// Project settings › Identity / Claude login (the dialog's form on its own): which identity it uses, loaded from
// /api/identities, picked and saved with PATCH /api/projects/:id. The form says Saved only once the server has the save.
describe("Project settings › Identity / Claude login", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  const setup = (claude: { state: "set" | "unset"; using: "claudeOauthToken" | "anthropicApiKey" | null }, github: "set" | "unset" = "set") => ({ upstash: { available: true }, credentials: {}, claude, github: { state: github } })
  let onDone: ReturnType<typeof vi.fn>
  let qc: QueryClient

  /** `identities: null` leaves them to fetch. */
  function renderSettings(p: Project, o: { identities?: Identity[] | null; claude?: Parameters<typeof setup>[0]; github?: "set" | "unset" } = {}) {
    qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
    qc.setQueryData(keys.projects, [p])
    qc.setQueryData(keys.tasks, [])
    if (o.identities !== null) qc.setQueryData(keys.identities, o.identities ?? IDENTITIES)
    qc.setQueryData(keys.setup, setup(o.claude ?? { state: "set", using: "claudeOauthToken" }, o.github))
    qc.setQueryData(keys.agentSettings, info())
    qc.setQueryData(keys.settings, { defaultTimezone: "UTC", scheduler: "local", maxUploadMb: 20, localDir: "~/boxyard-workspaces" })
    qc.setQueryData(keys.health, { provider: "upstash" })
    for (const k of [keys.artifacts, keys.schedules, keys.boxes]) qc.setQueryData(k, [])
    onDone = vi.fn()
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ProjectSettings, { project: p, onDone }))))
  }
  const text = (id: string) => $(id)?.textContent ?? null
  const cachedIdentity = () => qc.getQueryData<Project[]>(keys.projects)![0]!.identityId

  it("an inherited Default says so, with the kind of Claude login Settings › Credentials has", () => {
    renderSettings(project())
    expect(document.querySelector("#project-identity-heading")!.textContent).toBe("Identity / Claude login")
    expect(text("identity-current")).toBe("UsesDefaultinherited from Settings › Credentials")
    expect(text("identity-claude")).toBe("Settings › Credentials’ Claude subscription token")
    expect($<HTMLSelectElement>("project-identity")!.value).toBe(DEFAULT_IDENTITY_ID)
    expect($("identity-facts")!.textContent).toContain("GitHuboctocat")
  })

  it("an inherited Default with nothing in Settings › Credentials says none yet, not a login it doesn't have", () => {
    renderSettings(project(), { identities: [identity(DEFAULT_IDENTITY_ID, "Default", { color: "slate" })], claude: { state: "unset", using: null }, github: "unset" })
    expect($("identity-facts")!.textContent).toBe("GitHubnone yet: add a token in Settings › CredentialsClaude loginnone yet: add one in Settings › Credentials")
  })

  it("picking an identity shows its account and Claude login (a kind, never the key) before Save", () => {
    const own = identity("idn_own", "Own login", { githubLogin: "octo-own", claude: { kind: "api_key", fingerprint: "a1b2c3d4e5f6", readable: true }, projectIds: ["prj_app", "prj_other"] })
    const broken = identity("idn_broken", "Broken", { claude: { kind: "oauth_token", fingerprint: "ffeeddccbbaa", readable: false } })
    renderSettings(project(), { identities: [...IDENTITIES, own, broken], claude: { state: "set", using: "anthropicApiKey" } })
    pick("idn_own")
    expect($("identity-pending")!.querySelector('[data-identity="Own login"]')).not.toBeNull()
    expect($("identity-facts")!.textContent).toBe("GitHubocto-ownClaude loginits own API key")
    expect(document.body.textContent).not.toContain("a1b2c3d4e5f6")
    expect(document.body.textContent).toContain("1 other project uses Own login")
    pick("idn_acme")
    expect(text("identity-claude")).toBe("none of its own, so Settings › Credentials’ Anthropic API key")
    pick("idn_broken")
    expect(text("identity-claude")).toContain("its own can’t be read")
    expect(document.body.textContent).not.toContain("ffeeddccbbaa")
  })

  it("a Claude login in the project's env vars beats the identity's for its agents, and says so", () => {
    renderSettings(project({ envKeys: ["CLAUDE_CODE_OAUTH_TOKEN"] }))
    expect(text("identity-env-login")).toBe("Its agents log in with this project’s CLAUDE_CODE_OAUTH_TOKEN env var instead; its Captain uses the login above.")
  })

  it("links to Settings › Identities", () => {
    renderSettings(project())
    act(() => $("project-identity-manage")!.click())
    expect(new URLSearchParams(location.search).get("settings")).toBe("identities")
  })

  it("while identities load the picker waits, and a saved identity isn't shown as Default", () => {
    renderSettings(project({ identityId: "idn_acme" }), { identities: null })
    const select = $<HTMLSelectElement>("project-identity")!
    expect(select.disabled).toBe(true)
    expect(select.selectedOptions[0]!.textContent).toBe("Loading identities…")
    expect(text("identity-current")).toBe("Uses…")
    expect(requests.some((r) => r.url === "/api/identities")).toBe(true)
  })

  it("identities that fail to load say why, and Retry loads them", async () => {
    let fail = true
    vi.stubGlobal("fetch", async (url: string) => {
      requests.push({ method: "GET", url })
      if (url === "/api/identities") return fail ? json({ error: "Database is locked" }, 500) : json(IDENTITIES)
      return new Promise(() => {})
    })
    renderSettings(project(), { identities: null })
    await settle()
    const alert = $("project-identity-section")!.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain("Couldn’t load identities: Database is locked")
    expect($<HTMLSelectElement>("project-identity")!.disabled).toBe(true)
    // Saving the rest of the form doesn't wait for identities: Default stays as it was.
    expect(text("identity-current")).toBe("UsesDefaultinherited from Settings › Credentials")
    fail = false
    act(() => [...alert.querySelectorAll("button")].find((b) => b.textContent === "Retry")!.click())
    await settle()
    expect($("project-identity-section")!.querySelector('[role="alert"]')).toBeNull()
    expect($<HTMLSelectElement>("project-identity")!.disabled).toBe(false)
    expect(requests.filter((r) => r.url === "/api/identities")).toHaveLength(2)
  })

  it("Save waits for the server before saying Saved, and sends only the identity", async () => {
    let answer!: (r: Response) => void
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      requests.push({ method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : undefined })
      return init.method === "PATCH" ? new Promise<Response>((r) => (answer = r)) : new Promise(() => {})
    })
    renderSettings(project())
    pick("idn_acme")
    await submit()
    const patch = requests.find((r) => r.method === "PATCH")!
    expect(patch.url).toBe("/api/projects/prj_app")
    expect(patch.body).toMatchObject({ identityId: "idn_acme" })
    // On its way: still open, locked, and Save says so (busy, with its spinner).
    expect(onDone).not.toHaveBeenCalled()
    expect(save().disabled).toBe(true)
    expect(save().querySelector(".animate-spin")).not.toBeNull()
    expect(save().closest("form")!.getAttribute("aria-busy")).toBe("true")
    expect(save().closest("fieldset")!.disabled).toBe(true)
    expect($("project-settings-saved")).toBeNull()
    answer(json({ ...project(), identityId: "idn_acme" }))
    await settle()
    // Saved: it stays open and says so.
    expect(onDone).not.toHaveBeenCalled()
    expect($("project-settings-saved")!.textContent).toContain("Saved")
    expect(cachedIdentity()).toBe("idn_acme")
  })

  it("a refused save stays open with the server's reason and the edits, and the project keeps its identity", async () => {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      requests.push({ method: init.method ?? "GET", url })
      if (init.method === "PATCH") return json({ error: 'app has a task running ("busy"). Change its identity when the task rests, so no turn switches accounts halfway.' }, 409)
      return new Promise(() => {})
    })
    renderSettings(project())
    pick("idn_acme")
    await submit()
    expect(onDone).not.toHaveBeenCalled()
    expect(text("project-settings-error")).toBe(
      'Couldn’t save app’s settings: app has a task running ("busy"). Change its identity when the task rests, so no turn switches accounts halfway. Your edits are still here, so you can try Save again.',
    )
    expect($<HTMLSelectElement>("project-identity")!.value).toBe("idn_acme")
    expect(save().textContent).toBe("Save")
    expect(save().disabled).toBe(false)
    expect(save().closest("fieldset")!.disabled).toBe(false)
    // The optimistic update is undone: the project still uses Default.
    expect(cachedIdentity()).toBe(DEFAULT_IDENTITY_ID)
    expect(text("identity-current")).toContain("Default")
  })
})
