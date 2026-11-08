// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { AgentIcon } from "../web/src/components/ui.js"
import { agentIconCue, iconCue, TaskStatusIcon } from "../web/src/components/TaskIcon.js"
import { keys } from "../web/src/lib/queries.js"
import type { Project, SettingsInfo, Task, TaskStatus } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let qc: QueryClient

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.projects, [{ id: "prj_demo01", name: "demo", color: "lime", iconUrl: null, captainIcon: "bot", createdAt: 1 } as Project])
  qc.setQueryData(keys.tasks, [])
  qc.setQueryData(keys.agentSettings, { settings: { captainIcon: "captain-cap" } } as unknown as SettingsInfo)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe("AgentIcon", () => {
  const render = (props: Parameters<typeof AgentIcon>[0]) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(AgentIcon, props))))
  const icon = () => host.querySelector('[data-testid="agent-icon"]')!
  const live = () => host.querySelector('[aria-live="polite"]')!

  const cue = () => host.querySelector("[data-cue]")?.getAttribute("data-cue") ?? null

  it("pulses and announces Working… only while busy, and holds still under reduced motion", () => {
    render({ busy: true })
    // The header's status: a gentle pulse, only where motion is welcome; a still sky dot is always visible.
    expect(icon().getAttribute("class")).toContain("motion-safe:animate-pulse")
    expect(icon().getAttribute("class")).not.toMatch(/(^| )animate-/)
    expect(cue()).toBe("working")
    expect(host.querySelector("[data-cue]")!.className).not.toContain("hidden")
    expect(host.querySelector("[data-cue]")!.className).not.toContain("animate")
    expect(host.querySelector("[data-cue]")!.parentElement!.className).not.toContain("animate")
    expect(live().textContent).toBe("Working…")
    expect(host.querySelector('[title="Working…"]')).not.toBeNull()

    render({ busy: false })
    expect(icon().getAttribute("class")).not.toContain("animate-pulse")
    expect(cue()).toBeNull()
    expect(live().textContent).toBe("")
    expect(host.querySelector("[title]")).toBeNull()
  })

  it("says a Captain compacts as it works, and wears a still red dot after an error", () => {
    render({ busy: false, compacting: true })
    expect(icon().getAttribute("class")).toContain("motion-safe:animate-pulse")
    expect(live().textContent).toBe("Compacting…")
    render({ busy: false, error: true })
    expect(icon().getAttribute("class")).not.toContain("animate-pulse")
    expect(cue()).toBe("failed")
    expect(host.querySelector("[data-cue]")!.className).not.toContain("hidden")
    expect(live().textContent).toBe("Error")
    expect(host.querySelector('[title="Error"]')).not.toBeNull()
  })

  it("is the Coordinator's helm in its chat, and a Captain's icon in theirs, as in their boxes", () => {
    render({ busy: false, kind: "coordinator" })
    expect(icon().getAttribute("class")).toContain("lucide-helm")
    // No project: Settings' icon, the cap.
    render({ busy: true })
    expect(icon().getAttribute("data-captain-icon")).toBe("captain-cap")
    expect(icon().querySelector("svg")!.getAttribute("class")).toContain("lucide-captain-cap")
    expect(icon().getAttribute("class")).toContain("motion-safe:animate-pulse")
    // A project that picked the bot.
    render({ busy: false, projectId: "prj_demo01", color: "lime" })
    expect(icon().getAttribute("data-captain-icon")).toBe("bot")
    expect(icon().querySelector("svg")!.getAttribute("class")).toContain("lucide-bot")
  })

  it.each(["captain", "coordinator"] as const)("gives %s failures precedence over work without stopping the busy glyph's fade", (kind) => {
    render({ kind, busy: true, compacting: true, error: true })
    expect(cue()).toBe("failed")
    expect(live().textContent).toBe("Error")
    expect(icon().getAttribute("class")).toContain("motion-safe:animate-pulse")
    expect(host.querySelector("[data-cue]")!.parentElement).toBe(icon().parentElement)
    expect(host.querySelector("[data-cue]")!.parentElement!.className).not.toContain("animate")
  })

  it.each(["captain", "coordinator"] as const)("uses the same named corner dot on %s navigation tiles, including uploaded Captain images", (kind) => {
    qc.setQueryData(keys.projects, [{ id: "prj_demo01", name: "demo", color: "lime", iconUrl: "/api/projects/prj_demo01/icon", captainIcon: null, createdAt: 1 } as Project])
    render({ kind, projectId: "prj_demo01", color: "lime", busy: true, tile: true, announce: false })
    const wrapper = host.querySelector('[data-testid="agent-status-icon"]')!
    expect(wrapper.getAttribute("aria-label")).toBe("Working…")
    expect(wrapper.getAttribute("title")).toBe("Working…")
    expect(wrapper.querySelectorAll("[data-cue]")).toHaveLength(1)
    expect(wrapper.className).not.toContain("animate")
    expect(icon().className).toContain("motion-safe:animate-pulse")
    if (kind === "captain") expect(wrapper.querySelector("img")).not.toBeNull()
    expect(wrapper.querySelector("[aria-live]")).toBeNull()
  })
})

describe("actual model status sources", () => {
  it("maps only active task states to working and leaves queued, waiting and finished states unmarked", () => {
    const expected: Record<TaskStatus, ReturnType<typeof iconCue>> = { starting: "working", working: "working", needs_input: "asks", failed: "failed", queued: null, waiting: null, idle: null, pr_ready: null, done: null }
    for (const status of Object.keys(expected) as TaskStatus[]) {
      const task = { id: "task_demo01", title: "Build the preview", icon: "wrench", projectId: "prj_demo01", status, error: "Stale error", question: "Old question" } as Task
      act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(TaskStatusIcon, { task }))))
      const wrapper = host.querySelector('[data-testid="task-status-icon"]')!
      expect(iconCue(status), status).toBe(expected[status])
      expect(wrapper.querySelector("[data-cue]")?.getAttribute("data-cue") ?? null, status).toBe(expected[status])
      if (expected[status]) {
        expect(wrapper.getAttribute("aria-label"), status).toBeTruthy()
        expect(wrapper.getAttribute("title"), status).toBe(wrapper.getAttribute("aria-label"))
      }
      expect(wrapper.className, status).not.toContain("animate")
      expect(wrapper.querySelector("svg")!.getAttribute("class")!.includes("motion-safe:animate-pulse"), status).toBe(expected[status] === "working")
    }
  })

  it("does not invent feedback or work for unknown, idle or compact-queued manager state", () => {
    expect(agentIconCue(undefined)).toBeNull()
    expect(agentIconCue(null)).toBeNull()
    expect(agentIconCue({})).toBeNull()
    expect(agentIconCue({ busy: false, compacting: false, error: null })).toBeNull()
    const queued = { busy: false, compacting: false, error: null, compactQueued: true }
    expect(agentIconCue(queued)).toBeNull()
    expect(agentIconCue({ busy: true })).toBe("working")
    expect(agentIconCue({ compacting: true })).toBe("working")
    expect(agentIconCue({ busy: true, compacting: true, error: "Failed" })).toBe("failed")
  })
})
