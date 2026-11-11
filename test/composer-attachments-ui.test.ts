// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Composer } from "../web/src/components/Composer.js"
import { closePreview, previewState } from "../web/src/lib/preview.js"
import { prependDraft, resetDrafts } from "../web/src/lib/composerDraft.js"
import { stubUploads, type FakeUpload } from "./fakeUpload.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let qc: QueryClient
let sent: FakeUpload[]
const onSubmit = vi.fn<(text: string, files: unknown[]) => Promise<void>>()
const panel = createRef<HTMLElement>()

function render(draftKey?: string) {
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement("section", { ref: panel }, createElement(Composer, { draftKey, placeholder: "Reply", panelRef: panel, onSubmit })),
      ),
    ),
  )
}

beforeEach(() => {
  resetDrafts()
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // The upload limit comes from the settings, which never answer here: the 20 MB default.
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:thumb", revokeObjectURL: vi.fn() }))
  sent = stubUploads()
  onSubmit.mockReset().mockResolvedValue()
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  qc.clear()
  host.remove()
  closePreview()
  vi.unstubAllGlobals()
})

const shot = new File(["png"], "shot.png", { type: "image/png" })
const notes = new File(["abc"], "notes.txt", { type: "text/plain" })
const savedShot = { id: "upload_shot01", name: "shot.png", size: 3, mime: "image/png" }

function pick(...files: File[]) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(input, "files", { configurable: true, value: files })
  act(() => void input.dispatchEvent(new Event("change", { bubbles: true })))
}
const settle = () => act(async () => await new Promise((r) => setTimeout(r, 0)))
const items = () => [...host.querySelectorAll<HTMLElement>("[data-attachment]")]
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
// Send says what holds it ("Uploading files…") while a file uploads.
const sendButton = () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!
const problem = () => host.querySelector('[data-testid="upload-problem"]')
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
function type(text: string) {
  const field = host.querySelector("textarea")!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text)
    field.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("Composer attachments", () => {
  it("shows an upload's progress, holds the send until it lands, then previews and sends it", async () => {
    render()
    type("Look")
    pick(shot)
    const bar = () => host.querySelector('[role="progressbar"]')
    expect(bar()!.getAttribute("aria-label")).toBe("Uploading shot.png")
    expect(sendButton().disabled).toBe(true)
    expect(sendButton().getAttribute("aria-label")).toBe("Uploading files…")
    act(() => sent[0]!.progress(42, 100))
    expect(items()[0]!.textContent).toContain("42%")
    expect(bar()!.getAttribute("aria-valuenow")).toBe("42")
    // Same whole percent: no new label.
    act(() => sent[0]!.progress(429, 1000))
    expect(items()[0]!.textContent).toContain("42%")
    expect(button("Cancel uploading shot.png")).not.toBeNull()

    await act(async () => sent[0]!.respond(201, savedShot))
    expect(bar()).toBeNull()
    expect(sendButton().disabled).toBe(false)
    expect(sendButton().getAttribute("aria-label")).toBe("Send")
    const link = items()[0]!.querySelector("a")!
    expect(link.getAttribute("href")).toBe("/api/uploads/upload_shot01/shot.png")
    click(link)
    expect(previewState()?.items[previewState()!.index]?.url).toBe("/api/uploads/upload_shot01/shot.png")

    click(sendButton())
    expect(onSubmit).toHaveBeenCalledWith("Look", [savedShot])
  })

  it("names a failed upload, holds the send, and retries the same file", async () => {
    render()
    type("Here's the log")
    pick(notes)
    await act(async () => sent[0]!.respond(500, { error: "Disk full on the server" }))
    expect(items()[0]!.textContent).not.toContain("%")
    expect(problem()!.textContent).toBe(`"notes.txt" didn't upload: Disk full on the serverRetry or remove it to send.`)
    expect(sendButton().disabled).toBe(true)

    click(button("Retry uploading notes.txt")!)
    expect(sent).toHaveLength(2)
    expect(sent[1]!.body).toBe(notes)
    expect(problem()!.textContent).toBe("")
    await act(async () => sent[1]!.respond(201, { id: "upload_notes1", name: "notes.txt", size: 3, mime: "text/plain" }))
    expect(sendButton().disabled).toBe(false)
    expect(items()[0]!.querySelector("a")!.getAttribute("href")).toBe("/api/uploads/upload_notes1/notes.txt")
  })

  it("removing a file mid-upload cancels it without an error", async () => {
    render()
    type("Never mind")
    pick(shot, notes)
    click(button("Cancel uploading shot.png")!)
    await settle()
    expect(sent[0]!.aborted).toBe(true)
    expect(items().map((el) => el.textContent)).toEqual([expect.stringContaining("notes.txt")])
    expect(problem()!.textContent).toBe("")
  })

  it("a file over the limit isn't sent: it says so, offers no Retry, and Remove clears the way", async () => {
    render()
    type("Big one")
    const big = new File(["x"], "movie.mov", { type: "video/quicktime" })
    Object.defineProperty(big, "size", { value: 21 * 1024 * 1024 })
    pick(big)
    expect(sent).toHaveLength(0)
    expect(problem()!.textContent).toBe(`"movie.mov" is larger than the 20 MB upload limit.Remove it to send.`)
    expect(button("Retry uploading movie.mov")).toBeNull()
    expect(sendButton().disabled).toBe(true)
    click(button("Remove movie.mov")!)
    expect(items()).toHaveLength(0)
    expect(sendButton().disabled).toBe(false)
  })

  it("a box with no target cancels its uploads in flight when it goes", () => {
    render()
    pick(notes)
    act(() => root.render(null))
    expect(sent[0]!.aborted).toBe(true)
  })

  it("a restored draft's image shows its uploaded copy", () => {
    prependDraft("task:one", "Again", [savedShot])
    render("task:one")
    const img = items()[0]!.querySelector("img")!
    expect(img.getAttribute("src")).toBe("/api/uploads/upload_shot01/shot.png")
    expect(img.closest("a")!.getAttribute("href")).toBe("/api/uploads/upload_shot01/shot.png")
  })
})
