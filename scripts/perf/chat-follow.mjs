#!/usr/bin/env node
// Real-layout regression check; only an isolated mock server is accepted. All writes and SSE are browser fixtures.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/perf/chat-follow.mjs http://localhost:4000 /tmp/chat-follow [--record]
// --record captures the old behavior without asserting the fix. No real tools, runners or credentials are used.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
const [base, out, mode] = process.argv.slice(2)
if (!base || !out) throw new Error('Pass an isolated mock URL and an output directory')
const url = new URL(base)
assert(['localhost', '127.0.0.1'].includes(url.hostname) && url.port !== '3000', 'Use an isolated loopback port')
assert.equal((await (await fetch(new URL('/api/health', base))).json()).mock, true)
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox', '--mute-audio'] })
const project = { id: 'prj_scroll01', name: 'Scroll checks', description: '', repo: null, baseBranch: 'main', envKeys: [], notes: [], identityId: 'default', runner: 'box', createdAt: 1, color: null }
const task = { id: 'task_scroll01', projectId: project.id, title: 'Chat follow check', prompt: '', status: 'idle', previews: [], waitFor: [], createdAt: 1, updatedAt: 1, agentCli: 'codex', runsOn: 'box' }
const message = (i, extra = {}) => ({ id: `chat_history${i}`, role: i % 2 ? 'assistant' : 'user', content: (`History ${i}: Keep this conversation in view as replies stream and the layout grows.\n\n`).repeat(8), meta: null, createdAt: 1000 + i, ...extra })
const scrollerSelector = '[data-testid=chat-panel] .overflow-y-auto'
const results = [], shots = []
await fs.mkdir(out, { recursive: true })
const check = (condition, why) => { if (mode !== '--record') assert(condition, why) }
try {
  for (const width of (process.env.CHAT_FOLLOW_WIDTHS?.split(',').map(Number) ?? [320, 400, 560, 800, 1440])) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: width < 600, hasTouch: width < 600, reducedMotion: 'reduce' })
    try {
      await context.addInitScript(() => {
        localStorage.setItem('box-yard:setup-skipped', 'true')
        localStorage.setItem('boxyard:voice', JSON.stringify({ enabled: false }))
        // Exercise the application's real SSE -> Query cache -> memoized reply path deterministically.
        window.EventSource = class {
          constructor() { window.fixtureStream = this; setTimeout(() => this.onopen?.(), 0) }
          close() {}
        }
        window.emit = event => window.fixtureStream.onmessage({ data: JSON.stringify(event) })
      })
      const page = await context.newPage(), errors = [], writes = []
      page.on('pageerror', e => errors.push(e.message))
      const initial = Array.from({ length: 6 }, (_, i) => message(i))
      await page.route('**/api/**', async r => {
        const path = new URL(r.request().url()).pathname
        if (r.request().method() !== 'GET') {
          writes.push(path)
          if (path === '/api/chat' || path.endsWith('/captain/messages') || path.endsWith('/messages')) {
            const body = r.request().postDataJSON()
            return r.fulfill({ json: message(100, { ...body, role: 'user', taskId: task.id, projectId: project.id }) })
          }
          return r.abort()
        }
        if (path === '/api/chat') return r.fulfill({ json: initial })
        if (path === '/api/projects') return r.fulfill({ json: [project] })
        if (path === '/api/tasks') return r.fulfill({ json: [task] })
        if (path === `/api/tasks/${task.id}`) return r.fulfill({ json: task })
        if (path === `/api/tasks/${task.id}/messages`) return r.fulfill({ json: Array.from({ length: 90 }, (_, i) => message(i, { taskId: task.id })) })
        if (path.endsWith('/captain/messages')) return r.fulfill({ json: initial.map(m => ({ ...m, projectId: project.id })) })
        if (path.endsWith('/captain')) return r.fulfill({ json: { busy: false, usage: {}, compacting: false, compactQueued: false, error: null } })
        if (path === '/api/stream') return r.abort()
        return r.continue()
      })
      await page.goto(new URL('/', base).href)
      const scroller = page.locator(scrollerSelector).first()
      await page.waitForTimeout(400)
      const metrics = () => scroller.evaluate(el => ({ top: el.scrollTop, gap: el.scrollHeight - el.clientHeight - el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight }))
      const atBottom = async () => (await metrics()).gap <= 1
      const emit = async event => { await page.evaluate(e => window.emit(e), event); await page.waitForTimeout(70) }
      const grow = async (n = 6) => {
        for (let i = 0; i < n; i++) await emit({ type: 'chat.delta', text: `\n\nStream chunk ${i + 1}: new text arrives without adding another message. Follow this line as the answer grows.` })
      }
      const capture = async (name, caption) => {
        if (![400, 1440].includes(width)) return
        const file = `${width}-${name}.png`
        await page.screenshot({ path: `${out}/${file}` })
        shots.push({ file, caption: `${width}px · ${caption}`, metrics: await metrics() })
      }
      const wheel = async dy => {
        await scroller.hover(); await page.mouse.wheel(0, dy)
        await page.waitForTimeout(120)
      }
      check(await atBottom(), `${width}: initial mount`)
      await emit({ type: 'chat.busy', busy: true })
      const start = await metrics()
      await grow()
      check(await atBottom(), `${width}: streaming with no new message`)
      await capture('following', 'Reply streams: following at the bottom')
      // Continuous real SSE/cache/render growth while trackpad-sized wheel inputs arrive slowly.
      await page.evaluate(() => {
        window.streamTimer = setInterval(() => window.emit({ type: 'chat.delta', text: '\n\nContinuous streamed content grows while the user reads and scrolls slowly.' }), 80)
      })
      const slowStart = await metrics(), slowTrace = []
      for (let i = 0; i < 16; i++) {
        await wheel(-2)
        slowTrace.push(await metrics())
        check(slowTrace.at(-1).top <= slowStart.top - (i + 1), `${width}: slow 2px wheel ${i + 1} escapes streaming ${JSON.stringify({ slowStart, actual: slowTrace.at(-1) })}`)
      }
      await page.evaluate(() => clearInterval(window.streamTimer))
      const afterNudge = await metrics()
      await grow()
      check(Math.abs((await metrics()).top - afterNudge.top) <= 1, `${width}: growth holds after slow scrolling`)
      await capture('holding', '16 slow 2px scrolls during streaming: hold')
      await wheel(-300)
      const reading = await metrics()
      await grow()
      const held = await metrics()
      check(Math.abs(held.top - reading.top) <= 1 && held.gap > 40, `${width}: hold reading position ${JSON.stringify({ reading, held })}`)
      const jump = page.getByTestId('jump-latest')
      const jumpBox = await jump.boundingBox()
      check(jumpBox && (width >= 600 || jumpBox.height >= 44), `${width}: mobile jump target`)
      await jump.click()
      await page.waitForTimeout(150)
      await grow(2)
      check(await atBottom(), `${width}: jump re-pins`)
      await capture('jump', 'Jump to latest: following resumes')
      await wheel(-300)
      const composer = page.locator('[data-testid=chat-panel] textarea').last()
      await composer.fill('Continue following this reply')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await page.waitForTimeout(200)
      await grow(3)
      check(await atBottom(), `${width}: sending re-pins`)
      await capture('send', 'Send from history: following resumes')
      // Only an actual return to the bottom re-engages; being 1px short does not.
      await wheel(-10)
      await scroller.evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight - 1 })
      await page.waitForTimeout(100)
      const nearBottom = await metrics()
      await grow(2)
      check(Math.abs((await metrics()).top - nearBottom.top) <= 1, `${width}: 1px short stays unpinned`)
      await wheel(10000)
      await grow(2)
      check(await atBottom(), `${width}: user reaching bottom re-pins`)
      const inputs = []
      if (width < 600) {
        const cdp = await context.newCDPSession(page)
        const box = await scroller.boundingBox(), x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2)
        const before = await metrics()
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
        // Cross Chromium's native touch slop before streaming; sub-slop moves are not DOM touchmove events.
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 24 }] })
        await page.waitForTimeout(100)
        check(await jump.isVisible(), `${width}: first native touchmove releases follow`)
        const released = await metrics()
        for (let i = 1; i <= 20; i++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 24 + i * 3 }] })
          await emit({ type: 'chat.delta', text: '\n\nStreaming during a slow touch gesture.' })
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await page.waitForTimeout(500)
        const after = await metrics()
        check(after.top < released.top, `${width}: real touch scroll moves upward ${JSON.stringify({ before, released, after })}`)
        await grow(2)
        check(Math.abs((await metrics()).top - after.top) <= 1, `${width}: touch releases follow`)
        inputs.push({ type: 'native touch', before, released, after })
        await cdp.detach()
      } else {
        for (const key of ['ArrowUp', 'PageUp']) {
          await wheel(10000)
          await scroller.evaluate(el => { el.tabIndex = 0; el.focus({ preventScroll: true }) })
          const before = await metrics()
          await page.keyboard.press(key)
          await grow(3)
          await page.waitForTimeout(200)
          const after = await metrics()
          check(after.top < before.top, `${width}: ${key} scroll moves upward`)
          await grow(2)
          check(Math.abs((await metrics()).top - after.top) <= 1, `${width}: ${key} releases follow`)
          inputs.push({ type: key, before, after })
        }
        // Native scrollbar drag, not a synthetic scroll event or scrollTop assignment.
        await wheel(10000)
        const bar = await scroller.evaluate(el => {
          const r = el.getBoundingClientRect(), track = el.clientHeight, thumb = track * track / el.scrollHeight
          const gutter = (el.offsetWidth - el.clientWidth) / 2 // stable both-edges
          return { x: r.right - gutter / 2, y: r.bottom - thumb / 2 }
        })
        const before = await metrics()
        await page.mouse.move(bar.x, bar.y); await page.mouse.down()
        await page.mouse.move(bar.x, bar.y - 4, { steps: 4 })
        await grow(2)
        await page.mouse.up(); await page.waitForTimeout(150)
        const after = await metrics()
        if (!(after.top < before.top)) await page.screenshot({ path: `${out}/scrollbar-failure.png` })
        check(after.top < before.top, `${width}: native scrollbar drag moves upward ${JSON.stringify({ bar, before, after })}`)
        await grow(2)
        check(Math.abs((await metrics()).top - after.top) <= 1, `${width}: scrollbar drag releases follow`)
        inputs.push({ type: 'native scrollbar', before, after })
      }
      await wheel(10000)
      // Real image layout: no React rerender or message-count change. Image load grows the existing reply.
      await scroller.locator('.prose-chat').last().evaluate(el => {
        const image = document.createElement('img')
        image.alt = 'Loaded layout fixture'
        image.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="360"><rect width="600" height="360" fill="#164e63"/></svg>')
        el.append(image)
      })
      await page.waitForTimeout(150)
      check(await atBottom(), `${width}: image layout growth`)
      await page.setViewportSize({ width, height: 700 })
      await page.waitForTimeout(100)
      check(await atBottom(), `${width}: viewport resize`)
      // Inline Captain content arrives through the real Captain message cache, inside the shared scroller.
      await page.goto(new URL(`/?project=${project.id}`, base).href)
      await page.getByTestId('captain-card').waitFor()
      await page.waitForTimeout(150)
      await emit({ type: 'captain.message', message: message(101, { projectId: project.id, role: 'assistant', content: 'Inline Captain reply\n\n'.repeat(60) }) })
      check(await atBottom(), `${width}: inline Captain growth`)
      await wheel(-300)
      const captainReading = await metrics()
      await emit({ type: 'captain.message', message: message(102, { projectId: project.id, role: 'assistant', content: 'More inline Captain content\n\n'.repeat(20) }) })
      check(Math.abs((await metrics()).top - captainReading.top) <= 1, `${width}: inline Captain holds while away ${JSON.stringify({ captainReading, after: await metrics() })}`)
      // The task's memoized useTail transcript shares the same behavior and send handle.
      await page.goto(new URL(`/?session=${task.id}`, base).href)
      const dialog = page.getByRole('dialog')
      await dialog.locator('textarea').waitFor()
      const taskScroll = dialog.locator('.overflow-y-auto').last()
      await page.waitForTimeout(150)
      const taskGap = () => taskScroll.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)
      check(await taskGap() <= 1, `${width}: task initial history`)
      await emit({ type: 'task.message', message: message(150, { taskId: task.id, role: 'assistant', content: 'Task reply\n\n'.repeat(40) }) })
      check(await taskGap() <= 1, `${width}: task new reply`)
      await taskScroll.hover(); await page.mouse.wheel(0, -300); await page.waitForTimeout(120)
      const taskTop = await taskScroll.evaluate(el => el.scrollTop)
      await emit({ type: 'task.message', message: message(151, { taskId: task.id, role: 'assistant', content: 'Task reply continues\n\n'.repeat(20) }) })
      check(Math.abs(await taskScroll.evaluate(el => el.scrollTop) - taskTop) <= 1, `${width}: task holds while away`)
      await dialog.locator('textarea').fill('Continue the task')
      await dialog.getByRole('button', { name: 'Send', exact: true }).click()
      await page.waitForTimeout(200)
      check(await taskGap() <= 1, `${width}: task send re-pins`)
      check(!errors.length, errors.join('; '))
      results.push({ width, start, slowStart, slowTrace, afterNudge, reading, held, nearBottom, inputs, jumpBox, interceptedWrites: writes, errors })
      console.log(`${width}px: slow wheel, hold, bottom, jump, send, touch/keys/scrollbar, image, resize, inline Captain and task ${mode === '--record' ? 'recorded' : 'checked'}`)
    } finally { await context.close() }
  }
  // A strip of real UI frames with measurements; easier to review than several full-size screenshots.
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  const frames = await Promise.all(shots.map(async s => ({ ...s, data: (await fs.readFile(`${out}/${s.file}`)).toString('base64') })))
  await page.setContent(`<style>body{margin:24px;background:#09090b;color:#fafafa;font:16px system-ui}h1{font-size:24px}.frames{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}figure{margin:0}figcaption{height:66px;font-size:14px}img{width:100%;border:1px solid #3f3f46}small{color:#a1a1aa}</style><h1>Slow scrolling while a reply streams · ${mode === '--record' ? 'Before' : 'After'}</h1><div class="frames">${frames.map(s => `<figure><figcaption>${s.caption}<br><small>bottom gap ${Math.round(s.metrics.gap)}px · scrollTop ${Math.round(s.metrics.top)}</small></figcaption><img src="data:image/png;base64,${s.data}"></figure>`).join('')}</div>`)
  await page.screenshot({ path: `${out}/composite.png`, fullPage: true })
  await fs.writeFile(`${out}/checks.json`, JSON.stringify(results, null, 2))
} finally { await browser.close() }
