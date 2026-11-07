// @vitest-environment happy-dom
import { afterPaint } from "../web/src/lib/afterPaint.js"
// Every composer says who it messages with an icon at its text's leading edge (ChatIcons.tsx): the Coordinator's
// helm, a Captain's icon (the cap by default), a task's checklist, a sub-task's nested checklist, or a side question's bubble.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, createRef, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Composer } from "../web/src/components/Composer.js"
import { DockComposer } from "../web/src/components/DockComposer.js"
import { TaskComposer } from "../web/src/components/CaptainForward.js"
import { SideThreadPane, ThreadChatProvider } from "../web/src/components/SideThread.js"
import { CHAT_ICONS, ChatIcon, ComposerIcon, Subtask, type ChatKind } from "../web/src/components/ChatIcons.js"
import { CaptainCap, Helm } from "../web/src/components/ShipIcons.js"
import { createJumpStore } from "../web/src/components/StickyScroll.js"
import { keys } from "../web/src/lib/queries.js"
import { resetDrafts } from "../web/src/lib/composerDraft.js"
import { COORDINATOR_CHAT, closeThread, openThread, threadKeys } from "../web/src/lib/threads.js"
import { PROJECT_COLOR_HEX } from "../shared/projectColors.js"
import type { Project, SettingsInfo, SideThread, Task } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT = { id: "prj_demo01", name: "demo", color: "lime", createdAt: 1 } as Project
const task = (patch: Partial<Task> = {}) => ({ id: "task_abc123", projectId: PROJECT.id, title: "Login form", status: "idle", pendingCount: 0, parentTaskId: null, ...patch }) as Task

let root: Root
let host: HTMLElement
let qc: QueryClient

beforeEach(() => {
  resetDrafts()
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.projects, [PROJECT])
  qc.setQueryData(keys.tasks, [task()])
  qc.setQueryData(keys.agentSettings, { settings: { ownerName: "Ada" } } as unknown as SettingsInfo)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  act(() => root.unmount())
  // Keep deferred chat requests inside the mocked fetch lifetime.
  await act(async () => { await afterPaint() })
  host.remove()
  closeThread(COORDINATOR_CHAT)
  vi.unstubAllGlobals()
})

function render(el: ReactElement) {
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, el)))
}

/** The box's who-icon: its kind, label, the lucide glyph drawn and the colour it's drawn in. */
function who() {
  const icons = host.querySelectorAll<HTMLElement>("[data-chat-kind]")
  expect(icons).toHaveLength(1)
  const icon = icons[0]!
  // A Captain's glyph is inside its CaptainIcon, which takes the size and tint.
  const svg = icon.querySelector("svg")!
  const mark = icon.querySelector<HTMLElement>("[data-captain-icon]") ?? svg
  return {
    kind: icon.dataset.chatKind as ChatKind,
    label: icon.getAttribute("aria-label"),
    role: icon.getAttribute("role"),
    title: icon.getAttribute("title"),
    glyph: [...svg.classList].find((c) => c.startsWith("lucide-") && c !== "lucide-icon"),
    tint: [...mark.classList].find((c) => c.startsWith("text-")),
    pc: icon.style.getPropertyValue("--pc"),
    hidden: mark.getAttribute("aria-hidden"),
  }
}

function TaskBox({ t }: { t: Task }) {
  const panel = createRef<HTMLElement>()
  return createElement("section", { ref: panel }, createElement(TaskComposer, { task: t, project: PROJECT, panelRef: panel, onSubmit: async () => {}, ask: { on: false, toggle() {}, unread: false, busy: false, submit: async () => {} } }))
}

function Dock({ captain }: { captain: boolean }) {
  const panel = createRef<HTMLElement>()
  return createElement(
    "section",
    { ref: panel },
    createElement(DockComposer, {
      jumpStore: createJumpStore(),
      chat: captain ? { label: "the demo Captain", color: "lime" } : { label: "the Coordinator" },
      onSubmit: () => {},
      placeholder: "Message…",
      historyKey: captain ? `captain:${PROJECT.id}` : "coordinator",
      textareaRef: createRef(),
      handleRef: createRef(),
      panelRef: panel,
      runTargetsProject: captain ? PROJECT.id : null,
    }),
  )
}

