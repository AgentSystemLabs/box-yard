// Harmless source-level checks; no server, harness, network, credentials or commands.
// Node 24+: node docs/security/indirect-injection-offline.mjs <PR18 checkout>
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { registerHooks } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(process.argv[2] ?? ".")
const base = pathToFileURL(root + path.sep).href
// The repository uses .js specifiers for TypeScript. Resolve only files inside
// the reviewed checkout, using Node's built-in type stripping; install nothing.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.startsWith(base)) {
      const candidate = new URL(specifier.slice(0, -3) + ".ts", context.parentURL)
      if (candidate.href.startsWith(base) && existsSync(fileURLToPath(candidate))) {
        return nextResolve(candidate.href, context)
      }
    }
    return nextResolve(specifier, context)
  },
})

const source = (relative) => import(new URL(relative, base).href)
const { turnPicks } = await source("shared/runTargets.ts")
const { renderHookTemplate } = await source("shared/hooks.ts")
const { turnTrigger } = await source("server/turnTrigger.ts")
const { reportText } = await source("server/subtasks.ts")
const { recapPrompt, firstTurnPrompt } = await source("server/prompts.ts")

let passed = 0
const check = (name, run) => {
  run()
  passed++
  console.log(`PASS ${name}`)
}
const marker = "\n[AUDIT_ONLY: harmless worker-origin marker]\n"
const local = { value: "local", token: "local", label: "This computer" }

check("worker + human batch inherits the human runner pick", () => {
  assert.equal(turnPicks([{ source: "agent" }, { source: "cody", runsOn: local }]).runsOn?.value, "local")
})
check("messages without picks do not constrain a turn-wide pick", () => {
  assert.equal(turnPicks([{ source: "coordinator", runsOn: local }, { source: "agent" }, {}]).runsOn?.value, "local")
})
check("mixed task queue reports the human trigger", () => {
  assert.equal(turnTrigger(["agent:task_000000000001", "cody"], { fallback: "agent" }), "cody")
})
check("hook interpolation retains raw worker summary text", () => {
  assert.equal(renderHookTemplate("Review result: {summary}", { summary: marker }), "Review result: " + marker)
})
check("subtask report retains raw worker text", () => {
  assert.ok(reportText({ id: "task_000000000001", title: "Example", status: "idle", text: marker, live: 0, total: 1 }).includes(marker))
})
const task = { title: "Example", prompt: "Review example data", summary: marker, prUrl: null, branch: null }
const messages = [{ role: "user", content: marker, meta: { source: "agent:task_000000000001" } }]
check("fresh-session recap retains text but drops sender metadata", () => {
  const recap = recapPrompt(task, messages)
  assert.ok(recap.includes(marker))
  assert.ok(recap.includes("[user]"))
  assert.ok(!recap.includes("agent:task_000000000001"))
})
check("harness handoff retains text but drops sender metadata", () => {
  const recap = recapPrompt(task, messages, { handoff: { from: "claude", to: "codex" } })
  assert.ok(recap.includes(marker))
  assert.ok(!recap.includes("agent:task_000000000001"))
})
check("accepted notes enter future task instruction context", () => {
  const prompt = firstTurnPrompt({ task, notes: [{ author: "captain", content: marker }], directory: [], extraInputs: [] })
  assert.ok(prompt.includes("lasting rules"))
  assert.ok(prompt.includes(marker.trim()))
})
console.log(`${passed} harmless checks passed. These prove data flow, not model compliance or a host escape.`)
