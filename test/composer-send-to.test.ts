// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Composer } from "../web/src/components/Composer"
import { keys } from "../web/src/lib/queries"
import { resetDrafts, writeDraft, readDraft, uploadedFile } from "../web/src/lib/composerDraft"
import type { Attachment } from "../shared/types"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const projects = [{ id: "prj_example", name: "Example", repo: "acme/site" }]
const task = { id: "task_example", projectId: "prj_example", title: "Fix uploads", status: "done", pendingCount: 0 }
const file = { id: "upl_example", name: "example.txt", size: 10, mime: "text/plain" } as unknown as Attachment
let root: Root, host: HTMLElement, client: QueryClient
const sourceSend = vi.fn()
let calls: { url: string; body: Record<string, unknown> }[]
let rejectSend = false
let holdSend: Promise<void> | undefined
let rejectLoad = false
const wait = () => act(async () => new Promise((resolve) => setTimeout(resolve, 25)))
const text = () => host.querySelector("textarea")!
const menu = () => document.querySelector('[data-testid="send-to-menu"]')
const note = () => host.querySelector('[data-testid="send-to-note"]')
const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"][aria-label="Send to destination"] [role="option"] button'))
/** The click-opened sheet, its search field and its rows (the typed ">" list above is `menu` and `options`). */
const sheet = () => document.querySelector('[data-testid="send-to-sheet"]')
const search = () => document.querySelector<HTMLInputElement>('[aria-label="Search destinations"]')!
const choices = () => Array.from(sheet()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
const picked = () => document.getElementById(search().getAttribute("aria-activedescendant") ?? "")
async function find(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search(), value)
    search().dispatchEvent(new Event("input", { bubbles: true }))
  })
}
const sheetKey = (key: string) => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  act(() => void search().dispatchEvent(e))
  return e
}
const key = (key: string, extra: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra })
  act(() => void text().dispatchEvent(e))
  return e
}
async function type(value: string) {
  await act(async () => {
    text().focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(text(), value)
    text().setSelectionRange(value.length, value.length)
    text().dispatchEvent(new Event("input", { bubbles: true }))
    text().dispatchEvent(new Event("select", { bubbles: true }))
  })
}
const click = (el: HTMLElement) => act(async () => void el.click())
function mount(draftKey = "coordinator") {
  const panel = createRef<HTMLElement>()
  act(() => root.render(createElement(QueryClientProvider, { client }, createElement("section", { ref: panel }, createElement(Composer, { onSubmit: sourceSend, placeholder: "Message", panelRef: panel, draftKey })))))
}
beforeEach(() => {
  resetDrafts(); sourceSend.mockReset(); calls = []; rejectSend = false; holdSend = undefined; rejectLoad = false
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  client.setQueryData(keys.projects, projects)
  client.setQueryData(keys.tasks, [task])
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (!init?.body) {
      const catalog = url === "/api/projects" ? projects : url === "/api/tasks" ? [task] : undefined
      if (catalog) return new Response(JSON.stringify(rejectLoad ? { error: "Unavailable" } : catalog), { status: rejectLoad ? 500 : 200 })
      return new Promise(() => {})
    }
    const body = JSON.parse(init.body as string)
    calls.push({ url, body })
    await holdSend
    return new Response(JSON.stringify(rejectSend ? { error: "Destination unavailable" } : url.includes("/tasks/") ? { ...task, status: "queued" } : { id: body.id, content: body.content, role: "user", createdAt: 1 }), { status: rejectSend ? 409 : 200 })
  })
  host = document.createElement("div"); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount(); client.clear() })
  host.remove(); vi.unstubAllGlobals()
})