describe("the composer's who-icon", () => {
  it("the Coordinator's chat shows the helm, in the yard's colour", () => {
    render(createElement(Dock, { captain: false }))
    expect(who()).toMatchObject({ kind: "coordinator", glyph: "lucide-helm", label: "Messaging the Coordinator", title: "Messaging the Coordinator", role: "img", tint: "text-yard-400", hidden: "true" })
  })

  it("a Captain's chat shows the Captain's cap, in its project's colour", () => {
    render(createElement(Dock, { captain: true }))
    expect(who()).toMatchObject({ kind: "captain", glyph: "lucide-captain-cap", label: "Messaging the demo Captain", tint: "text-(--pc)", pc: PROJECT_COLOR_HEX.lime, hidden: "true" })
  })

  it("a task's box shows the task icon, and a sub-task's the nested one", () => {
    render(createElement(TaskBox, { t: task() }))
    expect(who()).toMatchObject({ kind: "task", glyph: "lucide-list-todo", label: "Messaging this task", tint: "text-(--pc)", pc: PROJECT_COLOR_HEX.lime })
    render(createElement(TaskBox, { t: task({ id: "task_child01", parentTaskId: "task_abc123" }) }))
    expect(who()).toMatchObject({ kind: "subtask", glyph: "lucide-subtask", label: "Messaging this sub-task" })
  })

  it("a task's box switches to the side question's bubble with Side question, and to the cap when it sends to the Captain", () => {
    render(createElement(TaskBox, { t: task({ status: "working", pendingCount: 1 }) }))
    expect(who().kind).toBe("task")
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="captain-target"]')!.click())
    expect(who()).toMatchObject({ kind: "captain", glyph: "lucide-captain-cap", label: "Messaging the demo Captain" })
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="task-ask-toggle"]')!.click())
    // The parent owns `ask.on`; render it on, as TaskSession does after the toggle.
    const panel = createRef<HTMLElement>()
    render(createElement("section", { ref: panel }, createElement(TaskComposer, { task: task(), project: PROJECT, panelRef: panel, onSubmit: async () => {}, ask: { on: true, toggle() {}, unread: false, busy: false, submit: async () => {} } })))
    expect(who()).toMatchObject({ kind: "side-question", glyph: "lucide-message-circle-question-mark", label: "Side question to the Coordinator about this task", tint: "text-yard-400", pc: "" })
  })

  it("the side question panel's box shows the side question's bubble", () => {
    const open: SideThread = { id: "thr_abc123", projectId: null, anchorId: null, kind: "ask", quote: "never backs off", context: "fork", busy: false, replies: 0, unread: false, resolvedAt: null, createdAt: 2, updatedAt: 2 } as SideThread
    qc.setQueryData(threadKeys.list(COORDINATOR_CHAT), [open])
    qc.setQueryData(threadKeys.messages(open.id), [])
    render(createElement(ThreadChatProvider, { value: COORDINATOR_CHAT }, createElement(SideThreadPane, { chat: COORDINATOR_CHAT })))
    act(() => openThread(COORDINATOR_CHAT, open.id))
    expect(host.querySelector('[data-testid="side-thread"]')).not.toBeNull()
    expect(who()).toMatchObject({ kind: "side-question", glyph: "lucide-message-circle-question-mark", label: "Side question to the Coordinator" })
  })
})

