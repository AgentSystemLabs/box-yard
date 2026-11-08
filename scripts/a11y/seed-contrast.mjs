// Creates a NEW, disposable mock yard. Never points at an existing store or runs an agent.
// npm run build && node scripts/a11y/seed-contrast.mjs
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const { openDb } = await import('../../dist/server/server/db.js')
const { Store } = await import('../../dist/server/server/store.js')
const dir = mkdtempSync(path.join(tmpdir(), 'contrast-yard-'))
const db = openDb(dir), store = new Store(db), now = Date.now()
const project = store.createProject({ id: 'prj_contrast', name: 'Example project', repo: 'acme/example-app', color: 'indigo', pushAtTurnEnd: false })
const states = ['idle', 'pr_ready', 'failed', 'needs_input', 'waiting', 'done', 'queued', 'working', 'starting']
for (const [i, status] of states.entries()) {
  const id = `task_contrast-${status}`
  store.createTask({ id, projectId: project.id, title: `${status}: example task`, prompt: 'Review the example change.' })
  // Active states are supplied by the browser's read-only API fixture, never to the scheduler.
  store.updateTask(id, { status: ['queued', 'working', 'starting'].includes(status) ? 'idle' : status, turnCount: 1, contextTokens: 130000, contextWindow: 200000,
    error: status === 'failed' ? 'Example build failed. Review the output and retry.' : null,
    question: status === 'needs_input' ? 'Which example should be used?' : null,
    prUrl: i < 4 ? `https://github.com/acme/example-app/pull/${i + 1}` : null,
    prState: ['draft', 'open', 'closed', 'merged'][i] ?? null,
  })
}
store.createTask({ id: 'task_contrast-child', projectId: project.id, parentTaskId: 'task_contrast-idle', title: 'Example subtask', prompt: 'Review the child change.' })
store.updateTask('task_contrast-child', { status: 'idle', turnCount: 1 })
const markdown = `### Example result
Normal text, **bold text**, *emphasis*, and \`inline code\`.

[Internal task](/tasks/task_contrast-idle), [external reference](https://example.com), and https://github.com/acme/example-app/pull/2.

> A quoted explanation.

| Item | Result |
| --- | --- |
| Contrast | Reviewed |

\`\`\`ts
${Array.from({length: 16}, (_, i) => `const example${i} = "readable code"`).join('\n')}
\`\`\``
const messages = [
  ['user', 'Please review the example UI.'],
  ['assistant', markdown],
  ['tool', 'Read example.ts', { input: { path: 'example.ts' } }],
  ['error', 'Example tool failed. Try again.'],
  ['assistant', 'The review is ready.'],
]
for (const [role, content, meta] of messages) {
  store.addChat(role, content, meta)
  store.addCaptainMessage(project.id, role, content, meta)
  for (const id of ['task_contrast-idle', 'task_contrast-child', 'task_contrast-failed', 'task_contrast-needs_input']) store.addTaskMessage(id, role, content, meta)
}
for (const [icon, verb, status] of [['🔀', 'opened a pull request: https://github.com/acme/example-app/pull/2', 'pr_ready'], ['❌', 'failed: Example build failure.', 'failed'], ['🙋', 'needs you: Which example?', 'needs_input'], ['✅', 'is done: Example checks passed.', 'done']]) {
  store.addChat('notice', `${icon} **${status}: example task** ${verb}`, { taskId: `task_contrast-${status}`, projectId: project.id })
}
db.prepare('UPDATE chat_messages SET seen_by_orchestrator = 1').run()
db.prepare('UPDATE captain_messages SET seen_by_captain = 1').run()
// Two days exercise the date navigation without a long virtualised transcript.
for (const table of ['chat_messages', 'captain_messages', 'task_messages']) db.prepare(`UPDATE ${table} SET created_at = created_at - 86400000 WHERE role = 'user'`).run()
store.setKv('orchestrator_usage', JSON.stringify({ tokens: 155000, window: 200000, updatedAt: now }))
store.setKv(`captain_usage:${project.id}`, JSON.stringify({ tokens: 140000, window: 200000, updatedAt: now }))
store.createSchedule({ id: 'sch_contrast', projectId: project.id, name: 'Example daily review', cron: '0 9 * * *', timezone: 'UTC', prompt: 'Review example changes.', nextRunAt: now + 86400000, enabled: false })
db.prepare("INSERT INTO boxes (id, provider, status, created_at, last_used_at, size) VALUES ('box_contrast', 'mock', 'running', ?, ?, 'medium')").run(now, now)
mkdirSync(path.join(dir, 'local-boxes', 'box_contrast'), { recursive: true })
db.close()
console.log(dir)
