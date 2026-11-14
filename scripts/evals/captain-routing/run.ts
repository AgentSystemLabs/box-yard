// The Captain routing eval's runner: a scratch Box Yard with the storefront project of seed.ts, whose Captain gets each
// case of fixtures.ts as a fresh conversation, on the real `claude` at one effort level. Tasks run on fake-claude, so
// only the Captain costs money. Every run is graded (grade.ts) and appended to a JSONL file; judge.ts adds the LLM
// judge's verdicts and report.ts turns the files into the report.
//
//   npx tsx scripts/evals/captain-routing/run.ts --effort low --real [--reps 3] [--out results/low.jsonl] [--port 4701]
//     [--cases id,id] [--category fan-out] [--budget 13] [--total-budget 38] [--model claude-opus-5-5] [--data /tmp/dir] [--keep]
//     [--label pruned-low]
//   npx tsx scripts/evals/captain-routing/run.ts --fake-captain [--cases ...]     (fake-claude as the Captain: plumbing only, free)
//
// --real spends tokens on this computer's own `claude` login; without it (or --fake-captain) the script only says what
// it would do. It runs its own server in a scratch data folder (never a live one, never ~/.boxyard), with an empty
// GH_CONFIG_DIR and a fake GitHub, and removes the Captain's session folders from ~/.claude/projects when it's done.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { Server } from "node:http"
import { CASES, type Case } from "./fixtures.js"
import { grade, type CreatedTask, type RunRecord, type Send, type ToolCall, type TranscriptLine } from "./grade.js"
import { OTHER_PROJECT, PROJECT, REPO_FILES, RETRO_SUGGESTIONS, SEED_NOTES, SEED_TASKS, type Alias } from "./seed.js"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  if (i < 0) return false
  args.splice(i, 1)
  return true
}
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args.splice(i, 2)[1] : undefined
}

const real = flag("--real")
const fakeCaptain = flag("--fake-captain")
const keep = flag("--keep")
const effort = opt("--effort") ?? "medium"
/** Names this run's variant in the report when it differs by more than effort (a changed prompt, say). */
const label = opt("--label")
const model = opt("--model") ?? "claude-opus-5-5"
const reps = Number(opt("--reps") ?? 3)
const port = Number(opt("--port") ?? 4701)
const budget = Number(opt("--budget") ?? 13)
/** A cap on everything the result files next to --out have spent (parallel runs, one per effort level, share it). */
const totalBudget = Number(opt("--total-budget") ?? Infinity)
const only = opt("--cases")?.split(",").map((s) => s.trim()).filter(Boolean)
const category = opt("--category")
const out = path.resolve(opt("--out") ?? `scripts/evals/captain-routing/results/${fakeCaptain ? "fake" : (label ?? effort)}.jsonl`)
const dataArg = opt("--data")

const cases = CASES.filter((c) => (!only || only.includes(c.id)) && (!category || c.category === category))
if (only) for (const id of only) if (!CASES.some((c) => c.id === id)) throw new Error(`No case ${id}`)
if (!cases.length) throw new Error("No cases selected")
if (!real && !fakeCaptain) {
  console.log(`Would run ${cases.length} case(s) × ${reps} rep(s) on ${model} at ${effort} effort with the real claude CLI, on port ${port}, writing ${out}. Pass --real to spend the tokens (budget $${budget}).`)
  process.exit(0)
}
// Another program on the port would answer this run's API calls (on macOS two servers can both bind it).
const portTaken = await new Promise<boolean>((resolve) => {
  const sock = net.connect(port, "127.0.0.1")
  sock.once("connect", () => (sock.destroy(), resolve(true)))
  sock.once("error", () => resolve(false))
})
if (portTaken) throw new Error(`Port ${port} is in use: pass a free one with --port`)

