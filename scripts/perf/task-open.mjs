#!/usr/bin/env node
// Measures opening a task's conversation from the sidebar: click a task row → the panel's header on screen → its
// transcript painted (the newest messages in, its loading state gone). Read-only: nothing is sent.
//
//   npm run build
//   PORT=4001 BOXYARD_MOCK=1 BOXYARD_MOCK_HEAVY=1 BOXYARD_DATA_DIR=/tmp/heavy node dist/server/server/index.js &
//   PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROMIUM_PATH=/path/to/chrome \
//     node scripts/perf/task-open.mjs http://localhost:4001 --seed=/tmp/heavy [--phone] [--runs=3] [--tasks=12]
//
// --seed=<data dir>: the heavy fixture has one long thread; give every other task a transcript too (the newest 80, 200,
// 400 or 1000 of its messages in turn), straight into the mock's SQLite. Only once per data dir.
// --phone: 4× CPU slowdown and a 150 ms, 10 Mbit/s network, like a phone on Tailscale.
// Each run opens --tasks tasks on a fresh page, each the way a mouse does: onto the row, a 120 ms pause, press, release
// 40 ms later. --touch: a finger's tap instead, held 90 ms, with no hover before it.
// "cold" is a task's first open on the page, "warm" opening it again after its panel closed.
import assert from "node:assert/strict"

const [base, ...flags] = process.argv.slice(2)
if (!base) throw new Error("Pass an isolated mock URL")
const flag = (name) => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3)
const phone = flags.includes("--phone")
const touch = flags.includes("--touch")
const runs = Number(flag("runs") ?? 3)
const taskCount = Number(flag("tasks") ?? 12)
const url = new URL(base)
assert(["localhost", "127.0.0.1"].includes(url.hostname) && url.port !== "3000", "Use an isolated loopback port")
assert.equal((await (await fetch(new URL("/api/health", base))).json()).mock, true)

if (flag("seed")) {
  const { default: Database } = await import("better-sqlite3")
  const db = new Database(`${flag("seed")}/box-yard.sqlite`)
  db.pragma("busy_timeout = 5000")
  const source = db.prepare("SELECT role, content, meta_json FROM task_messages WHERE task_id = 'task_heavy-thread' ORDER BY created_at DESC LIMIT 1000").all().reverse()
  const tasks = db.prepare("SELECT id FROM tasks WHERE id LIKE 'task_heavy-%' AND id != 'task_heavy-thread' ORDER BY id").all()
  const insert = db.prepare("INSERT OR IGNORE INTO task_messages (id, task_id, role, content, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
  const sizes = [80, 200, 400, 1000]
  const now = Date.now()
  db.transaction(() => {
    tasks.forEach((t, i) => {
      const list = source.slice(-sizes[i % sizes.length])
      // Each task's text is its own, as in a real yard: parsed Markdown is cached by text.
      list.forEach((m, j) => insert.run(`tm_seed-${t.id.slice(11)}-${j}`, t.id, m.role, `${m.content} (${t.id.slice(11)}.${j})`, m.meta_json, now - (list.length - j) * 30_000))
    })
  })()
  db.close()
}

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ["--mute-audio"] })
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null)
const max = (xs) => (xs.length ? Math.max(...xs) : null)
const round = (x) => (x === null ? null : Math.round(x))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// In the page: from a row's click, watch every frame for the panel and its transcript.
const WATCH = () => {
  window.__open = { long: [] }
  new PerformanceObserver((l) => window.__open.long.push(...l.getEntries().map((e) => ({ start: e.startTime, duration: e.duration })))).observe({ type: "longtask", buffered: true })
  window.__watchOpen = (title) => {
    const r = { title, click: null, down: null, shell: null, painted: null, waited: false, loading: false, newestInView: null }
    window.__open.current = r
    const onDown = (e) => (r.down = e.timeStamp)
    const onClick = (e) => {
      r.click = e.timeStamp
      const frame = () => {
        const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.getAttribute("aria-label") === title)
        const now = performance.now()
        if (dialog && r.shell === null) r.shell = now
        // Its transcript still loading: <Loading> (invisible for its first 300 ms), or the older "Loading transcript…".
        const loading = dialog?.querySelector("[data-loading]")
        const oldLoading = dialog?.textContent.includes("Loading transcript")
        if (loading || oldLoading) r.waited = true
        if (loading?.dataset.loading === "shown" || oldLoading) r.loading = true
        const list = dialog?.querySelector(".flow-root")
        // Rows are in: this frame paints them, pinned to the bottom (StickyScroll's resize observer runs before paint).
        if (list && list.children.length > 0 && !loading && !oldLoading) {
          // The frame paints once its rAF callbacks, layout and observers are done: a task queued now runs after it.
          const ch = new MessageChannel()
          ch.port1.onmessage = () => {
            r.painted = performance.now()
            // What that frame showed: the newest row in view (the list pinned to the bottom, #270).
            const box = list.parentElement.getBoundingClientRect()
            const last = list.lastElementChild.getBoundingClientRect()
            r.newestInView = last.top < box.bottom && last.bottom > box.top
          }
          ch.port2.postMessage(0)
          return
        }
        if (now - r.click < 15_000) requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    }
    document.addEventListener("pointerdown", onDown, { capture: true, once: true })
    document.addEventListener("click", onClick, { capture: true, once: true })
  }
}

