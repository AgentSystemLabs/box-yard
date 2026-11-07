// Mock-only task-header screenshots and layout checks. API writes are blocked, including fixture routes.
// PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROMIUM_PATH=/path/to/chrome \
//   node scripts/perf/task-header.mjs http://localhost:4230 after artifacts/ux-task-header/after
// `before` only takes screenshots (an older build has none of the checked structure); `after` asserts the layout.
// Stop isn't in the header: a running task's ⓘ details have a red "Stop task" (with Delete), and a resting one's has none.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const [base = 'http://localhost:4230', phase = 'after', out = `artifacts/ux-task-header/${phase}`] = process.argv.slice(2)
const after = phase === 'after'
assert.equal((await (await fetch(`${base}/api/health`)).json()).mock, true)
const [settings, projects, tasks] = await Promise.all(['agent-settings', 'projects', 'tasks'].map(async (p) => (await fetch(`${base}/api/${p}`)).json()))
const now = Date.now(), project = projects[0], seed = tasks[0]
assert(project && seed, 'Seed a project and task in the isolated mock server first')

const base_task = { ...seed, id: 'task_header_demo01', projectId: project.id, title: 'Improve task navigation and preview environments on phones', status: 'working', agentCli: 'codex', boxId: 'this-computer', runsOn: 'local', branch: 'boxyard/improve-task-navigation-and-preview-environments-on-phones', prUrl: 'https://github.com/acme/box-yard/pull/239', prState: 'merged', prMergedAt: now - 60_000, prMergedBy: 'webdevcody', stayOpenOnMerge: true, previews: [{ port: 4260, url: base, label: 'Phone navigation preview' }], model: 'gpt-6', effort: 'high', routingRule: 'phone-first-ux', routingReason: 'Continue the phone-first Coordinator experience with realistic screenshots. Preserve task context, keep useful actions within reach, and check long branch names and routing notes at narrow widths.', contextTokens: 576_000, contextWindow: 1_000_000, turnCount: 8, compacting: false, compactPending: false, mergeRequest: null, pendingCount: 0, waitReason: null, createdAt: now - 3600_000, updatedAt: now }
base_task.placement = { now: { kind: 'local', boxId: 'this-computer' }, last: null, runner: 'local', chosenBy: 'task', projectRunner: 'box' }
// The main scenario at every width; a few other states at one phone width.
const SCENARIOS = {
  main: base_task,
  open: { ...base_task, status: 'pr_ready', agentCli: 'claude', prUrl: 'https://github.com/acme/box-yard/pull/243', prState: 'open', prMergedAt: null, prMergedBy: null, previews: [], boxId: 'pure-lobster-27426', runsOn: null, placement: { now: { kind: 'box', boxId: 'pure-lobster-27426', provider: 'upstash', size: 'small' }, last: null, runner: 'box', chosenBy: 'project', projectRunner: 'box' }, pendingCount: 2 },
  plain: { ...base_task, title: 'Fix login', status: 'idle', agentCli: 'claude', prUrl: null, prState: null, prMergedAt: null, previews: [] },
}
const artifacts = Array.from({ length: 247 }, (_, i) => ({ id: `art_header${i}`, projectId: project.id, taskId: base_task.id, title: `Phone layout ${i + 1}`, filename: `phone-${i + 1}.png`, mime: 'image/png', size: 4000, url: `/artifacts/art_header${i}/phone.png`, createdAt: now - i * 1000 }))
// A realistic thread: Cody's prompt, progress replies, turn events, published files and a reply with next steps.
const reply = (id, at, content, meta = null) => ({ id, role: 'assistant', content, meta, createdAt: now - at })
const event = (id, at, content, meta = null) => ({ id, role: 'event', content, meta, createdAt: now - at })
const messages = [
  { id: 'msg_h_user1', role: 'user', content: 'Continue the phone-first header work. Keep the PR chip actionable and the preview easy to open.', meta: null, createdAt: now - 3_400_000 },
  event('msg_h_ev1', 3_390_000, 'Workspace ready on this computer.'),
  reply('msg_h_a1', 3_300_000, 'I checked the current header at 320, 400, 560 and 800 px. The state wraps under three rows of chips, and the preview looks like every other chip.'),
  ...Array.from({ length: 3 }, (_, i) => event(`msg_h_art${i}`, 3_000_000 - i * 1000, `Published header-${320 + i * 80}.png`, { kind: 'artifact', url: `/artifacts/art_header${i}/phone.png`, artifactId: `art_header${i}` })),
  reply('msg_h_a2', 2_000_000, 'The header now reads top-down: title, state, then the PR and preview. Run `npm run test:related` to check it.\n\n- **Stop** is in ⓘ\n- **Preview** is the one filled chip\n- Facts (agent, files) stay quiet'),
  event('msg_h_ev2', 1_900_000, 'Turn 10 finished.'),
  { id: 'msg_h_user2', role: 'user', content: 'Looks better. Check it at 125% zoom too.', meta: null, createdAt: now - 600_000 },
  reply('msg_h_a3', 500_000, 'Checked at 125% zoom: everything fits without horizontal scrolling. **No full gate is green yet:** [#243](https://github.com/acme/box-yard/pull/243) needs the locked suite before it is ready.', { nextSteps: ['Continue the header redesign', 'Review the saved screenshots', 'Resolve the full test gate'] }),
  event('msg_h_ev3', 480_000, 'Turn 11 finished.'),
]
messages.unshift({ id: 'hidden_old_tool', role: 'tool', content: 'hidden_tool_marker', meta: null, createdAt: now - 61000 })