// The server reads its config from the environment as it loads: nothing of the shell that started this (an agent's own
// session, a live server's port or token) may reach it. The Captain runs on this computer's own `claude` login.
for (const k of Object.keys(process.env)) {
  if (/^(CLAUDECODE$|CLAUDE_|BOXYARD_|GITHUB_TOKEN$|GH_TOKEN$|GIT_AUTHOR_|GIT_COMMITTER_|ANTHROPIC_|PORT$|UPSTASH_|BOX_|CODEX_|ORCHESTRATOR_|CAPTAIN_|WORKER_|FAKE_)/.test(k)) delete process.env[k]
}
// A neutral name: the Captain sees its paths, and nothing in them should say it's being tested.
const dataDir = fs.realpathSync(dataArg ? (fs.mkdirSync(dataArg, { recursive: true }), dataArg) : fs.mkdtempSync(path.join(os.tmpdir(), "boxyard-")))
process.env.BOXYARD_DATA_DIR = dataDir
process.env.BOXYARD_HOME = path.join(dataDir, "home")
process.env.BOXYARD_LOCAL_DIR = path.join(dataDir, "workspaces")
// Mock mode: every task agent (Claude, Codex, Cursor, OpenCode; boxes and Docker are folders here) is a stand-in.
process.env.BOXYARD_MOCK = "1"
process.env.DISABLE_AUTOUPDATER = "1"
// What a task the Captain starts says when it's done, if the Captain waits for it: plausible, so it doesn't follow up.
process.env.FAKE_CLAUDE_WORKER_REPLY = "Done: made the change with tests; npm test and npm run lint pass. No PR yet."
// No GitHub login: the server would hand this computer's `gh` token to the bench's agents.
process.env.GH_CONFIG_DIR = path.join(dataDir, "gh")
fs.mkdirSync(process.env.GH_CONFIG_DIR, { recursive: true })
// fake-claude keeps its sessions in CLAUDE_CONFIG_DIR (else ~/.fake-claude). The real Captain needs this computer's own
// ~/.claude login, so only a fake Captain gets it here; the tasks get it from their project's env (makeProject).
if (fakeCaptain) process.env.CLAUDE_CONFIG_DIR = path.join(dataDir, "fake-claude")

const { config: baseConfig } = await import("../../../server/config.js")
const { createBoxYard } = await import("../../../server/app.js")
type Config = typeof baseConfig

const c: Config = {
  ...baseConfig,
  dataDir,
  localDir: path.join(dataDir, "workspaces"),
  host: "127.0.0.1",
  port,
  password: "",
  publicUrl: "",
  provider: "local",
  defaultRunner: "local",
  githubToken: "",
  // The Captain's reports mustn't start Coordinator turns.
  orchestratorAutoWake: false,
  selfBoxId: "",
  diskMinFreeMb: 0,
  memoryMaxUsedPercent: 0,
  memoryMinFreeMb: 0,
  loadMaxPerCpu: 0,
  localDiskMinFreeGb: 0,
}

// ---------------------------------------------------------------- repos, GitHub

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=Sam", "-c", "user.email=sam@example.com", "-c", "init.defaultBranch=main", ...a], { cwd, stdio: "pipe" }).toString().trim()
function bareRepo(slug: string, files: Record<string, string>): string {
  const root = path.join(dataDir, "origin")
  const bare = path.join(root, `${slug}.git`)
  if (fs.existsSync(bare)) return bare
  fs.mkdirSync(path.dirname(bare), { recursive: true })
  git(root, "init", "-q", "--bare", "-b", "main", bare)
  git(bare, "config", "uploadpack.allowFilter", "true")
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true")
  const seed = path.join(root, "seed", slug)
  fs.mkdirSync(seed, { recursive: true })
  git(seed, "init", "-q", "-b", "main")
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true })
    fs.writeFileSync(path.join(seed, file), text)
  }
  git(seed, "add", ".")
  git(seed, "commit", "-qm", "Initial commit")
  git(seed, "push", "-q", bare, "main")
  return bare
}
const storeOrigin = bareRepo(PROJECT.slug, REPO_FILES)
const marketingOrigin = bareRepo(OTHER_PROJECT.slug, {
  "README.md": "# Marketing site\n\nAcme's marketing website and blog, built with Astro.\n",
  "src/pages/pricing.astro": "---\nconst plans = ['Starter', 'Growth', 'Scale']\n---\n<h1>Pricing</h1>\n",
})

/** Every PR the seed names, as the fake GitHub answers for it. */
const PR_STATES = new Map<string, { state: "OPEN" | "MERGED"; mergedAt: string | null }>()
for (const t of SEED_TASKS) if (t.pr) PR_STATES.set(`${PROJECT.slug}#${t.pr.number}`, { state: t.pr.state === "merged" ? "MERGED" : "OPEN", mergedAt: t.pr.state === "merged" ? new Date(Date.now() - t.agoMin * 60_000).toISOString() : null })
for (const t of OTHER_PROJECT.tasks) if (t.pr) PR_STATES.set(`${OTHER_PROJECT.slug}#${t.pr}`, { state: "OPEN", mergedAt: null })

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
/** GitHub's GraphQL as the PR poller asks it (server/prs.ts): each p<i> is a PR, o<i>/n<i> its repo. */
async function fakeGithub(_url: unknown, init?: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: Record<string, string | number> }
  const v = body.variables ?? {}
  const data: Record<string, unknown> = { rateLimit: { remaining: 4900, resetAt: new Date(Date.now() + 3600_000).toISOString() } }
  for (const k of Object.keys(v)) {
    const m = /^p(\d+)$/.exec(k)
    if (!m) continue
    const pr = PR_STATES.get(`${v[`o${m[1]}`]}/${v[`n${m[1]}`]}#${v[k]}`) ?? { state: "OPEN", mergedAt: null }
    data[k] = { pullRequest: { state: pr.state, isDraft: false, mergedAt: pr.mergedAt, mergedBy: pr.mergedAt ? { login: "sam" } : null, headRefOid: "a".repeat(40), labels: { nodes: [] } } }
  }
  return json({ data })
}
// Nothing reaches the real GitHub: GraphQL gets the fake, anything else a 404.
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (/^https:\/\/api\.github\.com\/graphql/.test(url)) return fakeGithub(url, init)
  if (/^https:\/\/(api\.)?github\.com\//.test(url)) return json({ message: "Not Found" }, 404)
  return realFetch(input, init)
}) as typeof fetch

