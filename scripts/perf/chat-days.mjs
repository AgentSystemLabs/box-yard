#!/usr/bin/env node
// Deterministic day-history checks/screenshots against a mock server. Browser jobs run sequentially.
// Start the mock server with BOXYARD_MOCK_HEAVY=1 to provide project/task schemas.
// PLAYWRIGHT_MODULE=/tmp/browser/node_modules/playwright-core/index.mjs node scripts/perf/chat-days.mjs http://localhost:4000 /tmp/chat-days
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")
const base = process.argv[2] ?? "http://localhost:4000"
const output = process.argv[3] ?? "/tmp/chat-days"
await mkdir(output, { recursive: true })
const get = async (path) => (await fetch(base + path)).json()
const [projects, originalTasks] = await Promise.all([get("/api/projects"), get("/api/tasks")])
assert.ok(projects[0] && originalTasks.length >= 4, "Use a mock yard seeded with BOXYARD_MOCK_HEAVY=1")
const project = { ...projects[0], name: "Studio", repo: "example/studio" }
const at = (ago, minute = 0) => {
  const d = new Date()
  d.setDate(d.getDate() - ago)
  d.setHours(9, minute, 0, 0)
  return +d
}
const titles = ["Fix sign-in redirects #318", "Guide example/docs#27 and https://github.com/example/docs/issues/28", "Add project search", "Review keyboard navigation #21"]
const tasks = titles.map((title, i) => ({
  ...originalTasks[i], projectId: project.id, title, status: "idle", question: null, error: null,
  createdAt: at(i === 3 ? 3 : i === 2 ? 0 : 1), updatedAt: at(0),
  prUrl: i === 0 ? "https://github.com/example/studio/pull/42" : null,
  prState: i === 0 ? "merged" : null, prMergedAt: i === 0 ? at(1, 45) : null,
  parentTaskId: null, rootTaskId: null, subtaskDepth: 0,
}))
// Exercise the real nested panel path, not another top-level task with a different title.
Object.assign(tasks[2], { parentTaskId: tasks[0].id, rootTaskId: tasks[0].id, subtaskDepth: 1 })
Object.assign(tasks[3], { parentTaskId: tasks[2].id, rootTaskId: tasks[0].id, subtaskDepth: 2 })
const isTask = (kind) => kind === "task" || kind === "subtask"
const taskFor = (kind) => tasks[kind === "subtask" ? 3 : 0]
const messages = []
for (const ago of [3, 2, 1, 0]) {
  const add = (role, content, meta = null) => messages.push({ id: `chat_day${ago}-${messages.length}`, role, content, meta, createdAt: at(ago, messages.length % 60) })
  add("user", ago === 1 ? "Please finish the sign-in fix and the setup guide today." : ago === 0 ? "Let's add project search next." : "Let's work through the project improvements.")
  add("assistant", ago === 1 ? "The sign-in fix is ready. I checked the return URL and the expired-session flow. The setup guide now covers the first project and its settings." : "I'll check the current flow, make the change, and run the affected tests.")
  for (let i = 0; i < 20; i++) add(i % 3 === 0 ? "user" : "assistant", [
    "Please keep the phone layout easy to use.",
    "The controls fit on a narrow panel, with room for the full task title.",
    "The focused checks pass. I'll verify the final layout before opening the PR.",
    "The update is ready to review. The existing keyboard shortcuts still work.",
  ][i % 4])
  if (ago === 3) {
    add("notice", `✅ **${titles[3]}** is done: Keyboard navigation checked.`, { taskId: tasks[3].id })
    add("notice", `💬 **${titles[3]}** finished its turn: Focus remains visible.`, { taskId: tasks[3].id })
  }
  if (ago === 1) {
    add("notice", `💬 **${titles[0]}** finished its turn: Fixed the return URL.`, { taskId: tasks[0].id })
    add("notice", `✅ **${titles[1]}** is done: Published the guide.`, { taskId: tasks[1].id })
  }
}
// Additional retained rows live outside the initial API response as well as outside useTail's DOM window.
const retained = Array.from({ length: 600 }, (_, i) => ({
  id: `chat_retained-${i}`, role: i % 3 === 0 ? "user" : "assistant", meta: null,
  content: `Earlier conversation ${i}. Keep the navigation clear on phones and desktops.`,
  createdAt: at(10 - Math.floor(i / 150), i % 150),
}))
async function fixture(context, long = false) {
  const full = long ? [...retained, ...messages] : messages
  const fullCaptain = full.map((m) => ({ ...m, projectId: project.id }))
  const taskMessages = (id) => full.map((m) => m.role === "notice" ? {
    ...m, taskId: id, role: "event", content: "Turn 1 finished. · Keyboard navigation checked.", meta: null,
  } : { ...m, taskId: id })
  // Link checks open a local stand-in page; the fixture never asks GitHub for data or state.
  await context.route("https://github.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>GitHub reference</title>" }))
  await context.addInitScript(() => {
    window.__streams = []
    window.EventSource = class {
      constructor() { window.__streams.push(this) }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    window.speechSynthesis = { getVoices: () => [], cancel() {}, addEventListener() {}, removeEventListener() {} }
  })
  await context.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === "/api/boot" || path === "/api/stream") return route.abort()
    let body
    if (path.endsWith("/history")) {
      const list = path.startsWith("/api/tasks/") ? taskMessages(path.split("/")[3]) : path.includes("/captain/") ? fullCaptain : full
      const query = new URL(route.request().url()).searchParams
      if (query.has("days")) {
        const days = [...new Set(list.map((m) => new Date(m.createdAt).toDateString()))].map((key) => {
          const m = list.find((m) => new Date(m.createdAt).toDateString() === key)
          return { at: m.createdAt, messageId: m.id }
        })
        return route.fulfill({ json: { days, oldestId: list[0].id } })
      }
      const id = query.get("around") ?? query.get("before") ?? query.get("after")
      const index = list.findIndex((m) => m.id === id)
      assert.ok(index >= 0, "history request uses a known cursor")
      const start = query.has("before") ? Math.max(0, index - 100) : query.has("after") ? index + 1 : Math.max(0, index - 10)
      const page = list.slice(start, start + (query.has("before") || query.has("after") ? 100 : 180))
      return route.fulfill({ json: { messages: page, before: start ? page[0].id : null,
        after: start + page.length < list.length ? page.at(-1).id : null } })
    }
    if (path === "/api/chat") body = full.slice(-messages.length)
    else if (path === "/api/tasks") body = tasks
    else if (path === "/api/projects") body = [project]
    else if (path === `/api/projects/${project.id}`) body = project
    else if (path === `/api/projects/${project.id}/captain/messages`) body = fullCaptain.slice(-messages.length)
    else if (/^\/api\/tasks\/[^/]+\/messages$/.test(path)) body = taskMessages(path.split("/")[3]).slice(-messages.length)
    else if (tasks.some((t) => path === `/api/tasks/${t.id}`)) body = tasks.find((t) => path === `/api/tasks/${t.id}`)
    else return route.continue()
    return route.fulfill({ json: body })
  })
}
const historySelector = (kind) => `${kind === "captain" ? "[data-testid=captain-chat]" : isTask(kind) ? `[data-view="session:${taskFor(kind).id}"]` : "[data-testid=chat-panel]"} [data-chat-history]`
const history = (page, kind) => page.locator(historySelector(kind)).filter({ visible: true }).last()
const wait = (page) => page.waitForTimeout(350)
async function open(page, kind, stacked = false) {
  await page.goto(base + (kind === "captain" ? `/?project=${project.id}` : stacked ? `/?session=${tasks[0].id}&stack=${tasks[2].id},${tasks[3].id}` : isTask(kind) ? `/?session=${taskFor(kind).id}` : "/"))
  const box = history(page, kind)
  await box.locator("nav button").last().waitFor()
  try {
    // Opening can replace the chat's first pre-render. Poll the current scroller, not a detached ElementHandle.
    await page.waitForFunction((selector) => {
      const el = [...document.querySelectorAll(selector)].filter((el) => el.getClientRects().length).at(-1)
      return el && el.firstElementChild.childElementCount >= 60 && Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 2
    }, `${historySelector(kind)} [data-scroller]`)
  } catch (error) {
    await page.screenshot({ path: `${output}/${kind}-open-failure.png` })
    console.error(kind, await box.locator("[data-scroller]").evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, view: el.clientHeight, rows: el.firstElementChild.childElementCount })))
    throw error
  }
  if (stacked) await box.evaluate((el) => { const strip = el.closest('[data-testid="columns"]'); strip.scrollLeft = strip.scrollWidth })
  await wait(page)
  return box
}

