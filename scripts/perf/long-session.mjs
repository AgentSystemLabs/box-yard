#!/usr/bin/env node
// Memory over a long session. The side panel opens 20 task conversations and every Captain, one after another, and
// the reader scrolls each one up into its history before moving on (--no-scroll: stays at the bottom; --pulse: live
// SSE traffic between pages, via POST /api/dev/pulse). Then the panel closes and, after a forced GC, it reports the
// growth of the JS heap, of DOM nodes outside the document (detached: alive only because something still holds them)
// and of event listeners, against the same page before the session. Median of --runs fresh pages. --idle=<s> waits
// that long before measuring, e.g. 330 to get past React Query's 5-minute gcTime, as a tab left open would.
//
//   npm run build
//   PORT=4001 BOXYARD_MOCK=1 BOXYARD_MOCK_HEAVY=1 BOXYARD_DATA_DIR=/tmp/heavy node dist/server/server/index.js &
//   node scripts/perf/long-session.mjs --seed=/tmp/heavy   (once, server running: 20 long task chats and Captain chats)
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_PATH=/path/to/chrome \
//     node scripts/perf/long-session.mjs http://localhost:4001 [--runs=3] [--no-scroll] [--pulse] [--idle=330]
//
// Only an isolated mock server is accepted. Nothing is sent but the dev pulses.
import assert from "node:assert/strict"
import path from "node:path"

const args = process.argv.slice(2)
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const seedDir = flag("seed")

if (seedDir) {
  // The heavy fixture has one long task conversation and no Captain messages: copy it to 20 tasks and every Captain.
  const { default: Database } = await import("better-sqlite3")
  const db = new Database(path.join(seedDir, "box-yard.sqlite"))
  const thread = db.prepare("SELECT role, content, meta_json, created_at FROM task_messages WHERE task_id = 'task_heavy-thread' ORDER BY created_at LIMIT 400").all()
  assert(thread.length, "No heavy thread: start the server with BOXYARD_MOCK_HEAVY=1 on this data dir first")
  const task = db.prepare("INSERT OR IGNORE INTO task_messages (id, task_id, role, content, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
  const captain = db.prepare("INSERT OR IGNORE INTO captain_messages (id, project_id, role, content, meta_json, seen_by_captain, created_at) VALUES (?, ?, ?, ?, NULL, 1, ?)")
  const projects = db.prepare("SELECT id FROM projects").all()
  db.transaction(() => {
    for (let t = 1; t <= 20; t++) thread.forEach((m, i) => task.run(`tm_long${t}_${i}`, `task_heavy-${String(t).padStart(3, "0")}`, m.role, `${m.content} (copy ${t})`, m.meta_json, m.created_at))
    for (const p of projects) thread.slice(0, 300).forEach((m, i) => captain.run(`cm_long_${p.id}_${i}`, p.id, m.role === "tool" ? "assistant" : m.role, `${m.content} (${p.id})`, m.created_at))
  })()
  db.close()
  console.log(`Seeded ${thread.length} messages into 20 tasks and 300 into ${projects.length} Captains`)
  process.exit(0)
}

const base = args.find((a) => !a.startsWith("--"))
if (!base) throw new Error("Pass an isolated mock URL (or --seed=<data dir>)")
const runs = Number(flag("runs") ?? 3)
const scroll = !args.includes("--no-scroll")
const pulse = args.includes("--pulse")
const idleMs = Number(flag("idle") ?? 0) * 1000
const url = new URL(base)
assert(["localhost", "127.0.0.1"].includes(url.hostname) && url.port !== "3000", "Use an isolated loopback port")
assert.equal((await (await fetch(new URL("/api/health", base))).json()).mock, true)
const projects = await (await fetch(new URL("/api/projects", base))).json()
const pages = [...Array.from({ length: 20 }, (_, i) => `/?session=task_heavy-${String(i + 1).padStart(3, "0")}`), ...projects.map((p) => `/?captain=${p.id}`)]

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ["--mute-audio"] })
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const r2 = (x) => Math.round(x * 100) / 100
const sendPulse = (kind, count) =>
  fetch(new URL("/api/dev/pulse", base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, count }) })

async function measure(page, cdp) {
  for (let i = 0; i < 3; i++) await cdp.send("HeapProfiler.collectGarbage")
  const { usedSize } = await cdp.send("Runtime.getHeapUsage")
  const { nodes, jsEventListeners } = await cdp.send("Memory.getDOMCounters")
  const inDocument = await page.evaluate(() => {
    let n = 1
    for (const w = document.createTreeWalker(document, NodeFilter.SHOW_ALL); w.nextNode(); ) n++
    return n
  })
  return { heapMB: usedSize / 1048576, outsideDocument: nodes - inDocument, listeners: jsEventListeners }
}

async function session() {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await context.addInitScript(() => {
    localStorage.setItem("box-yard:setup-skipped", "true")
    localStorage.setItem("boxyard:voice", JSON.stringify({ enabled: false }))
  })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", (e) => errors.push(e.message))
  const cdp = await context.newCDPSession(page)
  await cdp.send("HeapProfiler.enable")
  await page.goto(new URL("/", base).href)
  await page.locator("[data-testid=chat-panel] [data-chat-id]").first().waitFor({ timeout: 60_000 })
  await page.waitForTimeout(3000)
  const before = await measure(page, cdp)
  let readUp = 0
  for (const to of pages) {
    await page.evaluate((u) => history.pushState(null, "", u), to)
    const panel = page.locator('[role="dialog"]').first()
    // Its conversation is in: the panel's list has more than a screen to scroll.
    await page.waitForFunction(() => [...(document.querySelector('[role="dialog"]')?.querySelectorAll(".overflow-y-auto") ?? [])].some((s) => s.scrollHeight - s.clientHeight > 200), null, { timeout: 15_000 })
    await page.waitForTimeout(600)
    if (scroll) {
      const box = await panel.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      for (let i = 0; i < 4; i++) {
        await page.mouse.wheel(0, -400)
        await page.waitForTimeout(60)
      }
      await page.waitForTimeout(300)
      // The panel's list is now away from its bottom, as a reader leaves it.
      readUp += await panel.evaluate((el) => ([...el.querySelectorAll(".overflow-y-auto")].some((s) => s.scrollHeight - s.scrollTop - s.clientHeight > 200) ? 1 : 0))
    }
    if (pulse) {
      for (const [kind, count] of [["task", 20], ["task.message", 20], ["chat.reply", 1]]) await sendPulse(kind, count)
      await page.waitForTimeout(300)
    }
  }
  await page.evaluate(() => history.pushState(null, "", "/"))
  await page.waitForTimeout(1500 + idleMs)
  const after = await measure(page, cdp)
  await context.close()
  if (errors.length) throw new Error(errors.join("; "))
  if (scroll) assert.equal(readUp, pages.length, `Only ${readUp} of ${pages.length} lists were scrolled up`)
  return {
    heapGrowthMB: r2(after.heapMB - before.heapMB),
    detachedNodeGrowth: after.outsideDocument - before.outsideDocument,
    listenerGrowth: after.listeners - before.listeners,
    heapAfterMB: r2(after.heapMB),
  }
}

const each = []
for (let i = 0; i < runs; i++) each.push(await session())
await browser.close()
const summary = Object.fromEntries(Object.keys(each[0]).map((k) => [k, median(each.map((e) => e[k]))]))
console.log(JSON.stringify({ base, pages: pages.length, scroll, pulse, idleS: idleMs / 1000, runs, median: summary, each }, null, 1))
