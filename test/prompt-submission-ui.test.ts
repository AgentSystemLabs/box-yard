// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement as h, useRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { keys, useChat, useCaptainMessages, useSendChat, useSendCaptainMessage, useSendTaskMessage } from "../web/src/lib/queries.js"
import { useServerEvents } from "../web/src/lib/stream.js"
import { TaskThread } from "../web/src/components/TaskView.js"
import { ChatLine } from "../web/src/components/ChatLine.js"
import { InboundMessage } from "../web/src/components/CaptainTab.js"
import { ThreadChatProvider } from "../web/src/components/SideThread.js"
import { COORDINATOR_CHAT } from "../web/src/lib/threads.js"
import { Composer } from "../web/src/components/Composer.js"
import { readDraft, resetDrafts, setDraftFiles } from "../web/src/lib/composerDraft.js"
import { currentToasts } from "../web/src/lib/toast.js"
import type { Attachment, CaptainState, ChatMessage, QueuedMessage, Task, TaskMessage, UiEvent } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock("../web/src/lib/sendSound.js", async (load) => ({ ...(await load<typeof import("../web/src/lib/sendSound.js")>()), playSendSound: () => true, primeSendSound: () => {} }))

const TASK = "task_example01", PROJECT = "prj_example01"
type Scope = "task" | "subtask" | "captain" | "coordinator"
const noop = () => {}
class Events {
  static last: Events
  onmessage: ((e: { data: string }) => void) | null = null
  onerror = null
  onopen = null
  constructor() { Events.last = this }
  addEventListener() {}
  close() {}
}
let root: Root, host: HTMLElement, qc: QueryClient, scope: Scope
let posts: { body: { id: string; content: string }; answer: (body: unknown, status?: number) => void }[]
let serverMessages: unknown[], serverQueue: QueuedMessage[]
let getMessages: (() => Promise<Response>) | undefined
const task = (patch: Partial<Task> = {}): Task => ({ id: TASK, projectId: PROJECT, title: "Example", status: "idle", pendingCount: 0, queueRev: "", compacting: false, compactPending: false, agentCli: "codex", updatedAt: 1, ...patch }) as Task
const captain = (busy: boolean): CaptainState => ({ projectId: PROJECT, busy, compacting: false, compactQueued: false, error: null }) as CaptainState
const messageKey = () => scope === "coordinator" ? keys.chat : scope === "captain" ? keys.captainMessages(PROJECT) : keys.taskMessages(TASK)
const draftKey = () => scope === "coordinator" ? "coordinator" : scope === "captain" ? `captain:${PROJECT}` : `task:${TASK}`
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 40)) })
const emit = async (...events: UiEvent[]) => { act(() => events.forEach((e) => Events.last.onmessage!({ data: JSON.stringify(e) }))); await flush() }
const stored = (index = 0, queued = false) => ({ id: posts[index]!.body.id, role: "user" as const, content: posts[index]!.body.content, createdAt: Date.now(), meta: { ...(scope === "captain" ? { source: "cody" } : {}), ...(queued ? { queued: true } : {}) }, ...(scope === "captain" ? { projectId: PROJECT } : {}) })
const delivered = (index = 0): TaskMessage => ({ ...stored(index), id: `tm_delivery${index}`, taskId: TASK, meta: { source: "cody", clientMessageId: posts[index]!.body.id, queuedAt: 1 } })
const queueRow = (index = 0): QueuedMessage => ({ id: `in_example${index}`, clientMessageId: posts[index]!.body.id, taskId: TASK, source: "cody", sender: "Owner", kind: "owner", text: posts[index]!.body.content, attachments: [], status: "queued", version: 1, createdAt: Date.now(), updatedAt: Date.now() })
const messageEvent = (m: any): UiEvent => scope === "coordinator" ? { type: "chat.message", message: m } : scope === "captain" ? { type: "captain.message", message: m } : { type: "task.message", message: m }
const busyEvent = (busy: boolean): UiEvent => scope === "coordinator" ? { type: "chat.busy", busy } : scope === "captain" ? { type: "captain.state", state: captain(busy) } : { type: "task", task: task({ status: busy ? "working" : "idle", queueRev: busy ? "1" : "" }) }

