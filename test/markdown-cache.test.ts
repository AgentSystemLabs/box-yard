// @vitest-environment happy-dom
// Parsed Markdown outlives an entity added, removed or renamed elsewhere: every message on screen parsing again on each
// new task, artifact or box was a 100 ms stall on a phone with a Captain's chat open.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { InRepo, Markdown } from "../web/src/components/ui.js"
import { keys } from "../web/src/lib/queries.js"
import type { BoxInfo, Project, Task } from "../shared/types.js"

// Every parse goes through react-markdown.
const parses = vi.hoisted(() => ({ texts: [] as string[] }))
vi.mock("react-markdown", async (importOriginal) => {
  const mod = await importOriginal<typeof import("react-markdown")>()
  return { ...mod, default: (options: { children?: string }) => (parses.texts.push(options.children ?? ""), mod.default(options)) }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project = { id: "prj_mdcache01", name: "box-yard", repo: "acme/box-yard" } as Project
const task = (id: string, title: string, status = "running") => ({ id, projectId: project.id, title, status }) as unknown as Task
const box = (id: string) => ({ id, status: "ready", residentTasks: [] }) as unknown as BoxInfo
const tasks = [task("task_mdcache01", "Ship the fix")]

// Unique per test: the parse cache is the app's, shared across tests.
let n = 0
let texts: { plain: string; mentions: string; title: string; box: string }

let root: Root
let host: HTMLElement
let qc: QueryClient

const render = () =>
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(Markdown, null, texts.plain),
        createElement(Markdown, null, texts.mentions),
        createElement(Markdown, null, texts.title),
        createElement(Markdown, null, texts.box),
      ),
    ),
  )
// React Query tells the entity index a moment later.
const update = (key: readonly unknown[], data: unknown) =>
  act(() => {
    qc.setQueryData(key, data)
    vi.advanceTimersByTime(0)
  })
// What's linked, by its text.
const links = () => [...host.querySelectorAll("a")].map((a) => a.textContent)

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  n++
  texts = {
    plain: `Message ${n}: nothing to link, just **bold** and \`code\`.`,
    mentions: `Message ${n}: picked up task_mdcache01, then task_mdnew${String(n).padStart(4, "0")}.`,
    title: `Message ${n}: next is **Write the docs ${n}**.`,
    box: `Message ${n}: it runs on box local-md${String(n).padStart(4, "0")}.`,
  }
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const k of [keys.schedules, keys.artifacts]) qc.setQueryData(k, [])
  qc.setQueryData(keys.projects, [project])
  qc.setQueryData(keys.tasks, tasks)
  qc.setQueryData(keys.boxes, [])
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  render()
  parses.texts = []
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  qc.clear()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("Markdown's parse cache", () => {
  it("keeps every message parsed when an entity none of them mention is added, renamed or removed", () => {
    expect(links()).toEqual(["task_mdcache01"])
    update(keys.tasks, [...tasks, task("task_unrelated01", "Something else")])
    update(keys.tasks, [...tasks, task("task_unrelated01", "Something else, renamed")])
    update(keys.boxes, [box("local-unrelated")])
    update(keys.tasks, tasks)
    expect(parses.texts).toEqual([])
    expect(links()).toEqual(["task_mdcache01"])
  })

  it("parses again just the message whose mention now links: a new task's id, its bold title, a new box", () => {
    const id = `task_mdnew${String(n).padStart(4, "0")}`
    update(keys.tasks, [...tasks, task(id, "Something new")])
    expect(parses.texts).toEqual([texts.mentions])
    expect(links()).toEqual(["task_mdcache01", id])

    parses.texts = []
    update(keys.tasks, [...tasks, task(id, "Something new"), task("task_mddocs001", `Write the docs ${n}`)])
    expect(parses.texts).toEqual([texts.title])
    expect(links()).toContain(`Write the docs ${n}`)

    parses.texts = []
    const boxId = `local-md${String(n).padStart(4, "0")}`
    update(keys.boxes, [box(boxId)])
    expect(parses.texts).toEqual([texts.box])
    // A box's link (AppLink renders it as a span where it has no page to go to).
    expect(host.innerHTML).toContain(`<span>${boxId}</span>`)
  })

  it("parses again when a mention stops linking: its task deleted", () => {
    update(keys.tasks, [])
    expect(parses.texts).toEqual([texts.mentions])
    expect(links()).toEqual([])
  })

  it("parses a message the first time it's shown under another repo", () => {
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(InRepo, { projectId: project.id }, createElement(Markdown, null, texts.plain)))))
    expect(parses.texts).toEqual([texts.plain])
  })
})
