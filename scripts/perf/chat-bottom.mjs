#!/usr/bin/env node
// Real-browser check that a long chat reaches its bottom and stays there while a reply streams, and that a send from
// far up lands on the bottom. The Coordinator, a Captain and a task, at a phone and a desktop width. Only the browser's
// compositor scrolls against a stale layout (a wheel lands on the bottom from a frame ago), so happy-dom can't show it.
// Only an isolated mock server is accepted. All writes and SSE are browser fixtures.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/perf/chat-bottom.mjs http://localhost:4000 /tmp/chat-bottom [--record]
// --record captures the behaviour without asserting it. CHAT_BOTTOM_WIDTHS=400,1440 CHAT_BOTTOM_SURFACES=coordinator,captain,task
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
const task = { id: 'task_scroll01', projectId: project.id, title: 'Chat bottom check', prompt: '', status: 'working', previews: [], waitFor: [], createdAt: 1, updatedAt: 1, agentCli: 'claude', runsOn: 'box' }
// Varied heights: one to five paragraphs, some code and lists.
const body = i => `Message ${i}: a paragraph long enough to wrap over a couple of lines at desktop widths, so heights vary.\n\n`.repeat(1 + (i % 5)) + (i % 7 === 0 ? '```ts\nconst x = ' + i + '\n```\n' : '') + (i % 4 === 0 ? '- one\n- two\n' : '')
const chatMessage = (i, extra = {}) => ({ id: `chat_history${String(i).padStart(4, '0')}`, role: i % 2 ? 'assistant' : 'user', content: body(i), meta: null, createdAt: 1_700_000_000_000 + i * 1000, ...extra })
const taskMessage = i => {
  const role = ['user', 'assistant', 'tool', 'tool', 'assistant', 'event'][i % 6]
  return { id: `msg_${String(i).padStart(4, '0')}`, taskId: task.id, role, content: role === 'tool' ? `Bash ls -la ${i}` : role === 'event' ? `Turn ${i} finished` : body(i), meta: null, createdAt: 1_700_000_000_000 + i * 1000 }
}
const SURFACES = {
  coordinator: { path: '/', list: '[data-testid=chat-panel] .overflow-y-auto', box: '[data-testid=chat-panel] textarea' },
  captain: { path: `/?project=${project.id}`, list: '[data-testid=captain-chat] .overflow-y-auto', box: '[data-testid=captain-chat] textarea' },
  task: { path: `/?session=${task.id}`, list: '[role=dialog] .overflow-y-auto', box: '[role=dialog] textarea' },
}
const results = []
await fs.mkdir(out, { recursive: true })
const check = (condition, why) => { if (mode !== '--record') assert(condition, why) }
try {
  for (const width of (process.env.CHAT_BOTTOM_WIDTHS?.split(',').map(Number) ?? [400, 1440])) {
    for (const surface of (process.env.CHAT_BOTTOM_SURFACES?.split(',') ?? Object.keys(SURFACES))) {
      const { path, list, box } = SURFACES[surface]
      const phone = width < 600
      const context = await browser.newContext({ viewport: { width, height: phone ? 800 : 900 }, isMobile: phone, hasTouch: phone })
      try {
        await context.addInitScript(() => {
          localStorage.setItem('box-yard:setup-skipped', 'true')
          localStorage.setItem('boxyard:voice', JSON.stringify({ enabled: false }))
          window.EventSource = class {
            constructor() { window.fixtureStream = this; setTimeout(() => this.onopen?.(), 0) }
            close() {}
          }
          window.emit = event => window.fixtureStream.onmessage({ data: JSON.stringify(event) })
        })
        const page = await context.newPage(), errors = []
        page.on('pageerror', e => errors.push(e.message))
        const chat = Array.from({ length: 220 }, (_, i) => chatMessage(i))
        let sent = 0
        await page.route('**/api/**', async r => {
          const p = new URL(r.request().url()).pathname
          if (r.request().method() !== 'GET') {
            if (p === '/api/chat' || p.endsWith('/captain/messages') || p.endsWith('/messages')) {
              const b = r.request().postDataJSON()
              return r.fulfill({ json: { ...chatMessage(5000 + ++sent), ...b, role: 'user', taskId: task.id, projectId: project.id, id: b.id ?? `msg_sent${sent}` } })
            }
            return r.abort()
          }
          if (p === '/api/chat') return r.fulfill({ json: chat })
          if (p === '/api/projects') return r.fulfill({ json: [project] })
          if (p === '/api/tasks') return r.fulfill({ json: [task] })
          if (p === `/api/tasks/${task.id}`) return r.fulfill({ json: task })
          if (p === `/api/tasks/${task.id}/messages`) return r.fulfill({ json: Array.from({ length: 400 }, (_, i) => taskMessage(i)) })
          if (p.endsWith('/captain/messages')) return r.fulfill({ json: chat.map(m => ({ ...m, projectId: project.id })) })
          if (p.endsWith('/captain')) return r.fulfill({ json: { busy: true, usage: {}, compacting: false, compactQueued: false, error: null } })
          if (p === '/api/stream') return r.abort()
          return r.continue()
        })
        await page.goto(new URL(path, base).href)
        const scroller = page.locator(list).first()
        await scroller.waitFor()
        await page.waitForTimeout(800)
        const metrics = () => scroller.evaluate(el => ({
          top: Math.round(el.scrollTop * 10) / 10, gap: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop), view: el.clientHeight,
          away: !!document.querySelector('[data-testid=jump-latest], [data-jump]'),
        }))
        // A reply streams all along: the Coordinator's text grows, a task or Captain gets new messages.
        await page.evaluate(({ surface, taskId, projectId }) => {
          let n = 0
          if (surface === 'coordinator') window.emit({ type: 'chat.busy', busy: true })
          window.streamTimer = setInterval(() => {
            n++
            if (surface === 'coordinator') window.emit({ type: 'chat.delta', text: `\n\nStreamed chunk ${n}: more of the reply arrives and the layout grows a little.` })
            else if (surface === 'task' && n % 4 === 0) window.emit({ type: 'task.message', message: { id: `msg_live${n}`, taskId, role: n % 8 === 0 ? 'assistant' : 'tool', content: n % 8 === 0 ? `Live reply ${n}\n\nWith a second paragraph.` : `Read file ${n}`, meta: null, createdAt: Date.now() } })
            else if (surface === 'captain' && n % 6 === 0) window.emit({ type: 'captain.message', message: { id: `chat_live${n}`, projectId, role: 'assistant', content: `Live Captain reply ${n}\n\nSecond paragraph.`, meta: null, createdAt: Date.now() } })
          }, 80)
        }, { surface, taskId: task.id, projectId: project.id })
        const rect = await scroller.boundingBox()
        await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
        for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -400); await page.waitForTimeout(60) }
        await page.waitForTimeout(300)
        // Wheel down to the bottom, then keep wheeling there: it reaches the bottom, never pulls back up on the way, and stays.
        const down = []
        for (let i = 0; i < 80; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(50); down.push(await metrics()) }
        const reached = down.findIndex(m => !m.away && m.gap <= 1)
        const backUp = down.filter((m, i) => i > 0 && m.top < down[i - 1].top - 1).length
        const after = reached < 0 ? [] : down.slice(reached)
        await page.screenshot({ path: `${out}/${width}-${surface}-bottom.png` })
        check(reached >= 0, `${width} ${surface}: wheeling down reaches the bottom ${JSON.stringify(down.slice(-5))}`)
        check(backUp === 0, `${width} ${surface}: wheeling down never moves the view back up (${backUp} times)`)
        check(after.every(m => !m.away), `${width} ${surface}: stays pinned at the bottom ${JSON.stringify(after.map(m => m.gap))}`)
        check(new Set(down.map(m => m.view)).size === 1, `${width} ${surface}: the list's height never changes ${JSON.stringify([...new Set(down.map(m => m.view))])}`)
        // Send from far up: it glides to the bottom while the reply keeps streaming.
        for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -500); await page.waitForTimeout(40) }
        await page.waitForTimeout(400)
        const before = await metrics()
        check(before.away && before.gap > 1000, `${width} ${surface}: far up before the send ${JSON.stringify(before)}`)
        const composer = page.locator(box).last()
        await composer.fill('Send from far up the history')
        await composer.press('Enter')
        const send = []
        for (let i = 0; i < 15; i++) { await page.waitForTimeout(60); send.push(await metrics()) }
        await page.screenshot({ path: `${out}/${width}-${surface}-send.png` })
        await page.evaluate(() => clearInterval(window.streamTimer))
        await page.waitForTimeout(200)
        const settled = await metrics()
        check(!send.at(-1).away && settled.gap <= 1, `${width} ${surface}: a send lands on the bottom ${JSON.stringify(send.map(m => m.gap))}`)
        check(errors.length === 0, `${width} ${surface}: page errors ${errors.join('; ')}`)
        const result = { width, surface, reached, backUp, bottomGaps: after.slice(0, 20).map(m => m.gap), sendGaps: send.map(m => m.gap), settled: settled.gap }
        results.push(result)
        console.log(JSON.stringify(result))
      } finally {
        await context.close()
      }
    }
  }
} finally {
  await browser.close()
  await fs.writeFile(`${out}/results.json`, JSON.stringify(results, null, 2))
}
