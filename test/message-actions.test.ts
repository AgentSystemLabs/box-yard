// @vitest-environment happy-dom
// A chat message's one action (MessageActions.tsx): Reply, in a small toolbar on a short message and in a pill at the
// tap's height on one taller than about the chat, which quotes text selected beside it. It opens the message's reply
// thread, where the chat's agent routes each message (side-threads-web.test.ts, thread-routing.test.ts). No Ask,
// Respond or ··· menu, and nothing that stops the text being selected.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ChatLine } from "../web/src/components/ChatLine.js"
import { CaptainTab } from "../web/src/components/CaptainTab.js"
import { Line } from "../web/src/components/TaskView.js"
import { SelectionToTask } from "../web/src/components/SelectionToTask.js"
import { SideThreadPane, ThreadChatProvider } from "../web/src/components/SideThread.js"
import { quoteLines } from "../web/src/components/MessageActions.js"
import { findQuoteRange } from "../web/src/lib/threadHighlight.js"
import { keys } from "../web/src/lib/queries.js"
import { COORDINATOR_CHAT, closeThread, openThreadId, threadKeys } from "../web/src/lib/threads.js"
import type { SelectionTaskSource } from "../web/src/lib/selectionTask.js"
import type { CaptainMessage, CaptainState, ChatMessage, Project, SettingsInfo, TaskMessage } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project = { id: "prj_alpha1", name: "alpha", description: "", repo: null, baseBranch: "main", envKeys: [], notes: [], createdAt: 0, updatedAt: 0 } as unknown as Project
const ALPHA = { id: "prj_alpha1", name: "alpha" }
const ORCH: SelectionTaskSource = { kind: "orchestrator", project: ALPHA }

/** Every ResizeObserver and what it watches (MessageActions keeps one for every message), to report a height. */
const sizes: { cb: ResizeObserverCallback; els: Set<Element> }[] = []
class FakeResizeObserver {
  watch: { cb: ResizeObserverCallback; els: Set<Element> }
  constructor(cb: ResizeObserverCallback) {
    this.watch = { cb, els: new Set() }
    sizes.push(this.watch)
  }
  observe(el: Element) {
    this.watch.els.add(el)
  }
  unobserve(el: Element) {
    this.watch.els.delete(el)
  }
  disconnect() {
    this.watch.els.clear()
  }
}
/** The long message's pill watches whether it's still in view. */
let views: { cb: IntersectionObserverCallback; el: Element | null }[] = []
class FakeIntersectionObserver {
  view: { cb: IntersectionObserverCallback; el: Element | null }
  constructor(cb: IntersectionObserverCallback) {
    this.view = { cb, el: null }
    views.push(this.view)
  }
  observe(el: Element) {
    this.view.el = el
  }
  disconnect() {
    views = views.filter((v) => v !== this.view)
  }
}

/** The message `el` is now `height` px tall, as the ResizeObserver reports it. */
const resize = (el: Element, height: number) =>
  act(() => {
    const entry = { target: el, borderBoxSize: [{ blockSize: height, inlineSize: 600 }], contentRect: { height } } as unknown as ResizeObserverEntry
    for (const w of sizes) if (w.els.has(el)) w.cb([entry], {} as ResizeObserver)
  })

let root: Root
let host: HTMLElement
let qc: QueryClient
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  history.replaceState(null, "", "/")
  sessionStorage.clear()
  fetchMock = vi.fn(() => new Promise(() => {}))
  vi.stubGlobal("fetch", fetchMock)
  vi.stubGlobal("ResizeObserver", FakeResizeObserver)
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
  views = []
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const k of [keys.tasks, keys.schedules, keys.artifacts, keys.boxes]) qc.setQueryData(k, [])
  qc.setQueryData(keys.projects, [project])
  for (const chat of [COORDINATOR_CHAT, project.id]) qc.setQueryData(threadKeys.list(chat), [])
  qc.setQueryData(keys.agentSettings, { settings: { ownerName: "Ada", agentModel: "claude-opus-5-5", agentEffort: "high" } } as unknown as SettingsInfo)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  closeThread(COORDINATOR_CHAT)
  closeThread(project.id)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const render = (node: ReactNode) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, node)))