function Harness() {
  useServerEvents(true)
  const panel = useRef<HTMLElement>(null)
  // Scope is fixed for each mount. The actual row components and task transcript render the cached submissions.
  const send = scope === "coordinator" ? useSendChat() : scope === "captain" ? useSendCaptainMessage(PROJECT) : useSendTaskMessage(TASK)
  const messages = scope === "coordinator" ? useChat() : scope === "captain" ? useCaptainMessages(PROJECT) : null
  return h(ThreadChatProvider, { value: scope === "coordinator" ? COORDINATOR_CHAT : scope === "captain" ? PROJECT : null }, h("section", { ref: panel },
    messages ? messages.data?.map((m) => scope === "captain" ? h(InboundMessage, { key: m.id, m: m as any }) : h(ChatLine, { key: m.id, m, onFollowUp: noop }))
      : h(TaskThread, { id: TASK, handle: null, working: null, selectionSource: null, selectionAsk: null, onFollowUp: noop }),
    h(Composer, { panelRef: panel, placeholder: "Send feedback", draftKey: draftKey(), onSubmit: (content: string, attachments: Attachment[]) => send.mutateAsync({ id: `chat_${crypto.randomUUID()}`, content, attachments }) }),
  ))
}
function mount(kind: Scope, busy = false) {
  scope = kind
  qc.setQueryData(keys.tasks, [task({ status: busy ? "working" : "idle", ...(kind === "subtask" ? { parentTaskId: "task_parent01" } : {}) })])
  qc.setQueryData(keys.chatBusy, busy)
  qc.setQueryData(keys.orchestrator, { busy })
  qc.setQueryData(keys.captain(PROJECT), captain(busy))
  qc.setQueryData(messageKey(), [])
  qc.setQueryData(keys.taskQueue(TASK), [])
  act(() => root.render(h(QueryClientProvider, { client: qc }, h(Harness))))
}
const type = (value: string) => act(() => {
  const field = host.querySelector<HTMLTextAreaElement>('textarea[placeholder="Send feedback"]')!
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value)
  field.dispatchEvent(new Event("input", { bubbles: true }))
})
const send = async (text = "Follow this up") => {
  type(text)
  act(() => void host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
  await flush()
}
const queued = () => host.querySelector('[data-testid="queued-label"], [data-testid="queued-message"]')
const lines = () => qc.getQueryData<(ChatMessage | TaskMessage)[]>(messageKey())!

beforeEach(() => {
  resetDrafts()
  posts = []; serverMessages = []; serverQueue = []; getMessages = undefined
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } } })
  for (const key of [keys.projects, keys.artifacts, keys.schedules, keys.boxes]) qc.setQueryData(key, [])
  vi.stubGlobal("EventSource", Events)
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    if (init.method === "POST") return new Promise<Response>((resolve) => posts.push({ body: JSON.parse(String(init.body)), answer: (body, status = 200) => resolve(json(body, status)) }))
    if (url.endsWith("/queue")) return Promise.resolve(json(serverQueue))
    if (url === "/api/chat" || url.endsWith("/messages")) return getMessages ? getMessages() : Promise.resolve(json(serverMessages))
    return new Promise(() => {})
  })
  host = document.createElement("div"); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); qc.clear(); host.remove(); vi.unstubAllGlobals() })

