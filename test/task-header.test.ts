// @vitest-environment happy-dom
// Task identity stays compact; secondary details and actions live in ⓘ.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, Fragment } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TaskHeader } from "../web/src/components/TaskHeader.js"
import type { Artifact, MergeRequest, Project, Task } from "../shared/types.js"
import { LOCAL_UNSANDBOXED } from "../shared/runner.js"
import { keys } from "../web/src/lib/queries.js"
import { ConfirmHost } from "../web/src/components/ConfirmDialog.js"
import { currentConfirm, settleConfirm } from "../web/src/lib/confirm.js"
import { undoClose } from "../web/src/lib/inbox.js"
import { resetClosedTasks } from "../web/src/lib/closedTasks.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const prUrl = "https://github.com/acme/box-yard/pull/76"
const project: Project = { id: "prj_demo01", name: "box-yard", description: "", repo: null, baseBranch: "main", envKeys: [], notes: [], boxSize: null, createdAt: 0, updatedAt: 0 }

function task(over: Partial<Task> = {}): Task {
  return {
    id: "task_head000001",
    projectId: project.id,
    title: "Generic hook system (Coordinator/Captain automations on task events)",
    prompt: "",
    status: "working",
    boxId: "pleasing-shepherd-27426",
    sessionId: "s",
    branch: "boxyard/hooks",
    prUrl,
    prState: "open",
    prMergedAt: null,
    prMergedBy: null,
    previews: [{ port: 4020, url: "https://example.com/4020", label: "Demo" }],
    question: null,
    summary: null,
    error: null,
    waitReason: null,
    turnCount: 3,
    pendingCount: 0,
    lastArchivedAt: null,
    scheduleId: null,
    outcome: null,
    contextTokens: 576_000,
    contextWindow: 1_000_000,
    compactPending: false,
    compacting: false,
    model: "claude-opus-5-5",
    effort: "xhigh",
    claudeCostUsd: 0,
    claudeTokens: 0,
    routingRule: "big-features",
    routingReason: "Multi-file feature",
    mergeRequest: null,
    createdAt: Date.now() - 3_600_000,
    updatedAt: Date.now(),
    ...over,
  }
}

const file = (i: number): Artifact => ({ id: `art_${i}`, projectId: project.id, taskId: "task_head000001", title: `f${i}.png`, filename: `f${i}.png`, mime: "image/png", size: 1, url: `/artifacts/art_${i}/f${i}.png`, createdAt: 1000 + i })
const requested: MergeRequest = { prNumber: 76, prUrl, requestedAt: 1, deliveredAt: 2 }

