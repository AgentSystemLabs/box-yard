// Real-browser proof of the selection's Ask / Create task against an isolated mock server (never the live yard):
// the actions on highlighted text in a chat, a side thread and a task's transcript, nested threads and the way back,
// the Create task message, 44px touch targets and no sideways scroll, at 320-1440px, 100% and 125% zoom, touch and mouse.
//   npm run build
//   PORT=4012 BOXYARD_MOCK=1 BOXYARD_DATA_DIR=/tmp/selection-proof node dist/server/server/index.js
//   PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROME_PATH=/path/to/chrome \
//     node scripts/check-selection-actions.mjs http://localhost:4012 /tmp/selection-proof/shots
// ONLY=400-100-touch,800-125-mouse runs those cases. API fixtures use example data only.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
const base = process.argv[2] ?? "http://localhost:4012"
assert.match(base, /^http:\/\/(localhost|127\.0\.0\.1):\d+$/, "Use an isolated mock server on this computer")
const out = process.argv[3] ?? "/tmp/selection-proof/shots"
const only = process.env.ONLY ?? ""
await mkdir(out, { recursive: true })
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright-core")
const now = Date.now()
const project = { id: "prj_example", name: "example-app", repo: "acme/example-app", description: "", notes: [], envKeys: [], baseBranch: "main", runner: "box", identityId: "idn_default", gpuMachine: { gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null }, docker: { image: null, dockerfile: null }, createdAt: now, color: null }
const task = { id: "task_example01", projectId: project.id, title: "Add retry backoff to the sync worker", status: "idle", prompt: "", branch: "sync-retry-backoff", prUrl: null, prState: null, prMergedAt: null, previews: [], waitFor: [], question: null, error: null, scheduleId: null, outcome: null, turnCount: 1, pendingCount: 0, parentTaskId: null, rootTaskId: null, subtaskDepth: 0, createdAt: now - 3_600_000, updatedAt: now - 60_000 }
const REPLY = "The sync worker in `server/sync.ts` never backs off: when the upstream API returns 429 it retries at once, in a tight loop, which spins the CPU and gets the token rate-limited for longer.\n\nTwo things would fix it:\n\n1. Exponential backoff with jitter, capped at 60 seconds.\n2. Honour the `Retry-After` header when the API sends one.\n\nThe webhook receiver has the same loop, but it only retries three times, so it is less urgent."
const chat = [
  { id: "chat_user0001", role: "user", content: "Why did the sync job burn so much CPU last night?", meta: null, createdAt: now - 600_000 },
  { id: "chat_reply001", role: "assistant", content: REPLY, meta: null, createdAt: now - 590_000 },
]
const captain = [
  { id: "cap_user0001", projectId: project.id, role: "user", content: "How is the retry work going?", meta: null, createdAt: now - 500_000 },
  { id: "cap_reply001", projectId: project.id, role: "assistant", content: "The backoff task is ready for review. It adds exponential backoff with jitter to the sync worker and a unit test for the 429 path. The webhook receiver still retries without a delay.", meta: null, createdAt: now - 490_000 },
]
const transcript = [
  { id: "tm_user01", taskId: task.id, role: "user", content: "Add retry backoff to the sync worker.", meta: null, createdAt: now - 400_000 },
  { id: "tm_reply1", taskId: task.id, role: "assistant", content: "Done. The worker now waits `min(60s, 2^n × 500ms)` plus up to 20% jitter between tries, and stops after eight attempts.\n\nI left the webhook receiver alone: it shares the retry helper but passes its own fixed delay, and changing it would alter the delivery order that the billing export depends on.", meta: null, createdAt: now - 380_000 },
]
const thr = (over) => ({ projectId: null, anchorId: "chat_reply001", parentId: null, kind: "ask", context: "fork", busy: false, replies: 2, unread: false, resolvedAt: null, createdAt: now - 300_000, updatedAt: now - 290_000, taskId: null, ...over })
const A = thr({ id: "thr_parent01", quote: "retries at once, in a tight loop" })
const B = thr({ id: "thr_child001", parentId: A.id, quote: "no delay between the tries" })
const C = thr({ id: "thr_grand001", parentId: B.id, quote: "the nightly import" , replies: 2 })
const T = thr({ id: "thr_task0001", projectId: project.id, anchorId: task.id, quote: "the delivery order that the billing export depends on" })
const TB = thr({ id: "thr_task0002", projectId: project.id, anchorId: task.id, parentId: T.id, quote: "sorts by arrival time" })
const qa = (id, q, a) => [
  { id: `thm_q_${id}`, threadId: id, role: "user", content: q, meta: null, createdAt: now - 280_000 },
  { id: `thm_a_${id}`, threadId: id, role: "assistant", content: a, meta: null, createdAt: now - 270_000 },
]
const threadMessages = {
  [A.id]: qa(A.id, "Why does it retry straight away?", "Because `retry()` in `server/sync.ts` calls itself with no delay between the tries. The loop was written for network blips, where an instant retry usually works, and nobody revisited it when the upstream API started rate limiting."),
  [B.id]: qa(B.id, "Is that only the sync worker?", "No. The nightly import uses the same helper, so it has the same instant retries. The webhook receiver passes its own fixed delay."),
  [C.id]: qa(C.id, "When does it run?", "The nightly import runs at 02:00 UTC from the scheduler, and takes about four minutes."),
  [T.id]: qa(T.id, "Which order is that?", "The billing export sorts by arrival time, so a delayed retry would move a webhook later in the export than the events that followed it."),
  [TB.id]: qa(TB.id, "Could it sort by event time instead?", "Yes: each webhook carries `occurred_at`. Sorting by it would make the export independent of retry timing."),
}
const sent = []
async function fixture(context) {
  await context.addInitScript(() => {
    window.EventSource = class { addEventListener() {} removeEventListener() {} close() {} }
    window.speechSynthesis = { getVoices: () => [], cancel() {}, addEventListener() {}, removeEventListener() {} }
  })
  await context.route("**/api/**", async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname
    const method = req.method()
    if (path === "/api/boot" || path === "/api/stream") return route.abort()
    if (method === "POST") {
      const body = req.postDataJSON?.() ?? {}
      sent.push({ path, body })
      if (path === "/api/threads") {
        const t = thr({ id: body.id, projectId: body.projectId ?? null, anchorId: body.anchorId, parentId: body.parentId ?? null, quote: body.quote, busy: true, replies: 1, context: null, createdAt: Date.now(), updatedAt: Date.now() })
        return route.fulfill({ status: 201, json: { thread: t, message: { id: body.messageId, threadId: t.id, role: "user", content: body.question, meta: null, createdAt: Date.now() } } })
      }
      if (path === "/api/chat") return route.fulfill({ status: 201, json: { id: body.id, role: "user", content: body.content, meta: null, createdAt: Date.now() } })
      if (path === `/api/projects/${project.id}/captain/messages`) return route.fulfill({ status: 201, json: { id: body.id, projectId: project.id, role: "user", content: body.content, meta: null, createdAt: Date.now() } })
      if (/\/seen$/.test(path)) return route.fulfill({ json: {} })
      return route.continue()
    }
    let body
    if (path.endsWith("/history")) {
      const list = path.startsWith("/api/tasks/") ? transcript : path.includes("/captain/") ? captain : chat
      return route.fulfill({ json: url.searchParams.has("days") ? { days: [{ at: list[0].createdAt, messageId: list[0].id }], oldestId: list[0].id } : { messages: list, before: null, after: null } })
    }
    if (path === "/api/chat") body = chat
    else if (path === "/api/tasks") body = [task]
    else if (path === "/api/projects") body = [project]
    else if (path === `/api/projects/${project.id}`) body = project
    else if (path === `/api/projects/${project.id}/captain/messages`) body = captain
    else if (path === `/api/projects/${project.id}/captain`) body = { busy: false, sessionId: null, pendingCount: 0, error: null, usage: { tokens: 0, window: 200000, updatedAt: now } }
    else if (path === "/api/threads") body = url.searchParams.get("projectId") === project.id ? [T, TB] : [A, B, C]
    else if (/^\/api\/threads\/[^/]+\/messages$/.test(path)) body = threadMessages[path.split("/")[3]] ?? []
    else if (/^\/api\/tasks\/[^/]+\/messages$/.test(path)) body = transcript
    else if (path === `/api/tasks/${task.id}`) body = task
    else if (path.startsWith(`/api/tasks/${task.id}/`)) body = []
    else if (path.startsWith(`/api/projects/${project.id}/`) && /\/(compactions|queue)$/.test(path)) body = []
    else if (path === "/api/me") body = { authed: true, authRequired: false }
    else return route.continue()
    return route.fulfill({ json: body })
  })
}

