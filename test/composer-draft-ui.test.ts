// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Composer } from "../web/src/components/Composer.js"
import { draftKeys, prependDraft, readDraft, resetDrafts, setDraftText } from "../web/src/lib/composerDraft.js"
import { stubUploads, type FakeUpload } from "./fakeUpload.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let qc: QueryClient
let uploads: FakeUpload[]
let blobs: number
let revoke: ReturnType<typeof vi.spyOn<typeof URL, "revokeObjectURL">>
const onSubmit = vi.fn<(text: string, attachments: unknown[]) => Promise<void>>()
const panel = createRef<HTMLElement>()

type Target = { historyKey?: string; draftKey?: string }
/** The box for a target as the chats mount it: by historyKey (Coordinator, Captain, task) or draftKey (a thread). Another `id` is a fresh mount. */
const show = (target: Target | null, id = "box") =>
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        target ? createElement("section", { ref: panel }, createElement(Composer, { key: id, ...target, label: "Message", placeholder: "Message", panelRef: panel, onSubmit })) : null,
      ),
    ),
  )
const field = () => host.querySelector("textarea")!
const typeInto = (el: HTMLTextAreaElement, text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, text)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
const type = (text: string) => typeInto(field(), text)
const enter = (el: Element) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })))
const pick = (...files: File[]) => {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(input, "files", { configurable: true, value: files })
  act(() => void input.dispatchEvent(new Event("change", { bubbles: true })))
}
const items = () => [...host.querySelectorAll<HTMLElement>("[data-attachment]")]
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
const problem = () => host.querySelector('[data-testid="upload-problem"]')!.textContent
const shot = () => new File(["png"], "shot.png", { type: "image/png" })
const saved = (id: string) => ({ id, name: "shot.png", size: 3, mime: "image/png" })
const landed = (i: number, id: string) => act(async () => uploads[i]!.respond(201, saved(id)))

