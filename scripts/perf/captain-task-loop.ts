// The whole loop the owner waits on, on this computer's local runner: a message to a project's Captain → the Captain
// starts a task → the task's agent does something trivial and replies → the Captain hears it and answers. It times
// every phase and splits the total into model time (waiting on the API), the CLI's own start-up and exit, and Box Yard.
//
//   npx tsx scripts/perf/captain-task-loop.ts [rounds=5] --real [--label baseline] [--json out.json] [--port 4701]
//     [--data /tmp/dir] [--model claude-opus-5-5] [--effort medium] [--scenario wait|wake] [--wake-debounce 3000]
//     [--wake-quiet 250] [--poll-ms 1500] [--settings '{"claudeTelemetry":false}'] [--keep]
//   npx tsx scripts/perf/captain-task-loop.ts [rounds] --mock     (fake-claude, no Captain: Box Yard's launch and turn end only)
//   npx tsx scripts/perf/captain-task-loop.ts --summarize a.json b.json ...     (a table of saved runs, side by side)
//
// --real runs the real `claude` on this computer's own login and spends tokens (about $0.50 a round on Opus);
// without it the script only prints what it would do. It runs its own server in a scratch data folder (never a live
// one, never ~/.boxyard), with a bare file:// repo as the project's origin, so the turn-end push is real but has no
// network in it. One warm-up round comes first and isn't counted: the first spawn and the first prompt cache write.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Server } from "node:http"

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

// ---------------------------------------------------------------- summary of saved runs

interface Step {
  k: "model" | "tool"
  name?: string
  at: number
  ms: number
}
interface Timing {
  id: string
  role: string
  trigger: string | null
  taskId: string | null
  startedAt: number
  endedAt: number
  requestedAt: number | null
  queueMs: number | null
  setupMs: number | null
  startupMs: number | null
  firstTokenMs: number | null
  modelMs: number
  toolMs: number
  tailMs: number | null
  wallMs: number
  apiMs: number | null
  cliMs: number | null
  modelCalls: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  resumed: boolean
  steps: Step[]
}
interface Mark {
  at: number
  scope: string
  name: string
  ms?: number
}
interface Round {
  i: number
  word: string
  t0: number
  postedAt: number
  taskId: string
  taskCreatedAt: number
  /** The task's "finished its turn" notice on the Captain's chat. */
  noticeAt: number
  /** The Captain's answer with the task's word: the end of the loop. */
  replyAt: number
  /** The Captain's first words after the message (its "started a task" line), or null. */
  firstReplyAt: number | null
  /** The task row showed up for the owner (its SSE event). */
  taskSeenAt: number | null
  correct: boolean
  timings: Timing[]
  marks: Mark[]
  costUsd: number
  usage: { source: string; model: string; costUsd: number | null; input: number; output: number; cacheRead: number; cacheWrite: number }[]
}
interface Saved {
  label: string
  at: string
  options: Record<string, unknown>
  rounds: Round[]
}

const sum = (v: number[]) => v.reduce((a, b) => a + b, 0)
function pct(values: (number | null | undefined)[], p: number): number | null {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))]!
}
const sec = (ms: number | null | undefined) => (typeof ms === "number" && Number.isFinite(ms) ? `${(ms / 1000).toFixed(ms < 9950 ? 2 : 1)} s` : "–")

/**
 * One round's phases on the critical path, in the order they happen (ms each), and the three-way split. The Captain
 * answers one of two ways: it waits in its first turn (wait_for_tasks) and answers there, or it ends that turn and a
 * wake-up turn answers once the task's update arrives.
 */
