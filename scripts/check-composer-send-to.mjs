// Real UI, isolated mock yard, synthetic data. All writes are intercepted so no agent starts.
// PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROME_PATH=/path/to/chrome \
//   node scripts/check-composer-send-to.mjs http://localhost:4510 data/composer-proof/shots
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const [base, output = "data/composer-proof/shots"] = process.argv.slice(2)
const url = new URL(base)
assert(["localhost", "127.0.0.1"].includes(url.hostname) && Number(url.port) >= 4011, "Use an isolated loopback server on 4011+")
assert.equal((await (await fetch(`${base}/api/health`)).json()).mock, true)
const out = path.resolve(output)
await mkdir(out, { recursive: true })
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright-core")
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ["--mute-audio"] })
const now = Date.now()
const project = { id: "prj_example", name: "Example", repo: "acme/site", description: "Example release", notes: [], envKeys: [], baseBranch: "main", runner: "box", identityId: "idn_default", color: null, createdAt: now }
const task = { id: "task_source", projectId: project.id, title: "Review the example release", status: "idle", prompt: "Review the example release", prUrl: null, prState: null, previews: [], waitFor: [], question: null, error: null, parentTaskId: null, turnCount: 1, pendingCount: 0, createdAt: now, updatedAt: now }
const destination = { ...task, id: "task_destination", title: "Check example uploads", status: "done" }
const results = []
try {
  for (const width of [320, 393, 400, 560, 800]) for (const zoom of [1, 1.25]) for (const status of ["idle", "working"]) {
    const tag = `${width}-${zoom === 1 ? "100" : "125"}-${status}`
    const context = await browser.newContext({ viewport: { width: Math.floor(width / zoom), height: Math.floor(900 / zoom) }, deviceScaleFactor: zoom, hasTouch: true, reducedMotion: "reduce" })
    try {
      await context.addInitScript(() => {
        localStorage.setItem("box-yard:setup-skipped", "true")
        localStorage.setItem("boxyard:voice", JSON.stringify({ enabled: false }))
        localStorage.setItem("boxyard:send-sound", JSON.stringify({ enabled: false }))
        window.SpeechRecognition = class extends EventTarget { start() {} stop() {} abort() {} }
      })
      const page = await context.newPage(), errors = [], sends = []
      page.setDefaultTimeout(10_000)
      page.on("pageerror", (e) => errors.push(e.message))
      await page.route("**/api/**", async (route) => {
        const request = route.request(), p = new URL(request.url()).pathname
        if (p === "/api/boot") return route.abort()
        if (request.method() !== "GET") {
          assert.equal(p, "/api/tasks/task_destination/messages", "Only the selected task receives this message")
          const body = request.postDataJSON(); sends.push(body)
          return route.fulfill({ json: { ...destination, status: "queued" } })
        }
        let data
        if (p === "/api/tasks") data = [{ ...task, status }, destination]
        else if (p === "/api/projects") data = [project]
        else if (p.endsWith("/captain")) data = { busy: false, sessionId: null, pendingCount: 0, error: null }
        else if (p.endsWith("/history")) data = { oldestId: "tm_example", days: [{ at: now, messageId: "tm_example" }], messages: [], before: null, after: null }
        else if (p.startsWith("/api/tasks/")) data = p.endsWith("/messages") ? [{ id: "tm_example", taskId: task.id, role: "assistant", content: "The example release is ready for review.", createdAt: now }] : []
        else if (p.startsWith("/api/projects/") && /\/(messages|compactions|queue)$/.test(p)) data = []
        else if (p === "/api/run-targets" || p === "/api/harness-targets") data = []
        else return route.continue()
        return route.fulfill({ json: data })
      })
      await page.goto(`${base}/?session=${task.id}`)
      const input = page.locator('textarea[placeholder="Send feedback or a follow-up…"], textarea[placeholder="Delivered when the current turn ends…"]').first()
      await input.waitFor()
      const form = input.locator("xpath=ancestor::form")
      await input.fill("Please check the example attachment flow.")
      const geometry = await form.locator("button").evaluateAll((buttons) => buttons.map((button) => {
        const r = button.getBoundingClientRect(), box = button.closest("form").getBoundingClientRect()
        return { label: button.getAttribute("aria-label") || button.title, width: r.width, height: r.height, inside: r.left >= box.left && r.right <= box.right + 1 && r.bottom <= innerHeight }
      }).filter((b) => b.width && b.height))
      assert(geometry.every((b) => b.inside && b.width >= 44 && b.height >= 44), JSON.stringify({ tag, geometry }))
      const boxWidth = await input.locator("xpath=ancestor::div[contains(@class, '@container/composer')]").last().evaluate((el) => el.clientWidth)
      const chipsVisible = boxWidth >= (status === "working" ? 18.5 : 15.5) * 16
      assert.equal(await form.getByTestId("captain-target").isVisible(), chipsVisible, `${tag}: Captain keeps its threshold`)
      assert.equal(await form.getByTestId("task-ask-toggle").isVisible(), chipsVisible, `${tag}: Side question keeps its threshold`)
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tag}: no horizontal overflow`)
      if ((width === 320 || width === 393) && zoom === 1) await page.screenshot({ path: `${out}/row-${tag}.png` })

      const sendTo = form.getByRole("button", { name: "Send to…", exact: true })
      if (await sendTo.isVisible()) await sendTo.tap()
      else {
        await form.getByTestId("composer-more").tap()
        await page.getByTestId("more-send-to").tap()
      }
      const search = page.getByRole("combobox", { name: "Search destinations" })
      await search.fill("uploads")
      const choice = page.getByRole("option").getByRole("button", { name: /Check example uploads/ })
      assert((await choice.boundingBox()).height >= 44)
      if (width === 400 && zoom === 1 && status === "idle") await page.screenshot({ path: `${out}/touch-picker-400.png` })
      await choice.tap()
      const note = form.getByTestId("send-to-note")
      await note.getByRole("link", { name: "Check example uploads" }).waitFor()
      assert((await note.textContent()).includes("Sending reopens this task"))
      if (width === 400 && zoom === 1 && status === "idle") await page.screenshot({ path: `${out}/selected-400.png` })
      await note.getByRole("button", { name: "Clear destination" }).tap()
      assert.equal(await note.count(), 0)
      await input.fill("Please review >uploads")
      const menu = page.getByTestId("send-to-menu")
      await menu.getByRole("option").waitFor()
      if (width === 560 && zoom === 1 && status === "idle") await page.screenshot({ path: `${out}/typed-picker-560.png` })
      await input.press("Enter")
      assert.equal(await input.inputValue(), "Please review ")
      await input.press("Enter")
      // A disconnected mock stream holds the message rather than losing it; explicitly try its existing Send now.
      const sendNow = form.getByRole("button", { name: "Send now", exact: true })
      if (await sendNow.isVisible()) await sendNow.click()
      await page.waitForFunction(() => document.querySelector('[data-testid="send-to-note"]')?.textContent.includes("Sent to"))
      assert.equal(sends.length, 1)
      assert.equal(sends[0].content, "Please review")
      assert(page.url().endsWith(`?session=${task.id}`), "Stay at the source after sending")
      assert.equal(await note.getByRole("link").getAttribute("href"), "/?session=task_destination")
      if (width === 800 && zoom === 1.25 && status === "idle") await page.screenshot({ path: `${out}/confirmation-800-125.png` })
      assert.deepEqual(errors, [])
      results.push({ width, zoom, status, geometry, touchPicker: true, typedPicker: true, sendCount: sends.length, stayedInSource: true })
      console.log(`${tag}: row, 44px targets, touch, typed picker, clear and destination send pass`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
await writeFile(`${out}/checks.json`, JSON.stringify(results, null, 2))
