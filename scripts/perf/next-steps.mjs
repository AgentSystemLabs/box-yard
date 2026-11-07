#!/usr/bin/env node
// Suggestion review against an isolated mock yard. Every send is intercepted; no agent starts.
// PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROMIUM_PATH=/path/to/chrome \
//   node scripts/perf/next-steps.mjs http://localhost:4260 task_uxpreview prj_uxyard01 /tmp/steps [--record]
import fs from 'node:fs/promises'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const [base, taskId, projectId, out, mode] = process.argv.slice(2)
if (!base || !taskId || !projectId || !out) throw new Error('Pass an isolated mock URL, task id, project id and screenshot directory')
const strict = mode !== '--record'
const task = await (await fetch(new URL(`/api/tasks/${taskId}`,base))).json()
const latestSteps=['Open the phone preview','Start a task from this review','Check the layout at 125% zoom']
const now=Date.now()
const messages=[
 {id:'msg_uxaskold',role:'user',content:'What should we check on a phone?',meta:null,createdAt:now-4000},
 {id:'msg_uxreplyold',role:'assistant',content:'Start with the Coordinator and its task cards.',meta:{nextSteps:['Show every project','Review the old layout']},createdAt:now-3000},
 {id:'msg_uxasknew',role:'user',content:'What is ready for me to try?',meta:null,createdAt:now-2000},
 {id:'msg_uxreplynew',role:'assistant',content:'The phone preview is ready. Check its layout, then turn anything you find into a task.',meta:{nextSteps:latestSteps},createdAt:now-1000},
]
await fs.mkdir(out,{recursive:true})
const browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--mute-audio']})
const results=[]
try {
 for (const physical of [320,400,560,800]) for (const zoom of [1,1.25]) {
  const context=await browser.newContext({viewport:{width:Math.round(physical/zoom),height:Math.round(1000/zoom)},deviceScaleFactor:zoom,isMobile:true,hasTouch:true,reducedMotion:'reduce'})
  try {
   await context.addInitScript(()=>{
    localStorage.setItem('box-yard:setup-skipped','true')
    localStorage.setItem('boxyard:voice',JSON.stringify({enabled:false}))
    localStorage.setItem('boxyard:send-sound',JSON.stringify({enabled:false}))
   })
   const page=await context.newPage(),sends=[],errors=[]
   page.setDefaultTimeout(10000)
   page.on('pageerror',e=>errors.push(e.message))
   await page.route('**/api/stream',r=>r.abort())
   await page.route('**/api/chat',async r=>{
    if (r.request().method()==='GET') return r.fulfill({json:messages})
    const body=r.request().postDataJSON();sends.push({scope:'coordinator',body})
    return r.fulfill({json:{...body,role:'user',meta:{},createdAt:now}})
   })
   await page.route(`**/api/projects/${projectId}/captain/messages`,async r=>{
    if (r.request().method()==='GET') return r.fulfill({json:messages.map(m=>({...m,projectId}))})
    const body=r.request().postDataJSON();sends.push({scope:'captain',body})
    return r.fulfill({json:{...body,projectId,role:'user',meta:{},createdAt:now}})
   })
   await page.route(`**/api/tasks/${taskId}/messages`,async r=>{
    if (r.request().method()==='GET') return r.fulfill({json:messages.map(m=>({...m,taskId}))})
    const body=r.request().postDataJSON();sends.push({scope:'task',body})
    return r.fulfill({json:task})
   })
   for (const scope of ['coordinator','captain','task']) {
    const suffix=scope==='task'?`?session=${taskId}`:scope==='captain'?`?project=${projectId}`:''
    await page.goto(new URL(`/${suffix}`,base).href)
    const root=scope==='task'?page.getByRole('dialog'):scope==='captain'?page.getByTestId('captain-card'):page.getByTestId('coordinator-card')
    const pick=root.getByRole('button',{name:latestSteps[0],exact:true})
    await pick.waitFor();await pick.scrollIntoViewIfNeeded()
    const groups=root.locator('[aria-label="Next steps"], [aria-label="Recommended next steps"]')
    const count=await groups.count()
    const bounds=await groups.last().locator('button').evaluateAll(bs=>bs.map(b=>{
     const r=b.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)
     return {label:b.textContent,width:r.width,height:r.height,clipped:r.left<0||r.right>innerWidth,hit:hit===b||b.contains(hit)}
    }))
    await page.screenshot({path:`${out}/${scope}-${physical}-${zoom}.png`})
    const failures=bounds.filter(b=>b.width<44||b.height<44||b.clipped||!b.hit)
    results.push({scope,physical,zoom,count,bounds,failures,errors})
    console.log(`${scope} ${physical} at ${zoom*100}%: ${count} suggestion group(s); ${failures.length} target failures`)
    if (strict) {
     if(count!==1||failures.length) throw new Error(`${scope}: only the latest reply should offer tappable 44px suggestions`)
     const response=page.waitForResponse(r=>r.request().method()==='POST'&&[ '/api/chat', `/api/projects/${projectId}/captain/messages`, `/api/tasks/${taskId}/messages` ].some(path=>new URL(r.url()).pathname===path))
     await pick.tap();await response
     await page.waitForFunction(()=>document.activeElement?.tagName!=='TEXTAREA')
     if(sends.filter(s=>s.scope===scope).length!==1||sends.at(-1).body.content!==latestSteps[0]) throw new Error('A suggestion must send once to its own recipient')
    }
   }
   if(errors.length) throw new Error(errors.join('; '))
  } finally {await context.close()}
 }
} finally {await browser.close()}
await fs.writeFile(`${out}/checks.json`,JSON.stringify(results,null,2))
