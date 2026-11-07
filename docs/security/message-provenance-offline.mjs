// Offline source fixtures for PR #18. No server, model, provider, database or network is started.
// Node 24+ supplies stripTypeScriptTypes; no packages or installations are needed.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { stripTypeScriptTypes } from "node:module"
import vm from "node:vm"

const ref = "ed152eaf5271ba84782003afe753a94ea1f4e24c"
const source = (file) => execFileSync("git", ["show", `${ref}:${file}`], { encoding: "utf8" })
const tasks = source("server/tasks.ts")
function method(name, next) {
  const start = tasks.indexOf(`  ${name}`)
  assert.ok(start >= 0, name)
  const end = tasks.indexOf(next, start)
  assert.ok(end > start, next)
  return tasks.slice(start, end)
}
function plain(ts) {
  return stripTypeScriptTypes(ts, { mode: "strip" }).replace(/\bexport /g, "")
}
const methods = [
  method("async apply(taskId:", "\n  /** The tracker saw"),
  method("private deliverAgentMessage(", "\n  /**\n   * An agent's message_captain"),
  method("private reportToParent(", "\n  /** wait_for_subtasks"),
].join("\n")
const report = source("server/subtasks.ts")
const reportFunction = report.slice(report.indexOf("export function reportText("), report.indexOf("\nexport interface SubtaskReport"))
const prompt = source("server/prompts.ts")
const followupFunction = prompt.slice(prompt.indexOf("export function followupPrompt("), prompt.indexOf("\n/**\n * The Coordinator's and Captains' rule"))
const recapFunction = prompt.slice(prompt.indexOf("export function recapPrompt("), prompt.indexOf("\n/** When the Coordinator or a Captain"))
const trigger = source("server/turnTrigger.ts").replace(/^import .*$/gm, "")
const harness = plain(`
const withOwner = (s, name) => s.replaceAll("Cody", name || "Cody");
const AGENT_MSG_LIMIT = 100;
const RESTING = ["idle", "waiting", "pr_ready", "needs_input", "done"];
const MAX_REPORT_CHARS = 8000;
const STATUS_WORD = { idle: "finished its turn" };
const subtaskReportKey = id => "subtask_report:" + id;
const queuedFromKey = id => "queued_from:" + id;
const MERGE_BUTTON_SOURCE = "cody:merge";
const MERGE_BUTTON_LABEL = "Cody (Merge button)";
${reportFunction}
${followupFunction}
${recapFunction}
${trigger}
class Harness { ${methods} }
globalThis.audit = { Harness, followupPrompt, recapPrompt, turnTrigger };
`)
const context = vm.createContext({ Date, Set, Map, String, Number, Boolean, console })
vm.runInContext(harness, context)
const { Harness, followupPrompt, recapPrompt, turnTrigger } = context.audit
const sender = { id: "task_isolated", project_id: "project_a", title: "Example worker", runs_on: "docker", status: "working", current_turn_id: "turn_current" }
const host = { id: "task_local", project_id: "project_a", title: "Example host", runs_on: "local", status: "idle", current_turn_id: null }
const ssh = { ...host, id: "task_ssh", project_id: "project_b", runs_on: "ssh" }
const rows = new Map([sender, host, ssh].map(row => [row.id, { ...row }]))
const queued = []
const notices = []
const transcript = []
const kv = new Map()
const h = new Harness()
Object.assign(h, {
  agentMsgLog: new Map(),
  identities: { statusOnly: () => false },
  owner: () => "Fixture owner",
  notice: (...args) => notices.push(args),
  hub: { broadcast() {} },
  emitTask() {}, schedule() {}, syncSubtasks() {},
  liveSubtask: row => row.status === "working",
  store: {
    db: { open: true },
    getTaskRow: id => rows.get(id),
    listTaskRows: () => [...rows.values()],
    turnFlags: () => ({}),
    queueInput(taskId, source, content) {
      const id = `input_${queued.length}`
      queued.push({ id, taskId, source, content })
      return id
    },
    addTaskMessage(taskId, role, content, meta) {
      const message = { taskId, role, content, meta }
      transcript.push(message)
      return message
    },
    setKv: (key, value) => kv.set(key, value),
    updateTask: (id, patch) => Object.assign(rows.get(id), patch),
    subtaskRows: id => [...rows.values()].filter(row => row.parent_task_id === id),
  },
})

for (const target of [host, ssh]) {
  await h.apply(sender.id, { t: "message_agent", seq: queued.length + 1, turnId: "turn_stale", to: target.id, message: "Harmless fixture report" })
  const last = queued.at(-1)
  assert.equal(last.taskId, target.id)
  assert.equal(last.source, `agent:${sender.id}`)
  assert.equal(rows.get(target.id).status, "queued")
}
console.log("PASS: isolated worker -> existing local and cross-project SSH task queued; stale turn id is not fenced")

const beforeFyi = queued.length
await h.apply(sender.id, { t: "message_agent", to: host.id, message: "Harmless FYI", fyi: true })
assert.equal(queued.length, beforeFyi)
assert.equal(transcript.at(-1).meta.fyi, true)
console.log("PASS: ordinary agent FYI is transcript-only")

await h.apply(sender.id, { t: "message_agent", to: "orchestrator", message: "Harmless alias FYI", fyi: true })
assert.equal(notices.length, 1)
assert.equal(notices[0][1].taskId, sender.id)
console.log("PASS: human/orchestrator alias still emits notice even with fyi:true")

rows.get(sender.id).parent_task_id = host.id
rows.get(sender.id).status = "idle"
rows.get(host.id).status = "idle"
h.reportToParent(rows.get(sender.id), "idle", "Harmless child summary", null)
assert.equal(queued.at(-1).taskId, host.id)
assert.equal(queued.at(-1).source, `agent:${sender.id}`)
assert.ok(kv.get(`subtask_report:${sender.id}`))
console.log("PASS: isolated child report queues and persists for a host parent")

assert.equal(turnTrigger([`agent:${sender.id}`, "cody"], { fallback: "system" }), "cody")
const forwarded = followupPrompt([{ source: "captain:project_a", content: "Harmless relayed summary" }], () => "Example")
assert.ok(forwarded.includes("on Cody's behalf"))
const recap = recapPrompt({ title: "Example", prompt: "Harmless original request", summary: "Harmless summary", branch: null, prUrl: null }, [{ role: "user", content: "Harmless agent question", meta: { source: "agent", taskId: sender.id } }])
assert.ok(recap.includes("[user] Harmless agent question"))
assert.ok(!recap.includes(sender.id))
console.log("PASS: mixed trigger chooses human; manager relay label says on human's behalf; recap strips source metadata")