/** A chat with reply threads (the Coordinator's), or `null`: one without (a task's transcript). */
const inChat = (chat: string | null, source: SelectionTaskSource | null, ...children: ReactNode[]) => {
  const lines = createElement(SelectionToTask, { source, onPrompt: () => {} }, createElement("div", null, ...children))
  render(chat ? createElement(ThreadChatProvider, { value: chat }, lines, createElement(SideThreadPane, { chat })) : lines)
}
const click = (el: Element, at?: { clientY: number }) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...at })))
const down = (el: Element) => act(() => void el.dispatchEvent(new Event("pointerdown", { bubbles: true })))
const toolbars = () => [...host.querySelectorAll<HTMLElement>("[data-message-actions]")]
const pills = () => [...host.querySelectorAll<HTMLElement>("[data-reply-pill]")]
const touch = () => vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(hover: none)", media: q, addEventListener() {}, removeEventListener() {} }))

const chat = (id: string, role: ChatMessage["role"], content: string, meta: ChatMessage["meta"] = null): ChatMessage => ({ id, role, content, meta, createdAt: 1 })
const line = (m: ChatMessage) => createElement(ChatLine, { key: m.id, m, onFollowUp: () => {} })
const replyEl = () => host.querySelector<HTMLElement>("[data-testid=chat-reply]")!

