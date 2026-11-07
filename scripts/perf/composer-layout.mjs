#!/usr/bin/env node
// Touch regression for the Coordinator/Captain composer. Isolated mock yard only; SSE is aborted and all chat
// POSTs are fulfilled in the browser, so no agent starts. A short draft and a capped long draft exercise the optional
// Expand control. Use --record to capture baseline failures without sending. Browser zoom is emulated, not iOS.
// PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROMIUM_PATH=/path/to/chrome \
//   node scripts/perf/composer-layout.mjs http://localhost:4260 /tmp/composer-shots [--record]
import fs from 'node:fs/promises'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const [base, out, mode] = process.argv.slice(2)
if (!base || !out) throw new Error('Pass an isolated mock URL and screenshot directory; --record reports baseline failures without sending')
const strict = mode !== '--record'
await fs.mkdir(out,{recursive:true})
const browser=await chromium.launch({...(process.env.CHROMIUM_PATH ? { executablePath:process.env.CHROMIUM_PATH } : {}),args:['--mute-audio']})
const results=[]
const cases=[320,400,560,800].flatMap(physical=>[1,1.25].map(zoom=>({physical,zoom,touch:true})))
cases.push({physical:800,zoom:1,touch:false},{physical:800,zoom:1,touch:false,panel:320})
try {
for(const {physical,zoom,touch,panel} of cases) {
 const context=await browser.newContext({viewport:{width:Math.round(physical/zoom),height:Math.round(900/zoom)},deviceScaleFactor:zoom,isMobile:touch,hasTouch:touch,reducedMotion:'reduce'})
 try {
 await context.addInitScript(()=>{
  localStorage.setItem('box-yard:setup-skipped','true')
  localStorage.setItem('boxyard:voice',JSON.stringify({enabled:false}))
  localStorage.setItem('boxyard:send-sound',JSON.stringify({enabled:false}))
  window.SpeechRecognition=class extends EventTarget { start(){} stop(){} abort(){} }
 })
 const page=await context.newPage(), errors=[]
 page.setDefaultTimeout(10000)
 page.on('pageerror',e=>errors.push(e.message))
 await page.route('**/api/stream',r=>r.abort())
 const sends=[]
 await page.route('**/api/chat',async r=>{
  if(r.request().method()!=='POST') return r.continue()
  const body=r.request().postDataJSON(); sends.push(body)
  return r.fulfill({json:{...body,role:'user',meta:{},createdAt:Date.now()}})
 })
 await page.goto(new URL('/',base).href)
 const footer=page.getByTestId('chat-footer'), input=footer.locator('textarea'), send=footer.getByRole('button',{name:'Send',exact:true})
 await input.waitFor()
 if(panel) await page.getByTestId('chat-panel').evaluate((el,width)=>el.style.width=`${width}px`,panel)
 await footer.getByTestId('mic').waitFor()
 for(const long of [false,true]) {
  const draft=long?'Please review the Coordinator on a small phone.\n'.repeat(35):'Check the mobile Coordinator preview'
  await input.fill(draft)
  if(long) await footer.getByRole('button',{name:'Expand editor',exact:true}).waitFor()
  const bounds=await footer.locator('form button').evaluateAll(buttons=>buttons.map(b=>{
   const r=b.getBoundingClientRect(), c=b.closest('form').getBoundingClientRect()
   const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)
   return {label:b.getAttribute('aria-label')||b.title,x:r.x,y:r.y,width:r.width,height:r.height,clipped:r.left<c.left||r.right>c.right||r.top<0||r.bottom>innerHeight,hit:hit===b||b.contains(hit)}
  }).filter(b=>b.width&&b.height))
  const prefix=touch?'':`desktop-${panel??'wide'}-`
  await page.screenshot({path:`${out}/${prefix}${physical}-${zoom}-${long?'long':'short'}.png`})
  const failures=bounds.filter(b=>b.clipped||b.width<(touch?44:24)||b.height<(touch?44:24)||!b.hit)
  results.push({physical,zoom,touch,panel,long,bounds,failures,errors})
  console.log(`${physical} at ${zoom*100}% ${touch?'touch':`mouse panel ${panel??'wide'}`} ${long?'long':'short'}: ${failures.length?JSON.stringify(failures):`all visible, tappable and ${touch?'44':'24+'}px`}`)

  if(strict&&!failures.length) {
   const expected=sends.length+1
   if(touch) await send.tap()
   else await send.click()
   await page.waitForFunction(()=>document.querySelector('[data-testid=chat-footer] textarea')?.value==='')
   if(sends.length!==expected||sends.at(-1).content!==draft.trim()) throw new Error('Send must deliver the draft once')
  }
 }
 if(errors.length) throw new Error(errors.join('; '))
 } finally {await context.close()}
}
}finally {await browser.close()}
await fs.writeFile(`${out}/checks.json`,JSON.stringify(results,null,2))

if(strict&&results.some(r=>r.failures.length)) throw new Error('Composer controls clipped or too small; see checks.json')
