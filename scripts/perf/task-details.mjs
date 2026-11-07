// Mock-only before/after screenshots and geometry checks for the task's ⓘ modal.
// PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROMIUM_PATH=/path/to/chrome \
//   node scripts/perf/task-details.mjs http://localhost:4000 before /tmp/task-details-shots
// Repeat with `after` against the changed build. API writes and SSE are blocked.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const [base = 'http://localhost:4000', phase = 'after', out = '/tmp/task-details-shots'] = process.argv.slice(2)
assert(['before', 'after'].includes(phase))
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Use an isolated mock server')
assert.equal((await (await fetch(`${base}/api/health`)).json()).mock, true)
const [settings, projects, tasks, identities] = await Promise.all(['agent-settings', 'projects', 'tasks', 'identities'].map(async (p) => (await fetch(`${base}/api/${p}`)).json()))
assert(projects[0] && tasks[0], 'Seed a project and task in mock mode first')
const now = Date.now()
const project = { ...projects[0], name: 'Workbench', identityId: identities[0].id, runner: 'box' }
const identity = { ...identities[0], name: 'Personal', githubLogin: 'webdevcody' }
const task = {
  ...tasks[0], id: 'task_details-demo', projectId: project.id,
  title: 'Improve task navigation and preview environments on phones',
  status: 'working', agentCli: 'claude', branch: '382-task-info-modal-wider-and-easier-to-scan',
  boxId: 'pure-lobster-27426', runsOn: 'box', previews: [], prUrl: null, prState: null,
  model: 'claude-opus-5-5', effort: 'high', turnCount: 8, pendingCount: 0,
  routingRule: 'phone-first-ux', routingReason: 'Use the project’s agent for interface work. Check narrow panels, long branch names and touch targets.',
  createdAt: now - 3_600_000, updatedAt: now - 120_000, scheduleId: 'sch_details-demo',
  pushState: { status: 'pushed', at: now - 180_000, branch: '382-task-info-modal-wider-and-easier-to-scan', head: 'abc1234', wip: null, reason: null },
  placement: { now: { kind: 'box', boxId: 'pure-lobster-27426', provider: 'upstash', size: 'small', how: 'new' }, last: null, runner: 'box', chosenBy: 'task', projectRunner: 'box' },
}
const runs = [320, 400, 560, 800].flatMap((w) => [1, 1.25].map((zoom) => ({ w, zoom, local: false })))
runs.push({ w: 1040, zoom: 1, local: false }, { w: 400, zoom: 1, local: true }, { w: 800, zoom: 1, local: true })
await fs.mkdir(out, { recursive: true })
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--mute-audio'] })
const checks = []
try {
  for (const { w, zoom, local } of runs) {
    const name = `${phase}-${local ? 'local-' : ''}${w}-${zoom * 100}`
    // Smaller CSS viewport + matching device scale reproduces browser zoom and keeps PNG dimensions fixed.
    const ctx = await browser.newContext({ viewport: { width: Math.round(w / zoom), height: Math.round(900 / zoom) }, deviceScaleFactor: zoom, hasTouch: true, isMobile: true, reducedMotion: 'reduce' })
    await ctx.addInitScript(() => { localStorage.setItem('box-yard:setup-skipped', 'true') })
    const page = await ctx.newPage(), errors = [], writes = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.setDefaultTimeout(10_000)
    const t = local ? { ...task, boxId: 'this-computer', runsOn: 'local', placement: { ...task.placement, now: { kind: 'local', boxId: 'this-computer' }, runner: 'local' } } : task
    await page.route('**/api/**', async (r) => {
      const path = new URL(r.request().url()).pathname
      if (r.request().method() !== 'GET') { writes.push(path); return r.abort() }
      if (path === '/api/stream' || path === '/api/boot') return r.abort()
      const json = {
        '/api/agent-settings': settings, '/api/projects': [project], '/api/tasks': [t], '/api/identities': [identity],
        '/api/chat': [], '/api/artifacts': [], '/api/schedules': [{ id: t.scheduleId, projectId: project.id, name: 'Daily interface review' }],
        [`/api/projects/${project.id}`]: project, [`/api/tasks/${t.id}`]: t,
        [`/api/tasks/${t.id}/messages`]: [], [`/api/tasks/${t.id}/queue`]: [],
      }[path]
      return json === undefined ? r.fallback() : r.fulfill({ json })
    })
    await page.goto(`${base}/?session=${t.id}`)
    const trigger = page.getByRole('button', { name: 'Task details and more actions', exact: true })
    await trigger.click()
    const details = page.getByRole('dialog', { name: 'Task details', exact: true })
    await details.getByTestId('task-identity').waitFor()
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(() => document.activeElement?.blur())
    const geometry = await details.evaluate((el) => {
      const b = el.getBoundingClientRect(), body = el.children[1]
      const group = el.querySelector('section[aria-label="Task"]')
      const columns = group ? getComputedStyle(group.parentElement).gridTemplateColumns.split(' ').length : 1
      return { columns, width: b.width, height: b.height, x: b.x, y: b.y, bodyHeight: body.clientHeight, contentHeight: body.scrollHeight, overflow: el.scrollWidth > el.clientWidth + 1 }
    })
    assert(geometry.x >= 0 && geometry.y >= 0 && geometry.x + geometry.width <= page.viewportSize().width + 1 && geometry.y + geometry.height <= page.viewportSize().height + 1, `Modal fits: ${name}`)
    assert(!geometry.overflow, `No horizontal overflow: ${name}`)
    console.log(name, JSON.stringify(geometry))
    await page.screenshot({ path: `${out}/${name}.png` })
    const del = details.getByRole('button', { name: 'Delete task…', exact: true })
    await del.scrollIntoViewIfNeeded()
    if (w === 800 && zoom === 1 && !local) await page.screenshot({ path: `${out}/${name}-actions.png` })
    if (phase === 'after') {
      assert.equal(geometry.columns, geometry.width - 42 >= 544 ? 2 : 1, `Columns follow modal width: ${name}`)
      for (const label of ['Task', 'Agent', 'Runner', 'Actions']) assert.equal(await details.getByRole('heading', { name: label, exact: true }).count(), 1, `Group ${label}`)
      for (const b of await details.getByRole('button').all()) {
        const box = await b.boundingBox()
        assert(box.height >= 43.5 && box.width >= 43.5, `44px target: ${await b.getAttribute('aria-label') ?? await b.textContent()} (${name})`)
      }
      // Copy remains wired to the right values after moving between groups.
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'])
      for (const [label, expected] of [['Copy task id', t.id], ['Copy task link', `${base}/?session=${t.id}`], ['Copy branch name', t.branch]]) {
        await details.getByRole('button', { name: label, exact: true }).click()
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected)
      }
      await details.getByRole('button', { name: 'Open a port…', exact: true }).click()
      await details.getByRole('textbox', { name: 'Port', exact: true }).fill('4000')
      const port = await details.getByRole('textbox', { name: 'Port', exact: true }).boundingBox()
      assert(port.height >= 43.5 && port.x + port.width <= page.viewportSize().width, `Port input fits: ${name}`)
      await page.keyboard.press('Escape')
      assert.equal(await details.count(), 0, 'Escape closes details')
      assert(await trigger.evaluate((el) => el === document.activeElement), 'Focus returns to ⓘ')
      assert.equal(await page.getByRole('dialog').count(), 1, 'Task conversation stays open')
    }
    assert.deepEqual(errors, [], 'No browser errors')
    assert.deepEqual(writes, [], 'No API writes')
    checks.push({ name, w, zoom, ...geometry })
    await ctx.close()
  }
} finally {
  await browser.close()
}
await fs.writeFile(`${out}/${phase}-checks.json`, JSON.stringify(checks, null, 2))
