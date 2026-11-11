// @vitest-environment happy-dom
// Question, PR and failure cards in the Coordinator's transcript (components/NoticeNow.tsx): while the task waits on
// Cody, one action (Answer, Review PR, Retry) on a coloured card, its status word only for a screen reader; once it has
// moved on, or a newer card took over, "Now" and the task's status icon, named for where it is, on a gray card. Task updates re-render only the card they change.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, useRef, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { keys } from "../web/src/lib/queries.js"
import { useComposerFocus } from "../web/src/lib/chatSwitch.js"
import { resetChipState } from "../web/src/lib/chipState.js"
import type { ChatMessage, Project, Task } from "../shared/types.js"

// Count card renders: every NoticeLine render asks noticeNow what its card says.
const renders = vi.hoisted(() => ({ cards: [] as string[] }))
vi.mock("../web/src/lib/noticeNow.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../web/src/lib/noticeNow.js")>()
  return { ...mod, noticeNow: (...args: Parameters<typeof mod.noticeNow>) => (renders.cards.push(String(args[0])), mod.noticeNow(...args)) }
})

const { CoordinatorTranscript, useCoordinatorRows, usePlainRows } = await import("../web/src/components/UpdateChips.js")

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let qc: QueryClient
let setThread: (m: ChatMessage[]) => void = () => {}
let fetches: { url: string; method: string }[] = []

const project = { id: "prj_webapp01", name: "web", repo: "acme/web" } as Project
const PR_URL = "https://github.com/o/r/pull/9"
const task = (id: string, status: Task["status"], over: Partial<Task> = {}) =>
  ({ id, title: id, projectId: project.id, status, prUrl: null, prState: null, prMergedAt: null, prMergedBy: null, ...over }) as Task

let t = 0
const msg = (id: string, role: ChatMessage["role"], content: string, meta: Record<string, unknown> | null = null): ChatMessage => ({ id, role, content, meta, createdAt: ++t })
const asks = (id: string, taskId = "task_q") => msg(id, "notice", "🙋 **Pick a colour** needs you: Red or blue?", { taskId })
const failed = (id: string, taskId = "task_f") => msg(id, "notice", "❌ **Build** failed: tsc exited 2", { taskId })
const pr = (id: string, taskId = "task_p") => msg(id, "notice", `🔀 **Cards** opened a pull request: ${PR_URL}`, { taskId })

const onFollowUp = () => {}

function Thread({ initial }: { initial: ChatMessage[] }) {
  const [messages, set] = useState(initial)
  setThread = set
  return createElement(CoordinatorTranscript, { rows: usePlainRows(useCoordinatorRows(messages)), onFollowUp })
}

/** The task's own composer, as its panel mounts it (CaptainForward.tsx TaskComposer). */
function TaskBox({ taskId }: { taskId: string }) {
  const box = useRef<HTMLTextAreaElement>(null)
  useComposerFocus(taskId, box)
  return createElement("textarea", { ref: box, "data-testid": "task-box" })
}

const render = (messages: ChatMessage[]) =>
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Thread, { initial: messages }))))
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
const $ = (sel: string) => host.querySelector<HTMLElement>(sel)
const card = (id: string) => $(`#chat-${id}`)!
const row = (id: string) => card(id).querySelector<HTMLElement>('[data-testid="notice-now"]')
/** What a gray card's line says: "Now", and its status icon's name. */
const nowSays = (id: string) => [row(id)!.textContent, row(id)!.querySelector('[aria-label^="Now:"]')?.getAttribute("aria-label")]
// The query cache tells its observers a tick later.
const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)))
const tasks = async (...list: Task[]) => {
  qc.setQueryData(keys.tasks, list)
  await flush()
}
const session = () => new URLSearchParams(location.search).get("session")

