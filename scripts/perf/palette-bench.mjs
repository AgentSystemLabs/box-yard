#!/usr/bin/env node
// Command palette open time and search-as-you-type latency on a big yard (scripts/perf/palette-yard.mjs), in Chromium.
//
//   npm run build
//   PORT=4001 BOXYARD_MOCK=1 BOXYARD_DATA_DIR=/tmp/palette-yard node dist/server/server/index.js &
//   npm i --no-save playwright-core && npx playwright-core install chromium   (or PLAYWRIGHT_MODULE=/path/to/playwright-core)
//   node scripts/perf/palette-bench.mjs http://localhost:4001 [label] [cpuSlowdown=1] [projects=300] [tasks=5000] [artifacts=1000]
//
// The mock server serves the app; the browser answers /api/tasks, /api/projects and /api/artifacts with the big
// yard and blocks the event stream, so nothing but the palette moves. Prints JSON, medians over every sample:
// - open: Ctrl+K to the first frame that shows the palette's rows (first open and reopens).
// - openWork: main-thread time (CDP TaskDuration) in the 500 ms after Ctrl+K, and in the same window left idle.
// - typing: each keystroke to the first frame after it (input), and to the frame that shows its results.
// - burst: a query typed at 25 ms a key, from its first key to the frame with the final results.
// - showAll: "Show all N" for a one-letter query, to the frame that shows the rows; and the DOM it leaves.
// - firstKey: after a reload, the first key typed in the first open, to the frame that shows its results.

const [base = "http://localhost:4001", label = "run", cpu = "1", projects = "300", tasks = "5000", artifacts = "1000"] = process.argv.slice(2)
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright-core")
const { QUERIES, paletteYard } = await import("./palette-yard.mjs")

const yard = paletteYard({ projects: Number(projects), tasks: Number(tasks), artifacts: Number(artifacts) })
const queries = [...QUERIES, `${yard.projects[3].name} failed`]
const ROUNDS = 5

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0)
const p95 = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))] : 0)
const r1 = (n) => Math.round(n * 10) / 10

// Frame timing in the page: `__frameAfter(t0)` resolves with the time from t0 to just after the next paint.
const PROBE = () => {
  window.__afterPaint = () => new Promise((resolve) => requestAnimationFrame(() => {
    const ch = new MessageChannel()
    ch.port1.onmessage = () => resolve(performance.now())
    ch.port2.postMessage(0)
  }))
  // The last time the results list changed, and the paint after it.
  window.__resultsPaint = 0
  const watch = () => {
    const list = document.querySelector("[role=listbox]")
    if (!list || list.__watched) return
    list.__watched = true
    new MutationObserver(() => window.__afterPaint().then((t) => (window.__resultsPaint = t))).observe(list, { childList: true, subtree: true, characterData: true })
  }
  new MutationObserver(watch).observe(document, { childList: true, subtree: true })
  window.addEventListener(
    "keydown",
    (e) => {
      window.__keyAt = e.timeStamp
      window.__inputPaint = window.__afterPaint()
    },
    true,
  )
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined })
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
await context.addInitScript(PROBE)
const json = (body) => (route) => route.fulfill({ status: 200, contentType: "application/json", body })
await context.route("**/api/tasks", json(JSON.stringify(yard.tasks)))
await context.route("**/api/projects", json(JSON.stringify(yard.projects)))
await context.route("**/api/artifacts", json(JSON.stringify(yard.artifacts)))
await context.route("**/api/stream**", (route) => route.abort())
// The page's early snapshot would bring the server's own lists; without it the app asks for each list above.
await context.route("**/api/boot", (route) => route.abort())
const page = await context.newPage()
const cdp = await context.newCDPSession(page)
if (Number(cpu) > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(cpu) })

await page.goto(base + "/projects", { waitUntil: "load" })
await page.waitForFunction(() => document.body.innerText.length > 0)
await sleep(2500)

const optionCount = () => page.evaluate(() => document.querySelectorAll("[role=listbox] [role=option]").length)

/** Ctrl+K until the frame that shows the palette's rows. */
async function openOnce() {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null))
  const shown = page.evaluate(
    () =>
      new Promise((resolve) => {
        const check = () =>
          document.querySelector("[role=listbox] [role=option]") ? window.__afterPaint().then((t) => resolve(t - window.__keyAt)) : requestAnimationFrame(check)
        window.addEventListener("keydown", () => requestAnimationFrame(check), { once: true })
      }),
  )
  await page.keyboard.press("Control+k")
  const ms = await shown
  await sleep(300)
  return ms
}

async function closePalette() {
  await page.keyboard.press("Escape")
  await page.waitForFunction(() => !document.querySelector("[role=listbox]"))
  await sleep(300)
}

