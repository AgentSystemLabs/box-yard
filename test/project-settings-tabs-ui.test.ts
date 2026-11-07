// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ProjectSettingsHost } from "../web/src/components/ProjectSettingsDialog.js"
import { PROJECT_SECTIONS, type ProjectSection } from "../web/src/components/ProjectView.js"
import { warmLazyParts } from "../web/src/components/LazyPart.js"
import { keys } from "../web/src/lib/queries.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { DEFAULT_IDENTITY_ID, type Identity } from "../shared/identities"
import type { Project, SettingsInfo } from "../shared/types"

// A project's settings dialog uses Settings' category tabs (SettingsTabs): every field sits in one tab, switching tabs
// keeps the drafts, each edited tab gets the unsaved dot, and one Save sends them all.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const identity = (id: string, name: string, extra: Partial<Identity> = {}) =>
  ({ id, name, color: "sky", isDefault: id === DEFAULT_IDENTITY_ID, githubLogin: null, owners: [], tokens: [], author: null, signing: null, claude: null, runners: null, projectIds: [], lastCheck: null, ...extra }) as unknown as Identity

const PROJECT = {
  id: "prj_app",
  name: "app",
  description: "",
  repo: "acme-corp/app",
  baseBranch: "main",
  envKeys: ["API_URL"],
  notes: [],
  runner: "box",
  identityId: DEFAULT_IDENTITY_ID,
  boxSize: null,
  agentsPerBox: null,
  tasksPerBox: null,
  maxBoxes: null,
  wholeMachine: false,
  partialClone: null,
  pushAtTurnEnd: null,
  depCache: null,
  autoDoneOnMerge: null,
  closeIssuesOnMerge: null,
  notesMaxCount: null,
  notesMaxTokens: null,
  gpuMaxHourlyUsd: null,
  gpuMachine: { gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null },
  gpuProvider: null,
  docker: { image: null, dockerfile: null },
  createdAt: now,
  updatedAt: now,
} as unknown as Project

/** The fields each tab holds, by test id (or, for plain fields, label). Together they're every field of the form. */
const FIELDS: Record<ProjectSection, string[]> = {
  general: ["Name", "Repo", "Branch", "Description", "project-color", "project-icon-picker"],
  agents: ["project-runner", "project-agent-cli", "project-identity"],
  boxes: ["project-box-size", "project-agents-per-box", "project-tasks-per-box", "project-max-boxes", "project-whole-machine", "project-dep-cache"],
  git: ["project-partial-clone", "project-push-at-turn-end", "project-auto-done-on-merge", "project-close-issues-on-merge"],
  notes: ["project-notes-max", "project-notes-max-tokens"],
  env: ["Env vars"],
}

let root: Root
let host: HTMLElement
let requests: { method: string; url: string; body?: Record<string, unknown> }[]

beforeAll(async () => {
  await warmLazyParts()
})

beforeEach(() => {
  requests = []
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    requests.push({ method, url, body })
    if (method === "PATCH") return new Response(JSON.stringify({ ...PROJECT, ...body }), { status: 200, headers: { "Content-Type": "application/json" } })
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

function render(p: Project = PROJECT) {
  history.replaceState(null, "", `/?projectSettings=${p.id}`)
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.projects, [p])
  qc.setQueryData(keys.tasks, [])
  qc.setQueryData(keys.identities, [identity(DEFAULT_IDENTITY_ID, "Default", { githubLogin: "octocat" }), identity("idn_here", "Signed here", { runners: ["local"] })])
  qc.setQueryData(keys.agentSettings, {
    settings: DEFAULT_SETTINGS,
    sources: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, "default"])),
    defaults: DEFAULT_SETTINGS,
  } as SettingsInfo)
  qc.setQueryData(keys.settings, { defaultTimezone: "UTC", scheduler: "local", maxUploadMb: 20, localDir: "~/boxyard-workspaces" })
  qc.setQueryData(keys.health, { provider: "upstash" })
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ProjectSettingsHost))))
}