function phases(r: Round) {
  const captain = r.timings.filter((t) => t.role === "captain").sort((a, b) => a.startedAt - b.startedAt)
  const task = r.timings.find((t) => t.role === "task" && t.taskId === r.taskId) ?? null
  const isCreate = (s: Step) => s.k === "tool" && /create_tasks?$/.test(s.name ?? "")
  const c1 = captain.find((t) => t.steps.some(isCreate)) ?? null
  const abs = (t: Timing, s: Step) => t.startedAt + s.at
  // The first turn's reply is relayed at its result line, which is before the process exits.
  const waited = c1 !== null && r.replyAt <= c1.endedAt + 50
  const c2 = waited ? null : ([...captain].reverse().find((t) => t !== c1 && t.startedAt <= r.replyAt) ?? null)
  const mark = (scope: string, name: string) => r.marks.find((m) => m.scope === scope && m.name === name) ?? null
  const span = (name: string) => mark(r.taskId, name)?.ms ?? null
  const create = c1?.steps.find(isCreate) ?? null
  const createAt = c1 && create ? abs(c1, create) : null
  // Model steps of the first Captain turn that the task waits on: those before create_task.
  const c1ModelBefore = c1 && createAt !== null ? sum(c1.steps.filter((s) => s.k === "model" && abs(c1, s) < createAt).map((s) => s.ms)) : null
  const c1ToolsBefore = c1 && createAt !== null ? sum(c1.steps.filter((s) => s.k === "tool" && abs(c1, s) < createAt).map((s) => s.ms)) : null
  const wait = waited && c1 ? ([...c1.steps].reverse().find((s) => s.k === "tool" && /wait_for_tasks$/.test(s.name ?? "")) ?? null) : null
  const waitEnd = c1 && wait ? abs(c1, wait) + wait.ms : null
  const launchAt = mark(r.taskId, "launch")?.at ?? (task && task.setupMs !== null ? task.startedAt - task.setupMs : null)
  const seenAt = mark(r.taskId, "turn.end.seen")?.at ?? null
  const c1Ready = c1 && c1.startupMs !== null ? c1.startedAt + c1.startupMs : null
  const taskReady = task && task.startupMs !== null ? task.startedAt + task.startupMs : null
  const taskResult = task ? task.endedAt - (task.tailMs ?? 0) : null
  const c2Ready = c2 && c2.startupMs !== null ? c2.startedAt + c2.startupMs : null
  const d = (a: number | null | undefined, b: number | null | undefined) => (typeof a === "number" && typeof b === "number" ? Math.max(0, b - a) : null)
  const list: { key: string; label: string; kind: "model" | "cli" | "app"; ms: number | null }[] = [
    { key: "c1Queue", label: "Message posted → Captain CLI spawned", kind: "app", ms: d(r.t0, c1?.startedAt) },
    { key: "c1Startup", label: "Captain CLI start-up (spawn → ready)", kind: "cli", ms: c1?.startupMs ?? null },
    { key: "c1Model", label: "Captain model steps before create_task", kind: "model", ms: c1ModelBefore },
    { key: "c1Tools", label: "Captain tool calls before create_task", kind: "app", ms: c1ToolsBefore },
    { key: "c1Other", label: "Captain turn: other time before create_task", kind: "cli", ms: c1Ready !== null && createAt !== null ? Math.max(0, createAt - c1Ready - (c1ModelBefore ?? 0) - (c1ToolsBefore ?? 0)) : null },
    { key: "create", label: "create_task call → task row", kind: "app", ms: d(createAt, r.taskCreatedAt) },
    { key: "schedule", label: "Task row → launch (queue, placement)", kind: "app", ms: d(r.taskCreatedAt, launchAt) },
    { key: "setup", label: "Launch → task CLI spawned (workspace, runner)", kind: "app", ms: d(launchAt, task?.startedAt) },
    { key: "taskStartup", label: "Task CLI start-up (spawn → ready)", kind: "cli", ms: task?.startupMs ?? null },
    { key: "taskModel", label: "Task model steps", kind: "model", ms: task?.modelMs ?? null },
    { key: "taskTools", label: "Task tool calls (ToolSearch, finish)", kind: "app", ms: task?.toolMs ?? null },
    { key: "taskOther", label: "Task turn: other time before its result", kind: "cli", ms: taskReady !== null && taskResult !== null && task ? Math.max(0, taskResult - taskReady - task.modelMs - task.toolMs) : null },
    { key: "taskTail", label: "Task CLI exit tail (result → exit)", kind: "cli", ms: task?.tailMs ?? null },
    { key: "seen", label: "Task CLI exit → Box Yard sees turn_end", kind: "app", ms: d(task?.endedAt, seenAt) },
    { key: "finish", label: "turn_end seen → finish notice to the Captain", kind: "app", ms: d(seenAt, r.noticeAt) },
    { key: "waitReturn", label: "Waiting path: notice → wait_for_tasks returns", kind: "app", ms: waited ? d(r.noticeAt, waitEnd) : null },
    { key: "waitAnswer", label: "Waiting path: Captain's last model step → answer shown", kind: "model", ms: waited ? d(waitEnd, r.replyAt) : null },
    { key: "wake", label: "Wake path: notice → Captain CLI spawned (debounce)", kind: "app", ms: waited ? null : d(r.noticeAt, c2?.startedAt) },
    { key: "c2Startup", label: "Wake path: Captain CLI start-up", kind: "cli", ms: waited ? null : (c2?.startupMs ?? null) },
    { key: "c2Answer", label: "Wake path: ready → answer shown", kind: "model", ms: waited ? null : d(c2Ready, r.replyAt) },
  ]
  const total = r.replyAt - r.t0
  const by = (kind: string) => sum(list.filter((p) => p.kind === kind).map((p) => p.ms ?? 0))
  const model = by("model")
  const cli = by("cli")
  const ttft = (t: Timing | null) => (t && t.firstTokenMs !== null && t.startupMs !== null ? t.firstTokenMs - t.startupMs : null)
  return {
    total,
    model,
    cli,
    app: total - model - cli,
    list,
    waited,
    turns: { c1, task, c2 },
    ttft: { c1: ttft(c1), task: ttft(task), c2: ttft(c2) },
    spans: { check: span("launch.check"), workspace: span("launch.workspace"), runner: span("launch.runner"), author: span("launch.author"), cli: span("launch.cli"), start: span("launch.start") },
    firstWords: r.firstReplyAt === null ? null : r.firstReplyAt - r.t0,
    taskSeen: r.taskSeenAt === null ? null : r.taskSeenAt - r.t0,
    taskStarted: task ? task.startedAt - r.t0 : null,
    // Captain turns nobody asked for: a wake-up that answered "(no update)" after the loop was already answered.
    extraTurns: captain.filter((t) => t !== c1 && t !== c2).length,
  }
}

