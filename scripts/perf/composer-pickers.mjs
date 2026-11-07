// Actual production UI, isolated mock server only. Every picker API response is delayed 1200 ms;
// this models a slow availability check, without contacting SSH, Docker or live credentials.
// PLAYWRIGHT_MODULE=/tmp/picker-browser/node_modules/playwright/index.mjs \
//   node scripts/perf/composer-pickers.mjs http://localhost:4010 before /tmp/picker-evidence/before
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const [base, phase = 'after', out = `/tmp/picker-evidence/${phase}`] = process.argv.slice(2)
assert(base, 'Pass an isolated mock server URL')
assert.equal((await (await fetch(`${base}/api/health`)).json()).mock, true)
const delayMs = 1200
const places = [
  ['local', 'local', 'runner', 'This computer', "Box Yard's own computer"],
  ['box', 'box', 'runner', 'Upstash box', 'A cloud sandbox'],
  ['docker', 'docker', 'runner', 'Docker container', 'On this computer'],
  ['emma', 'label:emma', 'machine', 'emma', 'SSH · ready'],
  ['addie-bug', 'label:addie-bug', 'machine', 'addie-bug', 'SSH · offline (tasks wait)'],
  ['ssh', 'ssh', 'runner', 'Any SSH machine', 'The first free one'],
  ['label:laptops', 'label:laptops', 'label', 'Machines labelled laptops', 'emma, addie-bug'],
].map(([token, value, kind, label, detail]) => ({ token, value, kind, label, detail, disabled: null }))
const harnesses = ['claude', 'codex'].map(token => ({ token, value: token, kind: 'harness', label: token === 'codex' ? 'Codex' : 'Claude Code', detail: 'Installed and signed in', disabled: null }))
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ args: ['--mute-audio'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) })
const results = []
try {
  for (const [device, width, height, touch] of [['desktop', 1440, 1000, false], ['phone', 400, 860, true]]) {
    for (const kind of ['runsOn', 'agent']) {
      for (const cache of ['cold', 'mount-idle', 'reopen', 'stale']) {
        const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: 'reduce' })
        await ctx.addInitScript(() => {
          localStorage.setItem('box-yard:setup-skipped', 'true')
          localStorage.setItem('boxyard:voice', JSON.stringify({ enabled: false }))
          window.SpeechRecognition = class extends EventTarget { start() {} stop() {} abort() {} }
          const now = Date.now
          window.__pickerAge = 0
          Date.now = () => now() + window.__pickerAge
        })
        const page = await ctx.newPage(), requests = [], errors = []
        page.on('pageerror', e => errors.push(e.message))
        // Block writes and SSE, so the fixture never changes data or starts an agent.
        await page.route('**/api/**', r => r.request().method() !== 'GET' || r.request().url().endsWith('/stream') ? r.abort() : r.continue())
        let refresh = false
        for (const path of ['run-targets', 'harness-targets']) await page.route(`**/api/${path}*`, async r => {
          const fresh = refresh
          requests.push({ path, fresh })
          await new Promise(resolve => setTimeout(resolve, delayMs))
          const list = path === 'run-targets' ? places : harnesses
          await r.fulfill({ json: fresh ? list.map(t => t.token === (kind === 'runsOn' ? 'local' : 'claude') ? { ...t, disabled: 'Refresh found this unavailable' } : t) : list }).catch(() => {})
        })
        await page.goto(`${base}/`)
        const button = page.getByTestId(`pick-${kind}`).first()
        // A button types its @ or ! and opens the typed list (RunTargetList).
        const panel = page.locator(`[data-testid="run-target-menu"][data-kind="${kind}"]`)
        await button.waitFor()
        const open = async () => touch ? button.tap() : button.click()
        const close = async () => page.keyboard.press('Escape')
        if (cache === 'mount-idle') await page.waitForTimeout(delayMs + 300)
        if (cache === 'reopen' || cache === 'stale') {
          await open()
          await panel.locator('[data-token="box"], [data-token="codex"]').waitFor()
          await close()
        }
        if (cache === 'stale') {
          refresh = true
          await page.evaluate(() => { window.__pickerAge = 31_000 })
        }
        const beforeOpenRequests = requests.length
        // Use browser event timestamps and animation frames, excluding Playwright's actionability wait.
        await button.evaluate((el, kind) => {
          window.__pickerTiming = null
          el.addEventListener('pointerdown', () => {
            const start = performance.now(), timing = { menuMs: null, firstOptionsMs: null }
            window.__pickerTiming = timing
            const frame = () => {
              const menu = document.querySelector(`[data-testid="run-target-menu"][data-kind="${kind}"]`)
              if (menu?.getBoundingClientRect().height && timing.menuMs === null) timing.menuMs = performance.now() - start
              if (menu?.querySelector('[role="option"][data-token]')) timing.firstOptionsMs = performance.now() - start
              else requestAnimationFrame(frame)
            }
            requestAnimationFrame(frame)
          }, { once: true })
        }, kind)
        await open()
        await panel.waitFor()
        if (cache === 'mount-idle') {
          // Same point in the imposed delay: loading before, cached options after.
          await page.waitForTimeout(200)
          await page.screenshot({ path: `${out}/${device}-${kind}-pending.png` })
        }
        await page.waitForFunction(() => window.__pickerTiming?.firstOptionsMs !== null)
        const timing = await page.evaluate(() => window.__pickerTiming)
        if (cache === 'stale' && phase === 'after') {
          await panel.locator('[title*="Refresh found this unavailable"]').waitFor()
          // Background results must update the list without taking the caret out of the text.
          assert(await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'))
        }
        if (cache === 'stale') await page.waitForTimeout(delayMs + 100)
        assert.deepEqual(errors, [])
        if (phase === 'after') {
          assert(timing.menuMs < 500, `${device}/${kind}/${cache}: menu blocked`)
          if (cache !== 'cold') assert(timing.firstOptionsMs < 500, `${device}/${kind}/${cache}: cached options blocked`)
        }
        const row = { phase, device, kind, cache, delayMs, beforeOpenRequests, totalRequests: requests.length, ...timing }
        results.push(row)
        console.log(JSON.stringify(row))
        await ctx.close()
      }
    }
  }
} finally {
  await browser.close()
  await fs.writeFile(`${out}/timings.json`, JSON.stringify(results, null, 2))
}