// Assert against the conversation column, not just ChatHistory: a centred outer width cap can move the entire
// history (including its correctly positioned absolute popup) inward while a history-relative check still passes.
async function placement(box, kind) {
  const geometry = await box.evaluate((el) => {
    const rect = (node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width } }
    const column = el.closest('[data-testid="column"]')
    const frame = column ?? el.closest('[data-testid="captain-chat"], [data-testid="chat-panel"]')
    const bar = column?.querySelector(':scope > [data-testid="rail"]')
    return { frame: rect(frame), bar: bar?.getBoundingClientRect().width ?? 0,
      history: rect(el), popup: rect(el.querySelector('[role="region"]')) }
  })
  const { frame, bar, history, popup } = geometry
  assert.ok(Math.abs(history.x - frame.x - bar) < 2, `${kind}: date rail sits on the conversation edge (${JSON.stringify(geometry)})`)
  assert.ok(Math.abs(history.width - (frame.width - bar)) < 2, `${kind}: date navigation fills the conversation frame`)
  assert.ok(Math.abs(popup.x - history.x - 48) < 2, `${kind}: popup clears the date rail by the shared offset`)
  assert.ok(Math.abs(popup.y - history.y - 8) < 2, `${kind}: popup sits at the transcript top`)
  assert.equal(await box.getByRole("region").evaluate((el) => el.scrollWidth > el.clientWidth), false, `${kind}: popup fits`)
  return box.getByRole("region").evaluate((el) => {
    const style = getComputedStyle(el)
    return Object.fromEntries(["backgroundColor", "borderRadius", "borderWidth", "padding", "fontSize", "boxShadow"].map((key) => [key, style[key]]))
  })
}

