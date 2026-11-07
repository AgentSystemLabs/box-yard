#!/usr/bin/env node
// App-load bench: how soon the first useful screen paints, and what the load asks the server for.
//
//   npm run build
//   PORT=4001 BOXYARD_MOCK=1 BOXYARD_MOCK_HEAVY=1 BOXYARD_DATA_DIR=/tmp/heavy node dist/server/server/index.js &
//   npm i --no-save playwright && npx playwright install chromium   (or PLAYWRIGHT_MODULE=/path/to/playwright)
//   RTT=100 CPU=4 node scripts/perf/load-bench.mjs http://localhost:4001 [runs]
//
// Each run loads the page in a fresh context with RTT ms of network latency and CPU× slowdown (Chrome DevTools
// emulation), its static assets already in the HTTP cache (COLD=1 for an empty one; BPS caps bytes/s), and times:
// first and largest contentful paint, the app shell, the sidebar's projects, the Coordinator chat's first message
// ("useful": both of the last two), when /api/me answered, and the API requests made (and any made twice).
// Prints each run to stderr and the medians as JSON.

const base = process.argv[2] ?? "http://localhost:4001"
const runs = Number(process.argv[3] ?? 7)
const latency = Number(process.env.RTT ?? 100)
const cpu = Number(process.env.CPU ?? 4)
const bps = Number(process.env.BPS ?? -1)
const cold = process.env.COLD === "1"
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")

const MARKS = () => {
  window.__marks = {}
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__marks.lcp = e.startTime
  }).observe({ type: "largest-contentful-paint", buffered: true })
  const check = () => {
    const m = window.__marks
    if (!m.shell && document.querySelector("[data-app]")) m.shell = performance.now()
    if (!m.sidebar && document.querySelector('nav[aria-label="Projects and tasks"] section[aria-label]')) m.sidebar = performance.now()
    if (!m.chat && document.querySelector('[data-testid="chat-panel"] [id^="chat-"]')) m.chat = performance.now()
    if (m.sidebar && m.chat) m.useful = performance.now()
    else requestAnimationFrame(check)
  }
  requestAnimationFrame(check)
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const browser = await chromium.launch()
const rows = []
for (let i = 0; i < runs; i++) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const page = await context.newPage()
  await page.addInitScript(MARKS)
  const cdp = await context.newCDPSession(page)
  await cdp.send("Network.enable")
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency, downloadThroughput: bps, uploadThroughput: bps })
  if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu })
  // A load first, so the measured one times the app's requests rather than the bundle download.
  if (!cold) {
    await page.goto(`${base}/`, { waitUntil: "load" })
    await page.waitForFunction(() => window.__marks?.useful, null, { timeout: 30_000 })
  }
  await page.goto(`${base}/`, { waitUntil: "commit" })
  await page.waitForFunction(() => window.__marks?.useful, null, { timeout: 30_000 })
  // Let the requests that follow the first paint go out too.
  await page.waitForTimeout(1500)
  const row = await page.evaluate(() => {
    const api = performance.getEntriesByType("resource").filter((e) => e.name.includes("/api/") && !e.name.includes("/api/stream"))
    const asked = {}
    for (const e of api) {
      const url = new URL(e.name)
      asked[url.pathname + url.search] = (asked[url.pathname + url.search] ?? 0) + 1
    }
    return {
      ...window.__marks,
      fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime,
      meEnd: api.find((e) => e.name.endsWith("/api/me"))?.responseEnd,
      api: api.length,
      apiBeforeUseful: api.filter((e) => e.startTime < window.__marks.useful).length,
      twice: Object.entries(asked).filter(([, n]) => n > 1).map(([path, n]) => `${path}×${n}`),
    }
  })
  rows.push(row)
  const ms = (k) => `${k}=${Math.round(row[k] ?? 0)}`
  console.error(`run ${i + 1}: ${["useful", "fcp", "lcp", "shell", "sidebar", "chat", "meEnd"].map(ms).join(" ")} api=${row.api} twice=${row.twice.join(",") || "-"}`)
  await context.close()
}
await browser.close()

const KEYS = ["useful", "fcp", "lcp", "shell", "sidebar", "chat", "meEnd", "api", "apiBeforeUseful"]
const medians = Object.fromEntries(KEYS.map((k) => [k, Math.round(median(rows.map((r) => r[k] ?? 0)))]))
console.log(JSON.stringify({ base, rtt: latency, cpu, bps, cold, runs, median: medians, twice: [...new Set(rows.flatMap((r) => r.twice))] }, null, 2))
