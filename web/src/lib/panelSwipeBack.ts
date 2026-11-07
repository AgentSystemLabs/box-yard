// Touch-only dismissal for the full-screen conversation panel. Native browser edge gestures
// keep the outermost 8px; we own a gesture only after a cancelable, clearly horizontal move.
// The panel follows the finger, and on release it closes or snaps back at once: no settle animation.
type Point = { x: number; time: number }
type Drag = { id: number; x: number; y: number; width: number; href: string; locked: boolean; points: Point[] }
const EXCLUDED = 'a, button, input, textarea, select, label, summary, form, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="slider"], [role="separator"], pre, code, table, [data-swipe-back-ignore]'

/** Attaches to the shared dialog; moves its existing aside without re-rendering either transcript. */
export function bindPanelSwipeBack(root: HTMLElement, onClose: () => void, isTopmost: () => boolean) {
  const owner = root.closest('aside')
  if (!owner) return () => {}
  const original = { translate: owner.style.translate, transition: owner.style.transition, willChange: owner.style.willChange }
  let drag: Drag | undefined
  // Closed by a swipe: later touches wait for the panel to go (a history Back lands a moment later), not close twice.
  let closed = false
  const selection = () => Boolean(window.getSelection()?.toString())
  const eligible = () => {
    const box = owner.getBoundingClientRect()
    const host = owner.parentElement?.getBoundingClientRect()
    return isTopmost() && matchMedia('(pointer: coarse)').matches && box.width >= innerWidth - 1 && Boolean(host && Math.abs(host.left) <= 1)
  }
  const restore = () => {
    owner.style.translate = original.translate
    owner.style.transition = original.transition
    owner.style.willChange = original.willChange
  }
  const cancel = () => {
    drag = undefined
    closed = false
    restore()
  }
  const settle = (close: boolean) => {
    cancel()
    if (!close) return
    closed = true
    onClose()
  }
  const excluded = (target: Element) => {
    if (target.closest(EXCLUDED)) return true
    for (let el: Element | null = target; el && el !== root; el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true
    }
    return false
  }
  const start = (e: TouchEvent) => {
    if (e.touches.length !== 1) return cancel()
    if (closed || e.defaultPrevented || !eligible() || selection()) return
    const target = e.target instanceof Element ? e.target : null
    const touch = e.touches[0]!
    const box = owner.getBoundingClientRect()
    // The physical edge remains native, even when the touch happens on our header.
    if (!target || excluded(target) || touch.clientX < 8 ||
      (touch.clientX - box.left > 24 && !root.querySelector('header')?.contains(target))) return
    drag = { id: touch.identifier, x: touch.clientX, y: touch.clientY, width: box.width, href: location.href, locked: false, points: [{ x: touch.clientX, time: Date.now() }] }
  }
  const move = (e: TouchEvent) => {
    if (!drag) return
    if (e.touches.length !== 1 || e.defaultPrevented || !eligible() || selection() || !e.cancelable || drag.href !== location.href) return cancel()
    const touch = e.touches[0]!
    if (touch.identifier !== drag.id) return cancel()
    const dx = touch.clientX - drag.x, dy = touch.clientY - drag.y
    if (!drag.locked) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return
      if (dx < 10 || dx < Math.abs(dy) * 1.5) return cancel()
      drag.locked = true
      owner.style.transition = 'none'
      owner.style.willChange = 'translate'
    }
    e.preventDefault()
    drag.points.push({ x: touch.clientX, time: Date.now() })
    drag.points = drag.points.filter((p) => p.time >= Date.now() - 100)
    owner.style.translate = `${Math.max(0, Math.min(drag.width, dx))}px 0`
  }
  const end = (e: TouchEvent) => {
    if (!drag) return
    const touch = [...e.changedTouches].find((t) => t.identifier === drag!.id)
    if (e.touches.length || !touch || !drag.locked || e.defaultPrevented || !e.cancelable || !eligible() || selection() || drag.href !== location.href) return cancel()
    // A claimed touch must not synthesize a click on the chat revealed underneath it.
    if (e.cancelable) e.preventDefault()
    const dx = Math.max(0, touch.clientX - drag.x)
    const first = drag.points.find((p) => p.time >= Date.now() - 100)
    const speed = first && Date.now() > first.time ? (touch.clientX - first.x) / (Date.now() - first.time) : 0
    settle(dx >= drag.width * 0.35 || (dx >= 48 && speed >= 0.65))
  }
  const multi = (e: TouchEvent) => { if (e.touches.length > 1) cancel() }
  root.addEventListener('touchstart', start, { passive: true })
  root.addEventListener('touchmove', move, { passive: false })
  root.addEventListener('touchend', end, { passive: false })
  root.addEventListener('touchcancel', cancel)
  window.addEventListener('touchstart', multi, { passive: true, capture: true })
  // A native swipe/history change wins; cancel the pending close so it cannot go Back twice.
  const events = ['popstate', 'hashchange', 'pagehide', 'blur', 'resize'] as const
  for (const event of events) window.addEventListener(event, cancel)
  document.addEventListener('visibilitychange', cancel)
  return () => {
    cancel()
    root.removeEventListener('touchstart', start)
    root.removeEventListener('touchmove', move)
    root.removeEventListener('touchend', end)
    root.removeEventListener('touchcancel', cancel)
    window.removeEventListener('touchstart', multi, true)
    for (const event of events) window.removeEventListener(event, cancel)
    document.removeEventListener('visibilitychange', cancel)
  }
}
