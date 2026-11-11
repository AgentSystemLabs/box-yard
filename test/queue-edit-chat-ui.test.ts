// @vitest-environment happy-dom
// Queued messages in the Coordinator chat and the Captain tab: Edit swaps the bubble for an editor in place,
// Cancel takes it back into the message box with an Undo toast, and a refused change (already delivered) rolls back
// with a clear message. While a turn runs, Stop in the box ends it, and the chat shows it stopped from the click.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { CaptainTab } from "../web/src/components/CaptainTab.js"
import { keys } from "../web/src/lib/queries.js"
import { placeMessage } from "../web/src/lib/queued.js"
import { currentToasts as toasts, dismiss } from "../web/src/lib/toast.js"
import type { CaptainMessage, CaptainState, ChatMessage, Project, UiEvent } from "../shared/types"
import { resetDrafts } from "../web/src/lib/composerDraft.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const project = { id: "prj_demo01", name: "demo", description: "", repo: null, baseBranch: "main", envKeys: [], notes: [], createdAt: 0, updatedAt: 0 } as unknown as Project
const cap = (id: string, role: CaptainMessage["role"], content: string, createdAt: number, meta: Record<string, unknown> | null = null): CaptainMessage => ({
  id,
  projectId: project.id,
  role,
  content,
  meta,
  createdAt,
})
const captainState = (busy: boolean): CaptainState => ({ projectId: project.id, busy, usage: { tokens: null, window: null, updatedAt: null }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null })

let es: FakeEventSource | null = null
class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: unknown = null
  onopen: unknown = null
  constructor() {
    es = this
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

/** Requests the app made: method, path and body. */
let calls: { method: string; path: string; body: unknown }[] = []
/** Answer for a request; default: echo a fitting message. */
let reply: (method: string, path: string, body: any) => { status: number; data: unknown } | null = () => null

let root: Root
let host: HTMLElement
let qc: QueryClient

const flush = () => act(() => new Promise((r) => setTimeout(r, 40)))
const emit = async (...events: UiEvent[]) => {
  act(() => {
    for (const ev of events) es!.onmessage!({ data: JSON.stringify(ev) })
  })
  await flush()
}
const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy()
  act(() => (el as HTMLElement).click())
  await flush()
}
function typeInto(box: HTMLTextAreaElement, text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text)
    box.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
const editor = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Queued message"]')
const button = (label: string, scope: ParentNode = host) => scope.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const buttonByText = (text: string, scope: ParentNode = host) => [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)
/** The chat's message box (not a queued message's editor). */
const messageBox = (scope: ParentNode = host) => scope.querySelector<HTMLTextAreaElement>('textarea:not([aria-label="Queued message"])')!

beforeEach(() => {
  localStorage.clear()
  resetDrafts()
  for (const t of toasts()) dismiss(t.id)
  es = null
  calls = []
  reply = () => null
  vi.stubGlobal("EventSource", FakeEventSource)
  vi.stubGlobal("fetch", (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ method, path, body })
    const r = reply(method, path, body)
    if (r) return Promise.resolve(new Response(JSON.stringify(r.data), { status: r.status }))
    if (method !== "GET") return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
    return new Promise(() => {})
  })
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

function renderCaptain(messages: CaptainMessage[], state: CaptainState = captainState(true)) {
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  for (const k of [keys.tasks, keys.schedules, keys.artifacts, keys.boxes]) qc.setQueryData(k, [])
  qc.setQueryData(keys.projects, [project])
  qc.setQueryData(keys.captainCompactions(project.id), [])
  qc.setQueryData(keys.captain(project.id), state)
  qc.setQueryData(keys.captainMessages(project.id), messages)
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(CaptainTab, { project }))))
}
const inbound = () => [...host.querySelectorAll<HTMLElement>('[data-testid="captain-inbound"]')]
const captainList = () => qc.getQueryData<CaptainMessage[]>(keys.captainMessages(project.id))!

