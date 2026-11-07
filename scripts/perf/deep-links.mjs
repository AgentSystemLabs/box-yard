// Mock-only navigation/scroll audit. All API writes and SSE are blocked; fixtures never change server data.
// PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROMIUM_PATH=/path/to/chrome \
//   node scripts/perf/deep-links.mjs http://localhost:4000 /tmp/deep-links
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const [base = 'http://localhost:4000', out = '/tmp/deep-links'] = process.argv.slice(2)
assert.equal((await (await fetch(`${base}/api/health`)).json()).mock, true, 'Use an isolated mock server')
const settings = await (await fetch(`${base}/api/agent-settings`)).json()
const now = Date.now()
const project = { id: 'prj_links01', name: 'box-yard', repo: 'acme/box-yard', description: 'Chat navigation', baseBranch: 'main', runner: 'box', identityId: 'default', envKeys: [], notes: [], docker: { image: null, dockerfile: null }, gpuMachine: { gpuTypes: [], cloud: null, minRamGb: null, minVcpus: null }, updatedAt: now }
const makeTask = (id, title) => ({ id, title, projectId: project.id, prompt: 'Keep every conversation in place.', status: 'working', agentCli: 'codex', sessionId: 'demo', boxId: null, branch: null, prUrl: null, prState: null, prMergedAt: null, previews: [], question: null, summary: null, error: null, waitReason: null, turnCount: 3, pendingCount: 0, lastArchivedAt: null, scheduleId: null, outcome: null, contextTokens: null, contextWindow: null, compactPending: false, compacting: false, model: null, effort: null, claudeCostUsd: 0, claudeTokens: 0, routingRule: null, routingReason: null, createdAt: now - 3600000, updatedAt: now })
const tasks = [makeTask('task_links01', 'Keep chat context while opening links'), makeTask('task_links02', 'Review the navigation checks')]
const links = '[Open navigation task](/tasks/task_links02) · [Project Captain](/projects/prj_links01) · [Daily checks](/schedules#sch_links01) · [Navigation report](/artifacts/art_links01/report.md)'
const messages = Array.from({ length: 32 }, (_, i) => [
  { id: `msg_user${i}`, role: 'user', content: `Check ${i + 1}: can I follow a link and return to this conversation?`, meta: null, createdAt: now - (64 - i * 2) * 60000 },
  { id: `msg_reply${i}`, role: 'assistant', content: `Checked the chat links at phone and desktop widths. The conversation stays available while you review related work.\n\n${links}\n\nYour place in this thread and your unsent reply should be here when you come back.`, meta: null, createdAt: now - (63 - i * 2) * 60000 },
]).flat()
const schedule = { id: 'sch_links01', name: 'Daily navigation checks', target: 'project', projectId: project.id, cron: '0 9 * * *', timezone: 'UTC', enabled: true, prompt: 'Check task links and report any navigation regressions.', runCount: 0, catchUp: 'once', allowOverlap: false, createdAt: now, updatedAt: now }
const captain = { busy: false, usage: { tokens: 12000, window: 1000000, updatedAt: now }, compacting: false, compactQueued: false, error: null }
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--mute-audio'] })
const checks = []
try {
  for (const [width, zoom] of [...[320, 400, 560, 800, 1440].map((w) => [w, 1]), ...[320, 400, 560, 800, 1440].map((w) => [w, 1.25])]) {
    for (const source of ['coordinator', 'inline-captain', 'captain', 'task']) {
      const ctx = await browser.newContext({ viewport: { width: Math.round(width / zoom), height: Math.round(900 / zoom) }, deviceScaleFactor: zoom, isMobile: width < 1000, hasTouch: width < 1000, reducedMotion: 'reduce' })
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
        else if (path === '/api/tasks') json = tasks
        else if (/^\/api\/tasks\/[^/]+$/.test(path)) json = tasks.find((t) => path.endsWith(t.id))
        else if (path.endsWith('/messages') || path === '/api/chat') json = messages
        else if (path.endsWith('/captain')) json = captain
        else if (path === '/api/schedules') json = [schedule]
        else if (['/api/health', '/api/me', '/api/settings', '/api/orchestrator', '/api/setup', '/api/models', '/api/tts', '/api/cloud'].includes(path)) return r.continue()
        else json = []
        return r.fulfill({ json })
      })
      await ctx.route('**/artifacts/art_links01/report.md', (r) => r.fulfill({ contentType: 'text/markdown', body: '# Navigation report\n\nPhone and desktop links stay in the app.' }))
      const page = await ctx.newPage()
      page.setDefaultTimeout(10000)
      page.on('pageerror', (e) => errors.push(e.message))
      page.on('request', (r) => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) documents.push(r.url()) })
      const search = source === 'captain' ? `?captain=${project.id}` : source === 'task' ? `?session=${tasks[0].id}` : source === 'inline-captain' ? `?project=${project.id}` : ''
      await page.goto(`${base}/${search}`)
      const baseChat = source === 'coordinator' || source === 'inline-captain'
      const root = baseChat ? page.getByTestId('chat-panel') : page.getByRole('dialog').first()
      if (baseChat) await root.getByRole('button', { name: /\d+ earlier/ }).first().press('Enter')
      const anchor = root.getByRole('link', { name: 'Open navigation task', exact: true }).nth(baseChat ? 2 : 5)
      await anchor.waitFor().catch(async (error) => {
        await page.screenshot({ path: `${out}/failure.png` })
        console.error({ errors, body: (await page.locator("body").innerText()).slice(0, 4000) })
        throw error
      })
      await root.locator('textarea').fill(`Unsent ${source} reply`)
      // Put the link below the card's sticky header, including at 256 CSS px (320px at 125%).
      await anchor.evaluate((el) => el.scrollIntoView({ block: 'end' }))
      const scroller = anchor.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " overflow-y-auto ")][1]')
      const box = await anchor.boundingBox()
      await page.mouse.move(box.x + 5, box.y + 5)
      await page.mouse.wheel(0, -120)
      await page.waitForTimeout(150) // Wheel scrolling commits asynchronously in Chromium.
      await anchor.evaluate((el) => el.scrollIntoView({ block: 'end' }))
      await page.waitForTimeout(150)
      // Use a visible text fragment for the real pointer click. Playwright's automatic centering
      // scrolls multiline inline links past sticky card headers at the narrowest zoomed widths.
      const point = await anchor.evaluate((el) => {
        const rect = [...el.getClientRects()].at(-1)
        const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
        return { x, y, hit: el.contains(document.elementFromPoint(x, y)) }
      })
      assert(point.hit, 'The source link is visible and accepts pointer input')
      const before = await scroller.evaluate((el) => el.scrollTop)
      assert(before > 0, 'Exercise an actual scrolled thread')
      await scroller.evaluate((el) => { window.auditScroller = el })
      await root.locator('textarea').evaluate((el) => { window.auditDraft = el })
      if (zoom === 1 && [400, 1440].includes(width)) await page.screenshot({ path: `${out}/${source}-source-${width}.png` })
      await page.mouse.click(point.x, point.y)
      const target = page.getByRole('dialog', { name: tasks[1].title, exact: true })
      await target.waitFor()
      const panel = page.locator('[data-testid="side-thread"][data-conversation]')
      assert.equal(await panel.count(), 1, 'One shared question/conversation panel')
      assert.equal(await page.getByRole('dialog').count(), 1, 'Replace conversations without stacking')
      assert.equal(new URL(page.url()).pathname, '/')
      assert.equal(documents.length, 1, 'No document navigation or reload')
      assert.equal(await target.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false)
      await page.waitForTimeout(350)
      const frame = await panel.boundingBox()
      const viewport = page.viewportSize()
      if (viewport.width < 568) assert(Math.abs(frame.width - viewport.width) < 2, 'Phone panel covers the chat')
      else assert(frame.x >= 319 && frame.width < viewport.width, 'Desktop panel sits beside the source chat')
      if (zoom === 1 && [400, 1440].includes(width)) await page.screenshot({ path: `${out}/${source}-task-${width}.png` })
      if (source === 'coordinator') await page.screenshot({ path: `${out}/panel-${width}-${zoom}.png` })
      await page.goBack()
      await target.waitFor({ state: 'hidden' })
      await page.waitForTimeout(350)
      if (baseChat) {
        assert.equal(await scroller.evaluate((el) => el === window.auditScroller), true, 'Keep the source scroll container')
        assert.equal(await root.locator('textarea').evaluate((el) => el === window.auditDraft), true, 'Keep the source composer')
        assert.equal(await root.locator('textarea').inputValue(), `Unsent ${source} reply`)
      } else {
        assert.equal(await page.getByRole('dialog').count(), 1)
        assert.equal(await page.evaluate(() => window.auditDraft.isConnected), false, 'The replaced conversation unmounts')
      }
      assert(Math.abs(await scroller.evaluate((el) => el.scrollTop) - before) <= 1, `Back restores scroll: ${before} -> ${await scroller.evaluate((el) => el.scrollTop)}`)
      await page.goForward()
      await target.waitFor()
      await page.keyboard.press('Escape')
      await target.waitFor({ state: 'hidden' })
      await page.waitForTimeout(350)
      assert.equal(new URL(page.url()).search, '', 'Esc closes the entire panel trail')
      if (baseChat) {
        assert(Math.abs(await scroller.evaluate((el) => el.scrollTop) - before) <= 1, 'Esc restores exact source scroll')
        assert.equal(await anchor.evaluate((el) => el === document.activeElement), true, 'Close restores source focus')
      }
      if (zoom === 1 && [400, 1440].includes(width)) await page.screenshot({ path: `${out}/${source}-restored-${width}.png` })
      // Native Ctrl/middle-click leave the source URL and panel untouched.
      if (width === 1440 && zoom === 1 && source === 'coordinator') {
        for (const opts of [{ modifiers: ['Control'] }, { button: 'middle' }]) {
          const popupReady = ctx.waitForEvent('page')
          await anchor.click(opts)
          const popup = await popupReady
          await popup.waitForURL(`**/?session=${tasks[1].id}`)
          assert.equal(page.url(), `${base}/`)
          assert.equal(await page.getByRole('dialog').count(), 0)
          await popup.close()
        }
      }
      // The remaining labeled action uses this same slot. Refresh keeps its URL-backed content;
      // browser Back/Forward work, and the phone-style header Back returns to the source control.
      const open = page.locator(`#card-${tasks[0].id}`).getByRole('link', { name: 'View conversation', exact: true })
      await open.click()
      const firstTask = page.getByRole('dialog', { name: tasks[0].title, exact: true })
      await firstTask.waitFor()
      assert.equal(await panel.count(), 1)
      await firstTask.getByRole('link', { name: 'Open navigation task', exact: true }).nth(2).click()
      await target.waitFor()
      assert.equal(await page.getByRole('dialog').count(), 1)
      await page.reload()
      await target.waitFor()
      assert.equal(await page.getByRole('dialog').count(), 1)
      await page.goBack()
      await firstTask.waitFor()
      await page.goForward()
      await target.waitFor()
      await target.getByRole('button', { name: 'Back', exact: true }).click()
      await target.waitFor({ state: 'hidden' })
      assert.equal(page.url(), `${base}/`)
      assert.equal(await page.locator('[data-testid="chat-footer"] textarea').evaluate((el) => el === document.activeElement), true, 'Refresh has a safe composer focus fallback')
      if (source === 'task') {
        const chat = page.getByTestId('chat-panel')
        await chat.getByRole('button', { name: /\d+ earlier/ }).first().press('Enter')
        await chat.getByRole('link', { name: 'Project Captain', exact: true }).nth(2).click()
        const captainPanel = page.getByRole('dialog', { name: 'box-yard Captain', exact: true })
        await captainPanel.waitFor()
        if (zoom === 1 && [400, 1440].includes(width)) await page.screenshot({ path: `${out}/project-${width}.png` })
        await captainPanel.getByRole('link', { name: 'Daily checks', exact: true }).nth(2).click()
        const schedulePanel = page.getByRole('dialog', { name: schedule.name, exact: true })
        await schedulePanel.getByText(schedule.prompt, { exact: true }).waitFor()
        assert.equal(await page.getByRole('dialog').count(), 1)
        if (zoom === 1 && [400, 1440].includes(width)) await page.screenshot({ path: `${out}/schedule-${width}.png` })
        await page.keyboard.press('Escape')
        await schedulePanel.waitFor({ state: 'hidden' })
        await open.click()
        await firstTask.waitFor()
        await firstTask.getByRole('link', { name: 'Navigation report', exact: true }).nth(2).click()
        const preview = page.getByRole('dialog', { name: 'report.md', exact: true })
        await preview.getByRole('heading', { name: 'Navigation report', exact: true }).waitFor()
        await page.keyboard.press('Escape')
        await preview.waitFor({ state: 'detached' })
        assert.equal(await firstTask.count(), 1, 'Esc closes the preview alone')
        await firstTask.getByRole('button', { name: 'Back', exact: true }).click()
        await firstTask.waitFor({ state: 'hidden' })
        assert.equal(page.url(), `${base}/`)
      }
      assert.deepEqual(errors, [], 'No browser errors')
      assert.deepEqual(writes, [], 'No API writes')
      const check = { source, width, zoom, scrollTop: before, documents: documents.length, errors, writes }
      checks.push(check)
      console.log(JSON.stringify(check))
      await ctx.close()
    }
  }
} finally {
  await browser.close()
}
await fs.writeFile(`${out}/checks.json`, JSON.stringify(checks, null, 2))
