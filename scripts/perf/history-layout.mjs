#!/usr/bin/env node
// Read-only layout/date-jump reproduction on an isolated seeded yard. CSS zoom exercises 125% layout sizing.
import assert from 'node:assert/strict'
const [base, label = 'run', output = '/tmp'] = process.argv.slice(2)
assert(base && new URL(base).port !== '3000')
assert.equal((await (await fetch(base + '/api/health')).json()).mock, true)
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const engine = process.env.HISTORY_BROWSER === 'webkit' ? webkit : chromium
const browser = await engine.launch(engine === chromium ? { executablePath: process.env.CHROME_PATH || undefined } : {})
for (const width of [320, 400, 560, 800]) for (const zoom of [1, 1.25]) {
  const page = await browser.newPage({ viewport: { width, height: 800 }, timezoneId: 'America/New_York' })
  const metadata = label.startsWith('before') ? Promise.resolve() : page.waitForResponse((r) => r.url().includes('/captain/history?days=1'))
  await page.goto(base + '/?captain=prj_heavy-yard')
  await metadata
  await page.waitForSelector('[data-testid="captain-chat"] nav button')
  await page.evaluate((zoom) => { document.documentElement.style.zoom = zoom }, zoom)
  await page.waitForTimeout(1200)
  await page.evaluate(() => { const nav = document.querySelector('[data-testid="captain-chat"] nav'); nav.scrollTop = 0 })
  await page.waitForTimeout(150)
  if (width === 800 && zoom === 1.25) await page.screenshot({ path: `${output}/${label}-${width}-${zoom}-before-jump.png` })
  await page.locator('[data-testid="captain-chat"] nav button').first().evaluate((button) => button.click())
  await page.waitForFunction(() => document.activeElement?.hasAttribute('data-day-start'))
  await page.waitForTimeout(100)
  const metrics = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="captain-chat"]'), header = panel.querySelector('header'), list = panel.querySelector('[data-scroller]')
    return { headerTop: header.getBoundingClientRect().top, headerBottom: header.getBoundingClientRect().bottom,
      outerScroll: [...document.querySelectorAll('*')].filter((e) => e.scrollTop && !['auto','scroll'].includes(getComputedStyle(e).overflowY)).map((e) => ({ tag: e.tagName, top: e.scrollTop })),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      dayTargetSize: panel.querySelector('nav button').getBoundingClientRect().height,
      dateVisible: document.activeElement.getBoundingClientRect().top < list.getBoundingClientRect().bottom && document.activeElement.getBoundingClientRect().bottom > list.getBoundingClientRect().top,
      focused: document.activeElement?.getAttribute('data-day-start'), rows: list.firstElementChild.children.length }
  })
  console.log(JSON.stringify({ label, browser: process.env.HISTORY_BROWSER ?? 'chromium', width, zoom, ...metrics }))
  if (width === 400 && zoom === 1 || width === 800 && zoom === 1.25) await page.screenshot({ path: `${output}/${label}-${width}-${zoom}.png` })
  await page.close()
}
await browser.close()