const RUNS = [[320, 860], [400, 860], [560, 900], [800, 900], [1440, 900]].flatMap(([w, h]) => [1, 1.25].map((zoom) => ({ scenario: 'main', w, h, zoom })))
RUNS.push({ scenario: 'open', w: 400, h: 860, zoom: 1 }, { scenario: 'plain', w: 400, h: 860, zoom: 1 }, { scenario: 'open', w: 1440, h: 900, zoom: 1 })

await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--mute-audio'] })
const checks = []
try {
  for (const { scenario, w, h, zoom } of RUNS) {
    const task = SCENARIOS[scenario]
    const files = scenario === 'plain' ? [] : artifacts
    const touch = w < 1000
    const name = `${scenario}-${w}-${zoom * 100}`
    const ctx = await browser.newContext({ viewport: { width: Math.round(w / zoom), height: Math.round(h / zoom) }, deviceScaleFactor: zoom, hasTouch: touch, isMobile: touch, reducedMotion: 'reduce' })
    // An old saved "show tool calls" preference must not bring tool calls back.
    await ctx.addInitScript(() => { localStorage.setItem('box-yard:setup-skipped', 'true'); localStorage.setItem('boxyard:voice', JSON.stringify({ enabled: false })); localStorage.setItem('boxyard:show-tool-calls', '1') })
    const page = await ctx.newPage(), errors = [], writes = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.setDefaultTimeout(10000)
    await page.route('**/api/agent-settings', (r) => r.fulfill({ json: { ...settings, settings: { ...settings.settings, agentAutoCompact: { enabled: false, unit: 'tokens', value: 250000 } } } }))
    await page.route('**/api/tasks', (r) => r.fulfill({ json: [task] }))
    await page.route('**/api/chat', (r) => r.fulfill({ json: [] }))
    await page.route('**/api/artifacts', (r) => r.fulfill({ json: files }))
    await page.route('**/api/tasks/*/messages*', (r) => r.fulfill({ json: messages }))
    await page.route('**/api/tasks/*/queue', (r) => r.fulfill({ json: [] }))
    await page.route('**/api/tasks/*', (r) => (r.request().url().endsWith(task.id) ? r.fulfill({ json: task }) : r.fallback()))
    await page.route('**/api/**', (r) => {
      if (r.request().method() !== 'GET') { writes.push(r.request().url()); return r.abort() }
      if (r.request().url().endsWith('/stream')) return r.abort()
      return r.fallback()
    })
    await page.goto(`${base}/?session=${task.id}`)
    const session = page.getByRole('dialog').first()
    await session.getByText(task.title, { exact: true }).first().waitFor()
    await session.getByRole('button', { name: 'Task details and more actions', exact: true }).waitFor()
    if (files.length) await session.getByText('247 files', { exact: true }).waitFor()
    // Nothing is focused on purpose: a phone opens this with a tap, which shows no focus ring.
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
    await page.waitForTimeout(150)
    const check = { scenario, w, h, zoom }
    if (after) {
      const header = session.getByTestId('task-header')
      const hb = await header.boundingBox()
      check.headerHeight = Math.round(hb.height * zoom)
      const heading = await session.getByRole('heading', { name: task.title }).boundingBox()
      const status = await session.locator(`[data-status="${task.status}"]`).boundingBox()
      assert(status.y >= heading.y + heading.height - 1 && status.y - (heading.y + heading.height) < 24, `Status sits directly below the title (${name})`)
      assert.equal(await header.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false, `Header doesn't overflow (${name})`)
      assert.equal(await session.locator('textarea').count(), 1, 'Full conversation keeps a follow-up composer')
      assert.equal(await session.getByRole('button', { name: 'Compact', exact: true }).count(), 0, 'No manual Compact control')
      assert.equal(await session.getByText('Show tool calls', { exact: true }).count(), 0, 'No tool-call control')
      assert.equal(await session.getByText('hidden_tool_marker', { exact: true }).count(), 0, 'An old saved toggle cannot reveal tool calls')
      assert.equal(await session.locator('[data-testid=context-mini],[role=meter]').count(), 0, 'No context-progress bar')
      // Every header control is a 44px target to a finger: probe 21px above and below its centre.
      const controls = [session.getByRole('button', { name: 'Back', exact: true }), session.getByRole('button', { name: 'Task details and more actions', exact: true })]
      assert.equal(await header.getByRole('button', { name: /stop/i }).count(), 0, `No Stop in the header (${name})`)
      assert.equal(await header.getByText('Stop', { exact: true }).count(), 0, `No Stop beside the state (${name})`)
      if (task.prUrl) controls.push(session.locator('[data-pr-state]'))
      if (task.previews.length) controls.push(session.getByTestId('preview-chip'))
      if (files.length) controls.push(session.getByRole('button', { name: /^247 files/ }))
      // The newest reply's next steps are drawn small but stacked far enough apart to keep 44px targets.
      for (const step of await session.getByRole('group', { name: 'Recommended next steps' }).getByRole('button').all()) controls.push(step)
      for (const c of controls) {
        const b = await c.boundingBox()
        assert(b.x >= 0 && b.x + b.width <= w / zoom + 1, `Control fits the viewport (${name})`)
        if (!touch) continue
        for (const dy of [-21, 21]) {
          const hit = await c.evaluate((el, [x, y]) => { const t = document.elementFromPoint(x, y); return !!t && (el === t || el.contains(t)) }, [b.x + b.width / 2, b.y + b.height / 2 + dy])
          assert(hit, `44px target: ${await c.evaluate((el) => el.getAttribute('aria-label') || el.textContent)} at ${dy} (${name})`)
        }
      }
      if (task.previews.length) {
        const pv = await session.getByTestId('preview-chip').evaluate((el) => getComputedStyle(el).backgroundColor)
        assert.notEqual(pv, 'rgba(0, 0, 0, 0)', 'Preview is a filled, prominent action')
      }
      await page.screenshot({ path: `${out}/session-${name}.png` })
      // Sticky: the header stays put while the transcript scrolls.
      const before = (await header.boundingBox()).y
      const thread = await session.getByText('Checked at 125% zoom', { exact: false }).last().boundingBox()
      await page.mouse.move(thread.x + 10, thread.y + 5)
      await page.mouse.wheel(0, -2000)
      await page.waitForTimeout(100)
      assert.equal(Math.round((await header.boundingBox()).y), Math.round(before), 'Header stays at the top while the transcript scrolls')
    }
    if (!after) await page.screenshot({ path: `${out}/session-${name}.png` })
    if (after && scenario !== 'main') {
      // A resting task's ⓘ details have nothing to stop.
      await session.getByRole('button', { name: 'Task details and more actions', exact: true }).click()
      const details = page.getByRole('dialog', { name: 'Task details', exact: true })
      await details.getByRole('button', { name: /^Delete task/ }).waitFor()
      assert.equal(await details.getByRole('button', { name: 'Stop task', exact: true }).count(), 0, `No Stop in ⓘ while ${task.status} (${name})`)
      await page.keyboard.press('Escape')
    }
    if (scenario === 'main') {
      await session.getByRole('button', { name: 'Task details and more actions', exact: true }).click()
      // An older build names its details sheet differently: take whichever dialog opened over the session.
      const details = after ? page.getByRole('dialog', { name: 'Task details', exact: true }) : page.getByRole('dialog').last()
      await details.waitFor()
      await page.waitForTimeout(150)
      const b = await details.boundingBox()
      const vp = page.viewportSize()
      check.detailsFit = b.x >= 0 && b.y >= 0 && b.x + b.width <= vp.width + 1 && b.y + b.height <= vp.height + 1
      await page.screenshot({ path: `${out}/details-${name}.png` })
      if (after) {
        // Running: a red Stop task, last but Delete, a 44px row to a finger. Scrolled to, for the shot.
        const stop = details.getByRole('button', { name: 'Stop task', exact: true })
        await stop.scrollIntoViewIfNeeded()
        await page.waitForTimeout(100)
        const color = (l) => l.evaluate((el) => getComputedStyle(el).color)
        const del = details.getByRole('button', { name: /^Delete task/ })
        assert.equal(await color(stop), await color(del), `Stop task is red like Delete (${name})`)
        assert.notEqual(await color(stop), await color(details.getByRole('button', { name: 'Show its card', exact: true })), `Stop task isn't a plain row (${name})`)
        const rows = await details.getByRole('button').evaluateAll((els) => els.map((el) => el.textContent.trim()))
        assert.deepEqual(rows.slice(-2), ['Stop task', 'Delete task…'], `Stop task sits with Delete (${name})`)
        const sb = await stop.boundingBox()
        if (touch) assert(sb.height >= 43.5, `Stop task is 44px (${name})`)
        check.stopItem = Math.round(sb.height)
        await page.screenshot({ path: `${out}/stop-${name}.png` })
        assert(check.detailsFit, `Details clipped at ${name}: ${JSON.stringify(b)}`)
        assert.equal(await details.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false)
        await page.keyboard.press('Escape')
        assert.equal(await details.count(), 0, 'Escape closes only details')
        assert.equal(await session.count(), 1, 'Parent session stays open')
        assert.equal(await session.getByRole('button', { name: 'Task details and more actions', exact: true }).evaluate((el) => el === document.activeElement), true, 'Focus returns to ⓘ')
        // Where it runs is only in ⓘ, never in the header.
        assert.equal(await session.getByTestId('task-header').getByTestId('task-placement').count(), 0, `No runner chip in the header (${name})`)
      }
    }
    assert.equal(errors.length, 0, JSON.stringify(errors))
    assert.equal(writes.length, 0, JSON.stringify(writes))
    checks.push(check)
    console.log(`${phase}: ${name}`, JSON.stringify(check))
    await ctx.close()
  }
} finally {
  await browser.close()
}
await fs.writeFile(`${out}/checks.json`, JSON.stringify(checks, null, 2))