// ---------------------------------------------------------------- the server

const yard = createBoxYard(c, { webDir: "/nonexistent", github: { fetch: fakeGithub as typeof fetch, token: () => "eval-token" } })
// Only the Captain runs the real CLI (before any Captain exists: each one reads it as it's made).
if (!fakeCaptain) (yard.captains as unknown as { c: Config }).c = { ...c, claudeBin: "claude" }
// Boxes, Docker and Codex are stand-ins here: a task the Captain starts on them must not fail a runner check.
yard.tasks.requireRunner = async () => {}
// Task updates never wake the Captain on their own: each case is the one turn its message (or its retro) starts.
yard.captains.tuning.wakeDebounceMs = yard.captains.tuning.wakeQuietMs = 1e9
const server = await new Promise<Server>((resolve, reject) => {
  const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  s.once("error", reject)
})
await yard.start()
const db = yard.store.db
yard.settings.update({
  captainCli: "claude",
  captainModel: model,
  captainEffort: effort,
  ownerName: "Sam",
  notesRetroEnabled: false,
  // Three seeded tasks hold endless fake turns; what the Captain starts mustn't wait behind them.
  localAgents: 32,
  gitUserName: "Sam",
  gitUserEmail: "sam@example.com",
})

const base = `http://127.0.0.1:${port}`
async function call<T>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(fn: () => T | null | undefined | false, what: string, ms = 120_000, every = 50): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - start > ms) throw new Error(`Timed out: ${what}`)
    await sleep(every)
  }
}

// ---------------------------------------------------------------- seeding

type Row = Record<string, unknown> & { id: string; status: string; current_turn_id: string | null; created_at: number; parent_task_id?: string | null }
const BUSY = new Set(["queued", "starting", "working"])
const row = (id: string) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined
const rested = (id: string) => {
  const r = row(id)
  return r && !r.current_turn_id && !BUSY.has(r.status) ? r : null
}
/** A seeded "working" task in its endless fake turn (fake-claude's [slow:N] says "Working on it slowly" first). */
const SLOW = "[slow:21600]"
const slowRunning = (id: string) => {
  const r = row(id)
  return r && r.status === "working" && r.current_turn_id && db.prepare("SELECT 1 FROM task_messages WHERE task_id = ? AND content LIKE '%slowly%'").get(id) ? r : null
}

async function makeProject(name: string, slug: string, description: string, origin: string) {
  const p = await call<{ id: string }>("POST", "/api/projects", { name, runner: "local" })
  // The API only takes GitHub-style repos; the origin is a bare repo on this disk. Task agents (fake-claude) keep their
  // sessions in the scratch folder, not in ~/.fake-claude.
  db.prepare("UPDATE projects SET repo = ?, description = ?, env_json = ? WHERE id = ?").run(`file://${origin}`, description, JSON.stringify({ CLAUDE_CONFIG_DIR: path.join(dataDir, "fake-claude") }), p.id)
  void slug
  return p.id
}
const projectId = await makeProject(PROJECT.name, PROJECT.slug, PROJECT.description, storeOrigin)
const otherProjectId = await makeProject(OTHER_PROJECT.name, OTHER_PROJECT.slug, OTHER_PROJECT.description, marketingOrigin)