describe("TaskHeader", () => {
  let root: Root
  let host: HTMLElement

  beforeEach(() => {
    localStorage.clear()
    // The ⓘ details read the identities list; no request leaves the test (happy-dom's origin is localhost:3000).
    vi.stubGlobal("fetch", () => new Promise(() => {}))
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

  const render = (t: Task, files: Artifact[] = []) =>
    act(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(TaskHeader, { task: t, project, schedule: null, files }),
        ),
      ),
    )
  const meta = () => document.querySelector<HTMLElement>('[data-testid="task-meta"]')!
  const metaText = () => meta().textContent!.replace(/\s+/g, " ")

  const icon = () => document.querySelector<HTMLElement>('[data-testid="task-title"] [data-testid="task-status-icon"]')!

  it("reads top-down: the task's icon and title, then the PR and preview to act on, then the files", () => {
    render(task(), [file(1), file(2)])
    const text = metaText()
    const order = ["Generic hook system", "PR #76", "Preview", "2 files"].map((s) => text.indexOf(s))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // No status word: the task's icon is its status, and names it to screen readers.
    expect(text).not.toContain("Working")
    expect(icon().getAttribute("aria-label")).toBe("Working")
    // One preview needs no port in its label (the tooltip has it); several show theirs.
    const preview = document.querySelector<HTMLAnchorElement>('[data-testid="preview-chip"]')!
    expect(preview.textContent!.trim()).toBe("Preview")
    expect(preview.title).toContain("port 4020")
    render(task({ previews: [{ port: 4020, url: "https://example.com/4020", label: "Web" }, { port: 4021, url: "https://example.com/4021", label: "API" }] }))
    expect([...document.querySelectorAll('[data-testid="preview-chip"]')].map((a) => a.textContent!.trim())).toEqual(["Preview:4020", "Preview:4021"])
    // Where it runs is only in ⓘ's details.
    expect(text).not.toContain("Upstash")
    // Details live in the ⓘ sheet, not the header.
    expect(document.querySelector("header")!.textContent).not.toContain("claude-opus-5-5")
    expect(text).not.toContain("Active")
    expect(text).not.toContain("58%")
    expect(document.querySelector("header")!.className).toContain("sticky")
  })

  // Container queries don't run in happy-dom, so these check the classes that fold the header (HEADER_FOLD) and the
  // order and names it keeps; the screenshots in the PR show the real widths.
  const FOLDED = "@max-[36rem]/head:sr-only"
  const renderInPanel = (t: Task, files: Artifact[] = [], onBack = () => {}) =>
    act(() =>
      root.render(
        createElement(QueryClientProvider, { client: new QueryClient() }, createElement(TaskHeader, { task: t, project, schedule: null, files, onBack })),
      ),
    )

  it("is one row in a panel: back, the task's icon and title, the PR, preview and files, then ⓘ", () => {
    renderInPanel(task(), [file(1), file(2)])
    const row = meta()
    const controls = [...row.querySelectorAll<HTMLElement>("button, a")]
    expect(controls.map((el) => el.getAttribute("data-testid") ?? el.getAttribute("data-pr-state") ?? el.getAttribute("aria-label"))).toEqual([
      "Back",
      "task-title",
      "open",
      "preview-chip",
      "2 files, 2 new",
      "Task details and more actions",
    ])
    expect(row.querySelector("h2")!.contains(controls[1]!)).toBe(true)
    // The title is one truncated line, with the task's icon before it.
    const title = controls[1]!
    expect(title.lastElementChild!.className).toContain("truncate")
    expect(title.firstElementChild!.contains(icon())).toBe(true)
    expect(icon().dataset.status).toBe("working")
    expect(title.title).toContain("Generic hook system")
    expect(title.title).toContain("Working")
  })

  it("folds its words away when narrow but keeps them for screen readers: the PR, preview and files", () => {
    renderInPanel(task(), [file(1), file(2)])
    // The state never takes words in the header: its icon says it, by name to a screen reader.
    expect(document.querySelector('[data-testid="task-title"]')!.textContent).toBe(task().title)
    expect(icon().getAttribute("role")).toBe("img")
    const pr = document.querySelector<HTMLButtonElement>('[data-pr-state="open"]')!
    expect(pr.textContent).toContain("PR #76")
    expect([...pr.querySelectorAll("span")].find((el) => el.textContent === "PR #76")!.className).toBe(FOLDED)
    // It opens the PR sheet (which has Open on GitHub), so it has no ↗.
    expect(pr.getAttribute("aria-haspopup")).toBe("dialog")
    expect(pr.querySelector("[data-external-mark]")).toBeNull()
    const preview = document.querySelector<HTMLAnchorElement>('[data-testid="preview-chip"]')!
    expect([...preview.querySelectorAll("span")].find((el) => el.textContent === "Preview")!.className).toBe(FOLDED)
    const files = document.querySelector<HTMLButtonElement>('button[aria-label="2 files, 2 new"]')!
    expect(files.textContent).toBe(" 2 files")
    expect(files.querySelector("span")!.className).toBe(FOLDED)
    expect(files.querySelector('[data-testid="files-new-dot"]')).not.toBeNull()
    // Each folded chip is an icon button: 32px drawn, 44px to a finger, like back and ⓘ.
    for (const chip of [pr, preview, files]) expect(chip.className).toContain("pointer-coarse:@max-[36rem]/head:min-w-11")
    // The harness is absent even on wide headers; the details still have it.
    renderInPanel(task({ agentCli: "codex" }))
    expect(document.querySelector('[data-testid="agent-cli-chip"]')).toBeNull()
  })

  it("opens the details from the title: the state in words, the full title and where it runs; Esc returns to the title", async () => {
    renderInPanel(task({ boxId: "this-computer", pendingCount: 2 }))
    const title = document.querySelector<HTMLButtonElement>('[data-testid="task-title"]')!
    expect(title.getAttribute("aria-haspopup")).toBe("dialog")
    title.focus()
    await act(async () => void title.click())
    expect(title.getAttribute("aria-expanded")).toBe("true")
    const sheet = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.textContent?.includes("Task details"))!
    const status = sheet.querySelector('[data-status="working"]')!
    expect(status.textContent).toContain("Working")
    expect(status.textContent).toContain("2 queued")
    expect(sheet.textContent).toContain("Generic hook system (Coordinator/Captain automations on task events)")
    const where = sheet.querySelector('[data-testid="task-details-placement"]')!
    expect(where.textContent).toContain("This computer")
    expect(where.querySelector("#local-warning-note")!.textContent).toBe(LOCAL_UNSANDBOXED)
    // The header's own queued link folds away when narrow; the details always have it.
    expect(meta().querySelector('[data-testid="task-chips"] > span')!.className).toContain("@max-[36rem]/head:hidden")
    await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(title)
    expect(title.getAttribute("aria-expanded")).toBe("false")
  })

  it("closes the details when its queued link opens the queue", async () => {
    renderInPanel(task({ pendingCount: 1 }))
    await act(async () => void document.querySelector<HTMLButtonElement>('[data-testid="task-title"]')!.click())
    const sheet = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.textContent?.includes("Task details"))!
    const queued = [...sheet.querySelectorAll("button")].find((b) => b.textContent === "1 queued")!
    await act(async () => void queued.click())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it("folds a pending merge into the PR chip instead of a separate pill or button", () => {
    render(task({ mergeRequest: requested }))
    const chip = document.querySelector('[data-pr-state="open"]')!
    expect(chip.textContent).toContain("PR #76")
    expect(chip.textContent).toContain("merging…")
    expect(document.querySelector("header [data-merge-state]")).toBeNull()
    expect(document.querySelector("header")!.textContent).not.toContain("Merge requested")
  })

  it("keeps an open PR visible and moves its merge action into details", async () => {
    render(task({ status: "pr_ready" }))
    expect(document.querySelector('[data-pr-state="open"]')!.textContent).toContain("PR #76")
    expect(document.querySelector("header [data-merge-state]")).toBeNull()
    await act(async () => void document.querySelector<HTMLButtonElement>('button[aria-label="Task details and more actions"]')!.click())
    expect(document.querySelector('[data-merge-state="ready"]')!.textContent).toContain("Merge PR")
    render(task({ status: "idle", prState: "merged", prMergedAt: 1 }))
    expect(document.querySelector("[data-merge-state]")).toBeNull()
    expect(document.querySelector('[data-pr-state="merged"]')!.textContent).toContain("Merged #76")
    // A merged PR is still an actionable chip (it opens the PR sheet), in the purple merged state.
    expect(document.querySelector('[data-pr-state="merged"]')!.className).toContain("border-merged")
  })

  const menuButtons = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
  const stopItem = () => menuButtons().find((b) => b.textContent!.trim() === "Stop task")
  const openMenu = () => act(async () => void document.querySelector<HTMLButtonElement>('button[aria-label="Task details and more actions"]')!.click())

  it("keeps Stop out of the header: a running task's state sits with its title, and ⓘ is the only other control", () => {
    render(task())
    const controls = [...meta().querySelectorAll("button, a")].filter((el) => !el.closest('[data-testid="task-chips"]'))
    expect(controls.map((el) => el.getAttribute("aria-label") ?? el.getAttribute("data-testid"))).toEqual(["task-title", "Task details and more actions"])
    // An info icon: it opens the task's details (with its less common actions under them), not a short ⋯ menu.
    const details = controls.at(-1)!
    expect(details.querySelector("svg")!.getAttribute("class")).toContain("lucide-info")
    expect(details.className).toContain("pointer-coarse:h-11 pointer-coarse:w-11")
    expect(icon().getAttribute("aria-label")).toBe("Working")
    expect(meta().textContent).not.toContain("Stop")
  })

  it("says the state with the task's icon: a gentle pulse while it works, a still dot when it asks or failed", () => {
    const cue = () => icon().querySelector("[data-cue]")?.getAttribute("data-cue") ?? null
    for (const [status, label, pulse, dot] of [
      ["working", "Working", true, "working"],
      ["starting", "Starting", true, "working"],
      ["needs_input", "Needs you", false, "asks"],
      ["failed", "Failed", false, "failed"],
      ["queued", "Queued", false, null],
      ["idle", "Idle", false, null],
      ["pr_ready", "PR ready", false, null],
      ["waiting", "Waiting on agent", false, null],
      ["done", "Done", false, null],
    ] as const) {
      renderInPanel(task({ status }))
      expect(icon().getAttribute("aria-label"), status).toBe(label)
      expect(icon().dataset.status).toBe(status)
      // The glyph pulses only where motion is welcome; the corner dot stays visible in either mode.
      expect(icon().querySelector("svg")!.getAttribute("class")!.includes("motion-safe:animate-pulse"), status).toBe(pulse)
      expect(cue(), status).toBe(dot)
      expect(meta().textContent, status).not.toContain(label)
    }
  })

  it.each(["working", "starting", "queued"] as const)("offers a red Stop task in ⓘ while the task is %s, and stops it", async (status) => {
    const calls: string[] = []
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`)
      return new Promise(() => {})
    })
    render(task({ status }))
    await openMenu()
    const stop = stopItem()!
    expect(stop).toBeDefined()
    expect(stop.className).toContain("text-red-300")
    expect(stop.title).toBe("Stop the agent's current turn")
    // With Delete, under the other actions.
    const labels = menuButtons().map((b) => b.textContent!.trim())
    expect(labels.slice(-2)).toEqual(["Stop task", "Delete task…"])
    await act(async () => void stop.click())
    expect(calls).toContain("POST /api/tasks/task_head000001/stop")
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it.each(["needs_input", "idle", "pr_ready", "failed", "done"] as const)("has no Stop in ⓘ while the task is %s", async (status) => {
    render(task({ status }))
    await openMenu()
    expect(menuButtons().some((b) => b.textContent!.trim() === "Delete task…")).toBe(true)
    expect(stopItem()).toBeUndefined()
  })

  it("marks new files with a dot, not a count badge", () => {
    render(task(), [file(1), file(2), file(3)])
    const chip = [...meta().querySelectorAll("button")].find((b) => b.textContent?.includes("3 files"))!
    expect(chip.getAttribute("aria-label")).toBe("3 files, 3 new")
    expect(chip.querySelector('[data-testid="files-new-dot"]')).not.toBeNull()
    expect(chip.textContent).not.toContain("new")
  })

  it("keeps context usage and manual Compact out of the header", () => {
    render(task({ contextTokens: 700_000 }))
    expect(metaText()).not.toContain("70%")
    expect(metaText()).not.toContain("Compact")
    render(task({ contextTokens: 810_000 }))
    expect(metaText()).not.toContain("81%")
    expect(metaText()).not.toContain("Compact")
  })

  it.each([false, true])("confirms failed-task deletion directly from the header (phone: %s)", async (phone) => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: !phone, media: query, addEventListener() {}, removeEventListener() {} }))
    const t = task({ status: "failed", prUrl: null, previews: [], pendingCount: 5 })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    qc.setQueryData(keys.tasks, [t])
    qc.setQueryData(keys.projects, [project])
    const calls: string[] = []
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        calls.push(url)
        return Promise.resolve(new Response('{"ok":true}', { status: 200 }))
      }
      return new Promise(() => {})
    })
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Fragment, null, createElement(TaskHeader, { task: t, project, schedule: null, files: [], onBack: () => {} }), createElement(ConfirmHost)))))
    const del = document.querySelector<HTMLButtonElement>("header [data-delete-task]")!
    expect(del).not.toBeNull()
    expect(del.getAttribute("aria-label")).toBe(`Delete ${t.title}`)
    expect(del.getAttribute("aria-haspopup")).toBe("dialog")
    expect(del.className).toContain("pointer-coarse:@max-[36rem]/head:min-w-11")
    if (phone) expect(document.querySelector('[data-testid="task-nav"]')!.contains(del)).toBe(true)
    act(() => del.click())
    expect(currentConfirm()).toMatchObject({ title: "Delete task?", body: "Delete this task, its workspace and its archive? This also permanently deletes 5 queued messages. They won't be sent.", danger: true })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("permanently deletes 5 queued messages")
    expect(calls).toEqual([])
    await act(async () => settleConfirm(currentConfirm()!.id, false))
    expect(qc.getQueryData(keys.tasks)).toEqual([t])
    expect(calls).toEqual([])
    act(() => del.click())
    await act(async () => settleConfirm(currentConfirm()!.id, true))
    expect(calls).toEqual([`/api/tasks/${t.id}?ifResting=1&discardQueued=5`])
    expect(qc.getQueryData(keys.tasks)).toEqual([])
    qc.clear()
  })

  it.each(["working", "starting", "queued", "idle", "pr_ready", "needs_input", "done"] as const)("keeps direct Delete out of the %s header", (status) => {
    render(task({ status }))
    expect(document.querySelector("header [data-delete-task]")).toBeNull()
  })

  it("puts the full title, model, route, times, box, branch, id and task link in details", async () => {
    render(task())
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Task details and more actions"]')!
    await act(async () => void trigger.click())
    const panel = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.textContent?.includes("Task details"))!
    const text = panel.textContent!
    for (const s of ["Generic hook system (Coordinator/Captain automations on task events)", "task_head000001", "boxyard/hooks", "pleasing-shepherd-27426", "claude-opus-5-5 · xhigh effort", "big-features", "Multi-file feature", "Active", "Created", "Open this task"]) {
      expect(text).toContain(s)
    }
    expect(panel.querySelector('button[aria-label="Copy task id"]')).not.toBeNull()
    expect(panel.querySelector('button[aria-label="Copy task link"]')).not.toBeNull()
    expect(panel.textContent).not.toContain("Show tool calls")
    expect(panel.textContent).not.toContain("58%")
    expect(panel.textContent).not.toContain("Compact queued")
    expect([...panel.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Compact")).toBe(false)
  })

  const header = (t: Task, runner: "box" | "local" | "gpu") =>
    act(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(TaskHeader, { task: t, project: { ...project, runner }, schedule: null, files: [] }),
        ),
      ),
    )
  /** Where it runs, from ⓘ's details: the header leaves it out (a re-render keeps the details open). */
  const where = async () => {
    expect(metaText()).not.toMatch(/Upstash|This computer|RunPod|\bLocal\b/)
    if (!document.querySelector('[data-testid="task-details-placement"]')) await openMenu()
    return document.querySelector<HTMLElement>('[data-testid="task-details-placement"]')!.textContent!
  }

  it("shows where it runs in ⓘ, not the header: the box, its size, the setting that chose it and why", async () => {
    render(task({ placement: { now: { kind: "box", boxId: "pure-lobster", provider: "upstash", size: "small" }, last: null, runner: "box", chosenBy: "project", projectRunner: "box" } }))
    expect(document.querySelector('[data-testid="task-placement"]')).toBeNull()
    const text = await where()
    for (const s of ["Upstash · pure-lobster · small", "Small · 2 CPU, 4 GB", "Project's Runs on: an Upstash box"]) expect(text).toContain(s)
    expect(document.getElementById("local-warning-note")).toBeNull()
  })

  it("names a RunPod pod by GPU and pod id", async () => {
    render(task({ boxId: "runpod-prj_demo01", placement: { now: { kind: "gpu", boxId: "runpod-prj_demo01", gpu: "RTX A5000", podId: "3x9k2aqz7wplm1" }, last: null, runner: "gpu", chosenBy: "project", projectRunner: "gpu" } }))
    const text = await where()
    expect(text).toContain("RunPod · RTX A5000 · pod 3x9k2a")
    expect(text).toContain("3x9k2aqz7wplm1")
  })

  it("warns that a local task is unsandboxed in the details, not the header", async () => {
    render(task({ boxId: "this-computer" }))
    expect(document.getElementById("local-warning-note")).toBeNull()
    expect(await where()).toContain("This computer")
    expect(document.getElementById("local-warning-note")!.textContent).toBe(LOCAL_UNSANDBOXED)
  })

  it("says where a queued task will go, from its project's runner", async () => {
    render(task({ boxId: null, status: "queued" }))
    expect(await where()).toContain("Goes to Upstash")
    header(task({ boxId: null, status: "queued" }), "local")
    expect(await where()).toContain("Goes to This computer")
  })

  it("shows the last place of a resting, archived task", async () => {
    render(task({ boxId: null, status: "idle", lastArchivedAt: 1, placement: { now: null, last: { kind: "box", boxId: "pure-lobster", size: "small", leftAt: 1 }, runner: "box", chosenBy: "project", projectRunner: "box" } }))
    const text = await where()
    expect(text).toContain("Upstash · pure-lobster · small · archived")
    expect(text).toContain("Left")
  })

  it("follows the task's own runs_on over its project's, both ways, and says it's pinned in the details", async () => {
    // Pinned here in a box project: it shows where it goes before it has a place, and that it's pinned.
    render(task({ boxId: null, status: "queued", runsOn: "local" }))
    let text = await where()
    expect(text).toContain("Goes to This computer")
    expect(text).toContain("pinned: overrides the project")
    // Pinned to a box in a local project.
    header(task({ boxId: null, status: "queued", runsOn: "box" }), "local")
    text = await where()
    expect(text).toContain("Goes to Upstash")
    expect(text).toContain("pinned: overrides the project")
    // Its own runs_on, the same as the project's: not pinned.
    header(task({ boxId: "this-computer", runsOn: "local" }), "local")
    expect(await where()).not.toContain("pinned")
    // The ⓘ details say it's this task's own choice.
    header(task({ boxId: "this-computer", runsOn: "local", prUrl: "https://github.com/o/r/pull/7" }), "box")
    expect(document.querySelector('[data-testid="task-runs-on"]')!.textContent).toBe("This computer · this task only")
  })

  // ⓘ › Mark done is the same as a card's ✓ (lib/markDone.ts): done at once with an Undo toast, the close sent once the
  // undo window is over, and a running task asks first.
  describe("Mark done in ⓘ", () => {
    let qc: QueryClient
    let posts: string[]
    const markDoneItem = () => menuButtons().find((b) => b.textContent!.trim() === "Mark done")
    const cached = () => qc.getQueryData<Task[]>(keys.tasks)!.find((t) => t.id === "task_head000001")!
    const renderWith = (t: Task) => {
      qc.setQueryData(keys.tasks, [t])
      act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(TaskHeader, { task: t, project, schedule: null, files: [] }))))
    }

    beforeEach(() => {
      qc = new QueryClient()
      posts = []
      vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
        if (init?.method === "POST") posts.push(url)
        return new Promise(() => {})
      })
    })
    afterEach(() => {
      act(() => {
        undoClose("task_head000001")
        for (const t of currentToasts()) dismiss(t.id)
      })
      resetClosedTasks()
    })

    it("marks a resting task done at once, with an Undo toast, and sends nothing in the undo window", async () => {
      renderWith(task({ status: "idle" }))
      await openMenu()
      await act(async () => void markDoneItem()!.click())
      expect(currentConfirm()).toBeUndefined()
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(cached().status).toBe("done")
      expect(currentToasts().map((t) => [t.title, t.body, t.action?.label])).toEqual([["Marked done", task().title, "Undo"]])
      expect(posts).toEqual([])
      act(() => currentToasts()[0]!.action!.onClick())
      expect(cached().status).toBe("idle")
      expect(posts).toEqual([])
    })

    it("is a button beside ⓘ once the task is ready for review, not only in it: idle or with its PR open", async () => {
      const visible = () => document.querySelector<HTMLButtonElement>('[data-testid="task-mark-done"]')
      for (const status of ["working", "queued", "needs_input", "waiting", "failed", "done"] as const) {
        renderWith(task({ status }))
        expect(visible(), status).toBeNull()
      }
      renderWith(task({ status: "pr_ready" }))
      expect(visible()).not.toBeNull()
      // Beside the PR and preview chips it folds with them to its ✓ in a narrow header, so a phone's header stays one
      // row: 32px drawn and 44px to a finger, like ⓘ.
      expect(visible()!.querySelector("span")!.className).toBe("@max-[36rem]/head:sr-only")
      expect(visible()!.className).toContain("pointer-coarse:@max-[36rem]/head:min-w-11")
      // Alone, it keeps its words in a side panel or on a phone, and folds only in a 320px phone's header.
      renderWith(task({ status: "idle", prUrl: null, prState: null, previews: [] }))
      const button = visible()!
      expect(button.querySelector("span")!.className).toBe("@max-[22rem]/head:sr-only")
      expect(button.className).not.toContain("@max-[36rem]/head")
      expect(button.className).toContain("pointer-coarse:@max-[22rem]/head:min-w-11")
      // Last before ⓘ, with its words.
      const controls = [...document.querySelectorAll<HTMLElement>('[data-testid="task-meta"] button, [data-testid="task-meta"] a')]
      expect(controls.slice(-2).map((el) => el.getAttribute("data-testid") ?? el.getAttribute("aria-label"))).toEqual(["task-mark-done", "Task details and more actions"])
      expect(button.textContent).toBe("Mark done")
      // The same Mark done as ⓘ's: done at once, with Undo, and nothing sent in the undo window.
      await act(async () => void button.click())
      expect(currentConfirm()).toBeUndefined()
      expect(cached().status).toBe("done")
      expect(currentToasts().map((t) => [t.title, t.action?.label])).toEqual([["Marked done", "Undo"]])
      expect(posts).toEqual([])
      act(() => currentToasts()[0]!.action!.onClick())
      expect(cached().status).toBe("idle")
    })

    it("asks before it stops a running task: Cancel leaves it running, Stop and mark done marks it", async () => {
      renderWith(task({ status: "working" }))
      await openMenu()
      await act(async () => void markDoneItem()!.click())
      expect(currentConfirm()).toMatchObject({ title: "Stop it and mark it done?", confirmLabel: "Stop and mark done", danger: true })
      expect(currentConfirm()!.body).toContain("is running")
      await act(async () => settleConfirm(currentConfirm()!.id, false))
      expect(cached().status).toBe("working")
      expect(currentToasts()).toEqual([])
      await openMenu()
      await act(async () => void markDoneItem()!.click())
      await act(async () => settleConfirm(currentConfirm()!.id, true))
      expect(cached().status).toBe("done")
      expect(currentToasts().map((t) => t.action?.label)).toEqual(["Undo"])
      expect(posts).toEqual([])
    })
  })

  // Reopen (useReopenTask in lib/queries.ts): Undo for a Mark done at any time later. In the undo window nothing was
  // sent, so nothing is; after it, POST /reopen, once a close on its way has landed. Neither starts a turn.
  describe("Reopen", () => {
    const ID = "task_head000001"
    let qc: QueryClient
    let posts: string[]
    /** The server's answer to a POST, by its path's last part; none leaves it pending. */
    let answers: Record<string, Task>
    const cached = () => qc.getQueryData<Task[]>(keys.tasks)!.find((t) => t.id === ID)!
    const reopenButton = () => document.querySelector<HTMLButtonElement>('[data-testid="task-reopen"]')
    const markDoneButton = () => document.querySelector<HTMLButtonElement>('[data-testid="task-mark-done"]')
    const renderWith = (t: Task, seed = true) => {
      if (seed) qc.setQueryData(keys.tasks, [t])
      act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(TaskHeader, { task: t, project, schedule: null, files: [] }))))
    }

    beforeEach(() => {
      qc = new QueryClient()
      posts = []
      answers = {}
      vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
        if (init?.method !== "POST") return new Promise(() => {})
        posts.push(url)
        const answer = answers[url.split("/").at(-1)!]
        return answer ? Promise.resolve(new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } })) : new Promise(() => {})
      })
    })
    afterEach(() => {
      vi.useRealTimers()
      act(() => {
        undoClose(ID)
        for (const t of currentToasts()) dismiss(t.id)
      })
      resetClosedTasks()
    })

    it("is beside ⓘ for a done task, where Mark done was, and in ⓘ; never for a task that isn't done", async () => {
      for (const status of ["working", "queued", "needs_input", "waiting", "failed", "idle", "pr_ready"] as const) {
        renderWith(task({ status }))
        expect(reopenButton(), status).toBeNull()
      }
      // Alone it keeps its word down to a 320px phone's header; beside the PR and preview chips it folds with them.
      renderWith(task({ status: "done", prUrl: null, prState: null, previews: [] }))
      expect(reopenButton()!.textContent).toBe("Reopen")
      expect(reopenButton()!.querySelector("span")!.className).toBe("@max-[22rem]/head:sr-only")
      expect(reopenButton()!.className).toContain("pointer-coarse:@max-[22rem]/head:min-w-11")
      expect(markDoneButton()).toBeNull()
      const controls = [...document.querySelectorAll<HTMLElement>('[data-testid="task-meta"] button, [data-testid="task-meta"] a')]
      expect(controls.slice(-2).map((el) => el.getAttribute("data-testid") ?? el.getAttribute("aria-label"))).toEqual(["task-reopen", "Task details and more actions"])
      renderWith(task({ status: "done", prState: "merged" }))
      expect(reopenButton()!.querySelector("span")!.className).toBe("@max-[36rem]/head:sr-only")
      expect(reopenButton()!.className).toContain("pointer-coarse:@max-[36rem]/head:min-w-11")

      await openMenu()
      const items = menuButtons().map((b) => b.textContent!.trim())
      expect(items).toContain("Reopen")
      expect(items).not.toContain("Mark done")
    })

    it("reopens a done task on the server: POST /reopen, and the task is what the server answers", async () => {
      renderWith(task({ status: "done", prState: "merged" }))
      answers.reopen = task({ status: "idle", prState: "merged", turnCount: 3 })
      await act(async () => void reopenButton()!.click())
      expect(posts).toEqual([`/api/tasks/${ID}/reopen`])
      expect(cached().status).toBe("idle")
      expect(cached().prState).toBe("merged")
      expect(currentToasts()).toEqual([])
    })

    it("sends one reopen for a double tap, and waits on it", async () => {
      // Its own task: the server never answers this reopen.
      renderWith(task({ id: "task_head000002", status: "done" }))
      await act(async () => {
        reopenButton()!.click()
        reopenButton()!.click()
      })
      expect(posts).toEqual(["/api/tasks/task_head000002/reopen"])
      expect(reopenButton()!.disabled).toBe(true)
    })

    it("reopens from ⓘ too", async () => {
      renderWith(task({ status: "done" }))
      answers.reopen = task({ status: "pr_ready" })
      await openMenu()
      await act(async () => void menuButtons().find((b) => b.textContent!.trim() === "Reopen")!.click())
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(posts).toEqual([`/api/tasks/${ID}/reopen`])
      expect(cached().status).toBe("pr_ready")
    })

    it("in the undo window it is Undo: the task is as it was, and nothing is sent", async () => {
      renderWith(task({ status: "pr_ready" }))
      await act(async () => void markDoneButton()!.click())
      expect(cached().status).toBe("done")
      // The task page shows the cached copy: done, so Reopen is where Mark done was.
      renderWith(cached(), false)
      await act(async () => void reopenButton()!.click())
      expect(cached().status).toBe("pr_ready")
      expect(posts).toEqual([])
    })

    it("the toast's Undo after the close went out reopens it on the server, once the close has landed", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      renderWith(task({ status: "idle" }))
      await act(async () => void markDoneButton()!.click())
      const undo = currentToasts()[0]!.action!.onClick
      answers.close = task({ status: "done" })
      answers.reopen = task({ status: "idle", updatedAt: Date.now() + 1000 })
      // The window ends and the close goes out; Undo (pressed as the toast left) can't hold it back any more.
      await act(async () => void vi.advanceTimersByTime(5000))
      vi.useRealTimers()
      expect(posts).toEqual([`/api/tasks/${ID}/close`])
      await act(async () => undo())
      for (let i = 0; i < 50 && posts.length < 2; i++) await act(async () => new Promise((r) => setTimeout(r, 10)))
      expect(posts).toEqual([`/api/tasks/${ID}/close`, `/api/tasks/${ID}/reopen`])
      expect(cached().status).toBe("idle")
    })
  })
})
