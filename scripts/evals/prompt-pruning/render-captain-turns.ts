// Renders the Captain routing cases (captain-cases.ts) into the exact text a Captain gets: its system prompt (Box Yard's
// part) and, per case, the turn prompt: [Project now] with the project's notes and open tasks, the turn's updates, the
// "[Tasks this message names …]" block and the labelled messages. It uses Box Yard's own code for every block, on a
// throwaway yard (test config: temporary data dir, no server, no model calls).
//
//   npx tsx scripts/evals/prompt-pruning/render-captain-turns.ts <outDir> --clone <dir> [--notes notes.md] [--owner Cody]
//
// --clone is where the eval keeps the read-only copy of the repo the Captain reads (the system prompt and repo_clone
// point there). --notes is a file of the project's notes ("- (author) content" lines); keep it out of the repo.
// Writes captain.system.md, state.json (what the stub MCP server answers from) and cases/<id>.md.
import fs from "node:fs"
import path from "node:path"
import { createBoxYard } from "../../../server/app.js"
import { NAMED_TASKS_HEADING, namedState } from "../../../server/handoff.js"
import { updatesBlock } from "../../../server/noticeBatch.js"
import { retroNotice } from "../../../server/retro.js"
import { noteBudgetOf } from "../../../server/settings.js"
import { budgetLine, budgetNotes } from "../../../shared/notes.js"
import { agentCaptainLabel } from "../../../shared/captain.js"
import { withOwner } from "../../../shared/owner.js"
import { testConfig } from "../../../test/helpers.js"
import type { Project } from "../../../shared/types.js"
import { CASES, RETRO_TASK, SEED_TASKS, SUGGESTIONS, type Message } from "./captain-cases.js"
import { readNotes } from "./notes-file.js"

const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args.splice(i, 2)[1] : undefined
}
const notesFile = opt("--notes")
const clone = opt("--clone")
const ownerName = opt("--owner") ?? "Cody"
const out = args[0]
if (!out || !clone) {
  console.error("usage: npx tsx scripts/evals/prompt-pruning/render-captain-turns.ts <outDir> --clone <dir> [--notes notes.md] [--owner Cody]")
  process.exit(2)
}
fs.mkdirSync(path.join(out, "cases"), { recursive: true })

/** A few public example notes, for runs without a real project's notes. */
const SAMPLE_NOTES = [
  "Run the web UI tests with `npm run test:web`; they need Node 22 or newer.",
  "Cody prefers small PRs: one feature or fix per PR.",
  "Boxes have no Docker: tests that need it are skipped there and run on this computer instead.",
]

const yard = createBoxYard({ ...testConfig({ port: 0 }), defaultRunner: "local" }, { webDir: "/nonexistent" })
yard.settings.update({ ownerName })
const project: Project = yard.store.createProject({
  name: "Box Yard",
  repo: "acme/box-yard",
  description: "Box Yard: the orchestrator that runs Claude Code agents in Upstash Boxes",
} as never)

const notes = notesFile ? readNotes(notesFile) : SAMPLE_NOTES.map((content) => ({ author: "captain", content }))
for (const n of notes) yard.store.addNote(project.id, n.author, n.content)

const now = Date.now()
for (const [i, t] of SEED_TASKS.entries()) {
  yard.store.createTask({ id: t.id, projectId: project.id, title: t.title, prompt: t.title })
  yard.store.updateTask(t.id, {
    status: t.status,
    ...(t.prUrl ? { prUrl: t.prUrl, prState: t.prState ?? "open" } : {}),
    ...(t.summary ? { summary: t.summary } : {}),
    ...(t.question ? { question: t.question } : {}),
    ...(t.error ? { error: t.error } : {}),
    ...(t.mergePending && t.prUrl
      ? { mergeRequest: { prNumber: Number(t.prUrl.split("/").pop()), prUrl: t.prUrl, requestedAt: now - 120_000, deliveredAt: now - 110_000, requestedBy: null, inputId: "in_merge" } }
      : {}),
  } as never)
  // Spread the tasks' last activity over the last few hours, newest first.
  yard.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now - (i + 1) * 25 * 60_000, t.id)
}

