// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Composer } from "../web/src/components/Composer.js"
import { useServerEvents } from "../web/src/lib/stream.js"
import {
  BACK_MS,
  RECONNECT_GRACE_MS,
  connectionState,
  reconnectNow,
  reportOnline,
  reportStream,
  resetConnection,
} from "../web/src/lib/connection.js"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakeEventSource {
  static all: FakeEventSource[] = []
  static OPEN = 1
  static CLOSED = 2
  readyState = 0
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  closed = false
  addEventListener() {}
  constructor(public url: string) {
    FakeEventSource.all.push(this)
  }
  open() {
    this.readyState = FakeEventSource.OPEN
    this.onopen?.()
  }
  fail() {
    this.readyState = FakeEventSource.CLOSED
    this.onerror?.()
  }
  close() {
    this.closed = true
    this.readyState = FakeEventSource.CLOSED
  }
}

const latest = () => FakeEventSource.all.at(-1)!

beforeEach(() => {
  vi.useFakeTimers()
  resetConnection()
})

afterEach(() => {
  resetConnection()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("connection store", () => {
  it("holds sends at once on a drop, but says nothing until the grace is over", () => {
    reportStream(false)
    expect(connectionState()).toEqual({ live: false, view: null })
    vi.advanceTimersByTime(RECONNECT_GRACE_MS)
    expect(connectionState()).toEqual({ live: false, view: "reconnecting" })
  })

  it("says offline when the browser does, and only the stream decides whether sends wait", () => {
    reportOnline(false)
    // On this computer (localhost) the stream stays open with the Wi-Fi off: nothing to say, sends go.
    expect(connectionState()).toEqual({ live: true, view: null })
    reportStream(false)
    vi.advanceTimersByTime(RECONNECT_GRACE_MS)
    expect(connectionState().view).toBe("offline")
    reportOnline(true)
    expect(connectionState().view).toBe("reconnecting")
  })

  it("says Reconnected for a moment after an outage it showed", () => {
    reportStream(false)
    vi.advanceTimersByTime(RECONNECT_GRACE_MS)
    reportStream(true)
    expect(connectionState()).toEqual({ live: true, view: "back" })
    vi.advanceTimersByTime(BACK_MS)
    expect(connectionState()).toEqual({ live: true, view: null })
  })

  it("a blip shorter than the grace comes and goes without a word", () => {
    reportStream(false)
    vi.advanceTimersByTime(RECONNECT_GRACE_MS - 500)
    reportStream(true)
    expect(connectionState()).toEqual({ live: true, view: null })
    vi.advanceTimersByTime(RECONNECT_GRACE_MS)
    expect(connectionState().view).toBeNull()
  })
})

describe("the stream and the composers, with a mocked EventSource", () => {
  let root: Root
  let host: HTMLElement
  let qc: QueryClient
  let sent: { resolve: () => void; reject: (e: Error) => void } | null
  const onSubmit = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        sent = { resolve, reject }
      }),
  )

  beforeEach(() => {
    FakeEventSource.all = []
    sent = null
    onSubmit.mockClear()
    vi.stubGlobal("EventSource", FakeEventSource)
    // The composer asks for its upload limit, and a reopened stream refetches; there's no server here.
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
    vi.stubGlobal("requestAnimationFrame", () => 1)
    vi.stubGlobal("cancelAnimationFrame", () => {})
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    const panel = createRef<HTMLElement>()
    function Stream() {
      useServerEvents(true)
      return null
    }
    act(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(Stream),
          createElement("section", { ref: panel }, createElement(Composer, { onSubmit, placeholder: "Ask", panelRef: panel })),
        ),
      ),
    )
    act(() => latest().open())
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  const textarea = () => document.querySelector("textarea")!
  const line = () => document.querySelector<HTMLElement>('[data-testid="connection-line"]')
  const button = (name: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent === name)
  const sendButton = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!
  function typeAndSend(text: string) {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
    act(() => {
      set.call(textarea(), text)
      textarea().dispatchEvent(new Event("input", { bubbles: true }))
    })
    act(() => void document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
  }
  const drop = () => act(() => latest().fail())
  const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms))

  it("live: a send goes straight out, with nothing over the box", () => {
    typeAndSend("hello")
    expect(onSubmit).toHaveBeenCalledWith("hello", [])
    expect(line()).toBeNull()
  })

  it("says Reconnecting after the grace, and Retry opens a new stream at once", () => {
    drop()
    expect(line()).toBeNull()
    wait(RECONNECT_GRACE_MS)
    expect(line()!.textContent).toContain("Reconnecting to Box Yard…")
    const before = FakeEventSource.all.length
    act(() => button("Retry")!.click())
    expect(FakeEventSource.all).toHaveLength(before + 1)
  })

  it("comes back with everything refetched and a short Reconnected", () => {
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    drop()
    wait(RECONNECT_GRACE_MS)
    // The stream's own retry.
    wait(2000)
    act(() => latest().open())
    expect(invalidate).toHaveBeenCalledWith()
    expect(line()!.textContent).toBe("Reconnected")
    wait(BACK_MS)
    expect(line()).toBeNull()
  })

  it("holds a message sent while the stream is down, and sends it once it's back", () => {
    drop()
    typeAndSend("hello")
    expect(onSubmit).not.toHaveBeenCalled()
    expect(textarea().value).toBe("hello")
    expect(line()!.textContent).toContain("Your message sends once it's back.")
    expect(sendButton().getAttribute("aria-label")).toBe("Waiting to send")
    // Pressing Send again keeps waiting; it doesn't force it.
    act(() => void document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    expect(onSubmit).not.toHaveBeenCalled()
    wait(2000)
    act(() => latest().open())
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith("hello", [])
    expect(textarea().value).toBe("")
    expect(sendButton().getAttribute("aria-label")).toBe("Send")
  })

  it("sends what the box holds when it's back, edits included", () => {
    drop()
    typeAndSend("hello")
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
    act(() => {
      set.call(textarea(), "hello there")
      textarea().dispatchEvent(new Event("input", { bubbles: true }))
    })
    act(() => reconnectNow())
    act(() => latest().open())
    expect(onSubmit).toHaveBeenCalledWith("hello there", [])
  })

  it("Send now tries at once; a failure puts the text back, no longer held", async () => {
    drop()
    typeAndSend("hello")
    act(() => button("Send now")!.click())
    expect(onSubmit).toHaveBeenCalledTimes(1)
    await act(async () => sent!.reject(new Error("Can't reach the Box Yard server.")))
    expect(textarea().value).toBe("hello")
    expect(sendButton().getAttribute("aria-label")).toBe("Send")
    act(() => reconnectNow())
    act(() => latest().open())
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it("Cancel keeps the text as a draft that doesn't go by itself", () => {
    drop()
    typeAndSend("hello")
    act(() => button("Cancel")!.click())
    expect(textarea().value).toBe("hello")
    expect(sendButton().getAttribute("aria-label")).toBe("Send")
    act(() => reconnectNow())
    act(() => latest().open())
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("emptying the box lets go of the held message", () => {
    drop()
    typeAndSend("hello")
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
    act(() => {
      set.call(textarea(), "")
      textarea().dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(line()).toBeNull()
    act(() => reconnectNow())
    act(() => latest().open())
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("the browser going offline replaces the stream, and the line says offline", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    act(() => void window.dispatchEvent(new Event("offline")))
    expect(FakeEventSource.all).toHaveLength(2)
    expect(FakeEventSource.all[0]!.closed).toBe(true)
    drop()
    wait(RECONNECT_GRACE_MS)
    expect(line()!.textContent).toContain("You're offline.")
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true)
    const before = FakeEventSource.all.length
    act(() => void window.dispatchEvent(new Event("online")))
    // Back online: a new stream at once, not at the next retry.
    expect(FakeEventSource.all).toHaveLength(before + 1)
    act(() => latest().open())
    expect(line()!.textContent).toBe("Reconnected")
  })
})
