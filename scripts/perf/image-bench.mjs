#!/usr/bin/env node
// Image loading bench: what the chat's and the task page's images cost to download, decode and lay out.
//
//   npm run build
//   node scripts/perf/image-bench.mjs seed /tmp/img-yard          (heavy yard + images, before the server starts)
//   PORT=4001 BOXYARD_MOCK=1 BOXYARD_MOCK_HEAVY=1 BOXYARD_DATA_DIR=/tmp/img-yard node dist/server/server/index.js &
//   node scripts/perf/image-bench.mjs http://localhost:4001 [desktop|phone] [runs=3]
//
// `seed` adds, to the heavy mock yard (server/mockHeavy.ts): 12 published 1440×900 screenshots (Coordinator notice
// strips and task-thread chips), 2 phone photos (4032×3024 JPEG) on each of 3 chat and 3 task messages, and 3
// Markdown replies that show a screenshot inline. Images are drawn by Chromium, so nothing binary is checked in.
// `phone` is a 390×844 @3x touch screen on Fast 4G (9 Mbps, 60 ms) with 4× CPU throttling.
//
// Per run, in a fresh browser profile: the Coordinator cold, then the task page by in-app navigation, then a reload.
// Reports image requests and MB on the wire, how many asked the server again (304), decoded bitmap MB of loaded
// images, image decode time on the raster threads (Chrome trace), layout shift, and when the last image arrived.
// Prints the median of each over the runs.
import fs from "node:fs"
import path from "node:path"

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const HOSTED = /\/(?:artifacts|api\/uploads)\//

