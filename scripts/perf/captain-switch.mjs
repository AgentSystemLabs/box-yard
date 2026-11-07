#!/usr/bin/env node
// Measures Captain switching against a mock yard with Captain transcripts (BOXYARD_MOCK=1 BOXYARD_MOCK_HEAVY=1,
// then rows in captain_messages). Two parts:
// - load, over fresh pages: first paint, the Coordinator's chat on screen, long tasks in its first 4 s, how long clicks
//   take while the app settles (one every 150 ms for 3 s), and when the Captain prefetch ran;
// - switching: after the app has sat idle (--wait, 10 s), click a project's sidebar row → its Captain's conversation
//   painted, for every Captain, then again, with the rows that first frame had.
// Read-only: nothing is sent. Only an isolated mock server is accepted.
// PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROMIUM_PATH=/path/to/chrome \
//   node scripts/perf/captain-switch.mjs http://localhost:4001 /tmp/captain-switch [--phone] [--strip] [--runs=5]
// --phone: 4× CPU slowdown and a 150 ms, 10 Mbit/s network, like a phone on Tailscale. --strip: frames of one switch
// from a Captain sat on for --wait to another (strip.png). --load-only: just the load part. --wait=<ms>: idle first.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
const [base, out, ...flags] = process.argv.slice(2)
if (!base || !out) throw new Error('Pass an isolated mock URL and an output directory')
const phone = flags.includes('--phone'), strip = flags.includes('--strip'), loadOnly = flags.includes('--load-only')
const runs = Number(flags.find((f) => f.startsWith('--runs='))?.slice(7) ?? 5)
const wait = Number(flags.find((f) => f.startsWith('--wait='))?.slice(7) ?? 10_000)
const url = new URL(base)
assert(['localhost', '127.0.0.1'].includes(url.hostname) && url.port !== '3000', 'Use an isolated loopback port')
assert.equal((await (await fetch(new URL('/api/health', base))).json()).mock, true)
const projects = await (await fetch(new URL('/api/projects', base))).json()
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--mute-audio'] })
await fs.mkdir(out, { recursive: true })
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null)
const round = (x) => (x === null ? null : Math.round(x))
const rowFor = (page, p) => page.locator(`button[title^="Talk to the ${p.name} Captain"]`)