for (const kind of ["task", "subtask", "captain", "coordinator"] as const) describe(`${kind} submissions`, () => {
  it("renders an idle send at full strength immediately, through HTTP acceptance and SSE delivery", async () => {
    mount(kind)
    await send()
    expect(posts).toHaveLength(1)
    expect(queued()).toBeNull()
    const bubble = host.querySelector('[aria-busy="true"]')!
    expect(bubble.textContent).toContain("Follow this up")
    expect(bubble.className).not.toMatch(/opacity-/)
    expect(host.querySelector('[data-testid="message-reply"]')).toBeNull()
    expect(qc.getQueryData<Task[]>(keys.tasks)![0]!.status).toBe("idle")
    expect(qc.getQueryData(keys.chatBusy)).toBe(false)
    expect(qc.getQueryData<CaptainState>(keys.captain(PROJECT))?.busy).toBe(false)
    const m = kind === "task" || kind === "subtask" ? delivered() : stored()
    serverQueue = kind === "task" || kind === "subtask" ? [{ ...queueRow(), status: "delivering" }] : []
    await act(async () => posts[0]!.answer(kind === "task" || kind === "subtask" ? { ...task({ status: "queued" }), inputId: serverQueue[0]!.id } : m))
    await flush()
    expect(queued()).toBeNull()
    serverMessages = [m]
    await emit(messageEvent(m))
    expect(queued()).toBeNull()
    expect(lines()).toHaveLength(1)
    expect(host.contains(bubble)).toBe(true)
    expect(bubble.hasAttribute("aria-busy")).toBe(false)
    if (kind === "captain" || kind === "coordinator") expect(host.querySelector('[data-testid="message-reply"]')).not.toBeNull()
  })

  it("keeps genuine busy sends queued, with actions only after storage is confirmed", async () => {
    mount(kind, true)
    await send()
    expect(queued()).not.toBeNull()
    expect(host.querySelector('[aria-label="Edit queued message"]')).toBeNull()
    serverQueue = [queueRow()]
    const m = stored(0, true)
    serverMessages = [m]
    await act(async () => posts[0]!.answer(kind === "task" || kind === "subtask" ? { ...task({ status: "working" }), inputId: serverQueue[0]!.id } : m))
    await flush()
    expect(host.querySelector('[aria-label="Edit queued message"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Cancel queued message"]')).not.toBeNull()
  })

  it("keeps the newer SSE delivery over a late queued HTTP response and a stale history fetch", async () => {
    mount(kind, true)
    await send()
    let answer!: (r: Response) => void
    getMessages = () => new Promise<Response>((r) => answer = r)
    const fetching = qc.refetchQueries({ queryKey: messageKey() })
    await flush()
    const m = kind === "task" || kind === "subtask" ? delivered() : { ...stored(), meta: { ...stored().meta, queuedAt: 1 } }
    await emit(messageEvent(m), busyEvent(false))
    await act(async () => posts[0]!.answer(kind === "task" || kind === "subtask" ? { ...task({ status: "working" }), inputId: queueRow().id } : stored(0, true)))
    await flush()
    await act(async () => { answer(json([])); await fetching })
    expect(lines()).toEqual([m])
    expect(queued()).toBeNull()
    if (kind === "task" || kind === "subtask") expect(qc.getQueryData<Task[]>(keys.tasks)![0]!.status).toBe("idle")
  })

  it("keeps a pending send through refetch and removes it on failure even if a stale fetch finishes later", async () => {
    mount(kind)
    await send()
    await act(async () => qc.refetchQueries({ queryKey: messageKey() }))
    expect(lines()).toHaveLength(1)
    expect(lines()[0]!.meta?.pending).toBe(true)
    let answer!: (r: Response) => void
    getMessages = () => new Promise<Response>((r) => answer = r)
    const fetching = qc.refetchQueries({ queryKey: messageKey() })
    await flush()
    await act(async () => posts[0]!.answer({ error: "Unavailable" }, 503))
    await flush()
    await act(async () => { answer(json([])); await fetching })
    expect(lines()).toHaveLength(0)
    expect(readDraft(draftKey()).text).toBe("Follow this up")
  })

  it("a failed first send cannot erase a second identical send or its SSE echo", async () => {
    mount(kind)
    await send("same words"); await send("same words")
    expect(posts[0]!.body.id).not.toBe(posts[1]!.body.id)
    const m = kind === "task" || kind === "subtask" ? delivered(1) : stored(1)
    await emit(messageEvent(m), busyEvent(true))
    await act(async () => posts[0]!.answer({ error: "Try again" }, 503))
    await flush()
    expect(lines()).toEqual([m])
    expect(qc.getQueryData(keys.chatBusy)).toBe(kind === "coordinator")
    await act(async () => posts[1]!.answer(kind === "task" || kind === "subtask" ? task({ status: "working" }) : m))
    await flush()
    expect(lines()).toEqual([m])
  })

  it("restores failed text and attachments for retry; confirmed SSE storage survives a lost HTTP response", async () => {
    mount(kind)
    const attachment = { id: "upload_example01", name: "notes.txt", mime: "text/plain", size: 3 }
    act(() => setDraftFiles(draftKey(), [{ key: 1, ...attachment, preview: null, status: "done", attachment }]))
    await send()
    expect(readDraft(draftKey()).text).toBe("")
    await act(async () => posts[0]!.answer({ error: "Runner unavailable" }, 409))
    await flush()
    expect(lines()).toHaveLength(0)
    expect(readDraft(draftKey()).text).toBe("Follow this up")
    expect(readDraft(draftKey()).files[0]!.attachment).toEqual(attachment)
    expect(currentToasts().some((t) => t.body.includes("Runner unavailable"))).toBe(true)
    await send()
    const m = kind === "task" || kind === "subtask" ? delivered(1) : stored(1)
    await emit(messageEvent(m))
    await act(async () => posts[1]!.answer({ error: "Response lost" }, 502))
    await flush()
    expect(lines()).toEqual([m])
    expect(readDraft(draftKey()).text).toBe("")
    expect(readDraft(draftKey()).files).toHaveLength(0)
  })
})

