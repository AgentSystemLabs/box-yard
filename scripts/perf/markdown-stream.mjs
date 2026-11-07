#!/usr/bin/env node
// Streaming Markdown bench: what a long Coordinator reply costs the main thread while it streams in.
//
//   npm run build
//   PORT=4001 BOXYARD_MOCK=1 BOXYARD_MOCK_HEAVY=1 BOXYARD_DATA_DIR=/tmp/heavy node dist/server/server/index.js &
//   npm i --no-save playwright && npx playwright install chromium   (or PLAYWRIGHT_MODULE=/path/to/playwright)
//   node scripts/perf/markdown-stream.mjs http://localhost:4001 [label] [--cpu 4] [--deltas 700] [--runs 3]
//
// Streams the heavy fixture's ~12k-character Markdown reply (headings, lists, tables, code) into the Coordinator chat
// over SSE, 16 characters per delta (POST /api/dev/pulse kind "chat.stream"), and measures main-thread time per delta
// (per quarter of the stream, as the reply grows), delta-to-paint latency, long tasks, dropped frames and React
// component renders per delta. `--cpu 4` slows the CPU 4x, roughly a phone. Prints JSON with each run and the median.

const args = process.argv.slice(2)
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? Number(args[i + 1]) : def
}
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"))
const base = positional[0] ?? "http://localhost:4001"
const label = positional[1] ?? "run"
const cpu = flag("cpu", 1)
const deltas = flag("deltas", 700)
const runs = flag("runs", 3)
const intervalMs = flag("interval", 30)
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")

const HOOK = () => {
  const stats = { commits: 0, rendered: 0 }
  window.__perf = stats
  const COMPONENT_TAGS = new Set([0, 1, 11, 15])
  const visit = (fiber, mounting) => {
    for (let f = fiber; f; f = f.sibling) {
      const alt = f.alternate
      const mount = mounting || !alt
      if (COMPONENT_TAGS.has(f.tag) && (mount || (f.flags & 1) === 1)) stats.rendered++
      if (f.child && (mount || f.child !== alt.child)) visit(f.child, mount)
    }
  }
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer) {
      this.renderers.set(1, renderer)
      return 1
    },
    onCommitFiberRoot(_id, root) {
      stats.commits++
      visit(root.current.child, !root.current.alternate)
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    checkDCE() {},
  }
  window.__longtasks = []
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__longtasks.push(e.duration)
  }).observe({ type: "longtask" })
  // Delta-to-paint: from a chat.delta arriving to the frame after the app handled it.
  window.__lat = []
  const Native = window.EventSource
  window.EventSource = class extends Native {
    constructor(...a) {
      super(...a)
      this.addEventListener("message", (e) => {
        if (!window.__measuring || !e.data.includes('"chat.delta"')) return
        const t0 = performance.now()
        setTimeout(() =>
          requestAnimationFrame(() => {
            const ch = new MessageChannel()
            ch.port1.onmessage = () => window.__lat.push(performance.now() - t0)
            ch.port2.postMessage(0)
          }),
        )
      })
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pct = (arr, p) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const r1 = (n) => Math.round(n * 10) / 10
const median = (xs) => pct(xs, 50)

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined })

async function run() {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await context.addInitScript(HOOK)
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send("Performance.enable")
  const metric = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics")
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]))
    return { task: m.TaskDuration * 1000, script: m.ScriptDuration * 1000, layout: m.LayoutDuration * 1000, style: m.RecalcStyleDuration * 1000, layouts: m.LayoutCount }
  }
  await page.goto(base + "/", { waitUntil: "load" })
  await page.waitForSelector("[data-testid=chat-panel] textarea")
  await sleep(2500)
  if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu })
  await page.evaluate(() => {
    window.__perf.commits = 0
    window.__perf.rendered = 0
    window.__longtasks = []
    window.__lat = []
    window.__measuring = true
    // Frame gaps while the reply streams.
    window.__frames = []
    const tick = (t) => {
      window.__frames.push(t)
      if (window.__measuring) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const samples = [await metric()]
  const t0 = Date.now()
  await page.evaluate(
    ({ count, intervalMs }) =>
      fetch("/api/dev/pulse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "chat.stream", count, intervalMs }) }),
    { count: deltas, intervalMs },
  )
  // Sample main-thread time at each quarter of the stream.
  const span = deltas * intervalMs
  for (let q = 1; q <= 4; q++) {
    await sleep(Math.max(0, t0 + (span * q) / 4 - Date.now()))
    samples.push(await metric())
  }
  // Let a backlog drain, then the finished message replaces the stream.
  await sleep(1500)
  const end = await metric()
  const s = await page.evaluate(() => {
    window.__measuring = false
    return { ...window.__perf, longtasks: window.__longtasks, lat: window.__lat, frames: window.__frames }
  })
  if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
  await context.close()
  const gaps = s.frames.slice(1).map((t, i) => t - s.frames[i])
  const perDelta = (a, b) => r1((b.task - a.task) / (deltas / 4))
  return {
    mainThreadMs: r1(end.task - samples[0].task),
    scriptMs: r1(end.script - samples[0].script),
    layoutMs: r1(end.layout - samples[0].layout),
    styleMs: r1(end.style - samples[0].style),
    layouts: end.layouts - samples[0].layouts,
    perDeltaMsByQuarter: [1, 2, 3, 4].map((q) => perDelta(samples[q - 1], samples[q])),
    deltaToPaintP50Ms: r1(pct(s.lat, 50)),
    deltaToPaintP95Ms: r1(pct(s.lat, 95)),
    longTasks: s.longtasks.length,
    longTaskTotalMs: r1(s.longtasks.reduce((n, d) => n + d, 0)),
    framesOver50Ms: gaps.filter((g) => g > 50).length,
    frameMaxMs: r1(Math.max(0, ...gaps)),
    commits: s.commits,
    componentRendersPerDelta: r1(s.rendered / deltas),
  }
}

const results = []
for (let i = 0; i < runs; i++) results.push(await run())
await browser.close()
const keys = Object.keys(results[0]).filter((k) => typeof results[0][k] === "number")
const med = Object.fromEntries(keys.map((k) => [k, median(results.map((r) => r[k]))]))
med.perDeltaMsByQuarter = [0, 1, 2, 3].map((q) => median(results.map((r) => r.perDeltaMsByQuarter[q])))
console.log(JSON.stringify({ label, at: new Date().toISOString(), cpu, deltas, intervalMs, chars: deltas * 16, median: med, runs: results }, null, 2))
