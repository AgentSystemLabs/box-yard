#!/usr/bin/env node
// React renders per live (SSE) event in the Coordinator view, against the heavy mock yard.
//
//   npm run build
//   PORT=4001 BOXYARD_MOCK=1 BOXYARD_MOCK_HEAVY=1 BOXYARD_DATA_DIR=/tmp/heavy node dist/server/server/index.js &
//   npm i --no-save playwright && npx playwright install chromium   (or PLAYWRIGHT_MODULE=/path/to/playwright)
//   node scripts/perf/sse-renders.mjs http://localhost:4001 [label] [runs]
//
// Opens the Coordinator (/) at desktop width, then for each event kind POSTs /api/dev/pulse (one event every 50 ms,
// so each lands in its own frame) and counts, per event: React commits, components that rendered, and main-thread
// time. Runs every kind `runs` times in a fresh page and prints the medians, plus the components that rendered most
// in the median run. Renders are counted with a stand-in React DevTools hook, as in ui-bench.mjs.
// SSE_PATH=/?session=<task> measures with a task open in the side panel; SSE_CPU=4 throttles the CPU like a phone;
// SSE_TOP=<n> lists more components.

const base = process.argv[2] ?? "http://localhost:4001"
const label = process.argv[3] ?? "run"
const runs = Number(process.argv[4] ?? 5)
const path = process.env.SSE_PATH ?? "/"
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")

const HOOK = () => {
  const stats = { commits: 0, rendered: 0, byName: {} }
  window.__perf = stats
  const COMPONENT_TAGS = new Set([0, 1, 11, 15])
  const name = (f) => {
    const t = f.type
    return (t && (t.displayName || t.name)) || (t && t.render && (t.render.displayName || t.render.name)) || "anon"
  }
  const visit = (fiber, mounting) => {
    for (let f = fiber; f; f = f.sibling) {
      const alt = f.alternate
      const mount = mounting || !alt
      if (COMPONENT_TAGS.has(f.tag) && (mount || (f.flags & 1) === 1)) {
        stats.rendered++
        const n = name(f)
        stats.byName[n] = (stats.byName[n] ?? 0) + 1
      }
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
      const cur = root.current
      visit(cur.child, !cur.alternate)
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    checkDCE() {},
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const r1 = (n) => Math.round(n * 10) / 10

const KINDS = [
  ["task", 30],
  ["task.message", 30],
  ["chat.delta", 40],
  ["chat.message", 10],
]

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined })
const results = Object.fromEntries(KINDS.map(([k]) => [k, []]))

for (let run = 0; run < runs; run++) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await context.addInitScript(HOOK)
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send("Performance.enable")
  // SSE_CPU=4: a phone-class CPU (Chrome's CPU throttling).
  if (process.env.SSE_CPU) await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.SSE_CPU) })
  const taskMs = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics")
    return metrics.find((m) => m.name === "TaskDuration").value * 1000
  }
  await page.goto(base + path, { waitUntil: "load" })
  await page.waitForSelector("textarea")
  await sleep(3000)
  for (const [kind, count] of KINDS) {
    await sleep(500)
    await page.evaluate(() => Object.assign(window.__perf, { commits: 0, rendered: 0, byName: {} }))
    const before = await taskMs()
    await page.evaluate(
      ({ kind, count }) => fetch("/api/dev/pulse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, count, intervalMs: 50 }) }),
      { kind, count },
    )
    await sleep(count * 50 + 1200)
    const after = await taskMs()
    const s = await page.evaluate(() => window.__perf)
    results[kind].push({ commits: s.commits / count, renders: s.rendered / count, mainMs: (after - before) / count, byName: s.byName, count })
  }
  await context.close()
}
await browser.close()

const out = { label, path, runs, cpuThrottle: Number(process.env.SSE_CPU ?? 1), at: new Date().toISOString(), kinds: {} }
for (const [kind] of KINDS) {
  const rs = results[kind]
  const mid = median(rs.map((r) => r.renders))
  const pick = rs.find((r) => r.renders === mid)
  out.kinds[kind] = {
    commitsPerEvent: r1(median(rs.map((r) => r.commits))),
    rendersPerEvent: r1(mid),
    rendersPerEventRuns: rs.map((r) => r1(r.renders)),
    mainThreadPerEventMs: r1(median(rs.map((r) => r.mainMs))),
    mainThreadPerEventRuns: rs.map((r) => r1(r.mainMs)),
    topRendered: Object.entries(pick.byName)
      .sort((a, b) => b[1] - a[1])
      .slice(0, Number(process.env.SSE_TOP ?? 15))
      .map(([k, v]) => `${k}×${r1(v / pick.count)}`)
      .join(", "),
  }
}
console.log(JSON.stringify(out, null, 2))
