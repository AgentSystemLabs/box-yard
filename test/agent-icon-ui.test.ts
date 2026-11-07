// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { AgentIcon } from "../web/src/components/ui.js"
import { keys } from "../web/src/lib/queries.js"
import type { Project, SettingsInfo } from "../shared/types.js"

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
    // The header's status: a gentle pulse, only where motion is welcome; under reduced motion a still sky dot instead.
    expect(icon().getAttribute("class")).toContain("motion-safe:animate-pulse")
    expect(icon().getAttribute("class")).not.toMatch(/(^| )animate-/)
    expect(cue()).toBe("working")
    expect(host.querySelector("[data-cue]")!.className).toContain("hidden")
    expect(host.querySelector("[data-cue]")!.className).toContain("motion-reduce:block")
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
})
