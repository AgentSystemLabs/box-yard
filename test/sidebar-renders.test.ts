// @vitest-environment happy-dom
// A live task update (an SSE "task" event, written into the cache with upsert) re-renders only that task's sidebar row
// and its project's group: not every row, not the Coordinator's chat. Renders are counted per component with a stand-in
// React DevTools hook (as scripts/perf/sse-renders.mjs does in a browser), installed before react-dom loads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const renders = vi.hoisted(() => {
  const counts = new Map<string, number>()
  type Fiber = { tag: number; flags: number; type: unknown; alternate: Fiber | null; child: Fiber | null; sibling: Fiber | null }
  // Function, class, forwardRef and simple-memo components.
  const COMPONENTS = new Set([0, 1, 11, 15])
  const name = (f: Fiber) => {
    const t = f.type as { displayName?: string; name?: string; render?: { displayName?: string; name?: string } } | null
    return t?.displayName || t?.name || t?.render?.displayName || t?.render?.name || "anon"
  }
  const visit = (fiber: Fiber | null, mounting: boolean) => {
    for (let f = fiber; f; f = f.sibling) {
      const mount = mounting || !f.alternate
      // PerformedWork: the component ran in this commit (a memo bail-out doesn't set it).
      if (COMPONENTS.has(f.tag) && (mount || (f.flags & 1) === 1)) counts.set(name(f), (counts.get(name(f)) ?? 0) + 1)
      if (f.child && (mount || f.child !== f.alternate!.child)) visit(f.child, mount)
    }
  }
  ;(globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    onCommitFiberRoot: (_id: number, root: { current: Fiber }) => visit(root.current.child, !root.current.alternate),
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    checkDCE() {},
  }
  return counts
})

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { keys, upsert } from "../web/src/lib/queries.js"
import type { Project, Task, TaskStatus } from "../shared/types"
import { APP_HOME } from "../web/src/lib/navigation.js"
import { sidebarGroup } from "./sidebarTree.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const project = (id: string, name: string) => ({ id, name, repo: null, description: "", notes: [], envKeys: [], baseBranch: "main", runner: "box", identityId: "idn_default", gpuMachine: { gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null }, docker: { image: null, dockerfile: null }, createdAt: now, color: null }) as unknown as Project
const task = (id: string, projectId: string, title: string, status: TaskStatus, extra: Partial<Task> = {}) =>
  ({ id, projectId, title, status, prompt: "", prUrl: null, prState: null, prMergedAt: null, previews: [], waitFor: [], question: null, error: null, scheduleId: null, outcome: null, createdAt: now - 60_000, updatedAt: now - 60_000, ...extra }) as unknown as Task

const YARD = project("prj_yard01", "box-yard")
const SITE = project("prj_site01", "marketing-site")
const NEBULA = project("prj_nebula", "nebula")
const TASKS = [
  task("task_ask001", YARD.id, "Check SSH into the bench", "needs_input"),
  task("task_run001", YARD.id, "Three-pane layout", "working"),
  task("task_run002", YARD.id, "Sticky scroll", "working"),
  task("task_pr0001", SITE.id, "Refresh the portfolio", "pr_ready", { prUrl: "https://github.com/o/site/pull/19" }),
  task("task_run003", SITE.id, "Dark mode", "working"),
  task("task_fail01", NEBULA.id, "Ship the renderer", "failed"),
  task("task_run004", NEBULA.id, "Profile the shader", "working"),
]

class FakeEventSource {
  onmessage: unknown = null
  onerror: unknown = null
  onopen: unknown = null
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

let root: Root
let host: HTMLElement
let qc: QueryClient

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  ;(window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 1440, height: 900 })
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
  vi.stubGlobal("EventSource", FakeEventSource)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  history.replaceState(null, "", APP_HOME)
  sessionStorage.setItem("box-yard:landed", "1")
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.agentSettings, { settings: DEFAULT_SETTINGS, sources: {}, defaults: DEFAULT_SETTINGS })
  qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.chat, [])
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, TASKS)
  qc.setQueryData(keys.projects, [YARD, SITE, NEBULA])
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

/** Write a task update into the cache as the SSE stream does, and count what rendered (React Query notifies on a timer). */
async function liveUpdate(id: string, patch: Partial<Task>) {
  renders.clear()
  await act(async () => {
    qc.setQueryData<Task[]>(keys.tasks, (list) => upsert(list, { ...list!.find((t) => t.id === id)!, ...patch }))
    await new Promise((r) => setTimeout(r, 20))
  })
  return Object.fromEntries(renders)
}

const nav = () => document.querySelector<HTMLElement>("nav[aria-label='Projects and tasks']")!
const row = (title: string) => [...nav().querySelectorAll("button")].filter((b) => b.textContent?.includes(title))

describe("a live task update in the Coordinator view", () => {
  it("re-renders that task's row and its project's group, not every row or the chat", async () => {
    expect(row("Dark mode")).toHaveLength(1)
    const counts = await liveUpdate("task_run003", { updatedAt: now, contextTokens: 42_000 })
    expect(counts.TaskRow).toBe(1)
    expect(counts.ProjectGroup).toBe(1)
    // The Coordinator's chat reads only whether there are tasks, and its PR button only the open PR count.
    expect(counts.ChatPanel).toBeUndefined()
    expect(counts.PullRequestsButton).toBeUndefined()
    expect(counts.WaitingOnYou).toBeUndefined()
  })

  it("still draws what changed: a task that asks moves into Waiting on you, with its project's count", async () => {
    const counts = await liveUpdate("task_run004", { status: "needs_input", question: "Which GPU?" })
    expect(counts.TaskRow).toBe(2) // under its project, and its new copy in Waiting on you
    expect(counts.ProjectGroup).toBe(1)
    expect(counts.WaitingOnYou).toBe(1)
    const waiting = sidebarGroup(nav(), "Waiting on you")!
    expect(waiting.textContent).toContain("Profile the shader")
    expect(row("Profile the shader")).toHaveLength(2)
    expect(row("Profile the shader").every((b) => b.textContent?.includes("asks"))).toBe(true)
  })
})