/** Write a task as the seed has it: its prompt, state, PR and a two-line transcript (its prompt and its agent's reply). */
function writeSeedTask(id: string, t: { prompt: string; status: string; reply?: string; pr?: { url: string; state: "open" | "merged" } | null; mergeRequested?: boolean; question?: string; error?: string; agoMin: number }) {
  const now = Date.now()
  const at = now - t.agoMin * 60_000
  const merge = t.mergeRequested && t.pr ? JSON.stringify({ prNumber: Number(t.pr.url.split("/").pop()), prUrl: t.pr.url, requestedAt: at - 60_000, deliveredAt: at - 55_000, requestedBy: null, inputId: "inp_seed_merge" }) : null
  db.prepare(
    `UPDATE tasks SET prompt = ?, status = ?, pr_url = ?, pr_state = ?, pr_merged_at = ?, pr_merged_by = ?, pr_head_sha = ?, summary = ?, question = ?, questions_json = NULL,
       error = ?, merge_request_json = ?, outcome = NULL, wait_reason = NULL, updated_at = ?, last_active_at = ? WHERE id = ?`,
  ).run(
    t.prompt,
    t.status,
    t.pr?.url ?? null,
    t.pr?.state ?? null,
    t.pr?.state === "merged" ? at : null,
    t.pr?.state === "merged" ? "sam" : null,
    t.pr ? "a".repeat(40) : null,
    t.status === "working" ? null : (t.reply ?? null),
    t.question ?? null,
    t.error ?? null,
    merge,
    at,
    at,
    id,
  )
  db.prepare("DELETE FROM task_messages WHERE task_id = ?").run(id)
  db.prepare("DELETE FROM task_inputs WHERE task_id = ?").run(id)
  const created = Number(row(id)!.created_at)
  const add = db.prepare("INSERT INTO task_messages (id, task_id, role, content, meta_json, created_at) VALUES (?, ?, ?, ?, NULL, ?)")
  add.run(`tm_seed_${id}_0`, id, "user", t.prompt, Math.min(created, at - 120_000))
  if (t.reply) add.run(`tm_seed_${id}_1`, id, "assistant", t.reply, at - (t.mergeRequested ? 61_000 : 0))
  if (t.mergeRequested && t.pr) add.run(`tm_seed_${id}_2`, id, "user", `Merge your pull request #${t.pr.url.split("/").pop()} now (Sam pressed Merge PR).`, at - 55_000)
}

const seeded = new Map<Alias, string>()
async function seed() {
  const prUrl = (slug: string, n: number) => `https://github.com/${slug}/pull/${n}`
  // Every task runs one fake turn first, so it has a session, a workspace and a turn behind it like a real one.
  for (const t of SEED_TASKS) {
    const made = yard.tasks.createTask({ projectId, title: t.title, prompt: t.status === "working" ? `${t.prompt} ${SLOW}` : t.prompt } as Parameters<typeof yard.tasks.createTask>[0])
    seeded.set(t.alias, made.id)
  }
  const others = OTHER_PROJECT.tasks.map((t) => yard.tasks.createTask({ projectId: otherProjectId, title: t.title, prompt: t.title } as Parameters<typeof yard.tasks.createTask>[0]).id)
  for (const t of SEED_TASKS) {
    const id = seeded.get(t.alias)!
    await until(() => (t.status === "working" ? slowRunning(id) : rested(id)), `seed task ${t.alias} to settle`, 180_000)
    writeSeedTask(id, { ...t, pr: t.pr ? { url: prUrl(PROJECT.slug, t.pr.number), state: t.pr.state } : null })
  }
  for (const [i, t] of OTHER_PROJECT.tasks.entries()) {
    await until(() => rested(others[i]!), `other project's task ${i} to settle`, 180_000)
    writeSeedTask(others[i]!, { prompt: t.title, status: t.status, reply: t.reply, pr: t.pr ? { url: prUrl(OTHER_PROJECT.slug, t.pr), state: "open" } : null, agoMin: 120 + i * 30 })
  }
  for (const n of SEED_NOTES) yard.store.addNote(projectId, "Sam", n)
  // The Captain's read-only clone exists, as it does for a project whose Captain is in use.
  const view = await yard.captains.repo(projectId).open()
  if (view.kind !== "ready") {
    await until(() => yard.captains.repo(projectId).brief()?.commit, "the Captain's clone", 60_000, 200)
  }
}

interface Snapshot {
  tasks: Map<string, Row>
  messages: Set<string>
  inputs: Set<string>
  notes: Record<string, unknown>[]
  project: Record<string, unknown>
}
let snap: Snapshot
function snapshot(): Snapshot {
  const tasks = new Map<string, Row>()
  for (const id of seeded.values()) tasks.set(id, { ...row(id)! })
  const ids = [...seeded.values()]
  const q = (table: string) => new Set((db.prepare(`SELECT id FROM ${table} WHERE task_id IN (${ids.map(() => "?").join(",")})`).all(...ids) as { id: string }[]).map((r) => r.id))
  return {
    tasks,
    messages: q("task_messages"),
    inputs: q("task_inputs"),
    notes: db.prepare("SELECT * FROM project_notes WHERE project_id = ?").all(projectId) as Record<string, unknown>[],
    project: db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Record<string, unknown>,
  }
}

