// @vitest-environment happy-dom
// The centre chats: the Coordinator's plain transcript (no task cards, no tool calls, runs of updates as
// one "N updates" line) and a picked Captain as a full top-level chat of its own.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { keys } from "../web/src/lib/queries.js"
import { setChatProjectFilter } from "../web/src/lib/projectBar.js"
import { resetChipState } from "../web/src/lib/chipState.js"
import { revealChatMessage } from "../web/src/lib/reveal.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import type { CaptainMessage, ChatMessage, Project, Task, TaskStatus } from "../shared/types"
import { APP_HOME } from "../web/src/lib/navigation.js"

// Every text react-markdown parses, to tell a reply parsed ahead of time from one parsed as it shows.
const parsed = vi.hoisted(() => [] as string[])
vi.mock("react-markdown", async (load) => {
  const m = await load<typeof import("react-markdown")>()
  return { ...m, default: (o: Parameters<typeof m.default>[0]) => (parsed.push(String(o.children)), m.default(o)) }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const YARD = { id: "prj_yard01", name: "box-yard", repo: "acme/box-yard", description: "", notes: [], envKeys: [], createdAt: now, color: null } as unknown as Project
const task = (id: string, title: string, status: TaskStatus, extra: Partial<Task> = {}) =>
  ({ id, projectId: YARD.id, title, status, prompt: "", prUrl: null, prState: null, prMergedAt: null, previews: [], waitFor: [], question: null, error: null, scheduleId: null, outcome: null, createdAt: now - 60_000, updatedAt: now - 60_000, ...extra }) as unknown as Task
const DOCS = task("task_docs01", "Write the docs", "working")
const LOGIN = task("task_login1", "Fix login", "pr_ready", { prUrl: "https://github.com/acme/box-yard/pull/7", prState: "open" })

let t = 0
const msg = (id: string, role: ChatMessage["role"], content: string, meta: Record<string, unknown> | null = null): ChatMessage => ({ id, role, content, meta, createdAt: now - 10_000 + ++t })
const CHAT: ChatMessage[] = [
  msg("u1", "user", "What's running?"),
  msg("t1", "tool", "list_tasks", { input: {} }),
  msg("d1", "notice", "✅ **Write the docs** is done: Wrote the guide.", { taskId: DOCS.id }),
  msg("t2", "tool", "list_tasks", { input: {} }),
  msg("d2", "notice", "✅ **Fix login** is done: Fixed the redirect.", { taskId: LOGIN.id }),
  msg("r1", "assistant", "Two tasks finished.", { nextSteps: ["Open the PR"] }),
  msg("r2", "assistant", "Anything else?", { nextSteps: ["Check the docs"] }),
]
const cap = (id: string, role: CaptainMessage["role"], content: string, meta: Record<string, unknown> | null = null): CaptainMessage => ({ id, projectId: YARD.id, role, content, meta, createdAt: now - 5_000 + ++t })
const CAPTAIN: CaptainMessage[] = [
  cap("c1", "user", "How's the yard?", { source: "cody" }),
  cap("c2", "tool", "list_tasks", { input: {} }),
  cap("c3", "assistant", "All quiet.", { nextSteps: ["Start a task"] }),
  cap("c4", "assistant", "Still quiet.", { nextSteps: ["Check the PRs"] }),
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

function render(chat = CHAT, captain = CAPTAIN) {
  history.replaceState(null, "", APP_HOME)
  sessionStorage.setItem("box-yard:landed", "1")
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.agentSettings, { settings: { ownerName: "Cody" }, sources: {}, defaults: {} })
  qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.chat, chat)
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, [DOCS, LOGIN])
  qc.setQueryData(keys.projects, [YARD])
  qc.setQueryData(keys.captain(YARD.id), { projectId: YARD.id, busy: false, usage: { tokens: 0, window: 1_000_000, updatedAt: now }, compacting: false, compactQueued: false, error: null })
  qc.setQueryData(keys.captainMessages(YARD.id), captain)
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
}

