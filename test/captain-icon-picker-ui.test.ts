// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { CaptainIconPicker, type CaptainIconDefault } from "../web/src/components/CaptainIconPicker.js"
import { CaptainIcon, loadCaptainIcons } from "../web/src/components/CaptainIcon.js"
import { SettingsDialog } from "../web/src/components/SettingsDialog.js"
import { ProjectSettingsHost } from "../web/src/components/ProjectSettingsDialog.js"
import { warmLazyParts } from "../web/src/components/LazyPart.js"
import { keys } from "../web/src/lib/queries.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { DEFAULT_IDENTITY_ID, type Identity } from "../shared/identities"
import { captainIcons, type CaptainIconId } from "../shared/captainIcons"
import type { Project, Settings, SettingsInfo } from "../shared/types"

// The Captain icon picker (docs/captain-icons.md): Settings › Coordinator › Captain icon for every Captain, and a
// project's settings › General › Captain icon, with Use default. It opens in place, searches, picks with a tap or the
// arrow keys, and closes on Esc before its dialog. A pick is a draft until Save. A Captain shows its project's pick, then
// its image, then Settings' icon, then the cap.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const ICON_URL = "/api/projects/prj_app/icon?v=0123456789ab"

const PROJECT = {
  id: "prj_app",
  name: "app",
  description: "",
  repo: "acme-corp/app",
  baseBranch: "main",
  color: "violet",
  iconUrl: null,
  captainIcon: null,
  envKeys: [],
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

const settingsInfo = (values: Partial<Settings> = {}): SettingsInfo => ({
  settings: { ...DEFAULT_SETTINGS, ...values },
  sources: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, k in values ? "ui" : "default"])) as SettingsInfo["sources"],
  defaults: DEFAULT_SETTINGS,
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

let root: Root
let host: HTMLElement
let qc: QueryClient
let requests: { method: string; url: string; body?: unknown }[]

beforeAll(async () => {
  await warmLazyParts()
})

beforeEach(() => {
  requests = []
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, url, body })
    if (method === "PUT" && url === "/api/agent-settings") return json(settingsInfo(body))
    if (method === "PATCH") return json({ ...PROJECT, ...(body as object) })
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