for (const [engine, browserType] of [["chromium", chromium], ["webkit", webkit]]) {
  if (process.env.CHAT_DAYS_BROWSER && process.env.CHAT_DAYS_BROWSER !== engine) continue
  const browser = await browserType.launch({ ...(engine === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) })
  try {
  for (const kind of ["coordinator", "captain", "task"]) {
    if (process.env.CHAT_DAYS_KIND && process.env.CHAT_DAYS_KIND !== kind) continue
    const context = await browser.newContext({ viewport: { width: 400, height: 844 }, reducedMotion: "reduce", isMobile: true, hasTouch: true })
    await fixture(context)
    const page = await context.newPage()
    const errors = []
    page.on("pageerror", (e) => errors.push(String(e)))
    const box = await open(page, kind)
    const first = box.locator("nav button").first()
    const firstId = messages[0].id
    assert.equal(await box.locator(`[data-day-start="${firstId}"]`).count(), 0, "old day starts outside useTail")
    const before = await box.locator("[data-scroller]").evaluate((el) => el.scrollTop)
    await first.tap()
    await box.locator('[role="region"]').waitFor()
    assert.equal(await box.locator("[data-scroller]").evaluate((el) => el.scrollTop), before, "first tap only previews")
    const sourceId = messages.find((m) => m.role === "notice").id
    assert.equal(await box.locator(`[data-chat-id="${sourceId}"], [id="captain-${sourceId}"]`).count(), 0, "source isn't rendered yet")
    const bullet = box.locator('[data-summary-jump]').first()
    assert.match(await bullet.innerText(), /Jump to message/)
    await bullet.tap()
    const source = box.locator('[data-chat-highlight]')
    await source.waitFor()
    assert.equal(await source.evaluate((el) => el.dataset.chatId ?? el.id.replace(/^(?:captain|chat)-/, "")), sourceId, "jump opens its grouped source")
    if (kind === "coordinator") assert.equal(await source.getAttribute("data-testid"), "update-chip", "highlight the message rather than the group wrapper")
    assert.equal(await source.evaluate((el) => el === document.activeElement), true, "source takes keyboard focus")
    assert.equal(await box.locator('[role="region"]').count(), 0, "source jump closes the preview")
    const sourceY = await source.evaluate((el) => el.getBoundingClientRect().top)
    await wait(page)
    assert.ok(Math.abs(await source.evaluate((el) => el.getBoundingClientRect().top) - sourceY) < 2, "source stays put after layout settles")
    await page.keyboard.press("Tab")
    await page.waitForFunction(() => !document.querySelector('[data-chat-highlight]'))
    if (kind === "task") {
      // A second jump must reopen the same group after the reader folds it again.
      await box.getByRole("button", { name: "Hide 1 earlier event", exact: true }).first().tap()
      await first.tap()
      await box.locator('[data-summary-jump]').first().tap()
      await box.locator('[data-chat-highlight]').waitFor()
      await page.keyboard.press("Tab")
    }
    const beforeRepeat = await box.locator("[data-scroller]").evaluate((el) => el.scrollTop)
    await first.tap()
    await first.tap()
    assert.equal(await box.locator('[role="region"]').count(), 1, "repeated day taps keep the preview open")
    assert.equal(await box.locator("[data-scroller]").evaluate((el) => el.scrollTop), beforeRepeat, "repeated day taps do not jump")
    await box.getByRole("button", { name: "Jump to day", exact: true }).tap()
    const divider = box.locator(`[data-day-start="${firstId}"]`)
    await divider.waitFor()
    await page.waitForFunction((el) => Math.abs(el.getBoundingClientRect().top - el.closest("[data-scroller]").getBoundingClientRect().top - 12) < 3,
      await divider.elementHandle())
    const offset = await divider.evaluate((el) => el.getBoundingClientRect().top - el.closest("[data-scroller]").getBoundingClientRect().top)
    if (Math.abs(offset - 12) >= 3) {
      await page.screenshot({ path: `${output}/${engine}-${kind}-failure.png` })
      console.log(await box.locator("[data-scroller]").evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, view: el.clientHeight, rows: el.firstElementChild.children.length })))
    }
    assert.ok(Math.abs(offset - 12) < 3, `jump aligns the day start (${offset})`)
    if (kind === "coordinator") {
      // Add at the bottom while reading an old day: WebKit must not repin or shift the reader.
      const y = await divider.evaluate((el) => el.getBoundingClientRect().top)
      await page.evaluate((message) => window.__streams.forEach((s) => s.onmessage?.({ data: JSON.stringify({ type: "chat.message", message }) })), {
        id: "chat_late-update", role: "assistant", content: "A new update arrived while you were reading yesterday.", meta: null, createdAt: Date.now(),
      })
      await wait(page)
      assert.ok(Math.abs(await divider.evaluate((el) => el.getBoundingClientRect().top) - y) < 2, "new messages preserve the old day")
      // Reflow an old row above a reader near the bottom, the WebKit scroll-anchor caveat (#344).
      await box.locator("[data-scroller]").evaluate((el) => { el.scrollTop = el.scrollHeight - el.clientHeight - 600 })
      await wait(page)
      const spot = await box.locator("[data-scroller]").evaluate((el) => {
        const top = el.getBoundingClientRect().top
        const row = [...el.querySelectorAll('[id^="chat-"]')].find((r) => r.getBoundingClientRect().top >= top)
        return { id: row.id, y: row.getBoundingClientRect().top }
      })
      await page.evaluate((message) => window.__streams.forEach((s) => s.onmessage?.({ data: JSON.stringify({ type: "chat.message", message }) })), { ...messages[1], content: "An older reply grew while reading. ".repeat(80) })
      await wait(page)
      const after = await box.locator(`[id="${spot.id}"]`).evaluate((el) => el.getBoundingClientRect().top)
      assert.ok(Math.abs(after - spot.y) < 2, `rows above can reflow without moving the reader (${after - spot.y})`)
    }
    await box.getByRole("button", { name: /^Yesterday: preview/ }).tap()
    const popup = box.locator('[role="region"]')
    const links = popup.locator("a")
    const expected = ["https://github.com/example/studio/issues/318", "https://github.com/example/studio/pull/42"]
    if (kind !== "task") expected.push("https://github.com/example/docs/issues/27", "https://github.com/example/docs/issues/28")
    assert.deepEqual(await links.evaluateAll((els) => els.map((a) => a.href)), expected)
    for (const link of await links.all()) {
      const rect = await link.boundingBox()
      assert.ok(rect.width >= 44 && rect.height >= 44, "references have 44px tap targets")
      assert.equal(await link.getAttribute("target"), "_blank")
    }
    const scrollBeforeLink = await box.locator("[data-scroller]").evaluate((el) => el.scrollTop)
    const [tab] = await Promise.all([page.waitForEvent("popup"), links.first().tap()])
    await tab.waitForLoadState()
    assert.equal(tab.url(), expected[0])
    await tab.close()
    assert.equal(await popup.count(), 1, "a reference keeps the day summary open")
    assert.equal(await box.locator("[data-scroller]").evaluate((el) => el.scrollTop), scrollBeforeLink, "a reference does not jump the chat")
    assert.deepEqual(errors, [])
    console.log(`${engine} ${kind}: touch preview, hidden-day jump, alignment${kind === "coordinator" ? ", SSE and reflow anchoring" : ""}, reference links, isolated new-tab taps, grouped-source jump and static highlight passed`)
    await context.close()
  }
  const referenceStyle = new Map()
  for (const kind of ["coordinator", "captain", "task", "subtask"]) {
    if (process.env.CHAT_DAYS_KIND && process.env.CHAT_DAYS_KIND !== kind) continue
    for (const mobile of [false, true]) {
      const context = await browser.newContext({ viewport: { width: mobile ? 400 : 1280, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile })
      await fixture(context, true)
      const page = await context.newPage()
      const errors = []
      page.on("pageerror", (e) => errors.push(String(e)))
      const box = await open(page, kind)
      const list = box.locator("[data-scroller]")
      const lastDay = box.locator("nav button").last()
      const before = await list.evaluate((el) => el.scrollTop)
      await lastDay.dblclick()
      const popup = box.getByRole("region")
      await popup.waitFor()
      await wait(page)
      assert.equal(await list.evaluate((el) => el.scrollTop), before, "double click only opens the summary")
      const bounds = await box.boundingBox()
      const panel = await popup.boundingBox()
      assert.ok(Math.abs(panel.y - bounds.y - 8) < 2, "navigation opens at the top regardless of the selected day")
      const style = await placement(box, kind)
      if (kind === "coordinator") referenceStyle.set(mobile, style)
      else if (referenceStyle.has(mobile)) assert.deepEqual(style, referenceStyle.get(mobile), `${kind}: same date panel appearance as the Coordinator`)
      if (!process.env.CHAT_DAYS_CHECKS_ONLY) await page.screenshot({ path: `${output}/${engine}-${kind}-${mobile ? "mobile" : "desktop"}-navigation.png` })
      const actions = popup.getByRole("group", { name: "Transcript navigation" })
      const start = actions.getByRole("button", { name: "Jump to start", exact: true })
      const end = actions.getByRole("button", { name: "Jump to end", exact: true })
      for (const button of [start, end]) {
        const rect = await button.boundingBox()
        assert.ok(rect.height >= 44, "explicit navigation has 44px touch targets")
      }
      assert.ok((await actions.boundingBox()).y < (await popup.getByRole("button", { name: "Jump to day", exact: true }).boundingBox()).y, "start/end precede day selection")
      assert.equal(await box.locator(`[data-day-start="${retained[0].id}"]`).count(), 0, "oldest content is outside the API tail and rendered tail")
      // Native Tab/Enter and Tab/Space activation exercise the actual browser focus path.
      await lastDay.focus()
      await page.keyboard.press("Tab") // Close summary
      await page.keyboard.press("Tab") // Jump to start
      assert.equal(await start.evaluate((el) => el === document.activeElement), true)
      await page.keyboard.press("Enter")
      const oldest = box.locator(`[data-day-start="${retained[0].id}"]`)
      await oldest.waitFor()
      await page.waitForFunction((el) => el === document.activeElement, await oldest.elementHandle())
      await wait(page)
      assert.ok(await list.evaluate((el) => el.scrollTop < 40), "start reveals and aligns the oldest content")
      const rendered = await list.getByText(/^Earlier conversation \d+\. Keep the navigation clear on phones and desktops\.$/).count()
      assert.ok(rendered > 0 && rendered <= 200, `retained history keeps a bounded DOM (${rendered} messages)`)
      const y = await oldest.evaluate((el) => el.getBoundingClientRect().top)
      await wait(page)
      assert.ok(Math.abs(await oldest.evaluate((el) => el.getBoundingClientRect().top) - y) < 2, "oldest content stays put after layout")
      await lastDay.click()
      await lastDay.focus()
      await page.keyboard.press("Tab")
      await page.keyboard.press("Tab")
      await page.keyboard.press("Tab")
      assert.equal(await end.evaluate((el) => el === document.activeElement), true)
      await page.keyboard.press("Space")
      await page.waitForFunction((el) => el === document.activeElement && Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 2, await list.elementHandle())
      assert.equal(await oldest.count(), 0, "end returns to the live tail")
      const late = { id: `chat_end-${kind}-${mobile}`, role: "assistant", content: "A new reply after returning to the end. ".repeat(12), meta: null, createdAt: Date.now(),
        ...(isTask(kind) ? { taskId: taskFor(kind).id } : kind === "captain" ? { projectId: project.id } : {}) }
      const type = isTask(kind) ? "task.message" : kind === "captain" ? "captain.message" : "chat.message"
      await page.evaluate((event) => window.__streams.forEach((s) => s.onmessage?.({ data: JSON.stringify(event) })), { type, message: late })
      await page.waitForFunction((el) => el.textContent.includes("A new reply after returning") && Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 2, await list.elementHandle())
      assert.equal(await box.getByRole("region").count(), 0)
      assert.deepEqual(errors, [])
      console.log(`${engine} ${kind} ${mobile ? "mobile" : "desktop"}: double click, top placement, retained start, keyboard start/end, bounded DOM and live end pin passed`)
      await context.close()
    }
  }
  // Wide filling columns expose the former outer width cap. Stacked and folded-sidebar columns also have
  // borders or a sub-task bar: navigation belongs at the conversation edge, after that bar, at every depth.
  for (const [kind, width, stacked, folded] of [
    ["task", 1800, false, false], ["subtask", 1800, false, false],
    ["subtask", 2300, true, false], ["subtask", 1280, true, false],
    ["task", 1800, false, true], ["subtask", 1800, false, true],
  ]) {
    if (process.env.CHAT_DAYS_KIND && process.env.CHAT_DAYS_KIND !== kind) continue
    const context = await browser.newContext({ viewport: { width, height: 900 } })
    await fixture(context)
    const page = await context.newPage()
    const box = await open(page, kind, stacked)
    if (folded) {
      await page.getByRole("button", { name: "Fold the sidebar", exact: true }).click()
      await wait(page)
    }
    await box.locator("nav button").last().click()
    await box.getByRole("region").waitFor()
    await placement(box, kind)
    const popup = await box.getByRole("region").boundingBox()
    assert.ok(popup.x >= 0 && popup.x + popup.width <= width, "date panel stays in the visible conversation")
    if (!process.env.CHAT_DAYS_CHECKS_ONLY) await page.screenshot({ path: `${output}/${engine}-${kind}-${width}${stacked ? "-stacked" : ""}${folded ? "-folded" : ""}-placement.png` })
    console.log(`${engine} ${kind} ${width}px${stacked ? " stacked" : ""}${folded ? " folded sidebar" : ""}: date navigation matches the full conversation frame`)
    await context.close()
  }
  if (engine === "chromium" && !process.env.CHAT_DAYS_CHECKS_ONLY) {
    for (const width of [320, 400, 560, 800]) {
      for (const zoom of [1, 1.25]) {
        // Browser zoom shrinks the CSS layout viewport and scales its pixels. CSS zoom on <html> would instead
        // make a 100dvh app taller than the screen and clip its header/composer.
        const context = await browser.newContext({ viewport: { width: Math.round(width / zoom), height: Math.round(900 / zoom) }, deviceScaleFactor: zoom, hasTouch: true, isMobile: true })
        await fixture(context)
        const page = await context.newPage()
        for (const kind of ["coordinator", "captain", "task", "subtask"]) {
          const box = await open(page, kind)
          const yesterday = box.getByRole("button", { name: /^Yesterday: preview/ })
          await yesterday.tap()
          await box.getByRole("button", { name: "Jump to day", exact: true }).tap()
          await wait(page)
          await yesterday.tap()
          await box.locator('[role="region"]').waitFor()
          await placement(box, kind)
          const overflows = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
          assert.equal(overflows, false, `${width}px at ${zoom} doesn't overflow`)
          assert.equal(await box.locator('[role="region"]').evaluate((el) => el.scrollWidth > el.clientWidth), false, "summary fits its panel")
          const suffix = `${width}${zoom > 1 ? "-zoom125" : ""}`
          await page.screenshot({ path: `${output}/${kind}-jump-before-${suffix}.png` })
          const bullet = box.locator('[data-summary-jump]').last()
          await bullet.locator('span').last().tap()
          const source = box.locator('[data-chat-highlight]')
          await source.waitFor()
          await wait(page)
          assert.equal(await box.locator('[role="region"]').count(), 0)
          assert.equal(await source.evaluate((el) => getComputedStyle(el).outlineWidth), "2px")
          assert.equal(await source.evaluate((el) => getComputedStyle(el).animationName), "none")
          const actions = source.locator(':scope > [data-message-actions]')
          if (await actions.count()) {
            const actionBounds = await actions.boundingBox()
            const listBounds = await box.locator('[data-scroller]').boundingBox()
            assert.ok(actionBounds.y >= listBounds.y, "focused message actions aren't clipped above the source")
          }
          const bounds = await source.boundingBox()
          const view = await box.locator('[data-scroller]').boundingBox()
          assert.ok(bounds.y >= view.y - 2 && bounds.y < view.y + view.height, "destination is visible")
          await page.screenshot({ path: `${output}/${kind}-jump-after-${suffix}.png` })
        }
        console.log(`${engine} ${width}px at ${zoom}: all chat panels fit; explicit day and source navigation passed`)
        await context.close()
      }
    }
  }
  } finally { await browser.close() }
}
