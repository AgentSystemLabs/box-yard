// @vitest-environment happy-dom
// Highlighted text's two actions (SelectionToTask.tsx): "Ask" and "Create task". Create task opens the small popover on
// the passage and messages whoever creates the task, the project's Captain or the Coordinator; the browser never
// creates one itself. Ask and the threads it opens: side-threads-web.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SelectionToTask, type SelectionAsk } from "../web/src/components/SelectionToTask.js"
import { quotePreview } from "../web/src/components/NewTask.js"
import { keys } from "../web/src/lib/queries.js"
import { loadDraft, selectionScope } from "../web/src/lib/newTask.js"
import { resetDrafts } from "../web/src/lib/composerDraft.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import { closeThread, openThreadState, taskSlot } from "../web/src/lib/threads.js"
import { selectionTarget, selectionTargetProject, type SelectionTaskSource } from "../web/src/lib/selectionTask.js"
import type { Project, SettingsInfo } from "../shared/types"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECTS = [
  { id: "prj_zeta01", name: "zeta", repo: null, description: "", envKeys: [], notes: [] },
  { id: "prj_alpha1", name: "alpha", repo: null, description: "", envKeys: [], notes: [] },
] as unknown as Project[]

const OUTPUT = "The retry loop in server/sync.ts never backs off,\nso a dead remote spins the CPU."
const ALPHA = { id: "prj_alpha1", name: "alpha" }
const TASK: SelectionTaskSource = { kind: "task", project: ALPHA, task: { id: "task_sync01", title: "Fix the sync loop", branch: "fix-sync-loop", prUrl: "https://github.com/acme/site/pull/4" } }

let root: Root
let host: HTMLElement
let fetchMock: ReturnType<typeof vi.fn>

function render(source: SelectionTaskSource | null = { kind: "orchestrator", project: ALPHA }, extra: { askOn?: SelectionAsk | null; messageId?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.projects, PROJECTS)
  qc.setQueryData(keys.tasks, [])
  qc.setQueryData(keys.agentSettings, { settings: { ownerName: "Ada", agentModel: "claude-opus-5-5", agentEffort: "high" } } as unknown as SettingsInfo)
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          SelectionToTask,
          { source, ...("askOn" in extra && { askOn: extra.askOn }) },
          createElement("p", { "data-testid": "output", ...(extra.messageId && { "data-chat-id": extra.messageId }) }, OUTPUT),
        ),
      ),
    ),
  )
}

/** Select the whole output paragraph, as a drag would. */
function select() {
  const text = host.querySelector("[data-testid=output]")!.firstChild!
  const range = document.createRange()
  range.setStart(text, 0)
  range.setEnd(text, OUTPUT.length)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
  act(() => void document.dispatchEvent(new Event("selectionchange")))
}

/** The mouse's pill and the finger's bar, as their buttons read. */
const pill = () => [...document.querySelectorAll<HTMLButtonElement>("button[data-selection-task-action]")]
const bar = () => [...document.querySelectorAll<HTMLButtonElement>("[data-testid$=-bar]")]
const labels = (buttons: HTMLButtonElement[]) => buttons.map((b) => b.textContent!.trim())
const createTask = () => document.querySelector<HTMLButtonElement>("[data-testid=selection-task]")
const ask = () => document.querySelector<HTMLButtonElement>("[data-testid=selection-ask]")
const popover = () => document.querySelector<HTMLElement>("[role=dialog]:not([aria-modal])")
const modal = () => document.querySelector<HTMLElement>("[role=dialog][aria-modal=true]")
const textarea = () => popover()!.querySelector("textarea")!
const buttonStarting = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim().startsWith(label))!
const click = (el: HTMLElement) => act(() => el.click())
const press = (el: Element, key: string) => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  act(() => void el.dispatchEvent(e))
  return e
}
const type = (el: HTMLTextAreaElement, text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, text)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
const openPopover = () => {
  select()
  click(createTask()!)
}
/** What was POSTed to `path`, parsed. */
const posted = (path: string) =>
  fetchMock.mock.calls.filter(([url, init]) => url === path && (init as RequestInit | undefined)?.method === "POST").map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { id: string; content: string })
const posts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST").map(([url]) => String(url))
/** Let the send's optimistic steps (async) reach the request. */
const flush = () => act(() => new Promise((r) => setTimeout(r, 10)))

