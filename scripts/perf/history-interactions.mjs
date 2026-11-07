#!/usr/bin/env node
// Native scrolling + streaming + four bounded prepends in Chromium or WebKit, against an isolated heavy mock.
import assert from 'node:assert/strict'
const [base] = process.argv.slice(2)
assert(base && new URL(base).port !== '3000')
assert.equal((await (await fetch(base + '/api/health')).json()).mock, true)
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const engine = process.env.HISTORY_BROWSER === 'webkit' ? webkit : chromium
const browser = await engine.launch(engine === chromium ? { executablePath: process.env.CHROME_PATH || undefined } : {})
try {
  const page = await browser.newPage({ viewport: { width: 400, height: 800 } })
  await page.goto(base)
  await page.waitForSelector('[data-testid="chat-panel"] [data-scroller]')
  await page.waitForTimeout(1200)
  if (process.env.HISTORY_ZOOM) {
    await page.evaluate((zoom) => { document.documentElement.style.zoom = zoom }, Number(process.env.HISTORY_ZOOM))
    await page.waitForTimeout(250)
  }
  await page.evaluate(() => {
    window.list = document.querySelector('[data-testid="chat-panel"] [data-scroller]')
    window.beforeWheel = list.scrollTop
  })
  const bounds = await page.locator('[data-testid="chat-panel"] [data-scroller]').boundingBox()
  await page.mouse.move(bounds.x + bounds.width / 2, Math.min(bounds.y + bounds.height / 2, 750))
  await page.mouse.wheel(0, -2400)
  // wheel() returns before compositor scrolling finishes. Do not mix an immediate scripted scroll into it:
  // a delayed native scroll would otherwise move the benchmark's anchor after measurement has begun.
  await page.waitForFunction(() => list.scrollTop < beforeWheel - 500)
  await page.evaluate(async () => {
    let previous = list.scrollTop, still = 0
    for (let frames = 0; frames < 120 && still < 5; frames++) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const top = list.scrollTop
      still = top === previous ? still + 1 : 0
      previous = top
    }
    if (still < 5) throw new Error('Native wheel setup did not settle')
  })
  const mark = async () => page.evaluate(() => {
    window.anchor = [...list.firstElementChild.children].find((e) => e.tagName !== 'BUTTON' && e.getBoundingClientRect().bottom > list.getBoundingClientRect().top)
    window.anchorTop = anchor.getBoundingClientRect().top
  })
  const shift = async () => page.evaluate(() => anchor.isConnected ? anchor.getBoundingClientRect().top - anchorTop : null)
  await mark()
  await page.request.post(base + '/api/dev/pulse', { data: { kind: 'chat.stream', count: 20, intervalMs: 50 } })
  await page.waitForTimeout(1600)
  const streamShift = await shift()
  assert(streamShift !== null && Math.abs(streamShift) <= 1, `Streaming shifted the reading anchor by ${streamShift}`)
  const prepends = []
  for (let i = 0; i < 4; i++) {
    // Native scroll event releases the pin before the prepend. Stay near the top so the anchor survives the window.
    await page.evaluate(() => { list.scrollTop = 150 })
    await page.waitForTimeout(100)
    await mark()
    await page.evaluate(() => list.firstElementChild.querySelector(':scope > button')?.click())
    await page.waitForTimeout(150)
    const moved = await shift()
    assert(moved !== null && Math.abs(moved) <= 1, `Prepend shifted the reading anchor by ${moved}`)
    prepends.push(moved)
  }
  console.log(JSON.stringify({ browser: process.env.HISTORY_BROWSER ?? 'chromium', streamShift, prepends,
    rows: await page.evaluate(() => list.firstElementChild.children.length),
    headerTop: await page.locator('[data-testid="chat-panel"] header').evaluate((e) => e.getBoundingClientRect().top) }))
} finally {
  await browser.close()
}