async function openPage(width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 900 } })
  await context.addInitScript(() => {
    localStorage.setItem('box-yard:setup-skipped', 'true')
    localStorage.setItem('boxyard:voice', JSON.stringify({ enabled: false }))
    window.__perf = { long: [], clicks: [] }
    new PerformanceObserver((l) => window.__perf.long.push(...l.getEntries().map((e) => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: true })
    new PerformanceObserver((l) => window.__perf.clicks.push(...l.getEntries().filter((e) => e.name === 'click').map((e) => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'event', durationThreshold: 16, buffered: true })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const cdp = await context.newCDPSession(page)
  if (phone) {
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (10 * 1024 * 1024) / 8, uploadThroughput: (5 * 1024 * 1024) / 8 })
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  }
  await page.goto(new URL('/', base).href)
  await page.locator('[data-testid=chat-panel] [data-chat-id]').first().waitFor({ timeout: 60_000 })
  return { context, page, cdp, errors, ready: await page.evaluate(() => performance.now()) }
}

// ---- load
const loads = []
for (let i = 0; i < runs; i++) {
  const { context, page, errors, ready } = await openPage()
  // Clicks while the app settles: fold and unfold the first project's tasks every 150 ms for 3 s.
  const fold = page.locator('button[aria-label$=" tasks"]').first()
  const until = Date.now() + 3000
  while (Date.now() < until) {
    await fold.click()
    await page.waitForTimeout(150)
  }
  await page.waitForTimeout(2000)
  loads.push(await page.evaluate((ready) => {
    const long = window.__perf.long.filter((e) => e.start < ready + 4000)
    const prefetch = performance.getEntriesByType('resource').find((e) => e.name.includes('/api/captains/recent'))
    // Main-thread work right after the prefetch lands (parsing and seeding it), if any of it ran long.
    const afterPrefetch = prefetch ? window.__perf.long.filter((e) => e.start + e.duration >= prefetch.responseEnd && e.start < prefetch.responseEnd + 1000) : []
    // Event Timing only reports clicks over 16 ms, so the rest count as 16.
    const clicks = window.__perf.clicks.map((e) => e.duration)
    return {
      fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
      ready,
      longTaskMs: long.reduce((s, e) => s + e.duration, 0),
      blockingMs: long.reduce((s, e) => s + Math.max(0, e.duration - 50), 0),
      worstClick: clicks.length ? Math.max(...clicks) : 16,
      prefetchStart: prefetch ? prefetch.startTime : null,
      prefetchEnd: prefetch ? prefetch.responseEnd : null,
      prefetchBytes: prefetch ? prefetch.transferSize : null,
      prefetchLongTaskMs: afterPrefetch.reduce((s, e) => s + e.duration, 0),
      apiRequests: performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/') && e.startTime < ready + 4000).length,
    }
  }, ready))
  if (errors.length) throw new Error(errors.join('; '))
  await context.close()
}
const load = Object.fromEntries(Object.keys(loads[0]).map((k) => [k, round(median(loads.map((l) => l[k]).filter((v) => v !== null)))]))

if (loadOnly) {
  await browser.close()
  console.log(JSON.stringify({ load: { runs, ...load }, each: loads.map((l) => Object.fromEntries(Object.entries(l).map(([k, v]) => [k, round(v)]))) }, null, 1))
  process.exit(0)
}

// ---- switching
const { context, page, errors } = await openPage()
await page.waitForTimeout(wait)
const switchTo = async (p) => {
  const row = rowFor(page, p)
  await row.scrollIntoViewIfNeeded()
  // `paint`: from the click to the first frame painted after it (Event Timing, as INP counts it), when that frame has the
  // Captain's title and a message. `ms`: to the frame after that one, so it includes any work right after the paint
  // (the rest of the newest 60 rows). `blank`: a frame showed the Captain without its conversation.
  await page.evaluate((name) => {
    window.__switch = new Promise((resolve) => {
      document.addEventListener('click', (e) => {
        const start = e.timeStamp
        let blank = false
        let frames = 0
        const tick = () => {
          const chat = [...document.querySelectorAll('[data-testid=captain-chat]')].find((c) => c.checkVisibility())
          const onIt = (chat?.querySelector('[data-testid=chat-title]')?.textContent ?? '').startsWith(name)
          if (onIt && chat.querySelector('[data-chat-id], [id^=captain-]')) {
            const rows = chat.querySelectorAll('[data-chat-id]').length
            return requestAnimationFrame(() => resolve({ start, ms: performance.now() - start, blank, rows, frames }))
          }
          if (onIt) blank = true
          frames++
          requestAnimationFrame(tick)
        }
        tick()
      }, { capture: true, once: true })
    })
  }, p.name)
  await row.click()
  const { start, ...r } = await page.evaluate(() => window.__switch)
  await page.waitForTimeout(600)
  // Event Timing reports only clicks over 16 ms; a later first frame doesn't count (`paint` is then null).
  const timing = await page.evaluate((start) => window.__perf.clicks.find((c) => Math.abs(c.start - start) < 1), start)
  return { ...r, paint: r.frames === 1 ? (timing?.duration ?? 16) : null }
}
const visible = []
for (const p of projects) if (await rowFor(page, p).count()) visible.push(p)
const first = [], again = []
for (const p of visible) first.push({ project: p.name, ...(await switchTo(p)) })
for (const p of visible) again.push({ project: p.name, ...(await switchTo(p)) })
if (errors.length) throw new Error(errors.join('; '))
await context.close()

// ---- a strip of one switch, from a Captain sat on for a while to another
let frames = null
if (strip) {
  const { context, page, cdp } = await openPage(1000)
  await rowFor(page, visible.at(-2)).click()
  await page.locator('[data-testid=captain-chat] [data-chat-id]').first().waitFor()
  await page.waitForTimeout(wait)
  const p = visible.at(-1)
  const shots = []
  cdp.on('Page.screencastFrame', async (f) => {
    shots.push({ at: f.metadata.timestamp * 1000, data: f.data })
    await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 1000, maxHeight: 900 })
  await page.waitForTimeout(500)
  const clickedAt = Date.now()
  await rowFor(page, p).click()
  await page.waitForTimeout(1500)
  await cdp.send('Page.stopScreencast')
  frames = [0, 50, 100, 150, 200, 300, 450, 700]
  // Each offset shows the frame on screen then: the last one painted at or before it.
  const pick = frames.map((ms) => ({ ms, data: (shots.filter((s) => s.at <= clickedAt + ms).at(-1) ?? shots[0])?.data }))
  const sheet = await context.newPage()
  await sheet.setViewportSize({ width: 4 * 410 + 10, height: 2 * 410 })
  await sheet.setContent(`<body style="margin:0;background:#111;font:15px system-ui;color:#ddd;display:grid;grid-template-columns:repeat(4,400px);gap:10px;padding:5px">${pick
    .map((f) => `<figure style="margin:0"><img src="data:image/png;base64,${f.data}" style="width:400px;display:block;border:1px solid #333"><figcaption style="padding:4px">+${f.ms} ms</figcaption></figure>`)
    .join('')}</body>`)
  await sheet.screenshot({ path: `${out}/strip.png`, fullPage: true })
  await context.close()
}
await browser.close()

// `late`: switches whose first frame after the click didn't have the conversation yet (no `paint` for them).
const switches = (rs) => ({
  paintMedianMs: round(median(rs.map((r) => r.paint).filter((v) => v !== null))),
  paintMaxMs: round(Math.max(...rs.map((r) => r.paint ?? 0))),
  late: rs.filter((r) => r.paint === null).length,
  medianMs: round(median(rs.map((r) => r.ms))),
  maxMs: round(Math.max(...rs.map((r) => r.ms))),
  blank: rs.filter((r) => r.blank).length,
  rows: median(rs.map((r) => r.rows)),
  of: rs.length,
})
const summary = {
  mode: phone ? 'phone (4× CPU, 150 ms, 10 Mbit/s)' : 'desktop',
  load: { runs, ...load },
  loads: loads.map((l) => Object.fromEntries(Object.entries(l).map(([k, v]) => [k, round(v)]))),
  waitMs: wait,
  firstSwitch: switches(first),
  againSwitch: switches(again),
  each: first.map((r, i) => ({ project: r.project, paint: round(r.paint), first: round(r.ms), blank: r.blank, rows: r.rows, againPaint: round(again[i].paint), again: round(again[i].ms) })),
  strip: frames,
}
await fs.writeFile(`${out}/summary.json`, JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
