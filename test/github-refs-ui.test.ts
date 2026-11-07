// @vitest-environment happy-dom
// GitHub references in the app's text: linked to the repo of the task or project the text is about (InRepo), in a
// new tab with the ↗, and a PR a task has wears its state's colours (merged is purple).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ChatLine } from "../web/src/components/ChatLine.js"
import { InRepo, LinkedText, Markdown } from "../web/src/components/ui.js"
import { keys } from "../web/src/lib/queries.js"
import type { ChatMessage, Project, Task } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const GAME = "https://github.com/acme/keep-the-castle"
const projects = [{ id: "prj_castle", name: "keep-the-castle", repo: "acme/keep-the-castle" }] as Project[]
const cave = {
  id: "task_cave0406",
  projectId: "prj_castle",
  title: "Level 3 PR #406: Cave supply route",
  status: "done",
  prUrl: `${GAME}/pull/406`,
  prState: "merged",
  summary: "PR #406 merged clean with level3-epic and was pushed (head 5f3a9c1e).",
  previews: [],
  prompt: "",
  claudeCostUsd: 0,
  claudeTokens: 0,
  pendingCount: 0,
  updatedAt: Date.now(),
  createdAt: Date.now(),
} as unknown as Task

let root: Root
let host: HTMLElement
let qc: QueryClient

beforeEach(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  history.replaceState(null, "", "/")
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const k of [keys.schedules, keys.artifacts, keys.boxes]) qc.setQueryData(k, [])
  qc.setQueryData(keys.projects, projects)
  qc.setQueryData(keys.tasks, [cave])
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const render = (node: ReactNode) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, node)))
const linkTo = (href: string) => host.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)
const hasMark = (a: Element) => Boolean(a.querySelector("[data-external-mark]"))
const inTask = (node: ReactNode) => createElement(InRepo, { taskId: "task_cave0406", children: node })

describe("GitHub references in markdown", () => {
  it("links PR, issue and commit references to the task's repo, in a new tab with the ↗", () => {
    render(inTask(createElement(Markdown, null, "PR #406 merged as 5f3a9c1e; #12 is next.")))
    const pr = linkTo(`${GAME}/pull/406`)!
    expect(pr.textContent).toBe("PR #406")
    expect(pr.target).toBe("_blank")
    expect(hasMark(pr)).toBe(true)
    const commit = linkTo(`${GAME}/commit/5f3a9c1e`)!
    expect(commit.textContent).toBe("5f3a9c1e")
    expect(hasMark(commit)).toBe(true)
    // An issue nobody's PR has: a plain new-tab link, no PR glyph.
    const issue = linkTo(`${GAME}/issues/12`)!
    expect(issue.dataset.prLink).toBeUndefined()
    expect(hasMark(issue)).toBe(true)
  })

  it("colours a PR a task has by its state, a bare #N included", () => {
    render(inTask(createElement(Markdown, null, "PR #406 merged, see #406.")))
    expect(linkTo(`${GAME}/pull/406`)!.dataset.prLink).toBe("merged")
    expect(linkTo(`${GAME}/pull/406`)!.className).toContain("text-merged-fg")
    const bare = linkTo(`${GAME}/issues/406`)!
    expect(bare.dataset.prLink).toBe("merged")
    expect(bare.className).toContain("text-merged-fg")
  })

  it("leaves numbers as text where no repo is known", () => {
    render(createElement(Markdown, null, "PR #406 merged as 5f3a9c1e; #12 is next."))
    expect(host.querySelectorAll("a")).toHaveLength(0)
    expect(host.textContent).toBe("PR #406 merged as 5f3a9c1e; #12 is next.")
  })
})

describe("where text is shown", () => {
  it("links a task notice's text to its task's repo", () => {
    const m: ChatMessage = {
      id: "chat_cave01",
      role: "notice",
      content: "✅ **Level 3 PR #406: Cave supply route** is done: PR #406 merged clean (head 5f3a9c1e).",
      meta: { taskId: "task_cave0406", projectId: "prj_castle" },
      createdAt: Date.now(),
    }
    render(createElement(InRepo, { mentions: true, children: createElement(ChatLine, { m, onFollowUp: () => {} }) }))
    expect(linkTo(`${GAME}/pull/406`)!.dataset.prLink).toBe("merged")
    expect(linkTo(`${GAME}/commit/5f3a9c1e`)).toBeTruthy()
  })

  it("keeps plain text plain", () => {
    render(inTask(createElement(LinkedText, { text: "Build and unit tests pass." })))
    expect(host.innerHTML).toBe("Build and unit tests pass.")
  })
})
