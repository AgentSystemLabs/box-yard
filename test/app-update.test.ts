// @vitest-environment happy-dom
// A tab that outlived a server upgrade (#330's sub-task tree showed flat on Cody's phone: its home-screen app still ran
// the build from before the restart, which ignores a task's parent). Each stream's "hello" names the build the server
// serves (server/webApp.ts webBuild, server/hub.ts); a page running another one reloads as Cody comes back to it, or
// offers Reload while that would lose something (web/src/lib/appUpdate.ts, lib/stream.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import fs from "node:fs"
import path from "node:path"
import type { Response } from "express"
import { Hub } from "../server/hub.js"
import { entryScript, webBuild } from "../server/webApp.js"
import { pageBuild, reloadPage, resetAppUpdate, updatePending, RESUME_GRACE_MS } from "../web/src/lib/appUpdate.js"
import { resetResumeState } from "../web/src/lib/resume.js"
import { useServerEvents } from "../web/src/lib/stream.js"
import { clearDraft, resetDrafts, setDraftText } from "../web/src/lib/composerDraft.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import type { StreamHello } from "../shared/boot.js"
import { tmpDir } from "./helpers.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** index.html as `vite build` writes it: the inline boot script first, then the entry. */
const built = (hash: string) =>
  `<!doctype html><html><head><script>(function () { var es = new EventSource("/api/stream?patches=1") })()</script>` +
  `<script type="module" crossorigin src="/assets/index-${hash}.js"></script>` +
  `<link rel="modulepreload" crossorigin href="/assets/rolldown-runtime-XKyaHtl9.js"></head><body><div id="root"></div></body></html>`

describe("the build a server serves", () => {
  it("is its index.html's entry script; a dev index.html (Vite serves /src/) has none", () => {
    expect(entryScript(built("BvRiOokK"))).toBe("/assets/index-BvRiOokK.js")
    expect(entryScript(`<script type="module" src="/src/main.tsx"></script>`)).toBeNull()
    expect(entryScript(`<script src="/assets/legacy-AAAAAAAA.js"></script>`)).toBeNull()
  })

  it("follows a rebuild, and is null while there's no index.html", () => {
    const dir = tmpDir()
    const current = webBuild(dir)
    expect(current()).toBeNull()
    fs.writeFileSync(path.join(dir, "index.html"), built("OLD11111"))
    expect(current()).toBe("/assets/index-OLD11111.js")
    fs.writeFileSync(path.join(dir, "index.html"), built("NEWER2222"))
    expect(current()).toBe("/assets/index-NEWER2222.js")
    fs.rmSync(path.join(dir, "index.html"))
    expect(current()).toBeNull()
  })

  it("is in every stream's hello", () => {
    const hub = new Hub()
    const hello = () => {
      let said: StreamHello | null = null
      const res = {
        writeHead() {},
        write(chunk: string) {
          const m = chunk.match(/^event: hello\ndata: (.+)\n\n$/)
          if (m) said = JSON.parse(m[1]!)
          return true
        },
        on() {},
        end() {},
      } as unknown as Response
      hub.attach(res)
      return said as StreamHello | null
    }
    expect(hello()?.web).toBeNull()
    hub.setWebBuild(() => "/assets/index-BvRiOokK.js")
    expect(hello()).toMatchObject({ seq: 0, web: "/assets/index-BvRiOokK.js" })
    hub.close()
  })
})

/** An EventSource that hears named events ("hello") as well as messages, like a browser's. */
class FakeEventSource extends EventTarget {
  static all: FakeEventSource[] = []
  static OPEN = 1
  static CLOSED = 2
  readyState = 0
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  constructor(public url: string) {
    super()
    FakeEventSource.all.push(this)
  }
  /** The server answered: open, and its hello names the build it serves. */
  hello(web: string | null) {
    this.readyState = FakeEventSource.OPEN
    this.onopen?.()
    this.dispatchEvent(new MessageEvent("hello", { data: JSON.stringify({ epoch: "e1", seq: 0, web }) }))
  }
  /** The server went away (a restart). */
  fail() {
    this.onerror?.()
  }
  close() {
    this.readyState = FakeEventSource.CLOSED
  }
}

