#!/usr/bin/env node
// Phone jank bench against the heavy mock yard: a 393×852 touch phone with the CPU throttled (4x by default).
//
//   Build and start the heavy mock server, with Playwright installed, as in ui-bench.mjs. Then:
//   node scripts/perf/phone-jank.mjs http://localhost:4001 [runs=5]
//
// Each scenario runs in a fresh page, `runs` times; prints every run to stderr and the medians as JSON.
// - scroll-up-chat / scroll-up-task: 40 finger flings up the Coordinator chat / the 2000-event task thread, while
//   older rows load in (useTail). Long tasks (longest, total blocking time) and the slowest frames.
// - stream: a reply streaming in (40 chat.delta, 100 ms apart). - replies: 5 new Coordinator replies, 1 s apart.
//   Main-thread, style and layout time from CDP, plus long tasks.
// - insert: style + layout for one empty row added to the end of the chat list. It should cost about nothing; a
//   CSS :has() on an element around the list (e.g. a Tailwind group-has-*) makes it restyle the whole list.
// Env: CPU=4 (throttle rate), FLINGS=40, ONLY=scroll-up-chat,insert (a subset).

const base = process.argv[2] ?? "http://localhost:4001"
const runs = Number(process.argv[3] ?? 5)
const cpu = Number(process.env.CPU ?? 4)
const flings = Number(process.env.FLINGS ?? 40)
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const round = (n) => Math.round(n * 10) / 10
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const blocking = (lt) => lt.reduce((n, d) => n + Math.max(0, d - 50), 0)

const CHAT = { path: "/", ready: '[data-testid="chat-footer"] textarea', root: '[data-testid="chat-panel"]' }
const TASK = { path: "/?session=task_heavy-thread", ready: 'textarea[placeholder^="Send feedback"]', root: '[role="dialog"]' }

async function open(browser, where) {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
  await context.addInitScript(() => {
    window.__lt = []
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__lt.push(e.duration)
    }).observe({ type: "longtask" })
  })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send("Performance.enable")
  await page.goto(base + where.path)
  await page.waitForSelector(where.ready)
  await sleep(2500)
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu })
  const scroller = await page.evaluateHandle((sel) => {
    const root = document.querySelector(sel)
    return [...root.querySelectorAll("*")].find((e) => e.scrollHeight > e.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(e).overflowY))
  }, where.root)
  return { context, page, cdp, scroller }
}

async function metrics(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics")
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]))
  return { main: m.TaskDuration * 1000, style: m.RecalcStyleDuration * 1000, layout: m.LayoutDuration * 1000 }
}

async function scrollUp(browser, where) {
  const { context, page, cdp, scroller } = await open(browser, where)
  const box = await scroller.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2) }
  })
  await page.evaluate(() => {
    window.__lt = []
    window.__frames = []
    let last = performance.now()
    const tick = (t) => {
      window.__frames.push(t - last)
      last = t
      if (!window.__stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  // A finger fling: touch down, drag 400px down over ~100 ms (scrolls up), lift, let it glide.
  for (let i = 0; i < flings; i++) {
    const y0 = 250
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x, y: y0 }] })
    for (let s = 1; s <= 8; s++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x, y: y0 + (400 * s) / 8 }] })
      await sleep(12)
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    await sleep(250)
  }
  await sleep(500)
  const { lt, frames, rows } = await scroller.evaluate((el) => {
    window.__stop = true
    return { lt: window.__lt, frames: window.__frames.slice(1), rows: el.firstElementChild.children.length }
  })
  await context.close()
  return {
    longestTask: round(Math.max(0, ...lt)),
    tbt: round(blocking(lt)),
    framesOver50: frames.filter((f) => f > 50).length,
    maxFrame: round(Math.max(0, ...frames)),
    rowsShown: rows,
  }
}

async function live(browser, body, wait) {
  const { context, page, cdp } = await open(browser, CHAT)
  await page.evaluate(() => {
    window.__lt = []
  })
  await sleep(300)
  const a = await metrics(cdp)
  await fetch(base + "/api/dev/pulse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  await sleep(wait)
  const b = await metrics(cdp)
  const lt = await page.evaluate(() => window.__lt)
  await context.close()
  return {
    mainMs: round(b.main - a.main),
    styleMs: round(b.style - a.style),
    layoutMs: round(b.layout - a.layout),
    longestTask: round(Math.max(0, ...lt)),
    tbt: round(blocking(lt)),
  }
}

async function insert(browser) {
  const { context, scroller } = await open(browser, CHAT)
  const out = await scroller.evaluate((el) => {
    const content = el.firstElementChild
    const times = []
    for (let i = 0; i < 7; i++) {
      const row = document.createElement("div")
      const t0 = performance.now()
      content.append(row)
      void el.scrollHeight
      times.push(performance.now() - t0)
      row.remove()
      void el.scrollHeight
    }
    return { times, elements: el.querySelectorAll("*").length }
  })
  await context.close()
  return { insertMs: round(median(out.times)), elements: out.elements }
}

const SCENARIOS = {
  "scroll-up-chat": (b) => scrollUp(b, CHAT),
  "scroll-up-task": (b) => scrollUp(b, TASK),
  stream: (b) => live(b, { kind: "chat.delta", count: 40, intervalMs: 100 }, 6000),
  replies: (b) => live(b, { kind: "chat.reply", count: 5, intervalMs: 1000 }, 7000),
  insert,
}
const only = process.env.ONLY?.split(",")

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const summary = { base, runs, cpu, chromium: browser.version() }
try {
  for (const [name, run] of Object.entries(SCENARIOS)) {
    if (only && !only.includes(name)) continue
    const results = []
    for (let i = 0; i < runs; i++) {
      const r = await run(browser)
      console.error(name, i + 1, JSON.stringify(r))
      results.push(r)
    }
    summary[name] = Object.fromEntries(Object.keys(results[0]).map((k) => [k, round(median(results.map((r) => r[k])))]))
  }
} finally {
  await browser.close()
}
console.log(JSON.stringify(summary, null, 2))
