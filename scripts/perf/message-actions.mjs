#!/usr/bin/env node
// Inspect existing thread/question/new-task paths on a seeded mock yard. No message or task is submitted.
// PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROMIUM_PATH=/path/to/chrome \
//   node scripts/perf/message-actions.mjs http://localhost:4260 prj_uxyard01 /tmp/actions [--record]
import fs from 'node:fs/promises'
const [base, projectId, out, mode] = process.argv.slice(2)
if (!base || !projectId || !out) throw new Error('Pass an isolated mock URL, project id and screenshot directory')
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--mute-audio'] })
const answer = 'The preview is ready. Review the sign-in flow on a phone, then start a task with anything you find. Keep the existing Coordinator as your main input.'
const messages = [
  { id: 'msg_actionask1', role: 'user', content: 'What should I check next?', meta: null, createdAt: Date.now() - 2000 },
  { id: 'msg_actionreply1', role: 'assistant', content: answer, meta: null, createdAt: Date.now() - 1000 },
]
await fs.mkdir(out, { recursive: true })
const results = []
try {
  for (const physical of [320, 400, 560, 800]) for (const zoom of [1, 1.25]) {
    const context = await browser.newContext({ viewport: { width: Math.round(physical / zoom), height: Math.round(1000 / zoom) }, deviceScaleFactor: zoom, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
    try {
      await context.addInitScript(() => {
        localStorage.setItem('box-yard:setup-skipped', 'true')
        localStorage.setItem('boxyard:voice', JSON.stringify({ enabled: false }))
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copied = text } } })
      })
      const page = await context.newPage(), errors = []
      page.setDefaultTimeout(10000)
      page.on('pageerror', e => errors.push(e.message))
      await page.route('**/api/**', r => r.request().method() === 'GET' && !r.request().url().endsWith('/stream') ? r.continue() : r.abort())
      await page.route('**/api/chat', r => r.fulfill({ json: messages }))
      await page.route(`**/api/projects/${projectId}/captain/messages`, r => r.fulfill({ json: messages.map(m => ({ ...m, projectId })) }))
      for (const scope of ['coordinator', 'captain']) {
        await page.goto(new URL(`/${scope === 'captain' ? `?project=${projectId}` : ''}`, base).href)
        const root = page.getByTestId(`${scope}-card`), reply = root.getByTestId('chat-reply').last()
        await reply.getByText(answer, { exact: true }).scrollIntoViewIfNeeded()
        await reply.getByText(answer, { exact: true }).tap()
        const bar = reply.getByRole('toolbar', { name: 'Message actions', exact: true })
        const show = async () => {
          if (await bar.evaluate(el => getComputedStyle(el).opacity) === '0') await reply.getByText(answer, { exact: true }).tap()
        }
        await page.waitForFunction(el => getComputedStyle(el).opacity === '1', await bar.elementHandle())
        const bounds = await bar.locator('button').evaluateAll(bs => bs.map(b => {
          const r = b.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
          return { label: b.getAttribute('aria-label'), width: r.width, height: r.height, clipped: r.left < 0 || r.right > innerWidth, hit: hit === b || b.contains(hit) }
        }))
        const failures = bounds.filter(b => b.width < 44 || b.height < 44 || b.clipped || !b.hit)
        await page.screenshot({ path: `${out}/${scope}-${physical}-${zoom}.png` })
        if (mode !== '--record' && failures.length) throw new Error(JSON.stringify(failures))
        // Reply opens only this answer, then back returns to the original message without submitting anything.
        await bar.getByTestId('message-reply').tap()
        const thread = page.getByTestId('side-thread')
        await thread.getByTestId('side-thread-original').getByText(answer, { exact: true }).waitFor()
        if (physical === 400 && zoom === 1) await page.screenshot({ path: `${out}/${scope}-thread.png` })
        const back = thread.getByRole('button', { name: 'Back to the chat', exact: true })
        if (await back.isVisible()) await back.tap()
        else await thread.getByRole('button', { name: 'Close thread', exact: true }).tap()
        await thread.waitFor({ state: 'detached' })
        // Ask and New task reuse their existing quotation surfaces.
        await show()
        await bar.getByTestId('message-ask').tap()
        await page.getByTestId('ask-quote').waitFor()
        if (!answer.includes(await page.getByTestId('ask-quote').innerText())) throw new Error('Ask must retain the source answer')
        await page.keyboard.press('Escape')
        await show()
        await bar.getByTestId('message-respond').tap()
        await page.getByTestId('selection-quote').waitFor()
        if (!answer.includes(await page.getByTestId('selection-quote').innerText())) throw new Error('New task must retain the source answer')
        if (physical === 400 && zoom === 1) await page.screenshot({ path: `${out}/${scope}-new-task.png` })
        await page.keyboard.press('Escape')
        await show()
        await bar.getByTestId('message-more').tap()
        const items = page.getByRole('menuitem')
        const itemBounds = await items.evaluateAll(bs => bs.map(b => ({ label: b.textContent, height: b.getBoundingClientRect().height, width: b.getBoundingClientRect().width })))
        if (physical === 400 && zoom === 1) await page.screenshot({ path: `${out}/${scope}-more.png` })
        if (mode !== '--record' && itemBounds.some(b => b.height < 44)) throw new Error('Touch menu items must remain 44 px in wide containers too')
        if (mode !== '--record') {
          await page.getByRole('menuitem', { name: 'Copy message', exact: true }).tap()
          if (await page.evaluate(() => window.__copied) !== answer) throw new Error('Copy must preserve the whole answer')
        } else await page.keyboard.press('Escape')
        results.push({ scope, physical, zoom, bounds, failures, itemBounds, errors })
        console.log(`${scope} ${physical}px at ${zoom * 100}%: ${failures.length} target failures; thread, question and new-task quote checked`)
      }
      if (errors.length) throw new Error(errors.join('; '))
    } finally { await context.close() }
  }
  if (mode !== '--record') for (const width of [800, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' })
    try {
      await context.addInitScript(() => {
        localStorage.setItem('box-yard:setup-skipped', 'true')
        localStorage.setItem('boxyard:voice', JSON.stringify({ enabled: false }))
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copied = text } } })
      })
      const page = await context.newPage()
      await page.route('**/api/**', r => r.request().method() === 'GET' && !r.request().url().endsWith('/stream') ? r.continue() : r.abort())
      await page.route('**/api/chat', r => r.fulfill({ json: messages }))
      await page.route(`**/api/projects/${projectId}/captain/messages`, r => r.fulfill({ json: messages.map(m => ({ ...m, projectId })) }))
      for (const scope of ['coordinator', 'captain']) {
        await page.goto(new URL(`/${scope === 'captain' ? `?project=${projectId}` : ''}`, base).href)
        const reply = page.getByTestId(`${scope}-card`).getByTestId('chat-reply').last()
        await reply.hover()
        const bar = reply.getByRole('toolbar', { name: 'Message actions', exact: true })
        await page.waitForFunction(el => getComputedStyle(el).opacity === '1', await bar.elementHandle())
        const bounds = await bar.locator('button').evaluateAll(bs => bs.map(b => {
          const r = b.getBoundingClientRect()
          return { width: r.width, height: r.height, clipped: r.left < 0 || r.right > innerWidth }
        }))
        if (bounds.length !== 4 || bounds.some(b => b.width !== 28 || b.height !== 24 || b.clipped)) throw new Error('Mouse toolbar must stay compact and fit')
        await page.screenshot({ path: `${out}/${scope}-desktop-${width}.png` })
        const more = bar.getByTestId('message-more')
        await more.focus()
        await page.keyboard.press('Enter')
        const copy = page.getByRole('menuitem', { name: 'Copy message', exact: true })
        if (!await copy.evaluate(el => el === document.activeElement)) throw new Error('Menu must focus its first action')
        await page.keyboard.press('Enter')
        if (await page.evaluate(() => window.__copied) !== answer || !await more.evaluate(el => el === document.activeElement)) throw new Error('Keyboard copy must preserve the answer and return focus')
        await page.keyboard.press('Enter')
        await page.keyboard.press('Escape')
        if (!await more.evaluate(el => el === document.activeElement)) throw new Error('Escape must return focus to More')
        results.push({ scope, width, pointer: 'fine', bounds, keyboardCopy: true })
        console.log(`${scope} ${width}px mouse: compact toolbar, keyboard copy and focus checked`)
      }
    } finally { await context.close() }
  }
} finally { await browser.close() }
await fs.writeFile(`${out}/checks.json`, JSON.stringify(results, null, 2))