function summarize(files: string[]) {
  const runs = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")) as Saved)
  const out: string[] = []
  const base = runs[0]!
  const stat = (run: Saved, of: (p: ReturnType<typeof phases>) => number | null, p: number) => pct(run.rounds.map((r) => of(phases(r))), p)
  out.push("| Variant | n | Total p50 | Total p90 | Model p50 | CLI p50 | Box Yard p50 | vs first | Task shown p50 | Task agent running p50 | $ / round | Extra Captain turns | Answered waiting | correct |")
  out.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
  const baseTotal = stat(base, (p) => p.total, 0.5)
  for (const run of runs) {
    const total = stat(run, (p) => p.total, 0.5)
    const delta = total !== null && baseTotal !== null && run !== base ? `${total <= baseTotal ? "−" : "+"}${sec(Math.abs(total - baseTotal))}` : "–"
    out.push(
      `| ${run.label} | ${run.rounds.length} | ${sec(total)} | ${sec(stat(run, (p) => p.total, 0.9))} | ${sec(stat(run, (p) => p.model, 0.5))} | ${sec(stat(run, (p) => p.cli, 0.5))} | ${sec(stat(run, (p) => p.app, 0.5))} | ${delta} | ${sec(stat(run, (p) => p.taskSeen, 0.5))} | ${sec(stat(run, (p) => p.taskStarted, 0.5))} | $${(sum(run.rounds.map((r) => r.costUsd)) / Math.max(1, run.rounds.length)).toFixed(3)} | ${sum(run.rounds.map((r) => phases(r).extraTurns))} | ${run.rounds.filter((r) => phases(r).waited).length}/${run.rounds.length} | ${run.rounds.filter((r) => r.correct).length}/${run.rounds.length} |`,
    )
  }
  out.push("", `| Phase (p50) | kind | ${runs.map((r) => r.label).join(" | ")} |`, `|---|---|${runs.map(() => "---:").join("|")}|`)
  const keys = phases(base.rounds[0]!).list
  for (const k of keys) {
    out.push(`| ${k.label} | ${k.kind === "app" ? "Box Yard" : k.kind === "cli" ? "CLI" : "model"} | ${runs.map((run) => sec(stat(run, (p) => p.list.find((x) => x.key === k.key)?.ms ?? null, 0.5))).join(" | ")} |`)
  }
  out.push("", `| Launch step (p50) | ${runs.map((r) => r.label).join(" | ")} |`, `|---|${runs.map(() => "---:").join("|")}|`)
  for (const k of ["check", "workspace", "runner", "author", "cli", "start"] as const) {
    out.push(`| ${k} | ${runs.map((run) => sec(stat(run, (p) => p.spans[k], 0.5))).join(" | ")} |`)
  }
  out.push("", `| Tokens per turn (p50) | ${runs.map((r) => r.label).join(" | ")} |`, `|---|${runs.map(() => "---:").join("|")}|`)
  for (const [label, pick] of [
    ["Captain turn 1", (p: ReturnType<typeof phases>) => p.turns.c1],
    ["Task turn", (p: ReturnType<typeof phases>) => p.turns.task],
    ["Captain wake", (p: ReturnType<typeof phases>) => p.turns.c2],
  ] as const) {
    for (const [what, of] of [
      ["cache read", (t: Timing) => t.cacheReadTokens],
      ["cache write", (t: Timing) => t.cacheWriteTokens],
      ["uncached input", (t: Timing) => t.inputTokens],
      ["output", (t: Timing) => t.outputTokens],
      ["model calls", (t: Timing) => t.modelCalls],
      ["first token after ready, ms", (t: Timing) => (t.firstTokenMs !== null && t.startupMs !== null ? t.firstTokenMs - t.startupMs : null)],
      ["API ms (CLI's duration_api_ms)", (t: Timing) => t.apiMs],
    ] as const) {
      out.push(`| ${label}: ${what} | ${runs.map((run) => {
        const v = pct(run.rounds.map((r) => { const t = pick(phases(r)); return t ? of(t) : null }), 0.5)
        return v === null ? "–" : String(Math.round(v))
      }).join(" | ")} |`)
    }
  }
  console.log(out.join("\n"))
}

