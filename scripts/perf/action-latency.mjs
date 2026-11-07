#!/usr/bin/env node
// Click-to-result latency of the task actions, against the heavy mock yard.
//
//   npm run build
//   PORT=4001 BOXYARD_MOCK=1 BOXYARD_MOCK_HEAVY=1 BOXYARD_DATA_DIR=/tmp/heavy node dist/server/server/index.js &
//   npm i --no-save playwright && npx playwright install chromium   (or PLAYWRIGHT_MODULE=/path/to/playwright)
//   node scripts/perf/action-latency.mjs http://localhost:4001 [runs] [latencyMs]
//
// For each action, the time from the click (or Enter) to the frame that shows its result, in the task panel:
//   send   Enter in the task composer → the message is on screen (its Queued row)
//   stop   ⓘ › Stop task on a working task → the header no longer says Working
//   done   ⓘ › Mark done → the header says Done
//   merge  ⓘ › Merge PR… › Send merge request → the PR chip says "merge queued" / "merging…"
// `latencyMs` puts that much round-trip time between the page and the server (a TCP proxy that holds every chunk
// for half of it each way, the SSE stream too), like a phone on Tailscale; 0 is localhost. Each action runs `runs` times on fresh tasks; prints medians as JSON.
// Stop on a working mock task also waits for the runner's turn_end, which a real box takes longer to write. A result
// that never shows (15 s) is null in samplesMs and listed in `stuck` with what the server says.

const base = process.argv[2] ?? "http://localhost:4001"
const runs = Number(process.argv[3] ?? 5)
const latency = Number(process.argv[4] ?? 0)
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")
const net = await import("node:net")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const median = (a) => {
  const s = [...a].sort((x, y) => x - y)
  return s.length ? Math.round(s[Math.floor(s.length / 2)]) : null
}
const call = async (path, body, method = body === undefined ? "GET" : "POST") => {
  const res = await fetch(base + path, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}
const taskOf = (id) => call(`/api/tasks/${id}`)
async function until(fn, ms = 20_000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error("timed out")
    await sleep(100)
  }
}

// Fresh tasks in a project without a repo (so the mock agent can run them), each resting after one turn.
const projects = await call("/api/projects")
const home = projects.find((p) => !p.repo)?.id
if (!home) throw new Error("no repo-less project: start the server with BOXYARD_MOCK_HEAVY=1")
const settled = (t) => !["queued", "starting", "working"].includes(t.status)
async function fresh(n) {
  const ids = Array.from({ length: n }, (_, i) => `task_perf${Date.now().toString(36)}${i}`)
  for (const id of ids) await call("/api/tasks", { id, projectId: home, title: `Action latency ${id}`, prompt: "[pr] warm up" })
  for (const id of ids) await until(async () => settled(await taskOf(id)), 60_000)
  return ids
}
const pool = await fresh(runs * 3)
const take = () => pool.shift()
// Merge: every open PR the yard has (the request is answered before any turn runs).
const prs = (await call("/api/tasks")).filter((t) => t.prUrl && !t.mergeRequest && (t.prState ?? "open") === "open" && t.status !== "done").map((t) => t.id)