const centre = () => document.querySelector<HTMLElement>("[data-testid=chat-panel], [data-testid=captain-chat][data-centre]")!
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
const frames = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
/** Which replies offer their next steps. */
const stepsUnder = () => [...centre().querySelectorAll('[aria-label="Recommended next steps"]')].map((s) => s.closest("[data-chat-id], [id^='chat-']")?.textContent?.match(/All quiet|Still quiet|Two tasks finished|Anything else/)?.[0])

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  resetChipState()
  ;(window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 1440, height: 900 })
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
  vi.stubGlobal("EventSource", FakeEventSource)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  act(() => root.unmount())
  // A shown chat's requests wait for its first paint, and go on after it's gone: let them, before the next test.
  await frames()
  host.remove()
  document.body.innerHTML = ""
  for (const toast of currentToasts()) dismiss(toast.id)
  act(() => setChatProjectFilter(null))
  vi.unstubAllGlobals()
})

describe("the Coordinator's transcript", () => {
  it("is Cody's messages, the replies and one line for the updates: no task cards, no tool calls", () => {
    render()
    expect(centre().dataset.testid).toBe("chat-panel")
    expect(centre().querySelector('[data-testid="coordinator-card"], [data-card]')).toBeNull()
    expect(centre().textContent).not.toContain("list_tasks")
    // The tool calls between the two updates are gone, so they fold into one line naming their tasks.
    const groups = [...centre().querySelectorAll<HTMLElement>('[data-testid="update-group"]')]
    expect(groups).toHaveLength(1)
    expect(groups[0]!.dataset.count).toBe("2")
    expect(groups[0]!.querySelector('[data-testid="update-group-names"]')!.textContent).toBe("· Write the docs, Fix login")
    expect(groups[0]!.querySelector('[data-testid="update-group-items"]')).toBeNull()
    click(groups[0]!.querySelector("button")!)
    expect(groups[0]!.querySelectorAll('[data-testid="update-group-items"] [data-testid="update-chip"]')).toHaveLength(2)
    expect(centre().textContent).toContain("Two tasks finished.")
    // Only the newest reply offers next steps.
    expect(stepsUnder()).toEqual(["Anything else"])
  })

  it("a link to an update inside the line opens it", async () => {
    render()
    const group = centre().querySelector<HTMLElement>('[data-testid="update-group"]')!
    expect(group.dataset.open).toBeUndefined()
    act(() => revealChatMessage("d2"))
    await frames()
    expect(group.dataset.open).toBe("true")
    expect(group.querySelector("#chat-d2")).not.toBeNull()
  })

  it.each(["d1", "d2"])("a day-summary bullet opens its collapsed update %s and highlights the message rather than its group", async (id) => {
    render()
    const chat = centre()
    act(() => chat.querySelector<HTMLButtonElement>('[data-chat-history] nav button')!.focus())
    const bullet = [...chat.querySelectorAll<HTMLElement>('[data-summary-jump]')].find((b) => b.textContent?.includes(id === "d1" ? "Finished: Write the docs" : "Finished: Fix login"))!
    click(bullet)
    await frames()
    const source = chat.querySelector<HTMLElement>(`[data-chat-id="${id}"]`)!
    expect(source).not.toBeNull()
    expect(source.hasAttribute("data-chat-highlight")).toBe(true)
    expect(document.activeElement).toBe(source)
    expect(chat.querySelector('[role="region"]')).toBeNull()
    expect(chat.querySelector<HTMLElement>('[data-testid="update-group"]')!.dataset.open).toBe("true")
  })

  it("parses older replies' markdown while idle, so scrolling up to them only builds their DOM", async () => {
    // More rows than the newest 60 it renders.
    const long = Array.from({ length: 100 }, (_, i) => msg(`m${i}`, i % 2 ? "assistant" : "user", i % 2 ? `Reply **number ${i}**.` : `Question ${i}?`))
    render(long)
    const older = long.slice(0, 40).filter((m) => m.role === "assistant").map((m) => m.content)
    expect(centre().querySelector("#chat-m1")).toBeNull()
    await vi.waitFor(() => expect(parsed).toEqual(expect.arrayContaining(older)))
    parsed.length = 0
    act(() => revealChatMessage("m1"))
    await frames()
    expect(centre().querySelector("#chat-m1")?.textContent).toContain("Reply number 1.")
    // Parsed for the scope the transcript renders them in (InRepo mentions), so showing them found them cached.
    expect(parsed.filter((t) => older.includes(t))).toEqual([])
  })

  it("its Pull requests icon in the box counts every project's open PRs", () => {
    render()
    const button = centre().querySelector<HTMLButtonElement>('[data-testid="chat-footer"] [data-testid="pull-requests-button"]')!
    expect(button.closest('[data-testid="dock-line"]')).toBeNull()
    expect(button.getAttribute("aria-label")).toBe("Pull requests, 1 open")
  })

  it("its line over the box floats, so showing Jump to latest never resizes the list (#266)", () => {
    render()
    const line = centre().querySelector<HTMLElement>('[data-testid="dock-line"]')!
    // Taking a row of its own, it shrank the list as it scrolled up and grew it back at the bottom, which moved the view.
    expect(line.classList).toContain("absolute")
    expect(line.classList).toContain("bottom-0")
    expect(line.parentElement!.classList).toContain("h-0")
    // Only its pills take clicks; the list under the strip still scrolls and clicks.
    expect(line.classList).toContain("pointer-events-none")
    expect(line.className).toContain("*:pointer-events-auto")
    // Not inside the footer, which clips: it's a scroll container so its column lines up with the transcript's
    // scrollbar gutter. The line takes the same column, so its pills line up with the box.
    const footer = centre().querySelector<HTMLElement>('[data-testid="chat-footer"]')!
    expect(footer.contains(line)).toBe(false)
    expect(line.parentElement!.nextElementSibling).toBe(footer)
    expect(footer.classList).toContain("overflow-hidden")
    for (const c of ["chat-column", "overflow-hidden"]) expect(line.classList).toContain(c)
  })
})