// ---------------------------------------------------------------- reset between cases

/** Columns a working seed task keeps from its live turn when it's put back. */
const LIVE = new Set(["current_turn_id", "event_cursor", "box_id", "session_id", "session_started", "turn_count", "turn_flags_json", "archive_path", "last_archived_at", "archive_kind", "push_state_json", "port_base", "context_tokens", "context_window"])
function restoreRow(id: string, keepLive: boolean) {
  const saved = snap.tasks.get(id)!
  const seedTask = SEED_TASKS.find((t) => seeded.get(t.alias) === id)!
  const cols = Object.keys(saved).filter((k) => k !== "id" && !(keepLive && LIVE.has(k)))
  const values = cols.map((k) => saved[k] as never)
  db.prepare(`UPDATE tasks SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...values, id)
  // "N minutes ago" stays true however long the run takes.
  const at = Date.now() - seedTask.agoMin * 60_000
  db.prepare("UPDATE tasks SET updated_at = ?, last_active_at = ? WHERE id = ?").run(at, at, id)
}
function dropAdded(id: string) {
  for (const [table, keepIds] of [["task_messages", snap.messages], ["task_inputs", snap.inputs]] as const) {
    const rows = db.prepare(`SELECT id FROM ${table} WHERE task_id = ?`).all(id) as { id: string }[]
    for (const r of rows) if (!keepIds.has(r.id)) db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(r.id)
  }
}

async function stopIfBusy(id: string) {
  const r = row(id)
  if (!r || (!r.current_turn_id && !BUSY.has(r.status))) return
  await yard.tasks.stopTask(id).catch(() => {})
  await until(() => rested(id), `task ${id} to stop`, 60_000).catch(() => {})
}

const captainOf = () => yard.captains.get(projectId) as unknown as {
  wakeTimer: NodeJS.Timeout | null
  wakeWanted: boolean
  pending: boolean
  autoTurns: number
  lastError: string | null
  running: boolean
  drain: () => Promise<void>
}

async function reset(kase: Case) {
  await until(() => !yard.captains.state(projectId).busy, "the Captain to be idle", 600_000, 200)
  // What the last case started: its tasks (and their sub-tasks) go.
  const seededIds = new Set(seeded.values())
  for (let pass = 0; pass < 3; pass++) {
    const extra = (db.prepare("SELECT id FROM tasks WHERE project_id = ? AND parent_task_id IS NULL").all(projectId) as { id: string }[]).filter((r) => !seededIds.has(r.id))
    if (!extra.length) break
    for (const { id } of extra) {
      await stopIfBusy(id)
      await yard.tasks.deleteTask(id).catch((err) => console.error(`couldn't delete ${id}: ${(err as Error).message}`))
    }
  }
  db.prepare("DELETE FROM schedules WHERE project_id = ?").run(projectId)
  // The seeded tasks as they were.
  for (const t of SEED_TASKS) {
    const id = seeded.get(t.alias)!
    const saved = snap.tasks.get(id)!
    if (t.status === "working") {
      const r = row(id)!
      if (r.current_turn_id !== saved.current_turn_id || r.status !== "working") {
        // Its endless turn was interrupted or replaced (a message with interrupt): start another.
        await stopIfBusy(id)
        restoreRow(id, true)
        yard.tasks.sendInput(id, SLOW, "cody")
        await until(() => slowRunning(id), `task ${t.alias} to run again`, 120_000)
        const now = row(id)!
        snap.tasks.set(id, { ...saved, ...Object.fromEntries([...LIVE].map((k) => [k, now[k]])) })
      }
      dropAdded(id)
      restoreRow(id, true)
    } else {
      await stopIfBusy(id)
      dropAdded(id)
      restoreRow(id, false)
    }
  }
  // Notes and suggestions as seeded.
  db.prepare("DELETE FROM note_suggestions WHERE project_id = ?").run(projectId)
  db.prepare("DELETE FROM project_notes WHERE project_id = ?").run(projectId)
  for (const n of snap.notes) {
    const cols = Object.keys(n)
    db.prepare(`INSERT INTO project_notes (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((k) => n[k] as never))
  }
  const projectCols = Object.keys(snap.project).filter((k) => k !== "id")
  db.prepare(`UPDATE projects SET ${projectCols.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...projectCols.map((k) => snap.project[k] as never), projectId)
  if (kase.setup?.projectRunner) db.prepare("UPDATE projects SET runner = ? WHERE id = ?").run(kase.setup.projectRunner, projectId)
  // A fresh conversation: no chat, no session, nothing queued.
  const cap = captainOf()
  if (cap.wakeTimer) clearTimeout(cap.wakeTimer)
  cap.wakeTimer = null
  cap.wakeWanted = false
  cap.pending = false
  cap.autoTurns = 0
  cap.lastError = null
  await sleep(300)
  db.prepare("DELETE FROM captain_messages WHERE project_id = ?").run(projectId)
  db.prepare("DELETE FROM kv WHERE key LIKE 'captain%:' || ?").run(projectId)
}

// ---------------------------------------------------------------- one case

const CLAUDE_PROJECTS = path.join(os.homedir(), ".claude", "projects")
function sessionFile(sessionId: string): string | null {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return null
  for (const d of fs.readdirSync(CLAUDE_PROJECTS)) {
    const f = path.join(CLAUDE_PROJECTS, d, `${sessionId}.jsonl`)
    if (fs.existsSync(f)) return f
  }
  return null
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s)
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((b: { type?: string; text?: string; content?: unknown }) => (b.type === "text" ? (b.text ?? "") : b.content !== undefined ? textOf(b.content) : "")).join("\n") : ""

/** The session's transcript: what the Captain read, said and called, with each tool's result. */
function readSession(sessionId: string | null): { transcript: TranscriptLine[]; tools: ToolCall[]; finalText: string } {
  const file = sessionId ? sessionFile(sessionId) : null
  if (!file) return { transcript: [], tools: [], finalText: "" }
  const transcript: TranscriptLine[] = []
  const tools: ToolCall[] = []
  const byId = new Map<string, ToolCall>()
  let finalText = ""
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue
    let m: { type?: string; message?: { content?: unknown } }
    try {
      m = JSON.parse(line)
    } catch {
      continue
    }
    const content = m.message?.content
    if (m.type === "user") {
      if (typeof content === "string") transcript.push({ k: "user", text: clip(content, 6000) })
      else if (Array.isArray(content))
        for (const b of content as { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean; text?: string }[]) {
          if (b.type === "tool_result") {
            const text = textOf(b.content)
            transcript.push({ k: "result", text: clip(text, 1500), isError: Boolean(b.is_error) })
            const call = b.tool_use_id ? byId.get(b.tool_use_id) : undefined
            if (call) Object.assign(call, { result: clip(text, 4000), isError: Boolean(b.is_error) })
          } else if (b.type === "text" && b.text) transcript.push({ k: "user", text: clip(b.text, 6000) })
        }
    } else if (m.type === "assistant" && Array.isArray(content)) {
      for (const b of content as { type: string; text?: string; name?: string; input?: Record<string, unknown>; id?: string }[]) {
        if (b.type === "text" && b.text?.trim()) {
          transcript.push({ k: "text", text: b.text })
          finalText = b.text
        } else if (b.type === "tool_use") {
          transcript.push({ k: "tool", name: String(b.name), input: b.input })
          const call: ToolCall = { name: String(b.name), input: b.input ?? {} }
          tools.push(call)
          if (b.id) byId.set(b.id, call)
        }
      }
    }
  }
  return { transcript, tools, finalText }
}

