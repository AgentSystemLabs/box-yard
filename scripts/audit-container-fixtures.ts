/**
 * Offline characterization for docs/security/container-runner-audit-2026-11-07.md.
 * Run: npx tsx scripts/audit-container-fixtures.ts
 * No daemon, app, network, real credentials, agent CLI or scheduler is used. All filesystem
 * writes stay in a fresh directory inside this checkout, removed in finally. A true exposure
 * is an audit observation, never a security pass. These probes should change after remediation.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { TaskManager } from "../server/tasks.js"
import { Identities } from "../server/identity/identities.js"
import { LocalRunnerProvider } from "../server/providers/local.js"
import type { WorkerEvent } from "../server/bus.js"

type RecordValue = Record<string, unknown>
const method = (name: string) => Reflect.get(TaskManager.prototype, name) as (...args: unknown[]) => unknown

async function childRunnerProbe() {
  const parent = { id: "task_aaaaaaaaaaaa", project_id: "prj_example", runs_on: "docker", box_id: "docker-prj_example", agent_cli: "claude", subtask_depth: 0 }
  const children: RecordValue[] = []
  const replies: RecordValue[] = []
  // Use the real dispatch, spawn, availability, identity-runner and createTasks methods.
  // Persistence, availability discovery and scheduling are inert seams; no child is launched.
  const ctx: RecordValue = {
    store: {
      db: { open: true, transaction: (f: () => unknown) => f },
      getTaskRow: () => parent,
      turnFlags: () => ({}),
      subtaskRows: () => [],
      taskEnv: () => ({}),
      getProject: () => ({ id: parent.project_id, repo: null, agentCli: "claude" }),
      createTask: (input: RecordValue) => { const row = { ...input, id: "task_bbbbbbbbbbbb" }; children.push(row); return row },
      getTask: () => children[0],
      addTaskMessage: () => ({}),
    },
    identities: {
      idOf: () => "identity_example",
      runnerProblem: (identity: string, runner: string) => Identities.prototype.runnerProblem.call(
        { row: () => ({ runners_json: null, signing_json: null, name: "Example" }) } as unknown as Identities,
        identity, runner as Parameters<Identities["runnerProblem"]>[1],
      ),
    },
    runnerProblem: async () => null, // Explicit precondition: requested host CLI is available.
    turnCredentials: () => ({ claudeFrom: "project" }),
    agentCliFor: () => "claude",
    initialRoute: () => ({}),
    subtaskLimits: () => ({ maxDepth: 3, maxChildren: 10 }),
    writeTaskFile: async (_task: string, _name: string, body: RecordValue) => { replies.push(body) },
    addEvent: () => {}, emitTask: () => {}, publishDirectory: () => {}, schedule: () => {}, syncSubtasks: () => {},
    absoluteUrl: (s: string) => s,
  }
  for (const name of ["spawnSubtasks", "requireRunner", "requireIdentityRunner", "createTasks"]) {
    ctx[name] = (...args: unknown[]) => method(name).apply(ctx, args)
  }
  const event: WorkerEvent = {
    t: "spawn_subtasks", id: "sub_0123456789ab", seq: 1, ts: 1, turnId: "fixture-turn",
    tasks: [{ title: "Example child", prompt: "Inert fixture; never execute an agent.", runsOn: "local" }],
  }
  await TaskManager.prototype.apply.call(ctx as unknown as TaskManager, parent.id, event)
  assert.equal(replies[0]?.status, "ok")
  return { docker_parent_local_child_accepted: children[0]?.runsOn === "local", children_launched: 0 }
}

async function artifactProbe() {
  let pathRead: unknown
  let bytesRead = 0
  let rejectedAfterRead = false
  const ctx = {
    store: { db: { open: true }, getTaskRow: () => ({ id: "task_aaaaaaaaaaaa", project_id: "prj_example", box_id: "docker-prj_example" }), turnFlags: () => ({}), addTaskMessage: () => ({}) },
    provider: { readFile: async (_box: string, file: string) => { pathRead = file; bytesRead = 32; return Buffer.alloc(32) } },
    // A tiny synthetic quota makes ordering visible without allocating a large buffer.
    artifacts: { save: () => { rejectedAfterRead = bytesRead > 16; throw new Error("Synthetic 16-byte quota") } },
    hub: { broadcast: () => {} },
  }
  await TaskManager.prototype.apply.call(ctx as unknown as TaskManager, "task_aaaaaaaaaaaa", {
    t: "artifact", seq: 1, ts: 1, turnId: "fixture-turn", size: 1, path: "/fixture-outside-workspace",
  })
  return { artifact_unconfined_path_requested: pathRead === "/fixture-outside-workspace", artifact_quota_checked_after_read: rejectedAfterRead, synthetic_bytes_read: bytesRead }
}

async function archiveProbe(scratch: string) {
  const source = path.join(scratch, "source")
  const destination = path.join(scratch, "host-tasks")
  const id = "task_aaaaaaaaaaaa"
  const sibling = "task_bbbbbbbbbbbb"
  fs.mkdirSync(path.join(source, id), { recursive: true })
  fs.mkdirSync(path.join(source, sibling), { recursive: true })
  fs.mkdirSync(destination)
  const sentinel = path.join(scratch, "outside-marker")
  fs.writeFileSync(sentinel, "original fixture bytes")
  fs.symlinkSync("../../outside-marker", path.join(source, id, "turn.json"))
  fs.writeFileSync(path.join(source, sibling, "marker"), "sibling fixture bytes")
  const archive = path.join(scratch, "fixture.tgz")
  // Only fixed, checkout-owned fixture paths go to tar. No untrusted shell string executes.
  execFileSync("tar", ["czf", archive, "-C", source, id, sibling], { stdio: "pipe", timeout: 5000 })
  execFileSync("tar", ["xzf", archive, "-C", destination], { stdio: "pipe", timeout: 5000 })
  const restored = path.join(destination, id, "turn.json")
  assert.equal(fs.realpathSync(restored), sentinel)
  // Same local write path used for a restored turn's server-owned metadata.
  const local = new LocalRunnerProvider(destination)
  await local.writeFile("this-computer", restored, '{"fixture":true}')
  return {
    archive_sibling_entry_extracted: fs.existsSync(path.join(destination, sibling, "marker")),
    restored_metadata_symlink_followed: fs.readFileSync(sentinel, "utf8") === '{"fixture":true}',
  }
}

const scratch = fs.mkdtempSync(path.join(process.cwd(), ".container-audit-"))
try {
  const children = await childRunnerProbe()
  const artifact = await artifactProbe()
  const archive = await archiveProbe(scratch)
  console.log(JSON.stringify({ characterization_only: true, ...children, ...artifact, ...archive }, null, 2))
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
