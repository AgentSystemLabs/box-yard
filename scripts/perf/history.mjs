#!/usr/bin/env node
// Compare the same retained fixture on isolated mock servers. Run BEFORE building a changed version, then AFTER.
// PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROME_PATH=/path/to/chrome \
//   node scripts/perf/history.mjs http://localhost:4261 before 3
// Copy the same SQLite fixture into each server's independent data directory. Never use the live yard.
import assert from 'node:assert/strict'
const [base, label = 'run', count = '3'] = process.argv.slice(2)
assert(base && new URL(base).port !== '3000')
assert.equal((await (await fetch(base + '/api/health')).json()).mock, true)
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined })
const results = []
const r = (n) => Math.round(n * 10) / 10
for (let run = 0; run < Number(count); run++) for (const view of ['chat', 'captain', 'task']) {
  const path = view === 'chat' ? '/' : view === 'captain' ? '/?captain=prj_heavy-yard' : '/?session=task_heavy-thread'
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, timezoneId: 'America/New_York' })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')
  const main = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration').value * 1000
  let payload = 0
  const bodies = []
  page.on('response', (response) => { if (/\/api\/(boot|.*history|.*messages|captains\/recent)$/.test(new URL(response.url()).pathname)) bodies.push(response.body().then((body) => { payload += body.length }).catch(() => {})) })
  await page.goto(base + path)
  await page.waitForSelector('textarea')
  const root = view === 'chat' ? '[data-testid="chat-panel"]' : view === 'captain' ? '[data-testid="captain-chat"]' : '[data-testid="side-thread"]'
  await page.waitForSelector(root + ' [data-scroller]')
  await page.waitForTimeout(800)
  await page.evaluate((root) => { window.list = document.querySelector(root + ' [data-scroller]'); window.historyRoot = document.querySelector(root + ' [data-chat-history]') }, root)
  await Promise.all(bodies)
  const retained = await (await page.request.get(base + (view === "chat" ? "/api/chat" : view === "captain" ? "/api/projects/prj_heavy-yard/captain/messages" : "/api/tasks/task_heavy-thread/messages"))).json()
  const out = { label, run: run + 1, view, payloadBytes: payload,
    readyMs: await page.evaluate(() => performance.now()),
    domAtStart: await page.locator('*').count(),
    rowsAtStart: await page.evaluate(() => list.firstElementChild.children.length) }
  const textarea = page.locator(root + ' textarea').first()
  const beforeType = await main(), started = performance.now()
  await textarea.fill('Example draft for a retained history benchmark. '.repeat(4))
  await textarea.pressSequentially(' typing responsiveness', { delay: 0 })
  out.typingWallMs = r(performance.now() - started)
  out.typingMainMs = r(await main() - beforeType)
  await textarea.fill('')
  if (view === 'chat') {
    const before = await main()
    await page.request.post(base + '/api/dev/pulse', { data: { kind: 'chat.reply', count: 10, intervalMs: 100 } })
    await page.waitForTimeout(1800)
    out.streamMainMsPerReply = r((await main() - before) / 10)
  }
  // Five identical upward scroll steps: compare the same amount of work, rather than walking different API caps.
  let before = await main(), wall = performance.now()
  await page.evaluate(async () => { for (let i = 0; i < 5; i++) { list.scrollTop -= 600; await new Promise((resolve) => requestAnimationFrame(resolve)) } })
  await page.waitForTimeout(100)
  out.scrollWallMs = r(performance.now() - wall)
  out.scrollMainMs = r(await main() - before)
  // Prepend hidden rows with the sentinel, holding the first visible transcript row's viewport position.
  out.prepend = await page.evaluate(async () => {
    const target = [...list.firstElementChild.children].find((e) => e.getBoundingClientRect().bottom >= list.getBoundingClientRect().top && e.tagName !== 'BUTTON')
    const y = target?.getBoundingClientRect().top, t = performance.now()
    list.firstElementChild.querySelector(':scope > button')?.click()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return { wallMs: performance.now() - t, anchorShiftPx: target?.isConnected ? target.getBoundingClientRect().top - y : null }
  })
  // Same calendar date on both versions: the oldest date in the initial, capped response.
  // AFTER also measures a separate jump to the true beginning; that is additional work BEFORE cannot do.
  const jumpDate = async (at) => page.evaluate(async (at) => {
    const nav = historyRoot.querySelector('nav'); nav.scrollTop = 0
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const localDay = (at) => new Date(at).toDateString()
    const now = new Date(), yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1)
    const dayLabel = at === null ? null : localDay(at) === localDay(+now) ? 'Today' : localDay(at) === localDay(+yesterday) ? 'Yesterday' : new Date(at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(new Date(at).getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
    const first = dayLabel ? [...nav.querySelectorAll('button')].find((e) => e.getAttribute('aria-label').startsWith(dayLabel + ':')) : nav.querySelector('button')
    if (!first) throw new Error('Date is outside the benchmark rail window')
    const label = first.getAttribute('aria-label'), t = performance.now()
    document.activeElement?.blur()
    first.click()
    for (let i = 0; i < 120; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      if (document.activeElement?.hasAttribute('data-day-start')) break
    }
    return { wallMs: performance.now() - t, label, focused: document.activeElement?.getAttribute('data-day-start'), rows: list.firstElementChild.children.length }
  }, at)
  out.dateJump = await jumpDate(retained.find((m) => m.role !== 'tool').createdAt)
  out.oldestDateJump = await jumpDate(null)
  out.domAfterDate = await page.locator('*').count()
  out.header = await page.evaluate((root) => {
    const panel = document.querySelector(root), header = panel.querySelector('header')
    return { top: header?.getBoundingClientRect().top, panelTop: panel.getBoundingClientRect().top,
      outerScroll: [...document.querySelectorAll('*')].filter((e) => e.scrollTop && !['auto', 'scroll'].includes(getComputedStyle(e).overflowY)).map((e) => ({ tag: e.tagName, scrollTop: e.scrollTop })) }
  }, root)
  results.push(out)
  console.log(JSON.stringify(out))
  await context.close()
}
await browser.close()
const median = (xs) => xs.sort((a,b)=>a-b)[Math.floor(xs.length/2)]
const summary = Object.fromEntries(['chat', 'captain', 'task'].map((view) => {
  const rows = results.filter((r) => r.view === view)
  const merge = (example, pick) => Object.fromEntries(Object.entries(example).map(([key,value]) => [key,
    typeof value === 'number' ? r(median(rows.map((row) => pick(row)[key]))) : value && typeof value === 'object' && !Array.isArray(value) ? merge(value, (row) => pick(row)[key]) : value]))
  return [view, merge(rows[0], (row) => row)]
}))
console.log(JSON.stringify({ label, runs: Number(count), summary }, null, 2))
