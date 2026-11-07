// @vitest-environment happy-dom
// The Coordinator chat opens on just the rows that fill the view, then the rest of the newest 60 a few a frame: on a
// fresh launch, building all 60 at once (every reply's Markdown parsed for the first time) held a phone's main thread
// for half a second, and a tap on a Captain in the sidebar waited behind it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ChatPanel } from "../web/src/components/ChatPanel.js"
import { CAPTAIN_GROW_ROWS } from "../web/src/components/CaptainTab.js"
import { keys } from "../web/src/lib/queries.js"
import type { ChatMessage, Project } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project = { id: "prj_firstpaint", name: "box-yard", repo: null, description: "", envKeys: [], notes: [], createdAt: 1, color: null } as unknown as Project
const chat = (n: number): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `chat_fp${String(i).padStart(4, "0")}`,
    role: i % 2 ? "assistant" : "user",
    content: `Message ${i}: **what** happened with \`that\`.`,
    meta: null,
    createdAt: Date.now() - (n - i) * 60_000,
  }))

let root: Root
let host: HTMLElement
let qc: QueryClient

// A phone-sized chat: a 400px list of 100px rows.
const isList = (el: Element) => el.classList.contains("overflow-y-auto")
const shown = (el: Element = host) => new Set([...el.querySelectorAll("[data-chat-id]")].map((r) => r.getAttribute("data-chat-id"))).size
const layout: Record<string, PropertyDescriptor> = {
  clientHeight: { get(this: Element) { return isList(this) ? 400 : 0 } },
  scrollHeight: { get(this: Element) { return isList(this) ? Math.max(400, shown(this) * 100) : 0 } },
}

beforeEach(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  for (const [key, d] of Object.entries(layout)) Object.defineProperty(HTMLElement.prototype, key, { ...d, configurable: true })
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const k of [keys.schedules, keys.artifacts, keys.boxes, keys.tasks]) qc.setQueryData(k, [])
  qc.setQueryData(keys.projects, [project])
  qc.setQueryData(keys.chatBusy, false)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  for (const key of Object.keys(layout)) Reflect.deleteProperty(HTMLElement.prototype, key)
  vi.unstubAllGlobals()
})

/** The rows on screen after each frame, until the newest 60 are. */
async function grown() {
  const counts = [shown()]
  for (let i = 0; i < 100 && counts.at(-1)! < 60; i++) {
    await act(() => new Promise((r) => setTimeout(r, 5)))
    if (shown() !== counts.at(-1)) counts.push(shown())
  }
  return counts
}

describe("the Coordinator chat", () => {
  it("opens on the rows that fill the view, then the rest of the newest 60 a few a frame", async () => {
    qc.setQueryData(keys.chat, chat(200))
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ChatPanel))))
    // The first paint: the newest messages, enough to fill the view, and no more.
    expect(host.textContent).toContain("Message 199:")
    expect(shown()).toBeGreaterThanOrEqual(4)
    expect(shown()).toBeLessThanOrEqual(8)
    const counts = await grown()
    expect(counts.at(-1)).toBe(60)
    for (const [i, n] of counts.slice(1).entries()) expect(n - counts[i]!).toBeLessThanOrEqual(CAPTAIN_GROW_ROWS)
    expect(host.textContent).not.toContain("Message 139:")
  })

  it("does the same when the conversation arrives after the chat is on screen, as on a fresh launch", async () => {
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ChatPanel))))
    expect(shown()).toBe(0)
    await act(async () => {
      qc.setQueryData(keys.chat, chat(200))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(host.textContent).toContain("Message 199:")
    expect(shown()).toBeLessThanOrEqual(8)
    expect((await grown()).at(-1)).toBe(60)
  })
})