// ---------------------------------------------------------------- system prompt
const captain = yard.captains.get(project.id) as unknown as { systemPrompt(): string; projectNow(): { text: string }; repo: { dir: string } }
const system = captain.systemPrompt().split(captain.repo.dir).join(path.join(clone, ""))
fs.writeFileSync(path.join(out, "captain.system.md"), system)

// ---------------------------------------------------------------- per-case turn prompts
/** GitHub answered a minute ago, for every PR. */
const prs = { ensureFresh: async () => {}, prCheck: () => ({ checkedAt: now - 60_000, error: null }) }

function label(m: Message): string {
  if (m.source === "cody") return withOwner("From Cody", ownerName)
  if (m.source === "coordinator") return "From the Coordinator"
  const a = m.agent!
  const how =
    a.waitSeconds > 0
      ? ` It is waiting up to ${a.waitSeconds} s for your answer mid-turn: reply first, with reply_to_agent (task ${a.taskId}), before anything slow.`
      : ` It kept working. If it needs an answer, use reply_to_agent (task ${a.taskId}); it gets the reply as its next message.`
  return `${agentCaptainLabel({ taskId: a.taskId, taskTitle: a.taskTitle })}${withOwner(`, an agent in this project, via message_captain. Not a message from Cody.${how}`, ownerName)}`
}

const budget = noteBudgetOf(yard.settings.get(), yard.store.getProject(project.id))
const report = budgetNotes(yard.store.listNotes(project.id), budget)
const retroTask = yard.store.getTask(RETRO_TASK)!
const retro = retroNotice(
  [{ task: retroTask, trigger: "merged", suggestions: SUGGESTIONS.map((s) => ({ ...s, projectId: project.id, taskId: RETRO_TASK, taskTitle: retroTask.title, status: "pending" })) as never }],
  { budget: { line: budgetLine(report), over: report.over }, ownerName },
)

const projectNow = captain.projectNow().text
const tasks = yard.store.listTasks({ projectId: project.id })
for (const c of CASES) {
  const notices = (c.notices ?? []).map((n) => (n === "retro" ? retro : n))
  const updates = updatesBlock("Project updates since your last turn", notices)
  let body: string
  if (c.messages?.length) {
    const named = await namedState(c.messages.map((m) => m.text).join("\n\n"), { tasks }, { store: yard.store, prs, now }, NAMED_TASKS_HEADING)
    body = [updates, named, c.messages.map((m) => `[${label(m)}]\n${m.text}`).join("\n\n")].filter(Boolean).join("\n\n")
  } else {
    body = [
      updates,
      withOwner(
        "(Automatic wake-up: there is no new message from Cody or the Coordinator. Decide whether a project-local next step is needed. If Cody or the Coordinator should hear about it, say so in a line or two. If nothing needs reporting, reply with exactly (no update) and nothing else.)",
        ownerName,
      ),
    ].join("\n\n")
  }
  fs.writeFileSync(path.join(out, "cases", `${c.id}.md`), `${projectNow}\n\n${body}`)
}

// ---------------------------------------------------------------- what the stub MCP server answers from
fs.writeFileSync(
  path.join(out, "state.json"),
  JSON.stringify(
    {
      project: { id: project.id, name: project.name, repo: project.repo },
      clone,
      notes: yard.store.listNotes(project.id).map((n) => ({ id: n.id, author: n.author, content: n.content })),
      suggestions: SUGGESTIONS,
      tasks: yard.store.listTasks({ projectId: project.id }).map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        prUrl: t.prUrl,
        prState: t.prState,
        summary: t.summary,
        question: t.question,
        error: t.error,
        mergeRequested: t.mergeRequest ? true : undefined,
        agent: "claude",
      })),
    },
    null,
    2,
  ),
)
console.log(`rendered ${CASES.length} cases, system prompt ${system.length} chars, ${notes.length} notes`)
process.exit(0)
