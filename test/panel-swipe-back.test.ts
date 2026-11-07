// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { bindPanelSwipeBack } from "../web/src/lib/panelSwipeBack"

let host: HTMLElement, aside: HTMLElement, root: HTMLElement, heading: HTMLElement, body: HTMLElement
let coarse: boolean, topmost: boolean
let close: ReturnType<typeof vi.fn>, cleanup: () => void
const point = (x: number, y = 100, identifier = 1) => ({ clientX: x, clientY: y, identifier })
function touch(target: Element, type: string, x: number, y = 100, options: { cancelable?: boolean; count?: number; identifier?: number } = {}) {
  const p = point(x, y, options.identifier)
  const e = new Event(type, { bubbles: true, cancelable: options.cancelable ?? true })
  Object.defineProperties(e, {
    touches: { value: type === "touchend" || type === "touchcancel" ? [] : options.count === 2 ? [p, point(x + 20, y, 2)] : [p] },
    changedTouches: { value: [p] },
  })
  target.dispatchEvent(e)
  return e
}
const start = (target: Element = heading, x = 100) => touch(target, "touchstart", x)
const move = (x: number, y = 100) => touch(heading, "touchmove", x, y)
const end = (x: number) => touch(heading, "touchend", x)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  coarse = true; topmost = true
  vi.stubGlobal("innerWidth", 400)
  vi.stubGlobal("matchMedia", vi.fn((q: string) => ({ matches: q.includes("coarse") && coarse })))
  history.replaceState(null, "", "/?session=task_demo01")
  host = document.createElement("section")
  host.innerHTML = '<aside><div role="dialog"><header><h2>Task title</h2><button>Back</button></header><p>Transcript</p><form><div>Composer padding</div><textarea></textarea></form><pre>long code</pre><table><tbody><tr><td>wide table</td></tr></tbody></table><div class="horizontal" style="overflow-x:auto"><span>overflow</span></div><a href="/">Link</a><div contenteditable="true">editable</div></div></aside>'
  document.body.append(host)
  aside = host.querySelector("aside")!
  root = host.querySelector('[role="dialog"]')!
  heading = host.querySelector("h2")!
  body = host.querySelector("p")!
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue({ width: 400, left: 0 } as DOMRect)
  vi.spyOn(aside, "getBoundingClientRect").mockReturnValue({ width: 400, left: 0 } as DOMRect)
  close = vi.fn()
  cleanup = bindPanelSwipeBack(root, close, () => topmost)
})
afterEach(() => {
  cleanup()
  host.remove()
  window.getSelection()?.removeAllRanges()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("phone conversation swipe Back", () => {
  it("follows a header drag, snaps a short slow swipe back at once, then closes at once past 35%", () => {
    start()
    vi.advanceTimersByTime(300)
    expect(move(220).defaultPrevented).toBe(true)
    expect(aside.style.translate).toBe("120px 0")
    expect(aside.style.transition).toBe("none")
    vi.advanceTimersByTime(200)
    expect(end(220).defaultPrevented).toBe(true)
    // Back in place on the release itself: no settle animation, and nothing left to run.
    expect(aside.style.translate).toBe("")
    expect(aside.style.transition).toBe("")
    expect(vi.getTimerCount()).toBe(0)
    expect(close).not.toHaveBeenCalled()
    start()
    vi.advanceTimersByTime(300)
    move(241)
    end(241)
    // Closed on the release itself, without first sliding off screen.
    expect(close).toHaveBeenCalledTimes(1)
    expect(aside.style.translate).toBe("")
    expect(vi.getTimerCount()).toBe(0)
    // Until the panel goes (its history Back lands a moment later), another swipe can't close it twice.
    start(); move(350); end(350)
    expect(close).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new PopStateEvent("popstate"))
    start(); move(350); end(350)
    expect(close).toHaveBeenCalledTimes(2)
  })

  it("accepts a short fast flick, but a pause at release does not keep old velocity", () => {
    start(body, 12)
    vi.advanceTimersByTime(50)
    touch(body, "touchmove", 82)
    vi.advanceTimersByTime(10)
    touch(body, "touchend", 82)
    expect(close).toHaveBeenCalledTimes(1)
    cleanup(); cleanup = bindPanelSwipeBack(root, close, () => topmost)
    start(body, 12)
    vi.advanceTimersByTime(50)
    touch(body, "touchmove", 82)
    vi.advanceTimersByTime(200)
    touch(body, "touchend", 82)
    expect(close).toHaveBeenCalledTimes(1)
    expect(aside.style.translate).toBe("")
  })

  it.each([[103, 160], [60, 103], [150, 145]])("leaves vertical, left and ambiguous diagonal gestures native (%i,%i)", (x, y) => {
    start()
    expect(move(x, y).defaultPrevented).toBe(false)
    expect(move(350).defaultPrevented).toBe(false)
    end(350)
    vi.advanceTimersByTime(300)
    expect(close).not.toHaveBeenCalled()
    expect(aside.style.translate).toBe("")
  })

  it("cancels on touchcancel, a second finger, changed identity and noncancelable native moves", () => {
    for (const cancel of [
      () => touch(heading, "touchcancel", 260),
      () => touch(document.body, "touchstart", 260, 100, { count: 2 }),
      () => touch(heading, "touchmove", 270, 100, { identifier: 2 }),
      () => touch(heading, "touchmove", 270, 100, { cancelable: false }),
      () => touch(heading, "touchend", 270, 100, { cancelable: false }),
    ]) {
      start(); move(260); cancel(); end(300)
      vi.advanceTimersByTime(300)
      expect(close).not.toHaveBeenCalled()
      expect(aside.style.translate).toBe("")
    }
  })

  it("never handles mouse/fine input or a docked panel, and gives the physical edge to the browser", () => {
    root.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", clientX: 100 }))
    coarse = false
    start(); move(300); end(300)
    coarse = true
    vi.stubGlobal("innerWidth", 1440)
    start(); move(300); end(300)
    vi.stubGlobal("innerWidth", 400)
    start(heading, 3); move(300); end(300)
    // Body gestures away from the left edge do not become panel gestures.
    start(body, 100); move(300); end(300)
    vi.advanceTimersByTime(300)
    expect(close).not.toHaveBeenCalled()
    expect(aside.style.translate).toBe("")
  })

  it.each(["button", "form div", "textarea", "pre", "td", "a", "[contenteditable]", ".horizontal span"])("leaves %s controls, composer and horizontal content alone", (selector) => {
    const scroll = root.querySelector(".horizontal")!
    Object.defineProperties(scroll, { scrollWidth: { value: 1000 }, clientWidth: { value: 100 } })
    const target = root.querySelector(selector)!
    start(target, 12)
    expect(touch(target, "touchmove", 300).defaultPrevented).toBe(false)
    touch(target, "touchend", 300)
    vi.advanceTimersByTime(300)
    expect(close).not.toHaveBeenCalled()
  })

  it("preserves selection, including a selection created during a pending gesture", () => {
    const select = () => { const range = document.createRange(); range.selectNodeContents(body); window.getSelection()!.addRange(range) }
    select(); start(); move(300); end(300)
    window.getSelection()!.removeAllRanges()
    start(); select(); move(300); end(300)
    vi.advanceTimersByTime(300)
    expect(close).not.toHaveBeenCalled()
  })

  it("drops a drag on native history, navigation, topmost changes or cleanup before the release", () => {
    for (const cancel of [
      () => window.dispatchEvent(new PopStateEvent("popstate")),
      () => history.replaceState(null, "", "/?captain=prj_demo01"),
      () => { topmost = false },
      () => cleanup(),
    ]) {
      history.replaceState(null, "", "/?session=task_demo01")
      topmost = true
      start(); move(300)
      cancel()
      end(300)
      expect(close).not.toHaveBeenCalled()
      expect(aside.style.translate).toBe("")
    }
  })

  it("never reads the motion preference or eases the panel: every user gets the instant release", () => {
    // Every style the panel wore on the way: only "none" (while it follows the finger) ever names a transition.
    const observer = new MutationObserver(() => {})
    observer.observe(aside, { attributes: true, attributeFilter: ["style"], attributeOldValue: true })
    start(); vi.advanceTimersByTime(300); move(170)
    expect(aside.style.translate).toBe("70px 0")
    end(170)
    start(); move(260); end(260)
    const styles = [...observer.takeRecords().map((r) => r.oldValue ?? ""), aside.getAttribute("style") ?? ""]
    observer.disconnect()
    expect(close).toHaveBeenCalledTimes(1)
    expect(styles.some((s) => s.includes("translate: 70px"))).toBe(true)
    expect(styles.filter((s) => /transition:(?! none)/.test(s))).toEqual([])
    expect(vi.mocked(matchMedia).mock.calls.map(([q]) => q).filter((q) => !q.includes("coarse"))).toEqual([])
  })
})
