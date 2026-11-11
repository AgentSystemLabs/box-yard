// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SelectionToTask } from "../web/src/components/SelectionToTask.js"
import { ChatLine } from "../web/src/components/ChatLine.js"
import { SideThreadPane, ThreadChatProvider } from "../web/src/components/SideThread.js"
import { keys } from "../web/src/lib/queries.js"
import { routeView } from "../web/src/components/ThreadRoute.js"
import { routeMeta } from "../shared/threadRoutes.js"
import { COORDINATOR_CHAT, applyThreadEvent, closeThread, openThread, openThreadId, openThreadState, restoreThread, threadKeys } from "../web/src/lib/threads.js"
import { findQuoteRange } from "../web/src/lib/threadHighlight.js"
import { resetDrafts } from "../web/src/lib/composerDraft.js"
import { MAIN_MIN_THREAD, THREAD_ROOM, coordinatorDock, threadDockWidth } from "../web/src/lib/layout.js"
import type { ChatMessage, Project, SettingsInfo, SideThread, SideThreadMessage } from "../shared/types"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REPLY: ChatMessage = { id: "chat_reply01", role: "assistant", content: "The retry loop in **server/sync.ts** never backs off,\nso a dead remote spins the CPU.", meta: null, createdAt: 1 }
const thread = (over: Partial<SideThread> = {}): SideThread => ({
  id: "thr_abc123",
  projectId: null,
  anchorId: REPLY.id,
  kind: "ask",
  quote: "never backs off",
  context: "fork",
  busy: false,
  replies: 2,
  unread: false,
  resolvedAt: null,
  createdAt: 2,
  updatedAt: 2,
  ...over,
})

let root: Root
let host: HTMLElement
let qc: QueryClient
let fetchMock: ReturnType<typeof vi.fn>

function render(threads: SideThread[] = []) {
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.projects, [] as Project[])
  qc.setQueryData(keys.tasks, [])
  qc.setQueryData(keys.agentSettings, { settings: { ownerName: "Ada" } } as unknown as SettingsInfo)
  qc.setQueryData(threadKeys.list(COORDINATOR_CHAT), threads)
  qcSeed?.(qc)
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          ThreadChatProvider,
          { value: COORDINATOR_CHAT },
          createElement(SelectionToTask, { source: { kind: "orchestrator" } }, createElement(ChatLine, { m: REPLY, onFollowUp: vi.fn() })),
          createElement(SideThreadPane, { chat: COORDINATOR_CHAT }),
        ),
      ),
    ),
  )
}

/** Select `text` in the reply, as a drag would. */
function select(text: string) {
  const range = findQuoteRange(host.querySelector("[data-chat-id]")!, text)!
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
  act(() => void document.dispatchEvent(new Event("selectionchange")))
}

const click = (el: Element) => act(() => (el as HTMLElement).click())
/** Let the queries' batched notifications (a timeout) reach the components. */
const flush = () => act(() => new Promise((r) => setTimeout(r, 10)))
const askButton = () => document.querySelector<HTMLButtonElement>("[data-testid=selection-ask]")
/** The selection's actions as their buttons read: the mouse's pill, then the finger's bar. */
const actionLabels = () => [...document.querySelectorAll("[data-selection-task-action] button")].map((b) => b.textContent!.trim())
/** Extra cache seeding for the next render (the chat's messages). */
let qcSeed: ((q: QueryClient) => void) | null = null

