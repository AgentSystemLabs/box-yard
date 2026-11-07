// Browser regression for PR numbers inline with titles in parent and nested task rows.
// Build and start an isolated mock server on 4470–4479 (never the live yard), then:
// PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROME_PATH=/path/to/chrome \
//   node scripts/check-sidebar-pr-links.mjs http://localhost:4470 /tmp/example-pr-links
// The optional browser dependency stays outside the app's install. API/GitHub requests use example fixtures.
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const base = process.argv[2] ?? "http://localhost:4470"
assert.match(base, /^http:\/\/(localhost|127\.0\.0\.1):447[0-9]$/, "Use an isolated mock server on 4470–4479")
assert.equal((await (await fetch(`${base}/api/health`)).json()).mock, true)
const out = path.resolve(process.argv[3] ?? "/tmp/example-pr-links")
await mkdir(out, { recursive: true })
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright-core")
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH })
const now = Date.now()
const project = { id: "prj_example", name: "Example app", repo: "acme/example-app", description: "", notes: [], envKeys: [], baseBranch: "main", runner: "box", identityId: "idn_default", gpuMachine: { gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null }, docker: { image: null, dockerfile: null }, createdAt: now, color: null }
const task = (id, title, extra = {}) => ({ id, projectId: project.id, title, status: "idle", prompt: "", prUrl: null, prState: null, prMergedAt: null, previews: [], waitFor: [], question: null, error: null, scheduleId: null, outcome: null, turnCount: 1, pendingCount: 0, currentTurnId: null, parentTaskId: null, createdAt: now - 60_000, updatedAt: now - 60_000, ...extra })
const audit = task("task_audit01", "Security audit", { status: "pr_ready", prUrl: "https://github.com/acme/example-app/pull/18", prState: "open" })
const child = task("task_audit02", "Review dependencies", { status: "done", parentTaskId: audit.id, prUrl: "https://github.com/acme/example-app/pull/17", prState: "merged", prMergedAt: now })
const tasks = [audit, child, task("task_audit03", "Check the example server", { status: "done", parentTaskId: audit.id })]
const results = []
const errors = []
try {
  for (const width of [320, 400, 560, 800, 1440]) for (const zoom of [1, 1.25]) for (const touch of [false, true]) {
    const tag = `${width}-${zoom * 100}-${touch ? "touch" : "mouse"}`
    if (process.env.SIDEBAR_CASE && process.env.SIDEBAR_CASE !== tag) continue
    const context = await browser.newContext({ viewport: { width: Math.floor(width / zoom), height: 850 }, deviceScaleFactor: zoom, hasTouch: touch, colorScheme: "dark" })
    await context.route("https://github.com/**", (route) => route.fulfill({ body: "<title>Example PR</title>" }))
    const page = await context.newPage()
    page.setDefaultTimeout(6000)
    page.on("pageerror", (e) => errors.push(`${tag}: ${e.message}`))
    await page.route("**/api/**", async (route) => {
      const p = new URL(route.request().url()).pathname
      if (p === "/api/boot" || p === "/api/stream") return route.abort()
      assert.equal(route.request().method(), "GET", "Browser proof must not mutate server data")
      let data
      if (p === "/api/tasks") data = tasks
      else if (p === "/api/projects") data = [project]
      else if (p.endsWith("/captain")) data = { projectId: project.id, busy: false, pendingCount: 0, usage: { tokens: 0, window: 200000, updatedAt: now } }
      else if (/\/(messages|compactions|queue)$/.test(p)) data = []
      else if (p.startsWith("/api/tasks/")) data = tasks.find((t) => p === `/api/tasks/${t.id}`) ?? []
      else return route.continue()
      return route.fulfill({ json: data })
    })
    await page.goto(base)
    await page.locator("textarea").first().waitFor()
    const menu = page.locator('button[title="Projects and tasks"]').last()
    if (await menu.isVisible()) await menu.click()
    const tree = page.locator('[role="tree"][aria-label="Projects and tasks"]')
    await tree.waitFor()
    const row = (t) => tree.locator(`[data-tree-key="task:${t.id}@project"]`)
    const parent = row(audit)
    await parent.scrollIntoViewIfNeeded()
    await tree.screenshot({ path: `${out}/tree-${tag}.png` })
    const original = page.url()
    const rootLink = parent.getByRole("link", { name: "PR #18 on GitHub (opens in a new tab)", exact: true })
    if (!await rootLink.count()) {
      // Reproduce the original defect, rather than timing out looking for a link that does not exist.
      await parent.getByText("#18", { exact: true }).click()
      assert.equal(page.url(), original, "Clicking #18 navigated to the task instead of opening GitHub")
      assert.fail("#18 has no accessible GitHub link")
    }
    async function openPr(t, link) {
      await link.scrollIntoViewIfNeeded()
      const geometry = await link.evaluate((a) => {
        const rect = a.getBoundingClientRect()
        const row = a.closest("[data-tree-key]")
        const title = row.querySelector("[data-open-task]").getBoundingClientRect()
        // The trailing Mark done button bounds the PR link on desktop and touch.
        const action = [...row.querySelectorAll('[data-testid="sidebar-mark-done"]')].find((el) => el.checkVisibility())?.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return { width: rect.width, height: rect.height, hitLink: a.contains(hit), inline: rect.top < title.bottom && rect.bottom > title.top, fits: rect.right <= (action?.left ?? row.getBoundingClientRect().right) + 1, nested: !!a.closest("button"), overflow: row.scrollWidth - row.clientWidth }
      })
      assert.ok(geometry.hitLink && geometry.inline && geometry.fits && !geometry.nested && geometry.overflow <= 1, `${tag}: link hit target/layout ${JSON.stringify(geometry)}`)
      if (touch) assert.ok(geometry.height >= 44, `${tag}: PR has its own 44px touch target`)
      assert.equal(await link.getAttribute("href"), t.prUrl)
      assert.equal(await link.getAttribute("target"), "_blank")
      assert.equal(await link.getAttribute("rel"), "noopener noreferrer")
      const [popup] = await Promise.all([page.waitForEvent("popup"), touch ? link.tap() : link.click()])
      await popup.waitForLoadState()
      assert.equal(popup.url(), t.prUrl)
      await popup.close()
      assert.equal(page.url(), original)
      assert.equal(await parent.getAttribute("aria-expanded"), "true")
      return geometry
    }
    const geometry = await openPr(audit, rootLink)
    await openPr(child, row(child).getByRole("link", { name: "Merged #17 on GitHub (opens in a new tab)", exact: true }))
    // Tab from the treeitem reaches the PR link; native Enter opens GitHub without selecting/folding the task.
    await parent.focus()
    await page.keyboard.press("Tab")
    assert.equal(await rootLink.evaluate((a) => a === document.activeElement), true, `${tag}: Tab reaches PR`)
    const [popup] = await Promise.all([page.waitForEvent("popup"), page.keyboard.press("Enter")])
    await popup.waitForLoadState()
    assert.equal(popup.url(), audit.prUrl)
    await popup.close()
    assert.equal(page.url(), original)
    // Collapsing only changes the children. The same PR link still opens GitHub.
    await parent.locator("[data-tree-toggle]").click()
    assert.equal(await parent.getAttribute("aria-expanded"), "false")
    const [foldedPopup] = await Promise.all([page.waitForEvent("popup"), rootLink.click()])
    await foldedPopup.waitForLoadState()
    assert.equal(foldedPopup.url(), audit.prUrl)
    await foldedPopup.close()
    assert.equal(await parent.getAttribute("aria-expanded"), "false")
    assert.equal(page.url(), original)
    // The title remains a separate task navigation target.
    await parent.locator("[data-open-task]").click()
    await page.waitForURL((url) => url.searchParams.get("session") === audit.id)
    results.push({ tag, geometry, pointer: "passed", keyboard: "passed", folded: "passed", title: "passed" })
    console.log(`PASS ${tag}`)
    await context.close()
  }
  assert.deepEqual(errors, [], "No browser errors")
  await writeFile(`${out}/results.json`, JSON.stringify({ cases: results.length, results, errors }, null, 2) + "\n")
  console.log(`Passed ${results.length} sidebar/drawer width/zoom/input cases.`)
} finally { await browser.close() }
