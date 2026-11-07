// @vitest-environment happy-dom
// The centre keeps the last chats you left mounted, hidden (lib/keptChats.ts), so going back to one only shows it.
// At most two, one on a phone with little memory, none with the JS heap nearly full, and none once the tab is hidden.
// A hidden chat renders nothing while it waits, whatever comes in: a stand-in for React DevTools logs every component
// each commit renders, and none may be in a hidden chat.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { seedRecentCaptains } from "../web/src/lib/captainPrefetch.js"
import { KEEP_CHATS, keepLimit } from "../web/src/lib/keptChats.js"
import { forgetCaptainTail, keys } from "../web/src/lib/queries.js"
import { composerJumpTarget } from "../web/src/lib/shortcuts.js"
import { setChatProjectFilter } from "../web/src/lib/projectBar.js"
import { resetScrollMemory } from "../web/src/lib/scrollMemory.js"
import type { CaptainMessage, CaptainState, ChatMessage, Project, Task } from "../shared/types"
import { APP_HOME } from "../web/src/lib/navigation.js"

// Every component that renders in a centre chat, as "<chat key>:<shown|hidden>:<component>". React tells React DevTools
// about each commit; this stands in for DevTools and walks the parts of the tree that commit rendered, the way its
// "highlight updates" does. (A <Profiler> can't see into a hidden tree: React skips its onRender there.)
const renders = vi.hoisted(() => {
  type Fiber = { tag: number; key: string | null; type: unknown; flags: number; memoizedProps: { mode?: string } | null; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null }
  const log: string[] = []
  const PERFORMED_WORK = 1
  const COMPONENT = new Set([0, 1, 11, 14, 15]) // function, class, forwardRef, memo, simple memo
  const name = (t: unknown): string => {
    const c = t as { displayName?: string; name?: string; type?: unknown; render?: unknown } | null
    return c?.displayName || c?.name || (c?.type ? name(c.type) : c?.render ? name(c.render) : "?")
  }
  const walk = (fiber: Fiber, chat: string | null, hidden: boolean) => {
    if (fiber.tag === 31) chat = fiber.key
    if (fiber.tag === 22) hidden = fiber.memoizedProps?.mode === "hidden"
    if (chat && COMPONENT.has(fiber.tag) && fiber.flags & PERFORMED_WORK) log.push(`${chat}:${hidden ? "hidden" : "shown"}:${name(fiber.type)}`)
    // A subtree this commit didn't touch still has its children from before.
    if (fiber.alternate && fiber.child === fiber.alternate.child) return
    for (let c = fiber.child; c; c = c.sibling) walk(c, chat, hidden)
  }
  ;(globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot: (_id: number, root: { current: Fiber }) => walk(root.current, null, false),
  }
  return log
})
/** What rendered in one chat (its centre key), while hidden or shown. */
const rendered = (key: string, how: "hidden" | "shown") => renders.filter((r) => r.startsWith(`${key}:${how}:`))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const project = (id: string, name: string) => ({ id, name, repo: null, description: "", notes: [], envKeys: [], baseBranch: "main", runner: "box", identityId: "idn_default", gpuMachine: { gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null }, docker: { image: null, dockerfile: null }, createdAt: now, color: null }) as unknown as Project
const state = (projectId: string): CaptainState => ({ projectId, busy: false, usage: { tokens: 0, window: 1_000_000, updatedAt: now }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null })
const message = (projectId: string, id: string, content: string, ago = 1000): CaptainMessage => ({ id, projectId, role: "assistant", content, meta: null, createdAt: now - ago })

const YARD = project("prj_yard01", "box-yard")
const SITE = project("prj_site01", "marketing-site")
const COLD = project("prj_cold01", "cold-project")
const DOCS = project("prj_docs01", "docs-site")
const PROJECTS = [YARD, SITE, COLD, DOCS]
// In marketing-site's conversation: none of it may reach web storage, kept or not.
const SECRET = "sk-site-secret-71c2"
// A working task each, so every project has its own group in the sidebar.
const task = (id: string, projectId: string) =>
  ({ id, projectId, title: `Task ${id}`, status: "working", prompt: "Do it.", boxId: null, sessionId: "s", branch: null, prUrl: null, prState: null, prMergedAt: null, previews: [], waitFor: [], question: null, summary: null, error: null, waitReason: null, turnCount: 1, pendingCount: 0, scheduleId: null, outcome: null, contextTokens: null, contextWindow: null, model: null, effort: null, createdAt: now - 60_000, updatedAt: now - 60_000 }) as unknown as Task
const TASKS = PROJECTS.map((p) => task(`task_${p.id.slice(4)}`, p.id))
const COORDINATOR: ChatMessage[] = [{ id: "msg_1", role: "assistant", content: "Morning.", meta: null, createdAt: now - 1000 }]

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
let qc: QueryClient

