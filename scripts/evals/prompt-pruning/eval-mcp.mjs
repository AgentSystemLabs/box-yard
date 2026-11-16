#!/usr/bin/env node
// The Box Yard MCP server as the routing eval's Captain sees it: the real tool list (prompt-budget.ts writes
// tools.captain.json), with canned answers drawn from the eval project's state (render-captain-turns.ts writes
// state.json). Nothing is created, sent or deleted: every call is logged and answered as Box Yard would.
//
//   node eval-mcp.mjs --tools tools.captain.json --state state.json --log calls.jsonl [--fixtures case-fixtures.json]
import fs from "node:fs"
import readline from "node:readline"

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const tools = JSON.parse(fs.readFileSync(opt("--tools"), "utf8"))
const state = JSON.parse(fs.readFileSync(opt("--state"), "utf8"))
const fixtures = opt("--fixtures") ? JSON.parse(fs.readFileSync(opt("--fixtures"), "utf8")) : {}
const log = opt("--log")

let made = 0
const newId = () => `task_new${String(++made).padStart(7, "0")}`
const findTask = (ref) => state.tasks.find((t) => t.id === ref || t.title.toLowerCase() === String(ref ?? "").toLowerCase())
const brief = (t) => ({ id: t.id, title: t.title, status: t.status, ...(t.prUrl ? { prUrl: t.prUrl, prState: t.prState, prCheckedAt: "1m ago" } : {}), ...(t.mergeRequested ? { mergeRequested: true } : {}), agent: t.agent })
const placed = (a) => ({ runs_on: a.runs_on ?? "box (project)", agent: a.agent ?? "claude", ...(a.model ? { model: a.model } : {}), ...(a.priority ? { priority: a.priority } : {}) })
const BOXES = [
  { box: "box_7f3a21", size: "small", disk: "1.2 of 5 GB", tasks: 0, idle: "2 days" },
  { box: "box_91c2d4", size: "medium", disk: "6.8 of 10 GB", tasks: 1, running: ["task_flaky00002"] },
]

const handlers = {
  list_tasks: (a) => ({ project: state.project.name, tasks: state.tasks.filter((t) => (a.status ? t.status === a.status : t.status !== "done")).map(brief) }),
  get_task: (a) => {
    const t = findTask(a.task)
    if (!t) throw new Error(`No task ${a.task} in this project.`)
    return { ...brief(t), ...(t.question ? { question: t.question } : {}), ...(t.error ? { error: t.error } : {}), lastReply: t.summary ?? null }
  },
  wait_for_tasks: (a) => ({ tasks: (a.tasks ?? []).map((id) => findTask(id)).filter(Boolean).map(brief), timedOut: false }),
  create_task: (a) => ({ project: state.project.name, id: newId(), title: a.title, status: "queued", ...placed(a) }),
  create_tasks: (a) => ({ project: state.project.name, created: (a.tasks ?? []).length, tasks: (a.tasks ?? []).map((t) => ({ id: newId(), title: t.title, status: "queued", ...placed({ ...a, ...t }) })) }),
  send_to_task: (a) => {
    const t = findTask(a.task)
    if (!t) throw new Error(`No task ${a.task} in this project.`)
    return { ok: true, task: t.id, delivery: t.status === "working" ? "queued: it gets this when its current turn ends" : "resumes its session", status: "queued" }
  },
  reply_to_agent: (a) => ({ ok: true, task: a.task, delivered: "mid-turn: the agent was waiting" }),
  continue_task: (a) => ({ ok: true, task: a.task, agent: a.agent ?? "claude", status: "queued", note: "Continues the same workspace and branch on the new harness." }),
  reopen_task: (a) => ({ ok: true, task: a.task, status: a.message ? "queued" : "idle", reopened: true }),
  retry_task: (a) => ({ ok: true, task: a.task, status: "queued" }),
  repo_clone: () => ({
    status: "fresh",
    path: state.clone,
    repo: state.project.repo,
    branch: "main",
    commit: "70a64ed",
    synced: "just now",
    read_only: "Read, Grep and Glob work here. Nothing can edit, commit, push or run it: create a task for work that needs that.",
  }),
  list_notes: () => ({ notes: state.notes, budget: `${state.notes.length} of 25 notes, ~4k of 4k tokens` }),
  list_note_suggestions: () => ({ suggestions: state.suggestions.map((s) => ({ ...s, status: "pending" })) }),
  resolve_suggestion: (a) => ({ ok: true, suggestion: a.suggestion, action: a.action }),
  add_note: (a) => ({ ok: true, note: { id: "note_new0001", content: a.content } }),
  update_note: (a) => ({ ok: true, note: { id: a.note ?? a.id, content: a.content } }),
  delete_note: () => ({ ok: true }),
  pool_status: () => ({ boxes: BOXES }),
  box_history: () => ({ events: [] }),
  delete_idle_boxes: (a) =>
    a.dry_run === false
      ? { deleted: [BOXES[0].box], skipped: [{ box: BOXES[1].box, reason: "task_flaky00002 is running" }] }
      : { dry_run: true, would_delete: [BOXES[0]], skipped: [{ box: BOXES[1].box, reason: "task_flaky00002 is running" }], next: "Call again with dry_run: false and a reason to delete." },
  delete_box: () => ({ ok: true }),
  list_identities: () => ({ identities: [{ name: "Default", login: "example-bot", yours: true, projects: ["all"] }] }),
  test_identity: () => ({ ok: false, login: "example-bot", error: "example-bot has read-only access to acme/box-yard" }),
  detect_identities: () => ({
    changed: "nothing",
    accounts: [
      { login: "example-bot", source: "gh", access: { "acme/box-yard": "read" } },
      { login: "example-dev", source: "gh", access: { "acme/box-yard": "write" } },
    ],
    proposal: { login: "example-dev", owners: ["acme"], author: "Example Dev <dev@example.com>", why: "example-dev can push to acme/box-yard; example-bot can't." },
  }),
  list_hooks: () => ({ hooks: [] }),
  list_hook_runs: () => ({ runs: [] }),
  list_connectors: () => ({ connectors: [] }),
  list_inbox: () => ({ items: state.tasks.filter((t) => ["needs_input", "pr_ready", "failed"].includes(t.status)).map(brief) }),
  search_history: () => ({ results: [] }),
  list_projects: () => ({ projects: [{ id: state.project.id, name: state.project.name, repo: state.project.repo }] }),
  close_task: () => {
    throw new Error("close_task acts only on Cody's own direct request in chat.")
  },
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n")
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return
  const req = JSON.parse(line)
  if (req.id === undefined) return
  if (req.method === "initialize")
    return send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "boxyard", version: "0" } } })
  if (req.method === "tools/list") return send({ jsonrpc: "2.0", id: req.id, result: { tools } })
  if (req.method === "ping") return send({ jsonrpc: "2.0", id: req.id, result: {} })
  if (req.method === "tools/call") {
    const { name, arguments: a = {} } = req.params
    if (log) fs.appendFileSync(log, JSON.stringify({ name, input: a, at: Date.now() }) + "\n")
    let text
    let isError = false
    try {
      const fixed = fixtures[name]
      text = JSON.stringify(fixed !== undefined ? fixed : (handlers[name] ?? (() => ({ ok: true })))(a))
    } catch (e) {
      text = e.message
      isError = true
    }
    return send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text }], ...(isError ? { isError } : {}) } })
  }
  send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } })
})
