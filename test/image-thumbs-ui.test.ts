// @vitest-environment happy-dom
// Images in chats and file lists load the server's small copy (shared/thumbs.ts), lazily and decoded off the main
// thread, with an attachment's box sized before it loads; a click still opens the original.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { AttachmentList, thumbBox } from "../web/src/components/Attachments.js"
import { PublishedCard } from "../web/src/components/PublishedNotices.js"
import { PublishedFile } from "../web/src/components/TaskFiles.js"
import { Markdown } from "../web/src/components/ui.js"
import { groupPublished, type PublishedGroup } from "../web/src/lib/publishedNotices.js"
import { keys } from "../web/src/lib/queries.js"
import type { Artifact, Attachment, ChatMessage } from "../shared/types.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let qc: QueryClient

beforeEach(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}))
  history.replaceState(null, "", "/")
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const k of [keys.tasks, keys.projects, keys.schedules, keys.boxes]) qc.setQueryData(k, [])
  qc.setQueryData(keys.artifacts, [])
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const render = (node: ReactNode) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, node)))
const img = (alt?: string) => host.querySelector<HTMLImageElement>(alt === undefined ? "img" : `img[alt="${alt}"]`)!

describe("thumbBox", () => {
  it("fits an image into 192×128 with its border, as the classes would once it loads", () => {
    expect(thumbBox({ width: 4032, height: 3024 })).toEqual({ width: 170, height: 128 })
    expect(thumbBox({ width: 3024, height: 4032 })).toEqual({ width: 97, height: 128 })
    expect(thumbBox({ width: 4000, height: 1000 })).toEqual({ width: 192, height: 50 })
    // Never enlarged.
    expect(thumbBox({ width: 64, height: 48 })).toEqual({ width: 66, height: 50 })
    expect(thumbBox({})).toBeNull()
  })
})

describe("attachment thumbnails", () => {
  const photo: Attachment = { id: "up_0123456789ab", name: "IMG_1001.jpg", size: 2_100_000, mime: "image/jpeg", width: 4032, height: 3024 }

  it("load the 640 px copy lazily in a box sized up front, and link the original", () => {
    render(createElement(AttachmentList, { files: [photo] }))
    const el = img("IMG_1001.jpg")
    expect(el.getAttribute("src")).toBe("/api/uploads/up_0123456789ab/IMG_1001.jpg?w=640")
    expect(el.getAttribute("loading")).toBe("lazy")
    expect(el.getAttribute("decoding")).toBe("async")
    expect([el.getAttribute("width"), el.getAttribute("height")]).toEqual(["170", "128"])
    expect(el.closest("a")!.getAttribute("href")).toBe("/api/uploads/up_0123456789ab/IMG_1001.jpg")
  })

  it("leave the size to the image when the server didn't know it (older messages)", () => {
    render(createElement(AttachmentList, { files: [{ ...photo, width: undefined, height: undefined }] }))
    expect(img("IMG_1001.jpg").hasAttribute("width")).toBe(false)
    expect(img("IMG_1001.jpg").hasAttribute("height")).toBe(false)
  })

  it("show an animated GIF as it is", () => {
    render(createElement(AttachmentList, { files: [{ ...photo, name: "spin.gif", mime: "image/gif" }] }))
    expect(img("spin.gif").getAttribute("src")).toBe("/api/uploads/up_0123456789ab/spin.gif")
  })
})

describe("published file thumbnails", () => {
  const notice = (n: number): ChatMessage => ({
    id: `chat_pub000${n}`,
    role: "notice",
    content: `📎 **Dark mode** published Shot ${n}: https://yard.example.com/artifacts/art_00000000000${n}/shot-${n}.png`,
    meta: { taskId: "task_darkmode" },
    createdAt: n,
  })

  it("the Coordinator's strip loads 320 px copies and opens the original", () => {
    const rows = groupPublished([notice(1), notice(2)])
    render(createElement(PublishedCard, { group: (rows[0] as { group: PublishedGroup }).group }))
    const imgs = [...host.querySelectorAll("img")]
    // In the Files drawer's order: newest first.
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual(["/artifacts/art_000000000002/shot-2.png?w=320", "/artifacts/art_000000000001/shot-1.png?w=320"])
    expect(imgs[1]!.closest("a")!.getAttribute("href")).toBe("/artifacts/art_000000000001/shot-1.png")
  })

  it("the task thread's chip loads the same 320 px copy, so the browser fetches it once", () => {
    const a: Artifact = { id: "art_000000000001", projectId: null, taskId: null, title: "Shot 1", filename: "shot-1.png", mime: "image/png", size: 900_000, url: "/artifacts/art_000000000001/shot-1.png", createdAt: 1 }
    qc.setQueryData(keys.artifacts, [a])
    render(createElement(PublishedFile, { artifactId: a.id, url: a.url, text: "Published artifact: Shot 1" }))
    expect(img().getAttribute("src")).toBe("/artifacts/art_000000000001/shot-1.png?w=320")
    expect(img().getAttribute("decoding")).toBe("async")
  })
})

describe("images in Markdown", () => {
  it("an image from another site is left alone", () => {
    render(createElement(Markdown, null, "![Logo](https://example.com/logo.png)"))
    expect(img("Logo").getAttribute("src")).toBe("https://example.com/logo.png")
  })
})
