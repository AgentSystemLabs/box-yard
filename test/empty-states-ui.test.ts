// @vitest-environment happy-dom
// First-run and empty states say what to do next, with one thing to press: a new project's Captain chat offers
// requests to start from (put in the box, never sent), and the sidebar's "No projects yet" comes with its button.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { CaptainTab } from "../web/src/components/CaptainTab.js"
import { captainStarters } from "../web/src/components/EmptyCaptain.js"
import { Sidebar } from "../web/src/components/Sidebar.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { keys } from "../web/src/lib/queries.js"
import type { CaptainMessage, CaptainState, Project, Task } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project = (extra: Partial<Project> = {}) =>
  ({ id: "prj_demo01", name: "demo", description: "", repo: null, baseBranch: "main", envKeys: [], notes: [], createdAt: 0, updatedAt: 0, ...extra }) as unknown as Project
const task = (id: string, projectId: string, title: string, status: Task["status"]) =>
  ({ id, projectId, title, status, prompt: "", prUrl: null, prState: null, prMergedAt: null, previews: [], waitFor: [], question: null, error: null, scheduleId: null, outcome: null, createdAt: 1, updatedAt: 1 }) as unknown as Task
const idle: CaptainState = {
  projectId: "prj_demo01", busy: false, usage: { tokens: null, window: null, updatedAt: null }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null,
} as CaptainState

let root: Root
let host: HTMLElement
let qc: QueryClient
let fetches: string[]

beforeEach(() => {
  fetches = []
  // Nothing here should need the server; note what was asked for and leave it pending.
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    fetches.push(`${init?.method ?? "GET"} ${url}`)
    return new Promise(() => {})
  })
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const k of [keys.tasks, keys.schedules, keys.artifacts, keys.boxes, keys.notifications]) qc.setQueryData(k, [])
  qc.setQueryData(keys.agentSettings, { settings: DEFAULT_SETTINGS, sources: {}, defaults: DEFAULT_SETTINGS })
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

const render = (node: ReactNode) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, node)))
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name)

describe("captainStarters", () => {
  it("starts a GitHub project from its issues, with the repo as owner/name however it was written", () => {
    expect(captainStarters({ name: "site", repo: "https://github.com/acme/site.git" }, false)).toEqual([
      "Pick the easiest open issue in acme/site and fix it in a PR",
      "List the open issues in acme/site and suggest which to start with",
      "Look through acme/site and tell me the 3 riskiest parts of the code",
    ])
  })

  it("never mentions issues or PRs without a GitHub repo", () => {
    for (const repo of ["https://gitlab.com/acme/site", null, "  "]) {
      const starters = captainStarters({ name: "site", repo }, false)
      expect(starters.length).toBeGreaterThan(1)
      expect(starters.join(" ")).not.toMatch(/issue|PR/)
    }
    expect(captainStarters({ name: "site", repo: "https://gitlab.com/acme/site" }, false)[0]).toContain("the site repo")
    expect(captainStarters({ name: "recipes", repo: null }, false)[0]).toBe("Plan the first steps for recipes, then start on the first one")
  })

  it("asks about the tasks once a project has some", () => {
    expect(captainStarters({ name: "site", repo: "acme/site" }, true)).toEqual(["What's open in site?", "Summarize what the agents finished today", "Which tasks need me?"])
  })
})

describe("An empty Captain chat", () => {
  const renderCaptain = (p: Project) => {
    qc.setQueryData(keys.projects, [p])
    qc.setQueryData<CaptainMessage[]>(keys.captainMessages(p.id), [])
    qc.setQueryData<CaptainState>(keys.captain(p.id), idle)
    qc.setQueryData(keys.captainCompactions(p.id), [])
    render(createElement(CaptainTab, { project: p }))
  }
  const empty = () => host.querySelector<HTMLElement>("[data-testid=captain-empty]")!

  it("gives a project with no tasks its first step, and a starter goes in the box without being sent", () => {
    renderCaptain(project({ repo: "acme/demo" }))
    expect(empty().querySelector("h2")!.textContent).toBe("Give demo its first task")
    expect(empty().textContent).toContain("It starts a task for each request and reports back here")
    const starter = button("Pick the easiest open issue in acme/demo and fix it in a PR")!
    expect(starter.closest("[role=group]")!.getAttribute("aria-label")).toBe("Start from")
    click(starter)
    const box = host.querySelector("textarea")!
    expect(box.value).toBe("Pick the easiest open issue in acme/demo and fix it in a PR")
    expect(document.activeElement).toBe(box)
    // Nothing went to the Captain: the chat is still empty and no message was posted.
    expect(qc.getQueryData<CaptainMessage[]>(keys.captainMessages("prj_demo01"))).toEqual([])
    // (Focusing the box may ask for the Captain's warm process: that sends nothing to it.)
    expect(fetches.filter((f) => f.startsWith("POST") && !f.includes("/captain/warm"))).toEqual([])
    expect(empty()).not.toBeNull()
  })

  it("asks about the work when the project already has tasks, even finished ones", () => {
    qc.setQueryData(keys.tasks, [task("task_done01", "prj_demo01", "Old fix", "done")])
    renderCaptain(project())
    expect(empty().querySelector("h2")!.textContent).toBe("Ask the demo Captain")
    click(button("Which tasks need me?")!)
    expect(host.querySelector("textarea")!.value).toBe("Which tasks need me?")
    // (Focusing the box may ask for the Captain's warm process: that sends nothing to it.)
    expect(fetches.filter((f) => f.startsWith("POST") && !f.includes("/captain/warm"))).toEqual([])
  })

  it("switches to the first step's wording if the task list arrives empty", async () => {
    qc.removeQueries({ queryKey: keys.tasks })
    renderCaptain(project())
    // Not loaded yet: the questions, which suit any project.
    expect(empty().querySelector("h2")!.textContent).toBe("Ask the demo Captain")
    // React Query tells its observers on a timer, so wait inside act.
    await act(async () => {
      qc.setQueryData(keys.tasks, [])
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(empty().querySelector("h2")!.textContent).toBe("Give demo its first task")
  })
})

describe("sidebar empty states", () => {
  const nav = () => document.querySelector<HTMLElement>("nav[aria-label='Projects and tasks']")!

  it("with no projects, says what a project is and opens New project from right there", () => {
    qc.setQueryData(keys.projects, [])
    render(createElement(Sidebar))
    expect(nav().textContent).toContain("No projects yet.")
    expect(nav().textContent).toContain("A project is a repo")
    const create = [...nav().querySelectorAll("button")].find((b) => b.textContent === " New project")!
    expect(create).toBeDefined()
    click(create)
    expect(document.querySelector("[role=dialog]")?.textContent).toContain("Create project")
  })
})