describe("a picked Captain", () => {
  it("is a full chat in the centre: its header, its plain transcript and its own box", () => {
    render()
    click([...document.querySelectorAll<HTMLButtonElement>("nav[aria-label='Projects and tasks'] button")].find((b) => b.textContent?.startsWith("box-yard, Captain"))!)
    expect(centre().dataset.testid).toBe("captain-chat")
    // The Coordinator's chat isn't shown: it waits hidden behind it, kept for going back (lib/keptChats.ts).
    expect(document.querySelector<HTMLElement>("[data-testid=chat-panel]")?.style.display ?? "none").toBe("none")
    expect(centre().querySelector("[data-testid=chat-title]")!.textContent).toBe("box-yard Captain")
    expect(centre().textContent).toContain("All quiet.")
    expect(centre().textContent).not.toContain("list_tasks")
    expect(stepsUnder()).toEqual(["Still quiet"])
    // No context reading in the header: it's in ⋯, as for the Coordinator.
    expect(centre().querySelector("header [data-testid=context-mini]")).toBeNull()
    expect(centre().querySelector<HTMLTextAreaElement>("[data-testid=chat-footer] textarea")!.placeholder).toBe("Message the box-yard Captain…")
    expect(centre().querySelector('[data-testid="pull-requests-button"]')!.getAttribute("aria-label")).toBe("Pull requests, 1 open")
  })
  it("a day-summary bullet opens a collapsed Captain notice group and focuses the source", async () => {
    const notices = CHAT.filter((m) => m.role === "notice").map((m) => ({ ...m, projectId: YARD.id })) as CaptainMessage[]
    render(CHAT, [...CAPTAIN, ...notices])
    click([...document.querySelectorAll<HTMLButtonElement>("nav[aria-label='Projects and tasks'] button")].find((b) => b.textContent?.startsWith("box-yard, Captain"))!)
    await frames() // Let the chat switch finish focusing its composer before starting another interaction.
    const chat = document.querySelector<HTMLElement>('[data-testid=captain-chat][data-centre]')!
    expect(chat.querySelector('#captain-d2')).toBeNull()
    act(() => chat.querySelector<HTMLButtonElement>('[data-chat-history] nav button')!.focus())
    const bullet = [...chat.querySelectorAll<HTMLElement>('[data-summary-jump]')].find((b) => b.textContent?.includes("Finished: Fix login"))!
    click(bullet)
    await frames()
    const source = chat.querySelector<HTMLElement>('#captain-d2')!
    expect(source).not.toBeNull()
    expect(source.hasAttribute("data-chat-highlight")).toBe(true)
    expect(document.activeElement).toBe(source)
    expect(chat.querySelector('[role="region"]')).toBeNull()
  })

})
