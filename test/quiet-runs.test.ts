import { describe, expect, it } from "vitest"
import { isQuietRun, noopBlockers, parseOutcome, withoutQuiet, type RunEvidence } from "../shared/quiet.js"
import type { Task, TaskStatus } from "../shared/types.js"
import { inInbox } from "../web/src/lib/inbox.js"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { tmpDir } from "./helpers.js"

const NOW = 1_000_000_000
const HOUR = 60 * 60 * 1000

let n = 0
function task(status: TaskStatus, over: Partial<Task> = {}): Task {
  n += 1
  return {
    id: `t${n}`,
    projectId: "p1",
    title: `Task ${n}`,
    prompt: "Do the thing",
    status,
    boxId: null,
    sessionId: "s",
    branch: null,
    prUrl: null,
    prState: null,
    prMergedAt: null,
    prMergedBy: null,
    previews: [],
    question: null,
    summary: null,
    error: null,
    turnCount: 1,
    pendingCount: 0,
    lastArchivedAt: null,
    scheduleId: null,
    outcome: null,
    contextTokens: null,
    contextWindow: null,
    compactPending: false,
    compacting: false,
    model: null,
    effort: null,
    claudeCostUsd: 0,
    claudeTokens: 0,
    routingRule: null,
    routingReason: null,
    createdAt: NOW - 2 * HOUR,
    updatedAt: NOW - HOUR,
    ...over,
  }
}

/** A PR Merger run that found no open PRs. */
const quietRun = (over: Partial<Task> = {}) => task("done", { scheduleId: "sch_1", outcome: "noop", summary: "No open PRs, nothing to merge", ...over })

const evidence = (over: Partial<RunEvidence> = {}): RunEvidence => ({
  scheduleId: "sch_1",
  status: "done",
  prUrl: null,
  previews: 0,
  artifacts: 0,
  asked: false,
  commits: 0,
  ...over,
})

describe("noopBlockers: when the server accepts a noop mark", () => {
  it("accepts a finished (idle) or done schedule run that left nothing behind", () => {
    expect(noopBlockers(evidence())).toEqual([])
    // The agent's finish rests the run idle: only Cody marks a task done.
    expect(noopBlockers(evidence({ status: "idle" }))).toEqual([])
    // Outside a git repo the runner can't count commits; that alone doesn't block.
    expect(noopBlockers(evidence({ commits: null }))).toEqual([])
  })

  it("ignores the mark when the run pushed commits, touched a PR, or published an artifact or preview", () => {
    expect(noopBlockers(evidence({ commits: 2 }))).toEqual(["it made 2 commits"])
    expect(noopBlockers(evidence({ prUrl: "https://github.com/a/b/pull/1" }))).toEqual(["it opened or updated a pull request"])
    expect(noopBlockers(evidence({ sawPr: true }))).toEqual(["it opened or updated a pull request"])
    expect(noopBlockers(evidence({ artifacts: 1 }))).toEqual(["it published an artifact"])
    expect(noopBlockers(evidence({ previews: 1 }))).toEqual(["it reported a preview"])
    expect(noopBlockers(evidence({ asked: true }))).toEqual(["it asked Cody a question"])
  })

  it("never for failed, needs-input or non-schedule runs", () => {
    for (const status of ["failed", "needs_input", "pr_ready", "waiting"] as TaskStatus[]) {
      expect(noopBlockers(evidence({ status }))).toEqual([`it ended as ${status}`])
    }
    expect(noopBlockers(evidence({ scheduleId: null }))).toEqual(["it isn't a schedule run"])
  })
})

describe("isQuietRun", () => {
  it("is a finished (idle) or done schedule run with the noop outcome", () => {
    expect(isQuietRun(quietRun())).toBe(true)
    expect(isQuietRun(quietRun({ status: "idle" }))).toBe(true)
    expect(isQuietRun(quietRun({ status: "pr_ready" }))).toBe(false)
    expect(isQuietRun(task("done", { scheduleId: "sch_1" }))).toBe(false)
    expect(isQuietRun(task("done", { outcome: "noop" }))).toBe(false)
  })

  it("never hides failed or needs-input runs, even when marked noop", () => {
    expect(isQuietRun(quietRun({ status: "failed", error: "boom" }))).toBe(false)
    expect(isQuietRun(quietRun({ status: "needs_input", question: "Which one?" }))).toBe(false)
    expect(isQuietRun(quietRun({ status: "working" }))).toBe(false)
    expect(isQuietRun(quietRun({ error: "boom" }))).toBe(false)
  })

  it("isn't quiet once the task shows a PR or a preview", () => {
    expect(isQuietRun(quietRun({ prUrl: "https://github.com/a/b/pull/1" }))).toBe(false)
    expect(isQuietRun(quietRun({ previews: [{ port: 4040, url: "https://x", label: "Port 4040" }] }))).toBe(false)
  })

  it("parses only known outcomes", () => {
    expect(parseOutcome("noop")).toBe("noop")
    expect(parseOutcome("nope")).toBeNull()
    expect(parseOutcome(null)).toBeNull()
  })

  it("withoutQuiet drops quiet runs unless shown", () => {
    const list = [quietRun(), task("done")]
    expect(withoutQuiet(list)).toHaveLength(1)
    expect(withoutQuiet(list, true)).toHaveLength(2)
  })
})

describe("the Inbox", () => {
  const quiet = quietRun()

  it("the Inbox never shows quiet runs but keeps failures marked noop", () => {
    expect(inInbox(quiet)).toBe(false)
    expect(inInbox(quietRun({ status: "failed", error: "boom" }))).toBe(true)
  })
})

describe("Store notifications", () => {
  it("records none for a run that lands as quiet, and one for a normal finish", () => {
    const store = new Store(openDb(tmpDir()))
    const p = store.createProject({ name: "ops" })
    const make = (id: string) => store.createTask({ id, projectId: p.id, title: id, prompt: "x", scheduleId: "sch_1" } as never)
    make("task_q")
    make("task_n")
    store.updateTask("task_q", { status: "working" })
    store.updateTask("task_n", { status: "working" })
    store.updateTask("task_q", { status: "done", outcome: "noop" })
    store.updateTask("task_n", { status: "done" })
    expect(store.listNotifications().map((x) => x.taskId)).toEqual(["task_n"])
  })
})