if (process.argv[2] === "seed") {
  const dir = path.resolve(process.argv[3] ?? "/tmp/img-yard")
  const dist = path.resolve("dist/server/server")
  const { openDb } = await import(path.join(dist, "db.js"))
  const { Store } = await import(path.join(dist, "store.js"))
  const { Artifacts } = await import(path.join(dist, "artifacts.js"))
  const { Uploads } = await import(path.join(dist, "uploads.js"))
  const { seedHeavy, HEAVY_TASK_ID } = await import(path.join(dist, "mockHeavy.js"))

  // Images: busy 1440×900 UI-like screenshots (PNG) and 12 MP photos (JPEG), deterministic.
  const browser = await chromium.launch()
  const draw = async (w, h, kind, seed) => {
    const page = await browser.newPage({ viewport: { width: w, height: h } })
    await page.setContent(`<body style="margin:0"><canvas id=c width=${w} height=${h}></canvas></body>`)
    await page.evaluate(
      ({ w, h, kind, seed }) => {
        const c = document.getElementById("c").getContext("2d")
        let s = seed
        const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32
        if (kind === "png") {
          c.fillStyle = "#09090b"
          c.fillRect(0, 0, w, h)
          for (let i = 0; i < 400; i++) {
            c.fillStyle = `hsl(${Math.floor(r() * 360)},30%,${Math.floor(10 + r() * 40)}%)`
            c.fillRect(r() * w, r() * h, r() * 300, r() * 40)
          }
          c.font = "14px sans-serif"
          c.fillStyle = "#d4d4d8"
          for (let i = 0; i < 300; i++) c.fillText(`Lorem ipsum dolor sit amet ${i} ${r().toString(36)}`, r() * w, r() * h)
        } else {
          // Detail at every scale, like a photo: soft shapes from large to small, then sensor noise.
          for (let i = 0; i < 3000; i++) {
            const size = (w / 3) * Math.pow(r(), 3) + 4
            c.fillStyle = `hsla(${Math.floor(r() * 360)},${Math.floor(20 + r() * 50)}%,${Math.floor(20 + r() * 60)}%,0.5)`
            c.beginPath()
            c.ellipse(r() * w, r() * h, size, size * (0.3 + r()), r() * Math.PI, 0, 2 * Math.PI)
            c.fill()
          }
          const img = c.getImageData(0, 0, w, h)
          for (let i = 0; i < img.data.length; i += 4) {
            const n = (r() - 0.5) * 16
            img.data[i] += n
            img.data[i + 1] += n
            img.data[i + 2] += n
          }
          c.putImageData(img, 0, 0)
        }
      },
      { w, h, kind, seed },
    )
    const data = await page.screenshot({ type: kind === "png" ? "png" : "jpeg", ...(kind === "png" ? {} : { quality: 88 }) })
    await page.close()
    return data
  }
  const screens = []
  for (let i = 0; i < 6; i++) screens.push(await draw(1440, 900, "png", i + 1))
  const photos = []
  for (let i = 0; i < 3; i++) photos.push(await draw(4032, 3024, "jpg", i + 100))
  await browser.close()

  const db = openDb(dir)
  const store = new Store(db)
  if (!seedHeavy(db, store)) throw new Error(`${dir} already has a yard: seed an empty folder`)
  const arts = new Artifacts(store, path.join(dir, "artifacts"))
  const ups = new Uploads(path.join(dir, "uploads"), 50 * 1024 * 1024)
  const chat = db.prepare("SELECT created_at FROM chat_messages ORDER BY created_at DESC LIMIT 200").all()
  const thread = db.prepare("SELECT created_at FROM task_messages WHERE task_id = ? ORDER BY created_at DESC LIMIT 200").all(HEAVY_TASK_ID)
  const insertChat = db.prepare("INSERT INTO chat_messages (id, role, content, meta_json, seen_by_orchestrator, created_at) VALUES (?, ?, ?, ?, 1, ?)")
  const insertTaskMsg = db.prepare("INSERT INTO task_messages (id, task_id, role, content, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
  const title = "Heavy thread: 2000 events"
  let n = 0
  for (let g = 0; g < 4; g++) {
    for (let k = 0; k < 3; k++) {
      const a = arts.save({ title: `Screenshot ${g}.${k}: Coordinator panel (desktop 1440)`, filename: `shot-${g}-${k}.png`, data: screens[(g * 3 + k) % screens.length], projectId: "prj_heavy-yard", taskId: HEAVY_TASK_ID })
      insertChat.run(`chat_img${n}`, "notice", `📎 **${title}** published ${a.title}: ${a.url}`, JSON.stringify({ taskId: HEAVY_TASK_ID, artifactId: a.id }), chat[10 + g * 40].created_at + 1 + k)
      insertTaskMsg.run(`tm_img${n}`, HEAVY_TASK_ID, "event", `Published artifact: ${a.title}`, JSON.stringify({ kind: "artifact", url: a.url, artifactId: a.id }), thread[5 + g * 40].created_at + 1 + k)
      n++
    }
  }
  for (let g = 0; g < 3; g++) {
    const files = [0, 1].map((k) => {
      const { path: _path, ...f } = ups.save(`IMG_10${g}${k}.jpg`, photos[(g + k) % photos.length])
      return f
    })
    insertChat.run(`chat_photo${g}`, "user", `Here's what I see on my phone (${g})`, JSON.stringify({ attachments: files }), chat[3 + g * 50].created_at + 1)
    insertTaskMsg.run(`tm_photo${g}`, HEAVY_TASK_ID, "user", `Phone shot ${g}`, JSON.stringify({ attachments: files }), thread[2 + g * 50].created_at + 1)
  }
  for (let g = 0; g < 3; g++) {
    const a = arts.save({ title: `Inline ${g}`, filename: `inline-${g}.png`, data: screens[g], projectId: "prj_heavy-yard", taskId: HEAVY_TASK_ID })
    insertChat.run(`chat_md${g}`, "assistant", `Here's the before/after:\n\n![Inline ${g}](${a.url})\n\nLooks right to me.`, null, chat[20 + g * 30].created_at + 2)
    insertTaskMsg.run(`tm_md${g}`, HEAVY_TASK_ID, "assistant", `Screenshot:\n\n![Inline ${g}](${a.url})\n\nDone.`, null, thread[15 + g * 30].created_at + 2)
  }
  db.close()
  console.log(`Seeded ${dir}: ${n} published screenshots, 6 photo attachments ×2, 3 inline images.`)
  process.exit(0)
}

const base = process.argv[2] ?? "http://localhost:4001"
const phone = process.argv[3] === "phone"
const runs = Number(process.argv[4] ?? 3)
/** After a step: at least this long, then until no hosted image has been loading for a second (at most 60 s). */
const settle = phone ? 4000 : 2000
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

async function run() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined })
  const context = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } })
  await context.addInitScript(() => {
    localStorage.setItem("box-yard:setup-skipped", "true")
    window.__shifts = []
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) window.__shifts.push(e.value)
    }).observe({ type: "layout-shift", buffered: true })
  })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send("Network.enable")
  if (phone) {
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 60, downloadThroughput: 9_000_000 / 8, uploadThroughput: 1_500_000 / 8 })
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  }
  const requests = new Map()
  const inflight = new Set()
  let lastActivity = 0
  cdp.on("Network.requestWillBeSent", (e) => {
    if (!HOSTED.test(e.request.url)) return
    inflight.add(e.requestId)
    lastActivity = Date.now()
  })
  const ended = (e) => {
    if (inflight.delete(e.requestId)) lastActivity = Date.now()
  }
  cdp.on("Network.loadingFinished", ended)
  cdp.on("Network.loadingFailed", ended)
  cdp.on("Network.responseReceived", (e) => {
    if (HOSTED.test(e.response.url)) requests.set(e.requestId, { status: e.response.status, cached: e.response.fromDiskCache || e.response.fromMemoryCache, bytes: 0 })
  })
  cdp.on("Network.requestServedFromCache", (e) => requests.get(e.requestId) && (requests.get(e.requestId).cached = true))
  cdp.on("Network.loadingFinished", (e) => requests.get(e.requestId) && (requests.get(e.requestId).bytes = e.encodedDataLength))
  let trace = []
  cdp.on("Tracing.dataCollected", (e) => trace.push(...e.value))

  /** `load`: the step loads a new document, so its clock starts at 0. */
  async function step(label, act, load = false) {
    trace = []
    requests.clear()
    await page.evaluate(() => (window.__shifts = [])).catch(() => {})
    await cdp.send("Tracing.start", { traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] }, transferMode: "ReportEvents" })
    const t0 = load ? 0 : await page.evaluate(() => performance.now())
    await act()
    await sleep(settle)
    for (const end = Date.now() + 60_000; Date.now() < end && (inflight.size || Date.now() - lastActivity < 1000); ) await sleep(100)
    const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r))
    await cdp.send("Tracing.end")
    await done
    // ImageDecodeTask wraps Chrome's nested "Decode LazyPixelRef" and "Decode Image" events: count it alone.
    const decodeMs = trace.filter((e) => e.ph === "X" && e.name === "ImageDecodeTask").reduce((n, e) => n + e.dur / 1000, 0)
    const dom = await page.evaluate(
      ({ t0, hosted }) => {
        const re = new RegExp(hosted)
        const loaded = [...document.images].filter((i) => re.test(i.currentSrc || i.src) && i.complete && i.naturalWidth)
        const last = performance.getEntriesByType("resource").filter((r) => re.test(r.name) && r.responseEnd >= t0)
        return {
          decodedMB: loaded.reduce((n, i) => n + i.naturalWidth * i.naturalHeight * 4, 0) / 1048576,
          cls: window.__shifts.reduce((n, v) => n + v, 0),
          lastImageMs: last.length ? Math.max(...last.map((r) => r.responseEnd)) - t0 : 0,
        }
      },
      { t0, hosted: HOSTED.source },
    )
    const list = [...requests.values()]
    return {
      label,
      requests: list.filter((r) => !r.cached).length,
      revalidated304: list.filter((r) => r.status === 304).length,
      wireMB: list.reduce((n, r) => n + r.bytes, 0) / 1048576,
      decodedMB: dom.decodedMB,
      decodeMs,
      cls: dom.cls,
      lastImageMs: dom.lastImageMs,
    }
  }

  const go = (to) => page.evaluate((to) => {
    history.pushState(null, "", to)
    dispatchEvent(new PopStateEvent("popstate"))
  }, to)
  const out = []
  out.push(await step("Coordinator, cold", async () => {
    await page.goto(base + "/", { waitUntil: "load" })
    await page.waitForSelector("textarea")
  }, true))
  out.push(await step("Task page (in-app nav)", () => go("/tasks/task_heavy-thread")))
  out.push(await step("Task page reload", async () => {
    await page.reload({ waitUntil: "load" })
    await page.waitForSelector("textarea")
  }, true))
  await browser.close()
  return out
}

const all = []
for (let i = 0; i < runs; i++) all.push(await run())
const rows = all[0].map((r, i) => {
  const pick = (k) => median(all.map((run) => run[i][k]))
  return {
    step: r.label,
    requests: pick("requests"),
    "304s": pick("revalidated304"),
    "wire MB": +pick("wireMB").toFixed(2),
    "decoded MB": +pick("decodedMB").toFixed(1),
    "decode ms": Math.round(pick("decodeMs")),
    CLS: +pick("cls").toFixed(3),
    "last image ms": Math.round(pick("lastImageMs")),
  }
})
console.log(`${base} · ${phone ? "phone (390×844 @3x, Fast 4G, 4× CPU)" : "desktop (1440×900)"} · median of ${runs}`)
console.table(rows)
if (process.env.IMAGE_BENCH_JSON) fs.writeFileSync(process.env.IMAGE_BENCH_JSON, JSON.stringify({ base, phone, runs: all, median: rows }, null, 2))