describe("the message toolbar", () => {
  it("is one Reply on every Coordinator message type but not on tool rows", () => {
    inChat(
      COORDINATOR_CHAT,
      ORCH,
      line(chat("chat_reply0001", "assistant", "A **reply**")),
      line(chat("chat_user00001", "user", "My question")),
      line(chat("chat_sched0001", "user", "Nightly check", { scheduleId: "sch_x" })),
      line(chat("chat_notice001", "notice", "✅ **Fix sync** finished: opened a PR", { taskId: "task_abcdef1" })),
      line(chat("chat_error0001", "error", "Coordinator crashed")),
      line(chat("chat_tool00001", "tool", "list_tasks", { input: {} })),
    )
    const bars = toolbars()
    expect(bars).toHaveLength(5)
    for (const bar of bars) {
      expect(bar.getAttribute("role")).toBe("toolbar")
      const buttons = [...bar.querySelectorAll("button")]
      expect(buttons.map((b) => b.dataset.testid)).toEqual(["message-reply"])
      expect(buttons[0]!.getAttribute("aria-label")).toBe("Reply in a thread")
      expect(buttons[0]!.title).toBeTruthy()
    }
    // The old Ask, Respond and ··· are gone, and so is the menu they opened.
    for (const gone of ["message-ask", "message-respond", "message-more"]) expect(host.querySelector(`[data-testid=${gone}]`)).toBeNull()
    expect(host.querySelector("[data-testid=chat-reply] [data-message-actions]")).not.toBeNull()
    // It shows and hides at once: no fade.
    expect(bars[0]!.className).not.toMatch(/transition|duration-|animate-/)
  })

  it("Reply opens the message's reply thread, sending nothing; Reply again keeps the same thread", () => {
    inChat(COORDINATOR_CHAT, ORCH, line(chat("chat_reply0001", "assistant", "The retry loop never backs off.")))
    const reply = host.querySelector<HTMLButtonElement>("[data-testid=message-reply]")!
    click(reply)
    const id = openThreadId(COORDINATOR_CHAT)
    expect(id).not.toBeNull()
    const pane = document.querySelector("[data-testid=side-thread]")!
    expect(pane.querySelector("[data-testid=side-thread-original]")!.textContent).toContain("The retry loop never backs off.")
    expect(pane.querySelector("[data-testid=side-thread-routing-hint]")!.textContent).toContain("The Coordinator answers questions here and sends instructions on")
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toEqual([])
    click(reply)
    expect(openThreadId(COORDINATOR_CHAT)).toBe(id)
  })

  it("Reply on a task notice doesn't open the task", () => {
    inChat(COORDINATOR_CHAT, ORCH, line(chat("chat_notice001", "notice", "✅ **Fix sync** finished: opened a PR", { taskId: "task_abcdef1" })))
    click(host.querySelector("[data-testid=message-reply]")!)
    expect(location.pathname).toBe("/")
    expect(openThreadId(COORDINATOR_CHAT)).not.toBeNull()
  })

  it("isn't there where the chat has no reply threads: a task's transcript, or a chat outside one", () => {
    const msg = (id: string, role: TaskMessage["role"], content: string, meta: TaskMessage["meta"] = null) =>
      createElement(Line, { key: id, m: { id, taskId: "task_sync0001", role, content, meta, createdAt: 1 } as TaskMessage, onFollowUp: () => {} })
    const source: SelectionTaskSource = { kind: "task", project: ALPHA, task: { id: "task_sync0001", title: "Fix sync", branch: "fix-sync", prUrl: null } }
    inChat(null, source, msg("msg_user00001", "user", "Please fix sync"), msg("msg_reply0001", "assistant", "Fixed."), msg("msg_agent0001", "agent", "Heads up", { from: "task_other001", fromTitle: "Other" }), line(chat("chat_reply0001", "assistant", "A reply")))
    expect(toolbars()).toHaveLength(0)
    expect(pills()).toHaveLength(0)
    expect(host.querySelector("button")).toBeNull()
  })

  it("on touch, a tap on the message shows the toolbar and a tap elsewhere hides it; a tap on a link doesn't", () => {
    touch()
    inChat(COORDINATOR_CHAT, ORCH, line(chat("chat_reply0001", "assistant", "See [the docs](https://example.com) for more")), line(chat("chat_reply0002", "assistant", "Other")))
    const [bar, other] = toolbars()
    expect(bar!.hasAttribute("data-open")).toBe(false)
    act(() => void replyEl().querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })))
    expect(bar!.hasAttribute("data-open")).toBe(false)
    click(replyEl().querySelector("p")!)
    expect(bar!.hasAttribute("data-open")).toBe(true)
    expect(other!.hasAttribute("data-open")).toBe(false)
    down(other!.parentElement!)
    expect(bar!.hasAttribute("data-open")).toBe(false)
  })

  it("hides a tapped toolbar on Esc and when the app goes to the background", () => {
    touch()
    inChat(COORDINATOR_CHAT, ORCH, line(chat("chat_reply0001", "assistant", "A reply")))
    const bar = toolbars()[0]!
    click(replyEl().querySelector("p")!)
    act(() => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))
    expect(bar.hasAttribute("data-open")).toBe(false)
    click(replyEl().querySelector("p")!)
    expect(bar.hasAttribute("data-open")).toBe(true)
    act(() => void window.dispatchEvent(new Event("pagehide")))
    expect(bar.hasAttribute("data-open")).toBe(false)
  })

  it("is on Captain replies, inbound messages and notices, opens the Captain chat's thread, and a notice row doesn't fold open for it", () => {
    const msg = (id: string, role: CaptainMessage["role"], content: string, meta: CaptainMessage["meta"], at: number): CaptainMessage => ({ id, projectId: project.id, role, content, meta, createdAt: at })
    qc.setQueryData<CaptainMessage[]>(keys.captainMessages(project.id), [
      msg("cap_coord00001", "user", "What's open?", { source: "coordinator" }, 1),
      msg("cap_reply00001", "assistant", "Two tasks need you.", null, 2),
      msg("cap_notice0001", "notice", "✅ **Fix sync** finished: opened a PR", { taskId: "task_abcdef1" }, 3),
      msg("cap_reply00002", "assistant", "Done.", null, 4),
    ])
    qc.setQueryData<CaptainState>(keys.captain(project.id), {
      projectId: project.id, busy: false, usage: { tokens: null, window: null, updatedAt: null }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null,
    } as unknown as CaptainState)
    qc.setQueryData(keys.captainCompactions(project.id), [])
    render(createElement(CaptainTab, { project }))
    expect(toolbars()).toHaveLength(4)
    const notice = host.querySelector<HTMLElement>("#captain-cap_notice0001")!
    click(notice.querySelector("[data-testid=message-reply]")!)
    expect(notice.getAttribute("aria-expanded")).toBe("false")
    expect(openThreadId(project.id)).not.toBeNull()
    expect(openThreadId(COORDINATOR_CHAT)).toBeNull()
    // Nothing went to the Captain: the thread sends when Cody writes in it.
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toEqual([])
  })
})