describe("Captain tab: queued messages", () => {
  const first = cap("cap_first00001", "user", "status?", now - 3000, { source: "cody" })
  const queued = cap("cap_queued0001", "user", "also check the docs", now - 1500, { source: "cody", queued: true })

  it("only queued messages get Edit and Cancel, beside the Queued label", () => {
    renderCaptain([first, queued])
    const [sent, waiting] = inbound()
    expect(button("Edit queued message", sent!)).toBeNull()
    expect(waiting!.querySelector("[data-testid=queued-label]")).not.toBeNull()
    expect(button("Edit queued message", waiting!)).not.toBeNull()
    expect(button("Cancel queued message", waiting!)).not.toBeNull()
  })

  it("edits in place: Save sends the new text and shows it at once", async () => {
    renderCaptain([first, queued])
    await click(button("Edit queued message"))
    const box = editor()!
    expect(box.value).toBe("also check the docs")
    // The editor takes the bubble's place; the Queued label stays, without the buttons.
    expect(inbound().at(-1)!.querySelector(".rounded-2xl")).toBeNull()
    expect(inbound().at(-1)!.querySelector("[data-testid=queued-label]")).not.toBeNull()
    expect(button("Edit queued message")).toBeNull()
    typeInto(box, "also check the docs and the changelog")
    await click(buttonByText("Save"))
    expect(calls.find((c) => c.method === "PATCH")).toEqual({ method: "PATCH", path: `/api/projects/${project.id}/captain/messages/cap_queued0001`, body: { text: "also check the docs and the changelog" } })
    expect(editor()).toBeNull()
    expect(inbound().at(-1)!.textContent).toContain("also check the docs and the changelog")
  })

  it("Escape cancels the edit without sending anything", async () => {
    renderCaptain([first, queued])
    await click(button("Edit queued message"))
    typeInto(editor()!, "something else")
    act(() => void editor()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))
    await flush()
    expect(editor()).toBeNull()
    expect(calls.some((c) => c.method === "PATCH")).toBe(false)
    expect(inbound().at(-1)!.textContent).toContain("also check the docs")
  })

  it("Cancel takes it back into the box, ahead of the draft; Undo queues it again and takes it out", async () => {
    renderCaptain([first, queued])
    typeInto(messageBox(), "and the README")
    await click(button("Cancel queued message"))
    expect(calls.find((c) => c.method === "DELETE")?.path).toBe(`/api/projects/${project.id}/captain/messages/cap_queued0001`)
    expect(inbound()).toHaveLength(1)
    expect(messageBox().value).toBe("also check the docs\n\nand the README")
    expect(document.activeElement).toBe(messageBox())
    const t = toasts().find((x) => x.title === "Message cancelled")!
    expect(t.body).toBe("It's back in the message box.")
    expect(t.action?.label).toBe("Undo")
    act(() => t.action!.onClick())
    await flush()
    expect(calls.find((c) => c.method === "POST")?.path).toBe(`/api/projects/${project.id}/captain/messages/cap_queued0001/restore`)
    expect(inbound()).toHaveLength(2)
    expect(inbound().at(-1)!.querySelector("[data-testid=queued-label]")).not.toBeNull()
    expect(messageBox().value).toBe("and the README")
  })

  it("a refused cancel (already delivered) keeps it queued and takes the text out of the box again", async () => {
    reply = (method) => (method === "DELETE" ? { status: 409, data: { error: "That message was already delivered to the Captain, so it can't be changed." } } : null)
    renderCaptain([first, queued])
    await click(button("Cancel queued message"))
    await flush()
    expect(messageBox().value).toBe("")
    expect(captainList().find((m) => m.id === queued.id)?.meta?.queued).toBe(true)
    expect(toasts().find((x) => x.title === "Couldn't cancel the message")?.body).toMatch(/already delivered/)
  })

  it("Stop in the box stops the Captain's turn and shows it idle from the click; a queued turn after it shows busy again", async () => {
    reply = (method, path) => (path.endsWith("/captain/stop") ? { status: 200, data: { ok: true, stopped: true } } : null)
    renderCaptain([first, queued])
    expect(host.querySelector("[data-testid=captain-working]")).not.toBeNull()
    const stop = button("Stop the Captain's turn")!
    expect(stop.nextElementSibling?.getAttribute("aria-label")).toBe("Send")
    await click(stop)
    expect(calls).toContainEqual({ method: "POST", path: `/api/projects/${project.id}/captain/stop`, body: undefined })
    expect(button("Stop the Captain's turn")).toBeNull()
    expect(host.querySelector("[data-testid=captain-working]")).toBeNull()
    // The live stream's copies (CaptainTab alone has no stream to hear them on).
    act(() => qc.setQueryData(keys.captain(project.id), captainState(true)))
    await flush()
    expect(button("Stop the Captain's turn")).not.toBeNull()
    // The server's stopped line is a quiet one, not a red error.
    act(() => qc.setQueryData<CaptainMessage[]>(keys.captainMessages(project.id), (l) => [...l!, cap("cap_stopped001", "error", "Stopped by Cody.", now, { stopped: true })]))
    await flush()
    expect(host.querySelector("[data-testid=chat-stopped]")?.textContent).toBe("Stopped by Cody.")
    // Nothing red but the Stop button's own square (the Captain's busy again, so Stop is back).
    expect([...host.querySelectorAll(".text-red-300")].filter((el) => !el.closest(`button[aria-label="Stop the Captain's turn"]`))).toEqual([])
  })

  it("has no Stop while idle or compacting (a compaction finishes)", () => {
    renderCaptain([first], captainState(false))
    expect(button("Stop the Captain's turn")).toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    renderCaptain([first], { ...captainState(true), compacting: true })
    expect(button("Stop the Captain's turn")).toBeNull()
  })

  it("a refused edit (already delivered) rolls back and says why", async () => {
    reply = (method) => (method === "PATCH" ? { status: 409, data: { error: "That message was already delivered to the Captain, so it can't be changed." } } : null)
    renderCaptain([first, queued])
    await click(button("Edit queued message"))
    typeInto(editor()!, "too late")
    await click(buttonByText("Save"))
    await flush()
    expect(captainList().find((m) => m.id === queued.id)?.content).toBe("also check the docs")
    expect(toasts().find((x) => x.title === "Couldn't save the edit")?.body).toMatch(/already delivered/)
  })

  it("delivered while being edited: the editor goes and a toast says the edit wasn't saved", async () => {
    renderCaptain([first, queued])
    await click(button("Edit queued message"))
    typeInto(editor()!, "half-typed edit")
    act(() => qc.setQueryData<CaptainMessage[]>(keys.captainMessages(project.id), (l) => placeMessage(l!, { ...queued, createdAt: now - 500, meta: { source: "cody", queuedAt: queued.createdAt } })))
    await flush()
    expect(editor()).toBeNull()
    expect(toasts().find((x) => x.title === "Already delivered")?.body).toMatch(/^The Captain got the message as it was/)
  })
})

