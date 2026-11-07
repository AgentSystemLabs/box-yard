// Background work a tap doesn't need for its frame (refetching what's on screen, counts behind a menu) waits until that
// frame is on screen: on a phone, a fetch started inside the tap that opened a Captain cost 10 ms before its first paint.

/** If no frame comes (a background tab), what waits goes after this long anyway. */
const FRAME_FALLBACK_MS = 250

/** Resolves once the next frame is on screen (a frame and a task later), or after FRAME_FALLBACK_MS without frames. */
export function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    const fallback = setTimeout(resolve, FRAME_FALLBACK_MS)
    requestAnimationFrame(() =>
      setTimeout(() => {
        clearTimeout(fallback)
        resolve()
      }, 0),
    )
  })
}
