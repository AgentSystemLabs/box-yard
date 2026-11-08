// Runs in a real browser. Measurements use computed sRGB colours, not palette names.
// Alpha is composited through every ancestor (including group opacity). Images, gradients,
// masks and overlapping siblings need separate review; they are recorded, never silently passed.
export function computedContrast() {
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true })
  canvas.width = canvas.height = 1
  const colour = (css) => {
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
    return [r, g, b, a / 255]
  }
  const over = (a, b) => {
    const alpha = a[3] + b[3] * (1 - a[3])
    return alpha ? [0, 1, 2].map((i) => (a[i] * a[3] + b[i] * b[3] * (1 - a[3])) / alpha).concat(alpha) : [0, 0, 0, 0]
  }
  const luminance = (c) => c.slice(0, 3).map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((v, n, i) => v + n * [.2126, .7152, .0722][i], 0)
  const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05)
  const chain = (el) => { const out = []; for (; el; el = el.parentElement) out.push(getComputedStyle(el)); return out }
  const paint = (styles, ink) => {
    let out = ink ?? [0, 0, 0, 0]
    for (const style of styles) { out = over(out, colour(style.backgroundColor)); out[3] *= Number(style.opacity) }
    return over(out, [255, 255, 255, 1])
  }
  const visible = (el, rect) => {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || !rect || rect.width <= 2 || rect.height <= 2) return false
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight
    for (let p = el; p; p = p.parentElement) {
      const s = getComputedStyle(p), r = p.getBoundingClientRect()
      if (s.overflowX !== 'visible') { left = Math.max(left, r.left); right = Math.min(right, r.right) }
      if (s.overflowY !== 'visible') { top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom) }
    }
    return rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom
  }
  const scope = [...document.querySelectorAll('[role=dialog],dialog')].filter((e) => e.checkVisibility()).at(-1) ?? document.body
  const describe = (el) => ({ tag: el.tagName, text: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 100), class: typeof el.className === 'string' ? el.className : el.getAttribute('class') })
  const measurements = [], manual = [], exempt = []
  const complexPaint = (styles) => {
    let behind = true
    for (const s of styles) {
      if (s.maskImage !== 'none' || s.filter !== 'none' || (behind && (s.backgroundImage !== 'none' || s.backdropFilter !== 'none'))) return true
      if (colour(s.backgroundColor)[3] === 1) behind = false
      if (Number(s.opacity) < 1) behind = true
    }
    return false
  }
  const measure = (el, ink, minimum, kind, label) => {
    const styles = chain(el), fg = paint(styles, colour(ink)), bg = paint(styles)
    const record = { ...describe(el), ...(label ? { text: label } : {}), kind, ratio: ratio(fg, bg), minimum, fg: fg.slice(0, 3), bg: bg.slice(0, 3) }
    if (el.closest(':disabled,[aria-disabled=true]')) exempt.push({ ...record, reason: 'inactive control' })
    else if (complexPaint(styles)) manual.push(record)
    else measurements.push(record)
  }
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
  for (let node; (node = walker.nextNode());) {
    const el = node.parentElement
    if (!node.textContent.trim() || el.closest('script,style,option,.sr-only,[aria-hidden=true]')) continue
    const range = document.createRange(); range.selectNodeContents(node)
    if (![...range.getClientRects()].some((r) => visible(el, r))) continue
    const s = getComputedStyle(el), large = parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.6667 && Number(s.fontWeight) >= 700)
    measure(el, s.color, large ? 3 : 4.5, 'text', node.textContent.trim().slice(0, 100))
  }
  for (const el of scope.querySelectorAll('input:not([type=checkbox]):not([type=radio]),textarea,select')) {
    if (!visible(el, el.getBoundingClientRect())) continue
    const s = getComputedStyle(el)
    measure(el, s.color, 4.5, 'value')
    if (el.placeholder && !el.value) measure(el, getComputedStyle(el, '::placeholder').color, 4.5, 'placeholder')
    // A text field needs a discernible boundary even when empty. The transparent composer
    // textarea delegates that boundary to its enclosing box.
    const border = parseFloat(s.borderTopWidth) ? el : el.closest('[data-composer-box]')
    if (border) {
      const bs = getComputedStyle(border)
      measure(border, bs.borderTopColor, 3, 'field-boundary')
      const outside = chain(border.parentElement), ink = paint(outside, colour(bs.borderTopColor)), bg = paint(outside)
      const record = { ...describe(border), kind: 'field-boundary-outside', ratio: ratio(ink, bg), minimum: 3, fg: ink.slice(0, 3), bg: bg.slice(0, 3) }
      if (!border.closest(':disabled,[aria-disabled=true]') && !el.disabled) measurements.push(record)
    }
  }
  // Icon-only controls and icons that carry task/PR/status information. Other icons are redundant
  // to adjacent readable words, so keep them in the evidence without making them a text check.
  for (const el of scope.querySelectorAll('svg')) {
    if (!visible(el, el.getBoundingClientRect())) continue
    const control = el.closest('button,a,[role=button]'), text = control?.textContent.trim()
    if ((control && !text) || el.closest('[data-testid=task-status-icon],[data-pr-state]')) measure(el, getComputedStyle(el).color, 3, 'icon')
  }
  return { measurements, failures: measurements.filter((m) => m.ratio < m.minimum), manual, exempt }
}