describe("Coordinator chat: queued messages", () => {
  const msg = (id: string, role: ChatMessage["role"], content: string, createdAt: number, meta: Record<string, unknown> | null = null): ChatMessage => ({ id, role, content, meta, createdAt })

  function renderChat(messages: ChatMessage[]) {
    history.replaceState(null, "", "/")
    qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
    qc.setQueryData(keys.me, { authed: true, authRequired: false })
    qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: true, scheduler: "local" })
    qc.setQueryData(keys.orchestrator, { busy: true, usage: { tokens: null, window: null, updatedAt: null }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null })
    qc.setQueryData(keys.chat, messages)
    qc.setQueryData(keys.chatBusy, true)
    qc.setQueryData(keys.chatStream, "Here is a long reply that is still")
    for (const k of [keys.tasks, keys.projects, keys.artifacts, keys.schedules, keys.boxes, keys.notifications]) qc.setQueryData(k, [])
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
  }
  const panel = () => document.querySelector<HTMLElement>("[data-testid=chat-panel]")!

  it("edit, cancel and Undo under the streaming reply; the live stream's copy wins", async () => {
    const queued = msg("chat_queued001", "user", "k it works perfect", now - 1500, { queued: true })
    renderChat([msg("chat_ask000001", "user", "Build the thing", now - 3000), queued])
    expect(panel().querySelectorAll('button[aria-label="Edit queued message"]')).toHaveLength(1)

    await click(button("Edit queued message", panel()))
    typeInto(editor()!, "k it works perfect, ship it")
    await click(buttonByText("Save", panel()))
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ path: "/api/chat/messages/chat_queued001", body: { text: "k it works perfect, ship it" } })
    expect(panel().textContent).toContain("k it works perfect, ship it")
    // The server's broadcast of the same message changes nothing visible.
    await emit({ type: "chat.message", message: { ...queued, content: "k it works perfect, ship it" } })
    expect(panel().textContent).toContain("k it works perfect, ship it")

    await click(button("Cancel queued message", panel()))
    expect(calls.find((c) => c.method === "DELETE")?.path).toBe("/api/chat/messages/chat_queued001")
    expect(panel().querySelector("[data-testid=queued-label]")).toBeNull()
    // Back in the Coordinator's box, to fix and send again.
    expect(messageBox(panel()).value).toBe("k it works perfect, ship it")
    act(() => toasts().find((x) => x.title === "Message cancelled")!.action!.onClick())
    await flush()
    expect(calls.find((c) => c.method === "POST")?.path).toBe("/api/chat/messages/chat_queued001/restore")
    expect(panel().textContent).toContain("k it works perfect, ship it")
    expect(panel().querySelector("[data-testid=queued-label]")).not.toBeNull()
    expect(messageBox(panel()).value).toBe("")
  })

  it("Stop in the box stops the Coordinator's turn: its streamed text goes, and the stopped line is a quiet one", async () => {
    reply = (method, path) => (path === "/api/chat/stop" ? { status: 200, data: { ok: true, stopped: true } } : null)
    renderChat([msg("chat_ask000001", "user", "Build the thing", now - 3000)])
    expect(panel().querySelector('button[title="Stop"]')).toBeNull()
    expect(panel().textContent).toContain("Here is a long reply that is still")
    await click(button("Stop the Coordinator's turn", panel()))
    expect(calls).toContainEqual({ method: "POST", path: "/api/chat/stop", body: undefined })
    expect(button("Stop the Coordinator's turn", panel())).toBeNull()
    expect(panel().textContent).not.toContain("Here is a long reply that is still")
    await emit({ type: "chat.message", message: msg("chat_stopped01", "error", "Stopped by Cody.", now, { stopped: true }) })
    expect(panel().querySelector("[data-testid=chat-stopped]")?.textContent).toBe("Stopped by Cody.")
    expect(panel().querySelector(".text-red-300")).toBeNull()
  })

  it("a stop that found nothing to stop (it had just ended) brings back the server's word", async () => {
    reply = (method, path) => (path === "/api/chat/stop" ? { status: 200, data: { ok: true, stopped: false } } : path === "/api/health" ? { status: 200, data: { ok: true, orchestratorBusy: true } } : null)
    renderChat([msg("chat_ask000001", "user", "Build the thing", now - 3000)])
    await click(button("Stop the Coordinator's turn", panel()))
    await flush()
    expect(calls.some((c) => c.method === "GET" && c.path === "/api/health")).toBe(true)
  })

  it("has no Stop while the Coordinator compacts", async () => {
    renderChat([msg("chat_ask000001", "user", "Build the thing", now - 3000)])
    expect(button("Stop the Coordinator's turn", panel())).not.toBeNull()
    act(() => qc.setQueryData(keys.orchestrator, { busy: true, usage: { tokens: null, window: null, updatedAt: null }, compacting: true, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null }))
    await flush()
    expect(button("Stop the Coordinator's turn", panel())).toBeNull()
  })
})