/** A TCP proxy to `base` that delays every chunk by `oneWay` ms in each direction, in order. Resolves with its URL. */
function delayProxy(oneWay) {
  const target = new URL(base)
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port || 80), target.hostname)
    const pipe = (from, to) => {
      from.on("data", (chunk) => setTimeout(() => to.writable && to.write(chunk), oneWay))
      from.on("end", () => setTimeout(() => to.end(), oneWay))
      from.on("error", () => to.destroy())
    }
    pipe(client, upstream)
    pipe(upstream, client)
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, server })))
}
const proxy = latency ? await delayProxy(latency / 2) : null
const pageBase = proxy?.url ?? base

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await context.newPage()
// Resolves with the time of the first frame that shows `pred()`: it is checked once per frame, just before paint, so
// the check itself doesn't force extra layouts while the page renders.
await page.addInitScript(() => {
  window.__until = (pred, ms = 20_000) =>
    new Promise((resolve, reject) => {
      const start = performance.now()
      const frame = () => {
        const now = performance.now()
        if (pred()) resolve(now)
        else if (now - start > ms) reject(new Error("timed out"))
        else requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
})

async function openTask(id) {
  await page.goto(`${pageBase}/?session=${encodeURIComponent(id)}`)
  await page.waitForSelector('[data-testid="task-header"]', { timeout: 30_000 })
  await sleep(300)
}

/** Click `selector` and time until `pred` (a function body over `document`) holds; null if it never did (in 15 s). */
async function timeClick(selector, pred) {
  return page.evaluate(
    async ({ selector, pred }) => {
      const el = [...document.querySelectorAll(selector.css)].find((e) => !selector.text || e.textContent?.includes(selector.text))
      if (!el) throw new Error(`no ${selector.css} ${selector.text ?? ""}`)
      const check = new Function(pred)
      const t0 = performance.now()
      el.click()
      return window.__until(check, 15_000).then((t) => t - t0, () => null)
    },
    { selector, pred },
  )
}
const menu = async () => {
  await page.click('button[aria-label="Task details and more actions"]')
  await page.waitForSelector('[role="dialog"]')
}
const HEADER = `document.querySelector('[data-testid="task-header"]')?.innerText ?? ""`

const results = { send: [], stop: [], done: [], merge: [] }
const stuck = []

for (let i = 0; i < runs; i++) {
  // send: an idle task's composer; the text shows as its Queued row.
  {
    const t = take()
    await openTask(t)
    const text = `perf send ${i} ${Date.now()}`
    await page.fill('textarea[placeholder^="Send feedback"]', text)
    const ms = await page.evaluate(async (text) => {
      const box = document.querySelector('textarea[placeholder^="Send feedback"]')
      // A textarea's value isn't in textContent: this is the message on screen, not the draft.
      const seen = () => document.body.textContent.includes(text)
      const t0 = performance.now()
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }))
      return (await window.__until(seen)) - t0
    }, text)
    results.send.push(ms)
    // Let its turn finish, so the next run's tasks aren't waiting on a slot.
    await until(async () => settled(await taskOf(t)), 60_000)
  }
  // stop: a working task (a long mock turn).
  {
    const t = take()
    await call(`/api/tasks/${t}/messages`, { content: "[slow:120] keep going" })
    await until(async () => (await taskOf(t)).status === "working")
    await openTask(t)
    await page.waitForFunction(() => /\bWorking\b/.test(document.querySelector('[data-testid="task-header"]')?.innerText ?? ""))
    await menu()
    const ms = await timeClick({ css: "button", text: "Stop task" }, `return !/\\bWorking\\b/.test(${HEADER})`)
    results.stop.push(ms)
    await until(async () => (await taskOf(t)).status !== "working")
    // Never showed: the server has long rested the task while the page still says Working.
    if (ms === null) stuck.push({ action: "stop", task: t, server: (await taskOf(t)).status, header: await page.evaluate(() => document.querySelector('[data-testid="task-header"]')?.innerText) })
  }
  // done: Mark done from the details (ⓘ).
  {
    const t = take()
    await openTask(t)
    await menu()
    results.done.push(await timeClick({ css: "button", text: "Mark done" }, `return /\\bDone\\b/.test(${HEADER})`))
  }
  // merge: ⓘ › Merge PR…, then the confirm dialog's Send merge request.
  {
    const id = prs.shift()
    if (id) {
      await openTask(id)
      await menu()
      await page.click('[role="dialog"] button:has-text("Merge PR…")')
      await page.waitForSelector('[role="dialog"] button:has-text("Send merge request")')
      results.merge.push(await timeClick({ css: '[role="dialog"] button', text: "Send merge request" }, `return /merge queued|merging…/.test(${HEADER})`))
    }
  }
}
await browser.close()
proxy?.server.close()

const out = { base, runs, latencyMs: latency, medianMs: {}, samplesMs: {}, stuck }
for (const [k, v] of Object.entries(results)) {
  out.medianMs[k] = median(v.filter((x) => x !== null))
  out.samplesMs[k] = v.map((x) => (x === null ? null : Math.round(x)))
}
console.log(JSON.stringify(out, null, 2))