it("discovers a genuine task scheduler wait after the optimistic idle send", async () => {
  mount("task")
  await send()
  expect(queued()).toBeNull()
  serverQueue = [queueRow()]
  await emit({ type: "task", task: task({ status: "queued", waitReason: "Waiting for a free slot", queueRev: "1" }) })
  expect(queued()).not.toBeNull()
  expect(host.textContent?.match(/Follow this up/g)).toHaveLength(1)
  await act(async () => posts[0]!.answer({ ...task({ status: "queued" }), inputId: serverQueue[0]!.id }))
  await flush()
  expect(queued()).not.toBeNull()
})

for (const kind of ["task", "subtask"] as const) it(`${kind}: rapid sends left behind by a starting turn become actionable queue rows`, async () => {
  mount(kind)
  await send("first"); await send("second")
  expect(queued()).toBeNull()
  const first = delivered(0)
  serverQueue = [queueRow(1)]
  // The runner claims inputs before launch; another prompt can arrive after that claim but before working.
  await emit(messageEvent(first), busyEvent(true))
  expect(lines().find((m) => m.content === "first")).toEqual(first)
  expect(lines().find((m) => m.content === "second")).toBeUndefined()
  expect(queued()).not.toBeNull()
  serverMessages = [first]
  await act(async () => posts[1]!.answer({ ...task({ status: "working" }), inputId: serverQueue[0]!.id }))
  await flush()
  expect(host.querySelector('[aria-label="Edit queued message"]')).not.toBeNull()
  expect(host.textContent?.match(/first/g)).toHaveLength(1)
  expect(host.textContent?.match(/second/g)).toHaveLength(1)
  await act(async () => posts[0]!.answer({ ...task({ status: "queued" }), inputId: queueRow(0).id }))
  await flush()
  expect(queued()).not.toBeNull()
})

it("corrects a stale idle prediction when HTTP confirms an already running task", async () => {
  mount("task")
  await send()
  serverQueue = [queueRow()]
  await act(async () => posts[0]!.answer({ ...task({ status: "working" }), inputId: serverQueue[0]!.id }))
  await flush()
  expect(queued()).not.toBeNull()
  expect(lines()).toHaveLength(0)
})

it("a task wait leaves an independently pending Captain forward alone", async () => {
  mount("task")
  const forward = { id: "tmp-forward", taskId: TASK, role: "event", content: "Ask the Captain", createdAt: 1, meta: { pending: true, kind: "to_captain" } }
  act(() => qc.setQueryData(keys.taskMessages(TASK), [forward]))
  await send()
  await emit(busyEvent(true))
  expect(lines()).toEqual([forward])
  await act(async () => posts[0]!.answer({ error: "Unavailable" }, 503))
  await flush()
})

for (const state of [{ waitReason: "Waiting for a free slot" }, { compacting: true }, { compactPending: true }]) it(`keeps task sends queued for ${JSON.stringify(state)}`, async () => {
  mount("task")
  act(() => qc.setQueryData(keys.tasks, [task(state)]))
  await send()
  expect(queued()).not.toBeNull()
  expect(lines()).toHaveLength(0)
})

for (const kind of ["captain", "coordinator"] as const) it(`${kind}: a fresh idle signal outranks an earlier unacknowledged send`, async () => {
  mount(kind, true)
  await send("first")
  await emit(busyEvent(false))
  await send("second")
  expect(lines().find((m) => m.content === "second")?.meta?.queued).toBeUndefined()
})

it("two failed idle sends leave no invented queued task state", async () => {
  mount("task")
  await send("first"); await send("second")
  await act(async () => posts[0]!.answer({ error: "Unavailable" }, 503))
  await flush()
  await act(async () => posts[1]!.answer({ error: "Unavailable" }, 503))
  await flush()
  expect(lines()).toHaveLength(0)
  expect(qc.getQueryData<QueuedMessage[]>(keys.taskQueue(TASK))).toEqual([])
  expect(qc.getQueryData<Task[]>(keys.tasks)![0]!.status).toBe("idle")
})
