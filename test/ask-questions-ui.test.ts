// @vitest-environment happy-dom
// The task page's ask card with several questions (AskQuestions.tsx): one question at a time with its default picked,
// Back and Next that keep every answer, the keyboard (number keys, Enter, Shift+Enter), and Send answers posting them
// all at once for the questions it showed. A plain question keeps its old card.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TaskThread } from "../web/src/components/TaskView.js"
import { keys } from "../web/src/lib/queries.js"
import { focusAsk, resetAskProgress } from "../web/src/lib/askAnswers.js"
import { askKey, questionsText, type AskQuestion } from "../shared/askQuestions.js"
import type { Task } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const taskId = "task_asks0001"
const questions: AskQuestion[] = [
  { question: "Which database should it use?", defaultAnswer: "Postgres", options: ["SQLite", "MySQL"] },
  { question: "Where should it deploy?", defaultAnswer: "Fly.io", options: ["Render"] },
  { question: "What should the service be called?", defaultAnswer: "acme-settings", options: [] },
]
const question = questionsText("A few choices before I build it.", questions)

let root: Root
let host: HTMLElement
let qc: QueryClient
let posts: { url: string; body: Record<string, unknown> }[]
let reply: () => Response

const render = (props: { ask?: string | null; questions?: AskQuestion[] | null } = {}) =>
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(TaskThread, { id: taskId, handle: null, working: null, ask: question, questions, selectionSource: null, selectionAsk: null, onFollowUp: () => {}, ...props }),
      ),
    ),
  )
const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel)
const progress = () => $("[data-testid=ask-progress]")!.textContent
const legend = () => $("legend")!.textContent
const radios = () => [...host.querySelectorAll<HTMLInputElement>('[data-testid=ask-question] input[type="radio"]')]
const checked = () => radios().findIndex((r) => r.checked)
const choiceTexts = () => [...host.querySelectorAll("[data-testid=ask-choice]")].map((c) => c.textContent)
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })))
const press = (el: Element, key: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })
  act(() => void el.dispatchEvent(e))
  return e
}
const typeInto = (el: HTMLInputElement, value: string) =>
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    set.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

beforeEach(() => {
  resetAskProgress()
  posts = []
  reply = () => new Response(JSON.stringify({ id: taskId, projectId: "prj_example", title: "Settings page", status: "queued", question: null, questions: null }), { status: 200 })
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) })
      return reply()
    }
    return new Promise(() => {})
  })
  vi.stubGlobal("requestAnimationFrame", () => 0)
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const key of [keys.projects, keys.schedules, keys.artifacts, keys.taskQueue(taskId)]) qc.setQueryData(key, [])
  qc.setQueryData<Partial<Task>[]>(keys.tasks, [{ id: taskId, projectId: "prj_example", title: "Settings page", status: "needs_input", question, questions }])
  qc.setQueryData(keys.taskMessages(taskId), [{ id: "m_ask", taskId, role: "event", content: `Asked the owner: ${question}`, createdAt: Date.now() - 60_000, meta: { kind: "question" } }])
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  qc.clear()
  host.remove()
  vi.unstubAllGlobals()
})