/** One key: to the next frame, and to the frame that shows its results (when they changed). */
async function key(ch, settle = 400) {
  await page.evaluate(() => (window.__resultsPaint = 0))
  await page.keyboard.type(ch)
  await sleep(settle)
  return page.evaluate(async () => {
    const input = (await window.__inputPaint) - window.__keyAt
    return { input, results: window.__resultsPaint ? window.__resultsPaint - window.__keyAt : null }
  })
}

async function clearInput() {
  await page.keyboard.press("Control+a")
  await page.keyboard.press("Backspace")
  // Backspace once more drops a prefix chip (#, f:).
  await page.keyboard.press("Backspace")
  await sleep(400)
}

const out = { label, cpuSlowdown: Number(cpu), yard: { projects: yard.projects.length, tasks: yard.tasks.length, artifacts: yard.artifacts.length }, at: new Date().toISOString() }

// ---------------------------------------------------------------- open
const firstOpen = await openOnce()
await closePalette()
const reopens = []
for (let i = 0; i < ROUNDS * 2; i++) {
  reopens.push(await openOnce())
  await closePalette()
}
out.open = { firstMs: r1(firstOpen), reopenMedianMs: r1(median(reopens)), reopenP95Ms: r1(p95(reopens)) }

// ---------------------------------------------------------------- open work
// Frames are paced by the compositor, so the time to the first frame hides how much the open itself costs.
const cdpTask = async () => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration").value * 1000
await cdp.send("Performance.enable")
const openWork = []
const idleWork = []
for (let i = 0; i < ROUNDS * 3; i++) {
  let t0 = await cdpTask()
  await sleep(500)
  idleWork.push((await cdpTask()) - t0)
  t0 = await cdpTask()
  await page.keyboard.press("Control+k")
  await page.waitForSelector("[role=listbox] [role=option]")
  await sleep(500)
  openWork.push((await cdpTask()) - t0)
  await closePalette()
}
out.openWork = { medianMs: r1(median(openWork)), idleMedianMs: r1(median(idleWork)) }

// ---------------------------------------------------------------- typing
await openOnce()
const input = []
const results = []
let keys = 0
const before = await cdpTask()
for (let round = 0; round < ROUNDS; round++) {
  for (const q of queries) {
    for (const ch of q) {
      const k = await key(ch)
      keys++
      input.push(k.input)
      if (k.results !== null) results.push(k.results)
    }
    await clearInput()
  }
}
const busy = (await cdpTask()) - before
out.typing = {
  keys,
  inputMedianMs: r1(median(input)),
  inputP95Ms: r1(p95(input)),
  resultsMedianMs: r1(median(results)),
  resultsP95Ms: r1(p95(results)),
  // Includes clearing the box between queries.
  mainThreadPerKeyMs: r1(busy / keys),
}

// ---------------------------------------------------------------- burst
const bursts = []
for (let round = 0; round < ROUNDS; round++) {
  for (const q of queries) {
    await page.evaluate(() => (window.__resultsPaint = 0))
    const t0 = await page.evaluate(() => performance.now())
    await page.keyboard.type(q, { delay: 25 })
    // Wait until the results stop changing.
    let last = -1
    for (;;) {
      await sleep(250)
      const t = await page.evaluate(() => window.__resultsPaint)
      if (t === last) break
      last = t
    }
    bursts.push(last - t0)
    await clearInput()
  }
}
out.burst = { queries: bursts.length, toFinalResultsMedianMs: r1(median(bursts)), toFinalResultsP95Ms: r1(p95(bursts)) }

// ---------------------------------------------------------------- show all
const showAll = []
let showAllRows = 0
let showAllDom = 0
for (let round = 0; round < ROUNDS; round++) {
  await key("e")
  const ms = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const more = document.querySelector("[data-group=task] [data-testid=palette-show-all]")
        const t0 = performance.now()
        more.dispatchEvent(new MouseEvent("click", { bubbles: true }))
        window.__afterPaint().then((t) => resolve(t - t0))
      }),
  )
  await sleep(400)
  showAll.push(ms)
  showAllRows = await optionCount()
  showAllDom = await page.evaluate(() => document.getElementsByTagName("*").length)
  await clearInput()
}
out.showAll = { medianMs: r1(median(showAll)), optionRows: showAllRows, domElements: showAllDom }

// ---------------------------------------------------------------- first key
// Nothing is cached after a reload: the first search sees every row for the first time.
const firstKeys = []
for (let round = 0; round < ROUNDS * 2; round++) {
  await page.reload({ waitUntil: "load" })
  await page.waitForFunction(() => document.body.innerText.length > 0)
  await sleep(2500)
  await openOnce()
  const k = await key("e")
  if (k.results !== null) firstKeys.push(k.results)
  await closePalette()
}
out.firstKey = { resultsMedianMs: r1(median(firstKeys)), samples: firstKeys.length }

console.log(JSON.stringify(out, null, 2))
await browser.close()