if (flag("--summarize")) {
  summarize(args)
  process.exit(0)
}

// ---------------------------------------------------------------- the run

const real = flag("--real")
// --mock: fake-claude stands in for the model and the task is created directly (no Captain), so only Box Yard's own
// launch and turn-end phases are timed. Free, and steady enough to compare a 100 ms change.
const mock = flag("--mock")
const keep = flag("--keep")
const label = opt("--label") ?? "run"
const jsonOut = opt("--json")
const port = Number(opt("--port") ?? 4701)
const model = opt("--model") ?? "claude-opus-5-5"
const effort = opt("--effort") ?? "medium"
const wakeDebounce = opt("--wake-debounce")
const wakeQuiet = opt("--wake-quiet")
const pollMs = opt("--poll-ms")
const dataDir = path.resolve(opt("--data") ?? fs.mkdtempSync(path.join(os.tmpdir(), "box-yard-loop-")))
// "wait": the Captain may wait for the task in its turn (what it does for quick work). "wake": it's told to end its
// turn, so the answer comes from the wake-up turn the task's update starts.
const scenario = opt("--scenario") ?? "wait"
const rounds = Number(args[0] ?? 5)
if (!real && !mock) {
  console.log(`Would run ${rounds} round(s) (+1 warm-up) of Captain → task → reply on ${model} (${effort}) with the real claude CLI, in ${dataDir} on port ${port}. Pass --real to spend the tokens.`)
  process.exit(0)
}