beforeEach(() => {
  resetDrafts()
  fetchMock = vi.fn(() => new Promise(() => {}))
  vi.stubGlobal("fetch", fetchMock)
  vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([new DOMRect(200, 300, 240, 18)] as unknown as DOMRectList)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  window.getSelection()?.removeAllRanges()
  closeThread(COORDINATOR_CHAT)
  qcSeed = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Ask on a selection", () => {
  it("Ask and Create task are the selection's actions in a chat; Ask opens the side panel on the passage, with a box for the question", async () => {
    qcSeed = (q) => q.setQueryData(keys.chat, [REPLY])
    render()
    select("server/sync.ts never backs off")
    // The mouse's pill and the finger's bar, both with the two.
    expect(actionLabels()).toEqual(["Ask", "Create task", "Ask", "Create task"])
    const button = askButton()!
    // Pressing it keeps the focus and the selection where they are.
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    button.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    click(button)
    const pane = document.querySelector("[data-testid=side-thread]")!
    // The passage on top (not the whole message), an empty box with the caret in it, and nothing sent yet.
    expect(pane.querySelector("[data-testid=side-thread-quote]")!.textContent).toBe("server/sync.ts never backs off")
    expect(pane.querySelector("[data-testid=side-thread-original]")).toBeNull()
    expect(pane.querySelector("[data-testid=side-thread-parent]")).toBeNull()
    expect(pane.querySelector("[data-testid=side-thread-ask-hint]")!.textContent).toContain("Ask the Coordinator about the highlighted text.")
    const box = pane.querySelector<HTMLTextAreaElement>("textarea")!
    expect(box.value).toBe("")
    expect(box.placeholder).toBe("Ask about the highlighted text…")
    expect(document.activeElement).toBe(box)
    expect(askButton()).toBeNull()
    expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/threads"))).toEqual([])

    typeAndSend(box, "Why does it spin?")
    await flush()
    const body = JSON.parse((posts("/api/threads")[0]![1] as RequestInit).body as string)
    expect(body).toMatchObject({ kind: "ask", anchorId: REPLY.id, quote: "server/sync.ts never backs off", question: "Why does it spin?", projectId: null })
    // A question about the chat itself: under no other thread.
    expect(body.parentId ?? null).toBeNull()
    // It stays open, and the message gets its chip.
    expect(openThreadId(COORDINATOR_CHAT)).toBe(body.id)
    expect(host.querySelector("[data-testid=thread-marker]")!.textContent).toContain("server/sync.ts never backs off")
    // Nothing went into the Coordinator's own chat.
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/chat"))).toBe(false)
  })

  it("Ask mounts the panel and puts the caret in its box inside the press", () => {
    render()
    select("never backs off")
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    env.IS_REACT_ACT_ENVIRONMENT = false
    try {
      askButton()!.click()
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = true
    }
    const box = document.querySelector<HTMLTextAreaElement>("[data-testid=side-thread] textarea")
    expect(box).not.toBeNull()
    expect(document.activeElement).toBe(box)
  })

  it("asking again about the same passage keeps what's typed; another passage starts a new question", () => {
    render()
    select("never backs off")
    click(askButton()!)
    const first = openThreadId(COORDINATOR_CHAT)
    const box = () => document.querySelector<HTMLTextAreaElement>("[data-testid=side-thread] textarea")!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box(), "Half a question")
      box().dispatchEvent(new Event("input", { bubbles: true }))
    })
    select("never backs off")
    click(askButton()!)
    expect(openThreadId(COORDINATOR_CHAT)).toBe(first)
    expect(box().value).toBe("Half a question")
    select("spins the CPU")
    click(askButton()!)
    expect(openThreadId(COORDINATOR_CHAT)).not.toBe(first)
    expect(box().value).toBe("")
    expect(document.querySelector("[data-testid=side-thread-quote]")!.textContent).toBe("spins the CPU")
  })

  it("isn't offered where the chat has no side threads: Create task is", () => {
    act(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(SelectionToTask, { source: { kind: "orchestrator" } }, createElement("p", { "data-chat-id": "chat_x00001" }, "Some output text")),
        ),
      ),
    )
    const range = document.createRange()
    range.selectNodeContents(host.querySelector("p")!)
    window.getSelection()!.addRange(range)
    act(() => void document.dispatchEvent(new Event("selectionchange")))
    expect(actionLabels()).toEqual(["Create task", "Create task"])
    expect(askButton()).toBeNull()
  })
})

