// Real mouse/touch proof against an isolated mock yard; every DELETE is intercepted with example fixtures.
// npm run build
// PORT=4520 BOXYARD_MOCK=1 BOXYARD_DATA_DIR=/tmp/example-sidebar-delete node dist/server/server/index.js
// PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROME_PATH=/path/to/chrome \
//   node scripts/check-sidebar-delete.mjs http://localhost:4520 /tmp/example-sidebar-delete/shots
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
const base = process.argv[2] ?? "http://localhost:4520"
assert.match(base, /^http:\/\/(localhost|127\.0\.0\.1):452[0-9]$/, "Use an isolated mock server on 4520–4529")
assert.equal((await (await fetch(`${base}/api/health`)).json()).mock, true)
const out = path.resolve(process.argv[3] ?? "/tmp/example-sidebar-delete/shots")
await mkdir(out, { recursive: true })
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright-core")
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH })
const now = Date.now()
const project = { id: "prj_example", name: "Example release", repo: null, description: "", notes: [], envKeys: [], baseBranch: "main", runner: "box", identityId: "idn_default", gpuMachine: { gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null }, docker: { image: null, dockerfile: null }, createdAt: now, color: null }
const task = (id, title, extra = {}) => ({ id, projectId: project.id, title, status: "idle", prompt: "", prUrl: null, prState: null, prMergedAt: null, previews: [], waitFor: [], question: null, error: null, scheduleId: null, outcome: null, turnCount: 1, pendingCount: 0, turnStartedAt: null, parentTaskId: null, createdAt: now - 60_000, updatedAt: now - 60_000, ...extra })
const tasks = Array.from({ length: 13 }, (_, i) => task(`task_level${String(i).padStart(2, "0")}`, i ? `Review example step ${i}` : "Plan the example release", { parentTaskId: i ? `task_level${String(i - 1).padStart(2, "0")}` : null }))
tasks.push(...Array.from({ length: 20 }, (_, i) => task(`task_extra${String(i).padStart(2, "0")}`, `Example follow-up ${i + 1}`)))
const results = []
const errors = []
try {
  for (const width of [320, 400, 560, 800, 1600]) for (const zoom of [1, 1.25]) for (const touch of [true, false]) {
    const tag = `${width}-${zoom * 100}-${touch ? "touch" : "mouse"}`
    if (process.env.SIDEBAR_CASE && process.env.SIDEBAR_CASE !== tag) continue
    const context = await browser.newContext({ viewport: { width: Math.floor(width / zoom), height: 850 }, deviceScaleFactor: zoom, hasTouch: touch, colorScheme: "dark" })
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    page.setDefaultTimeout(6000)
    page.on("pageerror", (e) => errors.push(`${tag}: ${e.message}`))
    let deletes = 0
    await page.route("**/api/**", async (route) => {
      const p = new URL(route.request().url()).pathname
      if (p === "/api/boot" || p === "/api/stream") return route.abort()
      if (route.request().method() === "DELETE") {
        assert.equal(new URL(route.request().url()).searchParams.get("ifResting"), "1")
        assert.equal(p, `/api/tasks/${tasks[12].id}`)
        deletes++
        return route.fulfill({ json: { ok: true } })
      }
      let data
      if (p === "/api/tasks") data = tasks
      else if (p === "/api/projects") data = [project]
      else if (p.endsWith("/captain")) data = { projectId: project.id, busy: false, sessionId: null, pendingCount: 0, error: null, usage: { tokens: 0, window: 200000, updatedAt: now } }
      else if (/\/(messages|compactions|queue)$/.test(p)) data = []
      else if (p.startsWith("/api/tasks/")) data = []
      else if (p === "/api/me") data = { authed: true, authRequired: false }
      else return route.continue()
      return route.fulfill({ json: data })
    })
    await page.goto(base)
    await page.locator('textarea').first().waitFor()
    const menu = page.locator('button[title="Projects and tasks"]').last()
    if (await menu.isVisible()) await menu.click()
    const tree = page.locator('[role="tree"][aria-label="Projects and tasks"]')
    await tree.waitFor()
    const parent = tree.locator('[data-tree-key="task:task_level00@project"]')
    const leaf = tree.locator('[data-tree-key="task:task_level12@project"]')
    const action = () => tree.locator('[data-sidebar-delete]')
    async function drag(row, dx, dy = 0) {
      await row.scrollIntoViewIfNeeded()
      const box = await row.locator('[data-tree-open]').boundingBox()
      const x = box.x + box.width - 12
      const y = box.y + Math.min(16, box.height / 2)
      if (touch) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
        for (let i = 1; i <= 6; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx * i / 6, y: y + dy * i / 6 }] })
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
      } else {
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x + dx, y + dy, { steps: 6 })
        await page.mouse.up()
      }
    }
    if (tag === "400-100-touch") await page.screenshot({ path: `${out}/before-${tag}.png` })
    await drag(parent, -72)
    await action().waitFor()
    assert.equal(await action().innerText(), "Delete", `${tag}: clearly labelled`)
    assert.equal(await page.getByRole('dialog', { name: 'Delete task?', exact: true }).count(), 0)
    assert.equal(new URL(page.url()).searchParams.get("session"), null, `${tag}: swipe must not navigate`)
    assert.equal(await leaf.count(), 1, `${tag}: swipe must not fold`)
    assert.equal(deletes, 0, `${tag}: swipe must not delete`)
    if (tag === "400-100-touch") await page.screenshot({ path: `${out}/task-reveal-${tag}.png` })
    await page.keyboard.press("Escape")
    await action().waitFor({ state: "detached" })
    const projectRow = tree.locator(`[data-tree-key="captain:${project.id}"]`)
    await drag(projectRow, -72)
    await action().waitFor()
    assert.equal(await action().isEnabled(), true, `${tag}: resting project is deletable`)
    if (tag === "400-100-touch") await page.screenshot({ path: `${out}/project-reveal-${tag}.png` })
    await drag(projectRow, 72)
    await action().waitFor({ state: "detached" })
    // Native vertical scrolling, then a sideways tail: once vertical, it remains scrolling.
    const scrollBox = await parent.evaluate((el) => { for (let p = el.parentElement; p; p = p.parentElement) if (getComputedStyle(p).overflowY === "auto") return { top: p.scrollTop, height: p.clientHeight, total: p.scrollHeight }; return null })
    await drag(parent, -10, -90)
    assert.equal(await action().count(), 0, `${tag}: vertical drag must not reveal`)
    if (touch) {
      const after = await parent.evaluate((el) => { for (let p = el.parentElement; p; p = p.parentElement) if (getComputedStyle(p).overflowY === "auto") return p.scrollTop; return 0 })
      assert.ok(after > scrollBox.top, `${tag}: native vertical scrolling stays available`)
    }
    // Wait for native touch inertia before bringing the row back and starting the keyboard check.
    await parent.evaluate(async (el) => {
      let scroller = el.parentElement
      while (scroller && getComputedStyle(scroller).overflowY !== "auto") scroller = scroller.parentElement
      if (!scroller) return
      await new Promise((resolve) => {
        let previous = scroller.scrollTop, stable = 0
        const frame = () => {
          const next = scroller.scrollTop
          stable = Math.abs(next - previous) < 0.1 ? stable + 1 : 0
          previous = next
          if (stable >= 10) resolve()
          else requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      })
    })
    await parent.scrollIntoViewIfNeeded()
    await parent.focus()
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.keyboard.press("Shift+F10")
    await action().waitFor()
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-sidebar-delete"))
    await page.keyboard.press("Escape")
    assert.equal(await parent.evaluate((el) => el === document.activeElement), true)
    await page.keyboard.press("ArrowRight")
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-tree-key")), "task:task_level01@project")
    // A deeply nested action still has its full target and fits the sidebar at every requested width/zoom.
    await drag(leaf, -72)
    await action().waitFor()
    const geometry = await action().evaluate((el) => {
      const box = el.getBoundingClientRect()
      const nav = el.closest("nav").getBoundingClientRect()
      return { width: box.width, height: box.height, left: box.left, right: box.right, navRight: nav.right, viewport: innerWidth }
    })
    assert.ok(geometry.width >= 44 && geometry.height >= 44, `${tag}: 44px target`)
    assert.ok(geometry.left >= 0 && geometry.right <= Math.min(geometry.navRight, geometry.viewport) + 1, `${tag}: action fits`)
    if (touch && [320, 400, 800].includes(width)) await page.screenshot({ path: `${out}/reveal-${tag}.png` })
    await action().click()
    const confirm = page.getByRole('dialog', { name: 'Delete task?', exact: true })
    await confirm.waitFor()
    assert.equal(deletes, 0)
    // Escape must cancel the confirmation itself, including inside the phone drawer.
    await page.keyboard.press("Escape")
    await confirm.waitFor({ state: "detached" })
    assert.equal(deletes, 0)
    assert.equal(await leaf.count(), 1)
    await leaf.focus()
    await page.keyboard.press("Shift+F10")
    await action().click()
    await confirm.waitFor()
    if (tag === "400-100-touch") await page.screenshot({ path: `${out}/confirmation-${tag}.png` })
    await confirm.getByRole("button", { name: "Delete task", exact: true }).click()
    await leaf.waitFor({ state: "detached" })
    assert.equal(deletes, 1, `${tag}: confirmed fixture-only DELETE`)
    results.push({ tag, geometry, nativeScroll: touch ? "passed" : "n/a", confirmedFixtureDeletes: deletes })
    console.log(`PASS ${tag}`)
    await context.close()
  }
  assert.deepEqual(errors, [], "No browser errors")
  await writeFile(`${out}/results.json`, JSON.stringify({ cases: results.length, results, errors }, null, 2) + "\n")
  console.log(`Passed ${results.length} width/zoom/input cases. All DELETE requests intercepted; no user data touched.`)
} finally { await browser.close() }