beforeEach(() => {
  resetDrafts()
  blobs = 0
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onSubmit.mockReset().mockResolvedValue()
  // The settings (upload limit) never answer here: the 20 MB default.
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  uploads = stubUploads()
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:thumb-${++blobs}`)
  revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  resetDrafts()
  qc.clear()
  host.remove()
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const TARGETS: [string, Target][] = [
  ["the Coordinator", { historyKey: "coordinator" }],
  ["a Captain", { historyKey: "captain:prj_alpha1" }],
  ["a task", { historyKey: "task:task_alpha1" }],
  ["a task page in Side question mode", { historyKey: "task-ask:task_alpha1", draftKey: "task:task_alpha1" }],
  ["a thread", { draftKey: "thread:thr_alpha1" }],
]

describe("Composer drafts", () => {
  it.each(TARGETS)("%s keeps its text and image through leaving and coming back", async (_name, target) => {
    show(target)
    type("Look at this")
    pick(shot())
    await landed(0, "upload_shot01")
    show(null)
    // Leaving neither cancels the upload nor frees the thumbnail.
    expect(revoke).not.toHaveBeenCalled()
    show(target, "again")
    expect(field().value).toBe("Look at this")
    expect(document.activeElement).not.toBe(field())
    expect(items()).toHaveLength(1)
    expect(items()[0]!.querySelector("img")!.getAttribute("src")).toBe("blob:thumb-1")
    expect(button("Send")!.disabled).toBe(false)
  })

  it("keeps each target's draft apart, also when one box switches between them in place", async () => {
    // The Coordinator's box talks to a picked Captain without remounting (ChatPanel's project bar).
    show({ historyKey: "coordinator" })
    type("For the Coordinator")
    pick(shot())
    await landed(0, "upload_coord1")
    show({ historyKey: "captain:prj_alpha1" })
    expect(field().value).toBe("")
    expect(items()).toHaveLength(0)
    type("For the alpha Captain")
    show({ historyKey: "captain:prj_zeta01" })
    expect(field().value).toBe("")
    show({ historyKey: "coordinator" })
    expect(field().value).toBe("For the Coordinator")
    expect(items()).toHaveLength(1)
    show({ historyKey: "captain:prj_alpha1" })
    expect(field().value).toBe("For the alpha Captain")
    expect(items()).toHaveLength(0)
    expect(draftKeys().sort()).toEqual(["captain:prj_alpha1", "coordinator"])
  })

  it("lets an upload in flight finish while its box is away, and shows it done on return", async () => {
    show({ historyKey: "captain:prj_alpha1" })
    pick(shot())
    expect(button("Cancel uploading shot.png")).not.toBeNull()
    show(null)
    expect(uploads[0]!.aborted).toBe(false)
    act(() => uploads[0]!.progress(50, 100))
    await landed(0, "upload_late01")
    show({ historyKey: "captain:prj_alpha1" }, "again")
    expect(host.querySelector('[role="progressbar"]')).toBeNull()
    expect(items()[0]!.querySelector("a")!.getAttribute("href")).toBe("/api/uploads/upload_late01/shot.png")
    enter(field())
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("", [saved("upload_late01")])
  })

  it("shows an upload that failed while its box was away as failed, with Retry", async () => {
    show({ historyKey: "task:task_alpha1" })
    type("With the log")
    pick(new File(["abc"], "notes.txt", { type: "text/plain" }))
    show(null)
    await act(async () => uploads[0]!.respond(500, { error: "Disk full" }))
    show({ historyKey: "task:task_alpha1" }, "again")
    expect(problem()).toBe(`"notes.txt" didn't upload: Disk fullRetry or remove it to send.`)
    expect(button("Send")!.disabled).toBe(true)
    click(button("Retry uploading notes.txt")!)
    expect(uploads).toHaveLength(2)
    await act(async () => uploads[1]!.respond(201, { id: "upload_notes1", name: "notes.txt", size: 3, mime: "text/plain" }))
    expect(problem()).toBe("")
    expect(button("Send")!.disabled).toBe(false)
  })

  it("clears the draft on a successful send, and frees its thumbnails only then", async () => {
    let accept!: () => void
    onSubmit.mockImplementation(() => new Promise<void>((ok) => (accept = ok)))
    show({ historyKey: "coordinator" })
    type("Ship it")
    pick(shot())
    await landed(0, "upload_ship01")
    enter(field())
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("Ship it", [saved("upload_ship01")])
    // The box empties at once, but the send can still fail and bring the image back.
    expect(field().value).toBe("")
    expect(revoke).not.toHaveBeenCalled()
    await act(async () => accept())
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:thumb-1")
    show(null)
    show({ historyKey: "coordinator" }, "again")
    expect(field().value).toBe("")
    expect(items()).toHaveLength(0)
    expect(draftKeys()).toEqual([])
  })

  it("puts a failed send back in the draft it came from, after its box moved to another chat or closed", async () => {
    const rejects: ((err: Error) => void)[] = []
    onSubmit.mockImplementation(() => new Promise<void>((_ok, fail) => void rejects.push(fail)))
    show({ historyKey: "captain:prj_alpha1" })
    type("Don't lose this")
    pick(shot())
    await landed(0, "upload_keep01")
    enter(field())
    show({ historyKey: "coordinator" })
    type("Meanwhile, the Coordinator")
    await act(async () => rejects[0]!(new Error("Offline")))
    expect(field().value).toBe("Meanwhile, the Coordinator")
    expect(items()).toHaveLength(0)
    show({ historyKey: "captain:prj_alpha1" })
    expect(field().value).toBe("Don't lose this")
    expect(items()).toHaveLength(1)
    expect(revoke).not.toHaveBeenCalled()

    // And a box that closed before the server answered.
    show({ draftKey: "thread:thr_alpha1" })
    type("Thread reply")
    enter(field())
    show(null)
    await act(async () => rejects[1]!(new Error("Offline")))
    show({ draftKey: "thread:thr_alpha1" }, "again")
    expect(field().value).toBe("Thread reply")
  })

  it("Remove takes a file out of the draft for good and frees its thumbnail", async () => {
    show({ historyKey: "task:task_alpha1" })
    pick(shot())
    await landed(0, "upload_gone01")
    click(button("Remove shot.png")!)
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:thumb-1")
    show(null)
    show({ historyKey: "task:task_alpha1" }, "again")
    expect(items()).toHaveLength(0)
    expect(draftKeys()).toEqual([])
  })

  it("forgets the draft of a box with no target when it goes", () => {
    show({})
    type("Nowhere to come back to")
    pick(shot())
    show(null)
    expect(uploads[0]!.aborted).toBe(true)
    expect(revoke).toHaveBeenCalledWith("blob:thumb-1")
    expect(draftKeys()).toEqual([])
  })

  it("takes a prefill into a target's draft before its box opens, and while it's open", () => {
    setDraftText("thread:thr_alpha1", "> the quoted line\n\n")
    show({ draftKey: "thread:thr_alpha1" })
    expect(field().value).toBe("> the quoted line\n\n")
    act(() => void prependDraft("thread:thr_alpha1", "Ahead of it"))
    expect(field().value).toBe("Ahead of it\n\n> the quoted line\n\n")
  })

  it("keeps drafts in this tab's memory only: nothing goes to web storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem")
    show({ historyKey: "captain:prj_alpha1" })
    type("SECRET plan")
    pick(shot())
    await landed(0, "upload_secret1")
    show(null)
    show({ historyKey: "captain:prj_alpha1" }, "again")
    expect(field().value).toBe("SECRET plan")
    expect(setItem.mock.calls.filter((call) => call.join("=").includes("SECRET") || call.join("=").includes("upload_secret1"))).toEqual([])
    const stored = [localStorage, sessionStorage].flatMap((s) => Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i)!)}`))
    expect(stored.filter((w) => w.includes("SECRET") || w.includes("upload_secret1"))).toEqual([])
    expect(readDraft("captain:prj_alpha1").text).toBe("SECRET plan")
  })
})