// The server reads its config from the environment as it loads: nothing of the shell that started this (an agent's own
// session, a live server's port or token) may reach it. This computer's own `claude` login is what it runs on.
for (const k of Object.keys(process.env)) {
  if (/^(CLAUDECODE$|CLAUDE_|BOXYARD_|GITHUB_TOKEN$|GH_TOKEN$|GIT_AUTHOR_|GIT_COMMITTER_|ANTHROPIC_|PORT$|UPSTASH_|BOX_|CODEX_|ORCHESTRATOR_|CAPTAIN_|WORKER_)/.test(k)) delete process.env[k]
}
fs.mkdirSync(dataDir, { recursive: true })
process.env.BOXYARD_DATA_DIR = dataDir
process.env.BOXYARD_HOME = path.join(dataDir, "home")
process.env.BOXYARD_LOCAL_DIR = path.join(dataDir, "workspaces")
process.env.DISABLE_AUTOUPDATER = "1"
if (mock) process.env.BOXYARD_MOCK = "1"
// No GitHub login either: the server would hand this computer's `gh` token to the bench's agents.
process.env.GH_CONFIG_DIR = path.join(dataDir, "gh")
fs.mkdirSync(process.env.GH_CONFIG_DIR, { recursive: true })
for (const pair of opt("--env")?.split(",") ?? []) {
  const [k, v] = pair.split("=")
  if (k) process.env[k] = v ?? "1"
}

const { config: baseConfig } = await import("../../server/config.js")
const { createBoxYard } = await import("../../server/app.js")
const { onPerfMark } = await import("../../server/perfTrace.js")
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
  mock,
  claudeBin: mock ? baseConfig.claudeBin : "claude",
  githubToken: "",
  // The Captain's reports mustn't start Coordinator turns: this measures the Captain's chat.
  orchestratorAutoWake: false,
  selfBoxId: "",
  // A busy laptop mustn't hold the task back: placement waits are not what this measures.
  diskMinFreeMb: 0,
  memoryMaxUsedPercent: 0,
  memoryMinFreeMb: 0,
  loadMaxPerCpu: 0,
  localDiskMinFreeGb: 0,
  ...(pollMs ? { pollMs: Number(pollMs) } : {}),
}

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "-c", "init.defaultBranch=main", ...a], { cwd, stdio: "pipe" }).toString().trim()
const originRoot = path.join(dataDir, "origin")
const bare = path.join(originRoot, "origin.git")
if (!fs.existsSync(bare)) {
  fs.mkdirSync(originRoot, { recursive: true })
  const seed = path.join(originRoot, "seed")
  git(originRoot, "init", "-q", "--bare", "-b", "main", bare)
  git(bare, "config", "uploadpack.allowFilter", "true")
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true")
  git(originRoot, "init", "-q", "-b", "main", seed)
  fs.writeFileSync(path.join(seed, "README.md"), "# Bench repo\n\nA scratch repository for scripts/perf/captain-task-loop.ts.\n")
  git(seed, "add", ".")
  git(seed, "commit", "-qm", "init")
  git(seed, "push", "-q", bare, "main")
}

const marks: Mark[] = []
onPerfMark((m) => marks.push(m))
const yard = createBoxYard(c, { webDir: "/nonexistent" })
const server = await new Promise<Server>((resolve) => {
  const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
})
await yard.start()
const base = `http://127.0.0.1:${port}`
const tuning = yard.captains.tuning
if (wakeDebounce) tuning.wakeDebounceMs = Number(wakeDebounce)
if (wakeQuiet) tuning.wakeQuietMs = Number(wakeQuiet)
const settingsPatch = opt("--settings")
yard.settings.update({ captainModel: model, captainEffort: effort, agentModel: model, agentEffort: effort, gitUserName: "Bench", gitUserEmail: "bench@example.invalid", ...(settingsPatch ? JSON.parse(settingsPatch) : {}) })