describe("nested threads", () => {
  const ANSWER = "Because the loop retries at once, with no delay between tries."
  const answerIn = (threadId: string, content = ANSWER): SideThreadMessage[] => [
    { id: `thm_q_${threadId}`, threadId, role: "user", content: "Why?", meta: null, createdAt: 3 },
    { id: `thm_a_${threadId}`, threadId, role: "assistant", content, meta: null, createdAt: 4 },
  ]
  const pane = () => document.querySelector<HTMLElement>("[data-testid=side-thread]")!
  /** Select `text` in the open thread's answer. */
  const selectInThread = (text: string) => {
    const range = findQuoteRange(pane().querySelector("[data-testid=side-thread-reply]")!, text)!
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    act(() => void document.dispatchEvent(new Event("selectionchange")))
  }
  const esc = () => act(() => void pane().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))
  /** A thread open on its answer. */
  const openOn = (threads: SideThread[], id: string) => {
    qcSeed = (q) => {
      for (const t of threads) q.setQueryData(threadKeys.messages(t.id), answerIn(t.id))
    }
    render(threads)
    act(() => openThread(COORDINATOR_CHAT, id))
  }
  const child = (over: Partial<SideThread> = {}) => thread({ id: "thr_child01", parentId: "thr_abc123", quote: "retries at once", replies: 1, ...over })

  it("text in a thread has the same Ask and Create task; Ask nests a question under the thread, which is sent with its parent", async () => {
    openOn([thread()], "thr_abc123")
    selectInThread("retries at once")
    expect(actionLabels()).toEqual(["Ask", "Create task", "Ask", "Create task"])
    click(askButton()!)
    // A question not started yet, under the thread it was highlighted in, on the same message.
    expect(openThreadState(COORDINATOR_CHAT)).toMatchObject({ draft: { kind: "ask", anchorId: REPLY.id, parentId: "thr_abc123", text: "retries at once" } })
    expect(pane().querySelector("[data-testid=side-thread-quote]")!.textContent).toBe("retries at once")
    expect(pane().querySelector("[data-testid=side-thread-parent]")!.textContent).toContain("Asked in“never backs off”")
    const box = pane().querySelector<HTMLTextAreaElement>("textarea")!
    expect(document.activeElement).toBe(box)

    typeAndSend(box, "How often?")
    await flush()
    const body = JSON.parse((posts("/api/threads")[0]![1] as RequestInit).body as string)
    expect(body).toMatchObject({ kind: "ask", anchorId: REPLY.id, parentId: "thr_abc123", quote: "retries at once", question: "How often?", projectId: null })
    expect(openThreadId(COORDINATOR_CHAT)).toBe(body.id)
    // It's the parent's, not another chip under the message.
    expect(host.querySelectorAll("[data-testid=thread-marker]")).toHaveLength(1)
  })

  it("a nested thread leads back to its parent, and the parent lists it", () => {
    openOn([thread(), child()], "thr_child01")
    const up = pane().querySelector<HTMLButtonElement>("[data-testid=side-thread-parent]")!
    expect(up.textContent).toContain("“never backs off”")
    // A sheet's Back goes up a level too, and says so.
    expect(pane().querySelector("[data-dismiss=back]")!.getAttribute("aria-label")).toBe("Back to the thread this was asked in")
    click(up)
    expect(openThreadId(COORDINATOR_CHAT)).toBe("thr_abc123")
    expect(pane().querySelector("[data-testid=side-thread-parent]")).toBeNull()
    expect(pane().querySelector("[data-dismiss=back]")!.getAttribute("aria-label")).toBe("Back to the chat")
    // The parent lists what was asked from inside it; the chip opens it again.
    const chips = pane().querySelectorAll("[data-testid=side-thread-children] [data-testid=thread-marker]")
    expect([...chips].map((c) => c.textContent)).toEqual(["“retries at once”· 1 reply"])
    click(chips[0]!)
    expect(openThreadId(COORDINATOR_CHAT)).toBe("thr_child01")
    click(pane().querySelector("[data-dismiss=back]")!)
    expect(openThreadId(COORDINATOR_CHAT)).toBe("thr_abc123")
  })

  it("Esc leaves one level at a time", () => {
    openOn([thread(), child()], "thr_child01")
    esc()
    expect(openThreadId(COORDINATOR_CHAT)).toBe("thr_abc123")
    esc()
    expect(openThreadId(COORDINATOR_CHAT)).toBeNull()
  })

  it("nests to any depth: a question from inside a nested thread goes under that one", () => {
    openOn([thread(), child()], "thr_child01")
    selectInThread("no delay between tries")
    click(askButton()!)
    expect(openThreadState(COORDINATOR_CHAT)).toMatchObject({ draft: { kind: "ask", anchorId: REPLY.id, parentId: "thr_child01", text: "no delay between tries" } })
    expect(pane().querySelector("[data-testid=side-thread-parent]")!.textContent).toContain("“retries at once”")
    // Backing out of the unsent question returns to the thread it was highlighted in.
    esc()
    expect(openThreadId(COORDINATOR_CHAT)).toBe("thr_child01")
  })

  it("Create task from inside a thread messages the chat's agent, naming the thread", async () => {
    openOn([thread()], "thr_abc123")
    selectInThread("retries at once")
    click(document.querySelector("[data-testid=selection-task]")!)
    const box = document.querySelector<HTMLTextAreaElement>("[role=dialog] textarea")!
    typeAndSend(box, "Add a backoff")
    await flush()
    const content: string = JSON.parse((posts("/api/chat")[0]![1] as RequestInit).body as string).content
    expect(content).toContain("## Ada's request\nAdd a backoff")
    expect(content).toContain("- In a side thread (thr_abc123) about: “never backs off”")
    expect(content).toContain("## Highlighted text\n> retries at once")
    // The thread stays open, and no question was asked.
    expect(openThreadId(COORDINATOR_CHAT)).toBe("thr_abc123")
    expect(posts("/api/threads")).toEqual([])
  })

  it("a deleted nested thread shows its parent again; a deleted parent takes its nested threads with it", () => {
    openOn([thread(), child(), child({ id: "thr_grand01", parentId: "thr_child01", quote: "no delay" })], "thr_grand01")
    act(() => void applyThreadEvent(qc, { type: "thread.deleted", threadId: "thr_grand01", projectId: null }))
    expect(openThreadId(COORDINATOR_CHAT)).toBe("thr_child01")
    act(() => void applyThreadEvent(qc, { type: "thread.deleted", threadId: "thr_abc123", projectId: null }))
    expect(qc.getQueryData(threadKeys.list(COORDINATOR_CHAT))).toEqual([])
  })
})

