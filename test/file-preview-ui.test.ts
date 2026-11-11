// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { FileLink, PREVIEW_GROUP } from "../web/src/components/FileLink.js"
import { FilePreviewHost } from "../web/src/components/FilePreview.js"
import { closePreview, openPreview, previewState } from "../web/src/lib/preview.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
/** Whether the last click reached the window un-cancelled (i.e. the browser would have followed the link). */
let followed: boolean | null
const stopNavigation = (e: Event) => {
  followed = !e.defaultPrevented
  e.preventDefault()
}

beforeEach(() => {
  history.replaceState(null, "", "/tasks/task_abcdef123456")
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  followed = null
  window.addEventListener("click", stopNavigation)
})

afterEach(() => {
  act(() => root.unmount())
  window.removeEventListener("click", stopNavigation)
  host.remove()
  document.body.innerHTML = ""
  vi.unstubAllGlobals()
})

const render = (node: ReactNode) => act(() => root.render(node))
const click = (el: Element, init: MouseEventInit = {}) => {
  const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })
  act(() => void el.dispatchEvent(e))
  // FileLink stops a handled click from bubbling (cards are links too), so read it off the event.
  if (followed === null) followed = !e.defaultPrevented
  return e
}
const preview = () => new URL(window.location.href).searchParams.get("preview")

function gallery() {
  return createElement(
    "div",
    PREVIEW_GROUP,
    createElement(FileLink, { href: "/artifacts/art_before01/before.png", id: "before" }, "before"),
    createElement(FileLink, { href: "/artifacts/art_after001/after.png", id: "after" }, "after"),
    createElement(FileLink, { href: "/artifacts/art_notes001/notes.md", id: "notes" }, "notes"),
    createElement(FileLink, { href: "/artifacts/art_bundle01/bundle.zip", id: "zip" }, "zip"),
  )
}
const $ = (id: string) => document.getElementById(id)!

describe("FileLink", () => {
  it("renders a normal new-tab link, so copy link and middle-click keep working", () => {
    render(gallery())
    const a = $("before") as HTMLAnchorElement
    expect(a.getAttribute("href")).toBe("/artifacts/art_before01/before.png")
    expect(a.target).toBe("_blank")
    expect(a.dataset.preview).toBe("image")
    expect(($("zip") as HTMLAnchorElement).dataset.preview).toBeUndefined()
  })

  it("opens the preview on a plain click, with the group's images as the gallery", () => {
    render(gallery())
    click($("after"))
    expect(followed).toBe(false)
    expect(preview()).toBe("art_after001")
    const s = previewState()!
    expect(s.items.map((i) => i.url)).toEqual(["/artifacts/art_before01/before.png", "/artifacts/art_after001/after.png"])
    expect(s.index).toBe(1)
    act(() => closePreview())
  })

  it("passes Cmd, Ctrl, Shift and middle clicks through to the browser", () => {
    render(gallery())
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }]) {
      followed = null
      click($("before"), init)
      expect(followed).toBe(true)
      expect(preview()).toBeNull()
    }
  })

  it("passes clicks on files it can't show through", () => {
    render(gallery())
    click($("zip"))
    expect(followed).toBe(true)
    expect(preview()).toBeNull()
  })

  it("opens a non-image file on its own, without a gallery", () => {
    render(gallery())
    click($("notes"))
    expect(preview()).toBe("art_notes001")
    expect(previewState()!.items).toHaveLength(1)
    act(() => closePreview())
  })
})

describe("preview URL state", () => {
  it("pushes ?preview= on open and closes with back", async () => {
    const before = history.length
    act(() => openPreview({ url: "/api/uploads/up_1/shot.png" }))
    expect(preview()).toBe("/api/uploads/up_1/shot.png")
    expect(history.length).toBe(before + 1)
    act(() => closePreview())
    await act(() => new Promise((r) => setTimeout(r, 20)))
    expect(preview()).toBeNull()
    expect(window.location.pathname).toBe("/tasks/task_abcdef123456")
  })

  it("swaps the preview in place when opened from inside a preview", () => {
    act(() => openPreview({ url: "/artifacts/art_aaaaaaa1/a.md" }))
    const length = history.length
    act(() => openPreview({ url: "/artifacts/art_bbbbbbb1/b.html" }))
    expect(history.length).toBe(length)
    expect(preview()).toBe("art_bbbbbbb1")
    act(() => closePreview())
  })
})

