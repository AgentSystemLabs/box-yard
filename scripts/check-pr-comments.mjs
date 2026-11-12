// Browser check for the new-comments count on task rows, the task header's PR chip and the PR sheet.
// Build and start an isolated mock server on 4620–4629 (never the live yard), then:
// PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROME_PATH=/path/to/chrome \
//   node scripts/check-pr-comments.mjs http://localhost:4620 /tmp/example-pr-comments
// The optional browser dependency stays outside the app's install. API/GitHub requests use example fixtures.
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const base = process.argv[2] ?? "http://localhost:4620"
assert.match(base, /^http:\/\/(localhost|127\.0\.0\.1):462[0-9]$/, "Use an isolated mock server on 4620–4629")
assert.equal((await (await fetch(`${base}/api/health`)).json()).mock, true)
const out = path.resolve(process.argv[3] ?? "/tmp/example-pr-comments")
await mkdir(out, { recursive: true })
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright-core")
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH })
const now = Date.now()
const project = { id: "prj_example", name: "Example app", repo: "acme/example-app", description: "", notes: [], envKeys: [], baseBranch: "main", runner: "box", identityId: "idn_default", gpuMachine: { gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null }, docker: { image: null, dockerfile: null }, createdAt: now, color: null }
const pull = (n) => `https://github.com/acme/example-app/pull/${n}`
let order = 0
const task = (id, title, extra = {}) => ({ id, projectId: project.id, title, status: "pr_ready", prompt: "", prUrl: null, prState: null, prMergedAt: null, prNewComments: null, previews: [], waitFor: [], question: null, error: null, scheduleId: null, outcome: null, turnCount: 1, pendingCount: 0, currentTurnId: null, parentTaskId: null, createdAt: now - 60_000 - ++order, updatedAt: now - 60_000 - order, ...extra })
const five = task("task_cmt00001", "Checkout page", { prUrl: pull(18), prState: "open", prNewComments: 5 })
const many = task("task_cmt00002", "Rewrite the importer so a large spreadsheet no longer times out halfway", { prUrl: pull(1204), prState: "open", prNewComments: 250 })
const draft = task("task_cmt00003", "Dark mode", { prUrl: pull(19), prState: "draft", prNewComments: 1 })
const child = task("task_cmt00004", "Review dependencies", { parentTaskId: five.id, prUrl: pull(17), prState: "open", prNewComments: 12 })
const quiet = task("task_cmt00005", "Fix the footer", { prUrl: pull(20), prState: "open", prNewComments: 0 })
const merged = task("task_cmt00006", "Update the docs", { status: "done", prUrl: pull(16), prState: "merged", prMergedAt: now, prNewComments: 4 })
const tasks = [five, many, draft, child, quiet, merged]
// What each row shows: the count's text, or null for no badge.
const expected = [[five, "5"], [many, "99+"], [draft, "1"], [child, "12"], [quiet, null], [merged, null]]
const details = (t) => ({
  details: {
    url: t.prUrl, number: Number(t.prUrl.split("/").pop()), title: t.title, state: t.prState, mergedAt: null, mergedBy: null, base: "main", head: "checkout-page", headSha: "a".repeat(40),
    checks: { state: "passing", passed: 3, failed: 0, pending: 0, skipped: 0, list: [] }, merge: "clean", review: "required", files: { changed: 4, additions: 120, deletions: 18 },
    comments: t.prNewComments === null ? null : { count: t.prNewComments, viewedAt: now - 20 * 3600_000 },
  },
  error: null,
  checkedAt: now,
})
const results = []
const errors = []
try {
  for (const width of [320, 400, 560, 800, 1440]) for (const zoom of [1, 1.25]) for (const touch of [false, true]) {
    const tag = `${width}-${zoom * 100}-${touch ? "touch" : "mouse"}`
    if (process.env.PR_COMMENTS_CASE && process.env.PR_COMMENTS_CASE !== tag) continue
    const context = await browser.newContext({ viewport: { width: Math.floor(width / zoom), height: 850 }, deviceScaleFactor: zoom, hasTouch: touch, colorScheme: "dark" })
    await context.route("https://github.com/**", (route) => route.fulfill({ body: "<title>Example PR</title>" }))
    const page = await context.newPage()
    page.setDefaultTimeout(6000)
    page.on("pageerror", (e) => errors.push(`${tag}: ${e.message}`))
    const views = []
    await page.route("**/api/**", async (route) => {
      const p = new URL(route.request().url()).pathname
      if (p === "/api/boot" || p === "/api/stream") return route.abort()
      if (p === "/api/pr-views") {
        views.push(route.request().postDataJSON().url)
        return route.fulfill({ json: { viewedAt: now } })
      }
      assert.equal(route.request().method(), "GET", "Browser proof must not mutate server data")
      let data
      if (p === "/api/tasks") data = tasks
      else if (p === "/api/projects") data = [project]
      else if (p.endsWith("/captain")) data = { projectId: project.id, busy: false, pendingCount: 0, usage: { tokens: 0, window: 200000, updatedAt: now } }
      else if (/\/(messages|compactions|queue)$/.test(p)) data = []
      else if (/^\/api\/tasks\/[^/]+\/pr$/.test(p)) data = details(tasks.find((t) => p === `/api/tasks/${t.id}/pr`))
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
    await row(five).scrollIntoViewIfNeeded()
    const geometry = {}
    for (const [t, text] of expected) {
      const r = row(t)
      await r.waitFor()
      const got = await r.evaluate((el) => {
        const shown = [...el.querySelectorAll('[data-testid="pr-new-comments"]')].filter((b) => b.checkVisibility())
        const box = el.getBoundingClientRect()
        const title = el.querySelector("[data-open-task]").getBoundingClientRect()
        const action = [...el.querySelectorAll('[data-testid="sidebar-mark-done"]')].find((a) => a.checkVisibility())?.getBoundingClientRect()
        return shown.map((b) => {
          const rect = b.getBoundingClientRect()
          const link = b.closest("a")
          const target = link?.getBoundingClientRect()
          return {
            text: b.querySelector("span[aria-hidden]")?.textContent ?? null,
            // Without a link of its own (a zoomed phone's drawer) the row's name says it.
            name: link?.getAttribute("aria-label") ?? el.textContent,
            width: rect.width,
            targetHeight: target?.height ?? 0,
            inline: rect.top < title.bottom && rect.bottom > title.top,
            fits: rect.left >= box.left - 1 && rect.right <= (action?.left ?? box.right) + 1,
            titleWidth: title.width,
            overflow: el.scrollWidth - el.clientWidth,
            rowHeight: box.height,
          }
        })
      })
      if (text === null) {
        assert.deepEqual(got, [], `${tag}: ${t.title} shows no count`)
        continue
      }
      assert.equal(got.length, 1, `${tag}: ${t.title} shows its count once, got ${JSON.stringify(got)}`)
      const g = got[0]
      assert.equal(g.text, text, `${tag}: ${t.title}`)
      assert.ok(g.inline && g.fits && g.overflow <= 1, `${tag}: ${t.title} keeps the count on its one line ${JSON.stringify(g)}`)
      // The title never gives all of its room to the PR and its count.
      assert.ok(g.titleWidth >= 40, `${tag}: ${t.title} keeps a readable title ${JSON.stringify(g)}`)
      assert.match(g.name, /new comments? since you last opened this PR/, `${tag}: ${t.title} names its count`)
      geometry[t.id] = g
    }
    // Every task row is one line of the same height, with a count or without.
    const heights = await Promise.all(tasks.map((t) => row(t).evaluate((el) => Math.round(el.getBoundingClientRect().height))))
    assert.equal(new Set(heights).size, 1, `${tag}: rows keep one height ${heights}`)
    await tree.screenshot({ path: `${out}/tree-${tag}.png` })
    // Opening the PR from its row records the view, when the row offers a link of its own at this width.
    const link = row(five).getByRole("link", { name: /^PR #18, 5 new comments since you last opened this PR, on GitHub/ })
    if (await link.count() && await link.isVisible()) {
      if (touch) assert.ok(geometry[five.id].targetHeight >= 44, `${tag}: the PR and its count are one 44px target`)
      const [popup] = await Promise.all([page.waitForEvent("popup"), touch ? link.tap() : link.click()])
      await popup.close()
      assert.deepEqual(views, [five.prUrl], `${tag}: the click recorded the view`)
    }
    // The task page: its header chip carries the count, and the PR sheet says it in words.
    await row(five).locator("[data-open-task]").click()
    await page.waitForURL((url) => url.searchParams.get("session") === five.id)
    const chip = page.locator('button[data-pr-state][aria-haspopup="dialog"]').first()
    await chip.waitFor()
    const header = await chip.evaluate((el) => {
      const b = el.querySelector('[data-testid="pr-new-comments"]')
      const rect = el.getBoundingClientRect()
      const bar = el.parentElement.getBoundingClientRect()
      return { text: b?.querySelector("span[aria-hidden]")?.textContent ?? null, visible: !!b?.checkVisibility(), inside: rect.right <= bar.right + 1 && rect.left >= bar.left - 1, page: document.documentElement.scrollWidth - document.documentElement.clientWidth }
    })
    assert.ok(header.visible && header.text === "5" && header.inside && header.page <= 0, `${tag}: header chip ${JSON.stringify(header)}`)
    await page.screenshot({ path: `${out}/task-${tag}.png` })
    await chip.click()
    const fact = page.locator('[data-testid="pr-comments"]')
    await fact.waitFor()
    assert.match(await fact.innerText(), /5 new comments since you last opened this PR/, `${tag}: the PR sheet says the count`)
    const sheet = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert.ok(sheet <= 0, `${tag}: the PR sheet doesn't widen the page`)
    await page.screenshot({ path: `${out}/sheet-${tag}.png` })
    results.push({ tag, geometry, header, rows: "passed", sheet: "passed" })
    console.log(`PASS ${tag}`)
    await context.close()
  }
  assert.deepEqual(errors, [], "No browser errors")
  await writeFile(`${out}/results.json`, JSON.stringify({ cases: results.length, results, errors }, null, 2) + "\n")
  console.log(`Passed ${results.length} width/zoom/input cases.`)
} finally { await browser.close() }
