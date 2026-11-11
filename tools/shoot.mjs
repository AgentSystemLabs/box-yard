import { chromium } from "playwright-core"
import fs from "fs"
const R = process.argv[2] || "1", OUT = `/tmp/ux/round-${R}`, B = "http://localhost:4011", TID = "task_heavy-thread"
fs.mkdirSync(OUT, { recursive: true })
const exe = fs.globSync(process.env.HOME + "/.cache/ms-playwright/chromium-*/chrome-linux-arm64/chrome")[0]
const browser = await chromium.launch({ executablePath: exe })
const lines = []
const sizes = { 1440: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, 400: { viewport: { width: 400, height: 800 }, deviceScaleFactor: 2, hasTouch: true }, 320: { viewport: { width: 320, height: 700 }, deviceScaleFactor: 2, hasTouch: true }, z125: { viewport: { width: 1152, height: 720 }, deviceScaleFactor: 1.25 } }
async function page(sz, scheme = "dark") { const c = await browser.newContext({ ...sizes[sz], colorScheme: scheme }); return c.newPage() }
async function shot(p, name, desc) { await p.waitForTimeout(900); await p.screenshot({ path: `${OUT}/${name}.png` }); lines.push(`- ${name}.png: ${desc}`) }
const SEARCH = 'input[aria-label="Search Box Yard"]'
async function palette(p, path = "/") { await p.goto(B + path); await p.waitForTimeout(1800); await p.keyboard.press("Control+k"); await p.waitForSelector(SEARCH) }
for (const sz of ["1440", "400", "320"]) {
  const p = await page(sz)
  await palette(p); await shot(p, `palette-empty-${sz}`, `palette open, empty query, ${sz}px`)
  await p.keyboard.type("box"); await shot(p, `palette-query-${sz}`, `palette with query "box" (tasks, projects, settings), ${sz}px`)
  if (sz === "1440") {
    for (let i = 0; i < 3; i++) await p.keyboard.press("ArrowDown")
    await shot(p, `palette-keyboard-${sz}`, "palette after 3× ArrowDown: keyboard selection")
    await p.fill(SEARCH, "zzqxv nothing"); await shot(p, `palette-noresults-${sz}`, "palette no-results state")
    await p.fill(SEARCH, "new task"); await shot(p, `palette-newtask-${sz}`, 'palette query "new task": the New task… command')
    await p.keyboard.press("Escape"); await p.waitForTimeout(300); await p.mouse.click(700, 450); await p.keyboard.press("Shift+?"); await shot(p, `shortcuts-${sz}`, "shortcuts help sheet (?)")
  }
  if (sz === "400") { await p.fill(SEARCH, "zzqxv nothing"); await shot(p, `palette-noresults-${sz}`, "palette no-results state, 400") }
  await p.context().close()
}
for (const sz of ["1440", "400"]) {
  const p = await page(sz)
  await palette(p, "/tasks/" + TID)
  await p.keyboard.type("new task"); await p.waitForTimeout(400); await p.keyboard.press("Enter")
  await shot(p, `palette-newtask-dialog-${sz}`, `New task dialog opened from the palette (empty), ${sz}`)
  await p.keyboard.type("Add a retry with backoff to the acme/example-api webhook client.")
  await shot(p, `palette-newtask-dialog-filled-${sz}`, `palette New task dialog filled, ${sz}`)
  if (sz === "400") { await p.locator('[data-testid="new-task-options"]').first().click().catch(() => {}); await shot(p, `palette-newtask-options-400`, "New task dialog with the Runs with options unfolded, 400") }
  // keep the draft, reopen palette: draft subtitle
  await p.keyboard.press("Escape"); await p.waitForTimeout(500)
  if (sz === "400") { await p.keyboard.press("Control+k").catch(() => {}); await p.waitForTimeout(800); await shot(p, `palette-draft-400`, "palette reopened after cancelling a New task draft: draft subtitle") }
  await p.context().close()
}
async function select(p) {
  await p.evaluate(() => { const h = innerHeight, w = innerWidth; let el = null; for (const y of [0.6, 0.5, 0.4, 0.7, 0.3]) { const e = document.elementFromPoint(w * 0.55, h * y)?.closest(".prose-chat p, .prose-chat li"); if (e) { el = e; break } } const r=document.createRange(); r.selectNodeContents(el); const s=getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event("selectionchange")); window.dispatchEvent(new PointerEvent("pointerup")) })
  await p.waitForTimeout(600)
}
for (const [sz, scheme, tag] of [["1440", "dark", ""], ["400", "dark", ""], ["1440", "light", "-light"], ["z125", "dark", ""]]) {
  const p = await page(sz, scheme)
  try {
    await p.goto(B + "/tasks/" + TID); await p.waitForTimeout(2500); await select(p)
    await shot(p, `selection-chip-${sz}${tag}`, `text selected in a task transcript: the New task from selection action, ${sz}${tag}`)
    await p.getByRole("button", { name: /new task/i }).last().click()
    await shot(p, `newtask-empty-${sz}${tag}`, `New task popover from selection (quote, empty instructions), ${sz}${tag}`)
    if (scheme === "dark" && sz !== "z125") {
      const all = p.getByRole("button", { name: /show all/i }).first()
      if (sz === "400" && await all.count()) { await all.click(); await shot(p, `newtask-showall-400`, "popover quote expanded with Show all, 400"); await p.locator("textarea").last().focus() }
      await p.keyboard.type("Add a retry with backoff to the acme/example-api webhook client.")
      await shot(p, `newtask-filled-${sz}`, `New task popover with instructions typed, ${sz}`)
      if (sz === "1440") {
        await p.keyboard.press("Enter"); await shot(p, `sent-toast-1440`, "after Send to the Coordinator: the Sent toast with Open chat")
      } else {
        await p.getByRole("button", { name: /start it myself|more options/i }).first().click({ force: true })
        await shot(p, `newtask-dialog-${sz}`, `full New task dialog from selection, ${sz}`)
      }
    }
  } catch (e) { console.error(sz, tag, e.message.split("\n")[0]) }
  await p.context().close()
}
// mid-screen selection on phone: bar above the composer
{ const p = await page("400"); await p.goto(B + "/tasks/" + TID); await p.waitForTimeout(2500)
  await p.evaluate(() => { const ps=[...document.querySelectorAll(".prose-chat p")].filter(e=>{const r=e.getBoundingClientRect(); return r.top>200 && r.bottom<innerHeight*0.55}); const el=ps[0]; if(!el) return; const r=document.createRange(); r.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(r); document.dispatchEvent(new Event("selectionchange")); window.dispatchEvent(new PointerEvent("pointerup")) })
  await shot(p, "selection-chip-mid-400", "phone: selection mid-screen, bar placement"); await p.context().close() }
fs.writeFileSync(`${OUT}/SHOTS.md`, lines.join("\n") + "\n")
await browser.close()