async function call<T>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json()
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${JSON.stringify(data)}`)
  return data as T
}
async function until<T>(fn: () => T | null | undefined | false, what: string, ms = 300_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - start > ms) throw new Error(`Timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

// When each task row first reached the owner's screen (the SSE event the UI lists it from).
const taskSeen = new Map<string, number>()
const broadcast = yard.hub.broadcast.bind(yard.hub)
yard.hub.broadcast = ((event: { type: string; task?: { id: string } }) => {
  if (event.type === "task") {
    const id = event.task?.id
    if (id && !taskSeen.has(id)) taskSeen.set(id, Date.now())
  }
  return broadcast(event as never)
}) as typeof yard.hub.broadcast

let project = yard.store.listProjects().find((p) => p.name === "bench") as { id: string } | undefined
if (!project) {
  project = await call<{ id: string }>("POST", "/api/projects", { name: "bench", runner: "local" })
  // The API only takes GitHub-style repos; the bench's origin is a bare repo on this disk.
  yard.store.db.prepare("UPDATE projects SET repo = ? WHERE id = ?").run(`file://${bare}`, project.id)
}
const projectId = project.id
const captainIdle = () => !yard.captains.state(projectId)?.busy
const quiet = () => captainIdle() && yard.store.listTaskRows().every((t) => !t.current_turn_id && !["queued", "starting", "working"].includes(t.status))

const saved: Saved = { label, at: new Date().toISOString(), options: { scenario, model, effort, wakeDebounceMs: tuning.wakeDebounceMs, wakeQuietMs: tuning.wakeQuietMs, pollMs: c.pollMs, claude: mock ? "fake-claude" : execFileSync("claude", ["--version"]).toString().trim(), settings: settingsPatch ?? null, env: process.env.BOXYARD_BENCH_NOTE ?? null }, rounds: [] }
const save = () => jsonOut && fs.writeFileSync(jsonOut, JSON.stringify(saved, null, 2))