describe("FilePreviewHost", () => {
  const withClient = (node: ReactNode) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    qc.setQueryData(["artifacts"], [])
    return createElement(QueryClientProvider, { client: qc }, node)
  }
  const respond = (body: string, headers: Record<string, string> = {}) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers })))
  const settle = () => act(() => new Promise((r) => setTimeout(r, 20)))

  it("shows nothing without ?preview=", () => {
    render(withClient(createElement(FilePreviewHost)))
    expect(document.querySelector("[role=dialog]")).toBeNull()
  })

  it("pretty-prints JSON with line numbers and a Raw toggle", async () => {
    respond('{"ok":true,"n":[1,2]}')
    render(withClient(createElement(FilePreviewHost)))
    act(() => openPreview({ url: "/api/uploads/up_1/data.json", size: 22 }))
    await settle()
    const dialog = document.querySelector("[role=dialog]")!
    expect(dialog.getAttribute("aria-label")).toBe("data.json")
    expect(dialog.textContent).toContain('"ok": true')
    // One row per line: its number in the gutter, then its text.
    expect([...dialog.querySelectorAll("pre > span[aria-hidden]")].slice(0, 3).map((n) => n.textContent)).toEqual(["1", "2", "3"])
    click(dialog.querySelector('[aria-label="Show raw"]')!)
    expect(dialog.textContent).toContain('{"ok":true,"n":[1,2]}')
    act(() => closePreview())
  })

  it("renders CSV as a table", async () => {
    respond("name,count\nalpha,1\nbeta,2\n")
    render(withClient(createElement(FilePreviewHost)))
    act(() => openPreview({ url: "/api/uploads/up_1/rows.csv" }))
    await settle()
    const cells = [...document.querySelectorAll("[role=dialog] th, [role=dialog] td")].map((c) => c.textContent)
    expect(cells).toEqual(["name", "count", "alpha", "1", "beta", "2"])
    act(() => closePreview())
  })

  it("offers a new tab instead of previewing text over the cap", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    render(withClient(createElement(FilePreviewHost)))
    act(() => openPreview({ url: "/api/uploads/up_1/huge.log", size: 5 * 1024 * 1024 }))
    await settle()
    const dialog = document.querySelector("[role=dialog]")!
    expect(fetch).not.toHaveBeenCalled()
    expect(dialog.textContent).toContain("too big to preview")
    expect(dialog.querySelector('a[target="_blank"][href="/api/uploads/up_1/huge.log"]')).not.toBeNull()
    act(() => closePreview())
  })

  it("shows HTML in a sandboxed frame without same-origin access", async () => {
    render(withClient(createElement(FilePreviewHost)))
    act(() => openPreview({ url: "/artifacts/art_4c5d6e7f8a9b/arch.html" }))
    await settle()
    const frame = document.querySelector("[role=dialog] iframe")!
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts")
    expect(frame.getAttribute("src")).toBe("/artifacts/art_4c5d6e7f8a9b/arch.html")
    act(() => closePreview())
  })

  it("steps through the gallery with the arrow keys", async () => {
    render(withClient(createElement(FilePreviewHost)))
    const items = [{ url: "/artifacts/art_before01/before.png" }, { url: "/artifacts/art_after001/after.png" }]
    act(() => openPreview(items[0]!, items))
    await settle()
    expect(document.querySelector("[role=dialog] img")!.getAttribute("src")).toBe(items[0]!.url)
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })))
    expect(document.querySelector("[role=dialog] img")!.getAttribute("src")).toBe(items[1]!.url)
    expect(preview()).toBe("art_after001")
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })))
    expect(preview()).toBe("art_before01")
    act(() => closePreview())
  })
})

