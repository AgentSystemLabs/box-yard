import { describe, expect, it } from "vitest"
import { keyboardInset } from "../web/src/lib/keyboardInset"

describe("keyboardInset", () => {
  it("is what the on-screen keyboard covers at the bottom of the window", () => {
    expect(keyboardInset(800, { height: 480, offsetTop: 0, scale: 1 })).toBe(320)
    // The browser scrolled the visual viewport up to show the field: only what is left under it is covered.
    expect(keyboardInset(800, { height: 480, offsetTop: 40, scale: 1 })).toBe(280)
    expect(keyboardInset(800, { height: 480.4, offsetTop: 0, scale: 1 })).toBe(320)
  })

  it("is nothing without a keyboard: no viewport, a full one, or a bar that only shaves the window", () => {
    expect(keyboardInset(800, null)).toBe(0)
    expect(keyboardInset(800, undefined)).toBe(0)
    expect(keyboardInset(800, { height: 800, offsetTop: 0, scale: 1 })).toBe(0)
    expect(keyboardInset(800, { height: 740, offsetTop: 0, scale: 1 })).toBe(0)
    expect(keyboardInset(800, { height: 820, offsetTop: 0, scale: 1 })).toBe(0)
  })

  it("leaves a pinch-zoomed page alone: its small visual viewport is not a keyboard", () => {
    expect(keyboardInset(800, { height: 400, offsetTop: 100, scale: 2 })).toBe(0)
  })
})