const MESSAGING = new Set(["send_to_task", "reopen_task", "retry_task", "continue_task"])
const fill = (text: string) =>
  text.replace(/\{(\w+)\.(id|title)\}/g, (_, alias: Alias, what: "id" | "title") => {
    const id = seeded.get(alias)
    if (!id) throw new Error(`No seeded task ${alias}`)
    return what === "id" ? id : SEED_TASKS.find((t) => t.alias === alias)!.title
  })

let retroRun = 0
async function runCase(kase: Case, rep: number): Promise<RunRecord> {
  const cap = captainOf()
  const notesOf = () => Object.fromEntries((db.prepare("SELECT id, content FROM project_notes WHERE project_id = ?").all(projectId) as { id: string; content: string }[]).map((n) => [n.id, n.content]))
  const notesBefore = notesOf()
  const suggestionIds = new Map<string, string>()
  const message = kase.message ? fill(kase.message) : null
  const t0 = Date.now()
  if (kase.setup?.retro) {
    // A notes retro, as NotesRetro.flush delivers it: the CSV task's agent finished and left these suggestions.
    const csv = yard.store.getTask(seeded.get("csv")!)!
    const items = RETRO_SUGGESTIONS.map((s) => {
      const made = yard.store.addNoteSuggestion({ projectId, taskId: csv.id, taskTitle: csv.title, content: s.content, why: s.why })
      suggestionIds.set(s.key, made.id)
      return made
    })
    const { retroNotice } = await import("../../../server/retro.js")
    const ids = items.map((s) => s.id)
    yard.store.markSuggestionsInRetro(ids)
    const content = retroNotice([{ task: csv, trigger: "finished", suggestions: items }], { budget: yard.notes.budgetStatus(projectId), ownerName: "Sam" })
    // A loop key of its own each time, so the wake-up loop guard never takes repeated reps for a loop.
    yard.captains.projectNotice(projectId, content, { kind: "retro", taskIds: [csv.id], suggestionIds: ids, loopKey: `retro:${csv.id}:${++retroRun}` }, { wake: false })
    cap.wakeWanted = true
    void cap.drain()
  } else {
    await call("POST", `/api/projects/${projectId}/captain/messages`, { content: message })
  }
  let error: string | null = null
  // The turn: the Captain is busy, then idle with this turn's timing recorded.
  const timing = await until(
    () => {
      if (yard.captains.state(projectId).busy || cap.running) return null
      return yard.store.listTurnTimings({ since: t0, role: "captain", projectId, limit: 50 }).filter((t) => t.kind === "turn" && t.startedAt >= t0 - 1000).at(-1) ?? null
    },
    "the Captain's turn",
    15 * 60_000,
    100,
  ).catch((err) => {
    error = (err as Error).message
    yard.captains.stopTurn(projectId)
    return null
  })
  await sleep(500)
  const msgs = yard.store.listCaptainMessages(projectId, 500).filter((m) => m.createdAt >= t0 - 1000)
  const errors = msgs.filter((m) => m.role === "error")
  if (errors.length) error ??= errors.map((m) => m.content).join("; ").slice(0, 1000)
  const sessionId = yard.store.getKv(`captain_session:${projectId}`)
  const session = readSession(sessionId)
  // The tools as the session saw them (with results); the chat's own record when the session file isn't there.
  const tools: ToolCall[] = session.tools.length ? session.tools : msgs.filter((m) => m.role === "tool").map((m) => ({ name: m.content, input: (m.meta?.input ?? {}) as Record<string, unknown> }))
  const seededIds = new Set(seeded.values())
  const createdRows = (db.prepare("SELECT id, title, prompt, created_at FROM tasks WHERE project_id = ? AND parent_task_id IS NULL AND created_at >= ?").all(projectId, t0 - 1000) as { id: string; title: string; prompt: string }[]).filter((r) => !seededIds.has(r.id))
  const created: CreatedTask[] = createdRows.map((r) => ({ id: r.id, title: r.title, prompt: r.prompt }))
  const aliasOf = (ref: string): Alias | null => {
    const want = ref.trim().toLowerCase()
    for (const t of SEED_TASKS) if (seeded.get(t.alias) === ref.trim() || t.title.toLowerCase() === want) return t.alias
    return null
  }
  const sends: Send[] = tools
    .filter((t) => MESSAGING.has(t.name.replace(/^mcp__boxyard__/, "")))
    .map((t) => {
      const ref = String(t.input.task ?? "")
      const alias = aliasOf(ref)
      const toNew = !alias && created.some((x) => x.id === ref.trim() || x.title.toLowerCase() === ref.trim().toLowerCase())
      return { tool: t.name.replace(/^mcp__boxyard__/, ""), ref, alias, message: String(t.input.message ?? ""), isError: t.isError, ...(toNew ? { toNew } : {}) }
    })
  const suggestions: RunRecord["suggestions"] = {}
  for (const [key, id] of suggestionIds) {
    const s = yard.store.getNoteSuggestion(id)
    suggestions[key] = { status: s?.status ?? "missing", resolvedBy: s?.resolvedBy ?? null, reason: s?.reason ?? null }
  }
  const usage = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM claude_usage WHERE source = 'captain' AND project_id = ? AND started_at >= ?").get(projectId, t0 - 1000) as { cost: number }
  const timings = yard.store.listTurnTimings({ since: t0, role: "captain", projectId, limit: 50 }).filter((t) => t.startedAt >= t0 - 1000)
  const resultAt = timing ? timing.endedAt - (timing.tailMs ?? 0) : null
  const waitMs = timings.flatMap((t) => t.steps).filter((s) => s.k === "tool" && /wait_for_tasks$/.test(s.name ?? "")).reduce((a, s) => a + s.ms, 0)
  return {
    caseId: kase.id,
    effort: fakeCaptain ? "fake" : effort,
    ...(label ? { label } : {}),
    rep,
    message,
    tools,
    replies: msgs.filter((m) => m.role === "assistant").map((m) => m.content),
    finalText: session.finalText || (msgs.filter((m) => m.role === "assistant").at(-1)?.content ?? ""),
    created,
    sends,
    notesBefore,
    notesAfter: notesOf(),
    suggestions,
    ok: Boolean(timing?.ok) && !error,
    error,
    latencyMs: resultAt === null ? null : resultAt - t0,
    waitMs,
    modelMs: timings.reduce((a, t) => a + t.modelMs, 0),
    costUsd: usage.cost,
    modelCalls: timings.reduce((a, t) => a + t.modelCalls, 0),
    tokens: {
      input: timings.reduce((a, t) => a + t.inputTokens, 0),
      output: timings.reduce((a, t) => a + t.outputTokens, 0),
      cacheRead: timings.reduce((a, t) => a + t.cacheReadTokens, 0),
      cacheWrite: timings.reduce((a, t) => a + t.cacheWriteTokens, 0),
    },
    transcript: session.transcript,
    at: new Date(t0).toISOString(),
  }
}