describe("several questions in the ask card", () => {
  it("shows the first question with its default picked, its options, an answer of one's own, and where it is", () => {
    render()
    expect($("[data-testid=pending-ask]")!.dataset.questions).toBe("3")
    expect(progress()).toBe("1 of 3")
    expect(host.textContent).toContain("A few choices before I build it.")
    expect(legend()).toBe("Question 1 of 3: Which database should it use?")
    expect(choiceTexts()).toEqual(["Postgres (default)Default1", "SQLite2", "MySQL3", "Your own answer4"])
    expect(checked()).toBe(0)
    expect($<HTMLButtonElement>("[data-testid=ask-back]")!.disabled).toBe(true)
    expect($("[data-testid=ask-next]")).not.toBeNull()
    // The transcript's own line for the question steps aside while the card asks it.
    expect(host.textContent).not.toContain("Asked the owner")
    // Nothing takes the focus just because the card showed.
    expect(host.contains(document.activeElement)).toBe(false)
  })

  it("goes back and forward keeping every answer, and moves the focus with the question", () => {
    render()
    click(radios()[2]!)
    expect(checked()).toBe(2)
    click($("[data-testid=ask-next]")!)
    expect(progress()).toBe("2 of 3")
    expect(legend()).toContain("Where should it deploy?")
    expect(checked()).toBe(0)
    expect(document.activeElement).toBe(radios()[0])
    typeInto($<HTMLInputElement>("[data-testid=ask-custom]")!, "A box of its own")
    expect(checked()).toBe(radios().length - 1)
    click($("[data-testid=ask-back]")!)
    expect(progress()).toBe("1 of 3")
    expect(checked()).toBe(2)
    expect(document.activeElement).toBe(radios()[2])
    click($("[data-testid=ask-next]")!)
    expect($<HTMLInputElement>("[data-testid=ask-custom]")!.value).toBe("A box of its own")
    expect(checked()).toBe(radios().length - 1)
  })

  it("picks with number keys, goes on with Enter and back with Shift+Enter", () => {
    render()
    const form = $("form")!
    expect(press(radios()[0]!, "3").defaultPrevented).toBe(true)
    expect(checked()).toBe(2)
    expect(document.activeElement).toBe(radios()[2])
    press(radios()[2]!, "Enter")
    expect(progress()).toBe("2 of 3")
    press(document.activeElement!, "Enter", { shiftKey: true })
    expect(progress()).toBe("1 of 3")
    expect(checked()).toBe(2)
    // The last number is "Your own answer": it puts the caret in its box, where digits are just typed.
    press(form.querySelector("input")!, "4")
    expect(document.activeElement).toBe($("[data-testid=ask-custom]"))
    expect(press(document.activeElement!, "2").defaultPrevented).toBe(false)
    // Your own answer with nothing typed can't go on.
    press(document.activeElement!, "Enter")
    expect(progress()).toBe("1 of 3")
    expect($("[data-testid=ask-error]")!.textContent).toMatch(/Type your answer/)
    typeInto($<HTMLInputElement>("[data-testid=ask-custom]")!, "DuckDB")
    expect($("[data-testid=ask-error]")).toBeNull()
    press($("[data-testid=ask-custom]")!, "Enter")
    expect(progress()).toBe("2 of 3")
  })

  it("sends every answer at once for the questions it showed, from the last question", async () => {
    render()
    click(radios()[1]!)
    click($("[data-testid=ask-next]")!)
    click($("[data-testid=ask-next]")!)
    expect(progress()).toBe("3 of 3")
    expect($("[data-testid=ask-next]")).toBeNull()
    const send = $("[data-testid=ask-send]")!
    expect(send.textContent).toBe("Send answers")
    typeInto($<HTMLInputElement>("[data-testid=ask-custom]")!, "settings-api")
    click(send)
    await flush()
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe(`/api/tasks/${taskId}/answers`)
    expect(posts[0]!.body).toMatchObject({ key: askKey(questions), answers: ["SQLite", "Fly.io", "settings-api"] })
    expect(posts[0]!.body.id).toMatch(/^chat_/)
    // The task as the server answered: no question, so no card.
    expect(qc.getQueryData<Task[]>(keys.tasks)![0]!.question).toBeNull()
  })

  it("says so when the questions were answered elsewhere meanwhile, keeping the answers", async () => {
    reply = () => new Response(JSON.stringify({ error: "not waiting" }), { status: 409 })
    render()
    click($("[data-testid=ask-next]")!)
    click($("[data-testid=ask-next]")!)
    click($("[data-testid=ask-send]")!)
    await flush()
    expect($("[data-testid=ask-error]")!.textContent).toMatch(/answered or replaced meanwhile/)
    expect(progress()).toBe("3 of 3")
  })

  it("keeps the answers in memory when the task is left and opened again", () => {
    render()
    click(radios()[1]!)
    click($("[data-testid=ask-next]")!)
    render({ ask: null, questions: null })
    expect($("[data-testid=pending-ask]")).toBeNull()
    render()
    expect(progress()).toBe("2 of 3")
    click($("[data-testid=ask-back]")!)
    expect(checked()).toBe(1)
  })

  it("takes the focus when a notice's Answer asks for it", () => {
    render()
    act(() => focusAsk(taskId))
    expect(document.activeElement).toBe(radios()[0])
  })

  it("leaves a plain question in its old card, answered in the box", () => {
    render({ ask: "Blue or green?", questions: null })
    expect($("[data-testid=pending-ask-answer]")).not.toBeNull()
    expect($("[data-testid=ask-question]")).toBeNull()
    expect($("[data-testid=pending-ask]")!.textContent).toContain("Blue or green?")
  })
})