/** Select `text` inside the last visible element matching `scope`, as a drag would. */
async function select(page, scope, text) {
  const ok = await page.evaluate(([scope, text]) => {
    const roots = [...document.querySelectorAll(scope)].filter((el) => el.getClientRects().length)
    for (const root of roots.reverse()) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.data.indexOf(text)
        if (i < 0) continue
        const range = document.createRange()
        range.setStart(n, i)
        range.setEnd(n, i + text.length)
        const sel = getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
        document.dispatchEvent(new Event("selectionchange"))
        return true
      }
    }
    return false
  }, [scope, text])
  assert.ok(ok, `selected “${text}” in ${scope}`)
  await page.waitForTimeout(150)
}
const visible = (page, sel) => page.locator(sel).filter({ visible: true }).first()
const results = []
const failures = []
const check = (tag, name, ok, detail = "") => { results.push(`${ok ? "ok  " : "MISS"} ${tag}: ${name}${detail ? ` (${detail})` : ""}`); if (!ok) failures.push(`${tag}: ${name}`) }
/** Every visible control in `sel` is at least 44px to a finger (its own box, or its ::before tap area). */
async function tapSizes(page, sel) {
  return page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((el) => el.getClientRects().length).map((el) => {
    const r = el.getBoundingClientRect()
    const area = ["::before", "::after"].map((p) => getComputedStyle(el, p)).filter((s) => s.content !== "none" && s.position === "absolute")
    const bh = Math.max(0, ...area.map((s) => parseFloat(s.height) || 0))
    const bw = Math.max(0, ...area.map((s) => parseFloat(s.width) || 0))
    return { label: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40), w: Math.max(r.width, bw), h: Math.max(r.height, bh) }
  }), sel)
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