// ---------------------------------------------------------------- the run

/** The Captain's session folders this run made in ~/.claude/projects (named after the scratch folder's path). */
function removeSessionFolders() {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return 0
  const tag = path.basename(dataDir).replace(/[^a-zA-Z0-9]/g, "-")
  let n = 0
  for (const d of fs.readdirSync(CLAUDE_PROJECTS)) {
    if (!d.includes(tag)) continue
    fs.rmSync(path.join(CLAUDE_PROJECTS, d), { recursive: true, force: true })
    n++
  }
  return n
}

let spent = 0
let stopped: string | null = null
/** What every result file in --out's folder has spent so far (this run's included). */
function spentInFolder(): number {
  const dir = path.dirname(out)
  let total = 0
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue
      try {
        total += Number((JSON.parse(line) as { costUsd?: number }).costUsd ?? 0)
      } catch {
        // A line another run is still writing.
      }
    }
  }
  return total
}
// Ctrl-C or kill: finish the case under way, then stop every agent and clean up (a killed run leaves detached fakes).
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (stopped ??= sig))
fs.mkdirSync(path.dirname(out), { recursive: true })
try {
  console.error(`[eval] ${label ?? effort} on ${model}${fakeCaptain ? " (fake Captain)" : ""}: seeding in ${dataDir}`)
  await seed()
  await sleep(1500)
  snap = snapshot()
  console.error(`[eval] seeded ${seeded.size} tasks; ${cases.length} case(s) × ${reps} rep(s)`)
  outer: for (let rep = 1; rep <= reps; rep++) {
    for (const kase of cases) {
      if (stopped) break outer
      const folder = spentInFolder()
      if (folder >= totalBudget) {
        stopped = `total budget: $${folder.toFixed(2)} spent by the runs in ${path.dirname(out)}, at or over $${totalBudget}`
        break outer
      }
      await reset(kase)
      const r = await runCase(kase, rep)
      const g = grade(kase, r)
      spent += r.costUsd
      fs.appendFileSync(out, JSON.stringify({ ...r, grade: g }) + "\n")
      const failed = g.checks.filter((x) => !x.pass).map((x) => `${x.name}: ${x.detail}`)
      console.error(
        `[eval] ${label ?? effort} rep ${rep} ${kase.id}: ${g.pass ? "PASS" : g.passDeterministic ? "pass (judge pending)" : "FAIL"} ${r.latencyMs === null ? "–" : `${(r.latencyMs / 1000).toFixed(1)} s`} $${r.costUsd.toFixed(3)} (total $${spent.toFixed(2)})${failed.length ? `\n         ${failed.join("\n         ")}` : ""}`,
      )
      if (spent > budget) {
        stopped = `budget: $${spent.toFixed(2)} spent, over this run's $${budget}`
        break outer
      }
    }
  }
} finally {
  if (stopped) console.error(`[eval] stopped early: ${stopped}`)
  // Local agents run detached (they outlive the server): stop every one, the endless seeded turns included.
  for (const r of db.prepare("SELECT id FROM tasks WHERE current_turn_id IS NOT NULL OR status IN ('queued', 'starting', 'working')").all() as { id: string }[]) {
    await yard.tasks.stopTask(r.id).catch(() => {})
  }
  await sleep(2000)
  yard.stop()
  await new Promise((r) => server.close(() => r(null)))
  const removed = removeSessionFolders()
  console.error(`[eval] spent $${spent.toFixed(2)}; removed ${removed} Claude session folder(s)${keep ? `; data kept in ${dataDir}` : ""}`)
  if (!keep) fs.rmSync(dataDir, { recursive: true, force: true })
}
process.exit(0)
