import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { tmpDir } from "./helpers.js"

// A PR the agent opens from its shell (`gh pr create`) instead of with create_pull_request: the runner reads the URL gh
// printed in the command's output, which every harness hands back its own way (Claude's tool_result, Codex's
// command_execution aggregatedOutput, Cursor's shellToolCall result, OpenCode's bash part output), and reports the PR
// with the branch the workspace is on. The fakes stand in for each CLI (scripts/fake-*.mjs, driven by fake-claude's
// [gh-pr:…] marker), with the runner run straight on a task folder.

const fake = (name: string) => path.resolve(`scripts/${name}`)
const HARNESSES: Record<string, Record<string, unknown>> = {
  claude: { claudeBin: process.execPath, claudeArgs: [fake("fake-claude.mjs")] },
  codex: { agent: "codex", isolateCodex: true, codexBin: process.execPath, codexArgs: [fake("fake-codex.mjs")] },
  cursor: { agent: "cursor", cursorBin: process.execPath, cursorArgs: [fake("fake-cursor.mjs")] },
  opencode: { agent: "opencode", opencodeBin: process.execPath, opencodeArgs: [fake("fake-opencode.mjs")] },
}

interface RunnerEvent {
  t: string
  [k: string]: unknown
}

/** Run one turn of `prompt` on a task folder whose workspace is a git repo on branch fix-lights; its events. */
function turn(harness: string, prompt: string): RunnerEvent[] {
  const dir = tmpDir("shell-pr-")
  const work = path.join(dir, "work")
  fs.mkdirSync(work)
  execFileSync("git", ["init", "-q", "-b", "fix-lights", work])
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ taskId: "task_shellpr", projectId: "prj_shellpr", env: {}, unsetEnv: [], ...HARNESSES[harness] }))
  fs.writeFileSync(path.join(dir, "turn.json"), JSON.stringify({ turnId: "turn_1", prompt, sessionId: randomUUID(), resume: false, systemPrompt: "You are a test agent." }))
  const env = { ...process.env, BOXYARD_RUNNER_DETACHED: "1", CODEX_API_KEY: "codex-test-key", CURSOR_API_KEY: "cursor-test-key" }
  execFileSync(process.execPath, [path.resolve("runner/box-runner.mjs"), "turn", dir], { env, stdio: "pipe", timeout: 60_000 })
  return fs
    .readFileSync(path.join(dir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as RunnerEvent)
}

describe("a PR opened with `gh pr create`", () => {
  it.each(Object.keys(HARNESSES))("is reported from %s's shell output, with the workspace's branch", (harness) => {
    const events = turn(harness, "Open a PR for the lights. [gh-pr:Acme/site#12]")
    expect(events.at(-1)).toMatchObject({ t: "turn_end", ok: true })
    expect(events.filter((e) => e.t === "pr")).toEqual([
      expect.objectContaining({ t: "pr", url: "https://github.com/Acme/site/pull/12", source: "shell", branch: "fix-lights", turnId: "turn_1" }),
    ])
  }, 60_000)

  it.each(["claude", "codex"])("is reported from %s when gh says the branch already has one (exit 1, URL on stderr)", (harness) => {
    const events = turn(harness, "Open a PR. [gh-pr-exists:acme/site#7]")
    expect(events.filter((e) => e.t === "pr")).toEqual([expect.objectContaining({ url: "https://github.com/acme/site/pull/7", source: "shell" })])
    expect(events.some((e) => e.t === "tool_error" && String(e.text).includes("already exists"))).toBe(true)
  }, 60_000)

  it("isn't read from other commands' output", () => {
    // fake-claude's plain turn runs `ls`; nothing it prints is a PR.
    const events = turn("claude", "Write a haiku. [pr]")
    expect(events.at(-1)).toMatchObject({ t: "turn_end", ok: true })
    expect(events.filter((e) => e.t === "pr")).toEqual([])
  }, 60_000)
})
