#!/usr/bin/env node
// Read-only regression/screenshots for the task-linked PR list. The browser receives deterministic task
// fixtures; non-GET API calls are blocked. Use an isolated mock yard with two projects and at least one task.
// PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROMIUM_PATH=/path/to/chrome \
//   node scripts/perf/pull-requests.mjs http://localhost:4260 <project id> <other project id> <shots dir> [--before]
// Checks 320/400/560/800 physical px at 100/125% effective zoom, with touch and reduced motion.
// Pull requests is an icon on the line over the chat's box, only with a project picked (none in the header, none under
// "All"); the picked project's Captain card has no View conversation, and its head is the icon and "<project> Captain" only.
import fs from 'node:fs/promises'
const [base, projectId, otherProjectId, out, mode] = process.argv.slice(2)
if (!base || !projectId || !otherProjectId || !out) throw new Error('Pass a mock URL, two project ids and a screenshot directory')
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const health = await (await fetch(new URL('/api/health', base))).json()
if (!health.mock) throw new Error('Use an isolated mock yard')
const phase = mode === '--before' ? 'before' : 'after'
await fs.mkdir(out,{recursive:true})
const settings=await(await fetch(base+'/api/agent-settings')).json(), projects=await(await fetch(base+'/api/projects')).json(), all=await(await fetch(base+'/api/tasks')).json()
const seed=all[0], now=Date.now()
if (!seed || !projects.some(p=>p.id===projectId) || !projects.some(p=>p.id===otherProjectId)) throw new Error('Seed at least one task and both projects first')
const rows=[['task_prphone1',projectId,'Keep sign-in comfortable on mobile','open',251],['task_prphone2',projectId,'Follow up on the sign-in preview','open',251],['task_prdraft1',projectId,'Make preview navigation clearer','draft',252],['task_prunkno1',projectId,'Improve the empty task state',null,253],['task_prmerge1',projectId,'Fix attachment previews on phones','merged',249],['task_prclose1',projectId,'Try a different task layout','closed',248],['task_prfolio1',otherProjectId,'Refresh the portfolio introduction','open',19]]
const tasks=rows.map(([id,taskProjectId,title,prState,n],i)=>({...seed,id,projectId:taskProjectId,title,status:prState==='merged'||prState==='closed'?'done':'pr_ready',prUrl:`https://github.com/acme/${taskProjectId===otherProjectId?'portfolio':'box-yard'}/pull/${n}`,prState,summary:'The phone sign-in flow is ready. The preview keeps your return path visible and preserves the draft. Please check the narrow layout before requesting a merge.',previews:i===0?[{port:4260,url:base,label:'Phone sign-in preview'}]:[],mergeRequest:null,updatedAt:now-i*1000,createdAt:now-60000-i*1000}))
const browser=await chromium.launch({...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {}),args:['--mute-audio']})
const checks=[]
try{
 for(const physical of [320,400,560,800])for(const zoom of [1,1.25]){
  const ctx=await browser.newContext({viewport:{width:Math.round(physical/zoom),height:Math.round(1000/zoom)},deviceScaleFactor:zoom,isMobile:true,hasTouch:true,reducedMotion:'reduce'})
  await ctx.addInitScript(()=>{localStorage.setItem('box-yard:setup-skipped','true');localStorage.setItem('boxyard:voice',JSON.stringify({enabled:false}))})
  const page=await ctx.newPage(),errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000)
  await page.route('**/api/agent-settings',r=>r.fulfill({json:{...settings,settings:{...settings.settings,orchestratorAutoCompact:{enabled:false,unit:'tokens',value:250000}}}}))
  await page.route('**/api/tasks',r=>r.fulfill({json:tasks}))
  await page.route('**/api/tasks/*/messages*',r=>r.fulfill({json:[]}))
  await page.route('**/api/tasks/*/queue',r=>r.fulfill({json:[]}))
  await page.route('**/api/tasks/*',r=>{const id=r.request().url().split('/').at(-1),task=tasks.find(t=>t.id===id);return task?r.fulfill({json:task}):r.fallback()})
  await page.route('**/api/**',r=>{if(r.request().method()==='GET'&&!r.request().url().endsWith('/stream'))return r.fallback();if(r.request().method()!=='GET')writes.push(r.request().url());return r.abort()})
  const shot=async(opts)=>{
   const overflow=await page.evaluate(()=>[document.documentElement,...document.querySelectorAll('[role=dialog]')].some(el=>el.scrollWidth>el.clientWidth+1));if(overflow)throw Error('Horizontal overflow: '+opts.path)
   const small=await page.getByRole('dialog').locator('button:visible,a:visible').evaluateAll(els=>els.filter(el=>!el.closest('.prose-chat')&&el.getBoundingClientRect().height<43.5).map(el=>({text:el.textContent,height:el.getBoundingClientRect().height})))
   if(small.length)throw Error('Small touch targets: '+JSON.stringify(small))
   await page.screenshot(opts)
  }
  await page.goto(base+'/');await page.getByTestId('chat-panel').waitFor();await page.locator('[data-testid=project-bar]').waitFor();if(await page.locator('[data-testid=context-menu-button],[data-testid=context-meter-row]').count())throw Error('Manual context controls returned')
  let prButton=null
  await page.waitForTimeout(300)
  if(phase==='after'&&await page.getByRole('button',{name:'Pull requests',exact:true}).count())throw Error('No Pull requests under "All"')
  await shot({path:`${out}/home-all-${physical}-${zoom}.png`})
  await page.goto(base+'/?project='+encodeURIComponent(projectId));await page.getByTestId('captain-card').waitFor();await page.waitForTimeout(300)
  if(phase==='after'){
   const button=page.getByRole('button',{name:'Pull requests',exact:true});await button.waitFor()
   if(await page.locator('header').getByRole('button',{name:'Pull requests',exact:true}).count())throw Error('Pull requests left the header')
   if(!await button.evaluate(el=>!!el.closest('[data-testid=dock-line]')))throw Error('Pull requests is on the line over the box')
   if((await button.textContent()).trim()||await button.getAttribute('title')!=='Pull requests')throw Error('Icon only, with its tooltip')
   const rect=await button.boundingBox();if(rect.height<44||rect.width<44)throw Error('PR entry needs a 44px target')
   const box=await page.getByTestId('chat-footer').locator('textarea').boundingBox(),vp=page.viewportSize()
   const form=await page.getByTestId('dock-line').evaluate(el=>el.nextElementSibling.getBoundingClientRect().top)
   if(rect.y+rect.height>form+0.5||rect.y+rect.height>box.y)throw Error('Pull requests stays clear of the composer: '+JSON.stringify({rect,form,box}))
   if(rect.y<vp.height/2)throw Error('Pull requests sits at the bottom of the screen')
   if(await page.getByTestId('captain-card').getByRole('link',{name:'View conversation',exact:true}).count())throw Error('The Captain card has no View conversation')
   const captainHead=(await page.getByTestId('captain-card').getByTestId('bottom-card-head').textContent()).trim(),captainName=projects.find(p=>p.id===projectId).name
   if(captainHead!==`${captainName} Captain`||await page.getByTestId('captain-card').getByTestId('bottom-card-sub').count())throw Error('The Captain head is its icon and title only: '+captainHead)
   prButton={x:Math.round(rect.x),y:Math.round(rect.y),size:Math.round(rect.height),composerTop:Math.round(form)}
  }
  await shot({path:`${out}/home-${physical}-${zoom}.png`})
  if(phase==='after'){
   await page.getByRole('button',{name:'Pull requests',exact:true}).tap()
   const dialog=page.getByRole('dialog',{name:'Pull requests',exact:true});await dialog.waitFor()
   if(await dialog.getByTestId('pr-row').count()!==3)throw Error('Expect the project\'s 3 unique active PRs')
   if(await dialog.getByText('Fix attachment previews on phones',{exact:true}).count())throw Error('Merged work must be tucked away')
   await shot({path:`${out}/list-${physical}-${zoom}.png`})
   await dialog.getByRole('button',{name:'View pull request: Keep sign-in comfortable on mobile',exact:true}).tap()
   await dialog.getByRole('heading',{name:'Task summaries',exact:true}).waitFor()
   if(await dialog.getByRole('heading',{name:'Keep sign-in comfortable on mobile',exact:true}).count()!==1)throw Error('Expected task context')
   if(await dialog.locator('a').filter({hasText:'Phone sign-in preview'}).count()!==1)throw Error('Preview missing')
   await shot({path:`${out}/detail-${physical}-${zoom}.png`})
   await dialog.getByRole('button',{name:'Back to pull requests',exact:true}).tap()
   await dialog.getByRole('button',{name:'History',exact:true}).tap()
   if(await dialog.getByTestId('pr-row').count()!==2)throw Error('Expect merged + closed history')
   await shot({path:`${out}/history-${physical}-${zoom}.png`})
   await dialog.getByRole('button',{name:'Open work',exact:true}).tap()
   await dialog.getByRole('button',{name:'View pull request: Make preview navigation clearer',exact:true}).tap()
   if(await dialog.locator('[data-merge-state]').count())throw Error('Draft must not have a merge control')
   await dialog.getByRole('button',{name:'Back to pull requests',exact:true}).tap()
   await dialog.getByRole('button',{name:'View pull request: Improve the empty task state',exact:true}).tap()
   await dialog.getByText('Status unconfirmed',{exact:true}).last().waitFor()
   if(await dialog.locator('[data-merge-state]').count())throw Error('Unknown PR must not have a merge control')
   await dialog.getByRole('button',{name:'Close',exact:true}).tap()
   await page.goto(base+'/?project='+encodeURIComponent(otherProjectId))
   await page.getByRole('button',{name:'Pull requests',exact:true}).tap()
   if(await dialog.getByTestId('pr-row').count()!==1)throw Error('Project scope must have 1 PR')
   await dialog.getByRole('button',{name:'View pull request: Refresh the portfolio introduction',exact:true}).tap()
   await dialog.getByRole('button',{name:'Open task conversation: Refresh the portfolio introduction',exact:true}).tap()
   await page.getByRole('dialog').getByTestId('task-header').waitFor()
   await page.getByRole('button',{name:'Back',exact:true}).tap()
   await page.locator('[data-card=task_prfolio1]').waitFor()
  }
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)
  if(overflow||errors.length||writes.length)throw Error(JSON.stringify({physical,zoom,overflow,errors,writes}))
  checks.push({physical,zoom,prButton,overflow,errors,writes});console.log(`ok ${phase}: ${physical}px at ${zoom*100}%`,JSON.stringify(prButton))
  await ctx.close()
 }
}finally{await browser.close()}
await fs.writeFile(out+'/checks.json',JSON.stringify(checks,null,2))