async function openPage() {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, hasTouch: touch })
  await context.addInitScript(() => {
    localStorage.setItem("box-yard:setup-skipped", "true")
    localStorage.setItem("boxyard:voice", JSON.stringify({ enabled: false }))
  })
  await context.addInitScript(WATCH)
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", (e) => errors.push(e.message))
  const cdp = await context.newCDPSession(page)
  if (phone) {
    await cdp.send("Network.enable")
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (10 * 1024 * 1024) / 8, uploadThroughput: (5 * 1024 * 1024) / 8 })
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  }
  await page.goto(new URL("/", base).href)
  await page.locator("[data-testid=chat-panel] [data-chat-id]").first().waitFor({ timeout: 60_000 })
  // Let the app settle: its first requests, the Captain prefetch and its idle work.
  await sleep(phone ? 8000 : 4000)
  return { context, page, cdp, errors }
}

/** Open one task from its sidebar row, the way a mouse does, and close it again. */
async function openTask(page, cdp, task) {
  const row = page.locator(`nav[aria-label="Projects and tasks"] button[title^="${task.title.replace(/"/g, '\\"')} · "]`).last()
  await row.scrollIntoViewIfNeeded()
  await page.evaluate((title) => window.__watchOpen(title), task.title)
  const box = await row.boundingBox()
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2]
  if (touch) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
    await sleep(90)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  } else {
    await page.mouse.move(x, y, { steps: 4 })
    await sleep(120)
    await page.mouse.down()
    await sleep(40)
    await page.mouse.up()
  }
  await page.waitForFunction(() => window.__open.current.painted !== null, null, { timeout: 30_000 })
  const r = await page.evaluate((id) => {
    const r = window.__open.current
    const long = window.__open.long.filter((e) => e.start + e.duration > r.click && e.start < r.painted)
    const fetches = performance.getEntriesByType("resource").filter((e) => e.name.endsWith(`/api/tasks/${id}/messages`))
    const f = fetches.at(-1)
    return {
      shell: r.shell - r.click,
      painted: r.painted - r.click,
      fromPress: r.painted - r.down,
      waited: r.waited,
      loading: r.loading,
      newestInView: r.newestInView,
      longTaskMs: long.reduce((s, e) => s + e.duration, 0),
      longestTask: long.length ? Math.max(...long.map((e) => e.duration)) : 0,
      fetchMs: f && f.startTime > r.down - 1000 ? f.responseEnd - f.startTime : null,
      fetchBeforeClick: f && f.startTime > r.down - 1000 ? r.click - f.startTime : null,
      bytes: f ? f.encodedBodySize : null,
    }
  }, task.id)
  await page.keyboard.press("Escape")
  await page.waitForFunction((title) => ![...document.querySelectorAll('[role="dialog"]')].some((d) => d.getAttribute("aria-label") === title), task.title)
  await sleep(phone ? 1200 : 600)
  return r
}

const all = await (await fetch(new URL("/api/tasks", base))).json()
const counts = Object.fromEntries(await Promise.all(all.map(async (t) => [t.id, (await (await fetch(new URL(`/api/tasks/${t.id}/messages`, base))).json()).length])))
const results = { cold: [], warm: [] }
for (let run = 0; run < runs; run++) {
  const { context, page, cdp, errors } = await openPage()
  const titles = await page.$$eval('nav[aria-label="Projects and tasks"] section button[title]', (els) => els.map((e) => e.title))
  const shown = all.filter((t) => counts[t.id] > 0 && titles.some((x) => x.startsWith(`${t.title} · `)))
  // A different slice of tasks each run, so every run's first opens are cold.
  const picks = Array.from({ length: Math.min(taskCount, shown.length) }, (_, i) => shown[(run * taskCount + i) % shown.length])
  for (const t of picks) results.cold.push({ ...(await openTask(page, cdp, t)), messages: counts[t.id] })
  for (const t of picks.slice(0, 4)) results.warm.push({ ...(await openTask(page, cdp, t)), messages: counts[t.id] })
  if (errors.length) console.error("page errors:", errors)
  await context.close()
}
await browser.close()

const summary = (list) => ({
  opens: list.length,
  clickToShellMs: round(median(list.map((r) => r.shell))),
  clickToPaintedMs: round(median(list.map((r) => r.painted))),
  clickToPaintedMaxMs: round(max(list.map((r) => r.painted))),
  pressToPaintedMs: round(median(list.map((r) => r.fromPress))),
  waitedForMessages: list.filter((r) => r.waited).length,
  showedLoading: list.filter((r) => r.loading).length,
  newestNotInView: list.filter((r) => !r.newestInView).length,
  longTaskMs: round(median(list.map((r) => r.longTaskMs))),
  longestTaskMs: round(max(list.map((r) => r.longestTask))),
  fetchMs: round(median(list.flatMap((r) => (r.fetchMs === null ? [] : [r.fetchMs])))),
  fetchStartedBeforeClickMs: round(median(list.flatMap((r) => (r.fetchBeforeClick === null ? [] : [r.fetchBeforeClick])))),
  kbMedian: round(median(list.flatMap((r) => (r.bytes ? [r.bytes / 1024] : [])))),
})
const bySize = Object.fromEntries(
  [...new Set(results.cold.map((r) => r.messages))].sort((a, b) => a - b).map((n) => [`${n} messages`, round(median(results.cold.filter((r) => r.messages === n).map((r) => r.painted)))]),
)
console.log(JSON.stringify({ base, phone, touch, runs, cold: summary(results.cold), coldClickToPaintedBySize: bySize, warm: summary(results.warm) }, null, 2))