const CASES = [
  { width: 320, zoom: 1, touch: true },
  { width: 400, zoom: 1, touch: true },
  { width: 560, zoom: 1, touch: true },
  { width: 800, zoom: 1, touch: false },
  { width: 800, zoom: 1.25, touch: false },
  { width: 1440, zoom: 1, touch: false },
  { width: 1440, zoom: 1.25, touch: false },
]
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH })
try {
  for (const c of CASES) {
    const tag = `${c.width}-${c.zoom === 1 ? "100" : "125"}-${c.touch ? "touch" : "mouse"}`
    if (only && !only.split(",").includes(tag)) continue
    const context = await browser.newContext({ viewport: { width: Math.floor(c.width / c.zoom), height: Math.floor((c.width >= 800 ? 900 : 760) / c.zoom) }, deviceScaleFactor: c.zoom * (c.width < 800 ? 2 : 1), hasTouch: c.touch, isMobile: c.touch })
    await fixture(context)
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)
    page.on("pageerror", (e) => { failures.push(`${tag}: pageerror ${e.message}`); console.error(`${tag}: ${e.stack}`) })
    const shot = (name) => page.screenshot({ path: `${out}/${name}-${tag}.png` })
    const action = (key) => visible(page, c.touch ? `[data-testid=selection-${key}-bar]` : `[data-testid=selection-${key}]`)
    const press = (loc) => (c.touch ? loc.tap() : loc.click())
    const thread = () => visible(page, "[data-testid=side-thread]")
    const closeToast = async () => { await press(visible(page, 'button[aria-label="Dismiss"]')); await page.waitForTimeout(250) }
    // A phone's Enter is a new line: its Send button sends.
    const sendIn = (scope) => (c.touch ? scope.locator('button[aria-label="Send"]').filter({ visible: true }).first().tap() : scope.locator("textarea").press("Enter"))

    // ── The Coordinator's chat ────────────────────────────────────────────────
    await page.goto(`${base}/`)
    const chatSel = "[data-testid=chat-panel] [data-chat-id=chat_reply001]"
    await visible(page, chatSel).waitFor()
    await page.waitForTimeout(500)
    await select(page, chatSel, "retries at once, in a tight loop")
    await action("ask").waitFor()
    const labels = await page.locator("[data-selection-task-action] button").filter({ visible: true }).allTextContents()
    check(tag, "selection offers Ask and Create task", labels.map((l) => l.trim()).join("|") === "Ask|Create task", labels.join("|"))
    if (c.touch) {
      const sizes = await tapSizes(page, "[data-selection-task-action] button")
      check(tag, "bar buttons are 44px", sizes.every((s) => s.h >= 44 && s.w >= 44), JSON.stringify(sizes))
    }
    check(tag, "no sideways scroll with the actions", (await overflow(page)) <= 1)
    const oneLine = async (name) => { const hs = await page.locator("[data-selection-task-action] button").filter({ visible: true }).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height)); check(tag, `${name}: each action is one line`, hs.every((h) => h <= (c.touch ? 50 : 30)), hs.join(",")) }
    await oneLine("chat")
    await shot("1-chat-selection")

    // Create task: the popover, then the confirmation.
    await press(action("task"))
    const dialog = page.locator("[role=dialog]").filter({ has: page.locator("[data-testid=selection-quote]") })
    await dialog.waitFor()
    await dialog.locator("textarea").fill("Add backoff with jitter to the sync worker, capped at 60 seconds")
    await page.waitForTimeout(200)
    const dbox = await dialog.boundingBox()
    const vw = page.viewportSize().width
    check(tag, "Create task popover fits the window", dbox.x >= -1 && dbox.x + dbox.width <= vw + 1, `${Math.round(dbox.x)}..${Math.round(dbox.x + dbox.width)} of ${vw}`)
    const submit = dialog.getByRole("button", { name: "Send to the Coordinator" })
    if (c.touch) { const b = await submit.boundingBox(); check(tag, "Send button is 44px", b.height >= 44, `${b.height}`) }
    await shot("2-create-task")
    sent.length = 0
    await press(submit)
    await page.getByText("Sent to the Coordinator").first().waitFor()
    const post = sent.find((s) => s.path === "/api/chat")
    check(tag, "Create task posts to the Coordinator's chat", Boolean(post) && post.body.content.includes("## Highlighted text\n> retries at once, in a tight loop") && post.body.content.includes("- Message: chat_reply001"))
    await shot("3-create-task-sent")
    await closeToast()
    if (tag === "800-100-mouse") console.log(`\n--- Create task message ---\n${post.body.content}\n---\n`)

    // Ask: a new question about the passage.
    await select(page, chatSel, "Honour the")
    await press(action("ask"))
    await thread().waitFor()
    const focused = await page.evaluate(() => document.activeElement?.tagName === "TEXTAREA" && Boolean(document.activeElement.closest("[data-testid=side-thread]")))
    check(tag, "Ask puts the caret in the thread's box", focused)
    await thread().locator("textarea").fill("Does the upstream API always send it?")
    check(tag, "no sideways scroll with the thread", (await overflow(page)) <= 1)
    await shot("4-ask-draft")
    sent.length = 0
    await sendIn(thread())
    await page.waitForTimeout(400)
    const asked = sent.find((s) => s.path === "/api/threads")
    check(tag, "Ask posts a thread on the passage", Boolean(asked) && asked.body.kind === "ask" && asked.body.quote === "Honour the" && asked.body.anchorId === "chat_reply001" && !asked.body.parentId)

    // An existing thread: highlight in its answer → the same actions → a nested question.
    await page.goto(`${base}/`)
    await visible(page, chatSel).waitFor()
    await page.waitForTimeout(400)
    await visible(page, "[data-testid=chat-panel] [data-testid=thread-marker]").click()
    await thread().locator("[data-testid=side-thread-reply]").first().waitFor()
    await page.waitForTimeout(300)
    await select(page, "[data-testid=side-thread] [data-testid=side-thread-reply]", "no delay between the tries")
    await action("ask").waitFor()
    await oneLine("thread")
    await shot("5-thread-selection")
    await press(action("ask"))
    await thread().locator("[data-testid=side-thread-parent]").waitFor()
    await shot("6-nested-draft")
    sent.length = 0
    await thread().locator("textarea").fill("Is that only the sync worker?")
    await sendIn(thread())
    await page.waitForTimeout(400)
    const nested = sent.find((s) => s.path === "/api/threads")
    check(tag, "a question from a thread nests under it", Boolean(nested) && nested.body.parentId === A.id && nested.body.quote === "no delay between the tries")

    // Three levels down, from the fixtures: the way back up, and the parent's list.
    await page.goto(`${base}/`)
    await visible(page, chatSel).waitFor()
    await page.waitForTimeout(400)
    await visible(page, "[data-testid=chat-panel] [data-testid=thread-marker]").click()
    const kids = () => thread().locator("[data-testid=side-thread-children] [data-testid=thread-marker]")
    await kids().first().waitFor()
    await shot("7-parent-lists-nested")
    if (c.touch) { const sizes = await tapSizes(page, "[data-testid=side-thread-children] [data-testid=thread-marker]"); check(tag, "nested chips are 44px to a finger", sizes.every((s) => s.h >= 44), JSON.stringify(sizes)) }
    await press(kids().first())
    await thread().locator("[data-testid=side-thread-parent]").waitFor()
    await press(kids().first())
    await page.waitForFunction(() => document.querySelector("[data-testid=side-thread] [data-testid=side-thread-quote]")?.textContent === "the nightly import")
    await page.waitForTimeout(200)
    await shot("8-nested-two-deep")
    const up = thread().locator("[data-testid=side-thread-parent]")
    const ub = await up.boundingBox()
    if (c.touch) check(tag, "the Asked in row is 44px", ub.height >= 44, `${ub.height}`)
    const dismiss = await thread().locator("[data-dismiss]").filter({ visible: true }).evaluateAll((els) => els.map((e) => e.getAttribute("data-dismiss")))
    check(tag, "one dismiss control on the thread", dismiss.length === 1, dismiss.join(","))
    await press(up)
    await page.waitForFunction(() => document.querySelector("[data-testid=side-thread] [data-testid=side-thread-quote]")?.textContent === "no delay between the tries")
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => document.querySelector("[data-testid=side-thread] [data-testid=side-thread-quote]")?.textContent === "retries at once, in a tight loop")
    check(tag, "Asked in and Esc each go up one level", true)

    // ── A task's transcript ────────────────────────────────────────────────────
    await page.goto(`${base}/?session=${task.id}`)
    const line = "[data-chat-id=tm_reply1]"
    await visible(page, line).waitFor().catch(async () => { await page.getByText("delivery order").first().waitFor() })
    await page.waitForTimeout(500)
    const scope = (await page.locator(line).count()) ? line : "body"
    await visible(page, "[data-testid=task-questions]").waitFor()
    await select(page, scope, "the delivery order that the billing export depends on")
    await action("ask").waitFor()
    await oneLine("task")
    await shot("9-task-selection")
    await press(action("task"))
    const tdialog = page.locator("[role=dialog]").filter({ has: page.locator("[data-testid=selection-quote]") })
    await tdialog.waitFor()
    await tdialog.locator("textarea").fill("Sort the billing export by event time")
    await shot("10-task-create-task")
    sent.length = 0
    await press(tdialog.getByRole("button", { name: "Send to example-app's Captain" }))
    await page.getByText("Sent to example-app's Captain").first().waitFor()
    const cap = sent.find((s) => s.path === `/api/projects/${project.id}/captain/messages`)
    check(tag, "Create task from a task posts to its project's Captain", Boolean(cap) && cap.body.content.includes(`- In the transcript of the task: ${task.title} (${task.id})`))
    await shot("10b-task-create-task-sent")
    await closeToast()
    if (tag === "800-100-mouse") console.log(`\n--- Create task message (task) ---\n${cap.body.content}\n---\n`)
    await select(page, scope, "the delivery order that the billing export depends on")
    await press(action("ask"))
    const sheet = visible(page, "[data-testid=task-question]")
    await sheet.waitFor()
    await sheet.locator("textarea").fill("Which order is that?")
    await shot("11-task-ask-draft")
    const sd = await sheet.locator("[data-dismiss]").filter({ visible: true }).evaluateAll((els) => els.map((e) => `${e.getAttribute("data-dismiss")}:${e.getAttribute("aria-label")}`))
    check(tag, "the task's thread has one Back to the task", sd.join("|") === "back:Back to the task", sd.join("|"))
    await page.keyboard.press("Escape")
    await sheet.waitFor({ state: "detached" })
    // The questions asked before, as chips above the box.
    const chips = visible(page, "[data-testid=task-questions]").locator("[data-testid=thread-marker]")
    check(tag, "the task lists its top-level questions only", (await chips.count()) === 1, `${await chips.count()}`)
    if (c.touch) { const sizes = await tapSizes(page, "[data-testid=task-questions] [data-testid=thread-marker]"); check(tag, "task chips are 44px to a finger", sizes.every((s) => s.h >= 44), JSON.stringify(sizes)) }
    await shot("12-task-asked-here")
    await press(chips.first())
    await sheet.locator("[data-testid=side-thread-reply]").first().waitFor()
    await page.waitForTimeout(200)
    await shot("13-task-thread")
    await press(sheet.locator("[data-testid=side-thread-children] [data-testid=thread-marker]").first())
    await sheet.locator("[data-testid=side-thread-parent]").waitFor()
    await page.waitForTimeout(200)
    await shot("14-task-nested-thread")
    check(tag, "no sideways scroll in the task's thread", (await overflow(page)) <= 1)
    await context.close()
  }
} finally {
  await browser.close()
}
console.log(results.join("\n"))
if (failures.length) { console.error(`\n${failures.length} failed:\n${failures.join("\n")}`); process.exit(1) }
console.log(`\n${results.length} checks passed`)
