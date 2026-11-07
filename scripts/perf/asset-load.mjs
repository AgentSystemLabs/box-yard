#!/usr/bin/env node
// Page-load bench for how the server sends the web app and its API: bytes over the wire and time to a usable app,
// on a throttled phone-like network, for a first visit (empty cache) and a return visit two hours later.
//
//   npm run build
//   PORT=4001 BOXYARD_MOCK=1 BOXYARD_MOCK_HEAVY=1 BOXYARD_DATA_DIR=/tmp/heavy node dist/server/server/index.js &
//   npm i --no-save playwright && npx playwright install chromium   (or PLAYWRIGHT_MODULE=/path/to/playwright)
//   node scripts/perf/asset-load.mjs http://localhost:4001 [runs=5] [network=slow4g|fast4g|none]
//
// The browser talks to the server through a small local proxy that adds `Age: 7200` to every response, the way a
// cache entry looks two hours after it was stored: the return visit then shows what the Cache-Control headers make
// the browser re-check. "ready" is when the composer's textarea appears. Prints the median of each figure as JSON.
import http from "node:http"

const base = new URL(process.argv[2] ?? "http://localhost:4001")
const runs = Number(process.argv[3] ?? 5)
const NETWORKS = {
  // Lighthouse's mobile throttling.
  slow4g: { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
  fast4g: { latency: 40, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 },
  none: null,
}
const networkName = process.argv[4] ?? "slow4g"
if (!(networkName in NETWORKS)) throw new Error(`network must be one of ${Object.keys(NETWORKS).join(", ")}`)
const network = NETWORKS[networkName]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")

/** Forwards to the server, adding `Age: 7200`; streams pass straight through (SSE included). */
const proxy = http.createServer((req, res) => {
  const up = http.request({ host: base.hostname, port: base.port, path: req.url, method: req.method, headers: { ...req.headers, host: base.host } }, (r) => {
    res.writeHead(r.statusCode ?? 502, { ...r.headers, ...(r.statusCode === 200 ? { age: "7200" } : {}) })
    r.pipe(res)
  })
  up.on("error", () => res.destroy())
  // The browser closing a page ends its SSE stream upstream too.
  res.on("close", () => up.destroy())
  req.pipe(up)
})
await new Promise((r) => proxy.listen(0, "127.0.0.1", r))
const origin = `http://127.0.0.1:${proxy.address().port}`

const READY = () => {
  const mark = () => {
    if (window.__readyAt == null && document.querySelector("textarea")) window.__readyAt = performance.now()
  }
  new MutationObserver(mark).observe(document, { childList: true, subtree: true })
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** One page load in `context`: per-request bytes and whether each went to the server, plus paint timings. */
async function visit(context) {
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send("Network.enable")
  if (network) await cdp.send("Network.emulateNetworkConditions", { offline: false, ...network })
  const reqs = new Map()
  cdp.on("Network.requestWillBeSent", (e) => reqs.set(e.requestId, { url: new URL(e.request.url).pathname, bytes: 0, network: false }))
  cdp.on("Network.requestServedFromCache", (e) => reqs.get(e.requestId) && (reqs.get(e.requestId).cached = true))
  cdp.on("Network.responseReceived", (e) => {
    const r = reqs.get(e.requestId)
    if (!r) return
    r.network = !e.response.fromDiskCache && !r.cached
  })
  cdp.on("Network.loadingFinished", (e) => reqs.get(e.requestId) && (reqs.get(e.requestId).bytes = e.encodedDataLength))
  await page.goto(origin + "/", { waitUntil: "load" })
  await page.waitForFunction(() => window.__readyAt != null, null, { timeout: 120_000 })
  // Let the first API burst land (the SSE stream stays open and is left out).
  let settled = 0
  for (let last = -1; settled < 3; await sleep(500)) settled = reqs.size === last ? settled + 1 : ((last = reqs.size), 0)
  const timing = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0]
    const fcp = performance.getEntriesByName("first-contentful-paint")[0]
    return { domContentLoaded: nav.domContentLoadedEventEnd, load: nav.loadEventEnd, fcp: fcp?.startTime ?? 0, ready: window.__readyAt }
  })
  await page.close()
  const list = [...reqs.values()].filter((r) => r.url !== "/api/stream")
  const sum = (pred) => list.filter(pred).reduce((n, r) => n + r.bytes, 0)
  const isApi = (r) => r.url.startsWith("/api/")
  return {
    ...Object.fromEntries(Object.entries(timing).map(([k, v]) => [k + "Ms", Math.round(v)])),
    staticKB: Math.round(sum((r) => !isApi(r)) / 1024),
    apiKB: Math.round(sum(isApi) / 1024),
    // A revalidated file counts here even though Chrome reports its cached 200, not the 304.
    staticRequestsToServer: list.filter((r) => !isApi(r) && r.network).length,
  }
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined })
const first = []
const again = []
for (let i = 0; i < runs; i++) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await context.addInitScript(READY)
  first.push(await visit(context))
  again.push(await visit(context))
  await context.close()
}
await browser.close()
proxy.closeAllConnections()
proxy.close()

const summary = (list) => Object.fromEntries(Object.keys(list[0]).map((k) => [k, median(list.map((x) => x[k]))]))
console.log(JSON.stringify({ server: base.href, network: networkName, runs, firstVisit: summary(first), returnVisit2hLater: summary(again) }, null, 2))