beforeEach(() => {
  history.replaceState(null, "", "/")
  sessionStorage.clear()
  resetDrafts()
  fetchMock = vi.fn(() => new Promise(() => {}))
  vi.stubGlobal("fetch", fetchMock)
  // happy-dom lays nothing out, so give the selected range a box for the action button to sit on.
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
  for (const t of currentToasts()) dismiss(t.id)
  closeThread(taskSlot("task_sync01"))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("the selection's actions", () => {
  it("are Ask and Create task, for a mouse (a pill) and a finger (a bar)", () => {
    render(TASK, { askOn: { chat: "prj_alpha1", slot: taskSlot("task_sync01"), anchorId: "task_sync01" } })
    expect(pill()).toEqual([])
    select()
    expect(labels(pill())).toEqual(["Ask", "Create task"])
    expect(labels(bar())).toEqual(["Ask", "Create task"])
    // The bar's buttons are finger-sized.
    for (const b of bar()) expect(b.className).toMatch(/\bmin-h-11\b/)
    // Pressing one keeps the selection and the focus where they are.
    for (const b of [...pill(), ...bar()]) {
      const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      b.dispatchEvent(down)
      expect(down.defaultPrevented).toBe(true)
    }
    expect(document.body.textContent).not.toMatch(/Reply quoting|New task from selection/)
  })

  it("is Create task alone where there's nowhere to ask (no chat with threads)", () => {
    render()
    select()
    expect(labels(pill())).toEqual(["Create task"])
    expect(ask()).toBeNull()
  })

  it("is Ask alone while what Create task would say isn't known yet", () => {
    render(null, { askOn: { chat: "prj_alpha1", anchorId: "task_sync01" } })
    select()
    expect(labels(pill())).toEqual(["Ask"])
  })

  it("Ask in a task's transcript opens a question on that task in its own panel's slot, nothing sent yet", () => {
    render(TASK, { askOn: { chat: "prj_alpha1", slot: taskSlot("task_sync01"), anchorId: "task_sync01" } })
    select()
    click(ask()!)
    expect(openThreadState(taskSlot("task_sync01"))).toMatchObject({ draft: { kind: "ask", anchorId: "task_sync01", text: OUTPUT } })
    // The Captain chat's own panel isn't where it shows.
    expect(openThreadState("prj_alpha1")).toBeNull()
    expect(pill()).toEqual([])
    expect(window.getSelection()!.isCollapsed).toBe(true)
    expect(posts()).toEqual([])
  })
})

describe("Create task from selected text", () => {
  it("opens the small popover with a quote preview and a box for the request, not the full dialog", () => {
    render()
    select()
    click(createTask()!)
    const dialog = popover()!
    expect(dialog).not.toBeNull()
    expect(modal()).toBeNull()
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)!.textContent).toBe("Create task")
    expect(dialog.querySelector("[data-testid=selection-quote]")!.textContent).toBe(quotePreview(OUTPUT))
    expect(textarea().placeholder).toBe("What should the task do? (optional)")
    expect(document.activeElement).toBe(textarea())
    // It only sends: there's no way from here to start a task in the browser.
    expect([...dialog.querySelectorAll("button")].map((b) => b.textContent!.trim())).toEqual(["Send to the Coordinator"])
    // The selection's actions go while its popover is open.
    expect(pill()).toEqual([])
  })

  it("from the Coordinator's chat, Enter messages the Coordinator with the request and the highlighted text", async () => {
    render({ kind: "orchestrator", project: ALPHA }, { messageId: "chat_reply01" })
    openPopover()
    type(textarea(), "Add exponential backoff with a cap")
    expect(press(textarea(), "Enter").defaultPrevented).toBe(true)
    expect(popover()).toBeNull()
    await flush()
    const [sent] = posted("/api/chat")
    expect(sent!.id).toMatch(/^chat_/)
    expect(sent!.content).toContain("Create a new task from Ada's request and the text Ada highlighted")
    expect(sent!.content).toContain("Put it in the project it belongs to.")
    expect(sent!.content).toContain("## Ada's request\nAdd exponential backoff with a cap")
    expect(sent!.content).toContain("- Project: alpha (prj_alpha1)")
    expect(sent!.content).toContain("- In this chat (the Coordinator's)")
    expect(sent!.content).toContain("- Message: chat_reply01")
    expect(sent!.content).toContain("## Highlighted text\n> The retry loop in server/sync.ts never backs off,\n> so a dead remote spins the CPU.")
    // One message to the chat, and no task created from the browser.
    expect(posts()).toEqual(["/api/chat"])
    expect(loadDraft(selectionScope(OUTPUT))).toBe("")
  })

  it("from a task's transcript it goes to the project's Captain, naming the task", async () => {
    render(TASK)
    openPopover()
    expect(buttonStarting("Send to ").textContent).toBe("Send to alpha's Captain")
    type(textarea(), "Split the backoff out")
    press(textarea(), "Enter")
    await flush()
    const [sent] = posted("/api/projects/prj_alpha1/captain/messages")
    expect(sent!.content).toContain("It belongs in this project unless the request says otherwise.")
    expect(sent!.content).toContain("## Ada's request\nSplit the backoff out")
    expect(sent!.content).toContain("- In the transcript of the task: Fix the sync loop (task_sync01)")
    expect(sent!.content).toContain("- That task's branch: fix-sync-loop")
    expect(sent!.content).toContain("- That task's pull request: https://github.com/acme/site/pull/4")
    expect(sent!.content).toContain("> so a dead remote spins the CPU.")
    expect(posts()).toEqual(["/api/projects/prj_alpha1/captain/messages"])
  })

  it("from a Captain's chat it goes to that Captain", async () => {
    render({ kind: "captain", project: ALPHA })
    openPopover()
    type(textarea(), "fix it")
    press(textarea(), "Enter")
    await flush()
    const [sent] = posted("/api/projects/prj_alpha1/captain/messages")
    expect(sent!.content).toContain("- In this chat (the project Captain's)")
    expect(posts()).toEqual(["/api/projects/prj_alpha1/captain/messages"])
  })

  it("with no request it still sends the highlighted text, and says there's none", async () => {
    render()
    openPopover()
    expect(buttonStarting("Send to ").disabled).toBe(false)
    press(textarea(), "Enter")
    await flush()
    const [sent] = posted("/api/chat")
    expect(sent!.content).toContain("## Highlighted text")
    expect(sent!.content).toContain("(Ada didn't write one: work out the task from the highlighted text.)")
  })

  it("confirms once it's sent, with a way to that chat", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return new Promise(() => {})
      const body = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ id: body.id, projectId: "prj_alpha1", role: "user", content: body.content, meta: null, createdAt: 1 }), { status: 200, headers: { "Content-Type": "application/json" } })
    })
    render(TASK)
    openPopover()
    type(textarea(), "Split the backoff out")
    expect(currentToasts()).toEqual([])
    press(textarea(), "Enter")
    await vi.waitFor(() => expect(currentToasts().length).toBe(1))
    const [t] = currentToasts()
    expect(t).toMatchObject({ kind: "info", title: "Sent to alpha's Captain", body: "It creates the task in alpha.", action: { label: "Open chat" } })
  })

  it("says nothing was sent when it fails", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === "POST" ? new Response(JSON.stringify({ error: "The Captain is off" }), { status: 500 }) : new Promise(() => {})))
    render(TASK)
    openPopover()
    press(textarea(), "Enter")
    await vi.waitFor(() => expect(currentToasts().length).toBe(1))
    expect(currentToasts()[0]).toMatchObject({ kind: "error" })
    expect(currentToasts()[0]!.title).not.toContain("Sent to")
  })

  it("Esc closes and keeps the request for the same selection", () => {
    render()
    openPopover()
    type(textarea(), "half-typed thought")
    press(textarea(), "Escape")
    expect(popover()).toBeNull()
    expect(posts()).toEqual([])
    expect(loadDraft(selectionScope(OUTPUT))).toBe("half-typed thought")
    openPopover()
    expect(textarea().value).toBe("half-typed thought")
  })

  it("a click outside closes and keeps the request", () => {
    render()
    openPopover()
    type(textarea(), "kept")
    act(() => void document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })))
    expect(popover()).toBeNull()
    expect(loadDraft(selectionScope(OUTPUT))).toBe("kept")
  })

  it("is a bottom sheet on phones", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} }))
    render()
    openPopover()
    const sheet = modal()!
    expect(sheet).not.toBeNull()
    expect(sheet.textContent).toContain("Create task")
    expect(sheet.querySelector("[data-testid=selection-quote]")).not.toBeNull()
  })
})