const dialog = () => document.querySelector<HTMLElement>("[role=dialog]")!
const $ = <T extends Element = HTMLElement>(id: string) => dialog().querySelector<T>(`[data-testid=${id}]`)
const panel = (key: ProjectSection) => dialog().querySelector<HTMLElement>(`[data-project-section=${key}]`)!
const tab = (key: ProjectSection) => dialog().querySelector<HTMLButtonElement>(`[role=tab][data-section=${key}]`)!
const shown = () => PROJECT_SECTIONS.map((s) => s.key).filter((k) => !panel(k).hidden)
const dot = (key: ProjectSection) => tab(key).querySelector("[title]")?.getAttribute("title") ?? null
const save = () => $<HTMLButtonElement>("project-settings-save")!
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
/** A field of the form by test id, or a plain Field by its label. */
const field = (key: ProjectSection, name: string) =>
  panel(key).querySelector(`[data-testid="${name}"]`) ??
  [...panel(key).querySelectorAll("label")].find((l) => l.firstElementChild?.textContent === name)?.querySelector("input, textarea, select") ??
  null

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
function choose(el: HTMLSelectElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("change", { bubbles: true }))
  })
}
const click = (el: HTMLElement) => act(() => el.click())
const submit = async () => {
  act(() => void save().closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
  await settle()
}

describe("Project settings › category tabs", () => {
  it("shows Settings' tab list and narrow dropdown, with General open first", () => {
    render()
    expect(dialog().querySelector("[role=tablist]")!.getAttribute("aria-label")).toBe("Project settings categories")
    expect([...dialog().querySelectorAll("[role=tab]")].map((t) => t.textContent)).toEqual(PROJECT_SECTIONS.map((s) => s.label))
    const nav = dialog().querySelector<HTMLSelectElement>('[aria-label="Project settings category"]')!
    expect([...nav.options].map((o) => o.textContent)).toEqual(PROJECT_SECTIONS.map((s) => s.label))
    expect(nav.value).toBe("general")
    expect(shown()).toEqual(["general"])
    expect(tab("general").getAttribute("aria-selected")).toBe("true")
    expect(dialog().querySelector("[role=tabpanel]")!.getAttribute("aria-label")).toBe("General")
  })

  it("renders every tab's fields when it's picked, and every field of the form sits in exactly one tab", () => {
    render()
    for (const { key, label } of PROJECT_SECTIONS) {
      click(tab(key))
      expect(shown()).toEqual([key])
      expect(tab(key).getAttribute("aria-selected")).toBe("true")
      expect(panel(key).querySelector("h3")!.textContent).toBe(label)
      for (const name of FIELDS[key]) expect(field(key, name), `${name} in ${label}`).not.toBeNull()
    }
    // Nothing in the form is outside a tab (the nav's own dropdown aside), so no setting was dropped.
    const form = save().closest("form")!
    const controls = [...form.querySelectorAll<HTMLElement>("input, select, textarea")].filter((el) => !el.matches('[aria-label="Project settings category"]'))
    expect(controls.length).toBeGreaterThanOrEqual(20)
    for (const el of controls) expect(el.closest("[data-project-section]"), el.outerHTML.slice(0, 80)).not.toBeNull()
    // The dropdown picks tabs too (the phone layout).
    choose(dialog().querySelector<HTMLSelectElement>('[aria-label="Project settings category"]')!, "notes")
    expect(shown()).toEqual(["notes"])
  })

  it("keeps drafts across tabs, dots each edited tab, and one Save sends them all", async () => {
    render()
    type(field("general", "Name") as HTMLInputElement, "app two")
    click(tab("boxes"))
    type($<HTMLInputElement>("project-max-boxes")!, "3")
    click(tab("git"))
    choose($<HTMLSelectElement>("project-push-at-turn-end")!, "off")
    click(tab("general"))
    expect((field("general", "Name") as HTMLInputElement).value).toBe("app two")
    expect($<HTMLInputElement>("project-max-boxes")!.value).toBe("3")
    expect(PROJECT_SECTIONS.map((s) => dot(s.key))).toEqual(["Unsaved changes", null, "Unsaved changes", "Unsaved changes", null, null])
    expect([...dialog().querySelector<HTMLSelectElement>('[aria-label="Project settings category"]')!.options].map((o) => o.textContent)).toEqual([
      "General · unsaved",
      "Agents & runners",
      "Boxes · unsaved",
      "Git & PRs · unsaved",
      "Notes",
      "Env vars",
    ])
    expect($("project-unsaved-count")!.textContent).toBe("3 unsaved changes")

    // Changed back, a tab's dot goes again.
    click(tab("git"))
    choose($<HTMLSelectElement>("project-push-at-turn-end")!, "")
    expect(dot("git")).toBeNull()
    expect($("project-unsaved-count")!.textContent).toBe("2 unsaved changes")
    expect(requests.some((r) => r.method === "PATCH")).toBe(false)

    await submit()
    const patches = requests.filter((r) => r.method === "PATCH")
    expect(patches).toHaveLength(1)
    expect(patches[0]!.body).toMatchObject({ name: "app two", maxBoxes: 3, pushAtTurnEnd: null })
  })

  it("moves between tabs with the arrow keys, Home and End, as Settings does", () => {
    render()
    const list = dialog().querySelector<HTMLElement>("[role=tablist]")!
    const key = (k: string) => act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })))
    act(() => tab("general").focus())
    key("ArrowDown")
    expect(shown()).toEqual(["agents"])
    expect(document.activeElement).toBe(tab("agents"))
    key("End")
    expect(shown()).toEqual(["env"])
    key("ArrowDown")
    expect(shown()).toEqual(["general"])
    key("ArrowUp")
    expect(shown()).toEqual(["env"])
    key("Home")
    expect(shown()).toEqual(["general"])
    expect(list.contains(document.activeElement)).toBe(true)
  })

  it("Save opens the tab of a number it can't take instead of sending it", async () => {
    render()
    click(tab("boxes"))
    type($<HTMLInputElement>("project-agents-per-box")!, "500")
    click(tab("general"))
    await submit()
    expect(shown()).toEqual(["boxes"])
    expect(document.activeElement).toBe($("project-agents-per-box"))
    expect(requests.some((r) => r.method === "PATCH")).toBe(false)
  })

  it("an identity that can't run on the project's runner marks Agents & runners, and Save waits", () => {
    render()
    click(tab("agents"))
    choose($<HTMLSelectElement>("project-identity")!, "idn_here")
    expect(dot("agents")).toBe("Needs a fix")
    expect($("project-settings-problem")!.textContent).toBe("Fix 1 field to save")
    expect(save().disabled).toBe(true)
    choose($<HTMLSelectElement>("project-runner")!, "local")
    expect(dot("agents")).toBe("Unsaved changes")
    expect(save().disabled).toBe(false)
  })
})
