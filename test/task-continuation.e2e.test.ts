import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { execFileSync } from "node:child_process"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { harnessHandoffKey } from "../shared/taskContinuation.js"
import { Uploads, uploadsDir } from "../server/uploads.js"
import type { Task } from "../shared/types.js"
import { testConfig, tmpDir, waitFor } from "./helpers.js"

const yards: BoxYard[] = []
afterEach(async () => {
  for (const y of yards.splice(0)) {
    await settled(y)
    await waitFor(() => !y.orchestrator.state().busy, "Coordinator to settle")
    y.stop()
  }
  delete process.env.FAKE_CODEX_LOG
})
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Example Agent", "-c", "user.email=agent@example.invalid", ...args], { cwd, stdio: "pipe" }).toString().trim()
async function settled(y: BoxYard) {
  await waitFor(() => y.store.listTaskRows().every((r) => !r.current_turn_id) && !(y.tasks as unknown as { archiving: Set<string> }).archiving.size, "turn-end archives to settle", 30_000)
}
async function fixture(partial = false) {
  const root = tmpDir("continuation-origin-")
  const seed = path.join(root, "seed")
  const bare = path.join(root, "example.git")
  git(root, "init", "-q", "--bare", "-b", "main", bare)
  git(bare, "config", "uploadpack.allowFilter", "true")
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true")
  git(root, "init", "-q", "-b", "main", seed)
  fs.writeFileSync(path.join(seed, "README.md"), "Example\n")
  fs.writeFileSync(path.join(seed, ".gitignore"), "scratch.tmp\n")
  git(seed, "add", ".")
  git(seed, "commit", "-qm", "Example base")
  git(seed, "push", "-q", bare, "main")
  const config = testConfig({ claudeOauthToken: "example-limited-token", archiveMaxMb: partial ? 1 : 128 })
  const y = createBoxYard(config, { webDir: "/nonexistent" })
  yards.push(y)
  // No HTTP listener or production data; all CLIs, auth and Git are isolated fake fixtures.
  const project = y.store.createProject({ name: "Example continuation", agentCli: "claude", pushAtTurnEnd: false })
  y.store.db.prepare("UPDATE projects SET repo = ? WHERE id = ?").run(`file://${bare}`, project.id)
  const uploads = new Uploads(uploadsDir(config.dataDir), 1024 * 1024)
  const attached = uploads.save("example-notes.txt", Buffer.from("Keep this attachment"))
  const task = y.tasks.createTask({ projectId: project.id, title: "Continue example feature", prompt: "Continue the example feature", attachments: [attached], agentCli: "claude", model: "claude-opus-5-5", effort: "max" })
  await y.start()
  const failed = await waitFor(() => y.store.getTask(task.id)?.status === "failed" ? y.store.getTask(task.id) : null, "Claude usage limit", 30_000)
  await settled(y)
  expect(failed.error).toMatch(/usage limit/i)
  const dir = y.tasks.taskDir(failed.boxId!, task.id)
  const work = path.join(dir, "work")
  fs.writeFileSync(path.join(work, "committed.txt"), "Unpushed commit\n")
  git(work, "add", ".")
  git(work, "commit", "-qm", "Example progress")
  fs.writeFileSync(path.join(work, "README.md"), "Staged progress\n")
  git(work, "add", "README.md")
  fs.appendFileSync(path.join(work, "README.md"), "Unstaged progress\n")
  fs.writeFileSync(path.join(work, "untracked.txt"), "Untracked progress\n")
  y.store.addTaskMessage(task.id, "assistant", "Preserve this earlier conversation and inspect existing changes.")
  y.store.updateTask(task.id, { summary: "The example feature has uncommitted work." })
  if (partial) fs.writeFileSync(path.join(work, "scratch.tmp"), randomBytes(2 * 1024 * 1024))
  await y.tasks.archive(task.id)
  expect(y.store.getTaskRow(task.id)?.archive_kind).toBe(partial ? "partial" : "whole")
  const beforeStatus = git(work, "status", "--porcelain")
  const beforeHead = git(work, "rev-parse", "HEAD")
  const queueFile = uploads.save("queued.txt", Buffer.from("Keep this queued attachment"))
  y.store.queueInput(task.id, "cody", "First queued instruction", [queueFile.id])
  y.store.queueInput(task.id, "cody", "Second queued instruction")
  const log = path.join(root, "codex.jsonl")
  process.env.FAKE_CODEX_LOG = log
  return { y, task: y.store.getTask(task.id)!, dir, work, beforeStatus, beforeHead, log }
}