/** Taller than the window: 768px in happy-dom, so 2000px is long. */
const LONG_HEIGHT = 2000

describe("a long message's Reply pill", () => {
  /** A long reply whose top is 500px above the window (`top`), so its visible part runs from 500px to 1268px into it. */
  const long = (top = -500) => {
    inChat(
      COORDINATOR_CHAT,
      ORCH,
      line(chat("chat_reply0001", "assistant", "See [the docs](https://example.com) for more.\n\nThe retry loop never backs off, so a dead remote spins the CPU.")),
      line(chat("chat_reply0002", "assistant", "Short")),
    )
    const block = replyEl()
    resize(block, LONG_HEIGHT)
    vi.spyOn(block, "getBoundingClientRect").mockReturnValue(new DOMRect(0, top, 600, LONG_HEIGHT))
    return block
  }
  const column = (block: HTMLElement) => block.querySelector<HTMLElement>(":scope > [data-reply-pill]")!
  const pill = (block: HTMLElement) => column(block).querySelector<HTMLButtonElement>("[data-testid=message-reply]")!
  const esc = () => {
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    act(() => void document.body.dispatchEvent(e))
    return e
  }
  /** Select `text` in the reply, as a drag would; its last line box is 200px down the window. */
  const select = (text: string) => {
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([new DOMRect(40, 200, 240, 18)] as unknown as DOMRectList)
    const range = findQuoteRange(replyEl(), text)!
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    act(() => void document.dispatchEvent(new Event("selectionchange")))
  }
  afterEach(() => window.getSelection()?.removeAllRanges())

  it("replaces the toolbar, never both, and gets a gutter so it never covers the text", () => {
    const block = long()
    expect(block.querySelector("[data-message-actions]")).toBeNull()
    expect(column(block)).not.toBeNull()
    expect(block.className).toContain("has-[>[data-reply-pill]]:pr-12")
    // The short message keeps its toolbar.
    expect(toolbars()).toHaveLength(1)
    // Hidden until a tap, and a 44px-wide target in a column down the gutter that doesn't catch presses on the text.
    expect(column(block).hasAttribute("data-open")).toBe(false)
    expect(column(block).className).toMatch(/\binset-y-0\b.*\bpointer-events-none\b|\bpointer-events-none\b.*\binset-y-0\b/)
    expect(pill(block).className).toContain("w-11")
    expect(pill(block).style.height).toBe("52px")
    for (const el of [column(block), pill(block)]) expect(el.className).not.toMatch(/transition|duration-|animate-/)
    // Shorter again: back to the toolbar.
    resize(block, 300)
    expect(block.querySelector("[data-reply-pill]")).toBeNull()
    expect(block.querySelector("[data-message-actions]")).not.toBeNull()
  })

  it("shows on keyboard focus without a tap or a hover, stuck to the top of the message's visible part", () => {
    const block = long()
    const cls = pill(block).className.split(/\s+/)
    expect(cls).toEqual(expect.arrayContaining(["sticky", "top-2", "opacity-0", "focus-visible:opacity-100", "focus-visible:pointer-events-auto"]))
    expect(cls.some((c) => c.startsWith("hover:opacity") || c.startsWith("group-hover"))).toBe(false)
    // It's in the tab order, and Enter on it replies.
    expect(pill(block).tabIndex).toBe(0)
    click(pill(block))
    expect(openThreadId(COORDINATOR_CHAT)).not.toBeNull()
  })

  it("a tap on the text shows it at the tap's height; a link, a tap elsewhere, Esc or scrolling away doesn't keep it", () => {
    const block = long()
    act(() => void block.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientY: 300 })))
    expect(column(block).hasAttribute("data-open")).toBe(false)
    // At 300px in the viewport, 800px into the message (its top is 500px above): centred on the tap.
    click(block.querySelector("p")!, { clientY: 300 })
    expect(column(block).hasAttribute("data-open")).toBe(true)
    expect(pill(block).style.top).toBe(`${800 - 26}px`)
    expect(pill(block).className).not.toContain("sticky")
    // Another tap on it moves it there; a press inside the message keeps it.
    down(block.querySelector("p")!)
    click(block.querySelector("p")!, { clientY: 100 })
    expect(pill(block).style.top).toBe(`${600 - 26}px`)
    // A press elsewhere hides it.
    down(document.body)
    expect(column(block).hasAttribute("data-open")).toBe(false)
    expect(pill(block).style.top).toBe("")
    // Esc hides it, and is used up, so the open thread around it doesn't close too.
    click(block.querySelector("p")!, { clientY: 300 })
    expect(esc().defaultPrevented).toBe(true)
    expect(column(block).hasAttribute("data-open")).toBe(false)
    // Esc with nothing out is left alone.
    expect(esc().defaultPrevented).toBe(false)
    // Shown again, then scrolled out of view: gone.
    click(block.querySelector("p")!, { clientY: 300 })
    const view = views.find((v) => v.el === pill(block))!
    act(() => view.cb([{ isIntersecting: false, target: pill(block) } as unknown as IntersectionObserverEntry], {} as IntersectionObserver))
    expect(column(block).hasAttribute("data-open")).toBe(false)
  })

  it("its Reply opens the message's thread and puts it away", () => {
    const block = long()
    click(block.querySelector("p")!, { clientY: 300 })
    click(pill(block))
    expect(openThreadId(COORDINATOR_CHAT)).not.toBeNull()
    expect(column(block).hasAttribute("data-open")).toBe(false)
  })

  it("stays inside the part of the message on screen, clear of what floats over the chat, and inside the message", () => {
    const block = long()
    // Visible from 500px into the message (the window's top) to 1268px (its bottom, 768px).
    click(block.querySelector("p")!, { clientY: 2 })
    expect(pill(block).style.top).toBe(`${500 + 4}px`)
    click(block.querySelector("p")!, { clientY: 766 })
    expect(pill(block).style.top).toBe(`${1268 - 52 - 4}px`)
    // "Jump to latest" floating over the chat's bottom edge, over the gutter: the pill stays above it.
    const float = document.createElement("div")
    float.setAttribute("data-chat-float", "")
    const jump = float.appendChild(document.createElement("button"))
    document.body.append(float)
    vi.spyOn(jump, "getBoundingClientRect").mockReturnValue(new DOMRect(500, 700, 120, 44))
    click(block.querySelector("p")!, { clientY: 766 })
    expect(pill(block).style.top).toBe(`${1200 - 52 - 4}px`)
    // One that floats away from the gutter is left alone.
    vi.spyOn(jump, "getBoundingClientRect").mockReturnValue(new DOMRect(200, 700, 120, 44))
    click(block.querySelector("p")!, { clientY: 766 })
    expect(pill(block).style.top).toBe(`${1268 - 52 - 4}px`)
    // A message starting 100px down the window: its own top is the limit.
    vi.spyOn(block, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 600, LONG_HEIGHT))
    click(block.querySelector("p")!, { clientY: 102 })
    expect(pill(block).style.top).toBe("4px")
  })

  it("in a chat's scroller, the scroller's visible part is the limit, and its height is what long means", () => {
    host.setAttribute("data-scroller", "")
    let height = 400
    Object.defineProperty(host, "clientHeight", { configurable: true, get: () => height })
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 600, 400))
    const block = long()
    // The scroller shows 100px–500px of the window: 600px–1000px into the message.
    click(block.querySelector("p")!, { clientY: 110 })
    expect(pill(block).style.top).toBe(`${600 + 4}px`)
    click(block.querySelector("p")!, { clientY: 495 })
    expect(pill(block).style.top).toBe(`${1000 - 52 - 4}px`)
    // 500px is long in a 400px scroller, though not in the 768px window.
    resize(block, 500)
    expect(column(block)).not.toBeNull()
    // The scroller grows (the keyboard closes, the window gets taller): not long any more.
    height = 1000
    resize(host, 1000)
    expect(column(block)).toBeNull()
    expect(block.querySelector("[data-message-actions]")).not.toBeNull()
  })

  it("a selection doesn't show it, and the selection's own Reply quoting selection is still there", () => {
    const block = long()
    select("never backs off")
    click(block.querySelector("p:last-child")!, { clientY: 300 })
    expect(column(block).hasAttribute("data-open")).toBe(false)
    expect(document.querySelector("[data-testid=selection-reply]")).not.toBeNull()
  })

  it("with text selected while it's out, it quotes the selection, beside it, and the selection's own action steps aside", () => {
    const block = long()
    click(block.querySelector("p")!, { clientY: 300 })
    select("never backs off")
    expect(column(block).hasAttribute("data-quote")).toBe(true)
    expect(pill(block).getAttribute("aria-label")).toBe("Reply quoting selection")
    expect(pill(block).className).toContain("after:content-['Quote']")
    // Beside the selection's last line (200px–218px in the window: 709px into the message).
    expect(pill(block).style.top).toBe(`${709 - 26}px`)
    expect(document.querySelector("[data-testid=selection-reply]")).toBeNull()
    // Pressing it keeps the selection; a phone may drop it before the click lands, so the quote is kept from the press.
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    act(() => {
      pill(block).dispatchEvent(new Event("pointerdown", { bubbles: true }))
      pill(block).dispatchEvent(press)
    })
    expect(press.defaultPrevented).toBe(true)
    act(() => {
      window.getSelection()!.removeAllRanges()
      document.dispatchEvent(new Event("selectionchange"))
    })
    click(pill(block))
    const box = document.querySelector<HTMLTextAreaElement>("[data-testid=side-thread] textarea")!
    expect(box.value).toBe("> never backs off\n\n")
    expect(column(block).hasAttribute("data-open")).toBe(false)
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toEqual([])
  })

  it("selecting nothing again turns it back into a plain Reply", () => {
    const block = long()
    click(block.querySelector("p")!, { clientY: 300 })
    select("never backs off")
    act(() => {
      window.getSelection()!.removeAllRanges()
      document.dispatchEvent(new Event("selectionchange"))
    })
    expect(column(block).hasAttribute("data-quote")).toBe(false)
    expect(pill(block).getAttribute("aria-label")).toBe("Reply in a thread")
    click(pill(block))
    expect(document.querySelector<HTMLTextAreaElement>("[data-testid=side-thread] textarea")!.value).toBe("")
  })
})

describe("message text", () => {
  it("stays selectable: nothing on a message or around it turns off selection", () => {
    touch()
    inChat(COORDINATOR_CHAT, ORCH, line(chat("chat_reply0001", "assistant", "A reply")), line(chat("chat_user00001", "user", "My question")))
    for (const el of host.querySelectorAll<HTMLElement>("*")) expect(el.className.toString()).not.toMatch(/\bselect-none\b|touch-none/)
  })
})

describe("quoteLines", () => {
  it("quotes every line, blank ones too", () => {
    expect(quoteLines("Line one\n\nLine two\n")).toBe("> Line one\n>\n> Line two")
  })
})