describe("a tab running an older build than the server", () => {
  const OLD = "/assets/index-OLD11111.js"
  const NEW = "/assets/index-NEW22222.js"
  let root: Root
  let reloads: number
  let hidden = false
  const latest = () => FakeEventSource.all.at(-1)!
  const setHidden = (h: boolean) => {
    hidden = h
    document.dispatchEvent(new Event("visibilitychange"))
  }
  /** Cody leaves the app and comes back to it later. */
  const away = (ms = 60_000) =>
    act(() => {
      setHidden(true)
      vi.advanceTimersByTime(ms)
      setHidden(false)
    })
  /** The server restarts onto `web`: the stream drops, and the next one says hello. */
  const restartOnto = (web: string) => {
    act(() => latest().fail())
    act(() => void vi.advanceTimersByTime(2_000))
    act(() => latest().hello(web))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    hidden = false
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden })
    resetResumeState()
    resetDrafts()
    for (const t of currentToasts()) dismiss(t.id)
    reloads = 0
    vi.spyOn(reloadPage, "run").mockImplementation(() => void reloads++)
    // The page as index.html loaded it.
    document.head.innerHTML = `<script type="module" crossorigin src="${OLD}"></script>`
    resetAppUpdate()
    FakeEventSource.all = []
    vi.stubGlobal("EventSource", FakeEventSource)
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
    vi.stubGlobal("requestAnimationFrame", () => 1)
    vi.stubGlobal("cancelAnimationFrame", () => {})
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    function Probe() {
      useServerEvents(true)
      return null
    }
    act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Probe))))
    act(() => latest().hello(OLD))
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.head.innerHTML = ""
    document.body.innerHTML = ""
  })

  const reloadToast = () => currentToasts().find((t) => t.title === "Box Yard was updated")

  it("knows its own build from the entry script index.html loaded", () => {
    expect(pageBuild()).toBe(OLD)
    document.head.innerHTML = `<script type="module" src="/src/main.tsx"></script>`
    expect(pageBuild()).toBeNull()
  })

  it("does nothing while the server serves the build it runs", () => {
    restartOnto(OLD)
    away()
    expect(reloads).toBe(0)
    expect(reloadToast()).toBeUndefined()
    expect(updatePending()).toBe(false)
  })

  it("reloads as a thawed phone app reconnects to a server that restarted onto a newer build", () => {
    // Frozen in the background while the server restarted; back on screen, its stream is replaced and says hello.
    away(10 * 60_000)
    act(() => latest().hello(NEW))
    expect(reloads).toBe(1)
  })

  it("on screen when the server restarts: offers Reload, then reloads when Cody comes back to it", () => {
    vi.advanceTimersByTime(RESUME_GRACE_MS + 1)
    restartOnto(NEW)
    expect(reloads).toBe(0)
    const offer = reloadToast()
    expect(offer?.action?.label).toBe("Reload")
    // A reconnect to the same build doesn't ask again.
    restartOnto(NEW)
    expect(currentToasts().filter((t) => t.title === "Box Yard was updated")).toHaveLength(1)
    away()
    expect(reloads).toBe(1)
  })

  it("the toast's Reload reloads", () => {
    vi.advanceTimersByTime(RESUME_GRACE_MS + 1)
    restartOnto(NEW)
    act(() => reloadToast()!.action!.onClick())
    expect(reloads).toBe(1)
  })

  it("never reloads over an unsent draft or a dialog with unsaved changes; once they're gone it does", () => {
    setDraftText("coordinator", "half a message")
    away()
    restartOnto(NEW)
    expect(reloads).toBe(0)
    expect(reloadToast()).toBeDefined()
    away()
    expect(reloads).toBe(0)
    clearDraft("coordinator")

    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    dialog.setAttribute("data-dirty", "true")
    document.body.append(dialog)
    away()
    expect(reloads).toBe(0)
    dialog.remove()

    away()
    expect(reloads).toBe(1)
  })

  it("a page Vite serves in dev (no built entry script) never reloads", () => {
    document.head.innerHTML = `<script type="module" src="/src/main.tsx"></script>`
    resetAppUpdate()
    away()
    restartOnto(NEW)
    away()
    expect(reloads).toBe(0)
    expect(reloadToast()).toBeUndefined()
  })
})