try {
  for (let i = 0; i <= rounds; i++) {
    await until(quiet, "everything idle before the round")
    // The turn-end push and archive of the round before: let them finish, so they don't share this round's CPU.
    await new Promise((r) => setTimeout(r, mock ? 300 : 1500))
    const word = `PONG-${i}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
    const beforeTasks = new Set(yard.store.listTasks({ projectId }).map((t) => t.id))
    const beforeTimings = new Set(yard.store.listTurnTimings({ since: 0, limit: 10_000 }).map((t) => t.id))
    const beforeUsage = new Set((yard.store.db.prepare("SELECT id FROM claude_usage").all() as { id: string }[]).map((u) => u.id))
    const markFrom = marks.length
    const ask = `Start one new task titled "Ping ${i}" whose prompt is exactly: "Reply with exactly the word ${word} and nothing else. Change no files."`
    const content =
      scenario === "wake"
        ? `${ask} Don't call wait_for_tasks: end your turn as soon as it's started, and when its update arrives tell me the word it replied with.`
        : `${ask} When it has finished, tell me the word it replied with.`
    if (mock) {
      const t0 = Date.now()
      const made = yard.tasks.createTask({ projectId, title: `Ping ${i}`, prompt: `Reply with ${word}.` } as Parameters<typeof yard.tasks.createTask>[0])
      const end = await until(() => marks.slice(markFrom).find((m) => m.scope === made.id && m.name === "turn.end"), "the task's turn end", 60_000)
      await until(quiet, "everything idle after the round")
      const timings = yard.store.listTurnTimings({ since: t0 - 1000, limit: 100 }).filter((t) => !beforeTimings.has(t.id)) as unknown as Timing[]
      const round: Round = { i, word, t0, postedAt: t0, taskId: made.id, taskCreatedAt: yard.store.getTaskRow(made.id)!.created_at, noticeAt: end.at, replyAt: end.at, firstReplyAt: null, taskSeenAt: taskSeen.get(made.id) ?? null, correct: true, timings, marks: marks.slice(markFrom), costUsd: 0, usage: [] }
      if (i > 0) saved.rounds.push(round)
      continue
    }
    const t0 = Date.now()
    await call("POST", `/api/projects/${projectId}/captain/messages`, { content })
    const postedAt = Date.now()
    const task = await until(() => yard.store.listTasks({ projectId }).find((t) => !beforeTasks.has(t.id)), "the Captain to start the task")
    const notice = await until(
      () => yard.store.listCaptainMessages(projectId, 200).find((m) => m.role === "notice" && m.createdAt >= t0 && m.meta?.taskId === task.id && /finished its turn|is done|failed|needs you/.test(m.content)),
      "the task's finish notice",
    )
    const reply = await until(
      () => yard.store.listCaptainMessages(projectId, 200).find((m) => m.role === "assistant" && m.createdAt >= notice.createdAt),
      "the Captain's answer",
    )
    await until(quiet, "everything idle after the round")
    // A wake-up the round's own notice still starts (an answer of "(no update)") belongs to this round's cost.
    await new Promise((r) => setTimeout(r, tuning.wakeDebounceMs + 1000))
    await until(quiet, "everything idle after the round's wake-ups")
    const timings = yard.store.listTurnTimings({ since: t0 - 1000, limit: 100 }).filter((t) => !beforeTimings.has(t.id)) as unknown as Timing[]
    const firstReply = yard.store.listCaptainMessages(projectId, 200).find((m) => m.role === "assistant" && m.createdAt >= t0 && m.createdAt < notice.createdAt)
    const usage = (yard.store.db.prepare("SELECT * FROM claude_usage").all() as Record<string, unknown>[]).filter((u) => !beforeUsage.has(u.id as string))
    const round: Round = {
      i,
      word,
      t0,
      postedAt,
      taskId: task.id,
      taskCreatedAt: yard.store.getTaskRow(task.id)!.created_at,
      noticeAt: notice.createdAt,
      replyAt: reply.createdAt,
      firstReplyAt: firstReply?.createdAt ?? null,
      taskSeenAt: taskSeen.get(task.id) ?? null,
      correct: reply.content.includes(word),
      timings,
      marks: marks.slice(markFrom),
      costUsd: sum(usage.map((u) => Number(u.cost_usd ?? 0))),
      usage: usage.map((u) => ({ source: String(u.source), model: String(u.model), costUsd: u.cost_usd as number | null, input: Number(u.input_tokens ?? 0), output: Number(u.output_tokens ?? 0), cacheRead: Number(u.cache_read_tokens ?? 0), cacheWrite: Number(u.cache_creation_tokens ?? u.cache_write_tokens ?? 0) })),
    }
    const p = phases(round)
    process.stderr.write(
      `round ${i}${i ? "" : " (warm-up)"}: total ${sec(p.total)} = model ${sec(p.model)} + CLI ${sec(p.cli)} + Box Yard ${sec(p.app)}; first words ${sec(p.firstWords)}; $${round.costUsd.toFixed(3)}; ${round.correct ? "correct" : `WRONG: ${reply.content.slice(0, 120)}`}\n`,
    )
    if (process.env.BENCH_VERBOSE) for (const x of p.list) process.stderr.write(`    ${x.label}: ${sec(x.ms)}\n`)
    if (i > 0) saved.rounds.push(round)
    else fs.writeFileSync(path.join(dataDir, "warmup.json"), JSON.stringify(round, null, 2))
    save()
  }
} finally {
  save()
  await until(quiet, "everything idle before stopping", 60_000).catch(() => {})
  await new Promise((r) => setTimeout(r, 2000))
  yard.stop()
  await new Promise((r) => server.close(() => r(null)))
  if (keep) console.error(`Data kept in ${dataDir}`)
}
if (jsonOut && saved.rounds.length) summarize([jsonOut])
process.exit(0)
