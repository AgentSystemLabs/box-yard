// Zoom, pan and swipe maths for the image preview (components/FilePreview.tsx's ImageView): pinch and double-tap
// zoom, one-finger pan while zoomed, swipe left/right between images and down to close. Pure, so it is unit tested.
// A View is the image's CSS transform, `translate(x, y) scale(scale)` about its centre, on top of its fitted size.

export interface View {
  scale: number
  x: number
  y: number
}

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/** Fitted to the stage, not panned: how every image opens. */
export const FIT: View = { scale: 1, x: 0, y: 0 }

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

/** How many times the fitted image its own pixels are (1 for an image small enough to show at full size). */
export function pixelRatio(natural: Size, fit: Size): number {
  return fit.width > 0 && natural.width > 0 ? Math.max(1, natural.width / fit.width) : 1
}

/** The furthest a pinch or the wheel can zoom: 4×, or twice the image's own pixels if that's more. */
export function maxScale(natural: Size, fit: Size): number {
  return Math.max(4, 2 * pixelRatio(natural, fit))
}

/**
 * A tall image (a whole-page capture) shrunk to the stage's height, which leaves it a strip: under 60% of the stage's
 * width. Zooming one fills the width, as its own pixels at 2–4× would often still be a strip.
 */
export function isStrip(natural: Size, fit: Size, stage: Size): boolean {
  return fit.width > 0 && natural.width > fit.width && fit.width < stage.width * 0.6
}

/**
 * Where a double tap, a click, Z or the zoom button goes: the image's own pixels, but at least 2× and at most 4×.
 * With the `stage`, a strip goes to the stage's width instead, as far as maxScale lets it.
 */
export function zoomStep(natural: Size, fit: Size, stage?: Size): number {
  if (stage && isStrip(natural, fit, stage)) return Math.min(stage.width / fit.width, maxScale(natural, fit))
  return clamp(pixelRatio(natural, fit), 2, 4)
}

/**
 * Keeps the image on screen: the scale within 1…max, and the pan no further than the zoomed image overflows the
 * stage on each axis, so no edge it covers ever shows a gap (an axis that fits stays centred).
 */
export function clampView(v: View, fit: Size, stage: Size, max: number): View {
  const scale = clamp(v.scale, 1, max)
  const mx = Math.max(0, (fit.width * scale - stage.width) / 2)
  const my = Math.max(0, (fit.height * scale - stage.height) / 2)
  return { scale, x: clamp(v.x, -mx, mx), y: clamp(v.y, -my, my) }
}

/**
 * A pinch: the image point that was under the fingers' midpoint `from` when it started (at `start`) stays under the
 * midpoint `to`, scaled by how far the fingers spread (`spread`, the distance now over the distance then). Points are
 * relative to the stage's centre. With `to` = `from` it zooms about a fixed point (a double tap, the wheel).
 */
export function pinchView(start: View, from: Point, to: Point, spread: number): View {
  const scale = start.scale * spread
  const k = scale / start.scale
  return { scale, x: to.x - (from.x - start.x) * k, y: to.y - (from.y - start.y) * k }
}

/** Zooms to `scale` about `at` (relative to the stage's centre), keeping the image point there in place. */
export function zoomAt(v: View, scale: number, at: Point): View {
  return pinchView(v, at, at, scale / v.scale)
}

export type SwipeAction = "next" | "previous" | "close" | null

/** A drag this far is a swipe; a quick flick needs half as far. */
const SWIPE_PX = 60
const CLOSE_PX = 100
const FLICK_MS = 300

/**
 * What a one-finger drag on an image at fit size did, from how far it moved (dx, dy) in how long: mostly sideways
 * steps through the gallery (a leftward swipe shows the next image, as on a phone), mostly down closes the preview,
 * anything shorter or diagonal does nothing.
 */
export function swipeAction(dx: number, dy: number, ms: number): SwipeAction {
  const quick = ms < FLICK_MS
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax > ay * 1.5 && ax >= (quick ? SWIPE_PX / 2 : SWIPE_PX)) return dx < 0 ? "next" : "previous"
  if (dy > ax * 1.5 && ay >= (quick ? CLOSE_PX / 2 : CLOSE_PX)) return "close"
  return null
}

/** A finger that moves less than this between down and up tapped. */
export const TAP_SLOP_PX = 10

export interface Tap extends Point {
  t: number
}

/** A second tap close enough in time (within `ms`) and place to the first to be a double tap. */
export function isDoubleTap(prev: Tap | null, now: Tap, ms = 300): boolean {
  return !!prev && now.t - prev.t < ms && Math.hypot(now.x - prev.x, now.y - prev.y) < 30
}
