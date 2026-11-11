// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ProjectSettingsHost } from "../web/src/components/ProjectSettingsDialog.js"
import { ProjectAvatar } from "../web/src/components/TaskIcon.js"
import { warmLazyParts } from "../web/src/components/LazyPart.js"
import { keys } from "../web/src/lib/queries.js"
import { currentConfirm } from "../web/src/lib/confirm.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { DEFAULT_IDENTITY_ID, type Identity } from "../shared/identities"
import { PROJECT_ICON_MAX_BYTES } from "../shared/projectIcons"
import type { Project, SettingsInfo } from "../shared/types"

// Project settings › General › Icon: a picked image previews at once, is sent only on Save (before the rest of the
// form), and Cancel drops it. Remove goes back to the coloured letter. A project's icon that doesn't load draws its
// mark instead, there and everywhere else.

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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

let root: Root
let host: HTMLElement
let requests: { method: string; url: string; body?: unknown; type?: string | null }[]
/** What PUT …/icon answers; the project with an icon by default. */
let putAnswer: () => Response

beforeAll(async () => {
  await warmLazyParts()
})

beforeEach(() => {
  requests = []
  putAnswer = () => json({ ...PROJECT, iconUrl: ICON_URL })
  let blobs = 0
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => `blob:icon-${++blobs}`, revokeObjectURL: vi.fn() }))
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    const type = new Headers(init.headers).get("Content-Type")
    const body = init.body instanceof Blob ? init.body : init.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, url, body, type })
    if (method === "PUT") return putAnswer()
    if (method === "DELETE") return json({ ...PROJECT, iconUrl: null })
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

let qc: QueryClient
function render(p: Project = PROJECT) {
  history.replaceState(null, "", `/?projectSettings=${p.id}`)
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.projects, [p])
  qc.setQueryData(keys.tasks, [])
  qc.setQueryData(keys.identities, [{ id: DEFAULT_IDENTITY_ID, name: "Default", isDefault: true, runners: null, signing: null } as unknown as Identity])
  qc.setQueryData(keys.agentSettings, {
    settings: DEFAULT_SETTINGS,
    sources: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, "default"])),
    defaults: DEFAULT_SETTINGS,
  } as SettingsInfo)
  qc.setQueryData(keys.settings, { defaultTimezone: "UTC", scheduler: "local", maxUploadMb: 20, localDir: "~/boxyard-workspaces" })
  qc.setQueryData(keys.health, { provider: "upstash" })
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ProjectSettingsHost))))
}