describe("side thread markers", () => {
  it("show under the message, open and close the thread, and the thread closes to its marker", () => {
    render([thread()])
    const marker = host.querySelector("[data-testid=thread-marker]")!
    expect(marker.textContent).toContain("never backs off")
    click(marker)
    expect(openThreadId(COORDINATOR_CHAT)).toBe("thr_abc123")
    expect(document.querySelector("[data-testid=side-thread]")).not.toBeNull()
    click(document.querySelector("[aria-label='Close thread']")!)
    // Closing only hides it; the marker stays.
    expect(host.querySelector("[data-testid=thread-marker]")).not.toBeNull()
  })

  it("go when the thread is deleted, and a deleted open thread closes", () => {
    render([thread()])
    act(() => openThread(COORDINATOR_CHAT, "thr_abc123"))
    act(() => void applyThreadEvent(qc, { type: "thread.deleted", threadId: "thr_abc123", projectId: null }))
    expect(host.querySelector("[data-testid=thread-marker]")).toBeNull()
    expect(qc.getQueryData(threadKeys.list(COORDINATOR_CHAT))).toEqual([])
  })

  it("stream replies into the open thread", async () => {
    render([thread({ busy: true })])
    qc.setQueryData<SideThreadMessage[]>(threadKeys.messages("thr_abc123"), [{ id: "thm_q00001", threadId: "thr_abc123", role: "user", content: "Why?", meta: null, createdAt: 3 }])
    act(() => openThread(COORDINATOR_CHAT, "thr_abc123"))
    act(() => void applyThreadEvent(qc, { type: "thread.delta", threadId: "thr_abc123", text: "Because it " }))
    act(() => void applyThreadEvent(qc, { type: "thread.delta", threadId: "thr_abc123", text: "retries." }))
    await flush()
    expect(document.querySelector("[data-testid=side-thread]")!.textContent).toContain("Because it retries.")
    act(() => void applyThreadEvent(qc, { type: "thread.message", message: { id: "thm_a00001", threadId: "thr_abc123", role: "assistant", content: "Because it retries forever.", meta: null, createdAt: 4 } }))
    await flush()
    expect(qc.getQueryData(threadKeys.stream("thr_abc123"))).toBe("")
    expect(document.querySelector("[data-testid=side-thread-reply]")!.textContent).toContain("Because it retries forever.")
  })
})

/** Type into a textarea and press Enter, as React sees it. */
function typeAndSend(box: HTMLTextAreaElement, text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text)
    box.dispatchEvent(new Event("input", { bubbles: true }))
  })
  act(() => void box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })))
}