describe("selection task helpers", () => {
  it("quotePreview flattens whitespace and cuts long quotes with an ellipsis", () => {
    expect(quotePreview("a\n\n  b\tc")).toBe("a b c")
    const long = "word ".repeat(100)
    const p = quotePreview(long, 40)
    expect(p.length).toBeLessThanOrEqual(40)
    expect(p.endsWith("…")).toBe(true)
  })

  it("names where the prompt went", () => {
    expect(selectionTarget({ kind: "captain", project: ALPHA })).toBe("alpha's Captain")
    expect(selectionTarget({ kind: "orchestrator" })).toBe("the Coordinator")
    // A task's goes to its own project's Captain; only the Coordinator's chat goes to the Coordinator.
    expect(selectionTarget(TASK)).toBe("alpha's Captain")
    expect(selectionTargetProject(TASK)).toBe("prj_alpha1")
    expect(selectionTargetProject({ kind: "captain", project: ALPHA })).toBe("prj_alpha1")
    expect(selectionTargetProject({ kind: "orchestrator", project: ALPHA })).toBeNull()
  })

  it("keeps a draft per selection", () => {
    expect(selectionScope("one")).toBe(selectionScope("one"))
    expect(selectionScope("one")).not.toBe(selectionScope("two"))
  })
})
