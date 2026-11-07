// Background work a tap doesn't need for its frame waits until that frame is on screen (lib/afterPaint.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { afterPaint } from "../web/src/lib/afterPaint.js"

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("afterPaint", () => {
  it("goes a task after the next frame, not before it", async () => {
    let frame: (() => void) | undefined
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => ((frame = fn), 1))
    const done = vi.fn()
    void afterPaint().then(done)
    await vi.advanceTimersByTimeAsync(100)
    expect(done).not.toHaveBeenCalled()
    frame!()
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toHaveBeenCalledOnce()
  })

  it("goes anyway when no frame comes, as in a background tab", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1)
    const done = vi.fn()
    void afterPaint().then(done)
    await vi.advanceTimersByTimeAsync(249)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toHaveBeenCalledOnce()
  })
})
