#!/usr/bin/env node
// What the app downloads again when nothing changed: the API requests (not the event stream) and bytes after
// returning to the tab and after reopening a panel, on the heavy mock yard, plus the main-thread time they cost.
//
//   npm run build
//   PORT=4001 BOXYARD_MOCK=1 BOXYARD_MOCK_HEAVY=1 BOXYARD_DATA_DIR=/tmp/heavy node dist/server/server/index.js &
//   npm i --no-save playwright && npx playwright install chromium   (or PLAYWRIGHT_MODULE=/path/to/playwright)
//   node scripts/perf/refetch-storms.mjs http://localhost:4001 [runs] [cpuThrottle]
//
// The page's clock is faked (Playwright's clock), so "a minute later" takes no real minute: React Query's staleTime
// and lib/resume.ts's time away both read it. The tab hides and shows through document.visibilityState and a
// visibilitychange event, as a real tab switch does. Prints each scenario's median over the runs, as JSON.

const base = process.argv[2] ?? "http://localhost:4001"
const runs = Number(process.argv[3] ?? 3)
const throttle = Number(process.argv[4] ?? 4)
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const TASK = "task_heavy-thread"

async function run() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await context.addInitScript(() => {
    let hidden = false
    Object.defineProperty(Document.prototype, "hidden", { get: () => hidden, configurable: true })
    Object.defineProperty(Document.prototype, "visibilityState", { get: () => (hidden ? "hidden" : "visible"), configurable: true })
    window.__setHidden = (h) => {
      hidden = h
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true }))
    }
  })
  const page = await context.newPage()
  await page.clock.install()
  const cdp = await context.newCDPSession(page)
  await cdp.send("Performance.enable")
  if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle })
  const taskMs = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value])).TaskDuration * 1000

  let log = []
  const pending = new Set()
  page.on("requestfinished", (req) => {
    const u = new URL(req.url())
    if (!u.pathname.startsWith("/api/") || u.pathname === "/api/stream") return
    const p = req.response().then(async (res) => {
      const body = res ? await res.body().catch(() => null) : null
      log.push({ path: u.pathname, bytes: body ? body.length : 0 })
    })
    pending.add(p)
    p.finally(() => pending.delete(p))
  })
  const quiet = async () => {
    await sleep(2500)
    await Promise.all(pending)
  }
  /** Runs `act`, waits for its requests to settle, and reports them. */
  const measure = async (act) => {
    await quiet()
    log = []
    const t0 = await taskMs()
    await act()
    await quiet()
    const ms = (await taskMs()) - t0
    const by = {}
    for (const r of log) by[r.path] = (by[r.path] ?? 0) + 1
    return { requests: log.length, kb: Math.round(log.reduce((n, r) => n + r.bytes, 0) / 1024), mainThreadMs: Math.round(ms), by }
  }
  const go = (url) => page.evaluate((url) => {
    history.pushState(null, "", url)
    dispatchEvent(new PopStateEvent("popstate"))
  }, url)
  const idle = (ms) => page.clock.fastForward(ms)
  const away = async (ms) => {
    await page.evaluate(() => window.__setHidden(true))
    await idle(ms)
    await page.evaluate(() => window.__setHidden(false))
  }

  await page.goto(`${base}/?session=${TASK}`, { waitUntil: "load" })
  await page.waitForSelector("textarea")
  await quiet()
  const out = {}
  // A minute on the page with nothing changing, then a quick look at another tab: the stream stayed open.
  await idle(65_000)
  out.tabBackAfter5s = await measure(() => away(5_000))
  // Longer away: lib/stream.ts replaces the stream and refetches everything (it may have missed events).
  out.tabBackAfter40s = await measure(() => away(40_000))
  // The task panel closed, and opened again a minute later.
  await go("/")
  await idle(65_000)
  out.reopenTaskAfter65s = await measure(() => go(`/?session=${TASK}`))
  // A Captain in the centre, then back to the Coordinator a minute later: its chat mounts again.
  await go("/")
  await page.locator('nav[aria-label="Projects and tasks"] button[title^="Talk to the nebula Captain"]').first().click()
  await idle(65_000)
  out.backToCoordinatorAfter65s = await measure(() => page.locator('nav[aria-label="Projects and tasks"] button', { hasText: "Coordinator" }).first().click())
  await browser.close()
  return out
}

const all = []
for (let i = 0; i < runs; i++) all.push(await run())
const out = { base, runs, cpuThrottle: throttle, scenarios: {} }
for (const name of Object.keys(all[0])) {
  const xs = all.map((r) => r[name])
  out.scenarios[name] = {
    requests: median(xs.map((x) => x.requests)),
    kb: median(xs.map((x) => x.kb)),
    mainThreadMs: median(xs.map((x) => x.mainThreadMs)),
    perRun: xs.map((x) => `${x.requests} req / ${x.kb} KB / ${x.mainThreadMs} ms`),
    paths: xs[0].by,
  }
}
console.log(JSON.stringify(out, null, 2))
