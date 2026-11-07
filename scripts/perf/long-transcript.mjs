#!/usr/bin/env node
// Long-transcript bench against the heavy mock yard: the Coordinator chat (1200 messages) and the 2000-event task
// thread.
//
//   npm run build
//   PORT=4001 BOXYARD_MOCK=1 BOXYARD_MOCK_HEAVY=1 BOXYARD_DATA_DIR=/tmp/heavy node dist/server/server/index.js &
//   npm i --no-save playwright && npx playwright install chromium   (or PLAYWRIGHT_MODULE=/path/to/playwright)
//   node scripts/perf/long-transcript.mjs http://localhost:4001 [label] [runs=3]
//
// Per view, in a fresh page each run:
// - newMessage: main-thread cost of a new Coordinator reply (POST /api/dev/pulse chat.reply) at the bottom, with the
//   newest rows rendered, then again (newMessageInHistory) after reading back through the whole history.
// - history: scrolling up 600px a frame until every older row is rendered (useTail loads them as the top nears).
// - rotate: a phone turning between portrait and landscape, with the history rendered.
// Prints each run as JSON, then the medians.

const base = process.argv[2] ?? "http://localhost:4001"
const label = process.argv[3] ?? "run"
const runs = Number(process.argv[4] ?? 3)
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const r1 = (n) => Math.round(n * 10) / 10
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

const VIEWS = {
  chat: { path: "/", testid: "chat-panel", pulse: "chat.reply" },
  task: { path: "/?session=task_heavy-thread", testid: "side-thread", pulse: null },
}

async function measure(browser, which) {
  const view = VIEWS[which]
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await context.addInitScript(() => {
    window.__longtasks = []
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longtasks.push(e.duration)
    }).observe({ type: "longtask", buffered: true })
  })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send("Performance.enable")
  const metric = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics")
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]))
    return { task: m.TaskDuration * 1000, script: m.ScriptDuration * 1000, layout: m.LayoutDuration * 1000, style: m.RecalcStyleDuration * 1000 }
  }
  const diff = (a, b, per = 1) => ({
    mainThreadMs: r1((b.task - a.task) / per),
    styleMs: r1((b.style - a.style) / per),
    layoutMs: r1((b.layout - a.layout) / per),
    scriptMs: r1((b.script - a.script) / per),
  })

  await page.goto(base + view.path)
  // The transcript's StickyScroll: the scroller with its own scroll anchoring off.
  await page.waitForFunction(
    (t) => {
      const el = [...document.querySelectorAll(`[data-testid=${t}] .overflow-y-auto`)].find((e) => e.className.includes("overflow-anchor"))
      if (el?.firstElementChild?.children.length > 20) return (window.__list = el)
    },
    view.testid,
    { timeout: 30_000 },
  )
  await sleep(2500)
  const rows = () => page.evaluate(() => window.__list.firstElementChild.children.length)
  const out = { which, rowsAtStart: await rows() }

  const pulse = async (kind, count = 10) => {
    await sleep(500)
    const before = await metric()
    await page.evaluate(
      ({ kind, count }) => fetch("/api/dev/pulse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, count, intervalMs: 100 }) }),
      { kind, count },
    )
    await sleep(count * 100 + 1500)
    return diff(before, await metric(), count)
  }
  if (view.pulse) out.newMessage = await pulse(view.pulse)

  {
    await page.evaluate(() => (window.__longtasks = []))
    const before = await metric()
    const times = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const el = window.__list
          const times = []
          let still = 0
          const tick = (t) => {
            times.push(t)
            const prev = el.scrollTop
            el.scrollTop -= 600
            const more = !!el.firstElementChild.querySelector(":scope > button")
            if (el.scrollTop === 0 && prev === 0 && !more) still++
            if (still < 5 && times.length < 3000) requestAnimationFrame(tick)
            else resolve(times)
          }
          requestAnimationFrame(tick)
        }),
    )
    const after = await metric()
    const gaps = times.slice(1).map((t, i) => t - times[i])
    const long = await page.evaluate(() => window.__longtasks)
    out.history = {
      ...diff(before, after),
      framesOver50Ms: gaps.filter((g) => g > 50).length,
      longestFrameMs: r1(Math.max(...gaps)),
      longTasks: long.length,
      longestTaskMs: r1(Math.max(0, ...long)),
    }
  }
  await sleep(1000)
  out.rowsAtTop = await rows()
  out.domElements = await page.evaluate(() => document.getElementsByTagName("*").length)

  if (view.pulse) out.newMessageInHistory = await pulse(view.pulse)

  {
    // A phone turning, with the history rendered: the text reflows (the desktop column is capped at 48rem, so a
    // wide window's resize doesn't).
    await page.setViewportSize({ width: 390, height: 844 })
    await sleep(1000)
    const each = []
    for (const [width, height] of [[844, 390], [390, 844], [844, 390], [390, 844], [844, 390]]) {
      const a = await metric()
      await page.setViewportSize({ width, height })
      await sleep(300)
      each.push(diff(a, await metric()))
    }
    out.rotate = Object.fromEntries(Object.keys(each[0]).map((k) => [k, median(each.map((e) => e[k]))]))
  }
  await context.close()
  return out
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined })
const all = []
for (let i = 0; i < runs; i++) {
  for (const which of Object.keys(VIEWS)) {
    const r = await measure(browser, which)
    all.push(r)
    console.log(JSON.stringify({ label, run: i + 1, ...r }))
  }
}
await browser.close()

// Medians of every number, per view.
const summary = { label, runs }
for (const which of Object.keys(VIEWS)) {
  const rs = all.filter((r) => r.which === which)
  const med = (obj, pick) =>
    Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === "object" ? med(v, (r) => pick(r)[k]) : typeof v === "number" ? median(rs.map((r) => pick(r)[k])) : v]))
  summary[which] = med(rs[0], (r) => r)
}
console.log(JSON.stringify(summary, null, 2))