const dialog = () => document.querySelector<HTMLElement>("[role=dialog]")
const $ = <T extends Element = HTMLElement>(id: string) => dialog()!.querySelector<T>(`[data-testid=${id}]`)
const save = () => $<HTMLButtonElement>("project-settings-save")!
const preview = () => $("project-icon-picker")!.querySelector<HTMLImageElement>("[data-testid=project-icon]")
const letter = () => $("project-icon-letter")
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))
const click = (el: HTMLElement) => act(() => el.click())
const submit = async () => {
  act(() => void save().closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
  await settle()
}
const unsavedDot = () => dialog()!.querySelector("[role=tab][data-section=general] [title]")?.getAttribute("title") ?? null

/** Picks `file` in the hidden file input, as the browser's file dialog would. */
function pick(file: File) {
  const input = $<HTMLInputElement>("project-icon-input")!
  Object.defineProperty(input, "files", { value: [file], configurable: true })
  act(() => void input.dispatchEvent(new Event("change", { bubbles: true })))
}
const png = (name = "logo.png", size = 2048) => new File([new Uint8Array(size)], name, { type: "image/png" })

describe("Project settings › General › Icon", () => {
  it("shows the coloured letter until an image is picked, previews the pick without sending it, and Save uploads it", async () => {
    render()
    expect(letter()!.textContent).toBe("a")
    // In the colour picked above it.
    expect(letter()!.dataset.color).toBe("violet")
    expect(preview()).toBeNull()
    // Nothing to take off yet.
    expect($("project-icon-remove")).toBeNull()
    expect(save().disabled).toBe(true)

    const file = png()
    pick(file)
    expect(preview()!.getAttribute("src")).toBe("blob:icon-1")
    expect(letter()).toBeNull()
    expect(unsavedDot()).toMatch(/unsaved/i)
    expect($("project-unsaved-count")!.textContent).toBe("1 unsaved change")
    expect(save().disabled).toBe(false)
    expect(requests.filter((r) => r.method !== "GET")).toEqual([])

    await submit()
    // Only the icon changed: one PUT of the file itself, no PATCH, and the dialog says Saved.
    expect(requests.filter((r) => r.method !== "GET")).toEqual([{ method: "PUT", url: "/api/projects/prj_app/icon", body: file, type: "application/octet-stream" }])
    expect(qc.getQueryData<Project[]>(keys.projects)![0]!.iconUrl).toBe(ICON_URL)
    expect($("project-settings-saved")!.textContent).toContain("Saved")
  })

  it("sends the icon before the rest of the form when both changed", async () => {
    render()
    const name = [...dialog()!.querySelectorAll("label")].find((l) => l.firstElementChild?.textContent === "Name")!.querySelector("input")!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "app two")
      name.dispatchEvent(new Event("input", { bubbles: true }))
    })
    pick(png())
    expect($("project-unsaved-count")!.textContent).toBe("2 unsaved changes")
    await submit()
    const sent = requests.filter((r) => r.method !== "GET")
    expect(sent.map((r) => `${r.method} ${r.url}`)).toEqual(["PUT /api/projects/prj_app/icon", "PATCH /api/projects/prj_app"])
    expect((sent[1]!.body as { name: string }).name).toBe("app two")
    expect($("project-settings-saved")!.textContent).toContain("Saved")
  })

  it("refuses a file that isn't an image, or is over 1 MB, where it was picked, and keeps what it had", () => {
    render()
    pick(new File(["%PDF-1.7"], "notes.pdf", { type: "application/pdf" }))
    expect($("project-icon-error")!.textContent).toBe("notes.pdf isn't an image an icon can be: use a PNG, JPG, WebP, GIF or SVG.")
    expect(preview()).toBeNull()
    expect(save().disabled).toBe(true)

    pick(png("huge.png", PROJECT_ICON_MAX_BYTES + 512 * 1024))
    expect($("project-icon-error")!.textContent).toBe("huge.png is 1.5 MB; an icon can be up to 1 MB. Pick a smaller one.")
    expect(save().disabled).toBe(true)

    // A good one clears the message.
    pick(png())
    expect($("project-icon-error")).toBeNull()
    expect(preview()!.getAttribute("src")).toBe("blob:icon-1")
  })

  it("shows the server's refusal on General, keeps the pick, and Save can try again", async () => {
    putAnswer = () => json({ error: "That image is 4032 × 3024 px. This server can't shrink images (sharp isn't installed), so an icon can be at most 1024 px on a side: shrink it and upload it again." }, 400)
    render()
    pick(png())
    // Saved from another tab: the refusal brings General back.
    click(dialog()!.querySelector<HTMLButtonElement>("[role=tab][data-section=notes]")!)
    await submit()
    expect(dialog()).not.toBeNull()
    expect(dialog()!.querySelector("[role=tab][data-section=general]")!.getAttribute("aria-selected")).toBe("true")
    expect($("project-icon-error")!.textContent).toBe(
      "Couldn’t save the icon: That image is 4032 × 3024 px. This server can't shrink images (sharp isn't installed), so an icon can be at most 1024 px on a side: shrink it and upload it again.",
    )
    expect($("project-icon-error")!.getAttribute("role")).toBe("alert")
    expect(preview()!.getAttribute("src")).toBe("blob:icon-1")
    expect(qc.getQueryData<Project[]>(keys.projects)![0]!.iconUrl).toBeNull()

    putAnswer = () => json({ ...PROJECT, iconUrl: ICON_URL })
    await submit()
    expect(requests.filter((r) => r.method === "PUT")).toHaveLength(2)
    expect($("project-settings-saved")!.textContent).toContain("Saved")
  })

  it("Remove goes back to the letter, and Save takes the icon off", async () => {
    render({ ...PROJECT, iconUrl: ICON_URL })
    expect(preview()!.getAttribute("src")).toBe(ICON_URL)
    click($("project-icon-remove")!)
    expect(preview()).toBeNull()
    expect(letter()!.textContent).toBe("a")
    expect($("project-icon-remove")).toBeNull()
    expect(unsavedDot()).toMatch(/unsaved/i)
    await submit()
    expect(requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.url}`)).toEqual(["DELETE /api/projects/prj_app/icon"])
    expect(qc.getQueryData<Project[]>(keys.projects)![0]!.iconUrl).toBeNull()
  })

  it("Remove on a fresh pick, with no icon saved, is no change at all", () => {
    render()
    pick(png())
    click($("project-icon-remove")!)
    expect(letter()).not.toBeNull()
    expect(save().disabled).toBe(true)
    expect(unsavedDot()).toBeNull()
  })

  it("Discard drops the pick: nothing is sent and the preview's file is let go", async () => {
    render()
    pick(png())
    // One change: Discard drops it without asking, and the form starts over from the saved project.
    const discard = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Discard")!
    click(discard)
    await settle()
    expect(currentConfirm()).toBeFalsy()
    expect(preview()).toBeNull()
    expect(letter()).not.toBeNull()
    const close = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Close")!
    click(close)
    await settle()
    expect(dialog()).toBeNull()
    expect(requests.filter((r) => r.method !== "GET")).toEqual([])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:icon-1")
  })
})

describe("ProjectAvatar", () => {
  const mark = createElement("span", { "data-testid": "mark" }, "a")
  const avatar = (src: string | null) => createElement(ProjectAvatar, { src, className: "h-7 w-7 rounded-md" }, mark)

  it("draws the project's own icon in the mark's box, or the mark when there's none", () => {
    act(() => root.render(createElement("div", null, avatar("/api/projects/prj_a/icon?v=aaaaaaaaaaaa"), avatar(null))))
    const img = host.querySelector<HTMLImageElement>("[data-testid=project-icon]")!
    expect(img.getAttribute("src")).toBe("/api/projects/prj_a/icon?v=aaaaaaaaaaaa")
    expect(img.className).toContain("object-cover")
    expect(img.className).toContain("h-7 w-7 rounded-md")
    expect(img.getAttribute("alt")).toBe("")
    expect(host.querySelectorAll("[data-testid=mark]")).toHaveLength(1)
  })

  it("falls back to the mark when the icon doesn't load, and later ones go straight to it", () => {
    const src = "/api/projects/prj_b/icon?v=bbbbbbbbbbbb"
    act(() => root.render(createElement("div", null, avatar(src))))
    act(() => void host.querySelector("img")!.dispatchEvent(new Event("error")))
    expect(host.querySelector("img")).toBeNull()
    expect(host.querySelector("[data-testid=mark]")!.textContent).toBe("a")
    // Another place drawing the same project doesn't try it again this session.
    act(() => root.render(createElement("div", null, avatar(src), avatar(src))))
    expect(host.querySelector("img")).toBeNull()
    expect(host.querySelectorAll("[data-testid=mark]")).toHaveLength(2)
  })
})
