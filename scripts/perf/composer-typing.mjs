#!/usr/bin/env node
// Composer typing latency on the heavy mock yard, with the CPU slowed down like a slow phone.
//
//   npm run build
//   PORT=4001 BOXYARD_MOCK=1 BOXYARD_MOCK_HEAVY=1 BOXYARD_DATA_DIR=/tmp/heavy node dist/server/server/index.js &
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/perf/composer-typing.mjs http://localhost:4001 [label] [runs] [throttle]
//
// For each composer (the Coordinator's on /, a Captain's, a task's next to the Coordinator) it types plain text,
// text with an "@" and a "!" pick, and plain text at the end of a 40-line draft, one key at a time, and reports
// per key: keydown-to-next-frame latency (median, p95), main-thread and script time, React commits and component
// renders, and the components that rendered most. Runs are repeated and the median of the per-run medians is printed. Prints JSON.
// Renders are counted with a stand-in React DevTools hook: a component counts when it performed work in a commit.

const base = process.argv[2] ?? "http://localhost:4001"
const label = process.argv[3] ?? "run"
const runs = Number(process.argv[4] ?? 5)
const throttle = Number(process.argv[5] ?? 4)
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")

const HOOK = () => {
  const stats = { commits: 0, rendered: 0, byName: {} }
  window.__perf = stats
  const COMPONENT_TAGS = new Set([0, 1, 11, 15])
  const name = (f) => {
    const t = f.type
    return (t && (t.displayName || t.name)) || (t && t.render && (t.render.displayName || t.render.name)) || (t && t.type && (t.type.displayName || t.type.name)) || "anon"
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
  localStorage.setItem("box-yard:setup-skipped", "true")
  localStorage.setItem("boxyard:voice", JSON.stringify({ enabled: false }))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pct = (arr, p) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const median = (arr) => pct(arr, 50)
const r1 = (n) => Math.round(n * 10) / 10

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined })

const PLAIN = "the quick brown fox jumps over the lazy dog"
// Opens the "@" list, filters it, closes it with a space; then the same for "!".
const PICKS = "run it on @bo then use !cl and check"
// A long draft (past the box's cap, so it scrolls) to type at the end of.
const LONG = Array.from({ length: 40 }, (_, i) => `${i + 1}. the step that comes next, with enough words to wrap`).join("\n") + "\n"
const SCENARIOS = [
  { name: "coordinator", path: "/", box: 'textarea[placeholder^="Ask the Coordinator"]' },
  { name: "captain", path: "/projects/prj_heavy-yard", box: 'textarea[placeholder^="Message the Captain"]' },
  { name: "task", path: "/tasks/task_heavy-thread", box: 'textarea[placeholder^="Send feedback"]' },
]

async function measure(page, cdp, selector, text, draft = "") {
  const metric = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics")
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]))
    return { task: m.TaskDuration * 1000, script: m.ScriptDuration * 1000 }
  }
  await page.click(selector)
  if (draft) {
    await page.fill(selector, draft)
    await page.keyboard.press("Control+End")
  }
  await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    window.__lat = []
    // Keydown to the frame after its paint: rAF, then a task after it.
    el.addEventListener(
      "keydown",
      (e) => {
        const t0 = e.timeStamp
        requestAnimationFrame(() => {
          const ch = new MessageChannel()
          ch.port1.onmessage = () => window.__lat.push(performance.now() - t0)
          ch.port2.postMessage(0)
        })
      },
      true,
    )
  }, selector)
  await sleep(300)
  await page.evaluate(() => {
    window.__perf.commits = 0
    window.__perf.rendered = 0
    window.__perf.byName = {}
  })
  const before = await metric()
  for (const ch of text) {
    await page.keyboard.type(ch)
    await sleep(80)
  }
  await sleep(400)
  const after = await metric()
  const s = await page.evaluate(() => ({ ...window.__perf, lat: window.__lat }))
  await page.keyboard.press("Control+A")
  await page.keyboard.press("Backspace")
  await sleep(200)
  return {
    latencyMedianMs: median(s.lat),
    latencyP95Ms: pct(s.lat, 95),
    mainThreadPerKeyMs: (after.task - before.task) / text.length,
    scriptPerKeyMs: (after.script - before.script) / text.length,
    commitsPerKey: s.commits / text.length,
    rendersPerKey: s.rendered / text.length,
    byName: Object.fromEntries(Object.entries(s.byName).map(([k, v]) => [k, v / text.length])),
  }
}

const results = {}
for (let run = 0; run < runs; run++) {
  for (const sc of SCENARIOS) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
    await context.addInitScript(HOOK)
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send("Performance.enable")
    await page.goto(base + sc.path, { waitUntil: "load" })
    await page.waitForSelector(sc.box)
    await sleep(2500)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle })
    for (const [kind, text, draft] of [["plain", PLAIN], ["picks", PICKS], ["long draft", PLAIN, LONG]]) {
      const r = await measure(page, cdp, sc.box, text, draft)
      ;((results[`${sc.name}:${kind}`] ??= []).push(r))
    }
    await context.close()
  }
}

const summary = { label, runs, cpuThrottle: throttle, at: new Date().toISOString() }
for (const [key, list] of Object.entries(results)) {
  const names = {}
  for (const r of list) for (const [k, v] of Object.entries(r.byName)) (names[k] ??= []).push(v)
  summary[key] = {
    latencyMedianMs: r1(median(list.map((r) => r.latencyMedianMs))),
    latencyP95Ms: r1(median(list.map((r) => r.latencyP95Ms))),
    mainThreadPerKeyMs: r1(median(list.map((r) => r.mainThreadPerKeyMs))),
    scriptPerKeyMs: r1(median(list.map((r) => r.scriptPerKeyMs))),
    commitsPerKey: r1(median(list.map((r) => r.commitsPerKey))),
    rendersPerKey: r1(median(list.map((r) => r.rendersPerKey))),
    topRendered: Object.entries(names)
      .map(([k, v]) => [k, median(v)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([k, v]) => `${k}×${r1(v)}`)
      .join(", "),
  }
}
console.log(JSON.stringify(summary, null, 2))
await browser.close()
