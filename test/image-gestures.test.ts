import { describe, expect, it } from "vitest"
import { FIT, clampView, isDoubleTap, maxScale, pinchView, pixelRatio, swipeAction, zoomAt, zoomStep } from "../web/src/lib/imageGestures.js"

const fit = { width: 400, height: 800 }
const stage = { width: 400, height: 800 }

describe("zoom levels", () => {
  it("measures the image's own pixels against its fitted size", () => {
    expect(pixelRatio({ width: 1200, height: 2400 }, fit)).toBe(3)
    // Small enough to show at full size: it isn't scaled down, so 1×.
    expect(pixelRatio({ width: 200, height: 100 }, { width: 200, height: 100 })).toBe(1)
    // Not loaded yet.
    expect(pixelRatio({ width: 0, height: 0 }, { width: 0, height: 0 })).toBe(1)
  })

  it("zooms a tap to the image's own pixels, but at least 2× and at most 4×", () => {
    expect(zoomStep({ width: 1200, height: 2400 }, fit)).toBe(3)
    expect(zoomStep({ width: 400, height: 800 }, fit)).toBe(2)
    expect(zoomStep({ width: 4000, height: 8000 }, fit)).toBe(4)
  })

  it("lets a pinch go to 4×, or twice the image's own pixels", () => {
    expect(maxScale({ width: 400, height: 800 }, fit)).toBe(4)
    expect(maxScale({ width: 2400, height: 4800 }, fit)).toBe(12)
  })
})

describe("clampView", () => {
  it("keeps the scale between fit and the maximum", () => {
    expect(clampView({ scale: 0.5, x: 30, y: 30 }, fit, stage, 4)).toEqual(FIT)
    expect(clampView({ scale: 9, x: 0, y: 0 }, fit, stage, 4).scale).toBe(4)
  })

  it("pans no further than the zoomed image overflows the stage, so no edge shows a gap", () => {
    // 2×: 800×1600 in a 400×800 stage overflows 200 each side across and 400 up and down.
    expect(clampView({ scale: 2, x: 999, y: -999 }, fit, stage, 4)).toEqual({ scale: 2, x: 200, y: -400 })
    expect(clampView({ scale: 2, x: 50, y: 60 }, fit, stage, 4)).toEqual({ scale: 2, x: 50, y: 60 })
  })

  it("keeps an axis that still fits centred", () => {
    // A wide screenshot in a tall stage: at 2× it is 800×400, still shorter than the stage, so it stays centred vertically.
    expect(clampView({ scale: 2, x: 0, y: 150 }, { width: 400, height: 200 }, stage, 4)).toEqual({ scale: 2, x: 0, y: 0 })
  })
})

describe("pinchView and zoomAt", () => {
  it("keeps the image point under the fingers in place while zooming", () => {
    const at = { x: 100, y: -50 }
    const v = zoomAt(FIT, 2, at)
    expect(v).toEqual({ scale: 2, x: -100, y: 50 })
    // The image point that was at `at` (offset 100,-50 from the centre at 1×) is at x + scale × offset: still `at`.
    expect(v.x + v.scale * 100).toBe(at.x)
    expect(v.y + v.scale * -50).toBe(at.y)
  })

  it("follows the fingers' midpoint as they move", () => {
    const v = pinchView({ scale: 2, x: -100, y: 0 }, { x: 0, y: 0 }, { x: 30, y: 40 }, 1)
    expect(v).toEqual({ scale: 2, x: -70, y: 40 })
  })

  it("scales by how far the fingers spread", () => {
    expect(pinchView(FIT, { x: 0, y: 0 }, { x: 0, y: 0 }, 2.5).scale).toBe(2.5)
    expect(pinchView({ scale: 3, x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, 0.5).scale).toBe(1.5)
  })
})

describe("swipeAction", () => {
  it("steps to the next image on a leftward swipe and back on a rightward one", () => {
    expect(swipeAction(-80, 10, 500)).toBe("next")
    expect(swipeAction(80, -10, 500)).toBe("previous")
  })

  it("closes on a swipe down, never up", () => {
    expect(swipeAction(5, 140, 500)).toBe("close")
    expect(swipeAction(5, -140, 500)).toBeNull()
  })

  it("takes a quick flick at half the distance", () => {
    expect(swipeAction(-40, 0, 500)).toBeNull()
    expect(swipeAction(-40, 0, 150)).toBe("next")
    expect(swipeAction(0, 60, 150)).toBe("close")
  })

  it("ignores short and diagonal drags", () => {
    expect(swipeAction(-20, 5, 100)).toBeNull()
    expect(swipeAction(-90, 80, 500)).toBeNull()
  })
})

describe("isDoubleTap", () => {
  it("needs a second tap soon after, near the first", () => {
    expect(isDoubleTap(null, { x: 0, y: 0, t: 0 })).toBe(false)
    expect(isDoubleTap({ x: 0, y: 0, t: 0 }, { x: 10, y: 5, t: 200 })).toBe(true)
    expect(isDoubleTap({ x: 0, y: 0, t: 0 }, { x: 10, y: 5, t: 400 })).toBe(false)
    expect(isDoubleTap({ x: 0, y: 0, t: 0 }, { x: 60, y: 0, t: 100 })).toBe(false)
  })
})