const replyThread = (over: Partial<SideThread> = {}) => thread({ id: "thr_reply01", kind: "reply", quote: REPLY.content, ...over })
const posts = (path: string) => fetchMock.mock.calls.filter(([u, init]) => u === path && (init as RequestInit | undefined)?.method !== "GET" && (init as RequestInit | undefined)?.body !== undefined)

describe("threaded replies", () => {
  it("Reply opens an empty thread on the message; the first reply starts it, out of the main chat", async () => {
    render()
    const reply = host.querySelector<HTMLButtonElement>("[data-testid=message-reply]")!
    expect(reply).not.toBeNull()
    click(reply)
    const pane = document.querySelector("[data-testid=side-thread]")!
    // The original on top, titled by its first line, and nothing sent yet.
    expect(pane.querySelector("[data-testid=side-thread-title]")!.textContent).toBe("The retry loop in server/sync.ts never backs off,")
    expect(pane.querySelector("[data-testid=side-thread-original]")!.textContent).toContain("so a dead remote spins the CPU.")
    expect(pane.textContent).toContain("No replies yet")
    expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/threads"))).toEqual([])
    const box = pane.querySelector<HTMLTextAreaElement>("textarea")!
    expect(document.activeElement).toBe(box)

    typeAndSend(box, "Can it back off?")
    await flush()
    const [[, init]] = posts("/api/threads")
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body).toMatchObject({ kind: "reply", anchorId: REPLY.id, question: "Can it back off?", projectId: null })
    expect(body.quote).toBeUndefined()
    expect(openThreadId(COORDINATOR_CHAT)).toBe(body.id)
    // Nothing went to the Coordinator's own chat.
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/chat"))).toBe(false)
    // The chat shows the count under the message, not the reply; the panel says it is working on the thread.
    expect(host.querySelector("[data-testid=thread-replies]")!.textContent).toContain("1 reply")
    expect(host.querySelector("[data-chat-id]")!.textContent).not.toContain("Can it back off?")
    expect(document.querySelector("[data-testid=side-thread-working]")!.textContent).toContain("Working on this thread…")
  })

  it("Reply on a message that has replies opens its thread; questions on highlights stay chips", () => {
    render([replyThread(), thread()])
    expect(host.querySelectorAll("[data-testid=thread-replies]")).toHaveLength(1)
    expect(host.querySelectorAll("[data-testid=thread-marker]")).toHaveLength(1)
    click(host.querySelector("[data-testid=message-reply]")!)
    expect(openThreadId(COORDINATOR_CHAT)).toBe("thr_reply01")
    expect(document.activeElement).toBe(document.querySelector("[data-testid=side-thread] textarea"))
  })

  it("Reply mounts the panel and puts the caret in its box inside the press, and only then", async () => {
    render()
    const box = () => document.querySelector<HTMLTextAreaElement>("[data-testid=side-thread] textarea")
    expect(box()).toBeNull()
    // As the browser dispatches it, outside act: iOS brings up the keyboard only for a focus() inside the tap itself.
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    env.IS_REACT_ACT_ENVIRONMENT = false
    try {
      host.querySelector<HTMLButtonElement>("[data-testid=message-reply]")!.click()
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = true
    }
    expect(box()).not.toBeNull()
    expect(document.activeElement).toBe(box())
    await flush()

    // Pressed again with the panel open (the focus gone elsewhere): back in the box.
    act(() => box()!.blur())
    click(host.querySelector("[data-testid=message-reply]")!)
    expect(document.activeElement).toBe(box())

    // Another chat and back: the panel mounts again on the draft thread, and leaves the focus be.
    act(() => box()!.blur())
    act(() => root.render(createElement("div")))
    render()
    expect(box()).not.toBeNull()
    expect(document.activeElement).not.toBe(box())

    // Put back after giving way to pinned panels (App.tsx), the same.
    const shown = openThreadState(COORDINATOR_CHAT)!
    act(() => closeThread(COORDINATOR_CHAT))
    expect(box()).toBeNull()
    act(() => restoreThread(COORDINATOR_CHAT, shown))
    expect(box()).not.toBeNull()
    expect(document.activeElement).not.toBe(box())
  })

  it("↰ N replies counts live, shows answering and unread, and opening marks it read", async () => {
    render([replyThread({ busy: true })])
    const button = () => host.querySelector<HTMLButtonElement>("[data-testid=thread-replies]")!
    expect(button().textContent).toBe("2 replies")
    expect(button().getAttribute("aria-label")).toBe("2 replies, answering")
    act(() => void applyThreadEvent(qc, { type: "thread", thread: replyThread({ busy: false, replies: 3, unread: true }) }))
    await flush()
    expect(button().textContent).toBe("3 replies")
    expect(button().dataset.unread).toBe("true")

    click(button())
    await flush()
    expect(openThreadId(COORDINATOR_CHAT)).toBe("thr_reply01")
    expect(posts("/api/threads/thr_reply01/seen")).toHaveLength(1)
    expect(button().dataset.unread).toBeUndefined()
    expect(button().getAttribute("aria-pressed")).toBe("true")
  })

  it("resolve folds the thread away under its message; it reopens from there", async () => {
    render([replyThread()])
    act(() => openThread(COORDINATOR_CHAT, "thr_reply01"))
    click(document.querySelector("[data-testid=side-thread-resolve]")!)
    await flush()
    expect(posts("/api/threads/thr_reply01/resolve")).toHaveLength(1)
    expect(JSON.parse((posts("/api/threads/thr_reply01/resolve")[0]![1] as RequestInit).body as string)).toEqual({ resolved: true })
    // It's gone at once (no slide out), and the count says resolved.
    expect(document.querySelector("[data-testid=side-thread]")).toBeNull()
    expect(openThreadId(COORDINATOR_CHAT)).toBeNull()
    const marker = host.querySelector<HTMLButtonElement>("[data-testid=thread-replies]")!
    expect(marker.dataset.resolved).toBe("true")
    expect(marker.getAttribute("aria-label")).toBe("2 replies, resolved")
    click(marker)
    expect(openThreadId(COORDINATOR_CHAT)).toBe("thr_reply01")
    expect(document.querySelector("[data-testid=side-thread-resolve]")!.getAttribute("aria-label")).toBe("Reopen thread")
  })

  it("expands over the chat and back", () => {
    render([replyThread()])
    act(() => openThread(COORDINATOR_CHAT, "thr_reply01"))
    const pane = () => document.querySelector<HTMLElement>("[data-testid=side-thread]")!
    expect(pane().dataset.expanded).toBeUndefined()
    click(document.querySelector("[data-testid=side-thread-expand]")!)
    expect(pane().dataset.expanded).toBe("true")
    click(document.querySelector("[data-testid=side-thread-expand]")!)
    expect(pane().dataset.expanded).toBeUndefined()
  })
})

