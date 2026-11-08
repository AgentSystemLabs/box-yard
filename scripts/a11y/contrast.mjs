// Real rendered app audit; only disposable seed-contrast.mjs mock data is accepted.
// See docs/contrast-audit.md for installation, scope, manual checks and reproduction.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { computedContrast } from './computed-contrast.mjs'
const [base = 'http://localhost:4000', output = '/tmp/contrast-results'] = process.argv.slice(2)
assert.equal((await fetch(base + '/api/health').then((r) => r.json())).mock, true, 'Only a mock yard may be audited')
const projects = await fetch(base + '/api/projects').then((r) => r.json())
assert.deepEqual(projects.map((p) => p.id), ['prj_contrast'], 'Use a NEW seed-contrast.mjs fixture')
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const axe = (await import(process.env.AXE_MODULE ?? 'axe-core')).default
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
await mkdir(output, { recursive: true })
const sections = ['orchestrator', 'projects', 'agents', 'runners', 'local', 'upstash', 'credentials', 'identities', 'connectors', 'docker', 'daytona', 'machines', 'runpod', 'vast', 'hooks', 'limits', 'costs', 'notifications', 'voice', 'appearance', 'about']
const routes = [
  ['coordinator', '/'], ['captain', '/?captain=prj_contrast'],
  ['task', '/?session=task_contrast-idle'], ['subtask', '/?session=task_contrast-child'],
  ['failed-task', '/?session=task_contrast-failed'], ['asking-task', '/?session=task_contrast-needs_input'],
  ['project-settings', '/?projectSettings=prj_contrast'], ['schedules', '/?schedule=all'],
  ['schedule-detail', '/?schedule=sch_contrast'], ['usage', '/?usage=7'],
  ...sections.map((s) => [`settings-${s}`, `/?settings=${s}`]),
]
const results = [], errors = []
try {
  for (const theme of ['light', 'dark']) for (const width of (process.env.WIDTHS ?? '1440,400').split(',').map(Number)) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    // No setting or real data is changed. Even accidental UI writes are fulfilled locally.
    await page.route('**/api/**', async (r) => {
      const url = new URL(r.request().url())
      if (url.pathname === '/api/boot' || url.pathname === '/api/stream') return r.abort()
      if (r.request().method() !== 'GET') return r.fulfill({ status: 400, json: { error: 'Example validation error: review the fields.' } })
      if (url.pathname === '/api/tasks' || /^\/api\/tasks\/task_contrast-[a-z_]+$/.test(url.pathname)) {
        const response = await r.fetch(), data = await response.json()
        const patch = (task) => {
          const status = task.id?.replace('task_contrast-', '')
          return ['queued', 'starting', 'working'].includes(status) ? { ...task, status } : task
        }
        return r.fulfill({ json: Array.isArray(data) ? data.map(patch) : patch(data) })
      }
      return r.continue()
    })
    for (const [name, url] of routes.filter(([name]) => !process.env.ONLY || new RegExp(process.env.ONLY).test(name))) {
      await page.goto(base + url)
      await page.locator('textarea').first().waitFor()
      if (name.startsWith('settings-')) await page.locator(`[data-settings-category="${name.slice(9)}"]`).waitFor({ state: 'visible' })
      else if (name === 'usage' || name === 'project-settings') await page.getByRole('dialog').last().waitFor()
      await page.waitForTimeout(180)
      assert.equal(await page.locator('html').evaluate((el) => el.classList.contains('dark')), theme === 'dark')
      await page.addScriptTag({ content: axe.source })
      const snapshots = []
      const capture = async (state) => {
        const computed = await page.evaluate(computedContrast)
        const checked = await page.evaluate(async () => {
          const scope = [...document.querySelectorAll('[role=dialog],dialog')].filter((e) => e.checkVisibility()).at(-1) ?? document.body
          const r = await axe.run(scope, { runOnly: ['color-contrast'] })
          return { violations: r.violations, incomplete: r.incomplete, passes: r.passes.reduce((n, p) => n + p.nodes.length, 0) }
        })
        snapshots.push({ state, ...computed, axe: checked })
      }
      // Visit the entire rendered scroll area in overlapping viewport-sized steps. Hidden/virtualised
      // history beyond this small fixture is deliberately out of scope, not counted as a pass.
      await page.evaluate(() => {
        const scope = [...document.querySelectorAll('[role=dialog],dialog')].filter((e) => e.checkVisibility()).at(-1) ?? document.body
        window.auditScrollers = [...scope.querySelectorAll('*')].filter((e) => e.checkVisibility() && e.clientHeight > 120 && e.scrollHeight > e.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(e).overflowY))
        for (const e of window.auditScrollers) e.scrollTop = 0
      })
      await capture('top')
      for (let step = 1; step <= 20; step++) {
        const moved = await page.evaluate(() => {
          let moved = false
          for (const e of window.auditScrollers) {
            const before = e.scrollTop; e.scrollTop += e.clientHeight * .8
            moved ||= e.scrollTop > before + 1
          }
          return moved
        })
        if (!moved) break
        await page.waitForTimeout(40)
        await capture(`scroll-${step}`)
      }
      if (['coordinator', 'task', 'settings-identities', 'settings-runners', 'settings-appearance', 'usage'].includes(name)) await page.screenshot({ path: path.join(output, `${theme}-${width}-${name}.png`) })
      const record = { theme, width, name, url, snapshots }
      results.push(record)
      console.log(`${theme} ${width} ${name}: ${snapshots.length} views, ${snapshots.reduce((n,s) => n+s.failures.length,0)} computed failures, ${snapshots.reduce((n,s) => n+s.axe.violations.reduce((n,v) => n+v.nodes.length,0),0)} axe failures`)
      await writeFile(path.join(output, 'results.json'), JSON.stringify({ browser: browser.version(), axe: axe.version, results, errors }, null, 2))
    }
    await context.close()
  }
} finally { await browser.close() }
assert.deepEqual(errors, [])
const failures = results.flatMap((r) => r.snapshots.flatMap((s) => s.failures.concat(s.axe.violations.flatMap((v) => v.nodes))))
assert.equal(failures.length, 0, `${failures.length} failures; inspect ${output}/results.json (manual/incomplete evidence also needs review)`)
