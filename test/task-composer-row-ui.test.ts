// @vitest-environment happy-dom
// The task page's box keeps one row too (lib/composerRow.ts): its Side question and Captain chips fold into the More
// menu when the row is too narrow, their labels show only where the whole row fits them, and a folded new answer
// shows as a dot on More.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TaskComposer, type TaskAskTarget } from "../web/src/components/CaptainForward.js"
import { keys } from "../web/src/lib/queries.js"
import { resetDrafts } from "../web/src/lib/composerDraft.js"
import type { Project, SettingsInfo, Task } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT = { id: "prj_demo01", name: "demo", color: "lime", createdAt: 1 } as Project
const task = (patch: Partial<Task> = {}) => ({ id: "task_abc123", projectId: PROJECT.id, title: "Login form", status: "idle", pendingCount: 0, parentTaskId: null, ...patch }) as Task
const IDLE_ASK: TaskAskTarget = { on: false, toggle() {}, unread: false, busy: false, submit: async () => {} }

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

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

function box(t: Task, ask: TaskAskTarget | undefined = IDLE_ASK) {
  const panel = createRef<HTMLElement>()
  act(() =>
    root.render(
      createElement(QueryClientProvider, { client: qc }, createElement("section", { ref: panel }, createElement(TaskComposer, { task: t, project: PROJECT, panelRef: panel, onSubmit: async () => {}, ask }))),
    ),
  )
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const chips = () => byTestId("task-ask-toggle")!.parentElement!
// A chip's label: its text, not the Captain icon's box beside it.
const label = (chip: string) => byTestId(chip)!.querySelector("span:not([data-captain-icon])")!
const textarea = () => document.querySelector("textarea")!
async function press(el: HTMLElement) {
  await act(async () => void el.click())
  await act(async () => new Promise((r) => setTimeout(r, 20)))
}

describe("the task box's row", () => {
  it("a working task's two chips fold into More below the width that fits them with Stop, and are labelled only from where the labels fit", () => {
    box(task({ status: "working", pendingCount: 1 }))
    // Mic, Stop, Send, Side question, Captain and More: six 44px buttons need a 17.75rem box (a 320px phone's is 17.875).
    expect(chips().className).toContain("@max-[17.75rem]/composer:hidden")
    // Send to folds with the Captain chip (never alone), so More shows from there.
    expect(byTestId("composer-more")!.className).toContain("@min-[25rem]/composer:hidden")
    // Attach, a phone's most used, folds last: Mic, Stop, Send, More and Attach need 15rem.
    expect(document.querySelector('button[title="Attach files"]')!.className).toContain("@max-[15rem]/composer:hidden")
    // With their labels the chips are wider: Captain's label goes first, then Side question's.
    expect(label("task-ask-toggle").className).toBe("@max-[22.25rem]/composer:sr-only")
    expect(label("captain-target").className).toBe("@max-[27.5rem]/composer:sr-only")
    // Send and Stop never fold.
    expect(document.querySelector('button[type="submit"]')!.className).not.toMatch(/composer:hidden/)
  })

  it("an idle task keeps both chips: with no Stop they're labelled sooner, and fold later", () => {
    box(task())
    expect(byTestId("captain-target")).not.toBeNull()
    expect(label("task-ask-toggle").className).toBe("@max-[19rem]/composer:sr-only")
    expect(label("captain-target").className).toBe("@max-[24.25rem]/composer:sr-only")
    // With Send to in More, Mic, Send, More, Attach and the two chips fit down to 14.5rem.
    expect(chips().className).toContain("@max-[14.5rem]/composer:hidden")
    expect(byTestId("composer-more")!.className).toContain("@min-[21.75rem]/composer:hidden")
    expect(document.querySelector('button[title="Attach files"]')!.className).toContain("@max-[11.75rem]/composer:hidden")
  })

  it("an idle task's folded Captain line says what it does, as a working task's does", async () => {
    box(task())
    await press(byTestId("composer-more")!)
    expect(byTestId("more-captain-target")!.textContent).toContain("Send to the demo Captain")
    expect(byTestId("more-captain-target")!.parentElement!.className).toContain("@min-[21.75rem]/composer:hidden")
  })

  it("with Side question on, the box has neither the Captain chip nor its More line", () => {
    box(task({ status: "working", pendingCount: 1 }), { ...IDLE_ASK, on: true })
    expect(byTestId("captain-target")).toBeNull()
    expect(byTestId("more-captain-target")).toBeNull()
  })

  it("the chips' More lines say what they do, toggle like the chips, then close the menu with the caret in the text", async () => {
    box(task({ status: "working", pendingCount: 1 }))
    await press(byTestId("composer-more")!)
    const captain = byTestId("more-captain-target")!
    expect(captain.textContent).toContain("Captain")
    expect(captain.textContent).toContain("Send to the demo Captain")
    expect(captain.getAttribute("aria-pressed")).toBe("false")
    expect(byTestId("more-task-ask")!.textContent).toContain("Ask the Coordinator aside")
    // The lines show only while their chips are folded: the same width.
    expect(captain.parentElement!.className).toContain("@min-[25rem]/composer:hidden")
    await press(captain)
    expect(byTestId("composer-more-menu")).toBeNull()
    expect(document.activeElement).toBe(textarea())
    expect(textarea().placeholder).toBe("Message the Captain…")
    expect(byTestId("captain-forward-note")).not.toBeNull()
    await press(byTestId("composer-more")!)
    expect(byTestId("more-captain-target")!.getAttribute("aria-pressed")).toBe("true")
    expect(byTestId("more-captain-target")!.textContent).toContain("On: sending to the demo Captain")
  })

  it("Side question's line turns the box to the side question, and drops a Captain pick, as its chip does", async () => {
    const toggle = vi.fn()
    box(task({ status: "working", pendingCount: 1 }), { ...IDLE_ASK, toggle })
    await press(byTestId("captain-target")!)
    expect(byTestId("captain-forward-note")).not.toBeNull()
    await press(byTestId("composer-more")!)
    await press(byTestId("more-task-ask")!)
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(byTestId("captain-forward-note")).toBeNull()
    expect(byTestId("composer-more-menu")).toBeNull()
    expect(document.activeElement).toBe(textarea())
  })

  it("a new answer, or one on its way, shows on More while the chip is folded, and its line says so", async () => {
    box(task({ status: "working", pendingCount: 1 }), { ...IDLE_ASK, unread: true })
    const more = byTestId("composer-more")!
    expect(more.getAttribute("aria-label")).toBe("More actions (A new answer)")
    const dot = byTestId("composer-more-dot")!
    expect(dot.className).toContain("bg-yard-400")
    // Only while the chip (with its own dot) is in the menu.
    expect(dot.className).toContain("@min-[17.75rem]/composer:hidden")
    await press(more)
    expect(byTestId("more-task-ask")!.textContent).toContain("A new answer")
    act(() => root.unmount())
    root = createRoot(host)
    box(task({ status: "working", pendingCount: 1 }), { ...IDLE_ASK, busy: true })
    expect(byTestId("composer-more")!.getAttribute("aria-label")).toBe("More actions (An answer is on its way)")
    expect(byTestId("composer-more-dot")!.className).toContain("bg-sky-400")
  })

  it("no dot on More while the answer's been read, or while the box is on the side question", () => {
    box(task({ status: "working", pendingCount: 1 }))
    expect(byTestId("composer-more")!.getAttribute("aria-label")).toBe("More actions")
    expect(byTestId("composer-more-dot")).toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    box(task({ status: "working", pendingCount: 1 }), { ...IDLE_ASK, on: true, unread: true })
    expect(byTestId("composer-more-dot")).toBeNull()
  })
})