describe("where each reply went", () => {
  const user = (id: string, content: string, meta: Record<string, unknown> | null): SideThreadMessage => ({ id, threadId: "thr_reply01", role: "user", content, meta, createdAt: 3 })
  const said = (id: string, role: SideThreadMessage["role"], content: string): SideThreadMessage => ({ id, threadId: "thr_reply01", role, content, meta: null, createdAt: 4 })
  const routes = () => [...document.querySelectorAll<HTMLElement>("[data-testid=thread-route]")]
  const labels = () => routes().map((r) => r.textContent)
  const tap = (route: HTMLElement, label: string) => click([...route.querySelectorAll("button")].find((b) => b.textContent === label)!)

  function show(messages: SideThreadMessage[], over: Partial<SideThread> = {}) {
    render([replyThread({ replies: messages.length, ...over })])
    qc.setQueryData<SideThreadMessage[]>(threadKeys.messages("thr_reply01"), messages)
    act(() => openThread(COORDINATOR_CHAT, "thr_reply01"))
  }

  it("says under each of Cody's messages where it went, with the one tap that sends it the other way", () => {
    show(
      [
        user("thm_q00001", "Why does it spin?", routeMeta({ route: "thread" })),
        said("thm_a00001", "assistant", "It never backs off."),
        user("thm_q00002", "Add a backoff", routeMeta({ route: "agent", taskId: "task_sync0001", inputId: "inp_1" })),
        user("thm_q00003", "Split the logging into its own task", routeMeta({ route: "chat", chatMessageId: "chat_fwd001" })),
        user("thm_q00004", "Try it", routeMeta({ route: "failed" })),
        said("thm_e00001", "error", "Claude crashed"),
      ],
      { taskId: "task_sync0001" },
    )
    expect(labels()).toEqual([
      "answered by CoordinatorSend to agent instead",
      "sent to agentJust ask instead",
      "sent to CoordinatorJust ask instead",
      "Not sentSend to agentAsk again",
    ])
    // Every message stays in the thread, the failed one too.
    const pane = document.querySelector("[data-testid=side-thread]")!
    for (const text of ["Why does it spin?", "Add a backoff", "Split the logging into its own task", "Try it"]) expect(pane.textContent).toContain(text)
    // 44px to a finger, and nothing moves.
    for (const b of document.querySelectorAll<HTMLElement>("[data-testid=thread-route] button")) {
      expect(b.className).toContain("pointer-coarse:min-h-11")
      expect(b.className).not.toMatch(/transition|animate-/)
    }
  })

  it("a re-route tap posts the new route for that message", async () => {
    show([user("thm_q00002", "Add a backoff", routeMeta({ route: "agent", taskId: "task_sync0001", inputId: "inp_1" }))], { taskId: "task_sync0001" })
    tap(routes()[0]!, "Just ask instead")
    await flush()
    const sent = posts("/api/threads/thr_reply01/messages/thm_q00002/route")
    expect(sent).toHaveLength(1)
    expect(JSON.parse((sent[0]![1] as RequestInit).body as string)).toEqual({ to: "thread" })
  })

  it("sends to the main chat where the message has no task, and says it's routing while the turn runs", () => {
    show([user("thm_q00001", "Why?", routeMeta({ route: "thread" })), user("thm_q00002", "And then?", null)], { busy: true })
    expect(labels()).toEqual(["answered by CoordinatorSend to Coordinator instead", "Coordinator is routing it…"])
    expect(routes()[1]!.querySelector("button")).toBeNull()
  })

  it("reads right in a Captain's chat, and for messages Cody re-routed", () => {
    const o = { router: "Captain", hasTask: true, routing: false, answered: false }
    expect(routeView(null, { ...o, answered: true })).toBeNull()
    expect(routeView(null, o)).toEqual({ label: "Not sent yet", actions: [{ to: "agent", label: "Send to agent" }, { to: "thread", label: "Ask here" }] })
    const info = (over: Parameters<typeof routeMeta>[0]) => ({ route: over.route, by: over.by ?? "router", taskId: null, inputId: null, chatMessageId: over.chatMessageId ?? null, recalled: over.recalled ?? false, delivered: over.delivered ?? false })
    expect(routeView(info({ route: "chat" }), o)!.label).toBe("sent to Captain")
    expect(routeView(info({ route: "thread", by: "cody", recalled: true }), o)!.label).toBe("asked here · taken back from the agent")
    expect(routeView(info({ route: "thread", by: "cody", delivered: true, chatMessageId: "cap_1" }), o)!.label).toBe("asked here · the Captain already had it")
    expect(routeView(info({ route: "thread", by: "cody" }), { ...o, hasTask: false })).toEqual({ label: "asked here", actions: [{ to: "chat", label: "Send to Captain instead" }] })
  })
})

