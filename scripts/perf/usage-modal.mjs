#!/usr/bin/env node
// How fast the Usage modal opens and answers, against a mock server on a big yard (scripts/perf/usage-yard.ts):
//
//   npx tsx scripts/perf/usage-yard.ts --dir /tmp/usage-yard
//   npm run build && PORT=4011 BOXYARD_MOCK=1 BOXYARD_MOCK_HEAVY=1 BOXYARD_DATA_DIR=/tmp/usage-yard node dist/server/server/index.js &
//   PLAYWRIGHT_MODULE=/tmp/pw/node_modules/playwright-core/index.mjs node scripts/perf/usage-modal.mjs http://localhost:4011 [--phone] [--runs=5] [--json=out.json]
//
// Four parts, medians over --runs:
// - server: GET /api/usage/daily for 7, 30 and 90 days (the client's local day starts, to now), GET /api/usage and
//   GET /api/usage/budget, from Node: time to the last byte, and the response size.
// - open: on a fresh page each run, once the app has settled, the sidebar's Usage button (hovered 150 ms, pressed
//   60 ms, as a hand would) to the frame that shows the modal (`frame`), and to the frame that shows its numbers
//   (`data`). The modal's requests are split out of `data` (when each started after the press, and how long it took),
//   and `render` is the frame with the numbers less the end of the last request it waited on: parsing, folding and
//   rendering in the page. Then the same again with the modal closed and reopened (`reopen`), a switch to 90 days and
//   back to 30 (`range`, each button hovered 150 ms first), a tap on the first breakdown row (`drill`) and the mouse moving over 30 days of the cost
//   chart (`hover`, each move, 100 ms apart, to its frame).
// - live: with the modal open, 24 task updates over 6 s (POST /api/dev/pulse): the requests the page makes for usage,
//   main-thread long tasks in the page, and the worst /api/health latency meanwhile (the server stalls while it
//   builds a ledger: sync SQLite blocks every other request).
// Phone (--phone): a 400 px touch screen with 4× CPU slowdown; the Usage button is tapped (no hover).
// Only an isolated mock server is accepted.
import assert from "node:assert/strict"
import fs from "node:fs"

const [base, ...flags] = process.argv.slice(2)
if (!base) throw new Error("Pass an isolated mock URL")
const phone = flags.includes("--phone")
const runs = Number(flags.find((f) => f.startsWith("--runs="))?.slice(7) ?? 5)
const jsonOut = flags.find((f) => f.startsWith("--json="))?.slice(7)
const skip = new Set((flags.find((f) => f.startsWith("--skip="))?.slice(7) ?? "").split(",").filter(Boolean))
const url = new URL(base)
assert(["localhost", "127.0.0.1"].includes(url.hostname) && url.port !== "3000", "Use an isolated loopback port")
assert.equal((await (await fetch(new URL("/api/health", base))).json()).mock, true)
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright-core")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const median = (xs) => (xs.length ? Math.round([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] * 10) / 10 : null)
const max = (xs) => (xs.length ? Math.round(Math.max(...xs) * 10) / 10 : null)

/** The client's local day starts for the last `n` days (web/src/lib/usageChart.ts localDayStarts). */
function dayStarts(n) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Array.from({ length: n }, (_, i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - (n - 1 - i)).getTime())
}

const out = { base, phone, runs, server: {}, open: {}, live: {} }

