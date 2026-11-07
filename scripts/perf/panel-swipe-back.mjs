// Mock-only touch audit: CDP delivers real browser touch input; all API writes and SSE are blocked.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_PATH=/path/to/chrome \
//   node scripts/perf/panel-swipe-back.mjs http://localhost:4000 /tmp/panel-swipe-back
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const [base = 'http://localhost:4000', out = '/tmp/panel-swipe-back'] = process.argv.slice(2)
assert.equal((await (await fetch(`${base}/api/health`)).json()).mock, true, 'Use an isolated mock server')
const settings = await (await fetch(`${base}/api/agent-settings`)).json()
const now = Date.now()
const project = { id: 'prj_swipe01', name: 'box-yard', repo: 'acme/box-yard', description: 'Phone navigation', baseBranch: 'main', runner: 'box', identityId: 'default', envKeys: [], notes: [], docker: { image: null, dockerfile: null }, gpuMachine: { gpuTypes: [], cloud: null, minRamGb: null, minVcpus: null }, updatedAt: now }
const task = { id: 'task_swipe01', title: 'Return to your chat with a swipe', projectId: project.id, prompt: 'Keep the source conversation in place.', status: 'working', agentCli: 'codex', sessionId: 'demo', boxId: null, branch: null, prUrl: null, prState: null, prMergedAt: null, previews: [], question: null, summary: null, error: null, waitReason: null, turnCount: 3, pendingCount: 0, lastArchivedAt: null, scheduleId: null, outcome: null, contextTokens: null, contextWindow: null, compactPending: false, compacting: false, model: null, effort: null, claudeCostUsd: 0, claudeTokens: 0, routingRule: null, routingReason: null, createdAt: now - 3600000, updatedAt: now }
const links = '[Navigation task](/tasks/task_swipe01) · [Project Captain](/projects/prj_swipe01)'
const messages = Array.from({ length: 32 }, (_, i) => [
  { id: `msg_user${i}`, role: 'user', content: `Check ${i + 1}: can I return to my place in this chat?`, meta: null, createdAt: now - (64 - i * 2) * 60000 },
  { id: `msg_reply${i}`, role: 'assistant', content: `Your source conversation stays mounted while you review related work.\n\n${links}\n\nA short swipe returns the panel to its place. A longer swipe takes you back to your conversation.\n\n\`\`\`js\nconst horizontalCode = "This deliberately long code line should keep its own horizontal scrolling instead of dismissing the conversation panel."\n\`\`\``, meta: null, createdAt: now - (63 - i * 2) * 60000 },
]).flat()
const captain = { busy: false, usage: { tokens: 12000, window: 1000000, updatedAt: now }, compacting: false, compactQueued: false, error: null }
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--mute-audio'] })
const checks = []
try {
  for (const [width, zoom, kind, reduced, picked] of [
    ...[320, 400, 560, 800, 1440].flatMap((w) => [1, 1.25].flatMap((z) => ['session', 'captain'].map((k) => [w, z, k, false, false]))),
    [400, 1, 'session', true, false], [400, 1, 'captain', true, true],
  ].filter(([w, z, k, r]) => !process.env.AUDIT_ONLY || process.env.AUDIT_ONLY === `${w}:${z}:${k}:${r}`)) {
    const ctx = await browser.newContext({ viewport: { width: Math.round(width / zoom), height: Math.round(900 / zoom) }, deviceScaleFactor: zoom, isMobile: width < 1000, hasTouch: width < 1000, reducedMotion: reduced ? 'reduce' : 'no-preference' })
    await ctx.addInitScript(() => {
      localStorage.setItem('box-yard:setup-skipped', 'true')
      localStorage.setItem('boxyard:voice', JSON.stringify({ enabled: false }))
      Object.defineProperty(window, 'speechSynthesis', { value: { getVoices: () => [], cancel() {}, addEventListener() {}, removeEventListener() {} } })
    })
    const errors = [], writes = [], documents = []
    await ctx.route('**/api/**', (r) => {
      const req = r.request(), path = new URL(req.url()).pathname
      if (req.method() !== 'GET') { writes.push(path); return r.abort() }
      if (path === '/api/stream') return r.abort()
      let json
      if (path === '/api/agent-settings') json = settings
      else if (path === '/api/projects') json = [project]
      else if (path === '/api/tasks') json = [task]
      else if (/^\/api\/tasks\/[^/]+$/.test(path)) json = task
      else if (path.endsWith('/messages') || path === '/api/chat') json = messages
      else if (path.endsWith('/captain')) json = captain
      else if (['/api/health', '/api/me', '/api/settings', '/api/orchestrator', '/api/setup', '/api/models', '/api/tts', '/api/cloud'].includes(path)) return r.continue()
      else json = []
      return r.fulfill({ json })
    })
    const page = await ctx.newPage()
    page.setDefaultTimeout(10000)
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('request', (r) => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) documents.push(r.url()) })
    await page.goto(`${base}/${picked ? `?project=${project.id}` : ''}`)
    const source = page.locator('[data-testid="chat-panel"], [data-testid="captain-chat"][data-centre]')
    const anchor = source.getByRole('link', { name: kind === 'session' ? 'Navigation task' : 'Project Captain', exact: true }).nth(6)
    await anchor.waitFor()
    await source.locator('textarea').fill('Keep my source draft')
    await anchor.evaluate((el) => el.scrollIntoView({ block: 'end' }))
    const box = await anchor.boundingBox()
    await page.mouse.move(box.x + 5, box.y + 5)
    await page.mouse.wheel(0, -100)
    await page.waitForTimeout(150)
    await anchor.evaluate((el) => el.scrollIntoView({ block: 'end' }))
    await page.waitForTimeout(150)
    const scroller = anchor.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " overflow-y-auto ")][1]')
    const before = await scroller.evaluate((el) => { window.auditScroller = el; return el.scrollTop })
    const sourceUrl = page.url() // A ?project= intent is consumed when the Captain becomes the centre chat.
    assert(before > 0, 'Exercise a source thread scrolled away from its origin')
    await source.locator('textarea').evaluate((el) => { window.auditDraft = el })
    const open = async () => {
      await anchor.evaluate((el) => el.focus({ preventScroll: true }))
      await anchor.click()
      await page.getByRole('dialog').waitFor()
      await page.waitForTimeout(350)
    }
    await open()
    const panel = page.getByTestId('side-thread')
    const dialog = page.getByRole('dialog')
    const frame = await panel.boundingBox()
    const full = Math.abs(frame.width - page.viewportSize().width) < 2 && Math.abs(frame.x) < 2 && width < 1000
    const headerPoint = async () => {
      const header = await dialog.locator('header').first().boundingBox()
      return { x: Math.min(100, header.width / 3), y: header.y + 18 }
    }
    const cdp = await ctx.newCDPSession(page)
    const send = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y, id: 1 }] })
    const translate = () => panel.evaluate((el) => parseFloat(el.style.translate) || 0)
    const drag = async ({ x, y, distance, duration = 360, shot }) => {
      await send('touchStart', x, y)
      // Small first move establishes horizontal intent before the browser starts scrolling.
      await send('touchMove', x + Math.min(16, distance), y + 1)
      for (let i = 1; i <= 5; i++) {
        await page.waitForTimeout(duration / 5)
        await send('touchMove', x + distance * i / 5, y + 1)
      }
      const following = await translate()
      if (shot) await page.screenshot({ path: `${out}/${shot}.png` })
      await send('touchEnd', 0, 0)
      return following
    }
    const tag = `${kind}-${width}-${zoom}${reduced ? '-reduced' : ''}`
    if (full) {
      if (width === 400 && zoom === 1 && !reduced) await page.screenshot({ path: `${out}/${kind}-start.png` })
      const h = await headerPoint()
      const short = await drag({ ...h, distance: 65, duration: 450, shot: width === 400 && zoom === 1 && !reduced ? `${kind}-short` : undefined })
      assert(Math.abs(short - 65) < 2, 'Panel follows the finger without moving the source')
      await page.waitForTimeout(220)
      assert.equal(await translate(), 0, 'Short slow swipe snaps back')
      assert.equal(await dialog.count(), 1)
      // Vertical movement wins, even when it begins on the eligible edge.
      await send('touchStart', 16, 350)
      await send('touchMove', 18, 320)
      await send('touchMove', 20, 250)
      await send('touchEnd', 0, 0)
      assert.equal(await translate(), 0, 'Vertical scrolling is not intercepted')
      // Composer and horizontal code are never dismissal surfaces, including at the edge.
      const composer = await dialog.locator('textarea').boundingBox()
      await drag({ x: composer.x + 12, y: composer.y + 10, distance: 150 })
      assert.equal(await translate(), 0, 'Composer gesture stays in the composer')
      await page.evaluate(() => window.getSelection()?.removeAllRanges())
      const code = dialog.locator('pre').last()
      await code.scrollIntoViewIfNeeded()
      const codeBox = await code.boundingBox()
      await drag({ x: Math.max(12, codeBox.x + 2), y: codeBox.y + 10, distance: 150 })
      assert.equal(await translate(), 0, 'Code keeps horizontal scrolling')
      await page.evaluate(() => window.getSelection()?.removeAllRanges())
      const following = await drag({ ...await headerPoint(), distance: Math.round(frame.width * 0.4), shot: width === 400 && zoom === 1 && !reduced ? `${kind}-closing` : undefined })
      assert(Math.abs(following - Math.round(frame.width * 0.4)) < 2, 'Long drag follows the finger')
      await dialog.waitFor({ state: 'hidden' })
      await page.waitForTimeout(350)
      assert.equal(await scroller.evaluate((el) => el === window.auditScroller), true)
      assert.equal(await source.locator('textarea').evaluate((el) => el === window.auditDraft), true)
      assert.equal(await source.locator('textarea').inputValue(), 'Keep my source draft')
      assert(Math.abs(await scroller.evaluate((el) => el.scrollTop) - before) <= 1, 'Swipe restores exact source scroll')
      assert.equal(await anchor.evaluate((el) => el === document.activeElement), true, 'Swipe restores opener focus')
      assert.equal(page.url(), sourceUrl)
      if (width === 400 && zoom === 1 && !reduced) await page.screenshot({ path: `${out}/${kind}-restored.png` })
      if (width === 400 && zoom === 1) {
        await open()
        const h = await headerPoint()
        await send('touchStart', h.x, h.y)
        await send('touchMove', h.x + 80, h.y + 1)
        assert.equal(await translate(), 80)
        await send('touchCancel', 0, 0)
        await page.waitForTimeout(220)
        assert.equal(await translate(), 0, 'Canceled touches reset the panel without closing')
        assert.equal(await dialog.count(), 1)
        const flick = await headerPoint()
        await send('touchStart', flick.x, flick.y)
        await send('touchMove', flick.x + 12, flick.y + 1)
        await send('touchMove', flick.x + 80, flick.y + 1)
        await send('touchEnd', 0, 0)
        await dialog.waitFor({ state: 'hidden' })
        assert.equal(await anchor.evaluate((el) => el === document.activeElement), true, 'Fast flick restores focus too')
        if (!reduced) {
          await open()
          // A native history change wins over a close animation already in flight.
          await drag({ ...await headerPoint(), distance: 160 })
          await page.goBack()
          await dialog.waitFor({ state: 'hidden' })
          await page.waitForTimeout(250)
          assert.equal(new URL(page.url()).pathname, '/', 'No second Back into an earlier page')
          assert.equal(page.url(), sourceUrl)
        }
      }
      // A fresh direct URL has no in-app return entry: swipe safely replaces it with /.
      await page.goto(`${base}/?${kind}=${kind === 'session' ? task.id : project.id}`)
      await dialog.waitFor()
      await page.waitForTimeout(350)
      await drag({ ...await headerPoint(), distance: Math.round(frame.width * 0.4) })
      await dialog.waitFor({ state: 'hidden' })
      assert.equal(page.url(), `${base}/`)
      assert.equal(await page.locator('[data-testid="chat-footer"] textarea').evaluate((el) => el === document.activeElement), true)
    } else {
      await drag({ ...await headerPoint(), distance: 150 })
      assert.equal(await translate(), 0, 'Docked panels and fine pointers do not swipe Back')
      assert.equal(await dialog.count(), 1)
      if (zoom === 1) await page.screenshot({ path: `${out}/${tag}-docked.png` })
    }
    assert.deepEqual(errors, [], 'No browser errors')
    assert.deepEqual(writes, [], 'No API writes')
    assert.equal(documents.length, full ? 2 : 1, 'Only the deliberate direct-link check navigates the document')
    const check = { width, zoom, kind, reduced, picked, full, sourceScroll: before, documents: documents.length, errors, writes }
    checks.push(check)
    console.log(JSON.stringify(check))
    await ctx.close()
  }
} finally {
  await browser.close()
  await fs.writeFile(`${out}/checks.json`, JSON.stringify(checks, null, 2))
}