describe("findQuoteRange", () => {
  it("finds a selection's text across elements and line breaks", () => {
    const el = document.createElement("div")
    el.innerHTML = "<p>The retry loop in <strong>server/sync.ts</strong> never</p>\n<p>backs off.</p><div data-thread-markers>never backs off</div>"
    const range = findQuoteRange(el, "sync.ts never\n\nbacks")!
    expect(range.toString()).toBe("sync.ts never</p>\n<p>backs".replace(/<\/?p>/g, ""))
    expect(findQuoteRange(el, "not there")).toBeNull()
  })
})

describe("threadDockWidth", () => {
  const SIDEBAR = 256
  it("widens the docked Coordinator for the thread, leaving the page MAIN_MIN_THREAD", () => {
    expect(threadDockWidth(1920, SIDEBAR, 416)).toBe(416 + THREAD_ROOM)
    const laptop = threadDockWidth(1440, SIDEBAR, 416)
    expect(1440 - SIDEBAR - laptop).toBeGreaterThanOrEqual(MAIN_MIN_THREAD)
    // 125% zoom: still room for both side by side (35.5rem).
    const zoomed = coordinatorDock(1152, SIDEBAR, 416)
    expect(threadDockWidth(1152, SIDEBAR, zoomed.width) - 1).toBeGreaterThanOrEqual(35.5 * 16)
    // Never narrower than without a thread.
    expect(threadDockWidth(1000, SIDEBAR, 500)).toBe(500)
  })
})
