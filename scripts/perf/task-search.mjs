#!/usr/bin/env node
// Read-only browser check for the touch task finder. Use an isolated seeded mock yard, with an active task and
// a completed task. The completed task should be outside the current cards. No prompts or task actions are sent.
//
//   PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROMIUM_PATH=/path/to/chrome \
//     node scripts/perf/task-search.mjs http://localhost:4260 <active task id> <done task id> [shots dir]
//
// Checks 320/400/560/800 physical px, plus 125% effective zoom (smaller CSS viewport + deviceScaleFactor).
// This emulates browser zoom, not a physical iOS keyboard. Reduced motion is on. Captures each header and finder.
import fs from "node:fs/promises"

const [base, activeId, doneId, shots] = process.argv.slice(2)
if (!base || !activeId || !doneId) throw new Error("Pass a mock yard URL, active task id, done task id and optional screenshot directory")
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")
const browser = await chromium.launch({ args: ["--autoplay-policy=document-user-activation-required", "--mute-audio"], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) })
const get = async (path) => {
  const res = await fetch(new URL(path, base))
  if (!res.ok) throw new Error(`${path}: ${res.status}`)
  return res.json()
}
const active = await get(`/api/tasks/${activeId}`)
const done = await get(`/api/tasks/${doneId}`)
const settings = await get("/api/agent-settings")
if (done.status !== "done") throw new Error("The second task must be completed")
if (shots) await fs.mkdir(shots, { recursive: true })
const results = []
const check = (ok, description) => { if (!ok) throw new Error(description) }
try {
  for (const physical of [320, 400, 560, 800]) for (const zoom of [1, 1.25]) for (const firstVisit of [false, true]) {
    const label = `${physical}px at ${zoom * 100}%${firstVisit ? " (voice locked, auto-compaction disabled)" : ""}`
    const ctx = await browser.newContext({
      viewport: { width: Math.round(physical / zoom), height: Math.round(900 / zoom) },
      deviceScaleFactor: zoom, isMobile: true, hasTouch: true, reducedMotion: "reduce",
    })
    try {
      await ctx.addInitScript((enabled) => {
        localStorage.setItem("box-yard:setup-skipped", "true")
        localStorage.setItem("boxyard:voice", JSON.stringify({ enabled }))
        // Exercise the locked-voice layout without speaking through the host's speakers.
        speechSynthesis.speak = (utterance) => queueMicrotask(() => utterance.dispatchEvent(new Event("end")))
        speechSynthesis.cancel = () => {}
      }, firstVisit)
      const page = await ctx.newPage()
      page.setDefaultTimeout(10_000)
      const errors = []
      page.on("pageerror", (e) => errors.push(e.message))
      await page.route("**/api/stream", (r) => r.abort())
      if (firstVisit) await page.route("**/api/agent-settings", (r) => r.fulfill({ json: { ...settings, settings: { ...settings.settings, orchestratorAutoCompact: { ...settings.settings.orchestratorAutoCompact, enabled: false } } } }))
      await page.goto(new URL("/", base).href)
      const search = page.getByRole("button", { name: "Search tasks", exact: true })
      await search.waitFor()
      if (firstVisit) await page.locator("[data-voice-unlock]").waitFor()
      check(await page.locator("[data-testid=context-menu-button], [data-testid=context-meter]").count() === 0, `${label}: manual context controls stay out of chat`)
      const rect = await search.boundingBox()
      check(rect.width >= 44 && rect.height >= 44, `${label}: search needs a 44px target`)
      check(await search.evaluate((b) => {
        const r = b.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        return r.left >= 0 && r.right <= innerWidth && (b === hit || b.contains(hit))
      }), `${label}: search must be visible and tappable`)
      const clipped = await page.locator("header button").evaluateAll((buttons) => buttons.filter((b) => {
        const r = b.getBoundingClientRect()
        return r.width && r.height && (r.left < 0 || r.right > innerWidth || r.width < 44 || r.height < 44)
      }).map((b) => b.getAttribute("aria-label") ?? b.title))
      check(!clipped.length, `${label}: header controls clipped or too small: ${clipped.join(", ")}`)
      const suffix = `${physical}-${zoom}${firstVisit ? "-locked" : ""}`
      if (shots) await page.screenshot({ path: `${shots}/home-${suffix}.png` })
      await search.tap()
      const input = page.getByRole("combobox", { name: "Search Box Yard" })
      check(await input.evaluate((el) => el === document.activeElement), `${label}: search field must get focus`)
      if (shots) await page.screenshot({ path: `${shots}/finder-${suffix}.png` })
      const close = page.getByRole("button", { name: "Close", exact: true })
      if (await close.isVisible()) await close.tap()
      else await page.touchscreen.tap(2, 2) // Wide palette: its existing backdrop closes it by touch.
      await page.getByRole("dialog").waitFor({ state: "detached" })
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Search tasks")
      check(await search.evaluate((el) => el === document.activeElement), `${label}: close returns focus to search`)
      for (const task of [active, done]) {
        await search.tap()
        await input.fill(task.title)
        const result = page.locator(`[role=option][data-key="task:${task.id}"]`)
        check((await result.innerText()).includes(task.status === "done" ? "Done" : task.title), `${label}: task and status must be searchable`)
        await result.tap()
        await page.locator(`[data-testid=chat-card][data-card="${task.id}"]`).waitFor()
        check(await page.getByRole("dialog").count() === 0, `${label}: choosing a task closes search`)
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
      check(!overflow, `${label}: page must not overflow horizontally`)
      check(!errors.length, `${label}: ${errors.join("; ")}`)
      results.push({ physical, zoom, firstVisit, cssWidth: Math.round(physical / zoom), searchTarget: [rect.width, rect.height], errors, overflow })
      console.log(`ok ${label}: tap search, focus/close, active + done card reveal, no overflow or JS errors`)
    } finally { await ctx.close() }
  }
} finally { await browser.close() }
if (shots) await fs.writeFile(`${shots}/checks.json`, JSON.stringify(results, null, 2))
