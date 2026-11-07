#!/usr/bin/env node
// Mock-only responsive/editability proof, with a composite PNG. Uses a separate mock data directory.
// npm run build
// PORT=4240 BOXYARD_MOCK=1 BOXYARD_DATA_DIR=<scratch>/data node dist/server/server/index.js
// PLAYWRIGHT_MODULE=<path/to/playwright-core/index.mjs> CHROMIUM_PATH=<chrome executable> \
//   node scripts/perf/settings-search.mjs http://localhost:4240 <shots-dir>
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
const [base = "http://localhost:4240", output = ".boxyard/scratch/settings-shots"] = process.argv.slice(2)
assert.equal((await fetch(`${base}/api/health`).then((r) => r.json())).mock, true, "Only a mock server may be used")
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")
const browser = await pw.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
await mkdir(output, { recursive: true })
const shots = []
const proof = []
try {
  for (const width of [320, 400, 560, 800]) {
    for (const zoom of [1, 1.25]) {
      // Browser zoom reduces the CSS viewport. Device scale preserves the physical screenshot size.
      const context = await browser.newContext({ viewport: { width: Math.floor(width / zoom), height: Math.floor(900 / zoom) }, deviceScaleFactor: zoom, reducedMotion: "reduce" })
      const page = await context.newPage()
      const errors = []
      page.on("pageerror", (e) => errors.push(e.message))
      await page.addInitScript(() => {
        window.SpeechRecognition = class { start() {} stop() {} addEventListener() {} removeEventListener() {} }
        Object.defineProperty(window, "speechSynthesis", { value: { speak() {}, cancel() {}, pause() {}, resume() {}, speaking: false, paused: false, getVoices: () => [], addEventListener() {}, removeEventListener() {} } })
      })
      await page.route("**/api/stream", (r) => r.abort())
      await page.goto(`${base}/?settings=agents`)
      const search = page.getByRole("searchbox", { name: "Search settings" })
      await search.waitFor()
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Search settings")
      assert.equal(await search.evaluate((el) => el === document.activeElement), true)
      await search.fill("EFFORT box")
      await page.getByRole("region", { name: "Settings search results" }).getByText("Box agents", { exact: true }).waitFor()
      const effort = page.locator('[data-testid="agent-effort"]')
      await effort.selectOption("low")
      await page.getByText("1 unsaved change", { exact: true }).waitFor()
      // Changing a matching control is still a draft; the API remains at the original default.
      assert.notEqual((await page.request.get(`${base}/api/agent-settings`).then((r) => r.json())).settings.agentEffort, "low")
      const checkGeometry = async (state) => {
        const measurements = await page.evaluate(() => {
          const root = document.querySelector('[aria-label="Settings search results"]')
          const visible = (el) => el.checkVisibility() && el.getBoundingClientRect().height > 0
          const overflow = [...root.querySelectorAll('*')].filter(visible).filter((el) => el.getBoundingClientRect().right > root.getBoundingClientRect().right + 1).map((el) => el.outerHTML.slice(0, 150))
          const small = [...document.querySelectorAll('.settings-body input:not([type=checkbox]):not([type=radio]), .settings-body select, .settings-body label:has(input[type=checkbox]), .settings-body label:has(input[type=radio]), .settings-dialog button')].filter(visible).filter((el) => el.getBoundingClientRect().height < 44 || el.getBoundingClientRect().width < 44).map((el) => el.outerHTML.slice(0, 150))
          return { overflow, small }
        })
        assert.deepEqual(measurements, { overflow: [], small: [] }, `${width}px @${zoom * 100}% ${state} geometry`)
      }
      await checkGeometry("effort")
      const name = `${width}-${zoom * 100}.png`
      const bytes = await page.screenshot({ path: path.join(output, name) })
      shots.push({ label: `${width}px · ${zoom * 100}% · reduced motion`, bytes, width })
      await search.fill("unfindable-settings-example")
      await page.getByText("No settings found", { exact: true }).waitFor()
      await page.keyboard.press("Escape")
      assert.equal(await search.inputValue(), "")
      assert.equal(await effort.inputValue(), "low")
      await search.fill("signing")
      await page.locator('[data-settings-label="Signing key"]:visible').first().waitFor()
      await checkGeometry("signing")
      await search.fill("runner where")
      await page.locator('[data-settings-label="Where agents run"]:visible').waitFor()
      await checkGeometry("runner")
      await search.fill("voice")
      await page.locator('[data-settings-label="Voice announcements"]:visible').waitFor()
      await checkGeometry("voice")
      assert.deepEqual(errors, [])
      const result = `${width}px @${zoom * 100}%: no overflow; 44px targets; editable draft survives query/clear; signing/runner/voice found`
      console.log(result)
      proof.push(result)
      await context.close()
    }
  }
  const page = await browser.newPage({ viewport: { width: 2160, height: 1980 }, deviceScaleFactor: 1 })
  await page.setContent(`<html><head><style>body{margin:0;padding:24px;background:#18181b;color:#fafafa;font:20px system-ui}h1{font-size:28px;margin:0 0 6px}p{color:#a1a1aa;margin:0 0 20px}.grid{display:grid;grid-template-columns:320px 400px 560px 800px;gap:10px;align-items:start}.shot{overflow:hidden}h2{font-size:16px;margin:0 0 8px}img{display:block;width:100%;height:900px;object-fit:contain;object-position:top}</style></head><body><h1>Settings search · editable results, drafts until Save</h1><p>Mock mode · 320 / 400 / 560 / 800 px · 100% and 125% zoom · reduced motion</p><div class="grid">${[1, 1.25].flatMap((zoom) => [320, 400, 560, 800].map((width) => shots.find((s) => s.label.startsWith(`${width}px · ${zoom * 100}%`)))).map((s) => `<section class="shot"><h2>${s.label}</h2><img src="data:image/png;base64,${s.bytes.toString('base64')}"></section>`).join("")}</div></body></html>`)
  await page.screenshot({ path: path.join(output, "settings-search-composite.png"), fullPage: true })
  await writeFile(path.join(output, "checks.txt"), proof.join("\n") + "\n")
} finally { await browser.close() }
