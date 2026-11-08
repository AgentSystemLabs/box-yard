import '@fontsource-variable/inter'
import '../../web/src/styles.css'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Button, Select, inputClass, StatusBadge, STATUS, PrChip, Markdown, AgentIcon } from '../../web/src/components/ui'
import { TaskStatusIcon } from '../../web/src/components/TaskIcon'
import { ContextMeter } from '../../web/src/components/ContextMeter'
import { ChatLine, CollapsibleMarkdown } from '../../web/src/components/ChatLine'
import { NewTaskButton } from '../../web/src/components/NewTask'
import { ThreadLine } from '../../web/src/components/SideThread'
import { Toasts } from '../../web/src/components/Toasts'
import { toast } from '../../web/src/lib/toast'
import { ToCaptainLine } from '../../web/src/components/CaptainForward'
import { Line } from '../../web/src/components/TaskView'
import { Switch } from '../../web/src/components/Hooks'
import { InboundMessage } from '../../web/src/components/CaptainTab'
import { USAGE_COLORS, OTHER_COLOR } from '../../shared/usageLedger'
import { tagStyle, TAG_COLOR } from '../../web/src/components/ComposerTags'
import type { CSSProperties } from 'react'
import { PROJECT_COLORS, PROJECT_COLOR_HEX } from '../../shared/projectColors'
import { keys } from '../../web/src/lib/queries'
import { HealthBanner, Login } from '../../web/src/components/Views'
import { ConfirmHost } from '../../web/src/components/ConfirmDialog'
import { confirmDialog } from '../../web/src/lib/confirm'
import type { Project, Task, TaskMessage } from '../../shared/types'
const theme = new URLSearchParams(location.search).get('theme') ?? 'light'
document.documentElement.classList.toggle('dark', theme === 'dark')
const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
const projects = PROJECT_COLORS.map((color) => ({ id: `prj_${color}`, name: `Example ${color}`, color, createdAt: 1 }) as Project)
const tasks = projects.map((p) => ({ id: `task_${p.color}`, projectId: p.id, title: `Example ${p.color}`, status: 'working', icon: 'wrench', createdAt: 1 }) as Task)
client.setQueryData(keys.projects, projects)
client.setQueryData(keys.tasks, tasks)
client.setQueryData(keys.agentSettings, { settings: { ownerName: 'Example', captainIcon: 'cap' } })
client.setQueryData(keys.health, { problems: ['Example warning: Settings › Credentials needs attention.'] })
const noop = () => {}
const pending: TaskMessage = { id: 'tm_example', taskId: tasks[0]!.id, role: 'user', content: 'A pending message remains readable.', createdAt: Date.now(), meta: { pending: true, captainName: 'Example' } }
const md = `### Markdown heading\n\nProse and \`inline code\`. [Internal task](/tasks/task_example), [external reference](https://example.com).\n\n> Quoted text\n\n\`\`\`ts\n${Array.from({length: 28}, (_, i) => `const example${i} = "readable code"`).join('\n')}\n\`\`\``
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}>
  {new URLSearchParams(location.search).has('login') ? <Login/> : <main className="mx-auto max-w-4xl space-y-6 p-4">
    <h1 className="text-2xl font-bold">Actual shared components · {theme}</h1>
    <section data-audit="health"><HealthBanner/></section>
    <section data-audit="controls" className="space-y-3 rounded-lg bg-zinc-900 p-4">
      <h2 className="font-semibold">Controls and inactive states</h2>
      <label className="inline-flex min-h-11 items-center gap-2"><input type="checkbox" defaultChecked/>Native checked</label>
      <label className="inline-flex min-h-11 items-center gap-2"><input type="checkbox"/>Native unchecked</label>
      <div className="flex flex-wrap gap-2">{(['primary', 'subtle', 'ghost', 'danger'] as const).map((v) => <Button key={v} variant={v}>{v}</Button>)}<Button disabled>Disabled action</Button></div>
      <label className="block text-sm">Example input<input className={inputClass} placeholder="Helpful placeholder" /></label>
      <label className="block text-sm">Invalid input<input className={inputClass} aria-invalid value="Example invalid value" readOnly /></label>
      <label className="block text-sm">Example select<Select><option>Selected example</option><option>Other example</option></Select></label>
      <label className="block text-sm">Inactive select<Select disabled><option>Unavailable</option></Select></label>
      <div className="flex flex-wrap items-center gap-3"><Switch label="Off switch" checked={false} onChange={noop}/><Switch label="On switch" checked onChange={noop}/><Switch label="Inactive switch" checked disabled onChange={noop}/></div>
    </section>
    <section data-audit="statuses" className="flex flex-wrap gap-3 rounded-lg bg-zinc-900 p-4">{[...Object.keys(STATUS), 'merged'].map((s) => <StatusBadge key={s} status={s as keyof typeof STATUS} />)}</section>
    <section data-audit="prs" className="flex flex-wrap gap-3 rounded-lg bg-zinc-900 p-4">{(['open', 'draft', 'merged', 'closed'] as const).map((prState) => <div key={prState} className="space-y-2">{(['chip', 'link', 'number'] as const).map((variant) => <div key={variant}><PrChip variant={variant} task={{status:'pr_ready', prState, prUrl:'https://github.com/acme/example-app/pull/2'}} /></div>)}<PrChip task={{status:'pr_ready', prState, prUrl:'https://github.com/acme/example-app/pull/2'}} activity={{icon:null,label:'checking…',title:'Checking'}} /></div>)}</section>
    {['bg-zinc-900', 'bg-zinc-800', 'bg-zinc-700/30'].map((bg, i) => <section key={bg} data-audit={`icons-${i}`} className={`flex flex-wrap gap-4 rounded-lg p-4 ${bg}`}>
      <AgentIcon kind="coordinator" busy/><AgentIcon kind="coordinator" busy tile/><AgentIcon kind="coordinator" busy={false} error/><AgentIcon kind="captain" busy error/>
      {tasks.map((t) => <div key={t.id} className="flex items-center gap-2"><TaskStatusIcon task={t} label="Working"/><TaskStatusIcon task={{...t,status:'needs_input'}}/><AgentIcon kind="captain" busy color={projects.find(p=>p.id===t.projectId)?.color}/><AgentIcon kind="captain" busy tile projectId={t.projectId} color={projects.find(p=>p.id===t.projectId)?.color}/></div>)}
    </section>)}
    <section data-audit="palettes" className="space-y-3 rounded-lg bg-zinc-900 p-4">
      <h2>Every chart colour and composer tag</h2>
      {['bg-zinc-950','bg-zinc-900','bg-zinc-700/30'].map(bg => <div key={bg} className={`flex gap-2 p-2 ${bg}`}>{[...USAGE_COLORS, OTHER_COLOR].map((color, i) => <span key={color} data-series={`example-${i}`} className="usage-fill h-8 w-8" style={{'--series-color':color} as CSSProperties}/>)}</div>)}
      <div className="flex flex-wrap gap-2">{[...Object.values(PROJECT_COLOR_HEX), ...Object.values(TAG_COLOR)].map(color => <span key={color} className="composer-tag" style={tagStyle(color)}>Readable tag</span>)}</div>
    </section>
    <section data-audit="meters" className="flex flex-wrap gap-4">{[30, 80, 95].map((pct) => <ContextMeter key={pct} tokens={pct * 1000} window={100000} compacting={false} queued={false}/>)}</section>
    <section data-audit="pending" className="space-y-3"><ThreadLine m={{...pending, threadId:"thread_example"}}/><ChatLine m={{...pending,role:'user'}} onFollowUp={noop}/><InboundMessage m={{...pending,projectId:projects[0]!.id,role:'user'}}/><ToCaptainLine m={pending}/><Line m={pending} onFollowUp={noop}/><Line m={{...pending,meta:{pending:true,source:'hook'}}} onFollowUp={noop}/></section>
    <section data-audit="markdown"><Markdown>{md}</Markdown></section>
    <section data-audit="folded-message"><CollapsibleMarkdown>{Array.from({length: 30}, (_, i) => `Example paragraph ${i}: readable folded message.\n`).join("\n")}</CollapsibleMarkdown></section>
    <section data-audit="new-task"><NewTaskButton projectId={projects[0]!.id}/></section>
    <section data-audit="toasts" className="relative min-h-72"><Button onClick={() => { toast.error('Example error', 'Readable error detail.', {duration: 60000}); toast.info('Example notice', 'Readable notice detail.', {duration: 60000, action:{label:'Undo',onClick:noop}}); toast.task({title:'Example task ready',body:'Readable task detail.',status:'pr_ready',href:'/?session=task_example',context:'Example project',tone:'green'},60000) }}>Show example toasts</Button><Toasts/></section>
    <Button onClick={() => void confirmDialog({title:'Example confirmation',body:'Review this example action.',danger:true,confirmLabel:'Confirm example'})}>Open confirmation</Button>
  </main>}<ConfirmHost/>
</QueryClientProvider>)