function remount() {
  act(() => root.unmount())
  root = createRoot(host)
}
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
const writes = () => requests.filter((r) => r.method !== "GET")
const $ = <T extends Element = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid=${id}]`)
const click = (el: Element) => act(() => (el as HTMLElement).click())
const key = (el: Element, k: string) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })
  act(() => void el.dispatchEvent(e))
  return e
}
const type = (el: HTMLInputElement, text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, text)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })

function client(projects: Project[] = [PROJECT], settings = settingsInfo()) {
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.projects, projects)
  qc.setQueryData(keys.tasks, [])
  qc.setQueryData(keys.agentSettings, settings)
  qc.setQueryData(keys.identities, [{ id: DEFAULT_IDENTITY_ID, name: "Default", isDefault: true, runners: null, signing: null } as unknown as Identity])
  qc.setQueryData(keys.settings, { defaultTimezone: "UTC", scheduler: "local", maxUploadMb: 20, localDir: "~/boxyard-workspaces" })
  qc.setQueryData(keys.health, { provider: "upstash" })
  return qc
}

// First, while the catalogue's components haven't loaded in this file yet.
describe("CaptainIcon", () => {
  // A fresh tree each time: a query stays with the client it was first rendered with.
  const show = (projects: Project[], settings = settingsInfo(), projectId: string | null = "prj_app") => {
    remount()
    act(() => root.render(createElement(QueryClientProvider, { client: client(projects, settings) }, createElement(CaptainIcon, { projectId, className: "h-4 w-4" }))))
  }
  const mark = () => host.querySelector<HTMLElement>("[data-captain-icon]")!
  const svgClass = () => mark().querySelector("svg")?.getAttribute("class") ?? ""

  it("holds an icon's place, empty and the same size, until the catalogue loads, then draws it", async () => {
    show([{ ...PROJECT, captainIcon: "anchor" }])
    expect(mark().dataset.captainIcon).toBe("anchor")
    expect(svgClass()).toContain("lucide-captain-icon-pending")
    expect(mark().querySelector("svg")!.children).toHaveLength(0)
    await act(async () => { await loadCaptainIcons() })
    expect(svgClass()).toContain("lucide-anchor")
  })

  it("is the project's pick, then its image, then Settings' icon, then the cap", async () => {
    show([{ ...PROJECT, captainIcon: "crown", iconUrl: ICON_URL }], settingsInfo({ captainIcon: "anchor" }))
    expect(mark().dataset.captainIcon).toBe("crown")
    expect(svgClass()).toContain("lucide-crown")

    show([{ ...PROJECT, iconUrl: ICON_URL }], settingsInfo({ captainIcon: "anchor" }))
    expect(mark().dataset.captainIcon).toBe("image")
    expect(mark().querySelector("img")!.getAttribute("src")).toBe(ICON_URL)

    show([PROJECT], settingsInfo({ captainIcon: "anchor" }))
    expect(mark().dataset.captainIcon).toBe("anchor")
    expect(svgClass()).toContain("lucide-anchor")

    show([PROJECT])
    expect(mark().dataset.captainIcon).toBe("captain-cap")
    expect(svgClass()).toContain("lucide-captain-cap")
    // Decorative where its name is beside it.
    expect(mark().getAttribute("aria-hidden")).toBe("true")
  })
})

describe("CaptainIconPicker", () => {
  let picked: (CaptainIconId | null)[]
  function Harness({ start, useDefault }: { start: CaptainIconId | null; useDefault?: CaptainIconDefault }) {
    const [value, setValue] = useState(start)
    return createElement(CaptainIconPicker, {
      value,
      onChange: (id: CaptainIconId | null) => {
        picked.push(id)
        setValue(id)
      },
      color: "lime",
      useDefault,
    })
  }
  const open = async (start: CaptainIconId | null = "captain-cap", useDefault?: CaptainIconDefault) => {
    picked = []
    act(() => root.render(createElement(QueryClientProvider, { client: client() }, createElement(Harness, { start, useDefault }))))
    click($("captain-icon-picker-toggle")!)
    await act(async () => { await loadCaptainIcons() })
    await settle()
  }
  const toggle = () => $<HTMLButtonElement>("captain-icon-picker-toggle")!
  const radios = () => [...document.querySelectorAll<HTMLElement>('[role="radiogroup"] [role="radio"]')]
  const radio = (id: string) => document.querySelector<HTMLElement>(`[role="radio"][data-icon="${id}"]`)!
  const checked = () => radios().filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.dataset.icon)
  const current = () => $("captain-icon-picker-current")!.textContent

  it("shows the pick by name, and opens in place to every icon as one radio group of 44px tiles", async () => {
    picked = []
    act(() => root.render(createElement(QueryClientProvider, { client: client() }, createElement(Harness, { start: "captain-cap" }))))
    expect(current()).toBe("Captain's cap")
    expect(toggle().textContent).toBe("Choose icon")
    expect(toggle().getAttribute("aria-expanded")).toBe("false")
    expect(toggle().className).toContain("min-h-11")
    expect(document.querySelector('[role="radiogroup"]')).toBeNull()

    click(toggle())
    await settle()
    expect(toggle().getAttribute("aria-expanded")).toBe("true")
    expect(toggle().textContent).toBe("Done")
    expect(document.getElementById(toggle().getAttribute("aria-controls")!)).not.toBeNull()
    expect(document.querySelector('[role="radiogroup"]')!.getAttribute("aria-label")).toBe("Captain icon")
    expect(radios()).toHaveLength(captainIcons().length)
    expect(checked()).toEqual(["captain-cap"])
    expect(radio("anchor").getAttribute("aria-label")).toBe("Anchor")
    expect(radio("anchor").className).toContain("h-11 w-11")
    // One tab stop: the picked one.
    expect(radios().filter((r) => r.tabIndex === 0).map((r) => r.dataset.icon)).toEqual(["captain-cap"])
    // Drawn in the Captain's colour.
    expect(radio("anchor").className).toContain("text-(--pc)")
    expect(radio("anchor").querySelector("svg")!.getAttribute("class")).toContain("lucide-anchor")
  })

  it("searches by the start of each word, and says when nothing matches", async () => {
    await open()
    const search = $<HTMLInputElement>("captain-icon-picker-search")!
    expect(search.placeholder).toBe(`Search ${captainIcons().length} icons`)
    type(search, "sh wh")
    await settle()
    expect(radios().map((r) => r.dataset.icon)).toContain("ship-wheel")
    expect(radios().map((r) => r.dataset.icon)).not.toContain("anchor")
    expect(document.querySelector('[aria-live="polite"]')!.textContent).toBe(`${radios().length} ${radios().length === 1 ? "icon" : "icons"}`)
    // The cap isn't in view, so the first match is the tab stop.
    expect(radios().filter((r) => r.tabIndex === 0)).toEqual([radios()[0]])

    type(search, "zzzz")
    await settle()
    expect(radios()).toEqual([])
    expect($("captain-icon-picker-empty")!.textContent).toBe("No icons match “zzzz”. Try a word like ship, star or cat.")
  })

  it("picks with a tap, and with the arrow keys, Home and End", async () => {
    await open()
    click(radio("anchor"))
    expect(picked).toEqual(["anchor"])
    expect(checked()).toEqual(["anchor"])
    expect(current()).toBe("Anchor")

    const all = radios()
    const at = all.indexOf(radio("anchor"))
    radio("anchor").focus()
    expect(key(radio("anchor"), "ArrowRight").defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(all[at + 1])
    expect(checked()).toEqual([all[at + 1]!.dataset.icon])
    key(document.activeElement!, "ArrowLeft")
    expect(checked()).toEqual(["anchor"])
    key(document.activeElement!, "Home")
    expect(checked()).toEqual(["captain-cap"])
    key(document.activeElement!, "End")
    expect(checked()).toEqual([all.at(-1)!.dataset.icon])
    // Nothing before the first.
    key(document.activeElement!, "Home")
    const before = picked.length
    key(document.activeElement!, "ArrowLeft")
    expect(picked).toHaveLength(before)
  })

  it("closes on Esc, taking it before the dialog around it, and gives focus back to its button", async () => {
    await open()
    // In the search, Esc clears it first.
    const search = $<HTMLInputElement>("captain-icon-picker-search")!
    type(search, "anchor")
    await settle()
    expect(key(search, "Escape").defaultPrevented).toBe(true)
    await settle()
    expect(search.value).toBe("")
    expect(radios()).toHaveLength(captainIcons().length)
    radio("anchor").focus()
    const esc = key(radio("anchor"), "Escape")
    expect(esc.defaultPrevented).toBe(true)
    expect(document.querySelector('[role="radiogroup"]')).toBeNull()
    expect(toggle().getAttribute("aria-expanded")).toBe("false")
    expect(document.activeElement).toBe(toggle())
  })

  it("offers Use default first when given one, saying what it shows", async () => {
    await open(null, { preview: createElement("span", { "data-testid": "default-preview" }), label: "The project's image" })
    expect(current()).toBe("Default")
    expect($("captain-icon-picker")!.textContent).toContain("The project's image")
    const first = radios()[0]!
    expect(first.dataset.icon).toBe("default")
    expect(first.getAttribute("aria-label")).toBe("Use default: The project's image")
    expect(checked()).toEqual(["default"])
    expect(first.tabIndex).toBe(0)
    click(radio("crown"))
    expect(current()).toBe("Crown")
    click(radio("default"))
    expect(picked).toEqual(["crown", null])
    expect(current()).toBe("Default")
    // A search hides it: it's not an icon.
    type($<HTMLInputElement>("captain-icon-picker-search")!, "crown")
    await settle()
    expect(radios().map((r) => r.dataset.icon)).not.toContain("default")
  })
})

describe("Settings › Coordinator › Captain icon", () => {
  const render = (info = settingsInfo()) =>
    act(() => root.render(createElement(QueryClientProvider, { client: client([], info) }, createElement(SettingsDialog, { section: "orchestrator", onSection: () => {}, onClose: () => {} }))))
  const save = async () => {
    for (const f of document.querySelectorAll("form")) f.noValidate = true
    act(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Save")!.click())
    await settle()
  }

  it("is the cap, with no Use default: it is the default", async () => {
    render()
    expect($("captain-icon-current")!.textContent).toBe("Captain's cap")
    // Its row's label names its button.
    const label = [...document.querySelectorAll("label")].find((l) => l.textContent === "Captain icon")!
    expect(document.getElementById(label.htmlFor)).toBe($("captain-icon-toggle"))
    click($("captain-icon-toggle")!)
    await settle()
    expect(document.querySelector('[role="radio"][data-icon="default"]')).toBeNull()
  })

  it("is a draft until Save, which sends the icon's id", async () => {
    render()
    click($("captain-icon-toggle")!)
    await settle()
    click(document.querySelector('[role="radio"][data-icon="lighthouse"]')!)
    expect($("captain-icon-current")!.textContent).toBe("Lighthouse")
    expect(writes()).toEqual([])
    await save()
    expect(writes()).toHaveLength(1)
    expect(writes()[0]).toMatchObject({ method: "PUT", url: "/api/agent-settings", body: { captainIcon: "lighthouse" } })
  })

  it("leaves the dialog open on Esc while the picker is open", async () => {
    render(settingsInfo({ captainIcon: "anchor" }))
    expect($("captain-icon-current")!.textContent).toBe("Anchor")
    click($("captain-icon-toggle")!)
    await settle()
    const r = document.querySelector<HTMLElement>('[role="radio"][data-icon="anchor"]')!
    r.focus()
    key(r, "Escape")
    expect(document.querySelector('[role="radiogroup"]')).toBeNull()
    expect(document.querySelector("[role=dialog]")).not.toBeNull()
  })
})

describe("Project settings › General › Captain icon", () => {
  const render = (p: Project = PROJECT, settings = settingsInfo()) => {
    history.replaceState(null, "", `/?projectSettings=${p.id}`)
    act(() => root.render(createElement(QueryClientProvider, { client: client([p], settings) }, createElement(ProjectSettingsHost))))
  }
  const status = () => $("project-captain-icon-status")!.textContent
  const save = async () => {
    const button = $<HTMLButtonElement>("project-settings-save")!
    act(() => void button.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    await settle()
  }
  const openPicker = async () => {
    click($("project-captain-icon-toggle")!)
    await settle()
  }
  const pick = (id: string) => click(document.querySelector(`[data-testid=project-captain-icon] [role="radio"][data-icon="${id}"]`)!)

  it("says what Use default shows, and why: the cap, Settings' icon, or the project's image", () => {
    render()
    expect($("project-captain-icon-current")!.textContent).toBe("Default")
    expect(status()).toBe("Its Captain shows the Captain's cap, the default for every Captain. Change it in Settings › Coordinator.")
    remount()

    render(PROJECT, settingsInfo({ captainIcon: "anchor" }))
    expect(status()).toBe("Its Captain shows the Anchor, the default for every Captain. Change it in Settings › Coordinator.")
    remount()

    render({ ...PROJECT, iconUrl: ICON_URL }, settingsInfo({ captainIcon: "anchor" }))
    expect(status()).toBe("Its Captain shows the project's image: it uses the default, and a project's image comes before every Captain's icon in Settings. Pick an icon to show that instead.")
    expect($("project-captain-icon-preview")!.querySelector("img")!.getAttribute("src")).toBe(ICON_URL)
  })

  it("saves a pick with the rest of the form, saying it shows instead of the image", async () => {
    render({ ...PROJECT, iconUrl: ICON_URL })
    await openPicker()
    pick("crown")
    expect(status()).toBe("Once you save, its Captain shows the Crown: you picked it here, so it shows instead of the project's image.")
    expect($("project-unsaved-count")!.textContent).toBe("1 unsaved change")
    expect(writes()).toEqual([])
    await save()
    expect(writes()).toHaveLength(1)
    expect(writes()[0]).toMatchObject({ method: "PATCH", url: "/api/projects/prj_app", body: { captainIcon: "crown" } })
  })

  it("goes back to Use default with null, and sends nothing for it when it's unchanged", async () => {
    render({ ...PROJECT, captainIcon: "crown" })
    expect($("project-captain-icon-current")!.textContent).toBe("Crown")
    expect(status()).toBe("Its Captain shows the Crown: you picked it here.")
    await openPicker()
    pick("default")
    await save()
    expect(writes()[0]).toMatchObject({ method: "PATCH", body: { captainIcon: null } })
    remount()
    requests = []

    // Another change leaves it out of the PATCH.
    render({ ...PROJECT, captainIcon: "crown" })
    const name = [...document.querySelectorAll("label")].find((l) => l.firstElementChild?.textContent === "Name")!.querySelector("input")!
    type(name, "app two")
    await save()
    expect(writes()[0]!.body).not.toHaveProperty("captainIcon")
  })

  it("closes the picker on Esc and leaves the project's settings open", async () => {
    render()
    await openPicker()
    const r = document.querySelector<HTMLElement>('[data-testid=project-captain-icon] [role="radio"][data-icon="default"]')!
    r.focus()
    key(r, "Escape")
    expect(document.querySelector("[data-testid=project-captain-icon] [role=radiogroup]")).toBeNull()
    expect(document.querySelector("[role=dialog]")).not.toBeNull()
  })
})
