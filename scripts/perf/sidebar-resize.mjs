#!/usr/bin/env node
// Real-browser checks of the resizable left sidebar (components/SidebarPane.tsx), against a seeded mock yard.
// PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROMIUM_PATH=/path/to/chrome \
//   node scripts/perf/sidebar-resize.mjs http://localhost:4001 /tmp/sidebar-resize
// Asserts, with real mouse and keyboard input:
// - the column starts at 256px; a mouse drag on its right edge widens it, stops at 200 and 480px, and is saved;
// - a reload comes back at the saved width; a double-click on the edge (or Enter) resets it and forgets the save;
// - arrow keys resize it from the focused edge; the centre's draft survives a drag;
// - a narrower window squeezes the column so the chat keeps 320px, without overwriting the saved width;
// - the folded rail and the phone drawer have no handle, and unfolding brings back the saved width.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const [base = 'http://localhost:4001', out = '/tmp/sidebar-resize'] = process.argv.slice(2)
assert.equal((await (await fetch(`${base}/api/health`)).json()).mock, true)
await fs.mkdir(out, { recursive: true })

const KEY = 'box-yard:sidebar-width'
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` })
const sidebar = page.getByTestId('sidebar')
const handle = sidebar.getByRole('separator', { name: 'Sidebar width' })
const width = async () => Math.round((await sidebar.boundingBox()).width)
const saved = () => page.evaluate((k) => localStorage.getItem(k), KEY)
async function drag(dx) {
  const box = await handle.boundingBox()
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y, { steps: 4 })
  await page.mouse.move(x + dx, y, { steps: 4 })
  await page.mouse.up()
}
const checks = []
const ok = (name) => (checks.push(name), console.log(`✓ ${name}`))

await page.goto(`${base}/`)
await page.evaluate((k) => localStorage.removeItem(k), KEY)
await page.reload()
await handle.waitFor()
// The border sits at the column's right edge (+1px for the border line).
assert.equal(await width(), 256)
assert.equal(await handle.getAttribute('aria-valuenow'), '256')
await shot('desktop-1440-default')
ok('the column starts at 256px with a named, visible edge handle')

const composer = page.locator('textarea').first()
await composer.fill('A draft that must survive the drag')
await drag(120)
assert.equal(await width(), 376)
assert.equal(await saved(), '376')
assert.equal(await composer.inputValue(), 'A draft that must survive the drag')
await shot('desktop-1440-dragged-376')
ok('a mouse drag widens it to 376px, saves it, and keeps the centre draft')

await drag(1000)
assert.equal(await width(), 480)
await drag(-1000)
assert.equal(await width(), 200)
assert.equal(await saved(), '200')
ok('a drag stops at 480px and at 200px')

await drag(160)
assert.equal(await width(), 360)
await page.reload()
await handle.waitFor()
assert.equal(await width(), 360)
ok('a reload comes back at the saved 360px')

await handle.dblclick()
assert.equal(await width(), 256)
assert.equal(await saved(), null)
ok('a double-click resets it to 256px and forgets the saved width')

await handle.focus()
await page.keyboard.press('ArrowRight')
assert.equal(await width(), 266)
await page.keyboard.press('Shift+ArrowRight')
assert.equal(await width(), 316)
assert.equal(await saved(), '316')
await page.keyboard.press('ArrowLeft')
assert.equal(await width(), 306)
await page.keyboard.press('End')
assert.equal(await width(), 480)
await page.keyboard.press('Enter')
assert.equal(await width(), 256)
assert.equal(await saved(), null)
ok('the focused edge resizes with arrow keys (Shift for 50px), End jumps to the max and Enter resets')

await drag(1000)
assert.equal(await saved(), '480')
await page.setViewportSize({ width: 780, height: 900 })
await page.waitForFunction(() => document.querySelector('[data-testid=sidebar] [role=separator]')?.getAttribute('aria-valuemax') === '460')
assert.equal(await width(), 460)
const centre = await sidebar.evaluate((el) => el.nextElementSibling.getBoundingClientRect().width)
assert.equal(Math.round(centre), 320)
assert.equal(await saved(), '480')
await shot('desktop-780-clamped')
await page.setViewportSize({ width: 1440, height: 900 })
await page.waitForFunction(() => document.querySelector('[data-testid=sidebar] [role=separator]')?.getAttribute('aria-valuemax') === '480')
assert.equal(await width(), 480)
ok('at 780px the column shrinks to 460px so the chat keeps 320px; the saved 480px returns when the window widens')

await sidebar.getByRole('button', { name: 'Fold the sidebar' }).click()
assert.equal(await width(), 56)
assert.equal(await sidebar.getByRole('separator').count(), 0)
await shot('desktop-1440-rail')
await sidebar.getByRole('button', { name: 'Show the sidebar' }).click()
await handle.waitFor()
assert.equal(await width(), 480)
ok('the folded rail is 56px with no handle; unfolding brings back the saved width')

await handle.dblclick()
await drag(64)
assert.equal(await width(), 320)
await shot('desktop-1440-final-320')

await page.setViewportSize({ width: 393, height: 852 })
await page.waitForFunction(() => !document.querySelector('[data-testid=sidebar]'))
await shot('phone-393-chat')
await page.getByRole('button', { name: /^Projects and tasks/ }).first().click()
const drawer = page.getByRole('dialog', { name: 'Projects and tasks' })
await drawer.waitFor()
await page.waitForTimeout(400)
assert.equal(await drawer.getByRole('separator').count(), 0)
await shot('phone-393-drawer')
ok('on a phone there is no column, and the drawer has no handle')

await browser.close()
console.log(`\n${checks.length} checks passed; screenshots in ${out}`)
