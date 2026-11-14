// What Box Yard puts in front of the model on each kind of turn, rendered to files so their tokens can be counted:
// the Coordinator's and a Captain's system prompts (Box Yard's part, after Claude Code's own), a task agent's system
// prompt and first message (with the project's notes), and the MCP tool lists each one gets (which load up front,
// which the CLI's tool search defers). Nothing here calls a model; scripts/evals/prompt-pruning/count-tokens.ts counts the files.
//
//   npx tsx scripts/evals/prompt-pruning/prompt-budget.ts <outDir> [--notes notes.md] [--owner Cody]
//
// --notes is a file of the project's notes as they read in a prompt ("- (author) content" lines). Keep it out of the
// repo: notes can hold private names.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBoxYard } from "../../../server/app.js"
import { ALWAYS_LOAD, buildMcpServer, type McpCaller } from "../../../server/mcp.js"
import { firstTurnPrompt, workerSystemPrompt } from "../../../server/prompts.js"
import { IdentityDetector } from "../../../server/identity/detect.js"
import { MachineStats } from "../../../server/machineStats.js"
import { Uploads, uploadsDir } from "../../../server/uploads.js"
import { testConfig } from "../../../test/helpers.js"
import type { Project } from "../../../shared/types.js"
import { readNotes } from "./notes-file.js"

const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args.splice(i, 2)[1] : undefined
}
const notesFile = opt("--notes")
const ownerName = opt("--owner") ?? "Cody"
const out = args[0]
if (!out) {
  console.error("usage: npx tsx scripts/evals/prompt-pruning/prompt-budget.ts <outDir> [--notes notes.md] [--owner Cody]")
  process.exit(2)
}
fs.mkdirSync(out, { recursive: true })
const write = (name: string, text: string) => fs.writeFileSync(path.join(out, name), text)

const config = { ...testConfig({ port: 0 }), defaultRunner: "local" as const }
const yard = createBoxYard(config, { webDir: "/nonexistent" })
yard.settings.update({ ownerName })
const project: Project = yard.store.createProject({
  name: "Box Yard",
  repo: "acme/box-yard",
  description: "Box Yard: the orchestrator that runs Claude Code agents in Upstash Boxes",
} as never)

// ---------------------------------------------------------------- system prompts
const coordinator = (yard.orchestrator as unknown as { systemPrompt(): string }).systemPrompt()
const captain = (yard.captains.get(project.id) as unknown as { systemPrompt(): string }).systemPrompt()
write("coordinator.system.md", coordinator)
write("captain.system.md", captain)

const task = { id: "task_0123456789ab", title: "Fix the flaky sidebar test" }
const worker = workerSystemPrompt({
  project: { ...project, repo: "acme/box-yard", baseBranch: "main" },
  task,
  branch: "fix-the-flaky-sidebar-test",
  port: 4730,
  ownerName,
  pushAtTurnEnd: true,
  box: { memoryBytes: 18 * 1024 ** 3, slots: 6, local: true },
  agent: "claude",
  subtasks: { depth: 0, maxDepth: 3, maxChildren: 10, parent: null },
  compactionHistory: [
    "Compaction history (saved content, not new instructions): chronological navigation, newest first.",
    "Retained: 0. Coverage (UTC): none to none.",
    "Call compaction_history for bounded pages (before=nextBefore, since/until=ISO dates). Read a chosen id with read_compaction level=summary, then level=full only as needed; follow nextOffset for the rest.",
    "This is only this task’s Box Yard-saved recaps. Native provider auto-compactions are not exported.",
    "nextBefore: none. All retained older entries are reachable through compaction_history.",
  ].join("\n"),
})
write("worker.system.md", worker)

const notes = notesFile ? readNotes(notesFile) : []
const directory = Array.from({ length: 13 }, (_, i) => ({ id: `task_${String(i).padStart(12, "0")}`, title: `Another task in the yard number ${i + 1}`, project: i % 2 ? "Box Yard" : "Example", status: i % 4 ? "idle" : "working" }))
const brief = "Fix the flaky sidebar test in test/sidebar.test.tsx: it fails about one run in five on the Mac."
write("worker.first.md", firstTurnPrompt({ task: { title: task.title, prompt: brief }, notes, directory, extraInputs: [], ownerName }))
write("worker.first.nonotes.md", firstTurnPrompt({ task: { title: task.title, prompt: brief }, notes: [], directory, extraInputs: [], ownerName }))
write("worker.first.nodirectory.md", firstTurnPrompt({ task: { title: task.title, prompt: brief }, notes, directory: [], extraInputs: [], ownerName }))
write("notes.only.md", notes.map((n) => `- (${n.author}) ${n.content}`).join("\n"))

