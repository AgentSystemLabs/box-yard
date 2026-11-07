// Real-browser regression proof against an isolated mock server (never the live yard).
// npm run build
// PORT=4012 BOXYARD_MOCK=1 BOXYARD_DATA_DIR=/tmp/sidebar-proof node dist/server/server/index.js
// PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROME_PATH=/path/to/chrome \
//   node scripts/check-sidebar-tree.mjs http://localhost:4012 /tmp/sidebar-proof/shots
// Optional browser dependency stays outside the app's install. API fixtures use example data only.
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const base = process.argv[2] ?? "http://localhost:4012"
assert.match(base, /^http:\/\/(localhost|127\.0\.0\.1):401[1-9]$/, "Use an isolated mock server on 4011–4019")
const out = path.resolve(process.argv[3] ?? "/tmp/sidebar-tree-proof/shots")
await mkdir(out, { recursive: true })
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright-core")
const now = Date.now()
const project = { id: "prj_example", name: "example-app", repo: null, description: "", notes: [], envKeys: [], baseBranch: "main", runner: "box", identityId: "idn_default", gpuMachine: { gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null }, docker: { image: null, dockerfile: null }, createdAt: now, color: null }
// The existing tree builder admits a root plus twelve child levels (its cycle/depth guard).
const tasks = Array.from({ length: 13 }, (_, depth) => ({
  id: `task_level${String(depth + 1).padStart(2, "0")}`, projectId: project.id,
  title: `${depth ? "Review" : "Plan"} the example release — nesting level ${depth + 1} with a deliberately long title`,
  status: "idle", prompt: "", prUrl: null, prState: null, prMergedAt: null, previews: [], waitFor: [], question: null, error: null, scheduleId: null, outcome: null, turnCount: 1, pendingCount: 0,
  parentTaskId: depth ? `task_level${String(depth).padStart(2, "0")}` : null,
  rootTaskId: depth ? "task_level01" : null, subtaskDepth: depth, createdAt: now - 60_000 + depth, updatedAt: now - 60_000,
}))
const messages = [
  { id: "tm_started1", role: "event", content: "Started 2 sub-tasks.", meta: { kind: "subtasks", subtasks: tasks.slice(1, 3) }, createdAt: now },
  { id: "tm_report01", role: "agent", content: "The example release checks passed.", meta: { from: tasks[1].id, fromTitle: "ExampleReleaseValidationWithAVeryLongUnbrokenTaskNameThatMustStayInsideThePanel", subtaskReport: "idle" }, createdAt: now },
]
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH })
const failures = []
let checks = 0
const check = (name, test) => { checks++; try { assert.ok(test, name) } catch { failures.push(name) } }
const results = []
try {
  for (const width of [320, 400, 560, 800, 1600]) for (const zoom of [1, 1.25]) for (const touch of [false, true]) {
    // Browser zoom reduces CSS viewport, unlike deviceScaleFactor alone. Restore physical pixels in the PNG.
    const tag = `${width}-${zoom === 1 ? "100" : "125"}-${touch ? "touch" : "mouse"}`
    if (process.env.SIDEBAR_CASE && tag !== process.env.SIDEBAR_CASE) continue
    const context = await browser.newContext({ viewport: { width: Math.floor(width / zoom), height: 800 }, deviceScaleFactor: zoom, hasTouch: touch })
    // Also exercise the actual persisted minimum column width, rather than only phone drawers.
    if (width === 1600) await context.addInitScript(() => localStorage.setItem("box-yard:sidebar-width", "200"))
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)
    page.on("pageerror", (e) => { failures.push(`${tag}: ${e.message}`); console.error(`${tag}: ${e.stack}`) })
    await page.route("**/api/**", async (route) => {
      const p = new URL(route.request().url()).pathname
      if (p === "/api/boot" || p === "/api/stream") return route.abort()
      let data
      if (p === "/api/tasks") data = tasks
      else if (p === "/api/projects") data = [project]
      else if (p.endsWith("/captain")) data = { busy: false, sessionId: null, pendingCount: 0, error: null, usage: { tokens: 0, window: 200000, updatedAt: now } }
      else if (p.startsWith("/api/projects/") && /\/(messages|compactions|queue)$/.test(p)) data = []
      else if (p.endsWith("/messages") && p.startsWith("/api/tasks/")) data = messages
      else if (p.startsWith("/api/tasks/")) data = []
      else if (p === "/api/me") data = { authed: true, authRequired: false }
      else return route.continue()
      return route.fulfill({ json: data })
    })
    await page.goto(`${base}/?session=${tasks[0].id}`)
    await page.locator('textarea[placeholder^="Send feedback"]').first().waitFor()
    // Transcript: links and report names must fit even in the narrow task panel.
    const transcript = page.locator('[data-testid="subtasks-line"]').first()
    await transcript.waitFor()
    const transcriptGeometry = await transcript.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      const links = [...el.querySelectorAll("a")].map((a) => ({ width: a.getBoundingClientRect().width, height: a.getBoundingClientRect().height, title: a.querySelector(".truncate").getBoundingClientRect().width }))
      const report = document.querySelector('[data-testid="subtask-report"]')
      return { overflow: el.scrollWidth - el.clientWidth, reportOverflow: report.scrollWidth - report.clientWidth, right: rect.right, viewport: innerWidth, links }
    })
    check(`${tag}: transcript fits`, transcriptGeometry.overflow <= 1 && transcriptGeometry.reportOverflow <= 1 && transcriptGeometry.right <= transcriptGeometry.viewport + 1)
    check(`${tag}: transcript titles readable`, transcriptGeometry.links.every((l) => l.title >= 48))
    if (touch) check(`${tag}: transcript touch targets`, transcriptGeometry.links.every((l) => l.height >= 44))
    if (touch) await page.screenshot({ path: `${out}/transcript-${tag}.png` })

    // Small layouts open the same sidebar tree in its drawer.
    const menu = page.locator('button[title="Projects and tasks"]').last()
    if (await menu.isVisible()) await menu.click()
    const tree = page.locator('[role="tree"][aria-label="Projects and tasks"]')
    if (!await tree.isVisible()) await page.locator('button[aria-label="Show the sidebar"]').click()
    await tree.waitFor()
    const group = tree.locator(`[data-sidebar-group="${project.id}"]`)
    const rows = group.locator('[data-tree-node] > [role="treeitem"]')
    check(`${tag}: all depths rendered`, await rows.count() === tasks.length)
    const geometry = await rows.evaluateAll((rows) => rows.map((row) => {
      const open = row.querySelector("[data-open-task]")
      const done = row.querySelector('[data-testid="sidebar-mark-done"]')
      const toggle = row.querySelector("[data-tree-toggle]")
      const box = row.getBoundingClientRect()
      const title = open.querySelector(".truncate").getBoundingClientRect()
      const action = done.getBoundingClientRect()
      const nav = row.closest("nav").getBoundingClientRect()
      return { level: +row.getAttribute("aria-level"), left: box.left, right: box.right, titleWidth: title.width, actionWidth: action.width, actionHeight: action.height, actionLeft: action.left, actionRight: action.right, titleRight: title.right, navRight: nav.right, toggleWidth: toggle?.getBoundingClientRect().width, toggleHeight: toggle?.getBoundingClientRect().height, overflow: row.scrollWidth - row.clientWidth }
    }))
    if (width === 1600) check(`${tag}: actual 200px minimum column`, geometry[0].navRight >= 198 && geometry[0].navRight <= 200)
    for (const g of geometry) {
      check(`${tag}: level ${g.level} fits`, g.overflow <= 1 && g.actionRight <= g.navRight - 2 && g.actionLeft >= g.left && g.titleRight <= g.actionLeft + 1)
      check(`${tag}: level ${g.level} title readable`, g.titleWidth >= 48)
      if (touch) check(`${tag}: level ${g.level} touch targets`, g.actionWidth >= 44 && g.actionHeight >= 44 && (!g.toggleWidth || g.toggleWidth >= 44 && g.toggleHeight >= 44))
    }
    // Depth is semantic even when the visual indent reaches its budget. Keyboard folding must retain focus.
    const last = rows.last()
    await last.focus()
    await page.keyboard.press("ArrowLeft")
    check(`${tag}: left reaches actual parent`, await page.evaluate(() => document.activeElement?.getAttribute("aria-level")) === String(tasks.length))
    await page.keyboard.press("ArrowLeft")
    check(`${tag}: parent folds`, await rows.count() === tasks.length - 1)
    const foldedFits = await page.evaluate(() => {
      const row = document.activeElement
      return row.scrollWidth <= row.clientWidth + 1 && row.querySelector("[data-open-task] .truncate").getBoundingClientRect().width >= 48
    })
    check(`${tag}: folded count fits`, foldedFits)
    await page.keyboard.press("ArrowRight")
    await page.keyboard.press("ArrowRight")
    check(`${tag}: right restores deepest focus`, await page.evaluate(() => document.activeElement?.getAttribute("aria-level")) === String(tasks.length + 1))
    check(`${tag}: one tree tab stop`, await tree.locator('[tabindex="0"]').count() === 1 && await tree.locator('button:not([tabindex="-1"])').count() === 0)
    await last.scrollIntoViewIfNeeded()
    const done = last.locator('[data-testid="sidebar-mark-done"]')
    const hit = await done.evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) })
    check(`${tag}: deepest action can be hit`, hit)
    await page.screenshot({ path: `${out}/sidebar-${tag}.png` })
    if (width === 1600) await page.locator('nav[aria-label="Projects and tasks"]').screenshot({ path: `${out}/minimum-column-${tag}.png` })

    // The rail popover reuses TreeNode but exists only with the desktop inline sidebar (768 CSS px).
    if (Math.floor(width / zoom) < 768) {
      results.push({ tag, transcriptGeometry, geometry, railGeometry: null })
      await context.close()
      console.log(`Checked ${tag} (drawer; rail is desktop-only)`)
      continue
    }
    const closeDrawer = page.locator('button[aria-label="Close the sidebar"]')
    if (await closeDrawer.isVisible()) await closeDrawer.click()
    else await page.locator('button[aria-label="Fold the sidebar"]').click()
    await page.goto(`${base}/?project=${project.id}`)
    await page.locator('[data-testid="chat-title"]').filter({ hasText: project.name }).waitFor()
    // A Captain's task bar is available with the sidebar folded, including narrow chat containers.
    await page.waitForTimeout(300)
    const fold = page.locator('button[aria-label="Fold the sidebar"]')
    if (await fold.isVisible()) await fold.click()
    await page.screenshot({ path: `${out}/captain-${tag}.png` })
    await page.locator('[data-testid="rail-tree-button"]').click()
    const rail = page.locator('[data-testid="rail-tree"]')
    await rail.waitFor()
    const railRows = rail.locator('[data-tree-node] > div:first-child')
    const railGeometry = await railRows.evaluateAll((rows) => rows.map((row) => {
      const open = row.querySelector("[data-open-task]")
      const done = row.querySelector('[data-testid="sidebar-mark-done"]').getBoundingClientRect()
      const title = open.querySelector(".truncate").getBoundingClientRect()
      return { title: title.width, right: done.right, edge: row.closest('[role="dialog"]').getBoundingClientRect().right, overflow: row.scrollWidth - row.clientWidth, height: done.height, width: done.width }
    }))
    check(`${tag}: rail all depths`, railGeometry.length === tasks.length)
    check(`${tag}: rail fits and titles readable`, railGeometry.every((g) => g.title >= 48 && g.right <= g.edge - 2 && g.overflow <= 1))
    if (touch) check(`${tag}: rail touch targets`, railGeometry.every((g) => g.width >= 44 && g.height >= 44))
    await railRows.last().scrollIntoViewIfNeeded()
    if (touch) await page.screenshot({ path: `${out}/rail-${tag}.png` })
    results.push({ tag, transcriptGeometry, geometry, railGeometry })
    await context.close()
    console.log(`Checked ${tag}`)
  }
} finally { await browser.close() }
await writeFile(`${out}/geometry.json`, JSON.stringify({ checks, failures, results }, null, 2))
console.log(`${checks} checks; ${failures.length} failures. Proof: ${out}`)
for (const f of failures) console.error(f)
assert.equal(failures.length, 0)