function render() {
  history.replaceState(null, "", APP_HOME)
  resetScrollMemory()
  sessionStorage.setItem("box-yard:landed", "1")
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.agentSettings, { settings: { ...DEFAULT_SETTINGS, ownerName: "Cody" }, sources: {}, defaults: DEFAULT_SETTINGS })
  qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.orchestrator, { busy: false, usage: { tokens: 1000, window: 1_000_000, updatedAt: now }, compacting: false, compactQueued: false, lastCompaction: null, compactionsDir: "", error: null })
  qc.setQueryData(keys.chat, COORDINATOR)
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, TASKS)
  qc.setQueryData(keys.projects, PROJECTS)
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications, keys.scheduleRuns]) qc.setQueryData(k, [])
  for (const p of PROJECTS) qc.setQueryData(keys.captain(p.id), state(p.id))
  for (const p of [YARD, COLD, DOCS]) qc.setQueryData(keys.captainMessages(p.id), [message(p.id, `cm_${p.id}`, `${p.name} here.`)])
  // marketing-site as the prefetch leaves it: its newest messages, with more to load once its chat is shown.
  seedRecentCaptains(qc, [{ projectId: SITE.id, state: state(SITE.id), messages: [message(SITE.id, "cm_site01", `The launch plan uses ${SECRET}.`)], more: true, threads: [] }])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
}

const nav = () => document.querySelector<HTMLElement>("nav[aria-label='Projects and tasks']")!
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
const open = (p: Project) => click(nav().querySelector(`[data-open-captain='${p.id}']`)!)
const openCoordinator = () => click([...nav().querySelectorAll("button")].find((b) => b.textContent?.startsWith("Coordinator"))!)
/** Each Captain's chat in the page, by project name, and the Coordinator's. */
const captainChat = (p: Project) =>
  [...document.querySelectorAll<HTMLElement>("[data-testid=captain-chat]")].find((c) => c.querySelector("[data-testid=chat-title]")?.textContent === `${p.name} Captain`)
const coordinatorChat = () => document.querySelector<HTMLElement>("[data-testid=chat-panel]")
const isHidden = (el: HTMLElement | null | undefined) => el?.style.display === "none"
/** What the centre has: the chat shown, and the ones kept hidden behind it. */
function centre() {
  const all = [...PROJECTS.map((p) => [p.name, captainChat(p)] as const), ["Coordinator", coordinatorChat()] as const].filter(([, el]) => el)
  return { shown: all.filter(([, el]) => !isHidden(el)).map(([n]) => n), hidden: all.filter(([, el]) => isHidden(el)).map(([n]) => n).sort() }
}
const storage = () => JSON.stringify([{ ...localStorage }, { ...sessionStorage }])
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))))
/** A frame and a task later: when a shown chat asks for what it's missing (lib/afterPaint.ts). */
const afterFrame = () => act(async () => void (await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))))
const setVisibility = (v: DocumentVisibilityState) => {
  Object.defineProperty(document, "visibilityState", { value: v, configurable: true })
  act(() => void document.dispatchEvent(new Event("visibilitychange")))
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  renders.length = 0
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
  await afterFrame()
  vi.useRealTimers()
  host.remove()
  document.body.innerHTML = ""
  act(() => setChatProjectFilter(null))
  forgetCaptainTail(SITE.id)
  vi.unstubAllGlobals()
  for (const [target, key] of [[document, "visibilityState"], [navigator, "deviceMemory"], [performance, "memory"]] as const) Reflect.deleteProperty(target, key)
  localStorage.clear()
  sessionStorage.clear()
})