// ---- the same numbers: --snapshot=<file> saves the 30- and 90-day ledgers at a fixed `to` the first time, and
// compares later builds' ledgers for those same days with it (sorted rows, every number within 1e-9).
const snapshot = flags.find((f) => f.startsWith("--snapshot="))?.slice(11)
if (snapshot) {
  const saved = fs.existsSync(snapshot) ? JSON.parse(fs.readFileSync(snapshot, "utf8")) : null
  const to = saved?.to ?? Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000
  const ranges = saved?.ranges ?? { "30d": dayStarts(30), "90d": dayStarts(90) }
  const ledgers = {}
  for (const [k, days] of Object.entries(ranges)) ledgers[k] = await (await fetch(new URL(`/api/usage/daily?days=${days.join(",")}&to=${to}`, base))).json()
  const canon = (l) => ({ ...l, llm: l.llm.map((r) => JSON.stringify([r.day, r.role, r.projectId, r.taskId, r.model, r.loginId])).map((k, i) => [k, l.llm[i]]).sort(), compute: l.compute.map((r) => [JSON.stringify([r.day, r.provider, r.boxId, r.projectId, r.taskId]), r]).sort() })
  if (!saved) {
    fs.writeFileSync(snapshot, JSON.stringify({ to, ranges, ledgers }))
    out.snapshot = `saved ${snapshot}`
  } else {
    const diffs = []
    const walk = (a, b, at) => {
      if (typeof a === "number" && typeof b === "number") {
        if (Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a))) diffs.push(`${at}: ${a} → ${b}`)
      } else if (a && b && typeof a === "object" && typeof b === "object") {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)])
        for (const k of keys) walk(a[k], b[k], `${at}.${k}`)
      } else if (a !== b) diffs.push(`${at}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`)
    }
    for (const k of Object.keys(ranges)) walk(canon(saved.ledgers[k]), canon(ledgers[k]), k)
    out.snapshot = diffs.length ? { differs: diffs.length, first: diffs.slice(0, 10) } : "same numbers"
    if (diffs.length) console.error("ledger differs from the snapshot:", diffs.slice(0, 10))
  }
}

// ---- server
if (!skip.has("server")) {
  const get = async (path) => {
    const s = performance.now()
    const r = await fetch(new URL(path, base))
    const body = await r.arrayBuffer()
    assert.equal(r.status, 200, path)
    return { ms: performance.now() - s, kb: body.byteLength / 1024 }
  }
  for (const [label, path] of [
    ["daily 7d", () => `/api/usage/daily?days=${dayStarts(7).join(",")}`],
    ["daily 30d", () => `/api/usage/daily?days=${dayStarts(30).join(",")}`],
    ["daily 90d", () => `/api/usage/daily?days=${dayStarts(90).join(",")}`],
    ["usage", () => "/api/usage"],
    ["budget", () => "/api/usage/budget"],
  ]) {
    // An endpoint an older build doesn't have is left out.
    if (label === "budget" && (await fetch(new URL(path(), base))).status === 404) continue
    const xs = []
    for (let i = 0; i < runs; i++) xs.push(await get(path()))
    out.server[label] = { first: Math.round(xs[0].ms), median: median(xs.map((x) => x.ms)), kb: Math.round(xs[0].kb) }
  }
}

// ---- the page
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ["--mute-audio"] })
const PROBE = () => {
  localStorage.setItem("box-yard:setup-skipped", "true")
  window.__long = []
  new PerformanceObserver((l) => window.__long.push(...l.getEntries().map((e) => ({ start: e.startTime, duration: e.duration })))).observe({ type: "longtask", buffered: true })
  /** Resolves with the time just after the next paint. */
  window.__afterPaint = () =>
    new Promise((resolve) =>
      requestAnimationFrame(() => {
        const ch = new MessageChannel()
        ch.port1.onmessage = () => resolve(performance.now())
        ch.port2.postMessage(0)
      }),
    )
  /** The paint after `test()` first holds, timed in the page (polling from outside waits behind long tasks). */
  window.__paintWhen = (test) =>
    new Promise((resolve) => {
      const check = () => {
        if (!test()) return false
        obs.disconnect()
        void window.__afterPaint().then(resolve)
        return true
      }
      const obs = new MutationObserver(check)
      if (!check()) obs.observe(document, { childList: true, subtree: true, attributes: true, characterData: true })
    })
  window.__press = 0
  document.addEventListener("pointerdown", (e) => (window.__press = e.timeStamp), true)
}