beforeEach(() => {
  fetches = []
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    fetches.push({ url, method: init?.method ?? "GET" })
    return url.endsWith("/retry") ? Promise.resolve(new Response(JSON.stringify(task("task_f", "queued")), { status: 200 })) : new Promise(() => {})
  })
  history.replaceState(null, "", "/")
  sessionStorage.clear()
  resetChipState()
  renders.cards = []
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const k of [keys.schedules, keys.artifacts, keys.boxes]) qc.setQueryData(k, [])
  qc.setQueryData(keys.projects, [project])
  qc.setQueryData(keys.tasks, [task("task_q", "needs_input"), task("task_f", "failed"), task("task_p", "pr_ready", { prUrl: PR_URL, prState: "open" })])
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe("a card that waits on Cody", () => {
  it("leads with its action on a coloured card; the status word is only for a screen reader", () => {
    render([asks("q1"), pr("p1"), failed("f1")])
    expect(["q1", "p1", "f1"].map((id) => card(id).dataset.now)).toEqual(["live", "live", "live"])
    // The card's icon and edge already say why it waits: no visible status word.
    expect(row("q1")!.textContent).toBe("Answer")
    expect(row("q1")!.querySelector('[data-testid="notice-answer"]')!.getAttribute("aria-description")).toBe("Needs your answer")
    expect(row("p1")!.querySelector(".sr-only")!.textContent).toBe("Ready for your review")
    expect(row("f1")!.textContent).toBe("Retry")
    expect(row("f1")!.querySelector('[data-testid="notice-retry"]')!.getAttribute("aria-description")).toBe("Failed")
    expect(card("q1").querySelector('[role="link"]')!.className).toContain("border-amber-500/40!")
    expect(card("p1").querySelector('[role="link"]')!.className).toContain("border-emerald-500/40!")
    expect(card("f1").querySelector('[role="link"]')!.className).toContain("border-red-500/40!")
  })

  it("a question's Answer opens its task beside the chat and focuses the task's box", async () => {
    render([asks("q1")])
    click(row("q1")!.querySelector('[data-testid="notice-answer"]')!)
    expect(session()).toBe("task_q")
    // The panel mounts its composer after the click; it takes the pending focus.
    const panel = document.createElement("div")
    document.body.append(panel)
    const panelRoot = createRoot(panel)
    act(() => panelRoot.render(createElement(TaskBox, { taskId: "task_q" })))
    await vi.waitFor(() => expect(document.activeElement).toBe(panel.querySelector('[data-testid="task-box"]')))
    act(() => panelRoot.unmount())
    panel.remove()
  })

  it("a PR's action is its pull request on GitHub", () => {
    render([pr("p1")])
    const link = row("p1")!.querySelector<HTMLAnchorElement>(`a[href="${PR_URL}"]`)!
    expect(link.textContent).toContain("Review PR #9")
    expect(link.target).toBe("_blank")
  })

  it("a failure's Retry runs the task again, and the card goes gray while it's queued", async () => {
    render([failed("f1")])
    click(row("f1")!.querySelector('[data-testid="notice-retry"]')!)
    await flush()
    expect(fetches).toContainEqual({ url: "/api/tasks/task_f/retry", method: "POST" })
    expect(card("f1").dataset.now).toBe("past")
    expect(nowSays("f1")).toEqual(["Now", "Now: Queued"])
  })

  it("its action keeps its click: the card doesn't also open the task", async () => {
    render([failed("f1")])
    click(row("f1")!.querySelector('[data-testid="notice-retry"]')!)
    expect(session()).toBeNull()
    await flush()
  })
})

describe("a card whose moment has passed", () => {
  it("goes gray and says where its task is now, once the task has moved on", async () => {
    render([asks("q1"), pr("p1")])
    await tasks(task("task_q", "working"), task("task_p", "done", { prUrl: PR_URL, prState: "merged" }))
    expect(card("q1").dataset.now).toBe("past")
    expect(nowSays("q1")).toEqual(["Now", "Now: Working"])
    // Its PR as GitHub has it, beside the status icon.
    expect(nowSays("p1")).toEqual(["Now Merged #9", "Now: Merged"])
    expect(card("q1").querySelector('[role="link"]')!.className).not.toContain("border-amber")
    expect(card("q1").querySelector('[data-testid="notice-answer"]')).toBeNull()
    // Still a full card, not folded into the updates.
    expect(card("q1").dataset.attention).toBe("needs_input")
  })

  it("only a task's newest question, PR or failure asks; older ones say where it is", () => {
    render([asks("q1"), failed("f1"), asks("q2")])
    expect(card("q1").dataset.now).toBe("past")
    expect(nowSays("q1")).toEqual(["Now", "Now: Needs you"])
    expect(card("q2").dataset.now).toBe("live")
    expect(host.querySelectorAll('[data-testid="notice-answer"]')).toHaveLength(1)
  })

  it("a newer card hands the ask over as it streams in", () => {
    render([asks("q1")])
    act(() => setThread([asks("q1"), msg("u1", "user", "Red"), asks("q2")]))
    expect(card("q1").dataset.now).toBe("past")
    expect(card("q2").dataset.now).toBe("live")
  })

  it("a task the app doesn't know keeps its card as it came in", () => {
    render([asks("q1", "task_gone")])
    expect(card("q1").dataset.now).toBeUndefined()
    expect(row("q1")).toBeNull()
    expect(card("q1").querySelector('[role="link"]')!.className).toContain("border-amber-500/40!")
  })
})

describe("re-renders", () => {
  it("a task update re-renders only its own card, and a new message none of them", async () => {
    const thread = [asks("q1"), failed("f1")]
    render(thread)
    renders.cards = []
    await tasks(task("task_q", "needs_input"), task("task_f", "failed"), task("task_p", "working"))
    expect(renders.cards).toEqual([])
    act(() => setThread([...thread, msg("u1", "user", "Thanks")]))
    expect(renders.cards).toEqual([])
    await tasks(task("task_q", "working"), task("task_f", "failed"))
    expect(renders.cards).toEqual(["needs_input"])
  })
})
