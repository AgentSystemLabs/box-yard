#!/usr/bin/env node
// Exercise the existing answer → New task (all options) path in an isolated mock yard. Never launches a task.
// PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROMIUM_PATH=/path/to/chrome \
//   node scripts/perf/task-options.mjs http://localhost:4260 prj_uxyard01 /tmp/options [--record]
import fs from 'node:fs/promises'
const [base, projectId, out, mode] = process.argv.slice(2)
if (!base || !projectId || !out) throw new Error('Pass an isolated mock URL, project id and screenshot directory')
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const settings = await (await fetch(new URL('/api/agent-settings', base))).json()
const projects = await (await fetch(new URL('/api/projects', base))).json()
const answer = 'Build a small phone preview of the sign-in flow. Keep the Coordinator as the main input.'
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--mute-audio'] })
const results = []
await fs.mkdir(out, { recursive: true })
try {
  for (const physical of [320, 400, 560, 800]) for (const zoom of [1, 1.25]) {
    const context = await browser.newContext({ viewport: { width: Math.round(physical / zoom), height: Math.round(1000 / zoom) }, deviceScaleFactor: zoom, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
    try {
      await context.addInitScript(() => {
        localStorage.setItem('box-yard:setup-skipped', 'true')
        localStorage.setItem('boxyard:voice', JSON.stringify({ enabled: false }))
      })
      const page = await context.newPage(), errors = [], writes = []
      page.setDefaultTimeout(10000)
      page.on('pageerror', e => errors.push(e.message))
      await page.route('**/api/**', r => {
        if (r.request().method() === 'GET' && !r.request().url().endsWith('/stream')) return r.continue()
        if (r.request().method() !== 'GET') writes.push(r.request().url())
        return r.abort()
      })
      await page.route('**/api/agent-settings', r => r.fulfill({ json: { ...settings, settings: { ...settings.settings, agentCli: 'codex', agentCodexModel: 'gpt-6.1-sol', agentModel: 'claude-haiku-4-5' } } }))
      await page.route('**/api/projects', r => r.fulfill({ json: projects.map(p => p.id === projectId ? { ...p, agentCli: 'codex' } : p) }))
      await page.route('**/api/models', r => r.fulfill({ json: { models: [{ id: 'claude-haiku-4-5', label: 'Haiku 4.5', group: 'older', efforts: [] }], source: 'builtin', cliVersion: null, fetchedAt: null } }))
      await page.route(`**/api/projects/${projectId}/captain/messages`, r => r.fulfill({ json: [
        { id: 'msg_optionsask1', projectId, role: 'user', content: 'What should I build next?', meta: null, createdAt: Date.now() - 1000 },
        { id: 'msg_optionsreply1', projectId, role: 'assistant', content: answer, meta: null, createdAt: Date.now() },
      ] }))
      await page.goto(new URL(`/?project=${projectId}`, base).href)
      const reply = page.getByTestId('captain-card').getByTestId('chat-reply').last()
      await reply.getByText(answer, { exact: true }).tap()
      await reply.getByTestId('message-more').tap()
      await page.getByRole('menuitem', { name: 'New task with all options…', exact: true }).tap()
      const dialog = page.getByRole('dialog', { name: 'New task', exact: true })
      const cli = dialog.getByTestId('new-task-agent-cli'), effort = dialog.getByTestId('new-task-effort')
      await effort.scrollIntoViewIfNeeded()
      const bounds = await dialog.locator('[data-testid^="new-task-"]').evaluateAll(es => es.map(el => {
        const r = el.getBoundingClientRect()
        return { id: el.dataset.testid, left: r.left, right: r.right, width: r.width }
      }))
      const disabled = await effort.locator('option:disabled').count()
      const warning = await dialog.getByTestId('new-task-effort-warning').count()
      await page.screenshot({ path: `${out}/options-${physical}-${zoom}.png` })
      if (mode !== '--record') {
        if (disabled || warning) throw new Error('Codex must not inherit Claude effort restrictions')
        await effort.selectOption('xhigh')
        await cli.selectOption('claude')
        await dialog.getByTestId('new-task-effort-warning').waitFor()
        await cli.selectOption('codex')
        if (await dialog.getByTestId('new-task-effort-warning').count()) throw new Error('Switching to Codex must remove the Claude warning')
        if (await effort.inputValue() !== 'xhigh') throw new Error('Switching the harness must retain the explicit effort')
      }
      if (bounds.some(b => b.left < 0 || b.right > Math.round(physical / zoom))) throw new Error('Task options overflow')
      if (errors.length || writes.length) throw new Error(JSON.stringify({ errors, writes }))
      results.push({ physical, zoom, disabled, warning, bounds, harnessSwitch: mode !== '--record' })
      console.log(`${physical}px at ${zoom * 100}%: ${disabled} disabled choices, ${warning} warnings; no task launched`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
await fs.writeFile(`${out}/checks.json`, JSON.stringify(results, null, 2))