describe("Send to from every chat", () => {
  for (const source of ["coordinator", "captain:prj_example", "task:task_source"]) {
    for (const [search, path] of [["Coordinator", "/api/chat"], ["Example Captain", "/api/projects/prj_example/captain/messages"], ["Fix uploads", "/api/tasks/task_example/messages"]]) {
      it(`${source} sends text and attachments to ${search} through its existing API, staying at the source`, async () => {
        writeDraft(source, { text: `Review >${search}`, files: [uploadedFile(file)] })
        mount(source)
        await type(`Review >${search}`)
        expect(menu()).not.toBeNull()
        expect(options()).toHaveLength(1)
        expect(text().getAttribute("aria-controls")).toBe(menu()?.querySelector("ul")?.id)
        key("Tab")
        expect(text().value).toBe("Review ")
        expect(note()?.textContent).toContain(`Send to ${search}`)
        expect(calls).toHaveLength(0)
        expect(sourceSend).not.toHaveBeenCalled()
        key("Enter"); await wait()
        expect(calls).toHaveLength(1)
        expect(calls[0]).toMatchObject({ url: path, body: { content: "Review", attachments: [file.id] } })
        expect(readDraft(source).text).toBe("")
        expect(readDraft(source).files).toHaveLength(0)
        expect(note()?.textContent).toContain(`Sent to ${search}`)
        expect(note()?.querySelector("a")?.getAttribute("href")).toBe(path.includes("tasks") ? "/?session=task_example" : path.includes("projects") ? "/?project=prj_example" : "/")
        expect(sourceSend).not.toHaveBeenCalled()
      })
    }
  }
  for (const destination of ["Coordinator", "Example Captain", "Fix uploads"]) it(`keeps text, files and ${destination} on an API error, then retries once`, async () => {
    rejectSend = true
    writeDraft("coordinator", { text: "", files: [uploadedFile(file)] })
    mount(); await type(`Check >${destination}`); key("Enter"); key("Enter"); await wait()
    expect(text().value).toBe("Check ")
    expect(readDraft("coordinator").files[0]?.attachment?.id).toBe(file.id)
    expect(note()?.textContent).toContain(`Send to ${destination}`)
    expect(note()?.textContent).not.toContain("Sent to")
    rejectSend = false; key("Enter"); await wait()
    expect(calls).toHaveLength(2)
    expect(note()?.textContent).toContain(`Sent to ${destination}`)
  })
  it("Escape cancels a typed query without changing the draft; Clear restores normal source sending", async () => {
    mount(); await type("Keep >Captain"); key("Escape")
    expect(menu()).toBeNull(); expect(text().value).toBe("Keep >Captain")
    await type("Keep >Fix"); key("Enter")
    await click(host.querySelector('[aria-label="Clear destination"]')!)
    expect(note()).toBeNull(); expect(text().value).toBe("Keep ")
    key("Enter")
    expect(sourceSend).toHaveBeenCalledWith("Keep", [])
    expect(calls).toHaveLength(0)
  })
  it("supports touch/button and both shortcut modifiers, without changing the draft on cancel", async () => {
    mount(); await type("Touch draft")
    await click(host.querySelector('button[aria-label="Send to…"]')!)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Send to")
    expect(document.activeElement).toBe(search())
    await click(choices()[0]!)
    expect(text().value).toBe("Touch draft"); expect(document.activeElement).toBe(text())
    expect(note()?.textContent).toContain("Send to Coordinator")
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      key("Enter", { shiftKey: true, ...modifier })
      expect(sheet()).not.toBeNull()
      await click(document.querySelector('[aria-label="Close"]')!)
      expect(text().value).toBe("Touch draft")
      expect(note()?.textContent).toContain("Send to Coordinator")
    }
    expect(calls).toHaveLength(0)
  })
  it("filters in the sheet, selects by keyboard, and shields IME composition and empty results", async () => {
    mount(); await type(">no matching task")
    expect(options()).toHaveLength(0)
    key("Enter"); expect(sourceSend).not.toHaveBeenCalled()
    await type(">Fix")
    key("Enter", { isComposing: true }); expect(menu()).not.toBeNull()
    key("Enter", { keyCode: 229 }); expect(menu()).not.toBeNull()
    key("ArrowDown"); key("Enter")
    expect(note()?.textContent).toContain("Sending reopens this task")
    key("Enter", { shiftKey: true, ctrlKey: true })
    await find("Captain")
    expect(choices()).toHaveLength(1)
    sheetKey("Enter")
    expect(note()?.textContent).toContain("Example Captain")
  })
  it("the sheet lists chats then tasks under headings, ranks words, and Esc clears the search before it closes", async () => {
    mount(); await type("Draft")
    await click(host.querySelector('button[aria-label="Send to…"]')!)
    expect(choices().map((el) => el.textContent)).toEqual(["CoordinatorAll projects", "Example Captainacme/site", "Fix uploadsExample · Done · sending reopens it"])
    expect(sheet()?.textContent).toMatch(/Chats.*Coordinator.*Tasks.*Fix uploads/)
    expect(picked()?.textContent).toContain("Coordinator")
    // The pointer and the keys move one highlight.
    act(() => void choices()[2]!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })))
    expect(picked()?.textContent).toContain("Fix uploads")
    sheetKey("ArrowUp")
    expect(picked()?.textContent).toContain("Example Captain")
    // Words in any order, each from a different part of the row: the task's name and its project.
    await find("example fix")
    expect(choices().map((el) => el.textContent)).toEqual(["Fix uploadsExample · Done · sending reopens it"])
    expect([...choices()[0]!.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["Fix", "Example"])
    await find("zzzz")
    expect(choices()).toHaveLength(0)
    expect(sheet()?.textContent).toContain("No chat or task matches “zzzz”")
    sheetKey("Enter")
    expect(sheet()).not.toBeNull()
    expect(sheetKey("Escape").defaultPrevented).toBe(true)
    expect(search().value).toBe("")
    expect(choices()).toHaveLength(3)
    await find("fix")
    sheetKey("Enter")
    expect(sheet()).toBeNull()
    expect(text().value).toBe("Draft"); expect(document.activeElement).toBe(text())
    expect(note()?.textContent).toContain("Send to Fix uploads")
    expect(calls).toHaveLength(0)
  })
  it("swaps drafts without carrying a destination to another chat", async () => {
    mount(); await type("Draft >Fix"); key("Enter")
    mount("captain:prj_example"); expect(note()).toBeNull(); expect(text().value).toBe("")
    await type("New message"); key("Enter")
    expect(sourceSend).toHaveBeenCalledWith("New message", [])
    mount("coordinator")
    expect(text().value).toBe("Draft ")
    expect(note()?.textContent).toContain("Send to Fix uploads")
  })
  it("restores a failed delivery to its source draft after that composer unmounts", async () => {
    let release!: () => void
    holdSend = new Promise<void>((resolve) => { release = resolve })
    rejectSend = true
    mount(); await type("Retain >Fix"); key("Enter"); key("Enter")
    await wait()
    mount("captain:prj_example")
    act(() => release()); await wait()
    expect(note()).toBeNull()
    expect(text().value).toBe("")
    mount()
    expect(text().value).toBe("Retain ")
    expect(note()?.textContent).toContain("Send to Fix uploads")
    expect(calls[0]?.url).toBe("/api/tasks/task_example/messages")
  })
  for (const [search, path] of [["Coordinator", "/api/chat"], ["Captain", "/api/projects/prj_example/captain/messages"], ["uploads", "/api/tasks/task_example/messages"]]) it(`sends an attachment-only draft to ${search}`, async () => {
    writeDraft("coordinator", { text: "", files: [uploadedFile(file)] })
    mount()
    key("Enter", { shiftKey: true, ctrlKey: true })
    await find(search)
    await click(choices()[0]!)
    key("Enter"); await wait()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ url: path, body: { content: "", attachments: [file.id] } })
  })
  it("blocks sending when destination discovery fails and supports retry", async () => {
    rejectLoad = true
    client.removeQueries({ queryKey: keys.projects }); client.removeQueries({ queryKey: keys.tasks })
    mount(); await type("Draft >"); await wait()
    expect(menu()?.textContent).toContain("Couldn't load destinations")
    key("Enter"); expect(sourceSend).not.toHaveBeenCalled(); expect(calls).toHaveLength(0)
    rejectLoad = false
    await click(menu()!.querySelector("button")!); await wait()
    expect(options().length).toBe(3)
    key("Escape"); expect(text().value).toBe("Draft >")
  })

})
