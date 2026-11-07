// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { CommandPalette, openPalette } from "../web/src/components/CommandPalette.js"
import { keys } from "../web/src/lib/queries.js"
import { paletteIndex, rankPalette } from "../web/src/lib/paletteRank.js"
import { readPins, setChatProjectFilter } from "../web/src/lib/projectBar.js"
import type { Artifact, Project, SettingsInfo, Task } from "../shared/types"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Counts rankings and the palette's own index builds; both still run.
vi.mock("../web/src/lib/paletteRank.js", async (original) => {
  const actual = await original<typeof import("../web/src/lib/paletteRank.js")>()
  return { ...actual, rankPalette: vi.fn(actual.rankPalette), paletteIndex: vi.fn(actual.paletteIndex) }
})

const now = Date.now()
const task = (id: string, title: string, status: Task["status"], age: number) =>
  ({ id, title, status, projectId: "prj_a", updatedAt: now - age * 60_000, createdAt: 1, prUrl: null, prState: null, summary: null }) as unknown as Task

const TASKS = [
  task("tsk_ask", "Pick a color", "needs_input", 1),
  task("tsk_pr", "Review the palette PR", "pr_ready", 2),
  ...Array.from({ length: 7 }, (_, i) => task(`tsk_w${i}`, `Working task ${i}`, "working", 10 + i)),
  task("tsk_done", "Finished thing", "done", 100),
]
const PROJECTS = [{ id: "prj_a", name: "box-yard", repo: "acme/box-yard", description: "", updatedAt: 1 }] as unknown as Project[]
const ARTIFACTS = [{ id: "art_1", projectId: "prj_a", taskId: null, title: "Screenshot", filename: "shot.png", mime: "image/png", size: 1, url: "/artifacts/art_1/shot.png", createdAt: now }] as Artifact[]

let root: Root
let host: HTMLElement
let qc: QueryClient

function render(tasks = TASKS) {
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.tasks, tasks)
  qc.setQueryData(keys.projects, PROJECTS)
  qc.setQueryData(keys.artifacts, ARTIFACTS)
  qc.setQueryData(keys.schedules, [])
  qc.setQueryData(keys.boxes, [])
  qc.setQueryData(keys.agentSettings, { settings: { ownerName: "Ada" } } as unknown as SettingsInfo)
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(CommandPalette))))
  act(() => openPalette())
}

beforeEach(() => {
  history.replaceState(null, "", "/")
  localStorage.clear()
  localStorage.setItem("box-yard:recent", JSON.stringify(["project:prj_a", "task:tsk_done", "task:tsk_ask"]))
  localStorage.setItem("box-yard:command-usage", JSON.stringify({ "page:boxes": 3 }))
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  setChatProjectFilter(null)
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

const input = () => document.querySelector<HTMLInputElement>("input[role=combobox]")!
const groupLabels = () => [...document.querySelectorAll("[role=group]")].map((g) => g.querySelector("[id]")!.textContent)
const groupRows = (key: string) => [...document.querySelectorAll(`[data-group=${key}] [role=option]`)].map((o) => o.textContent!.trim())
const groupKeys = (key: string) => [...document.querySelectorAll(`[data-group=${key}] [role=option]`)].map((o) => o.getAttribute("data-key"))
const selected = () => document.querySelector("[role=option][aria-selected=true]")!
const press = (key: string, init: KeyboardEventInit = {}) => act(() => void input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })))
const type = (text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text)
    input().dispatchEvent(new Event("input", { bubbles: true }))
  })

