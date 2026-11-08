// Actual shared components, including states that would need live agents or provider credentials.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { computedContrast } from './computed-contrast.mjs'
const output = process.argv[2] ?? '/tmp/contrast-components'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core')
const axe = (await import(process.env.AXE_MODULE ?? 'axe-core')).default
const server = await createServer({ configFile: 'scripts/a11y/gallery.config.ts', server: { strictPort: true } })
await server.listen()
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
await mkdir(output, { recursive: true })
const results = [], errors = []
try {
  for (const theme of ['light', 'dark']) for (const width of [1440, 400]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'no-preference' })
    page.setDefaultTimeout(10000)
    page.on('pageerror', (e) => errors.push(e.message))
    await page.route('**/api/**', (r) => r.fulfill(r.request().url().includes('/login') ? { status: 400, json: { error: 'Example password error.' } } : { json: r.request().url().includes('settings') ? { settings: { ownerName: 'Example', captainIcon: 'cap' } } : [] }))
    await page.goto(`http://127.0.0.1:4001/scripts/a11y/gallery.html?theme=${theme}`)
    await page.getByRole('heading', { name: `Actual shared components · ${theme}` }).waitFor()
    await page.evaluate(async () => {
      await document.fonts.ready
      // Freeze the REAL pulse at its dimmest keyframe, rather than trusting a screenshot at peak.
      for (const a of document.getAnimations()) if (a.animationName.endsWith('pulse')) { a.pause(); a.currentTime = 1000 }
    })
    await page.addScriptTag({ content: axe.source })
    const capture = async (state) => {
      if (process.env.ONLY && !new RegExp(process.env.ONLY).test(state)) return
      await page.waitForTimeout(220) // Let existing colour transitions settle.
      if (!await page.evaluate(() => typeof window.axe !== 'undefined')) await page.addScriptTag({content: axe.source})
      const computed = await page.evaluate(computedContrast)
      const checked = await page.evaluate(async () => { const r = await axe.run(document.body, { runOnly: ['color-contrast'] }); return { violations: r.violations, incomplete: r.incomplete } })
      results.push({ theme, width, state, ...computed, axe: checked })
      await writeFile(path.join(output, 'results.json'), JSON.stringify({ browser: browser.version(), axe: axe.version, results, errors }, null, 2))
    }
    for (const section of await page.locator('[data-audit]').all()) {
      await section.scrollIntoViewIfNeeded()
      const state = await section.getAttribute('data-audit')
      await capture(state)
      if ((['controls','markdown','folded-message'].includes(state) || state.startsWith('icons-'))) await page.screenshot({path:path.join(output, `${theme}-${width}-${state}.png`)})
    }
    if (!process.env.ONLY || new RegExp(process.env.ONLY).test('pr-list')) {
      await page.getByTestId('pull-requests-button').click()
      await page.getByRole('dialog', {name:'Pull requests',exact:true}).waitFor()
      await capture('pr-list-open')
      // Simulate an SSE/cache update, without any real merge or provider request.
      await page.getByRole('button', {name:'Publish example merge update',exact:true}).dispatchEvent('click')
      await page.locator('[data-testid=pr-row] [data-pr-state=merged]').waitFor()
      await capture('pr-list-stale')
      await page.screenshot({path:path.join(output, `${theme}-${width}-pr-list-stale.png`)})
      await page.getByRole('button', {name:'History',exact:true}).click()
      await capture('pr-list-history')
      await page.getByRole('button', {name:/^View pull request:/}).first().click()
      await capture('pr-list-detail')
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
    }
    if (!process.env.ONLY) {
    // Verify both hover and keyboard focus without submitting anything.
    for (const control of await page.locator('[data-audit=controls] button:enabled,[data-audit=controls] input,[data-audit=controls] select:enabled,[data-audit=prs] a').all()) {
      await control.hover(); await capture('hover')
      await page.keyboard.press('Tab'); await control.focus(); await capture('keyboard-focus')
    }
    await page.getByRole('button', { name:'New task', exact: true }).click()
    await page.getByRole('button', { name:'More options' }).waitFor()
    await capture('new-task-popover')
    await page.getByRole('button', { name:'More options' }).click()
    await page.getByRole('dialog', { name:'New task', exact:true }).waitFor()
    await capture('new-task-options')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Show example toasts' }).click()
    await capture('toasts')
    while (await page.getByRole('button', { name:'Dismiss', exact: true }).count()) await page.getByRole('button', { name:'Dismiss', exact: true }).first().click()
    await page.getByRole('button', { name: 'Open confirmation' }).click()
    await page.getByRole('dialog', { name: 'Example confirmation' }).waitFor()
    await capture('confirmation')
    await page.screenshot({ path: path.join(output, `${theme}-${width}-confirmation.png`) })
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.evaluate(() => {document.body.scrollTop = 0; document.documentElement.scrollTop = 0; scrollTo(0,0)})
    await page.screenshot({ path: path.join(output, `${theme}-${width}-components.png`), fullPage: true })
    await page.goto(`http://127.0.0.1:4001/scripts/a11y/gallery.html?theme=${theme}&login=1`)
    await page.addScriptTag({ content: axe.source })
    await page.getByPlaceholder('Password').fill('example-fixture')
    await capture('login-focus')
    await page.getByRole('button', { name: 'Log in', exact: true }).click()
    await page.getByText('Example password error.').waitFor()
    await capture('login-error')
    await page.screenshot({ path: path.join(output, `${theme}-${width}-login.png`) })
    }
    console.log(`${theme} ${width}: ${results.filter(r=>r.theme===theme&&r.width===width).reduce((n,r)=>n+r.failures.length,0)} computed failures`)
    await page.close()
    await writeFile(path.join(output, 'results.json'), JSON.stringify({ browser: browser.version(), axe: axe.version, results, errors }, null, 2))
  }
} finally { await browser.close(); await server.close() }
assert.deepEqual(errors, [])
assert.equal(results.flatMap((r) => r.failures.concat(r.axe.violations.flatMap((v) => v.nodes))).length, 0, `Inspect ${output}/results.json; manual/incomplete results also need review`)