async function newPage() {
  const context = await browser.newContext(phone ? { viewport: { width: 400, height: 860 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(PROBE)
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  if (phone) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  await page.goto(base, { waitUntil: "load" })
  await page.waitForSelector(phone ? "button[title='Projects and tasks']" : "[data-testid=sidebar-usage]", { state: "attached", timeout: 60_000 })
  // Settled: the first requests are done and the lazy parts (the modal's chunk among them) are warmed.
  await sleep(phone ? 8000 : 4000)
  return { context, page }
}

/** Presses the sidebar's Usage button as a hand would: on a phone the drawer first, then a tap. */
async function pressUsage(page) {
  if (phone) {
    const menu = page.locator("button[title='Projects and tasks']").first()
    if (await menu.isVisible().catch(() => false)) {
      await menu.tap()
      await page.locator("[data-testid=sidebar-usage]").waitFor({ state: "visible" })
      await sleep(400)
    }
    await page.locator("[data-testid=sidebar-usage]").tap()
    return
  }
  const box = await page.locator("[data-testid=sidebar-usage]").boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await sleep(150)
  await page.mouse.down()
  await sleep(60)
  await page.mouse.up()
}

/** Press Usage and time the frames after it, with the requests it made. */
async function timeOpen(page) {
  await page.evaluate(() => {
    performance.clearResourceTimings()
    window.__long = []
    window.__frame = window.__paintWhen(() => document.querySelector("[role=dialog]")?.textContent?.includes("Usage"))
    window.__data = window.__paintWhen(() => {
      const total = document.querySelector("[data-testid=usage-total]")
      return !!total && total.closest("[aria-busy=true]") === null
    })
  })
  await pressUsage(page)
  return page.evaluate(async () => {
    const [frame, data] = await Promise.all([window.__frame, window.__data])
    await new Promise((r) => setTimeout(r, 300))
    const t0 = window.__press
    const reqs = performance
      .getEntriesByType("resource")
      .filter((e) => /\/api\/usage(\/daily|\/budget)?(\?|$)/.test(new URL(e.name).pathname + new URL(e.name).search) && e.startTime >= t0 - 1000)
      .map((e) => ({ path: new URL(e.name).pathname, start: e.startTime - t0, ttfb: e.responseStart - e.startTime, ms: e.responseEnd - e.startTime, end: e.responseEnd - t0, kb: e.encodedBodySize / 1024 }))
    const ledger = reqs.filter((r) => r.path === "/api/usage/daily" && r.end <= data - t0 + 1).at(-1)
    return {
      frame: frame - t0,
      data: data - t0,
      reqs,
      ledgerStart: ledger?.start ?? null,
      ledgerMs: ledger?.ms ?? null,
      ledgerKb: ledger?.kb ?? null,
      render: ledger ? data - t0 - ledger.end : null,
      longMs: window.__long.filter((l) => l.start >= t0 && l.start <= data).reduce((s, l) => s + l.duration, 0),
    }
  })
}

async function closeModal(page) {
  await page.keyboard.press("Escape")
  await page.waitForFunction(() => !document.querySelector("[data-testid=usage-modal]"))
}

/** Click (or tap) `selector`, the pointer on it 150 ms first as a hand's would be, to the frame where `test` holds. */
async function timeClick(page, selector, test) {
  await page.evaluate((src) => {
    window.__done = window.__paintWhen(new Function(`return (${src})()`))
  }, test.toString())
  const el = page.locator(selector).first()
  if (phone) await el.tap()
  else {
    await el.hover()
    await sleep(150)
    await el.click()
  }
  return page.evaluate(async () => (await window.__done) - window.__press)
}

if (!skip.has("open")) {
  const samples = { open: [], reopen: [], range90: [], range30: [], drill: [], hover: [] }
  for (let i = 0; i < runs; i++) {
    const { context, page } = await newPage()
    samples.open.push(await timeOpen(page))
    await closeModal(page)
    await sleep(500)
    samples.reopen.push(await timeOpen(page))
    samples.range90.push(await timeClick(page, "[aria-label='Last 90 days']", () => document.querySelector("[data-testid=usage-readout]")?.textContent?.startsWith("All 90 days") && !document.querySelector("[aria-busy=true]")))
    samples.range30.push(await timeClick(page, "[aria-label='Last 30 days']", () => document.querySelector("[data-testid=usage-readout]")?.textContent?.startsWith("All 30 days") && !document.querySelector("[aria-busy=true]")))
    samples.drill.push(await timeClick(page, "[data-testid=usage-row]", () => !!document.querySelector("[data-testid=usage-filters]")))
    if (!phone) {
      const bars = page.locator("[data-testid=usage-cost-chart] [role=group][tabindex='0']")
      await bars.scrollIntoViewIfNeeded()
      const chart = await bars.boundingBox()
      for (let d = 0; d < 30; d++) {
        // Timed in the page from the move's event to the paint after it, so the harness's round trips don't count, and
        // 100 ms apart: back to back, headless Chromium's software compositor (≈50 ms a frame for the dialog's
        // backdrop blur) paces every frame, whatever the page does.
        await sleep(100)
        await page.evaluate(() =>
          document.addEventListener("pointermove", (e) => (window.__hover = window.__afterPaint().then((t) => t - e.timeStamp)), { once: true, capture: true }),
        )
        await page.mouse.move(chart.x + ((d + 0.5) / 30) * chart.width, chart.y + chart.height - 4)
        samples.hover.push(await page.evaluate(() => window.__hover))
      }
    }
    await context.close()
  }
  const sum = (xs) => ({
    frame: median(xs.map((x) => x.frame)),
    data: median(xs.map((x) => x.data)),
    ledgerStart: median(xs.map((x) => x.ledgerStart).filter((x) => x !== null)),
    ledgerMs: median(xs.map((x) => x.ledgerMs).filter((x) => x !== null)),
    ledgerKb: median(xs.map((x) => x.ledgerKb).filter((x) => x !== null)),
    render: median(xs.map((x) => x.render).filter((x) => x !== null)),
    longMs: median(xs.map((x) => x.longMs)),
    requests: median(xs.map((x) => x.reqs.length)),
  })
  out.open = { first: sum(samples.open), reopen: sum(samples.reopen), range90: median(samples.range90), range30: median(samples.range30), drill: median(samples.drill), hover: median(samples.hover), hoverMax: max(samples.hover) }
  out.open.samples = samples
}

if (!skip.has("live")) {
  const { context, page } = await newPage()
  await timeOpen(page)
  await sleep(1000)
  let usageRequests = 0
  page.on("request", (r) => /\/api\/usage(\/|\?|$)/.test(new URL(r.url()).pathname + new URL(r.url()).search) && usageRequests++)
  await page.evaluate(() => (window.__long = []))
  const health = []
  let polling = true
  const poll = (async () => {
    while (polling) {
      const s = performance.now()
      await fetch(new URL("/api/health", base))
      health.push(performance.now() - s)
      await sleep(50)
    }
  })()
  const r = await fetch(new URL("/api/dev/pulse", base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "task", count: 24, intervalMs: 250 }) })
  assert.equal((await r.json()).sent, 24, "the yard needs task_heavy-* tasks (scripts/perf/usage-yard.ts) and BOXYARD_MOCK_HEAVY=1")
  await sleep(8000)
  polling = false
  await poll
  const long = await page.evaluate(() => window.__long)
  out.live = { usageRequests, longTaskMs: Math.round(long.reduce((s, l) => s + l.duration, 0)), longTasks: long.length, healthMedian: median(health), healthMax: max(health) }
  await context.close()
}
await browser.close()

const { samples, ...open } = out.open
console.log(JSON.stringify({ ...out, open }, null, 2))
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 2))