async function runContinuation(y: BoxYard, task: Task) {
  await y.tasks.continueTask(task.id, { agent: "codex", message: "Finish the existing feature" })
  await waitFor(() => y.store.getTask(task.id)?.status === "idle" && y.store.getTask(task.id)!.turnCount > task.turnCount, "Codex continuation", 30_000)
  await settled(y)
}

describe("harness-limit continuation through the real runner and archive path", () => {
  it.each(["live", "whole", "partial"])("keeps the same task and dirty Git work (%s), and resumes only Codex later", async (mode) => {
    const restore = mode !== "live"
    const f = await fixture(mode === "partial")
    const { y, task } = f
    if (restore) {
      // The original workspace was parked after its archive finished, as on a retired box.
      fs.rmSync(f.dir, { recursive: true })
      y.store.updateTask(task.id, { boxId: null, portBase: null })
    }
    y.settings.update({ agentCli: "codex", agentCodexModel: "gpt-6.1-terra", agentCodexEffort: "ultra" })
    expect(y.store.getTask(task.id)?.agentCli).toBe("claude")
    await runContinuation(y, task)
    const now = y.store.getTask(task.id)!
    const dir = y.tasks.taskDir(now.boxId!, now.id)
    const work = path.join(dir, "work")
    expect(y.store.listTaskRows()).toHaveLength(1)
    expect(now).toMatchObject({ id: task.id, branch: task.branch, agentCli: "codex", pendingCount: 0, model: null, effort: null })
    expect(git(work, "status", "--porcelain").split("\n").filter((line) => !line.endsWith("box-yard-demo.md")).join("\n")).toBe(f.beforeStatus)
    expect(git(work, "rev-parse", "HEAD")).toBe(f.beforeHead)
    expect(fs.readFileSync(path.join(work, "untracked.txt"), "utf8")).toContain("Untracked progress")
    const turn = JSON.parse(fs.readFileSync(path.join(dir, "turn.json"), "utf8"))
    expect(turn).toMatchObject({ resume: false, model: "gpt-6.1-terra", effort: "ultra" })
    expect(turn.sessionId).not.toBe(task.sessionId)
    expect(turn.prompt).toMatch(/SAME task on Codex after Claude Code/)
    expect(turn.prompt).toContain("Preserve this earlier conversation")
    expect(turn.prompt.indexOf("First queued instruction")).toBeLessThan(turn.prompt.indexOf("Second queued instruction"))
    const attachmentFiles = fs.readdirSync(path.join(dir, "attachments"), { recursive: true }).map(String)
    expect(attachmentFiles.some((p) => p.endsWith("example-notes.txt"))).toBe(true)
    expect(attachmentFiles.some((p) => p.endsWith("queued.txt"))).toBe(true)
    const json = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"))
    expect(json.agent).toBe("codex")
    expect(json.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(json.unsetEnv).toContain("CLAUDE_CODE_OAUTH_TOKEN")
    expect(y.store.getKv(harnessHandoffKey(task.id))).toBeNull()
    const runs = () => fs.readFileSync(f.log, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(runs()[0].resume).toBeNull()
    y.tasks.sendInput(task.id, "Follow up on Codex")
    await waitFor(() => runs().length === 2, "second Codex invocation")
    await waitFor(() => y.store.getTask(task.id)?.status === "idle", "Codex follow-up")
    await settled(y)
    expect(runs()[1].resume).toBe(runs()[0].thread)
    expect(runs()[1].resume).not.toBe(task.sessionId)
    if (mode === "live") {
      const codexSession = y.store.getTask(task.id)!.sessionId
      await y.tasks.continueTask(task.id, { agent: "cursor" })
      await waitFor(() => y.store.getTask(task.id)?.status === "idle", "Cursor continuation")
      await settled(y)
      const cursorTurn = JSON.parse(fs.readFileSync(path.join(dir, "turn.json"), "utf8"))
      expect(cursorTurn).toMatchObject({ resume: false, model: "auto", effort: null })
      expect(cursorTurn.sessionId).not.toBe(codexSession)
      await y.tasks.continueTask(task.id, { agent: "claude" })
      await waitFor(() => y.store.getTask(task.id)?.status === "failed", "new Claude session hitting its limit")
      await settled(y)
      const claudeTurn = JSON.parse(fs.readFileSync(path.join(dir, "turn.json"), "utf8"))
      expect(claudeTurn.resume).toBe(false)
      expect(claudeTurn.sessionId).not.toBe(task.sessionId)
      expect(claudeTurn.sessionId).not.toBe(codexSession)
      expect(claudeTurn.prompt).toContain("SAME task on Claude Code after Cursor")
    }
  })

  it("refuses a missing workspace/archive instead of silently losing unpushed work", async () => {
    const { y, task, dir } = await fixture()
    const archive = y.store.getTaskRow(task.id)!.archive_path!
    const valid = fs.readFileSync(archive)
    fs.rmSync(dir, { recursive: true })
    fs.rmSync(archive)
    y.store.updateTask(task.id, { boxId: null, portBase: null })
    await y.tasks.continueTask(task.id, { agent: "codex" })
    await waitFor(() => y.store.getTask(task.id)?.status === "failed" && /workspace and its archive are unavailable/.test(y.store.getTask(task.id)?.error ?? ""), "missing workspace refusal")
    await settled(y)
    expect(y.store.listQueuedInputs(task.id)).toHaveLength(3)
    expect(y.store.getKv(harnessHandoffKey(task.id))).toContain('"needsWorkspace":true')
    fs.writeFileSync(archive, valid)
  })

  it("preserves a broken archive and queue on restore failure, then recovers on retry", async () => {
    const { y, task, dir, beforeHead } = await fixture()
    const archive = y.store.getTaskRow(task.id)!.archive_path!
    const valid = fs.readFileSync(archive)
    fs.rmSync(dir, { recursive: true })
    y.store.updateTask(task.id, { boxId: null, portBase: null })
    fs.writeFileSync(archive, "broken archive fixture")
    await y.tasks.continueTask(task.id, { agent: "codex" })
    await waitFor(() => y.store.getTask(task.id)?.status === "failed" && /until the workspace archive is restored/.test(y.store.getTask(task.id)?.error ?? ""), "failed handoff restore")
    await settled(y)
    expect(fs.readFileSync(archive, "utf8")).toBe("broken archive fixture")
    expect(y.store.getTaskRow(task.id)?.archive_path).toBe(archive)
    expect(y.store.getKv(harnessHandoffKey(task.id))).toContain('"to":"codex"')
    expect(y.store.listQueuedInputs(task.id).map((i) => i.content)).toContain("First queued instruction")
    fs.writeFileSync(archive, valid)
    y.tasks.retryTask(task.id)
    await waitFor(() => y.store.getTask(task.id)?.status === "idle", "recovered archive continuation", 30_000)
    await settled(y)
    const back = y.store.getTask(task.id)!
    expect(git(path.join(y.tasks.taskDir(back.boxId!, task.id), "work"), "rev-parse", "HEAD")).toBe(beforeHead)
    expect(y.store.getKv(harnessHandoffKey(task.id))).toBeNull()
  })
})