describe("the icon slot", () => {
  function box(icon?: ReactElement) {
    const panel = createRef<HTMLElement>()
    render(createElement("section", { ref: panel }, createElement(Composer, { onSubmit: () => {}, placeholder: "Reply…", panelRef: panel, icon })))
    return host.querySelector("textarea")!
  }

  it("sits on the text's first line and costs no height: the textarea keeps its padding and only starts after the icon", () => {
    const plain = [...box().classList]
    const withIcon = [...box(createElement(ComposerIcon, { kind: "side-question", label: "Side question" })).classList]
    // Same top padding and no min height: the box is exactly as tall as without the icon.
    expect(withIcon.filter((c) => c !== "pl-11")).toEqual(plain)
    expect(withIcon).toContain("pl-11")
    expect(withIcon.some((c) => c.startsWith("min-h"))).toBe(false)
    const slot = host.querySelector<HTMLElement>('[data-testid="composer-icon"]')!
    // The slot takes the text's own top padding and line height, so the icon centres on the first line at either size.
    for (const c of ["pt-3", "@min-[32rem]/composer:pt-2.5", "leading-6", "@min-[32rem]/composer:leading-5", "absolute", "w-11"]) expect(slot.classList).toContain(c)
    expect(slot.firstElementChild!.classList).toContain("h-lh")
    expect(host.querySelector('[data-testid="composer-target"]')).toBeNull()
  })

  it("a press on the icon puts the caret in the text and never takes the focus", () => {
    const text = box(createElement(ComposerIcon, { kind: "task", label: "Messaging this task" }))
    const icon = host.querySelector("[data-chat-kind] svg")!
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    act(() => void icon.dispatchEvent(down))
    expect(down.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(text)
    expect(host.querySelector("[data-chat-kind]")!.getAttribute("tabindex")).toBeNull()
  })
})

describe("the icons", () => {
  it("are one lucide-style glyph per kind, the sub-task's a custom one in currentColor at lucide's 2px stroke", () => {
    expect(new Set(Object.values(CHAT_ICONS)).size).toBe(5)
    render(createElement(Subtask))
    const svg = host.querySelector("svg")!
    expect(svg.getAttribute("stroke")).toBe("currentColor")
    expect(svg.getAttribute("stroke-width")).toBe("2")
    expect(svg.getAttribute("fill")).toBe("none")
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24")
    expect(svg.classList).toContain("lucide-subtask")
  })

  it("the Coordinator's is the six-spoke helm and a Captain's the cap, as the icon sheet drew them (#2, #10)", () => {
    // Each on lucide's 24px grid at its 2px round stroke in currentColor, with its filled parts filled and unstroked.
    const parts = (svg: SVGSVGElement) =>
      [...svg.children].map((el) => Object.fromEntries([...el.attributes].filter((a) => a.name !== "key").map((a) => [a.name, a.value])))
    render(createElement(Helm))
    let svg = host.querySelector("svg")!
    expect([svg.getAttribute("viewBox"), svg.getAttribute("stroke"), svg.getAttribute("stroke-width"), svg.getAttribute("fill")]).toEqual(["0 0 24 24", "currentColor", "2", "none"])
    expect(svg.getAttribute("stroke-linecap")).toBe("round")
    expect(parts(svg)).toEqual([
      { cx: "12", cy: "12", r: "6.6" },
      { d: "M12 12L12 1.6M12 12L21.01 6.8M12 12L21.01 17.2M12 12L12 22.4M12 12L2.99 17.2M12 12L2.99 6.8" },
      { cx: "12", cy: "12", r: "2.4", fill: "currentColor", stroke: "none" },
    ])
    render(createElement(CaptainCap))
    svg = host.querySelector("svg")!
    expect([svg.getAttribute("viewBox"), svg.getAttribute("stroke"), svg.getAttribute("stroke-width"), svg.getAttribute("fill")]).toEqual(["0 0 24 24", "currentColor", "2", "none"])
    expect(parts(svg)).toEqual([
      { d: "M6 13 2.8 9.4C2.2 7.2 6.6 5.2 12 5.2s9.8 2 9.2 4.2L18 13Z" },
      { d: "M6 13h12v2.8H6Z" },
      { d: "M6 15.8h12c-1 2.8-11 2.8-12 0Z", fill: "currentColor", stroke: "none" },
      { cx: "12", cy: "9.2", r: "1.4", fill: "currentColor", stroke: "none" },
    ])
  })

  it("the nav's Coordinator mark is the composer's helm", () => {
    render(createElement(ChatIcon, { kind: "coordinator", className: "h-4 w-4" }))
    const svg = host.querySelector("svg")!
    expect(svg.classList).toContain("lucide-helm")
    expect(svg.getAttribute("aria-hidden")).toBe("true")
  })
})