describe("the chats the centre keeps hidden", () => {
  it("keeps the last two left, hidden behind the one shown, and lets the oldest go past that", () => {
    render()
    expect(centre()).toEqual({ shown: ["Coordinator"], hidden: [] })
    open(SITE)
    expect(centre()).toEqual({ shown: ["marketing-site"], hidden: ["Coordinator"] })
    open(YARD)
    expect(centre()).toEqual({ shown: ["box-yard"], hidden: ["Coordinator", "marketing-site"] })
    open(COLD)
    expect(KEEP_CHATS).toBe(2)
    expect(centre()).toEqual({ shown: ["cold-project"], hidden: ["box-yard", "marketing-site"] })
    // Going back to one kept puts the one left in its place.
    open(SITE)
    expect(centre()).toEqual({ shown: ["marketing-site"], hidden: ["box-yard", "cold-project"] })
    openCoordinator()
    expect(centre()).toEqual({ shown: ["Coordinator"], hidden: ["cold-project", "marketing-site"] })
    // Kept in memory, like the conversations: nothing in web storage.
    expect(storage()).not.toContain(SECRET)
  })

  it("going back shows the very chat left, caught up on what came while it was hidden", async () => {
    render()
    open(SITE)
    const chat = captainChat(SITE)!
    open(YARD)
    expect(isHidden(chat)).toBe(true)
    act(() => qc.setQueryData<CaptainMessage[]>(keys.captainMessages(SITE.id), (m) => [...m!, message(SITE.id, "cm_site02", "Shipped the launch page.", 10)]))
    expect(chat.textContent).not.toContain("Shipped the launch page.")

    open(SITE)
    expect(captainChat(SITE)).toBe(chat)
    expect(isHidden(chat)).toBe(false)
    expect(chat.textContent).toContain("Shipped the launch page.")
    await afterFrame()
  })

  it("renders nothing while hidden: not for its messages, the projects or tasks changing, the Coordinator's chat, nor the clock", async () => {
    // The clock every "4m ago" reads ticks on an interval: fake that, and the time, to move it on.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
    render()
    open(SITE)
    open(YARD)
    await afterFrame()
    expect(centre()).toEqual({ shown: ["box-yard"], hidden: ["Coordinator", "marketing-site"] })
    renders.length = 0

    act(() => {
      qc.setQueryData<CaptainMessage[]>(keys.captainMessages(SITE.id), (m) => [...m!, message(SITE.id, "cm_site02", "Shipped the launch page.", 10)])
      qc.setQueryData(keys.captain(SITE.id), { ...state(SITE.id), busy: true })
      qc.setQueryData<ChatMessage[]>(keys.chat, (m) => [...m!, { id: "msg_2", role: "assistant", content: "A task finished.", meta: null, createdAt: Date.now() }])
      qc.setQueryData(keys.chatBusy, true)
      // A real change (an equal list keeps its old reference), so the centre itself renders again.
      qc.setQueryData(keys.projects, PROJECTS.map((p) => ({ ...p, description: "Updated." })))
      qc.setQueryData(keys.tasks, TASKS.map((t) => ({ ...t, updatedAt: Date.now() })))
      // The one shown hears from its Captain too: it renders, so the log is listening.
      qc.setQueryData<CaptainMessage[]>(keys.captainMessages(YARD.id), (m) => [...m!, message(YARD.id, "cm_yard02", "On it.", 10)])
    })
    act(() => void vi.advanceTimersByTime(10 * 60_000))
    await wait(20)
    await afterFrame()

    // The one shown rendered, so the log is listening; nothing hidden did.
    expect(rendered(`captain:${YARD.id}`, "shown")).toContain(`captain:${YARD.id}:shown:CaptainTab`)
    expect(renders.filter((r) => r.includes(":hidden:"))).toEqual([])

    // Shown again, each catches up at once.
    open(SITE)
    expect(rendered(`captain:${SITE.id}`, "shown").length).toBeGreaterThan(0)
    expect(captainChat(SITE)!.textContent).toContain("Shipped the launch page.")
    openCoordinator()
    expect(coordinatorChat()!.textContent).toContain("A task finished.")
  })

  it("the composer jump, and a closing panel giving focus back, go to the shown chat's box, not a kept one's", async () => {
    render()
    open(SITE)
    open(YARD)
    await afterFrame()
    const box = (p: Project) => captainChat(p)!.querySelector<HTMLTextAreaElement>("[data-testid=chat-footer] textarea")!
    // marketing-site's chat, hidden, comes first in the page.
    expect(box(SITE).compareDocumentPosition(box(YARD)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(composerJumpTarget(document.body)).toBe(box(YARD))
    // With nothing focused, a task's panel opened over the chat and closed again gives focus to the chat's box.
    act(() => (document.activeElement as HTMLElement | null)?.blur())
    click(nav().querySelector(`[data-open-task='${TASKS[0]!.id}']`)!)
    expect(document.querySelector("[data-testid=column]")).not.toBeNull()
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    await afterFrame()
    expect(document.querySelector("[data-testid=column]")).toBeNull()
    expect(document.activeElement).toBe(box(YARD))
  })

  it("lets them all go when the tab is hidden", () => {
    render()
    open(SITE)
    open(YARD)
    expect(centre().hidden).toEqual(["Coordinator", "marketing-site"])
    setVisibility("hidden")
    expect(centre()).toEqual({ shown: ["box-yard"], hidden: [] })
    // Back on the tab, it keeps chats again as they're left.
    setVisibility("visible")
    open(COLD)
    expect(centre()).toEqual({ shown: ["cold-project"], hidden: ["box-yard"] })
  })

  it("keeps one on a phone with little memory, and none with the JS heap nearly full", () => {
    Object.defineProperty(navigator, "deviceMemory", { value: 2, configurable: true })
    expect(keepLimit()).toBe(1)
    render()
    open(SITE)
    open(YARD)
    open(COLD)
    expect(centre()).toEqual({ shown: ["cold-project"], hidden: ["box-yard"] })

    Object.defineProperty(performance, "memory", { value: { usedJSHeapSize: 900, jsHeapSizeLimit: 1000 }, configurable: true })
    expect(keepLimit()).toBe(0)
    open(DOCS)
    expect(centre()).toEqual({ shown: ["docs-site"], hidden: [] })
  })

  it("keeps none while the tab is hidden, and two otherwise", () => {
    expect(keepLimit()).toBe(KEEP_CHATS)
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })
    expect(keepLimit()).toBe(0)
  })
})
