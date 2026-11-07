#!/usr/bin/env node
// Measures the first load and the surfaces that load on demand (components/LazyPart.tsx), against a mock yard
// (BOXYARD_MOCK=1 BOXYARD_MOCK_HEAVY=1). Two parts, each over fresh pages with an empty cache:
// - load: the JavaScript fetched before the Coordinator's composer is in the DOM (bytes and files), first paint, when
//   the composer appeared (timed in the page), and long tasks until then;
// - open: Settings (its sidebar button; on --phone, ?settings=), a project's settings (?projectSettings=) and all
//   schedules (?schedule=all), from the change to the frame after their content is on screen. By default once the
//   background warm-up has run (8 s; 4 s on desktop); --cold opens Settings the moment the composer appears.
// Read-only: nothing is sent. Only an isolated mock server is accepted.
// PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROMIUM_PATH=/path/to/chrome \
//   node scripts/perf/first-load.mjs http://localhost:4001 [--phone] [--cold] [--runs=7]
// --phone: a 390 px touch screen, 4× CPU slowdown and a 60 ms, 9 Mbit/s network.
import assert from 'node:assert/strict'
const [base, ...flags] = process.argv.slice(2)
if (!base) throw new Error('Pass an isolated mock URL')
const phone = flags.includes('--phone'), cold = flags.includes('--cold')
const runs = Number(flags.find((f) => f.startsWith('--runs='))?.slice(7) ?? 7)
const url = new URL(base)
assert(['localhost', '127.0.0.1'].includes(url.hostname) && url.port !== '3000', 'Use an isolated loopback port')
assert.equal((await (await fetch(new URL('/api/health', base))).json()).mock, true)
const project = (await (await fetch(new URL('/api/projects', base))).json())[0]?.id
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--mute-audio'] })
const median = (xs) => (xs.length ? Math.round([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] * 10) / 10 : null)

async function openPage() {
  const context = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : { viewport: { width: 1600, height: 1000 } })
  await context.addInitScript(() => {
    localStorage.setItem('box-yard:setup-skipped', 'true')
    window.__perf = { long: [], ready: null }
    new PerformanceObserver((l) => window.__perf.long.push(...l.getEntries().map((e) => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: true })
    // When the composer is first in the DOM, timed in the page: polling from outside waits behind long tasks.
    new MutationObserver((_, obs) => {
      if (!document.querySelector('textarea')) return
      window.__perf.ready = performance.now()
      obs.disconnect()
    }).observe(document, { childList: true, subtree: true })
  })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  if (phone) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 60, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (3 * 1024 * 1024) / 8 })
  }
  const js = { bytes: 0, files: 0 }, scripts = new Set()
  cdp.on('Network.responseReceived', (e) => e.response.mimeType.includes('javascript') && scripts.add(e.requestId))
  cdp.on('Network.loadingFinished', (e) => {
    if (!scripts.has(e.requestId)) return
    js.bytes += e.encodedDataLength
    js.files++
  })
  await page.goto(base, { waitUntil: 'commit' })
  await page.waitForSelector('textarea', { timeout: 60_000 })
  return { context, page, js: { ...js } }
}

/** From `how` (a click or a URL) to the frame after `text` is on screen. */
const open = (page, how, text) =>
  page.evaluate(async ({ how, text }) => {
    const t0 = performance.now()
    if (how.click) document.querySelector(how.click).click()
    else history.replaceState(history.state, '', how.url)
    await new Promise((resolve) => {
      const shown = () => document.body.innerText.includes(text)
      if (shown()) return resolve()
      const obs = new MutationObserver(() => shown() && (obs.disconnect(), resolve()))
      obs.observe(document.body, { childList: true, subtree: true, characterData: true })
    })
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
    return performance.now() - t0
  }, { how, text })
const close = async (page) => {
  await page.evaluate(() => history.replaceState(history.state, '', '/'))
  await page.waitForTimeout(300)
}

const load = [], opened = { settings: [], projectSettings: [], schedules: [] }
for (let i = 0; i < runs; i++) {
  const { context, page, js } = await openPage()
  const p = await page.evaluate(() => {
    const ready = window.__perf.ready
    const long = window.__perf.long.filter((t) => t.start < ready)
    return { ready, fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null, tbt: long.reduce((n, t) => n + Math.max(0, t.duration - 50), 0) }
  })
  load.push({ readyMs: p.ready, fcpMs: p.fcp, tbtToReadyMs: p.tbt, jsKBToReady: js.bytes / 1024, jsFilesToReady: js.files })
  if (!cold) await page.waitForTimeout(phone ? 8000 : 4000)
  opened.settings.push(await open(page, phone ? { url: '/?settings=orchestrator' } : { click: 'button[aria-label="Settings"]' }, 'Changes apply from the next turn'))
  await close(page)
  if (!cold && project) {
    opened.projectSettings.push(await open(page, { url: `/?projectSettings=${project}` }, 'Delete project'))
    await close(page)
    opened.schedules.push(await open(page, { url: '/?schedule=all' }, 'New schedule'))
  }
  await context.close()
}
await browser.close()
const medians = (rows) => Object.fromEntries(Object.keys(rows[0]).map((k) => [k, median(rows.map((r) => r[k]))]))
console.log(JSON.stringify({ base, phone, cold, runs, load: medians(load), openMs: Object.fromEntries(Object.entries(opened).filter(([, v]) => v.length).map(([k, v]) => [k, median(v)])) }, null, 1))