describe("command palette", () => {
  it("opens on the empty-query sections in order, with the owner's name and no files", () => {
    render()
    expect(groupLabels()).toEqual(["Waiting on Ada", "Working", "Recently viewed", "Commands"])
    expect(groupRows("waiting").map((t) => t.split("Needs")[0]!.split("PR ready")[0])).toEqual(["Pick a colorbox-yard", "Review the palette PRbox-yard"])
    // Tasks already listed above don't repeat under Recently viewed.
    expect(groupRows("recent")[0]).toContain("box-yard")
    expect(groupRows("recent").some((r) => r.startsWith("Finished thing"))).toBe(true)
    expect(groupRows("recent").some((r) => r.startsWith("Pick a color"))).toBe(false)
    expect(groupRows("command")[0]).toContain("Coordinator")
    expect(document.querySelector("[data-key^='artifact:']")).toBeNull()
    expect(document.querySelector("[data-testid=palette-prefixes]")!.textContent).toContain("f:Files")
  })

  it("lists tasks and Captains opened anywhere under Recently viewed, newest first", () => {
    localStorage.setItem("box-yard:recent", "[]")
    render()
    expect(groupLabels()).not.toContain("Recently viewed")
    press("Escape")
    // A card or link opens the task's panel; the sidebar picks a Captain. Neither goes through the palette.
    act(() => history.pushState(null, "", "/?session=tsk_done"))
    act(() => setChatProjectFilter("prj_a"))
    act(() => openPalette())
    expect(groupKeys("recent")).toEqual(["project:prj_a", "task:tsk_done"])
  })

  it("caps a group with a Show N more row that expands it inline", () => {
    render()
    const working = groupRows("working")
    expect(working).toHaveLength(6)
    expect(working.at(-1)).toBe("Show 2 more")
    act(() => void document.querySelector("[data-group=working] [data-testid=palette-show-all]")!.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    expect(groupRows("working")).toHaveLength(7)
    expect(groupRows("working").at(-1)).toContain("Working task 6")
  })

  it("lists top-level tasks first, then a few sub-tasks in their own group, each under its parent's title", () => {
    const parent = task("tsk_logo", "Box Yard logo exploration: 10 designer sub-tasks", "waiting", 300)
    const kids = Array.from({ length: 8 }, (_, i) => ({ ...task(`tsk_logo${i}`, `Logo designer ${i + 1}`, "done", 10 + i), parentTaskId: "tsk_logo", rootTaskId: "tsk_logo" }))
    const brand = task("tsk_brand", "Brand refresh", "idle", 400)
    const mark = { ...task("tsk_mark", "Logo wordmark", "done", 5), parentTaskId: "tsk_brand", rootTaskId: "tsk_brand" }
    render([...TASKS, parent, ...kids, brand, mark])
    type("logo")
    expect(groupLabels().slice(0, 2)).toEqual(["Tasks", "Sub-tasks"])
    // The parent first; then, below every direct match, the task whose sub-task says "logo", saying so.
    expect(groupKeys("task")).toEqual(["task:tsk_logo", "task:tsk_brand"])
    expect(groupRows("task")[1]).toContain("1 sub-task matches")
    const subs = groupRows("subtask")
    expect(subs).toHaveLength(4)
    expect(subs.at(-1)).toBe("Show 6 more")
    expect(subs[0]).toContain("Logo wordmark")
    expect(subs[0]).toContain("Sub-task of Brand refresh· box-yard")
    expect(subs[1]).toContain("Sub-task of Box Yard logo exploration")
    // Enter opens the top-level task.
    expect(selected().getAttribute("data-key")).toBe("task:tsk_logo")
  })

  it("draws a big expanded group a page at a time, and always the selected row", () => {
    // The list's end coming into view, on demand.
    const seen: IntersectionObserverCallback[] = []
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: IntersectionObserverCallback) {
          seen.push(cb)
        }
        observe() {}
        disconnect() {}
      },
    )
    const scrolledToEnd = () => act(() => seen.at(-1)!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    const showAll = (group: string) => act(() => void document.querySelector(`[data-group=${group}] [data-testid=palette-show-all]`)!.dispatchEvent(new MouseEvent("click", { bubbles: true })))
    const drawn = () => document.querySelectorAll("[role=option]").length
    render([...TASKS, ...Array.from({ length: 120 }, (_, i) => task(`tsk_m${i}`, `More work ${i}`, "working", 20 + i))])
    showAll("working")
    // 2 waiting rows, then the first 48 of 127 working ones; the rest and the groups after them wait.
    expect(drawn()).toBe(50)
    expect(groupLabels()).toEqual(["Waiting on Ada", "Working"])
    scrolledToEnd()
    expect(drawn()).toBe(100)
    for (let i = 0; i < 100; i++) press("ArrowDown")
    expect(drawn()).toBe(101)
    expect(selected().textContent).toContain("More work 91")
    press("End", { ctrlKey: true })
    expect(groupLabels().at(-1)).toBe("Commands")
    expect(selected().closest("[role=group]")!.getAttribute("data-group")).toBe("command")
    expect(document.querySelector("[data-testid=palette-more-rows]")).toBeNull()
    // A new query starts from one page again.
    type("work")
    showAll("task")
    expect(drawn()).toBe(50)
  })

  it("moves with the arrows across groups and through expanded rows", () => {
    render()
    expect(selected().textContent).toContain("Pick a color")
    press("ArrowDown")
    press("ArrowDown")
    expect(selected().textContent).toContain("Working task 0")
    for (let i = 0; i < 5; i++) press("ArrowDown")
    expect(selected().textContent).toBe("Show 2 more")
    press("Enter")
    // The first row that was hidden takes the Show N more row's place, and the arrows go on through the rest.
    expect(selected().textContent).toContain("Working task 5")
    press("ArrowDown")
    expect(selected().textContent).toContain("Working task 6")
    press("ArrowDown")
    expect(selected().closest("[role=group]")!.getAttribute("data-group")).toBe("recent")
    press("ArrowUp")
    press("ArrowUp")
    expect(selected().textContent).toContain("Working task 5")
  })

  it("opens the selected item in a new tab on Cmd/Ctrl+Enter and keeps the palette open", () => {
    const open = vi.fn()
    vi.stubGlobal("open", open)
    render()
    press("Enter", { ctrlKey: true })
    expect(open).toHaveBeenCalledWith("/?session=tsk_ask", "_blank", "noopener")
    expect(input()).not.toBeNull()
    press("Enter")
    expect(window.location.pathname + window.location.search).toBe("/?session=tsk_ask")
    expect(document.querySelector("input[role=combobox]")).toBeNull()
  })

  it("ranks by the query: tasks first for a name, files first for an extension", () => {
    render()
    type("palette")
    expect(groupLabels()[0]).toBe("Tasks")
    type(".png")
    expect(groupLabels()[0]).toBe("Files")
    expect(groupRows("artifact")[0]).toContain("Screenshot")
  })

  it("ranks once per keystroke", () => {
    render()
    for (const text of ["p", "pa", "pal", ""]) {
      vi.mocked(rankPalette).mockClear()
      type(text)
      expect(rankPalette, JSON.stringify(text)).toHaveBeenCalledTimes(1)
    }
  })

  it("indexes the rows it searches once it has painted, before the first keystroke", async () => {
    vi.mocked(paletteIndex).mockClear()
    render()
    expect(paletteIndex).not.toHaveBeenCalled()
    await act(() => new Promise<void>((done) => requestAnimationFrame(() => setTimeout(done))))
    expect(paletteIndex).toHaveBeenCalledTimes(1)
    vi.mocked(rankPalette).mockClear()
    type("p")
    expect(vi.mocked(rankPalette).mock.calls[0]![0]).toBe(vi.mocked(paletteIndex).mock.calls[0]![0])
  })

  it("finds done tasks by the word and opens a Settings section by its name", () => {
    render()
    type("done")
    expect(groupLabels()).toEqual(["Tasks"])
    expect(groupRows("task")[0]).toContain("Finished thing")
    type("voice")
    expect(groupLabels()[0]).toBe("Settings")
    expect(groupRows("setting")[0]).toContain("Voice")
    press("Enter")
    expect(new URLSearchParams(window.location.search).get("settings")).toBe("voice")
    expect(document.querySelector("input[role=combobox]")).toBeNull()
  })

  it("turns a typed prefix into a chip that Backspace removes", () => {
    render()
    type(">")
    expect(document.querySelector("[data-testid=palette-scope]")!.textContent).toContain("Commands")
    expect(input().value).toBe("")
    expect(groupLabels()).toEqual(["Commands"])
    type("coordinator")
    expect(groupRows("command")[0]).toContain("Coordinator")
    type("")
    press("Backspace")
    expect(document.querySelector("[data-testid=palette-scope]")).toBeNull()
    expect(groupLabels()[0]).toBe("Waiting on Ada")
  })

  it("doesn't re-render on live updates; the next keystroke picks them up", async () => {
    render()
    // React Query batches observer notifications on a timer, so wait one out.
    await act(async () => {
      qc.setQueryData(keys.tasks, [task("tsk_new", "Late arrival", "needs_input", 0), ...TASKS])
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(groupRows("waiting").some((r) => r.startsWith("Late arrival"))).toBe(false)
    type("late")
    expect(groupRows("task")[0]).toContain("Late arrival")
  })
})

describe("project pins", () => {
  it("Pin and Unpin <project> pin and unpin it in the sidebar, the keyboard's way to the row's pin", () => {
    render()
    type(">pin box")
    expect(groupRows("command")[0]).toContain("Pin box-yard")
    press("Enter")
    expect(document.querySelector("input[role=combobox]")).toBeNull()
    expect(readPins()).toEqual({ prj_a: "pinned" })
    act(() => openPalette())
    type(">box-yard")
    expect(groupRows("command")).toEqual([expect.stringContaining("Unpin box-yard")])
    press("Enter")
    expect(readPins()).toEqual({ prj_a: "unpinned" })
  })
})