describe("image preview gestures", () => {
  const withClient = (node: ReactNode) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    qc.setQueryData(["artifacts"], [])
    return createElement(QueryClientProvider, { client: qc }, node)
  }
  const items = [
    { url: "/artifacts/art_before01/before.png", title: "Before at 400px" },
    { url: "/artifacts/art_after001/after.png", title: "After at 400px" },
  ]
  const stage = () => document.querySelector<HTMLElement>("[data-testid=image-stage]")!
  const image = () => stage().querySelector("img")!
  const transform = () => image().style.transform
  const pressed = (label: RegExp) => [...document.querySelectorAll("[role=dialog] button")].find((b) => label.test(b.getAttribute("aria-label") ?? ""))!

  /** happy-dom has no layout: a 400×800 stage at the origin, the image fitted to it, its own pixels 3× that. */
  function layout() {
    const el = stage()
    Object.defineProperties(el, { clientWidth: { value: 400, configurable: true }, clientHeight: { value: 800, configurable: true } })
    el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 800, width: 400, height: 800, x: 0, y: 0, toJSON: () => ({}) })
    const img = image()
    Object.defineProperties(img, {
      offsetWidth: { value: 400, configurable: true },
      offsetHeight: { value: 800, configurable: true },
      naturalWidth: { value: 1200, configurable: true },
      naturalHeight: { value: 2400, configurable: true },
    })
    act(() => void img.dispatchEvent(new Event("load")))
  }
  let nextId = 1
  const pointer = (type: string, x: number, y: number, init: PointerEventInit = {}) =>
    act(() => void (init.pointerType === "mouse" ? image() : stage()).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerType: "touch", clientX: x, clientY: y, ...init })))
  /** One finger from `from` to `to`. */
  function drag(from: [number, number], to: [number, number], pointerType = "touch") {
    const pointerId = nextId++
    pointer("pointerdown", ...from, { pointerId, pointerType })
    pointer("pointermove", ...to, { pointerId, pointerType })
    pointer("pointerup", ...to, { pointerId, pointerType })
  }
  const tap = (x: number, y: number) => drag([x, y], [x, y])

  function open(gallery = items) {
    render(withClient(createElement(FilePreviewHost)))
    act(() => openPreview(gallery[0]!, gallery))
    layout()
  }

  it("shows where it is in the gallery in the footer pager, never in the title a phone truncates", () => {
    open()
    expect(document.querySelector("[role=dialog] footer nav[aria-label=Files]")!.textContent).toContain("1 of 2")
    expect(document.querySelector("[role=dialog] header p")!.textContent).toBe("before.png · 1200×2400")
    act(() => closePreview())
  })

  it("steps to the next image on a swipe left and back on a swipe right", () => {
    open()
    drag([300, 400], [180, 410])
    expect(image().getAttribute("src")).toBe(items[1]!.url)
    expect(preview()).toBe("art_after001")
    layout()
    drag([100, 400], [260, 390])
    expect(image().getAttribute("src")).toBe(items[0]!.url)
    act(() => closePreview())
  })

  it("follows the finger, and settles back at fit when the drag is too short", () => {
    open()
    const pointerId = nextId++
    pointer("pointerdown", 300, 400, { pointerId })
    pointer("pointermove", 280, 402, { pointerId })
    expect(transform()).toBe("translate(-20px, 0px) scale(1)")
    pointer("pointerup", 280, 402, { pointerId })
    expect(transform()).toBe("")
    expect(image().getAttribute("src")).toBe(items[0]!.url)
    act(() => closePreview())
  })

  it("closes on a swipe down", () => {
    open()
    drag([200, 200], [205, 420])
    expect(previewState()).toBeNull()
    expect(document.querySelector("[role=dialog]")).toBeNull()
  })

  it("doesn't step an image on its own sideways", () => {
    open([items[0]!])
    drag([300, 400], [100, 400])
    expect(document.querySelector("[role=dialog]")).not.toBeNull()
    expect(image().getAttribute("src")).toBe(items[0]!.url)
    act(() => closePreview())
  })

  it("zooms to the image's own pixels on a double tap, about the tap, and back to fit on another", () => {
    open()
    tap(300, 400)
    expect(transform()).toBe("")
    tap(300, 400)
    // 3× about a point 100px right of centre: that image point stays under the finger (100 - 3 × 100 = -200).
    expect(transform()).toBe("translate(-200px, 0px) scale(3)")
    expect(pressed(/Fit to screen/).getAttribute("aria-pressed")).toBe("true")
    tap(300, 400)
    tap(300, 400)
    expect(transform()).toBe("")
    expect(pressed(/Zoom in/).getAttribute("aria-pressed")).toBe("false")
    act(() => closePreview())
  })

  it("pinches to zoom, then pans with one finger only as far as the image reaches", () => {
    open()
    pointer("pointerdown", 150, 400, { pointerId: 91 })
    pointer("pointerdown", 250, 400, { pointerId: 92 })
    pointer("pointermove", 100, 400, { pointerId: 91 })
    pointer("pointermove", 300, 400, { pointerId: 92 })
    expect(transform()).toBe("translate(0px, 0px) scale(2)")
    pointer("pointerup", 100, 400, { pointerId: 91 })
    pointer("pointerup", 300, 400, { pointerId: 92 })
    // Zoomed, a sideways drag pans (2× overflows 200px each side) instead of stepping to the next image.
    drag([100, 400], [700, 400])
    expect(transform()).toBe("translate(200px, 0px) scale(2)")
    expect(image().getAttribute("src")).toBe(items[0]!.url)
    act(() => closePreview())
  })

  it("zooms with the header button and a mouse click on the image", () => {
    open()
    click(pressed(/Zoom in/))
    expect(transform()).toBe("translate(0px, 0px) scale(3)")
    click(pressed(/Fit to screen/))
    expect(transform()).toBe("")
    drag([200, 100], [200, 100], "mouse")
    expect(transform()).toBe("translate(0px, 600px) scale(3)")
    act(() => closePreview())
  })

  // happy-dom's WheelEvent drops ctrlKey and clientX/Y, so they go on the event itself.
  const wheel = (init: WheelEventInit & { ctrlKey?: boolean; clientX?: number; clientY?: number }) => {
    const { ctrlKey = false, clientX = 0, clientY = 0, ...rest } = init
    const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...rest })
    Object.defineProperties(e, { ctrlKey: { value: ctrlKey }, clientX: { value: clientX }, clientY: { value: clientY } })
    act(() => void stage().dispatchEvent(e))
    return e
  }

  it("zooms about the pointer on Ctrl+wheel (a trackpad pinch) and pans with the wheel once zoomed", () => {
    open()
    // At fit size the wheel is left alone.
    expect(wheel({ deltaX: 30 }).defaultPrevented).toBe(false)
    expect(transform()).toBe("")
    expect(wheel({ ctrlKey: true, deltaY: -50, clientX: 200, clientY: 400 }).defaultPrevented).toBe(true)
    expect(transform()).toBe(`translate(0px, 0px) scale(${Math.exp(0.5)})`)
    wheel({ deltaY: 40 })
    expect(transform()).toBe(`translate(0px, -40px) scale(${Math.exp(0.5)})`)
    act(() => closePreview())
  })
})
