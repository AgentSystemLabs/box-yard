#!/usr/bin/env node
// Several ask_user questions on a phone, against an isolated mock server: the task's ask form at 320, 400, 560 and
// 800 px, each at 100% and 125% zoom, then answered from the keyboard and sent as one message.
//   npm run build
//   PORT=4470 BOXYARD_MOCK=1 BOXYARD_DATA_DIR=/tmp/ask-yard node dist/server/server/index.js
//   PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROMIUM_PATH=/path/to/chrome \
//     node scripts/perf/ask-questions.mjs http://localhost:4470 /tmp/ask-shots
// It starts one task whose fake agent asks three questions ([asks] in scripts/fake-claude.mjs). Every width checks the
// 44px targets on touch screens, that nothing scrolls sideways or is cut off, and that the card takes no focus on its own.
// Then phones, short ones included, dark and light: the question, Back and Next in the chat's view and not covered (no
// "Jump to latest" over them) as the task opens and after each tap on Next and Back, and 16px text in the answer box.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const [base = 'http://localhost:4470', out = '/tmp/ask-shots'] = process.argv.slice(2)
assert.equal((await (await fetch(`${base}/api/health`)).json()).mock, true, 'Run this against a mock server (BOXYARD_MOCK=1)')

const api = async (path, body) => {
  const res = await fetch(`${base}/api${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}
const project = (await api('/projects')).find((p) => p.name === 'example-settings') ?? (await api('/projects', { name: 'example-settings', runner: 'local' }))
const created = await api('/tasks', { projectId: project.id, title: 'Settings page', prompt: '[asks] Build the settings page.' })
let task
for (const t0 = Date.now(); Date.now() - t0 < 90_000; await new Promise((r) => setTimeout(r, 500))) {
  task = await api(`/tasks/${created.id}`)
  if (task.status === 'needs_input' && task.questions?.length === 3) break
}
assert.equal(task.status, 'needs_input', `the fake agent should end its turn asking (got ${task.status})`)
console.log(`${task.id} asks ${task.questions.length} questions`)

await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--mute-audio'] })
const results = []
const open = async (physical, zoom, touch, { height = 900, colorScheme = 'dark' } = {}) => {
  const context = await browser.newContext({
    viewport: { width: Math.round(physical / zoom), height: Math.round(height / zoom) },
    deviceScaleFactor: zoom * 2,
    isMobile: touch,
    hasTouch: touch,
    reducedMotion: 'reduce',
    colorScheme,
  })
  await context.addInitScript(() => {
    localStorage.setItem('box-yard:setup-skipped', 'true')
    localStorage.setItem('boxyard:voice', JSON.stringify({ enabled: false }))
    localStorage.setItem('boxyard:send-sound', JSON.stringify({ enabled: false }))
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.setDefaultTimeout(15_000)
  await page.goto(`${base}/?session=${task.id}`)
  const card = page.getByTestId('pending-ask')
  await card.getByTestId('ask-question').waitFor()
  // As opened: the chat sticks to its end, where the card is. No scrolling of our own (that would float Jump to latest).
  await page.waitForTimeout(400)
  return { context, page, card, errors }
}
/**
 * Each control's box, whether it's on screen as the task opens and, if so, whether something else covers its middle;
 * and the page's sideways overflow. A card taller than the screen has its first rows above it, a scroll away.
 */
const measure = (page) =>
  page.evaluate(() => {
    const card = document.querySelector('[data-testid=pending-ask]')
    const controls = [...card.querySelectorAll('[data-testid=ask-choice], [data-testid=ask-custom], button')].map((el) => {
      const r = el.getBoundingClientRect()
      const onScreen = r.top >= 0 && r.bottom <= innerHeight
      const hit = onScreen ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null
      const covered = onScreen && !(hit === el || el.contains(hit))
      return { what: el.dataset.testid ?? el.textContent, width: Math.round(r.width), height: Math.round(r.height), onScreen, clipped: r.left < 0 || r.right > innerWidth + 0.5, covered, ...(covered && { by: `${hit?.tagName}.${String(hit?.className).slice(0, 60)}` }) }
    })
    return { controls, overflow: document.documentElement.scrollWidth - innerWidth, focusInCard: card.contains(document.activeElement) }
  })

try {
  for (const physical of [320, 400, 560, 800])
    for (const zoom of [1, 1.25]) {
      const touch = physical < 560
      const { context, page, card, errors } = await open(physical, zoom, touch)
      try {
        const m = await measure(page)
        const small = touch ? m.controls.filter((c) => c.height < 44 || c.width < 44) : []
        const bad = m.controls.filter((c) => c.clipped || c.covered)
        results.push({ physical, zoom, touch, ...m, small, bad, errors })
        console.log(`${physical}px at ${zoom * 100}%${touch ? ' (touch)' : ''}: ${m.controls.length} controls, ${small.length} under 44px, ${bad.length} clipped or covered, overflow ${m.overflow}px`)
        assert.deepEqual(small, [], `${physical}px: touch targets under 44px`)
        assert.deepEqual(bad, [], `${physical}px: controls clipped or covered`)
        const nav = m.controls.filter((c) => /^ask-(back|next|send)$/.test(c.what))
        assert(nav.length === 2 && nav.every((c) => c.onScreen), `${physical}px: Back and Next must be on screen as the task opens`)
        assert(m.overflow <= 0, `${physical}px: the page scrolls sideways`)
        assert(!m.focusInCard, 'the card must not take the focus on its own')
        // The screen as opened (an element screenshot would scroll the chat itself and float Jump to latest).
        await page.screenshot({ path: `${out}/ask-${physical}-${zoom * 100}.png` })
        if (physical === 400 && zoom === 1) {
          // Step 2 with an answer of one's own typed, on a phone.
          await card.getByTestId('ask-next').tap()
          await card.getByTestId('ask-custom').fill('A box of its own, in eu-west')
          await page.screenshot({ path: `${out}/ask-${physical}-step2-custom.png` })
        }
        assert.deepEqual(errors, [])
      } finally {
        await context.close()
      }
    }

  // Phones, as tall as their screens: a short one's chat is shorter than the card, which then shows from its top.
  const phone = (page) =>
    page.evaluate(() => {
      const card = document.querySelector('[data-testid=pending-ask]')
      const list = card.closest('[data-scroller]').getBoundingClientRect()
      const inView = (el) => {
        const r = el.getBoundingClientRect()
        return r.top >= list.top - 0.5 && r.bottom <= list.bottom + 0.5
      }
      const usable = (el) => {
        const r = el.getBoundingClientRect()
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        return inView(el) && (hit === el || el.contains(hit))
      }
      return {
        chat: Math.round(list.height),
        card: Math.round(card.getBoundingClientRect().height),
        step: card.querySelector('[data-testid=ask-progress]').textContent,
        question: inView(card.querySelector('legend')),
        back: usable(card.querySelector('[data-testid=ask-back]')),
        next: usable(card.querySelector('[data-testid=ask-next], [data-testid=ask-send]')),
        jump: document.querySelector('[data-jump]') !== null,
        inputFont: parseFloat(getComputedStyle(card.querySelector('[data-testid=ask-custom]')).fontSize),
      }
    })
  for (const [name, width, height] of [['320x568', 320, 568], ['375x667', 375, 667], ['390x664', 390, 664], ['412x839', 412, 839]])
    for (const colorScheme of ['dark', 'light']) {
      const { context, page, card, errors } = await open(width, 1, true, { height, colorScheme })
      try {
        const seen = { open: await phone(page) }
        await page.screenshot({ path: `${out}/phone-${name}-${colorScheme}-open.png` })
        await card.getByTestId('ask-choice').nth(1).tap()
        await card.getByTestId('ask-next').tap()
        await page.waitForTimeout(300)
        seen.next = await phone(page)
        await page.screenshot({ path: `${out}/phone-${name}-${colorScheme}-next.png` })
        await card.getByTestId('ask-back').tap()
        await page.waitForTimeout(300)
        seen.back = await phone(page)
        results.push({ phone: name, colorScheme, ...seen })
        console.log(`${name} ${colorScheme}: chat ${seen.open.chat}px, card ${seen.open.card}px`)
        for (const [when, m] of Object.entries(seen)) {
          assert(m.question && m.back && m.next, `${name} ${colorScheme}, ${when}: the question, Back and Next in view and uncovered (${JSON.stringify(m)})`)
          assert(!m.jump, `${name} ${colorScheme}, ${when}: Jump to latest over the card`)
          assert(m.inputFont >= 16, `${name}: the answer box's text under 16px makes iOS zoom in`)
        }
        assert.deepEqual([seen.open.step, seen.next.step, seen.back.step], ['1 of 3', '2 of 3', '1 of 3'])
        assert.deepEqual(errors, [])
      } finally {
        await context.close()
      }
    }

  // The keyboard, on a desktop width: number keys pick, Enter goes on, Shift+Enter goes back, the last Enter sends.
  const { context, page, card, errors } = await open(800, 1, false)
  try {
    const progress = () => card.getByTestId('ask-progress').textContent()
    // The progress the 400px run left (step 2, typed) is that tab's memory only: a new tab starts at 1.
    assert.equal(await progress(), '1 of 3')
    await card.locator('input[type=radio]').first().focus()
    await page.keyboard.press('2')
    assert.equal(await page.evaluate(() => document.activeElement?.value), '1', '2 picks the second choice and focuses it')
    await page.keyboard.press('Enter')
    assert.equal(await progress(), '2 of 3')
    await page.keyboard.press('Shift+Enter')
    assert.equal(await progress(), '1 of 3')
    assert(await card.locator('input[type=radio]').nth(1).isChecked(), 'Back keeps the answer')
    await page.keyboard.press('Enter')
    await page.keyboard.press('2')
    await page.keyboard.press('Enter')
    assert.equal(await progress(), '3 of 3')
    await page.keyboard.press('2')
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.testid), 'ask-custom')
    await page.keyboard.type('settings-api')
    await card.screenshot({ path: `${out}/ask-800-last-step.png` })
    const sent = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/tasks/${task.id}/answers`))
    await page.keyboard.press('Enter')
    assert.equal((await sent).status(), 200)
    await page.getByText('My answers to your 3 questions').last().waitFor()
    // Delivered: the fake agent's next turn has it.
    await page.locator('[aria-busy=true]').first().waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {})
    await page.screenshot({ path: `${out}/ask-800-sent.png` })
    const message = (await api(`/tasks/${task.id}/messages`)).filter((m) => m.role === 'user').at(-1)?.content
    console.log(`sent:\n${message}`)
    assert.match(message, /1\. Which database should it use\?\n {3}- SQLite\n2\. Where should it deploy\?\n {3}- Render\n3\. What should the service be called\?\n {3}- settings-api \(my own answer\)/)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
} finally {
  await browser.close()
}
await fs.writeFile(`${out}/checks.json`, JSON.stringify(results, null, 2))
console.log(`screenshots and checks.json in ${out}`)