// A phone's chat can be shorter than the card. happy-dom has no layout, so the chat is VIEW tall and the card sits
// where `card` says (its top relative to the chat's); the chat's own scrolls (scrollIntoList) are recorded.
describe("on a phone, where the card can be taller than the chat", () => {
  const VIEW = 300
  let card: { top: number; height: number }
  let frames: Map<number, FrameRequestCallback>
  let frameId: number
  let observers: { cb: () => void; targets: Set<Element> }[]
  let scrolls: number[]
  const nextFrame = () =>
    act(() => {
      const run = [...frames.values()]
      frames.clear()
      run.forEach((cb) => cb(0))
    })
  const list = () => $("[data-scroller]")!
  const cardEl = () => $("[data-testid=pending-ask]")!
  const layout = () => {
    Object.defineProperty(list(), "clientHeight", { configurable: true, get: () => VIEW })
    list().scrollTo = ((o: ScrollToOptions) => void scrolls.push(o.top ?? 0)) as typeof Element.prototype.scrollTo
  }
  // The browser reports the card's layout (as it does once it's laid out, and on each resize).
  const resized = () => act(() => observers.filter((o) => o.targets.has(cardEl())).forEach((o) => o.cb()))

  beforeEach(() => {
    frames = new Map()
    frameId = 0
    observers = []
    scrolls = []
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => (frames.set(++frameId, cb), frameId))
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
    vi.stubGlobal(
      "ResizeObserver",
      class {
        targets = new Set<Element>()
        constructor(readonly cb: () => void) {
          observers.push(this)
        }
        observe(t: Element) { this.targets.add(t) }
        unobserve() {}
        disconnect() { this.targets.clear() }
      },
    )
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const r = this.matches("[data-scroller]") ? { top: 0, height: VIEW } : this.matches("[data-testid=pending-ask]") ? card : { top: 0, height: 0 }
      return { ...r, bottom: r.top + r.height, left: 0, right: 0, width: 0, x: 0, y: r.top, toJSON() {} } as DOMRect
    })
  })

  it("moves between questions without scrolling, then shows a card taller than the chat from its top", () => {
    // Pinned to the chat's bottom: the card's end (Back, Next) shows, its question is a scroll above.
    card = { top: -150, height: 420 }
    render()
    layout()
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    const from = list().scrollTop
    click($("[data-testid=ask-next]")!)
    expect(progress()).toBe("2 of 3")
    // A focused control's own scrolling would move every scrolling box around it, the chat off its bottom included.
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true })
    expect(document.activeElement).toBe(radios()[0])
    expect(scrolls).toEqual([from - 150])
    // Already showing from its top: Back moves nothing.
    card = { top: 0, height: 420 }
    click($("[data-testid=ask-back]")!)
    nextFrame()
    nextFrame()
    expect(scrolls).toHaveLength(1)
  })

  it("leaves a card that fits where it is when it's all in view, and brings the rest of it in when it isn't", () => {
    card = { top: 20, height: 250 }
    render()
    layout()
    const from = list().scrollTop
    click($("[data-testid=ask-next]")!)
    // Checked two frames on, once a chat pinned to its bottom has followed the card's new height.
    nextFrame()
    nextFrame()
    expect(scrolls).toEqual([])
    card = { top: 100, height: 250 }
    click($("[data-testid=ask-next]")!)
    nextFrame()
    expect(scrolls).toEqual([])
    nextFrame()
    expect(scrolls).toEqual([from + 50])
  })

  it("as it opens at the chat's bottom, shows from its top, once the transcript is in", async () => {
    card = { top: -150, height: 420 }
    // The transcript still loading: its messages would count as new ones if the chat left its bottom now.
    qc.removeQueries({ queryKey: keys.taskMessages(taskId) })
    render()
    layout()
    expect(observers.some((o) => o.targets.has(cardEl()))).toBe(false)
    qc.setQueryData(keys.taskMessages(taskId), [])
    await flush()
    const from = list().scrollTop
    resized()
    expect(scrolls).toEqual([])
    // A frame on, after the chat's own observers followed its bottom.
    nextFrame()
    expect(scrolls).toEqual([from - 150])
    // Once.
    resized()
    nextFrame()
    expect(scrolls).toHaveLength(1)
  })

  it("never pulls a reader up in older messages back to it, nor moves once they touch the chat", () => {
    // Its end below the view: someone reading older messages as it came.
    card = { top: 120, height: 420 }
    render()
    layout()
    resized()
    nextFrame()
    expect(scrolls).toEqual([])
    // A finger on the chat: from here the scrolling is theirs.
    act(() => void list().dispatchEvent(new Event("pointerdown", { bubbles: true })))
    card = { top: -150, height: 420 }
    resized()
    nextFrame()
    expect(scrolls).toEqual([])
  })

  it("takes 16px text under a finger, so iOS doesn't zoom in on it, and holds Back and Next at the chat's bottom", () => {
    render()
    expect($("[data-testid=ask-custom]")!.className).toContain("pointer-coarse:text-base")
    expect($("[data-testid=ask-nav]")!.className).toContain("[@media(min-height:30rem)]:sticky")
  })
})
