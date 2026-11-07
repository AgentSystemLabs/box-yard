#!/usr/bin/env node
// Mock-only before/after proof. Capture `before` from a clean main build, then `after` from this branch.
// PLAYWRIGHT_MODULE=<playwright-core/index.mjs> CHROMIUM_PATH=<chrome> \
//   node scripts/perf/settings-providers.mjs http://localhost:4240 <shots-dir> before|after
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
const [base = "http://localhost:4240", output = ".boxyard/scratch/provider-shots", mode = "after"] = process.argv.slice(2)
assert.equal((await fetch(`${base}/api/health`).then((r) => r.json())).mock, true, "Only a mock server may be used")
assert.ok(["before", "after"].includes(mode))
const initialSetup = await fetch(`${base}/api/setup`).then((r) => r.json())
// sendFile rejects dot-directory worktrees; static /index.html remains available there.
const html = mode === "before" ? await fetch(`${base}/index.html`).then((r) => { assert.ok(r.ok); return r.text() }) : null
// Keep the same demonstration state in both builds; writes are intercepted, never sent to a provider.
Object.assign(initialSetup, {
  ready: true, mock: true, missing: [], restart: [], authorFallbacks: [],
  runner: { choice: "local", default: "local", installDefault: "local" }, upstash: { available: false },
  local: { tools: [{ key: "node", found: true, version: "mock" }, { key: "claude", found: true, version: "mock" }], claudeLogin: true, codexLogin: false, ghLogin: false, checkedAt: Date.now() },
  credentials: Object.fromEntries(Object.keys(initialSetup.credentials).map((k) => [k, { state: "unset", source: null }])),
})
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")
const browser = await pw.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
await mkdir(output, { recursive: true })
const proof = []
try {
  for (const width of mode === "before" ? [400, 800] : [320, 400, 560, 800]) {
    for (const zoom of mode === "before" ? [1] : [1, 1.25]) {
      const context = await browser.newContext({ viewport: { width: Math.floor(width / zoom), height: Math.floor(900 / zoom) }, deviceScaleFactor: zoom, reducedMotion: "reduce" })
      const page = await context.newPage()
      const errors = [], writes = []
      let setup = structuredClone(initialSetup)
      page.on("pageerror", (e) => errors.push(e.message))
      await page.addInitScript(() => {
        window.SpeechRecognition = class { start() {} stop() {} addEventListener() {} removeEventListener() {} }
        Object.defineProperty(window, "speechSynthesis", { value: { speak() {}, cancel() {}, pause() {}, resume() {}, speaking: false, paused: false, getVoices: () => [], addEventListener() {}, removeEventListener() {} } })
      })
      await page.route("**/api/stream", (r) => r.abort())
      if (html) await page.route((url) => url.pathname === "/", (r) => r.fulfill({ contentType: "text/html", body: html }))
      await page.route("**/api/setup", (r) => r.fulfill({ json: setup }))
      await page.route("**/api/setup/runner", (r) => {
        const body = r.request().postDataJSON()
        writes.push({ url: "/api/setup/runner", body })
        setup = { ...setup, runner: { ...setup.runner, choice: body.runner, default: body.runner } }
        return r.fulfill({ json: setup })
      })
      await page.route("**/api/setup/credentials", (r) => {
        const body = r.request().postDataJSON()
        writes.push({ url: "/api/setup/credentials", body })
        setup = { ...setup, credentials: { ...setup.credentials, ...Object.fromEntries(Object.keys(body).map((k) => [k, { state: "set", source: "saved" }])) } }
        return r.fulfill({ json: setup })
      })
      await page.goto(`${base}/?settings=${mode === "before" ? "credentials" : "runners"}`)
      const dialog = page.getByRole("dialog", { name: "Settings", exact: true })
      await dialog.waitFor()
      if (mode === "before") {
        await page.locator('[data-runner-choice=local]').waitFor()
        await page.locator('[role=tab][data-section=runpod]').scrollIntoViewIfNeeded()
        await page.screenshot({ path: path.join(output, `before-${width}.png`) })
        await context.close()
        continue
      }
      const search = page.getByRole("searchbox", { name: "Search settings" })
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Search settings")
      await page.locator('[data-runner-section=daytona]').waitFor()
      assert.equal(await page.locator('[data-runner-section=local]').getByText('Saved default').count(), 1)
      const geometry = async (state) => {
        const measured = await page.evaluate(() => {
          const root = document.querySelector('.settings-layout')
          const visible = (el) => el.checkVisibility() && el.getBoundingClientRect().height > 0
          const overflow = [...root.querySelectorAll('*')].filter(visible).filter((el) => el.getBoundingClientRect().right > root.getBoundingClientRect().right + 1).map((el) => el.outerHTML.slice(0, 140))
          const small = [...document.querySelectorAll('.settings-body input:not([type=checkbox]):not([type=radio]), .settings-body select, .settings-body label:has(input[type=checkbox]), .settings-body label:has(input[type=radio]), .settings-dialog button')].filter(visible).filter((el) => el.getBoundingClientRect().height < 44 || el.getBoundingClientRect().width < 44).map((el) => el.outerHTML.slice(0, 140))
          return { overflow, small }
        })
        assert.deepEqual(measured, { overflow: [], small: [] }, `${width}px @${zoom * 100}% ${state}`)
      }
      await geometry('provider hub')
      await page.screenshot({ path: path.join(output, `after-${width}-${zoom * 100}.png`) })
      if ([400, 800].includes(width) && zoom === 1) {
        await page.locator('[data-runner-section=machines]').scrollIntoViewIfNeeded()
        await page.screenshot({ path: path.join(output, `providers-${width}.png`) })
      }
      await page.locator('[data-runner-section=daytona]').click()
      await page.waitForFunction(() => document.activeElement?.hasAttribute('data-settings-back'))
      await geometry('provider fields')
      await search.fill('API daytona GPU where')
      await page.getByRole('heading', { name: 'Where tasks run › GPU clouds › Daytona' }).waitFor()
      const key = page.locator('[data-credential=daytonaApiKey] input')
      await key.fill('mock-draft-key')
      await page.getByText('1 unsaved change', { exact: true }).waitFor()
      assert.deepEqual(writes, [], 'Editing must not save')
      await geometry('search path')
      if ([400, 800].includes(width) && zoom === 1) {
        await key.scrollIntoViewIfNeeded()
        await page.screenshot({ path: path.join(output, `path-${width}.png`) })
      }
      await page.keyboard.press('Escape')
      assert.equal(await key.inputValue(), 'mock-draft-key')
      await page.locator('[data-settings-back]').click()
      await page.waitForFunction(() => document.activeElement?.getAttribute('data-runner-section') === 'daytona')
      assert.equal(await page.locator('[data-runner-section=daytona] [title="Unsaved changes"]').count(), 1)
      await search.fill('runner where')
      await page.locator('[data-runner-choice=box]').click()
      await page.getByText('2 unsaved changes', { exact: true }).waitFor()
      assert.deepEqual(writes, [], 'Changing the default must remain a draft')
      await geometry('default choices')
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      await page.getByText('Saved', { exact: true }).waitFor()
      assert.ok(writes.some((w) => w.url === '/api/setup/runner' && w.body.runner === 'box'))
      assert.ok(writes.some((w) => w.url === '/api/setup/credentials' && w.body.daytonaApiKey === 'mock-draft-key'))
      assert.equal(writes.length, 2)
      assert.deepEqual(errors, [])
      proof.push(`${width}px @${zoom * 100}%: no overflow; 44px targets; reduced motion; provider drill/back focus; full search path; drafts retained; one Save writes both drafts (mock requests)`)
      console.log(proof.at(-1))
      await context.close()
    }
  }
  if (mode === 'after') {
    const panels = [
      ['Before · 400px · flat categories', 'before-400.png'], ['Before · 800px · flat categories', 'before-800.png'],
      ['After · 400px · grouped providers', 'after-400-100.png'], ['After · 800px · grouped providers', 'after-800-100.png'],
      ['Providers · 400px · GPU clouds + SSH', 'providers-400.png'], ['Providers · 800px · GPU clouds + SSH', 'providers-800.png'],
      ['Search · 400px · editable key draft', 'path-400.png'], ['Search · 800px · full category path', 'path-800.png'],
    ]
    const images = await Promise.all(panels.map(async ([label, file]) => ({ label, bytes: await readFile(path.join(output, file)) })))
    const page = await browser.newPage({ viewport: { width: 2480, height: 2020 }, deviceScaleFactor: 1 })
    await page.setContent(`<html><head><style>body{margin:0;padding:24px;background:#18181b;color:#fafafa;font:20px system-ui}h1{font-size:28px;margin:0 0 6px}p{color:#a1a1aa;margin:0 0 20px}.grid{display:grid;grid-template-columns:400px 800px 400px 800px;gap:10px;align-items:start}h2{font-size:16px;margin:0 0 8px}img{display:block;width:100%;height:900px;object-fit:contain;object-position:top}</style></head><body><h1>Settings · find fields, configure providers, Save drafts</h1><p>Mock mode · before from main b531f74 · 320 / 400 / 560 / 800 px checked at 100% and 125% zoom · reduced motion</p><div class="grid">${images.map((s) => `<section><h2>${s.label}</h2><img src="data:image/png;base64,${s.bytes.toString('base64')}"></section>`).join('')}</div></body></html>`)
    await page.screenshot({ path: path.join(output, 'settings-providers-composite.png'), fullPage: true })
    await writeFile(path.join(output, 'checks.txt'), proof.join('\n') + '\n')
  }
} finally { await browser.close() }