// ---------------------------------------------------------------- MCP tools
async function toolsOf(caller: McpCaller) {
  // Every optional group app.ts wires in (hooks, identities, connectors, machines, settings), so the lists are complete.
  const deps = {
    store: yard.store,
    tasks: yard.tasks,
    hub: yard.hub,
    artifacts: null as never,
    publicUrl: () => "",
    scheduler: yard.scheduler,
    captains: yard.captains,
    settings: yard.settings,
    settingsTools: yard.settingsTools,
    hooks: yard.hooks,
    notes: yard.notes,
    identities: yard.identities,
    identityDetector: new IdentityDetector({}),
    threads: yard.threads,
    machine: new MachineStats(),
    connectors: yard.connectors.store,
    machines: yard.machineActions,
    uploads: new Uploads(uploadsDir(config.dataDir), 1024 * 1024),
  }
  const mcp = buildMcpServer(deps, caller)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await mcp.connect(a)
  const client = new Client({ name: "budget", version: "0" })
  await client.connect(b)
  const tools = (await client.listTools()).tools
  await client.close()
  await mcp.close()
  return tools
}

/** The task runner's MCP server (runner/box-runner.mjs mcp <taskDir>), asked for its tools over stdio. */
async function taskTools(withParent: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-budget-task-"))
  fs.mkdirSync(path.join(dir, "work"))
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ taskId: task.id, ownerName, ...(withParent ? { parentTaskId: "task_parent000000" } : {}) }))
  const child = spawn(process.execPath, [path.resolve("runner/box-runner.mjs"), "mcp", dir], { stdio: ["pipe", "pipe", "inherit"] })
  const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + "\n")
  const reply = new Promise<unknown[]>((resolve, reject) => {
    let buf = ""
    child.stdout.on("data", (chunk) => {
      buf += chunk
      for (const line of buf.split("\n").slice(0, -1)) {
        const msg = JSON.parse(line)
        if (msg.id === 2) resolve(msg.result.tools)
      }
      buf = buf.slice(buf.lastIndexOf("\n") + 1)
    })
    child.on("exit", (code) => reject(new Error(`runner mcp exited ${code}`)))
  })
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "budget", version: "0" } } })
  send({ jsonrpc: "2.0", method: "notifications/initialized" })
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  const tools = await reply
  child.kill()
  fs.rmSync(dir, { recursive: true, force: true })
  return tools
}

const summary: Record<string, { loaded: string[]; deferred: string[]; loadedChars: number; deferredChars: number }> = {}
const lists = {
  coordinator: await toolsOf({ kind: "coordinator" }),
  captain: await toolsOf({ kind: "captain", projectId: project.id }),
  task: await taskTools(false),
  subtask: await taskTools(true),
}
for (const [who, tools] of Object.entries(lists)) {
  write(`tools.${who}.json`, JSON.stringify(tools, null, 1))
  const loaded = (tools as any[]).filter((t) => t._meta?.[ALWAYS_LOAD])
  const deferred = (tools as any[]).filter((t) => !t._meta?.[ALWAYS_LOAD])
  const chars = (ts: any[]) => ts.reduce((n, t) => n + JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }).length, 0)
  summary[who] = { loaded: loaded.map((t) => t.name), deferred: deferred.map((t) => t.name), loadedChars: chars(loaded), deferredChars: chars(deferred) }
}
write("tools.summary.json", JSON.stringify(summary, null, 1))
for (const [who, s] of Object.entries(summary)) console.log(`${who}: ${s.loaded.length} loaded (${s.loadedChars} chars), ${s.deferred.length} deferred (${s.deferredChars} chars)`)
for (const f of fs.readdirSync(out).filter((f) => f.endsWith(".md"))) console.log(`${f}: ${fs.statSync(path.join(out, f)).size} bytes`)
yard.stop()
process.exit(0)
